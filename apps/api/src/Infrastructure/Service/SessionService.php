<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Session;
use App\Domain\Entity\StaffSession;
use App\Domain\Entity\User;
use App\Domain\Enum\SessionState;
use App\Domain\Repository\SessionRepository;
use App\Domain\Repository\StaffSessionRepository;
use DateTimeImmutable;

/**
 * Server-side session registry that makes JWTs revocable and time-boxed: each
 * login (patient or staff) records a session keyed by the token's `jti`; the
 * auth middleware and the refresh endpoint reject tokens whose session was
 * signed out, has been idle longer than `$idleTimeout`, or is older than
 * `$absoluteTimeout`. Authenticated requests refresh the activity timestamp
 * (throttled), so the idle clock only runs while nothing talks to the API.
 */
final class SessionService
{
    public function __construct(
        private readonly SessionRepository $sessions,
        private readonly StaffSessionRepository $staffSessions,
        private readonly int $idleTimeout = 3600,
        private readonly int $absoluteTimeout = 43200,
    ) {
    }

    /** Record a new session for a just-signed-in patient; returns the jti. */
    public function start(Patient $patient, ?string $userAgent, ?string $ip): string
    {
        $jti = bin2hex(random_bytes(16));
        $this->sessions->save(new Session($jti, $patient, $userAgent, $ip));

        return $jti;
    }

    /** Record a new session for a just-signed-in staff user; returns the jti. */
    public function startStaff(User $user, ?string $userAgent, ?string $ip): string
    {
        $jti = bin2hex(random_bytes(16));
        $this->staffSessions->save(new StaffSession($jti, $user, $userAgent, $ip));

        return $jti;
    }

    /** Whether a patient session is usable (not revoked, not idle/expired). */
    public function isActive(string $id): bool
    {
        return $this->customerState($id) === SessionState::ACTIVE;
    }

    /**
     * The state of a patient session. With `$touch`, a usable session also has
     * its activity recorded (the caller is serving an authenticated request).
     */
    public function customerState(string $id, bool $touch = false): SessionState
    {
        if ($id === '') {
            return SessionState::UNKNOWN;
        }
        $session = $this->sessions->find($id);
        if (!$session instanceof Session) {
            return SessionState::UNKNOWN;
        }

        return $this->evaluate($session, $touch, fn () => $this->sessions->save($session));
    }

    /** The state of a staff session; see {@see customerState()}. */
    public function staffState(string $id, bool $touch = false): SessionState
    {
        if ($id === '') {
            return SessionState::UNKNOWN;
        }
        $session = $this->staffSessions->find($id);
        if (!$session instanceof StaffSession) {
            return SessionState::UNKNOWN;
        }

        return $this->evaluate($session, $touch, fn () => $this->staffSessions->save($session));
    }

    /** Sign out a session by its jti, whichever audience it belongs to. */
    public function revokeById(string $id): void
    {
        if ($id === '') {
            return;
        }
        $session = $this->sessions->find($id);
        if ($session instanceof Session) {
            $session->revoke();
            $this->sessions->save($session);

            return;
        }
        $staff = $this->staffSessions->find($id);
        if ($staff instanceof StaffSession) {
            $staff->revoke();
            $this->staffSessions->save($staff);
        }
    }

    /**
     * A patient's live sessions (not revoked, not run out), newest first.
     *
     * @return list<Session>
     */
    public function listForPatient(string $patientId): array
    {
        $now = new DateTimeImmutable();

        return array_values(array_filter(
            $this->sessions->listForPatient($patientId),
            fn (Session $s): bool => !$s->isExpired($now, $this->idleTimeout, $this->absoluteTimeout),
        ));
    }

    /** Revoke one of the patient's sessions; false if it isn't theirs / unknown. */
    public function revoke(string $id, string $patientId): bool
    {
        $session = $this->sessions->findForPatient($id, $patientId);
        if ($session === null) {
            return false;
        }
        $session->revoke();
        $this->sessions->save($session);

        return true;
    }

    public function idleTimeout(): int
    {
        return $this->idleTimeout;
    }

    /** @param callable():void $persist */
    private function evaluate(Session|StaffSession $session, bool $touch, callable $persist): SessionState
    {
        if ($session->isRevoked()) {
            return SessionState::REVOKED;
        }
        $now = new DateTimeImmutable();
        // Expiry is monotonic (activity is only recorded on a live session), so
        // an expired session stays expired without needing to be revoked.
        if ($session->isExpired($now, $this->idleTimeout, $this->absoluteTimeout)) {
            return SessionState::EXPIRED;
        }
        if ($touch && $session->markActive($now)) {
            $persist();
        }

        return SessionState::ACTIVE;
    }
}
