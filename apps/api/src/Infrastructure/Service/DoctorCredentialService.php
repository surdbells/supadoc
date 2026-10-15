<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Doctor\DoctorCredentials;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\ClinicTime;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Storage\CredentialStore;
use DateTimeImmutable;
use Psr\Http\Message\UploadedFileInterface;

/**
 * Doctors' licensing documents end to end: the doctor uploads (a licence needs
 * its number and expiry date), a reviewer verifies each against the MDCN
 * register — attesting to it — or rejects it with a reason. A newer upload of
 * the same kind replaces an older one still waiting; once verified, it
 * replaces the older verified one (so a renewed licence never leaves a gap).
 * The doctor's `licence_expires_at` follows their current verified licence,
 * and a doctor approved before documents existed is cleared of their
 * "credentials due" date (and given an approval snapshot) once both are
 * verified. The doctor's emails go after the response. Uploads, verifications and
 * rejections are audited; reviewers' file views are audited by the action.
 */
final class DoctorCredentialService
{
    /** Documents a doctor may have waiting for review at once. */
    public const MAX_PENDING = 10;

    public const MAX_REFERENCE = 120;
    public const MAX_NOTE      = 1000;

    public function __construct(
        private readonly SpecialistCredentialRepository $credentials,
        private readonly SpecialistRepository $specialists,
        private readonly CredentialStore $store,
        private readonly AuditLogger $audit,
        private readonly StaffNotifier $notifier,
        private readonly MailService $mail,
        private readonly UserRepository $users,
        private readonly DoctorOnboardingService $onboarding,
    ) {
    }

    // ----- Rules (pure) -----

    /**
     * The upload's fields, checked: `type`, `number` (required for a
     * licence), `issued_at` (not in the future) and `expires_at` (required for
     * a licence, not already past), dates as YYYY-MM-DD.
     *
     * @return array{type:string, number:?string, issued_at:?DateTimeImmutable, expires_at:?DateTimeImmutable}
     * @throws ValidationException
     */
    public static function uploadFields(array $body, string $todayYmd): array
    {
        $errors = [];
        $type   = trim((string) ($body['type'] ?? ''));
        if (!isset(SpecialistCredential::TYPES[$type])) {
            $errors['type'] = 'Choose the document type: ' . implode(', ', array_keys(SpecialistCredential::TYPES));
        }
        $number = self::number($body['number'] ?? null, $errors);
        $issued = self::date($body['issued_at'] ?? null, 'issued_at', $errors);
        $expiry = self::date($body['expires_at'] ?? null, 'expires_at', $errors);

        if ($issued !== null && $issued->format('Y-m-d') > $todayYmd) {
            $errors['issued_at'] = 'The issue date cannot be in the future';
        }
        if ($type === SpecialistCredential::TYPE_LICENCE) {
            if ($number === null && !isset($errors['number'])) {
                $errors['number'] = 'Enter the licence number';
            }
            if ($expiry === null && !isset($errors['expires_at'])) {
                $errors['expires_at'] = 'Enter the date the licence expires';
            }
        }
        if ($expiry !== null && $expiry->format('Y-m-d') < $todayYmd) {
            $errors['expires_at'] = 'This document has already expired — upload your current one';
        } elseif ($issued !== null && $expiry !== null && $expiry < $issued) {
            $errors['expires_at'] = 'The expiry date cannot be before the issue date';
        }
        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        return ['type' => $type, 'number' => $number, 'issued_at' => $issued, 'expires_at' => $expiry];
    }

    /**
     * The reviewer's verification: they must confirm they checked the MDCN
     * register and give the register reference (an optional note); a licence
     * must end up with an expiry date that hasn't passed (the uploaded one, or
     * `expires_at` correcting it) and may have its `number` corrected.
     *
     * @return array{attestation: array{register_checked:bool, register_reference:string, note:?string}, expires_at:?DateTimeImmutable, number:?string}
     * @throws ValidationException
     */
    public static function verifyFields(SpecialistCredential $c, array $body, string $todayYmd): array
    {
        if (!$c->isPending()) {
            $message = $c->isVerified() ? 'This document is already verified' : 'Only a document waiting for review can be verified';

            throw new ValidationException(['status' => $message], $message);
        }
        $errors  = [];
        $checked = $body['register_checked'] ?? null;
        if (!in_array($checked, [true, 1, '1', 'true'], true)) {
            $errors['register_checked'] = 'Confirm that you checked the MDCN register';
        }
        $reference = trim((string) ($body['register_reference'] ?? ''));
        if ($reference === '') {
            $errors['register_reference'] = 'Enter the register reference you checked';
        } elseif (mb_strlen($reference) > self::MAX_REFERENCE) {
            $errors['register_reference'] = 'Keep the reference to ' . self::MAX_REFERENCE . ' characters';
        }
        $note = trim((string) ($body['note'] ?? ''));
        if (mb_strlen($note) > self::MAX_NOTE) {
            $errors['note'] = 'Keep the note to ' . self::MAX_NOTE . ' characters';
        }
        $number = array_key_exists('number', $body) ? self::number($body['number'], $errors) : null;
        $expiry = self::date($body['expires_at'] ?? null, 'expires_at', $errors);
        $final  = $expiry ?? $c->getExpiresAt();
        if ($c->getType() === SpecialistCredential::TYPE_LICENCE && $final === null && !isset($errors['expires_at'])) {
            $errors['expires_at'] = 'Enter the date the licence expires';
        } elseif ($final !== null && $final->format('Y-m-d') < $todayYmd && !isset($errors['expires_at'])) {
            $errors['expires_at'] = 'This document has expired, so it cannot be verified';
        }
        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        return [
            'attestation' => ['register_checked' => true, 'register_reference' => $reference, 'note' => $note !== '' ? $note : null],
            'expires_at'  => $expiry,
            'number'      => $number,
        ];
    }

    /**
     * Whether a doctor approved before documents existed (a "credentials due"
     * date, or practising with no approval snapshot) now has both documents
     * verified — {@see verify()} then clears the due date and snapshots them.
     *
     * @param list<SpecialistCredential> $credentials
     */
    public static function completesLegacy(Specialist $s, array $credentials, string $todayYmd): bool
    {
        $legacy = $s->getCredentialsDueAt() !== null || ($s->hasLockedFields() && $s->getApprovedSnapshot() === null);

        return $legacy && DoctorCredentials::complete($credentials, $todayYmd);
    }

    // ----- Doctor -----

    /**
     * Store a document the doctor uploaded (multipart `file` + fields).
     *
     * @throws ValidationException|\DomainException (no secure storage: 409)
     */
    public function upload(Specialist $s, UploadedFileInterface $file, array $body, ?string $actorId): SpecialistCredential
    {
        $fields = self::uploadFields($body, ClinicTime::todayYmd());
        if ($this->credentials->countPendingFor($s->getId()) >= self::MAX_PENDING) {
            throw new ValidationException(['file' => 'You already have ' . self::MAX_PENDING . ' documents waiting for review. Delete one, or wait until they are checked.']);
        }
        $read = $this->store->read($file);
        $key  = $this->store->store($read['bytes']);

        $credential = new SpecialistCredential($s->getId(), $fields['type'], $key, $read['name'], $read['mime'], $read['size'], $read['sha256']);
        $credential->setNumber($fields['number']);
        $credential->setIssuedAt($fields['issued_at']);
        $credential->setExpiresAt($fields['expires_at']);

        // One MDCN certificate / licence waits at a time: a newer upload replaces the older one.
        if ($fields['type'] !== SpecialistCredential::TYPE_SPECIALIST) {
            foreach ($this->credentials->forSpecialist($s->getId()) as $older) {
                if ($older->getType() === $fields['type'] && $older->isPending()) {
                    $older->supersede();
                }
            }
        }
        try {
            $this->credentials->save($credential);
        } catch (\Throwable $e) {
            $this->store->delete($key); // never leave an orphaned sealed file
            throw $e;
        }

        $this->record($s->getName(), 'doctor', 'specialist.credential_uploaded', $s, [
            'credential_id' => $credential->getId(),
            'type'          => $credential->getType(),
            'number'        => $credential->getNumber(),
            'expires_at'    => $credential->expiresYmd(),
            'size_bytes'    => $read['size'],
            'sha256'        => $read['sha256'],
        ], $actorId);

        // A live doctor's (or one in review's) new document needs a reviewer now;
        // one still onboarding is reviewed when they submit.
        if ($s->hasLockedFields() || $s->getStatus() === SpecialistStatus::PENDING_REVIEW) {
            $this->onboarding->notifyReviewers(
                $s,
                'New document to verify: ' . $s->getName(),
                $s->getName() . ' uploaded a new ' . strtolower($credential->typeLabel()) . ' to be verified.',
            );
        }

        return $credential;
    }

    /** The doctor deletes a document still waiting for review (a verified one stays on record). */
    public function deleteByDoctor(Specialist $s, SpecialistCredential $c, ?string $actorId): void
    {
        if (!$c->isPending()) {
            throw new ValidationException(['status' => 'Only a document waiting for review can be deleted. Upload a newer one instead.']);
        }
        $key = $c->getVaultKey();
        $this->credentials->remove($c);
        $this->credentials->flush();
        $this->store->delete($key);
        $this->record($s->getName(), 'doctor', 'specialist.credential_deleted', $s, [
            'credential_id' => $c->getId(),
            'type'          => $c->getType(),
        ], $actorId);
    }

    /** The document's bytes (owner / reviewer endpoints only), or null when unreadable. */
    public function bytes(SpecialistCredential $c): ?string
    {
        return $this->store->bytes($c->getVaultKey());
    }

    // ----- Reviewer -----

    /**
     * Verify a document with the reviewer's attestation (see verifyFields()).
     *
     * @throws ValidationException
     */
    public function verify(Specialist $s, SpecialistCredential $c, array $body, ?string $actorId, string $actorName): SpecialistCredential
    {
        $today  = ClinicTime::todayYmd();
        $fields = self::verifyFields($c, $body, $today);
        if ($fields['expires_at'] !== null) {
            $c->setExpiresAt($fields['expires_at']);
        }
        if ($fields['number'] !== null) {
            $c->setNumber($fields['number']);
        }
        $c->verify($actorId, $actorName, $fields['attestation']);

        $all = $this->credentials->forSpecialist($s->getId());
        // The newly verified document replaces the older verified one of its kind.
        if ($c->getType() !== SpecialistCredential::TYPE_SPECIALIST) {
            foreach ($all as $older) {
                if ($older !== $c && $older->getType() === $c->getType() && $older->isVerified()) {
                    $older->supersede();
                }
            }
        }
        if ($c->getType() === SpecialistCredential::TYPE_LICENCE) {
            $s->setLicenceExpiresAt(DoctorCredentials::currentLicence($all, $today)?->getExpiresAt());
        }
        // A doctor approved before documents existed is complete once both are
        // verified: no longer due, and snapshotted like an approval — so the
        // licence cron stops treating them as a legacy doctor.
        if (self::completesLegacy($s, $all, $today)) {
            $s->setCredentialsDueAt(null);
            $s->markVerified();
            $s->snapshotApproval(DoctorCredentials::verifiedIds($all, $today), $actorId, $actorName);
        }
        $this->specialists->save($s); // flushes the documents with it

        $this->record($actorName, 'admin', 'specialist.credential_verified', $s, [
            'credential_id' => $c->getId(),
            'type'          => $c->getType(),
            'number'        => $c->getNumber(),
            'expires_at'    => $c->expiresYmd(),
            'attestation'   => $fields['attestation'],
        ], $actorId);
        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Document verified', 'Your ' . strtolower($c->typeLabel()) . ' has been verified.', '/onboarding');

        return $c;
    }

    /**
     * Turn a document down (waiting or verified) with a reason the doctor sees;
     * they are told in-app and by email.
     *
     * @throws ValidationException
     */
    public function reject(Specialist $s, SpecialistCredential $c, string $reason, ?string $actorId, string $actorName): void
    {
        $reason = trim($reason);
        if ($reason === '') {
            throw new ValidationException(['reason' => 'Tell the doctor why the document was not accepted']);
        }
        if (mb_strlen($reason) > self::MAX_NOTE) {
            throw new ValidationException(['reason' => 'Keep the reason to ' . self::MAX_NOTE . ' characters']);
        }
        if (!$c->isPending() && !$c->isVerified()) {
            throw new ValidationException(['status' => 'This document was already replaced or turned down']);
        }

        $wasVerified = $c->isVerified();
        $c->reject($reason, $actorId, $actorName);
        if ($wasVerified && $c->getType() === SpecialistCredential::TYPE_LICENCE) {
            $s->setLicenceExpiresAt(DoctorCredentials::currentLicence($this->credentials->forSpecialist($s->getId()), ClinicTime::todayYmd())?->getExpiresAt());
        }
        $this->specialists->save($s);

        $this->record($actorName, 'admin', 'specialist.credential_rejected', $s, [
            'credential_id' => $c->getId(),
            'type'          => $c->getType(),
            'reason'        => $reason,
            'was_verified'  => $wasVerified,
        ], $actorId);
        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Document not accepted', $c->typeLabel() . ': ' . $reason, '/onboarding');
        try {
            $tpl   = EmailTemplates::doctorCredentialRejected($s->getName(), $c->typeLabel(), $reason, WebUrls::forSpecialist($s));
            $email = $this->users->findBySpecialist($s->getId())?->getEmail() ?? $s->getEmail();
            $name  = $s->getName();
            if ($email !== null && $email !== '') {
                // After the response (a failure is logged; the decision already stands).
                AfterResponse::defer(fn () => $this->mail->send($email, $name, $tpl['subject'], $tpl['html']));
            }
        } catch (\Throwable) {
            // non-fatal — the decision already stands.
        }
    }

    // ----- Helpers -----

    /** @param array<string,string> $errors */
    private static function number(mixed $raw, array &$errors): ?string
    {
        $number = trim((string) ($raw ?? ''));
        if ($number === '') {
            return null;
        }
        if (mb_strlen($number) > 60 || preg_match('/^[A-Za-z0-9\/\-. ]{2,60}$/', $number) !== 1) {
            $errors['number'] = 'Enter the number as printed (letters, numbers, / . or -)';

            return null;
        }

        return strtoupper($number);
    }

    /** @param array<string,string> $errors */
    private static function date(mixed $raw, string $field, array &$errors): ?DateTimeImmutable
    {
        $value = trim((string) ($raw ?? ''));
        if ($value === '') {
            return null;
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
        if ($date === false || $date->format('Y-m-d') !== $value) {
            $errors[$field] = 'Enter a valid date (YYYY-MM-DD)';

            return null;
        }

        return $date;
    }

    /** @param array<string,mixed> $metadata */
    private function record(string $actorName, string $role, string $action, Specialist $s, array $metadata, ?string $actorId): void
    {
        try {
            $this->audit->record($actorName, $role, $action, null, 'specialist', $s->getId(), $metadata + ['doctor' => $s->getName()], $actorId);
        } catch (\Throwable) {
            // non-fatal — the change itself is saved.
        }
    }
}
