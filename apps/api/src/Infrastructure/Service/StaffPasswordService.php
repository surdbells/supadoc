<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\User;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\WebUrls;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use Predis\Client as RedisClient;
use Psr\Log\LoggerInterface;

/**
 * One-time set-password links for staff logins: the invite a new doctor gets,
 * and "forgot password". The emailed token is random (256 bits) and only its
 * SHA-256 is stored on the user ({@see User::issuePasswordToken()}), so a database
 * leak never yields a working link. Using a link sets the password, burns the
 * link and signs the person in exactly like a password sign-in.
 */
final class StaffPasswordService
{
    /** Same rule as changing a staff password in Settings. */
    public const MIN_PASSWORD = 8;

    public const INVITE_TTL = 7 * 24 * 3600; // 7 days
    public const RESET_TTL  = 3600;          // 1 hour

    /** At most one reset email per address in this window (no inbox flooding). */
    private const RESET_COOLDOWN = 60;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AuthService $auth,
        private readonly MailService $mail,
        private readonly RedisClient $redis,
        private readonly bool $exposeLinks,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /** Null when the password is acceptable, else the message to show. */
    public static function passwordProblem(string $password): ?string
    {
        return strlen($password) < self::MIN_PASSWORD
            ? 'Password must be at least ' . self::MIN_PASSWORD . ' characters'
            : null;
    }

    /**
     * Issue (or re-issue — a resend replaces the old link) an invite link and
     * email it. Saves the user.
     *
     * `$template` (name, link, days) => {subject, html} replaces the doctor
     * invite wording — an approved applicant gets "Welcome aboard".
     *
     * @param (\Closure(string, string, int): array{subject:string, html:string})|null $template
     * @return array{email_sent:bool, expires_at:string, dev_link?:string}
     */
    public function sendInvite(User $user, string $displayName, string $baseUrl, ?\Closure $template = null): array
    {
        $token = $user->issuePasswordToken(User::TOKEN_INVITE, self::INVITE_TTL);
        $this->users->save($user);

        $link = rtrim($baseUrl, '/') . '/auth/set-password?token=' . $token;
        $days = intdiv(self::INVITE_TTL, 86400);
        $mail = $template !== null ? $template($displayName, $link, $days) : EmailTemplates::doctorInvite($displayName, $link, $days);
        $sent = false;
        try {
            $sent = $this->mail->send($user->getEmail(), $displayName, $mail['subject'], $mail['html'], $template !== null ? 'applicationApproved' : 'doctorInvite');
        } catch (\Throwable) {
            // send() never throws by contract; the link stays valid for a resend.
        }

        $out = [
            'email_sent' => $sent,
            'expires_at' => (string) $user->getPasswordTokenExpiresAt()?->format(DATE_ATOM),
        ];
        if ($this->exposeLinks) {
            $out['dev_link'] = $link; // non-production only, so the flow is testable without mail
        }

        return $out;
    }

    /**
     * Invite link → choose a password → signed in.
     *
     * @return array{access_token:string, refresh_token:string, user:array}
     */
    public function acceptInvite(string $token, string $password, string $userAgent = '', string $ip = ''): array
    {
        $user = $this->redeem(
            $token,
            $password,
            User::TOKEN_INVITE,
            'This invite link is invalid, has expired or has already been used. If you have already set your password, use "Forgot password?" on the sign-in page. Otherwise ask your administrator to send a new invite.',
        );

        return $this->auth->issueStaffTokens($user, $userAgent, $ip);
    }

    /**
     * Email a reset link. Always quiet: the caller replies the same way whether
     * or not the address belongs to anyone, so the endpoint can't be used to
     * find out who has an account. Returns nothing — the link only ever goes to
     * the account's own inbox, never back to whoever asked (anyone can call it).
     *
     * The lookup, the token write and the (slow) email all run after the reply
     * has been sent ({@see AfterResponse}), so the reply takes the same time
     * whether or not the account exists.
     */
    public function requestReset(string $email): void
    {
        $email  = strtolower(trim($email));
        // The site they asked from (doctor portal) — read now, while the request is current.
        $origin = WebUrls::requestStaffOrigin();

        AfterResponse::defer(fn () => $this->sendReset($email, $origin));
    }

    private function sendReset(string $email, ?string $origin): void
    {
        $user = $this->users->findByEmail($email);
        if ($user === null || !$user->isActive() || !$this->claimResetSlot($email)) {
            return;
        }

        $token = $user->issuePasswordToken(User::TOKEN_RESET, self::RESET_TTL);
        $this->users->save($user);

        // The site they asked from, else the one they last used.
        $base = $origin ?? WebUrls::forStaff($user);
        $link = rtrim($base, '/') . '/auth/reset-password?token=' . $token;
        $mail = EmailTemplates::staffPasswordReset($user->getFirstName(), $link, intdiv(self::RESET_TTL, 60));
        try {
            $this->mail->send($user->getEmail(), $user->getFirstName(), $mail['subject'], $mail['html']);
        } catch (\Throwable) {
            // non-fatal — the reply is the same either way.
        }

        if ($this->exposeLinks) {
            // Non-production only, so the flow is testable without mail. Server
            // log only — never in the (unauthenticated) reply.
            $this->logger?->info('Staff password reset link (non-production)', ['user_id' => $user->getId(), 'link' => $link]);
        }
    }

    /**
     * Reset link → choose a password → signed in.
     *
     * @return array{access_token:string, refresh_token:string, user:array}
     */
    public function resetPassword(string $token, string $password, string $userAgent = '', string $ip = ''): array
    {
        $user = $this->redeem(
            $token,
            $password,
            User::TOKEN_RESET,
            'This reset link is invalid or has expired. Request a new one from the sign-in page.',
        );

        return $this->auth->issueStaffTokens($user, $userAgent, $ip);
    }

    /** Validate the link + password, set the password and burn the link. */
    private function redeem(string $token, string $password, string $purpose, string $badLink): User
    {
        $token  = trim($token);
        $errors = [];
        if ($token === '') {
            $errors['token'] = $badLink;
        }
        $problem = self::passwordProblem($password);
        if ($problem !== null) {
            $errors['password'] = $problem;
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        $user = $this->users->findByPasswordTokenHash(User::hashPasswordToken($token));
        if ($user === null || !$user->passwordTokenMatches($token, $purpose)) {
            throw new ValidationException(['token' => $badLink]);
        }
        if (!$user->isActive()) {
            throw new ValidationException(['token' => 'This account has been deactivated. Please contact your administrator.']);
        }

        $user->choosePassword($password);
        $this->users->save($user);

        return $user;
    }

    /** True at most once per address per cooldown window. Fails open without Redis. */
    private function claimResetSlot(string $email): bool
    {
        try {
            return $this->redis->set('staff-reset:' . hash('sha256', $email), '1', 'EX', self::RESET_COOLDOWN, 'NX') !== null;
        } catch (\Throwable) {
            return true;
        }
    }
}
