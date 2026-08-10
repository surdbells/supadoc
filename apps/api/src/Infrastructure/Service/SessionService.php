<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Session;
use App\Domain\Repository\SessionRepository;

/**
 * Server-side session registry that makes JWTs revocable: each customer login
 * records a Session keyed by the token's `jti`, the middleware rejects tokens
 * whose session was revoked, and the portal exposes list/revoke.
 */
final class SessionService
{
    public function __construct(private readonly SessionRepository $sessions)
    {
    }

    /** Record a new session for a just-signed-in patient; returns the jti. */
    public function start(Patient $patient, ?string $userAgent, ?string $ip): string
    {
        $jti = bin2hex(random_bytes(16));
        $this->sessions->save(new Session($jti, $patient, $userAgent, $ip));

        return $jti;
    }

    public function isActive(string $id): bool
    {
        return $id !== '' && $this->sessions->findActive($id) !== null;
    }

    /** @return list<Session> */
    public function listForPatient(string $patientId): array
    {
        return $this->sessions->listForPatient($patientId);
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
}
