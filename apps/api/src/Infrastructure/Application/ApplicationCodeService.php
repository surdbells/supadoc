<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Exception\ApplicationProblem;

/**
 * The applicant's one-time codes and counters (spec §2.8, §8): the email
 * confirm code, the status-check code, the draft code's hash, the resume-code
 * failure lockout, the resend cooldown and the self-service mail cap.
 *
 *  - Codes are 6 digits from random_int, stored only as an HMAC
 *    (`hash_hmac(sha256, scope:code, sha256('onb-codes:' . JWT_SECRET))`),
 *    compared with hash_equals, valid 10 minutes, 5 attempts then burned,
 *    single use; a new code resets the attempts; 60 s resend cooldown.
 *  - Attempts are counted atomically BEFORE the comparison (an INCR on
 *    `{code key}:a`, and on the per-email failure counters), so concurrent
 *    guesses can't share one attempt; an attempt that turns out not to be a
 *    wrong guess is given back.
 *  - A confirm code is bound to the address it was sent to (`e`, the email
 *    hash): after the draft's email changes it no longer verifies anything.
 *  - A status-check code that was not sent (no match, a cooldown or a cap
 *    held it back) is a placeholder that never matches (`n`).
 *  - Counters get their TTL only when created, so failures never extend a window.
 *  - Caps are per email hash across all of an applicant's drafts.
 *  - Fail closed: a store failure is 503 `codes_unavailable` — except the
 *    mail cap, which then simply sends nothing (the response is unchanged).
 *
 * Nothing here is logged; codes are returned to the caller only to be sent
 * (and, outside production, echoed as `dev_*` fields).
 */
final class ApplicationCodeService
{
    public const CODE_TTL       = 600;
    public const MAX_ATTEMPTS   = 5;
    public const COOLDOWN       = 60;
    public const ECONF_DAY      = 10;
    public const ECONF_FAIL_DAY = 15;
    public const MAIL_DAY       = 5;
    public const TRACK_TTL      = 900;
    public const TRACK_APP_DAY  = 8;
    public const TRACK_DEST_DAY = 10;
    public const RESUME_FAILS   = 5;
    public const RESUME_WINDOW  = 1800;
    public const DAY            = 86400;

    /** Crockford base32: no I, L, O, U. */
    public const DRAFT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    public const UNAVAILABLE = "We can't send or check codes right now. Please try again in a few minutes.";

    public function __construct(
        private readonly CodeStore $store,
        private readonly string $codeKey,
        private readonly bool $exposeCodes = false,
    ) {
    }

    /** The HMAC key, derived from the app secret. */
    public static function codeKeyFrom(string $jwtSecret): string
    {
        return hash('sha256', 'onb-codes:' . $jwtSecret, true);
    }

    /** Outside production the codes and links come back as `dev_*` fields (never logged). */
    public function exposeCodes(): bool
    {
        return $this->exposeCodes;
    }

    public function hash(string $scopeId, string $code): string
    {
        return hash_hmac('sha256', $scopeId . ':' . $code, $this->codeKey);
    }

    public function matches(string $scopeId, string $code, ?string $hash): bool
    {
        return $hash !== null && $hash !== '' && hash_equals($hash, $this->hash($scopeId, $code));
    }

    public static function newCode(): string
    {
        return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    }

    public static function newDraftCode(): string
    {
        $out = '';
        for ($i = 0; $i < 6; $i++) {
            $out .= self::DRAFT_ALPHABET[random_int(0, 31)];
        }

        return $out;
    }

    /** What a person typed as a draft code: upper-cased, no spaces or hyphens, O → 0, I and L → 1. */
    public static function normaliseDraftCode(string $raw): string
    {
        $s = strtoupper((string) preg_replace('/[\s\-]+/', '', $raw));

        return strtr($s, ['O' => '0', 'I' => '1', 'L' => '1']);
    }

    public static function emailHash(string $email): string
    {
        return hash('sha256', strtolower(trim($email)));
    }

    // ----- Email confirm code (before submit) -----

    /**
     * A new confirm code for draft `$aid`, bound to `$email` — the address it
     * goes to (the old code stops working, attempts reset). 429
     * `resend_cooldown` within 60 s, 429 `rate_limited` past 10 codes a day for
     * this email.
     */
    public function issueEmailConfirm(string $aid, string $email): string
    {
        return $this->guard(function () use ($aid, $email): string {
            if (!$this->store->setNx('onb:econf:cool:' . $aid, '1', self::COOLDOWN)) {
                throw $this->cooldown('onb:econf:cool:' . $aid);
            }
            if ($this->store->count('onb:econf:day:' . self::emailHash($email), self::DAY) > self::ECONF_DAY) {
                throw new ApplicationProblem(429, 'rate_limited', "You've asked for too many codes today. Try again tomorrow.");
            }
            $code = self::newCode();
            $this->writeCode('onb:econf:' . $aid, ['h' => $this->hash($aid, $code), 'e' => self::emailHash($email)]);

            return $code;
        });
    }

    /**
     * Check a confirm code for draft `$aid`, whose address is now `$email`: a
     * code sent to another address is `code_expired`. Every attempt counts
     * against the per-email daily failure cap first (15; over it:
     * `code_locked` for the day); one that wasn't a wrong guess is given back.
     *
     * @throws ApplicationProblem 422 code_invalid (attempts_left) | code_expired | code_locked
     */
    public function verifyEmailConfirm(string $aid, string $email, string $code): void
    {
        $this->guard(function () use ($aid, $email, $code): void {
            $failKey = 'onb:econf:fail:' . self::emailHash($email);
            if ($this->store->count($failKey, self::DAY) > self::ECONF_FAIL_DAY) {
                throw new ApplicationProblem(422, 'code_locked', 'Too many attempts today. Try again tomorrow.');
            }
            $this->checkCode('onb:econf:' . $aid, $aid, $code, $failKey, self::emailHash($email));
        });
    }

    // ----- Resume by code -----

    /**
     * Count a resume-by-code attempt up front (atomic, so parallel guesses
     * can't slip past the limit): 429 `resume_locked` once 5 failed in the
     * 30-minute window. A successful attempt is given back
     * ({@see resumeSucceeded}); a failed one stays counted.
     *
     * @throws ApplicationProblem 429 resume_locked | 503 codes_unavailable
     */
    public function beginResumeAttempt(string $email): void
    {
        $this->guard(function () use ($email): void {
            if ($this->store->count('onb:resume:fail:' . self::emailHash($email), self::RESUME_WINDOW) > self::RESUME_FAILS) {
                throw new ApplicationProblem(429, 'resume_locked', 'Too many attempts. Try again in 30 minutes, or use the link in your email.');
            }
        });
    }

    /** The attempt counted by {@see beginResumeAttempt} was not a failure (best effort). */
    public function resumeSucceeded(string $email): void
    {
        $this->giveBack('onb:resume:fail:' . self::emailHash($email));
    }

    // ----- Resume email cooldown + the self-service mail cap -----

    /** True when no resume email went to this address in the last 60 s (and claims the slot). */
    public function claimResendCooldown(string $email): bool
    {
        return $this->guard(fn (): bool => $this->store->setNx('onb:resend:' . self::emailHash($email), '1', self::COOLDOWN));
    }

    /** Best effort: start the cooldown (POST /drafts just sent one). */
    public function markResendCooldown(string $email): void
    {
        try {
            $this->store->setNx('onb:resend:' . self::emailHash($email), '1', self::COOLDOWN);
        } catch (\Throwable) {
            // no Redis: the cooldown is simply not enforced on this one
        }
    }

    public function resendRetryAfter(string $email): int
    {
        try {
            return max(1, $this->store->ttl('onb:resend:' . self::emailHash($email)));
        } catch (\Throwable) {
            return self::COOLDOWN;
        }
    }

    /**
     * Whether one more self-service email (applicationSaved / applicationCode)
     * may go to this address today (≤ 5, D31). False when the cap can't be
     * checked — nothing is sent then.
     */
    public function claimMailSlot(string $email): bool
    {
        try {
            return $this->store->count('onb:mail:day:' . self::emailHash($email), self::DAY) <= self::MAIL_DAY;
        } catch (\Throwable) {
            return false;
        }
    }

    // ----- Status check (track) -----

    /**
     * Open a status check (15 minutes). `$aid` is null when nothing matched —
     * everything after behaves the same.
     *
     * @param array{email:string, sms:string} $destinations the texts shown on each channel card
     */
    public function startTrack(?string $aid, string $kind, array $destinations): string
    {
        return $this->guard(function () use ($aid, $kind, $destinations): string {
            $tid = rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '=');
            $this->store->setEx('onb:trk:' . $tid, (string) json_encode([
                'aid'        => $aid,
                'kind'       => $kind,
                'email_mask' => $destinations['email'],
                'phone_mask' => $destinations['sms'],
            ]), self::TRACK_TTL);

            return $tid;
        });
    }

    /** @return array{aid:?string, kind:string, email_mask:string, phone_mask:string}|null */
    public function track(string $tid): ?array
    {
        if (preg_match('/^[A-Za-z0-9_-]{16,64}$/', $tid) !== 1) {
            return null;
        }

        return $this->guard(function () use ($tid): ?array {
            $raw  = $this->store->get('onb:trk:' . $tid);
            $data = $raw !== null ? json_decode($raw, true) : null;

            return is_array($data) ? $data : null;
        });
    }

    /**
     * POST /track/request-code, the part that runs before the response — the
     * same work whether or not the check matched an application (spec §3.5):
     * 410 once the check is gone; within the check's 60 s cooldown nothing
     * changes (`fresh` false); otherwise a placeholder that never matches
     * replaces the check's code, so a code verifies only once
     * {@see armTrackCode} has really sent one.
     *
     * @return array{session: array{aid:?string, kind:string, email_mask:string, phone_mask:string}, fresh: bool}
     * @throws ApplicationProblem 410 track_expired | 503 codes_unavailable
     */
    public function openTrackCode(string $tid, string $channel): array
    {
        $session = $this->track($tid);
        if ($session === null) {
            throw self::trackExpired();
        }

        return $this->guard(function () use ($tid, $channel, $session): array {
            if (!$this->store->setNx('onb:trk:cool:' . $tid, '1', self::COOLDOWN)) {
                return ['session' => $session, 'fresh' => false];
            }
            $this->writeCode('onb:trk:code:' . $tid, ['h' => bin2hex(random_bytes(32)), 'ch' => $channel, 'n' => 1]);

            return ['session' => $session, 'fresh' => true];
        });
    }

    /**
     * After the response, for a matched check only: within the per-application
     * cooldown (60 s per channel), the daily caps (8 per application, 10 per
     * destination) and — by email — the self-service mail cap, a real code
     * replaces the placeholder {@see openTrackCode} wrote. Returns that code
     * (the caller sends it; the mail slot is already claimed), or null when
     * nothing may be sent — the placeholder then stays and verifies nothing.
     * Never throws: a store failure sends nothing.
     */
    public function armTrackCode(string $tid, string $aid, string $channel, string $destination): ?string
    {
        try {
            if ($destination === '' || !$this->store->setNx('onb:trk:cool:' . $aid . ':' . $channel, '1', self::COOLDOWN)) {
                return null;
            }
            if ($this->store->count('onb:trk:day:' . $aid, self::DAY) > self::TRACK_APP_DAY) {
                return null;
            }
            if ($this->store->count('onb:trk:day:dest:' . hash('sha256', strtolower($destination)), self::DAY) > self::TRACK_DEST_DAY) {
                return null;
            }
            if ($channel === 'email' && !$this->claimMailSlot($destination)) {
                return null;
            }
            $code = self::newCode();
            // Attempts made against the placeholder in the meantime still count.
            $this->store->setEx('onb:trk:code:' . $tid, (string) json_encode(['h' => $this->hash($tid, $code), 'ch' => $channel]), self::CODE_TTL);

            return $code;
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Check a status code; the code is burned on success. Returns the
     * application id.
     *
     * @throws ApplicationProblem 410 track_expired | 422 code_invalid | code_expired | code_locked
     */
    public function verifyTrackCode(string $tid, string $code): string
    {
        $session = $this->track($tid);
        if ($session === null) {
            throw self::trackExpired();
        }

        return $this->guard(function () use ($tid, $code, $session): string {
            $aid = $session['aid'] ?? null;
            $this->checkCode('onb:trk:code:' . $tid, $tid, $code, neverMatches: !is_string($aid));
            $this->store->del('onb:trk:' . $tid); // one status session per check

            return (string) $aid;
        });
    }

    public static function trackExpired(): ApplicationProblem
    {
        return new ApplicationProblem(410, 'track_expired', 'This check has timed out. Start again.');
    }

    // ----- Helpers -----

    /**
     * Store a fresh code record; its attempt counter starts again.
     *
     * @param array<string,mixed> $record
     */
    private function writeCode(string $key, array $record): void
    {
        $this->store->del($key . ':a');
        $this->store->setEx($key, (string) json_encode($record), self::CODE_TTL);
    }

    /**
     * The shared code check: missing → expired; otherwise the attempt is
     * counted atomically first (`{key}:a`), so N parallel guesses use N
     * attempts; past 5 → locked; right → burned; wrong → one attempt used (the
     * 5th burns it). A placeholder (`n`) or `$neverMatches` (a status check
     * that matched nothing) fails like a wrong code. `$boundEmail`: the code
     * must have been sent to this email hash, else it is expired for it.
     * `$failKey`: a per-email failure counter the caller already counted for
     * this attempt — given back unless a wrong guess was actually compared.
     */
    private function checkCode(string $key, string $scopeId, string $code, ?string $failKey = null, ?string $boundEmail = null, bool $neverMatches = false): void
    {
        $raw    = $this->store->get($key);
        $record = $raw !== null ? json_decode($raw, true) : null;
        if (!is_array($record) || ($boundEmail !== null && !hash_equals($boundEmail, (string) ($record['e'] ?? '')))) {
            $this->giveBack($failKey);

            throw new ApplicationProblem(422, 'code_expired', 'Code expired. Request a new code.');
        }
        $attempt = $this->store->count($key . ':a', self::CODE_TTL);
        if ($attempt > self::MAX_ATTEMPTS) {
            // A guess that lost the race for the last attempt; the counter stays (it is the lock) until a new code.
            $this->store->del($key);
            $this->giveBack($failKey);

            throw new ApplicationProblem(422, 'code_locked', 'Too many attempts. Request a new code.');
        }
        $code = (string) preg_replace('/\s+/', '', $code);
        if (!$neverMatches && empty($record['n']) && preg_match('/^\d{6}$/', $code) === 1 && $this->matches($scopeId, $code, (string) ($record['h'] ?? ''))) {
            $this->store->del($key);
            $this->store->del($key . ':a');
            $this->giveBack($failKey);

            return;
        }

        if ($attempt >= self::MAX_ATTEMPTS) {
            $this->store->del($key);

            throw new ApplicationProblem(422, 'code_locked', 'Too many attempts. Request a new code.');
        }

        throw new ApplicationProblem(422, 'code_invalid', "That code isn't right. Check it and try again.", ['attempts_left' => self::MAX_ATTEMPTS - $attempt]);
    }

    /** Best effort: an attempt counted up front was not a failure after all. */
    private function giveBack(?string $counterKey): void
    {
        if ($counterKey === null) {
            return;
        }
        try {
            $this->store->decrement($counterKey);
        } catch (\Throwable) {
            // the counter just stays one higher until its window ends
        }
    }

    private function cooldown(string $key): ApplicationProblem
    {
        $left = max(1, $this->store->ttl($key));

        return new ApplicationProblem(429, 'resend_cooldown', 'Please wait a minute before asking for another code.', ['retry_after' => $left]);
    }

    /**
     * Run a store operation; an ApplicationProblem passes through, anything
     * else (Redis down) is 503 codes_unavailable.
     *
     * @template T
     * @param callable(): T $work
     * @return T
     */
    private function guard(callable $work): mixed
    {
        try {
            return $work();
        } catch (ApplicationProblem $p) {
            throw $p;
        } catch (\Throwable) {
            throw new ApplicationProblem(503, 'codes_unavailable', self::UNAVAILABLE);
        }
    }
}
