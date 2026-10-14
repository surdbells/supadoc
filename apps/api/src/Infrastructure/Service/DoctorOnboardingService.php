<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\PayoutAccountRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use DateTimeImmutable;

/**
 * Doctor onboarding: admin invites → doctor sets a password and completes the
 * checklist → submits for review → admin approves (listed + bookable) or sends
 * it back with a reason. The checklist rule itself is pure ({@see checklistFrom()})
 * so it is unit-tested without a database.
 */
final class DoctorOnboardingService
{
    /** Checklist keys, in the order the doctor works through them. */
    public const ITEMS = ['photo', 'bio', 'qualifications', 'mdcn', 'signature', 'availability', 'payout'];

    /** What each missing item asks for, for the "not ready yet" message. */
    private const MISSING_LABELS = [
        'photo'          => 'a profile photo',
        'bio'            => 'a short bio',
        'qualifications' => 'your qualifications',
        'mdcn'           => 'your MDCN registration number',
        'signature'      => 'your signature',
        'availability'   => 'your availability',
        'payout'         => 'a payout account',
    ];

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly AvailabilitySlotRepository $slots,
        private readonly PayoutAccountRepository $payoutAccounts,
        private readonly StaffPasswordService $passwords,
        private readonly MailService $mail,
        private readonly StaffNotifier $notifier,
        /** Back-office base URL for the reviewers' email ('' = no link, see {@see backofficeUrlFromEnv()}). */
        private readonly string $backofficeUrl = '',
    ) {
    }

    /**
     * The back office's base URL: BACKOFFICE_WEB_URL, else the CORS-allowed
     * origin whose host starts with "backoffice." (how the portals are deployed),
     * else '' — the reviewers' email then says where to look instead of linking.
     */
    public static function backofficeUrlFromEnv(array $env): string
    {
        $isWeb = static fn (string $url): bool => preg_match('#^https?://[^/\s]+$#i', $url) === 1;

        $explicit = rtrim(trim((string) ($env['BACKOFFICE_WEB_URL'] ?? '')), '/');
        if ($isWeb($explicit)) {
            return $explicit;
        }
        foreach (explode(',', (string) ($env['CORS_ALLOWED_ORIGINS'] ?? '')) as $origin) {
            $origin = rtrim(trim($origin), '/');
            if ($isWeb($origin) && str_starts_with(strtolower((string) parse_url($origin, PHP_URL_HOST)), 'backoffice.')) {
                return $origin;
            }
        }

        return '';
    }

    /**
     * Why a NEW doctor login can't be made for this specialist from their
     * contact email, or null when it can. A live doctor (approved, legacy or
     * suspended) has appointments and patient records, and `specialists.manage`
     * can change the contact email — so an invite that creates a login there
     * could hand that inbox's owner the doctor's patient records. Their login
     * has to be created from Staff (`staff.manage`) instead. Doctors still
     * onboarding can't have been booked, so there is nothing to expose.
     */
    public static function newLoginProblem(Specialist $s): ?string
    {
        $status = $s->getStatus(); // a legacy NULL reads as APPROVED

        return $status === SpecialistStatus::APPROVED || $status === SpecialistStatus::SUSPENDED
            ? 'This doctor is already live, so their login has to be created from Staff & roles.'
            : null;
    }

    /**
     * The checklist rule. Availability counts either recurring weekly hours or at
     * least one published open slot from now on.
     *
     * @return array<string,bool> keyed by {@see ITEMS}
     */
    public static function checklistFrom(Specialist $s, bool $hasOpenSlots, bool $hasPayoutAccount): array
    {
        $hours = array_filter(
            $s->getWeeklyHours() ?? [],
            static fn (mixed $windows): bool => is_array($windows) && $windows !== [],
        );

        return [
            'photo'          => ($s->getPhotoUrl() ?? '') !== '',
            'bio'            => trim((string) $s->getBio()) !== '',
            'qualifications' => trim((string) $s->getQualifications()) !== '' || $s->getQualificationEntries() !== [],
            'mdcn'           => ($s->getMdcnNumber() ?? '') !== '',
            'signature'      => $s->getSignatureKey() !== null,
            'availability'   => $hours !== [] || $hasOpenSlots,
            'payout'         => $hasPayoutAccount,
        ];
    }

    /** @param array<string,bool> $checklist */
    public static function isComplete(array $checklist): bool
    {
        foreach (self::ITEMS as $key) {
            if (($checklist[$key] ?? false) !== true) {
                return false;
            }
        }

        return true;
    }

    /** @return array<string,bool> */
    public function checklist(Specialist $s): array
    {
        return self::checklistFrom(
            $s,
            $this->slots->hasOpenSlotsSince($s->getId(), new DateTimeImmutable()),
            $this->payoutAccounts->forSpecialist($s->getId()) !== null,
        );
    }

    /**
     * Everything the onboarding page (doctor) and the review panel (admin) show.
     *
     * @return array<string,mixed>
     */
    public function summary(Specialist $s): array
    {
        $checklist = $this->checklist($s);

        return $s->toReviewArray() + [
            'checklist' => $checklist,
            'completed' => count(array_filter($checklist)),
            'total'     => count($checklist),
            'complete'  => self::isComplete($checklist),
        ];
    }

    /**
     * Invite (or re-invite) the doctor: find or create their login — no usable
     * password until they choose one — and email a set-password link. Calling
     * it again is a resend: the old link stops working.
     *
     * A login that already exists keeps its own email (the invite goes there),
     * and one whose password is already set can't be invited at all — so
     * `specialists.manage` can never be used to take over a doctor's account by
     * pointing the contact email elsewhere. Changing a login's email stays a
     * `staff.manage` action, and so does creating a login for a doctor who is
     * already live ({@see newLoginProblem()}).
     *
     * @return array<string,mixed>
     */
    public function invite(Specialist $s): array
    {
        $user = $this->users->findBySpecialist($s->getId());
        if ($user !== null && $user->hasPassword()) {
            throw new ValidationException(['email' => 'This doctor has already set a password. They can use "Forgot password?" on the sign-in page.']);
        }

        // A live doctor with no login: never create one from the (editable) contact email.
        $problem = $user === null ? self::newLoginProblem($s) : null;
        if ($problem !== null) {
            throw new ValidationException(['email' => $problem]);
        }

        $email = strtolower(trim((string) $s->getEmail()));
        if ($user === null && ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL))) {
            throw new ValidationException(['email' => "Add the doctor's email address before sending an invite"]);
        }

        if ($user === null) {
            $existing = $this->users->findByEmail($email);
            if ($existing !== null) {
                if ($existing->getSpecialistId() !== null && $existing->getSpecialistId() !== $s->getId()) {
                    throw new ValidationException(['email' => "This email already belongs to another doctor's login"]);
                }
                if (!in_array('doctor', $existing->getRoles(), true)) {
                    throw new ValidationException(['email' => 'This email belongs to a staff account that is not a doctor login. Use a different email.']);
                }
                if ($existing->hasPassword()) {
                    throw new ValidationException(['email' => 'A doctor login with this email already exists. Link it to this specialist from Staff.']);
                }
                $user = $existing;
            } else {
                [$first, $last] = self::nameParts($s->getName());
                $user = new User($email, $first, $last);
                $user->setRoles(['doctor']);
                $user->setPermissions(['appointments.view']);
            }
            $user->setSpecialistId($s->getId());
        }
        if (!$user->isActive()) {
            throw new ValidationException(['email' => "This doctor's login is deactivated. Reactivate it in Staff first."]);
        }

        $result = $this->passwords->sendInvite($user, $s->getName(), WebUrls::forSpecialist($s));

        return $result + ['login' => $this->loginArray($user)];
    }

    /** The doctor submits a complete checklist for review; admins are notified. */
    public function submit(Specialist $s): void
    {
        $status = $s->getStatus();
        if ($status === SpecialistStatus::APPROVED) {
            throw new ValidationException(['status' => 'Your profile is already approved']);
        }
        if ($status === SpecialistStatus::PENDING_REVIEW) {
            throw new ValidationException(['status' => 'Your profile is already waiting for review']);
        }
        if ($status === SpecialistStatus::SUSPENDED) {
            throw new ValidationException(['status' => 'Your account is suspended. Please contact support.']);
        }

        $missing = array_keys(array_filter($this->checklist($s), static fn (bool $done): bool => !$done));
        if ($missing !== []) {
            $labels = array_map(static fn (string $k): string => self::MISSING_LABELS[$k] ?? $k, $missing);
            throw new ValidationException(['checklist' => 'Before submitting, add ' . self::humanList($labels) . '.']);
        }

        $s->submitForReview();
        $this->specialists->save($s);

        $this->notifier->notifyPermission(
            'specialists.manage',
            'onboarding',
            'Doctor ready for review',
            $s->getName() . ' submitted their profile for review.',
            '/specialists',
        );

        // The back office has no notification bell, so the reviewers are also
        // emailed — after the doctor's reply has gone, so N sends don't slow it.
        $name = $s->getName();
        AfterResponse::defer(fn () => $this->emailReviewers($name));
    }

    /**
     * Email everyone who can approve doctors (`specialists.manage`, super admins
     * included) that a profile is waiting. Only the doctor's name — no profile or
     * medical content. Best-effort, one failure never stops the rest.
     *
     * @return int how many emails were accepted
     */
    public function emailReviewers(string $doctorName): int
    {
        $tpl  = EmailTemplates::doctorReadyForReview($doctorName, $this->backofficeUrl);
        $sent = 0;
        try {
            $reviewers = $this->users->withPermission('specialists.manage');
        } catch (\Throwable) {
            return 0;
        }
        foreach ($reviewers as $reviewer) {
            try {
                if ($this->mail->send($reviewer->getEmail(), $reviewer->getFirstName(), $tpl['subject'], $tpl['html'])) {
                    $sent++;
                }
            } catch (\Throwable) {
                // non-fatal — the in-app notification and the Needs review count remain.
            }
        }

        return $sent;
    }

    /** An admin approves: the doctor becomes listed and bookable. Emails them. */
    public function approve(Specialist $s, string $actorId): void
    {
        $status = $s->getStatus();
        if ($status === SpecialistStatus::APPROVED) {
            throw new ValidationException(['status' => 'This doctor is already approved']);
        }
        if ($status !== SpecialistStatus::PENDING_REVIEW && $status !== SpecialistStatus::SUSPENDED) {
            throw new ValidationException(['status' => "This doctor hasn't submitted their profile for review yet"]);
        }

        $s->approve($actorId !== '' ? $actorId : null);
        $this->specialists->save($s);

        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Profile approved', 'Patients can now find and book you.', '/dashboard');
        $tpl = EmailTemplates::doctorApproved($s->getName(), WebUrls::forSpecialist($s));
        $this->emailDoctor($s, $tpl);
    }

    /** An admin sends a submitted profile back with a reason. Emails the doctor. */
    public function reject(Specialist $s, string $reason): void
    {
        $reason = trim($reason);
        if ($reason === '') {
            throw new ValidationException(['reason' => 'Tell the doctor what to change']);
        }
        if (mb_strlen($reason) > 2000) {
            throw new ValidationException(['reason' => 'Keep the reason under 2000 characters']);
        }
        if ($s->getStatus() !== SpecialistStatus::PENDING_REVIEW) {
            throw new ValidationException(['status' => 'Only a profile waiting for review can be sent back']);
        }

        $s->reject($reason);
        $this->specialists->save($s);

        $this->notifier->notifyDoctor($s->getId(), 'onboarding', 'Profile needs changes', $reason, '/onboarding');
        $tpl = EmailTemplates::doctorRejected($s->getName(), $reason, WebUrls::forSpecialist($s));
        $this->emailDoctor($s, $tpl);
    }

    /**
     * The login state the back office shows next to a specialist.
     *
     * @return array<string,mixed>|null
     */
    public function loginArray(?User $user): ?array
    {
        if ($user === null) {
            return null;
        }
        $u = $user->toArray();

        return [
            'id'                => $u['id'],
            'email'             => $u['email'],
            'active'            => $u['active'],
            'password_set'      => $u['password_set'],
            'invite_pending'    => $u['invite_pending'],
            'invite_expires_at' => $u['invite_expires_at'],
        ];
    }

    /** Strip an honorific and split "Dr. Grace Bell" into [first, last]. */
    public static function nameParts(string $name): array
    {
        $clean = trim(preg_replace('/^(dr|prof|mr|mrs|ms)\.?\s+/i', '', trim($name)) ?? $name);
        $parts = preg_split('/\s+/', $clean) ?: [$clean];
        $first = $parts[0] !== '' ? $parts[0] : 'Doctor';

        return [$first, count($parts) > 1 ? implode(' ', array_slice($parts, 1)) : 'Doctor'];
    }

    /** @param list<string> $items */
    private static function humanList(array $items): string
    {
        if (count($items) <= 1) {
            return $items[0] ?? '';
        }
        $last = array_pop($items);

        return implode(', ', $items) . ' and ' . $last;
    }

    /** @param array{subject:string, html:string} $tpl */
    private function emailDoctor(Specialist $s, array $tpl): void
    {
        try {
            $login = $this->users->findBySpecialist($s->getId());
            $email = $login?->getEmail() ?? $s->getEmail();
            if ($email !== null && $email !== '') {
                $this->mail->send($email, $s->getName(), $tpl['subject'], $tpl['html']);
            }
        } catch (\Throwable) {
            // non-fatal — the review decision already succeeded.
        }
    }
}
