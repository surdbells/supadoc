<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\NotificationType;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\InsufficientFundsException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Agora\AgoraKickingService;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;
use Doctrine\ORM\Exception\EntityManagerClosed;
use Ramsey\Uuid\Uuid;

/**
 * The patient's guests (third parties invited to a video consultation), end to
 * end: invite one after booking (paying the guest fee from the wallet or by
 * card — free when the fee is 0), remove one (their link stops working at
 * once; the fee goes back to the wallet when removed before the consultation
 * starts), re-send an invitation, and list them with each one's personal link.
 * Guests are emailed when invited, removed, and when the consultation moves
 * or is cancelled.
 *
 * Every change to the guest list is a read-modify-write of the appointment's
 * JSON under a row lock ({@see AppointmentRepository::lockAndRefresh()}), so
 * two at once can't lose one. A wallet charge moves first (the wallet posts in
 * its own transactions); a card payment is consumed inside the guest's own
 * transaction, so one payment invites one guest, once
 * ({@see PaymentIntentService::consume()}). If the guest then can't be added
 * (a race), the money goes to the wallet. Emails and notices never name the reason for the visit, a
 * diagnosis or a medicine, nor any guest's email to anyone but that guest.
 */
final class GuestInvitations
{
    /** A guest's invitation can be re-sent this often. */
    public const RESEND_INTERVAL_SECONDS = 120;
    /** A join link lives at least this long (and always until the guest window closes). */
    private const LINK_TTL = 2592000;
    /**
     * How long a removed guest's uid is kept out of the channel (minutes) —
     * longer than any token they could hold; their link can't get another.
     */
    private const EJECT_MINUTES = 60;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly AppointmentPaymentService $payments,
        private readonly PaymentIntentService $intents,
        private readonly PricingService $pricing,
        private readonly MailService $mail,
        private readonly JwtService $jwt,
        private readonly AuditLogger $audit,
        private readonly PatientNotifier $patientNotifier,
        private readonly StaffNotifier $staffNotifier,
        private readonly CallPresence $presence,
        private readonly AgoraKickingService $kicker,
    ) {
    }

    // ----- Rules -----

    /** Why the patient can't change this consultation's guests now, or null. */
    public static function manageProblem(Appointment $appointment, DateTimeImmutable $now): ?string
    {
        $status = $appointment->getStatus();

        return match (true) {
            $status === AppointmentStatus::PROPOSED => 'Accept this follow-up first — then you can invite guests.',
            !in_array($status, [AppointmentStatus::PENDING, AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED], true)
                => 'Guests can only be changed for an upcoming consultation.',
            $now > CallAccess::guestClosesAt($appointment) => 'This consultation has ended, so its guests can no longer be changed.',
            default => null,
        };
    }

    /**
     * Field errors for inviting `$name` / `$email` to this consultation: a name,
     * a valid email that isn't the patient's, the doctor's or an invited
     * guest's, and room on the list (MAX_GUESTS).
     *
     * @return array<string,string>
     */
    public static function newGuestProblems(Appointment $appointment, string $name, string $email): array
    {
        $errors = [];
        if (count($appointment->getGuests()) >= Appointment::MAX_GUESTS) {
            $errors['guests'] = 'You can invite at most ' . Appointment::MAX_GUESTS . ' guests';
        }
        if ($name === '') {
            $errors['name'] = "Enter the guest's name";
        } elseif (mb_strlen($name) > 100) {
            $errors['name'] = 'Keep the name to 100 characters or fewer';
        }
        $taken = array_map(static fn (array $g): string => (string) ($g['email'] ?? ''), $appointment->getGuests());
        if (($problem = self::emailProblem($email, $appointment->getPatient(), $appointment->getSpecialist(), $taken)) !== null) {
            $errors['email'] = $problem;
        }

        return $errors;
    }

    /**
     * Why `$email` can't be invited, or null: it must be valid and not the
     * patient's, the doctor's, or one already on the list (`$taken`).
     *
     * @param list<string> $taken
     */
    public static function emailProblem(string $email, Patient $patient, Specialist $doctor, array $taken): ?string
    {
        if ($email === '' || mb_strlen($email) > 190 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            return 'Enter a valid email address';
        }
        if (self::sameEmail($email, $patient->getEmail())) {
            return "That's your own email — invite someone else";
        }
        if ($doctor->getEmail() !== null && self::sameEmail($email, $doctor->getEmail())) {
            return "This email belongs to someone already in the consultation";
        }
        foreach ($taken as $other) {
            if (self::sameEmail($email, $other)) {
                return 'This person is already invited';
            }
        }

        return null;
    }

    /**
     * Field errors (`guests.N.email`) for the guests of a new booking: none may
     * be the patient, the doctor, or appear twice.
     *
     * @param list<array{name:string,email:string}> $guests
     * @return array<string,string>
     */
    public static function bookingGuestProblems(array $guests, Patient $patient, Specialist $doctor): array
    {
        $errors = [];
        $taken  = [];
        foreach ($guests as $i => $guest) {
            if (($problem = self::emailProblem($guest['email'], $patient, $doctor, $taken)) !== null) {
                $errors["guests.$i.email"] = $problem;
            }
            $taken[] = $guest['email'];
        }

        return $errors;
    }

    /** What a guest's removal gives back now: their fee before the consultation starts (if it was paid), else nothing. */
    public static function refundFor(Appointment $appointment, array $guest, DateTimeImmutable $now): ?string
    {
        $fee = bcadd((string) ($guest['fee'] ?? '0'), '0', 2);
        if (
            bccomp($fee, '0', 2) <= 0
            || $now >= $appointment->getScheduledAt()
            || $appointment->getPaymentStatus() !== 'paid'
        ) {
            return null;
        }

        return bccomp($fee, $appointment->getAmount(), 2) <= 0 ? $fee : bcadd($appointment->getAmount(), '0', 2);
    }

    /** invited → consented (accepted the notice in the lobby) → joined (was in the call). */
    public static function status(array $guest): string
    {
        return match (true) {
            ($guest['joined_at'] ?? null) !== null    => 'joined',
            ($guest['consented_at'] ?? null) !== null => 'consented',
            default                                   => 'invited',
        };
    }

    // ----- Links -----

    /**
     * A guest's personal join token: their gid and uid, valid at least until
     * their join window closes (a consultation booked months ahead included).
     */
    public static function token(JwtService $jwt, Appointment $appointment, array $guest): string
    {
        $ttl = max(self::LINK_TTL, CallAccess::guestClosesAt($appointment)->getTimestamp() - time() + 86400);

        return $jwt->issueCallAccess(
            $appointment->getId(),
            (string) ($guest['name'] ?? 'Guest'),
            'guest',
            (int) ($guest['uid'] ?? 0),
            $ttl,
            (string) ($guest['id'] ?? ''),
        );
    }

    /** A guest's join link — on the patient's site, which hosts the public call page. */
    public static function joinUrl(JwtService $jwt, Appointment $appointment, array $guest): string
    {
        return WebUrls::forPatient($appointment->getPatient()) . '/call/join/' . self::token($jwt, $appointment, $guest);
    }

    // ----- The patient's guest list -----

    public function fee(): string
    {
        return number_format($this->pricing->guestFee(), 2, '.', '');
    }

    /**
     * The guest list as the patient sees it: each guest with their email,
     * status, whether they are in the call now, and their personal link to
     * copy — plus what inviting another costs and whether the list can change.
     *
     * @return array<string,mixed>
     */
    public function listFor(Appointment $appointment): array
    {
        $now     = new DateTimeImmutable();
        $problem = self::manageProblem($appointment, $now);
        $inCall  = $this->presence->forAppointment($appointment)['guests'];
        $guests  = array_map(fn (array $g): array => $this->patientView($appointment, $g, $inCall), $appointment->getGuests());

        return [
            'guests'                  => $guests,
            'max_guests'              => Appointment::MAX_GUESTS,
            'guest_fee'               => $this->fee(),
            'currency'                => $this->pricing->currency(),
            'can_manage'              => $problem === null,
            'can_add'                 => $problem === null && count($guests) < Appointment::MAX_GUESTS,
            'manage_problem'          => $problem,
            // Removing a guest before this refunds their fee to the wallet.
            'refundable_until'        => $appointment->getScheduledAt()->format(DATE_ATOM),
            'window_closes_at'        => CallAccess::guestClosesAt($appointment)->format(DATE_ATOM),
            'resend_interval_seconds' => self::RESEND_INTERVAL_SECONDS,
        ];
    }

    /**
     * @param list<string> $inCall guest ids with a live heartbeat
     * @return array<string,mixed>
     */
    private function patientView(Appointment $appointment, array $guest, array $inCall): array
    {
        $id         = isset($guest['id']) ? (string) $guest['id'] : null;
        $lastSent   = (string) ($guest['last_sent_at'] ?? $guest['invited_at'] ?? '');
        $resendable = $lastSent !== '' ? (new DateTimeImmutable($lastSent))->modify('+' . self::RESEND_INTERVAL_SECONDS . ' seconds') : null;

        return [
            'id'                  => $id,
            'uid'                 => isset($guest['uid']) ? (int) $guest['uid'] : null,
            'name'                => (string) ($guest['name'] ?? ''),
            'email'               => (string) ($guest['email'] ?? ''),
            'display_name'        => $guest['display_name'] ?? null,
            'status'              => self::status($guest),
            'in_call'             => $id !== null && in_array($id, $inCall, true),
            'fee'                 => bcadd((string) ($guest['fee'] ?? '0'), '0', 2),
            'paid_by'             => $guest['paid_by'] ?? 'booking',
            'invited_at'          => $guest['invited_at'] ?? null,
            'last_sent_at'        => $guest['last_sent_at'] ?? null,
            'resend_available_at' => $resendable?->format(DATE_ATOM),
            'joined_at'           => $guest['joined_at'] ?? null,
            'consented_at'        => $guest['consented_at'] ?? null,
            // A guest not given an identity yet (bin/prod-migrate.php) has no link to copy.
            'join_url'            => $id !== null && isset($guest['uid']) ? self::joinUrl($this->jwt, $appointment, $guest) : null,
        ];
    }

    // ----- Invite / remove / re-send -----

    /**
     * Invite a guest to `$appointment` (the patient's — the caller checked),
     * paying the guest fee with `$method` (wallet | card + the verified
     * Paystack `$reference`) unless it is free. Returns the stored guest; the
     * guest is emailed their link, the doctor gets an in-app notice. If the
     * guest can't be stored after paying (the list closed or filled up
     * meanwhile — also when that is found before a card payment is checked),
     * the money goes back to the wallet and the 422 says so (`errors.payment =
     * credited_to_wallet`).
     *
     * @return array<string,mixed>
     * @throws ValidationException
     */
    public function add(Appointment $appointment, string $name, string $email, string $method, string $reference): array
    {
        $now       = new DateTimeImmutable();
        $name      = trim((string) preg_replace('/\s+/u', ' ', $name));
        $email     = trim($email);
        $method    = strtolower(trim($method));
        $reference = trim($reference);
        $problem   = self::manageProblem($appointment, $now);
        $errors    = $problem !== null ? ['status' => $problem] : self::newGuestProblems($appointment, $name, $email);
        if ($errors !== []) {
            // Paid by card while the list closed or filled up: nothing the patient
            // can change fixes that, so the payment goes to the wallet (once per
            // payment). A name / email problem keeps it for the retry.
            $returned = $method === 'card' && $reference !== '' && (isset($errors['status']) || isset($errors['guests']))
                ? $this->returnPayment($appointment, 'card', '0', '', $reference)
                : null;
            throw $this->refusal($errors, $problem, $returned);
        }

        $fee    = $this->fee();
        $free   = bccomp($fee, '0', 2) <= 0;
        if (!$free && !in_array($method, ['wallet', 'card'], true)) {
            throw new ValidationException(['payment_method' => 'Choose how to pay the guest fee: wallet or card']);
        }
        $gid = Uuid::uuid4()->toString();

        // A wallet charge first: the wallet posts (and flushes) in its own
        // transactions, so a short wallet leaves the list untouched.
        if (!$free && $method === 'wallet') {
            try {
                $this->payments->chargeGuest($appointment, $fee, $gid);
            } catch (InsufficientFundsException) {
                $short = 'Your wallet balance is too low to invite a guest. Pay by card, or top up your wallet and try again.';
                throw new ValidationException(['wallet' => 'insufficient_funds'], $short);
            }
        } elseif (!$free && $reference === '') {
            throw new ValidationException(['payment_reference' => 'Pay the guest fee by card first, then confirm with the payment reference']);
        }
        $paidBy = $free ? 'free' : $method;

        // Stored under the row lock, re-checked against what is saved now. A
        // card payment is consumed in this same transaction (it pays for one
        // guest, once). A refusal is handed back, not thrown, so the
        // transaction ends cleanly — and a card payment it took goes to the wallet.
        $store = function (?PaymentIntent $intent) use ($appointment, $now, $name, $email, $fee, $free, $paidBy, $gid): PaymentUse {
            $this->appointments->lockAndRefresh($appointment);
            if (($problem = self::manageProblem($appointment, $now)) !== null) {
                return PaymentUse::declined(['status', $problem], creditToWallet: true);
            }
            if (($errors = self::newGuestProblems($appointment, $name, $email)) !== []) {
                return PaymentUse::declined([(string) array_key_first($errors), (string) reset($errors)], creditToWallet: true);
            }
            $guest = $appointment->addGuest($name, $email, $free ? '0.00' : $fee, $paidBy, $intent?->getReference(), $now, $gid);
            if (!$free) {
                $appointment->setAmount(bcadd($appointment->getAmount(), $fee, 2));
            }
            $this->appointments->save($appointment);

            return PaymentUse::used($gid, $guest);
        };
        $stored = $paidBy === 'card'
            ? $this->intents->consume($reference, PaymentIntent::PURPOSE_GUEST, $appointment->getPatient()->getId(), $fee, $store, ['appointment_id' => $appointment->getId()])
            : $this->appointments->transactional(static fn (): PaymentUse => $store(null));
        if (!$stored->used) {
            [$field, $problem] = $stored->value;
            $returned = $paidBy === 'card' ? $stored->credited : $this->returnPayment($appointment, $paidBy, $fee, $gid, $reference);
            throw $this->refusal([$field => $problem], $problem, $returned);
        }
        $guest = $stored->value;

        $this->audit->record(
            self::patientName($appointment),
            'patient',
            'appointment.guest_added',
            $appointment->getId(),
            'guest',
            (string) $guest['id'],
            ['guest_id' => $guest['id'], 'fee' => $guest['fee'], 'paid_by' => $paidBy],
        );
        if ($paidBy === 'card') {
            $this->patientNotifier->notify(
                $appointment->getPatient(),
                NotificationType::PAYMENT,
                'Payment received',
                sprintf('We received your payment of %s for inviting a guest to your consultation with %s.', $this->money($fee), $appointment->getSpecialist()->getName()),
                '/dashboard/appointments/' . $appointment->getId(),
            );
        }
        $this->staffNotifier->notifyDoctor(
            $appointment->getSpecialist()->getId(),
            'appointment',
            'Guest invited',
            sprintf('%s invited %s to join the consultation on %s.', self::patientName($appointment, 'The patient'), (string) $guest['name'], FollowUpService::whenLabel($appointment->getScheduledAt())),
            '/appointments/' . $appointment->getId(),
        );
        $this->sendInvite($appointment, $guest);

        return $guest;
    }

    /**
     * Remove guest `$guestId` from `$appointment` (the patient's): their link
     * stops working at once, a call they are in ends for them ({@see eject()}),
     * they leave the presence list, and they are told by email. Removed before
     * the consultation starts, their fee goes back to the wallet (and off the
     * amount) in the same transaction.
     *
     * @return array{guest: array<string,mixed>, refunded: ?string}
     * @throws ValidationException|EntityNotFoundException
     */
    public function remove(Appointment $appointment, string $guestId): array
    {
        $now = new DateTimeImmutable();
        if (($problem = self::manageProblem($appointment, $now)) !== null) {
            throw new ValidationException(['status' => $problem], $problem);
        }
        if ($appointment->findGuest($guestId) === null) {
            throw new EntityNotFoundException('Guest not found');
        }

        $removed = $this->appointments->transactional(function () use ($appointment, $guestId, $now): ?array {
            $this->appointments->lockAndRefresh($appointment);
            $guest = $appointment->removeGuest($guestId);
            if ($guest === null) {
                return null; // removed by another request a moment ago
            }
            $refund = self::refundFor($appointment, $guest, $now);
            if ($refund !== null) {
                $appointment->setAmount(bcsub($appointment->getAmount(), $refund, 2));
            }
            $this->appointments->save($appointment);
            if ($refund !== null) {
                // Inside the transaction: if the refund can't post, the removal rolls back with it.
                $this->payments->refundGuest($appointment, $refund, $guestId);
            }

            return ['guest' => $guest, 'refunded' => $refund];
        });
        if ($removed === null) {
            throw new EntityNotFoundException('Guest not found');
        }

        $guest = $removed['guest'];
        $this->eject($appointment, $guest, $this->presence->forAppointment($appointment)['guests'], $now);
        $this->presence->clear($appointment, 'guest', $guestId);
        $this->audit->record(
            self::patientName($appointment),
            'patient',
            'appointment.guest_removed',
            $appointment->getId(),
            'guest',
            $guestId,
            ['guest_id' => $guestId, 'refunded' => $removed['refunded']],
        );
        $this->sendClosed($appointment, $guest, 'removed');

        return $removed;
    }

    /**
     * Re-send guest `$guestId`'s invitation (with a fresh link), at most once
     * per RESEND_INTERVAL_SECONDS. Returns the guest, or `retry_after` seconds
     * when it is too soon.
     *
     * @return array{guest: ?array<string,mixed>, retry_after: ?int}
     * @throws ValidationException|EntityNotFoundException
     */
    public function resend(Appointment $appointment, string $guestId): array
    {
        $now = new DateTimeImmutable();
        if (($problem = self::manageProblem($appointment, $now)) !== null) {
            throw new ValidationException(['status' => $problem], $problem);
        }
        $guest = $appointment->findGuest($guestId);
        if ($guest === null || !isset($guest['uid'])) {
            throw new EntityNotFoundException('Guest not found');
        }
        $wait = self::resendWait($guest, $now);
        if ($wait > 0) {
            return ['guest' => null, 'retry_after' => $wait];
        }

        $sent = $this->appointments->transactional(function () use ($appointment, $guestId, $now): ?array {
            $this->appointments->lockAndRefresh($appointment);
            $guest = $appointment->findGuest($guestId);
            if ($guest === null || self::resendWait($guest, $now) > 0) {
                return $guest === null ? null : ['wait' => self::resendWait($guest, $now)];
            }
            $guest = $appointment->updateGuest($guestId, ['last_sent_at' => $now->format(DATE_ATOM)]);
            $this->appointments->save($appointment);

            return ['guest' => $guest];
        });
        if ($sent === null) {
            throw new EntityNotFoundException('Guest not found');
        }
        if (isset($sent['wait'])) {
            return ['guest' => null, 'retry_after' => (int) $sent['wait']];
        }

        $this->sendInvite($appointment, $sent['guest'], true);
        $this->audit->record(
            self::patientName($appointment),
            'patient',
            'appointment.guest_invite_resent',
            $appointment->getId(),
            'guest',
            $guestId,
            ['guest_id' => $guestId],
        );

        return ['guest' => $sent['guest'], 'retry_after' => null];
    }

    /** Seconds until this guest's invitation can be re-sent (0: now). */
    public static function resendWait(array $guest, DateTimeImmutable $now): int
    {
        $last = (string) ($guest['last_sent_at'] ?? $guest['invited_at'] ?? '');
        if ($last === '') {
            return 0;
        }

        return max(0, (new DateTimeImmutable($last))->getTimestamp() + self::RESEND_INTERVAL_SECONDS - $now->getTimestamp());
    }

    // ----- In the call -----

    /**
     * The guest accepted the call's recording + privacy notice in the lobby
     * (and maybe chose the name they show as). Kept on their entry with the
     * notice version; audited (`call.guest_consented`, guest id only).
     *
     * @return array<string,mixed>|null the updated guest, or null when no longer invited
     */
    public function recordConsent(Appointment $appointment, string $guestId, ?string $displayName): ?array
    {
        $now   = new DateTimeImmutable();
        $guest = $this->appointments->transactional(function () use ($appointment, $guestId, $displayName, $now): ?array {
            $this->appointments->lockAndRefresh($appointment);
            $guest = $appointment->findGuest($guestId);
            if ($guest === null) {
                return null;
            }
            $same    = ($guest['consent_version'] ?? null) === GuestConsent::VERSION && ($guest['consented_at'] ?? null) !== null;
            $changes = [
                'consented_at'    => $same ? $guest['consented_at'] : $now->format(DATE_ATOM),
                'consent_version' => GuestConsent::VERSION,
            ];
            if ($displayName !== null) {
                $changes['display_name'] = $displayName;
            }
            $guest = $appointment->updateGuest($guestId, $changes);
            $this->appointments->save($appointment);

            return $guest;
        });
        if ($guest !== null) {
            $this->audit->record('Guest', 'guest', 'call.guest_consented', $appointment->getId(), 'guest', $guestId, [
                'guest_id' => $guestId,
                'version'  => GuestConsent::VERSION,
            ]);
        }

        return $guest;
    }

    /**
     * A guest's heartbeat: the first one records when they first joined, and
     * every (re)join — a heartbeat that starts a presence — is audited
     * (`call.guest_joined`, guest id only).
     */
    public function markJoined(Appointment $appointment, array $guest, bool $newlyPresent): void
    {
        $gid   = (string) ($guest['id'] ?? '');
        $first = ($guest['joined_at'] ?? null) === null;
        if ($first) {
            $this->appointments->transactional(function () use ($appointment, $gid): void {
                $this->appointments->lockAndRefresh($appointment);
                $current = $appointment->findGuest($gid);
                if ($current !== null && ($current['joined_at'] ?? null) === null) {
                    $appointment->updateGuest($gid, ['joined_at' => (new DateTimeImmutable())->format(DATE_ATOM)]);
                    $this->appointments->save($appointment);
                }
            });
        }
        if ($first || $newlyPresent) {
            $this->audit->record('Guest', 'guest', 'call.guest_joined', $appointment->getId(), 'guest', $gid, ['guest_id' => $gid]);
        }
    }

    // ----- Emails -----

    /** Email a guest their invitation (or a re-send) with their personal link. Never breaks the caller. */
    public function sendInvite(Appointment $appointment, array $guest, bool $resend = false): void
    {
        if (!isset($guest['id'], $guest['uid'])) {
            return;
        }
        try {
            $mail = EmailTemplates::guestInvite(
                (string) $guest['name'],
                self::inviterFirstName($appointment),
                $appointment->getSpecialist()->getName(),
                FollowUpService::whenLabel($appointment->getScheduledAt()),
                self::joinUrl($this->jwt, $appointment, $guest),
                $resend,
            );
            $this->mail->send((string) $guest['email'], (string) $guest['name'], $mail['subject'], $mail['html']);
        } catch (\Throwable) {
            // logged inside MailService; the invitation already stands.
        }
    }

    /** Every guest of a moved consultation gets the new time and a fresh link (both reschedule paths). */
    public function notifyRescheduled(Appointment $appointment): void
    {
        $when    = FollowUpService::whenLabel($appointment->getScheduledAt());
        $inviter = self::inviterFirstName($appointment);
        foreach ($appointment->getGuests() as $guest) {
            if (!isset($guest['id'], $guest['uid'])) {
                continue;
            }
            try {
                $mail = EmailTemplates::guestRescheduled(
                    (string) $guest['name'],
                    $inviter,
                    $appointment->getSpecialist()->getName(),
                    $when,
                    self::joinUrl($this->jwt, $appointment, $guest),
                );
                $this->mail->send((string) $guest['email'], (string) $guest['name'], $mail['subject'], $mail['html']);
            } catch (\Throwable) {
                // logged inside MailService; the reschedule already succeeded.
            }
        }
    }

    /**
     * Every guest of a cancelled (or declined, or closed) consultation is
     * told; their links stop working, and a call they are in ends for them.
     */
    public function notifyCancelled(Appointment $appointment): void
    {
        // Re-read under the row lock (the cancellation is saved): a guest given a
        // token a moment ago shows here, and one joining from now on is refused.
        try {
            $this->appointments->transactional(fn () => $this->appointments->lockAndRefresh($appointment));
        } catch (EntityManagerClosed) {
            // A later suspension batch failed and closed the entity manager; this
            // cancellation was already committed — tell the guests as loaded.
        }
        $now    = new DateTimeImmutable();
        $inCall = $this->presence->forAppointment($appointment)['guests'];
        foreach ($appointment->getGuests() as $guest) {
            if (isset($guest['id'])) {
                // Putting them out of the call is best effort: they are told either way.
                try {
                    $this->eject($appointment, $guest, $inCall, $now);
                    $this->presence->clear($appointment, 'guest', (string) $guest['id']);
                } catch (\Throwable $e) {
                    error_log('[guests] ending a cancelled call for a guest failed: ' . $e->getMessage());
                }
            }
            $this->sendClosed($appointment, $guest, 'cancelled');
        }
    }

    /**
     * Put a guest who lost their place out of the call now, when they may
     * still hold an Agora token (one issued within its lifetime, or in the
     * call by heartbeat): their link already stopped working, but a token in
     * hand would otherwise last until it expires. Their uid (never handed out
     * again) is kept out of the appointment's channel for EJECT_MINUTES (not
     * the shared channel of the dev-only static token).
     *
     * @param list<string> $inCall guest ids with a live heartbeat
     */
    private function eject(Appointment $appointment, array $guest, array $inCall, DateTimeImmutable $now): void
    {
        $uid = (int) ($guest['uid'] ?? 0);
        if ($uid <= 0 || !(in_array((string) ($guest['id'] ?? ''), $inCall, true) || CallAccess::guestMayHoldToken($guest, $now))) {
            return;
        }
        $this->kicker->kick($appointment->getId(), $uid, self::EJECT_MINUTES);
    }

    /** `removed` | `cancelled`. */
    private function sendClosed(Appointment $appointment, array $guest, string $why): void
    {
        try {
            $mail = EmailTemplates::guestCallClosed(
                (string) ($guest['name'] ?? ''),
                self::inviterFirstName($appointment),
                $appointment->getSpecialist()->getName(),
                FollowUpService::whenLabel($appointment->getScheduledAt()),
                $why,
            );
            $this->mail->send((string) ($guest['email'] ?? ''), (string) ($guest['name'] ?? ''), $mail['subject'], $mail['html']);
        } catch (\Throwable) {
            // logged inside MailService; the change already stands.
        }
    }

    // ----- Helpers -----

    /**
     * A refused invitation's 422. When its payment went back to the wallet
     * (`$returned`), `errors.payment = credited_to_wallet` and the message
     * says how much.
     *
     * @param array<string,string> $errors
     */
    private function refusal(array $errors, ?string $message, ?string $returned): ValidationException
    {
        if ($returned === null) {
            return new ValidationException($errors, $message ?? 'Validation failed');
        }

        return new ValidationException(
            $errors + ['payment' => 'credited_to_wallet'],
            ($message ?? (string) reset($errors)) . ' Your payment of ' . $this->money($returned) . ' was added to your VideoMed wallet.',
        );
    }

    /**
     * Give back the guest fee a refused invitation took: a wallet charge is
     * credited back; a card payment made to invite a guest to this
     * consultation is credited to the wallet (once per payment). Returns the
     * amount, or null when nothing was taken.
     */
    private function returnPayment(Appointment $appointment, string $paidBy, string $fee, string $gid, string $reference): ?string
    {
        try {
            return match ($paidBy) {
                'wallet' => $this->payments->creditBack($appointment, $fee, 'appt_guest_return_' . $gid)->getAmount(),
                'card'   => $this->intents->settleUnusedFor(
                    $reference,
                    $appointment->getPatient()->getId(),
                    PaymentIntent::PURPOSE_GUEST,
                    ['appointment_id' => $appointment->getId()],
                ),
                default  => null,
            };
        } catch (\Throwable $e) {
            error_log('[guests] returning a guest fee failed: ' . $e->getMessage());

            return null;
        }
    }

    /** The patient's first name — how guests are told who invited them. */
    public static function inviterFirstName(Appointment $appointment): string
    {
        return trim((string) ($appointment->getPatient()->toArray()['first_name'] ?? ''));
    }

    private static function patientName(Appointment $appointment, string $fallback = 'Patient'): string
    {
        $p    = $appointment->getPatient()->toArray();
        $name = trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? ''));

        return $name !== '' ? $name : $fallback;
    }

    private static function sameEmail(string $a, string $b): bool
    {
        return $a !== '' && mb_strtolower(trim($a)) === mb_strtolower(trim($b));
    }

    /** "₦5,000.00". */
    private function money(string $amount): string
    {
        $currency = $this->pricing->currency() === 'NGN' ? '₦' : $this->pricing->currency();

        return $currency . number_format((float) $amount, 2);
    }
}
