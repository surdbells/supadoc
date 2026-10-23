<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Repository\DoctorApplicationDocumentRepository;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Storage\ApplicationDocumentStore;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * Deleting drafts (spec §2.10, D11): a cancelled draft, or one not saved for
 * 30 days — its document rows and the draft itself (under the application
 * lock), then its files. Drafts have no events, so nothing is left behind.
 * Expiry is lazy (on read),
 * plus an opportunistic purge of up to 20 on each new draft and the manual
 * bin/application-drafts-purge.php — there is no cron.
 */
final class ApplicationDraftPurger
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DoctorApplicationRepository $applications,
        private readonly DoctorApplicationDocumentRepository $documents,
        private readonly ApplicationDocumentStore $store,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * Delete one draft, its documents and their files — under the application
     * lock (advisory + re-read row lock, as every draft write), so a submit
     * that committed meanwhile is seen: a submitted application is never
     * touched. `$expiredAt`: delete only if the draft is still expired then
     * (the expiry paths; a save may have just extended it). The vault files go
     * only after the rows are committed, so a failed delete leaves a whole
     * draft rather than rows pointing at missing files.
     *
     * @return bool false when the row is no longer a draft (or no longer
     *              expired); true when it is gone (also when it already was)
     */
    public function purge(DoctorApplication $draft, ?DateTimeImmutable $expiredAt = null): bool
    {
        if (!$draft->isDraft()) {
            return false;
        }
        $id   = $draft->getId();
        $keys = [];
        $conn = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('SELECT pg_advisory_xact_lock(' . DoctorApplicationService::LOCK_APPLICATION . ', hashtext(?))', [$id]);
            $locked = $this->applications->findForUpdate($id);
            if ($locked === null) {
                $conn->rollBack();

                return true; // discarded or purged meanwhile
            }
            if (!$locked->isDraft() || ($expiredAt !== null && !$locked->isExpiredDraft($expiredAt))) {
                $conn->rollBack();

                return false;
            }
            foreach ($this->documents->forApplication($id) as $doc) {
                $keys[] = $doc->getVaultKey();
                $this->em->remove($doc);
            }
            $this->em->remove($locked);
            $this->em->flush();
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }

            throw $e;
        }
        foreach ($keys as $key) {
            $this->store->delete($key);
        }

        return true;
    }

    /** Delete up to `$limit` expired drafts; returns how many went. */
    public function purgeExpired(int $limit = 20, ?DateTimeImmutable $now = null): int
    {
        $done = 0;
        $now ??= ClinicTime::now();
        foreach ($this->applications->expiredDrafts($now, $limit) as $draft) {
            if (!$this->em->isOpen()) {
                break;
            }
            try {
                if ($this->purge($draft, $now)) {
                    $done++;
                }
            } catch (\Throwable $e) {
                $this->logger?->warning('Expired draft could not be purged', ['application_id' => $draft->getId(), 'error' => $e::class]);
            }
        }

        return $done;
    }

    public function countExpired(?DateTimeImmutable $now = null): int
    {
        return $this->applications->countExpiredDrafts($now ?? ClinicTime::now());
    }
}
