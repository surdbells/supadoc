<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Application\ApplicationDocuments;
use App\Domain\Application\ApplicationStateMachine as SM;
use App\Domain\Application\ApprovalInput;
use App\Domain\Contact\Countries;
use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Entity\DoctorApplicationEvent;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Entity\SpecialistStatusEvent;
use App\Domain\Entity\User;
use App\Domain\Enum\DoctorApplicationStatus as S;
use App\Domain\Exception\ApplicationProblem;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\DoctorApplicationDocumentRepository;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Service\AfterResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\StaffPasswordService;
use App\Infrastructure\Storage\ApplicationDocumentStore;
use App\Infrastructure\Storage\CredentialStore;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * Approval (spec §4.2, D1–D5): one transaction under the application and email
 * locks creates the doctor's profile (status *invited*, not bookable until
 * they go live), their login (or reuses an unused invited one) and a VERIFIED
 * credential for every carried document — each file re-sealed under
 * `credentials/` with the reviewer's attestation. After the commit the
 * "Welcome aboard" set-password email goes synchronously (a failure is
 * reported, never a 500), then the SMS and the clean-up of the application's
 * copies of the carried files.
 */
final class ApplicationApprovalService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DoctorApplicationRepository $applications,
        private readonly DoctorApplicationDocumentRepository $documents,
        private readonly UserRepository $users,
        private readonly ApplicationDocumentStore $store,
        private readonly CredentialStore $credentialStore,
        private readonly StaffPasswordService $passwords,
        private readonly ApplicationNotifier $notifier,
        private readonly ApplicationViews $views,
        private readonly AuditLogger $audit,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @param array<string,mixed> $body ApproveApplicationInput
     * @return array{application: array<string,mixed>, specialist_id: string, invite: array<string,mixed>}
     */
    public function approve(string $id, array $body, ?string $actorId, string $actorName): array
    {
        $app = $this->applications->findApplication($id);
        if ($app === null || $app->isDraft()) {
            throw new EntityNotFoundException('Application not found');
        }

        $newKeys = [];
        $conn    = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('SELECT pg_advisory_xact_lock(' . DoctorApplicationService::LOCK_APPLICATION . ', hashtext(?))', [$id]);
            $conn->executeStatement('SELECT pg_advisory_xact_lock(' . DoctorApplicationService::LOCK_EMAIL . ', hashtext(?))', [$app->getEmail()]);
            $app = $this->applications->findForUpdate($id) ?? throw new EntityNotFoundException('Application not found');
            ApplicationReviewService::assertExpected($app, $body);
            $from = $app->getStatus();
            SM::assertCan($from, SM::APPROVE);

            $today  = ClinicTime::todayYmd();
            $now    = ClinicTime::now();
            $active = $this->documents->activeFor($id);
            $input  = ApprovalInput::validate($body, $app, $active, $today, $this->views->specialtyResolver());
            $login  = $this->views->loginState($app->getEmail());
            if ($login['state'] === 'blocked') {
                throw new ValidationException(['email' => (string) $login['problem']], (string) $login['problem']);
            }

            [$specialist, $user] = $this->createDoctor($app, $input['specialty'], $input['fee']);
            $credentials = [];
            foreach (ApprovalInput::carried($active) as $doc) {
                $credentials[] = $this->carry($doc, $specialist, $input['documents'][$doc->getId()], $actorId, $actorName, (string) $app->getReference(), $newKeys);
            }
            $route = $specialist->getLicenceRoute();
            $specialist->setLicenceExpiresAt(DoctorCredentials::currentLicence($credentials, $today, $route)?->getExpiresAt());

            $app->setStatus(S::APPROVED);
            $app->markDecided($now, $actorId, $actorName);
            $app->setSpecialistId($specialist->getId());
            $app->setAwaitingStaff(false);
            $app->setApprovalSnapshot([
                'locked'           => $specialist->lockedValues(),
                'credential_ids'   => array_map(static fn (SpecialistCredential $c): string => $c->getId(), $credentials),
                'consultation_fee' => $input['fee'],
                'specialty'        => $input['specialty'],
                'approved_by_id'   => $actorId,
                'approved_by_name' => $actorName,
                'approved_at'      => $now->format(DATE_ATOM),
            ]);

            $ref = (string) $app->getReference();
            $this->em->persist(new DoctorApplicationEvent($id, 'approved', 'staff', $from->value, S::APPROVED->value, $actorId, $actorName, true, at: $now));
            $this->em->persist(new DoctorApplicationEvent($id, 'specialist_created', 'staff', null, null, $actorId, $actorName, false, metadata: ['specialist_id' => $specialist->getId()], at: $now));
            $this->em->persist(new SpecialistStatusEvent($specialist->getId(), null, 'invited', $actorId, $actorName, 'Created from application ' . $ref, 'from_application', ['application_id' => $id]));
            $this->em->flush();
            $this->audit->record($actorName, 'admin', 'doctor_application.approved', null, 'doctor_application', $id, [
                'reference'        => $ref,
                'specialist_id'    => $specialist->getId(),
                'credential_count' => count($credentials),
            ], $actorId);
            $this->audit->record($actorName, 'admin', 'specialist.created_from_application', null, 'specialist', $specialist->getId(), [
                'doctor'         => $specialist->getName(),
                'application_id' => $id,
                'reference'      => $ref,
            ], $actorId);
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }
            foreach ($newKeys as $key) {
                $this->credentialStore->delete($key);
            }
            if ($e instanceof UniqueConstraintViolationException) {
                $this->logger?->warning('Doctor application approval unique constraint', ['application_id' => $id, 'error' => $e::class]);

                throw new ApplicationProblem(409, 'status_changed', 'This application or its email changed while you were approving. Reload and try again.');
            }

            throw $e;
        }

        $invite = $this->invite($app, $user, $specialist);
        $this->notifier->approved($app, (bool) ($invite['email_sent'] ?? false));
        $this->notifier->dispatch();
        $carried = array_values(array_filter(ApprovalInput::carried($active), static fn (DoctorApplicationDocument $d): bool => $d->getCredentialId() !== null));
        AfterResponse::defer(fn () => $this->purgeCarried($carried));

        return [
            'application'   => $this->views->detail($app),
            'specialist_id' => $specialist->getId(),
            'invite'        => $invite,
        ];
    }

    /**
     * The profile (invited) and the login, from the application.
     *
     * @return array{0: Specialist, 1: User}
     */
    private function createDoctor(DoctorApplication $app, string $specialty, string $fee): array
    {
        $personal     = $app->section('personal') ?? [];
        $professional = $app->section('professional') ?? [];
        $first        = (string) ($app->getFirstName() ?? '');
        $last         = (string) ($app->getLastName() ?? '');

        $s = new Specialist(mb_substr('Dr. ' . $first . ' ' . $last, 0, 200), $specialty);
        $s->setEmail($app->getEmail());
        $s->setPhone($app->getPhone());
        $dob = is_string($personal['date_of_birth'] ?? null) ? DateTimeImmutable::createFromFormat('!Y-m-d', $personal['date_of_birth']) : false;
        $s->setDateOfBirth($dob ?: null);
        $gender = $personal['gender'] ?? null;
        $s->setGender(in_array($gender, ['male', 'female'], true) ? $gender : null);
        $s->setCountry(Countries::name($app->getResidenceCountry()));
        $s->setLocation(trim((string) ($personal['city'] ?? '')) . ', ' . (string) $app->getResidenceCountry());
        $s->setYearsExperience(is_int($professional['years_experience'] ?? null) ? $professional['years_experience'] : null);
        $s->setLanguages(implode(', ', is_array($professional['languages'] ?? null) ? $professional['languages'] : []));
        $s->setBio(is_string($professional['bio'] ?? null) ? $professional['bio'] : null);

        $entries = [];
        foreach (($app->section('qualifications')['entries'] ?? []) as $entry) {
            if (!is_array($entry)) {
                continue;
            }
            $entries[] = [
                'title'       => (string) ($entry['degree'] ?? ''),
                'institution' => (string) ($entry['institution'] ?? ''),
                'year'        => (string) ($entry['year_awarded'] ?? ''),
            ];
        }
        $s->setQualificationEntries($entries);
        $s->setQualifications(mb_substr(implode(', ', array_map(static fn (array $e): string => $e['title'], $entries)), 0, 300));
        $s->setConsultationFee($fee);
        $s->setLicenceRoute($app->getLicenceRoute());
        if ($app->getLicenceRoute() === 'abroad') {
            $s->setRegistration($app->getRegulatorName(), $app->getRegulatorCountry(), $app->getRegistrationNumber());
        } else {
            $s->setMdcnNumber($app->getMdcnNumber());
        }
        $s->setApplicationId($app->getId());
        $portal = WebUrls::staffForOnboardingOrigin($app->getWebOrigin());
        $s->setWebOrigin($portal);
        $this->em->persist($s);

        $user = $this->users->findByEmail($app->getEmail());
        if ($user === null) {
            $user = new User($app->getEmail(), $first !== '' ? $first : 'Doctor', $last !== '' ? $last : 'Doctor');
            $user->setRoles(['doctor']);
            $user->setPermissions(['appointments.view']);
        }
        $user->setSpecialistId($s->getId());
        $user->setWebOrigin($portal);
        $this->em->persist($user);

        return [$s, $user];
    }

    /**
     * One carried document → a verified credential: the bytes re-sealed under
     * `credentials/` (the vault binds the key, so a file can't be copied).
     *
     * @param array{checked:bool, register_reference:string, number:?string, issued_on:?DateTimeImmutable, expires_on:?DateTimeImmutable} $attest
     * @param list<string> $newKeys
     */
    private function carry(DoctorApplicationDocument $doc, Specialist $s, array $attest, ?string $actorId, string $actorName, string $ref, array &$newKeys): SpecialistCredential
    {
        $bytes = $this->store->bytes($doc->getVaultKey());
        if ($bytes === null) {
            throw new ApplicationProblem(503, 'storage_unavailable', 'A document could not be read from secure storage. Nothing was approved.');
        }
        try {
            $key = $this->credentialStore->store($bytes);
        } catch (\Throwable) {
            throw new ApplicationProblem(503, 'storage_unavailable', 'A document could not be saved to secure storage. Nothing was approved.');
        }
        $newKeys[] = $key;

        $type       = (string) ApplicationDocuments::typeFor($doc->getSlot(), $s->getLicenceRoute());
        $credential = new SpecialistCredential($s->getId(), $type, $key, $doc->getOriginalName(), $doc->getMime(), $doc->getSizeBytes(), $doc->getSha256());
        $credential->setNumber($attest['number']);
        $credential->setIssuedAt($attest['issued_on']);
        $credential->setExpiresAt($attest['expires_on']);
        $credential->verify($actorId, $actorName, [
            'register_checked'   => true,
            'register_reference' => $attest['register_reference'],
            'note'               => 'Verified at application ' . $ref,
        ]);
        $this->em->persist($credential);
        $doc->setCredentialId($credential->getId());

        return $credential;
    }

    /**
     * The set-password email, after the commit. A failure is reported (the
     * reviewer resends the invite), never a 500 — the approval stands.
     *
     * @return array<string,mixed> DoctorInviteResultDto
     */
    private function invite(DoctorApplication $app, User $user, Specialist $s): array
    {
        $first = (string) $app->getFirstName();
        $last  = (string) $app->getLastName();
        $ref   = (string) $app->getReference();
        try {
            $result = $this->passwords->sendInvite(
                $user,
                $s->getName(),
                WebUrls::forSpecialist($s),
                static fn (string $name, string $link, int $days): array => EmailTemplates::applicationApproved($first, $last, $ref, $link, $days),
            );
        } catch (\Throwable $e) {
            $this->logger?->error('Approved applicant invite failed', ['application_id' => $app->getId(), 'error' => $e::class]);
            $result = ['email_sent' => false, 'expires_at' => ''];
        }
        $u = $user->toArray();

        return $result + ['login' => [
            'id'                => $u['id'],
            'email'             => $u['email'],
            'active'            => $u['active'],
            'password_set'      => $u['password_set'],
            'invite_pending'    => $u['invite_pending'],
            'invite_expires_at' => $u['invite_expires_at'],
        ]];
    }

    /**
     * After approval: the application's copies of the carried files go (the
     * credentials hold their own). `file_purged_at` is committed first — from
     * then on the staff file view reads the credential's copy — and only then
     * are the vault files deleted, so a failed flush never leaves rows
     * pointing at deleted files.
     *
     * @param list<DoctorApplicationDocument> $carried
     */
    private function purgeCarried(array $carried): void
    {
        if (!$this->em->isOpen() || $carried === []) {
            return;
        }
        try {
            $now = ClinicTime::now();
            foreach ($carried as $doc) {
                $doc->markFilePurged($now);
            }
            $this->em->flush();
        } catch (\Throwable $e) {
            $this->logger?->warning('Carried application files not purged', ['error' => $e::class]);

            return;
        }
        foreach ($carried as $doc) {
            $this->store->delete($doc->getVaultKey());
        }
    }
}
