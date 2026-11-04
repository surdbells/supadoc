<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Doctor\DoctorStanding;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Domain\Settings\TimeZones;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\DoctorTimeZoneService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PUT /api/doctor/timezone — the signed-in doctor's IANA time zone, which their
 * weekly hours, availability, schedule, emails and reminders use.
 *
 *   - `source: "auto"` (detected by a browser at sign-in) writes only while no
 *     zone was ever set, and only a detectable zone (never UTC, GMT, Etc/*,
 *     Reykjavik…); otherwise it is a no-op answered with the current state —
 *     so a second device can never flip it.
 *   - `source: "manual"` (chosen) always writes a valid zone, and an actual
 *     change is audited. With `shift_slots: true` the doctor's future unbooked
 *     open times and blocks keep their wall clock in the new zone
 *     ({@see DoctorTimeZoneService}) — refused (422) when their standing
 *     forbids availability writes (suspended).
 *
 * Open to every standing (a suspended doctor can still fix their zone).
 *
 * Body: { timezone: IANA, source: "auto"|"manual", shift_slots?: bool }
 * 200: { timezone, timezone_source, changed, shifted: {moved, skipped}|null }
 */
final class SetDoctorTimeZoneAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly DoctorTimeZoneService $zones,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $body   = (array) $request->getParsedBody();
        $source = $body['source'] ?? null;
        if (!in_array($source, ['auto', 'manual'], true)) {
            return $this->error($response, 'Validation failed', 422, ['source' => 'Unknown source']);
        }
        $tz = $body['timezone'] ?? null;
        if (!TimeZones::isValid($tz)) {
            return $this->error($response, 'Validation failed', 422, ['timezone' => 'Choose a time zone from the list']);
        }
        $tz    = trim((string) $tz);
        $shift = filter_var($body['shift_slots'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $now   = new DateTimeImmutable();

        if ($source === 'auto') {
            // A quick no-op answer; the service checks again under the lock.
            if ($specialist->getTimezoneSource() !== null || !TimeZones::isDetectable($tz)) {
                return $this->state($response, $specialist, false, null);
            }
            $result = $this->zones->change($specialist, $tz, 'auto', false, $now);

            return $this->state($response, $specialist, $result['changed'], null);
        }

        // Whether times may move is decided here; whether the zone really
        // changes (and so whether they do move) is decided under the lock.
        $standing = DoctorStanding::problem($specialist);
        $mayMove  = DoctorStanding::allows($standing[0] ?? null, 'POST', '/doctor/availability');
        if ($shift && !$mayMove && TimeZones::zoneOr($tz)->getName() !== $specialist->timeZone()->getName()) {
            return $this->error($response, 'Validation failed', 422, [
                'shift_slots' => "Your account is suspended, so your open times can't be moved. Change the time zone without moving them.",
            ]);
        }
        $result = $this->zones->change($specialist, $tz, 'manual', $shift && $mayMove, $now);

        if ($result['changed']) {
            try {
                $this->audit->record(
                    $specialist->getName(),
                    'doctor',
                    'doctor.timezone_changed',
                    null,
                    'specialist',
                    $specialist->getId(),
                    ['from' => $result['from'], 'to' => $specialist->timeZone()->getName(), 'shifted' => $result['shifted']['moved'] ?? 0],
                    (string) $request->getAttribute('user_id'),
                );
            } catch (\Throwable $e) {
                error_log('[timezone] audit failed: ' . $e::class);
            }
        }

        return $this->state($response, $specialist, $result['changed'], $result['shifted']);
    }

    /** @param array{moved:int, skipped:int}|null $shifted */
    private function state(ResponseInterface $response, Specialist $s, bool $changed, ?array $shifted): ResponseInterface
    {
        return $this->success($response, [
            'timezone'        => $s->timeZone()->getName(),
            'timezone_source' => $s->getTimezoneSource(),
            'changed'         => $changed,
            'shifted'         => $shifted,
        ], 'Time zone saved');
    }
}
