<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Repository\AppointmentRepository;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Service\ApiResponse;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments/{id}/call-token — an Agora RTC token for the
 * consultation. The channel is the appointment id, so patient, specialist and
 * guests join the same room; the patient joins as uid 1, and `participants`
 * names everyone who may be in the call by uid (names only) so each tile can
 * be labelled. Scoped to the signed-in patient (a foreign id → 404).
 * Refused: an unaccepted follow-up (422 errors.status `proposed`); a cancelled
 * (410 errors.code `cancelled`), completed or missed (410 `ended`) one.
 */
final class GetCallTokenAction
{
    use ApiResponse;

    private const TTL = 3600;

    public function __construct(
        private readonly AppointmentRepository $repo,
        private readonly AgoraTokenService $agora,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $customerId  = (string) $request->getAttribute('customer_id');
        $id          = (string) $args['id'];
        $appointment = $this->repo->findForPatient($id, $customerId);

        if ($appointment === null) {
            throw EntityNotFoundException::for(Appointment::class, $id);
        }
        // A follow-up proposal isn't a booking until the patient accepts it.
        if ($appointment->getStatus() === AppointmentStatus::PROPOSED) {
            $notYet = "Accept this follow-up first — there is no call to join until you do.";

            return $this->error($response, $notYet, 422, ['status' => 'proposed']);
        }
        // A cancelled, completed or missed consultation has no call (410
        // cancelled / ended, as joining refuses it — CallAccess::problem()).
        if (($problem = CallAccess::problem($appointment, ['role' => 'patient'], null, new DateTimeImmutable())) !== null) {
            return $this->error($response, $problem[1], $problem[0], $problem[2]);
        }
        if (!$this->agora->hasAppId()) {
            return $this->error($response, 'Video calling is not configured', 503);
        }

        // The patient joins as uid 1 — the uid every party's `participants`
        // labels as the patient (guests get their own, the doctor 2).
        $uid          = Appointment::PATIENT_UID;
        $participants = CallAccess::participants($appointment);

        // TEMPORARY (never in production — see AgoraTokenService): a fixed Console
        // token overrides minting (its bound channel wins, so everyone shares one
        // room) while the certificate desync is unresolved. It is a wildcard token.
        if ($this->agora->hasStaticToken()) {
            return $this->success($response, [
                'app_id'       => $this->agora->appId(),
                'channel'      => $this->agora->staticChannel(),
                'uid'          => $uid,
                'token'        => $this->agora->staticToken(),
                'expires_in'   => null,
                'participants' => $participants,
            ], 'Call token issued')
                ->withHeader('Cache-Control', 'no-store');
        }

        $channel = $appointment->getId();
        // App-ID-only mode (certificate blank) → null token; client joins token-less.
        $token = $this->agora->isConfigured()
            ? $this->agora->rtcToken($channel, $uid, self::TTL)
            : null;

        return $this->success($response, [
            'app_id'       => $this->agora->appId(),
            'channel'      => $channel,
            'uid'          => $uid,
            'token'        => $token,
            'expires_in'   => $token !== null ? self::TTL : null,
            'participants' => $participants,
        ], 'Call token issued')
            // Never let the browser reuse a cached (possibly expired) token.
            ->withHeader('Cache-Control', 'no-store');
    }
}
