<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Infrastructure\Agora\AgoraRecordingService;
use DateTimeImmutable;

/**
 * A guest's acceptance of the call's recording + privacy notice. Recording
 * could happen in a consultation when cloud recording is set up and the
 * patient has agreed to it (or one is running): a guest must then accept the
 * notice before joining, and cloud recording only starts once every guest in
 * the call has. Otherwise the lobby shows the privacy notice only — accepting
 * it is still recorded, so a later recording finds that guest ready.
 */
final class GuestConsent
{
    /** The notice a guest accepts (bump when its wording changes). */
    public const VERSION = '1.0';

    public function __construct(
        private readonly ConsultationConsentRepository $consents,
        private readonly RecordingRepository $recordings,
        private readonly AgoraRecordingService $recorder,
        private readonly CallPresence $presence,
    ) {
    }

    public function recordingActive(Appointment $appointment): bool
    {
        return $this->recordings->activeForAppointment($appointment->getId()) !== null;
    }

    /** Recording could happen in this consultation (set up, and the patient agreed — or one is running). */
    public function recordingPossible(Appointment $appointment): bool
    {
        if (!$this->recorder->isConfigured()) {
            return false;
        }
        $consent = $this->consents->findOne($appointment->getId(), 'recording');

        return ($consent !== null && $consent->isGranted()) || $this->recordingActive($appointment);
    }

    /**
     * What the lobby shows a guest: whether accepting the notice is required
     * to join (recording could happen), whether it covers recording, whether a
     * recording is running, and whether they accepted it already.
     *
     * @param array<string,mixed> $guest
     * @return array{required:bool, recording_possible:bool, recording_active:bool, given:bool, consented_at:?string, version:string}
     */
    public function state(Appointment $appointment, array $guest): array
    {
        // Without cloud recording set up, nothing can be (or is being) recorded.
        $active   = $this->recorder->isConfigured() && $this->recordingActive($appointment);
        $possible = $active || $this->recordingPossible($appointment);
        $at       = $guest['consented_at'] ?? null;

        return [
            'required'           => $possible,
            'recording_possible' => $possible,
            'recording_active'   => $active,
            'given'              => $at !== null,
            'consented_at'       => $at !== null ? (string) $at : null,
            'version'            => self::VERSION,
        ];
    }

    /**
     * The guests who may be in the call right now and how many of them have
     * not accepted the notice — recording waits for those. In the call: a live
     * heartbeat, or an Agora token issued within its lifetime that they
     * haven't left the call since (the moments between joining and the first
     * heartbeat). When Redis can't say who is in the call (`unknown`), every
     * invited guest counts — never record someone who didn't agree.
     *
     * @return array{connected:int, pending:int, pending_ids:list<string>, unknown:bool}
     */
    public function connectedGuests(Appointment $appointment, ?DateTimeImmutable $now = null): array
    {
        $now       = $now ?? new DateTimeImmutable();
        $present   = $this->presence->tryForAppointment($appointment);
        $connected = 0;
        $pending   = [];
        foreach ($appointment->getGuests() as $guest) {
            $gid = (string) ($guest['id'] ?? '');
            if ($gid === '') {
                continue; // no identity yet (bin/prod-migrate.php): their link can't join
            }
            $inCall = $present === null
                || in_array($gid, $present['guests'], true)
                || CallAccess::guestMayBeConnected($guest, $now);
            if (!$inCall) {
                continue;
            }
            $connected++;
            if (($guest['consented_at'] ?? null) === null) {
                $pending[] = $gid;
            }
        }

        return ['connected' => $connected, 'pending' => count($pending), 'pending_ids' => $pending, 'unknown' => $present === null];
    }
}
