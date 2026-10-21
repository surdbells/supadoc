<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Patient;
use App\Tests\Integration\DocumentSharing\Support\DocShareHarness;
use Doctrine\ORM\EntityManagerInterface;
use Ramsey\Uuid\Uuid;

/**
 * Atomicity and locks (spec §7.2): one transaction per call under sorted pair
 * locks, re-validated inside them — real concurrent requests in worker
 * processes, released together from a lock this test holds.
 */
final class ConcurrencyTest extends DocShareTestCase
{
    public function testADoctorWhoBecomesUnavailableInsideTheLocksRollsBackTheWholeShare(): void
    {
        $results = $this->race(
            [['op' => 'share', 'patient_id' => $this->P, 'input' => $this->input([$this->A, $this->G, $this->B])]],
            [$this->A, $this->G, $this->B],
            fn () => $this->suspend($this->B, $this->now),
        );

        $this->assertSame(422, $results[0]['refusal']['status'] ?? null, json_encode($results));
        $this->assertSame('doctor_unavailable', $results[0]['refusal']['code']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants'), 'no share for the other doctors either');
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM audit_events'));
    }

    public function testCrossingSharesNeverDeadlock(): void
    {
        $results = $this->race(
            [
                ['op' => 'share', 'patient_id' => $this->P, 'input' => $this->input([$this->A, $this->G])],
                ['op' => 'share', 'patient_id' => $this->P, 'input' => $this->input([$this->G, $this->A], 'selected')],
            ],
            [$this->A, $this->G],
        );

        foreach ($results as $result) {
            $this->assertArrayHasKey('result', $result, json_encode($results));
        }
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE scope = 'all' AND specialist_id = ?", [$this->A]));
    }

    public function testTwoParallelFolderSharesLeaveOneActiveFolderShare(): void
    {
        $results = $this->race(
            [
                ['op' => 'share', 'patient_id' => $this->P, 'input' => ['duration' => '7d'] + $this->input([$this->A])],
                ['op' => 'share', 'patient_id' => $this->P, 'input' => ['duration' => '30d'] + $this->input([$this->A])],
            ],
            [$this->A],
        );

        $outcomes = array_map(static fn (array $r): string => $r['result']['outcomes'][0]['outcome'] ?? 'error: ' . json_encode($r), $results);
        sort($outcomes);
        $this->assertContains('created', $outcomes);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active' AND scope = 'all'"));
        $end = Rules::fromSql($this->conn()->fetchOne("SELECT expires_at FROM document_access_grants WHERE status = 'active'"));
        $this->assertGreaterThanOrEqual($this->now->modify('+30 days'), $end, 'the later end wins: ' . json_encode([$outcomes, Rules::iso($end), Rules::iso($this->now)]));
    }

    public function testAnEditAddingDocumentsToAShareThatBecameAFolderShareMeanwhileIsRefused(): void
    {
        $grant = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1]])['grants'][0]['id'];

        $results = $this->race(
            [
                ['op' => 'update', 'patient_id' => $this->P, 'grant_id' => $grant, 'input' => ['add_document_ids' => [$this->P2]]],
                ['op' => 'update', 'patient_id' => $this->P, 'grant_id' => $grant, 'input' => ['scope' => 'selected', 'add_document_ids' => [$this->P3]]],
            ],
            [$this->A],
            function () use ($grant): void {
                // Another tab turned it into a whole-folder share while these edits waited.
                $this->conn()->executeStatement("UPDATE document_access_grants SET scope = 'all' WHERE id = ?", [$grant]);
                $this->conn()->executeStatement('DELETE FROM document_access_grant_documents WHERE grant_id = ?', [$grant]);
            },
        );

        $codes = [];
        foreach ($results as $result) {
            $this->assertSame(422, $result['refusal']['status'] ?? null, json_encode($results));
            $codes[] = isset($result['refusal']['errors']['scope']) ? 'scope' : (string) ($result['refusal']['code'] ?? '?');
        }
        sort($codes);
        $this->assertSame(['nothing_selected', 'scope'], $codes, 'decided again on the locked row');
        $this->assertSame('all', $this->conn()->fetchOne('SELECT scope FROM document_access_grants WHERE id = ?', [$grant]));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grant_documents WHERE grant_id = ?', [$grant]), 'no include row on a folder share');
    }

    public function testARefusalInsideTheLocksUndoesEverythingTheCallWrote(): void
    {
        [$svc, $em] = $this->request();
        $p = $em->find(Patient::class, $this->P);
        try {
            $svc->inPairs($p, [$this->A], function () use ($svc, $p): void {
                $svc->removeDocumentAccess($p, $this->P1, $this->A, $this->now);
                throw DomainRefusal::code(422, 'test', 'refused');
            }, $this->now);
            $this->fail('the refusal must surface');
        } catch (DomainRefusal $r) {
            $this->assertSame('test', $r->errorCode());
        }
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_hidden'));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_log'));
    }

    // ----- Helpers -----

    /** @param list<string> $doctors @return array<string,mixed> */
    private function input(array $doctors, string $scope = 'all'): array
    {
        return [
            'specialist_ids' => $doctors,
            'scope'          => $scope,
            'document_ids'   => $scope === 'selected' ? [$this->P1] : [],
            'duration'       => 'indefinite',
            'client_key'     => Uuid::uuid4()->toString(),
            'surface'        => 'manage_sharing',
        ];
    }

    /**
     * Hold the FIRST pair lock the jobs need (sorted ids) in a transaction of
     * our own, start the workers, wait until they all wait on it, run
     * `$meanwhile`, then let them go.
     *
     * @param list<array<string,mixed>> $jobs
     * @param list<string>              $doctors
     * @return list<array<string,mixed>>
     */
    private function race(array $jobs, array $doctors, ?callable $meanwhile = null): array
    {
        $ids = array_map('strtolower', $doctors);
        sort($ids);
        $blocker = $this->container()->get(EntityManagerInterface::class)->getConnection();
        $blocker->beginTransaction();
        $blocker->executeQuery('SELECT pg_advisory_xact_lock(3493, hashtext(:key))', ['key' => strtolower($this->P) . ':' . $ids[0]]);

        $app     = 'docshare_race_' . bin2hex(random_bytes(3));
        $workers = [];
        $failure = null;
        try {
            foreach ($jobs as $job) {
                $workers[] = DocShareHarness::startWorker($job + ['schema' => self::$schema, 'app' => $app]);
            }
            DocShareHarness::awaitLockWaiters($this->em(), $app, count($jobs));
            if ($meanwhile !== null) {
                $meanwhile();
            }
        } catch (\Throwable $e) {
            $failure = $e;
        }
        $blocker->commit();
        $results = array_map(static fn (array $w): array => DocShareHarness::finishWorker($w), $workers);
        if ($failure !== null) {
            throw new \RuntimeException($failure->getMessage() . "\nworkers: " . json_encode($results), 0, $failure);
        }

        return $results;
    }
}
