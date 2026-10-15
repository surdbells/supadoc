<?php

declare(strict_types=1);

namespace App\Action\Call;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\JwtService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/call/{token}/consent — a guest accepts the call's recording
 * + privacy notice in the lobby: `{"accepted": true, "display_name"?: "…"}`.
 * Records when (and which notice version) on their guest entry, and the name
 * they chose to show as in the call (1–60 characters). Required before
 * joining while recording could happen; worth sending always, so a recording
 * started later finds the guest ready. Guest links only (422 otherwise); the
 * same refusals as the lobby (410 / 409) — not "too early", so an early guest
 * can get ready.
 */
final class GuestConsentAction
{
    use ApiResponse;

    private const MAX_NAME = 60;

    public function __construct(
        private readonly JwtService $jwt,
        private readonly AppointmentRepository $appointments,
        private readonly GuestInvitations $guests,
        private readonly GuestConsent $consent,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $claims = $this->jwt->verifyCallAccess((string) ($args['token'] ?? ''));
        if ($claims === null) {
            return $this->error($response, 'This join link is invalid or has expired', 401);
        }
        if ($claims['role'] !== 'guest') {
            $only = 'Only invited guests confirm the notice here.';

            return $this->error($response, $only, 422, ['role' => $only]);
        }
        /** @var Appointment|null $appointment */
        $appointment = $this->appointments->find($claims['appointment_id']);
        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $claims['appointment_id']);
        }
        $guest = CallAccess::guestFor($appointment, $claims);
        if (($problem = CallAccess::problem($appointment, $claims, $guest, new DateTimeImmutable(), early: false)) !== null) {
            return $this->error($response, $problem[1], $problem[0], $problem[2]);
        }

        $body = (array) ($request->getParsedBody() ?? []);
        if (($body['accepted'] ?? false) !== true) {
            return $this->error($response, 'Validation failed', 422, ['accepted' => 'Please accept the notice to continue']);
        }
        $displayName = null;
        if (array_key_exists('display_name', $body) && $body['display_name'] !== null) {
            $displayName = trim((string) preg_replace('/[\p{C}\s]+/u', ' ', (string) $body['display_name']));
            if ($displayName === '' || mb_strlen($displayName) > self::MAX_NAME) {
                return $this->error($response, 'Validation failed', 422, ['display_name' => 'Enter a name of 1 to ' . self::MAX_NAME . ' characters']);
            }
        }

        // A guest token past problem() always resolved to a guest entry.
        $updated = $this->guests->recordConsent($appointment, (string) ($guest['id'] ?? ''), $displayName);
        if ($updated === null) {
            return $this->error($response, CallAccess::WITHDRAWN, 410, ['call' => CallAccess::WITHDRAWN, 'code' => 'withdrawn']);
        }

        return $this->success($response, [
            'consent'      => $this->consent->state($appointment, $updated),
            'you'          => ['name' => Appointment::guestDisplayName($updated), 'role' => 'guest', 'uid' => (int) $updated['uid'], 'id' => (string) $updated['id']],
            'participants' => CallAccess::participants($appointment),
        ], 'Thank you — you can join the call')->withHeader('Cache-Control', 'no-store');
    }
}
