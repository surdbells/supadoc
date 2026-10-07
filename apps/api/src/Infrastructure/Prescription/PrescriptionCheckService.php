<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Entity\Patient;
use App\Domain\Entity\Prescription;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\PrescriptionCheckThrottleRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Infrastructure\Service\AuditLogger;
use DateTimeImmutable;

/**
 * The public pharmacist check (GVM-RX-02 Part G): prescription number + the
 * patient's date of birth → status, date sent, doctor's name and MDCN number —
 * never the medicines, the reason or any other patient detail. A miss never
 * says which field was wrong. Every check is audited (number, result, time,
 * device).
 *
 * Lock-out (AC34) uses three atomic counters, each charged BEFORE the date of
 * birth is evaluated, so a burst of parallel guesses cannot get past a lock:
 *  - per device (client device id + network): `check_max_attempts` misses in a
 *    row lock it for `check_lock_minutes`; a match clears the run;
 *  - per network (IP, IPv6 bucketed by /64): 4× that, so rotating device ids
 *    from one place doesn't help;
 *  - per prescription number (only for numbers that exist): 2× that, whatever
 *    the device or network — stops date-of-birth guessing from many addresses.
 * Counts decay once no attempt has been made for a lock window.
 */
final class PrescriptionCheckService
{
    public function __construct(
        private readonly PrescriptionRepository $prescriptions,
        private readonly PatientRepository $patients,
        private readonly PrescriptionCheckThrottleRepository $throttles,
        private readonly PrescriptionSettings $settings,
        private readonly AuditLogger $audit,
    ) {
    }

    /**
     * @return array{result: 'match'|'no_match'|'locked', status?: string, number?: string, sent_at?: ?string,
     *               valid_until?: ?string, doctor?: string, mdcn_number?: ?string, attempts_left?: int, retry_at?: string}
     */
    public function check(string $number, string $dateOfBirth, string $deviceId, string $ip): array
    {
        $now         = new DateTimeImmutable();
        $maxFailures = $this->settings->get('check_max_attempts');
        $lockMinutes = $this->settings->get('check_lock_minutes');
        $network     = self::network($ip);

        $number = strtoupper(preg_replace('/\s+/', '', $number) ?? '');
        $rx     = PrescriptionNumberGenerator::isValid($number) ? $this->prescriptions->findByNumber($number) : null;
        if ($rx !== null && $rx->isDraft()) {
            $rx = null; // a draft is not a prescription anyone can present
        }

        $deviceKey = $this->deviceKey($deviceId, $network);
        /** @var array<string,int> $buckets key => max misses */
        $buckets = [
            $deviceKey                               => $maxFailures,
            hash('sha256', 'net|' . $network)        => $maxFailures * 4,
        ];
        if ($rx !== null) {
            $buckets[hash('sha256', 'rx|' . $number)] = $maxFailures * 2;
        }
        $audit = ['number' => mb_substr($number, 0, 40), 'device' => substr($deviceKey, 0, 16), 'ip' => $ip];

        // Charge every bucket first; refuse while any is (or is now) locked.
        $counts = [];
        $lockedUntil = null;
        foreach ($buckets as $key => $max) {
            $state = $this->throttles->charge($key, $lockMinutes, $now);
            $counts[$key] = $state['failures'];
            if ($state['locked_until'] !== null && $state['locked_until'] > $now) {
                $lockedUntil = max($lockedUntil ?? $state['locked_until'], $state['locked_until']);
            } elseif ($state['failures'] > $max) {
                $until = $now->modify("+{$lockMinutes} minutes");
                $this->throttles->lock($key, $until);
                $lockedUntil = max($lockedUntil ?? $until, $until);
            }
        }
        if ($lockedUntil !== null) {
            $this->audit->record('Prescription check', 'public', 'prescription.checked', null, 'prescription', $rx?->getId(), $audit + ['result' => 'locked']);

            return ['result' => 'locked', 'retry_at' => $lockedUntil->format(DATE_ATOM)];
        }

        if ($rx !== null && $this->dobMatches($rx, $dateOfBirth)) {
            // A match is not a miss: clear the device's run, give the rest back.
            $this->throttles->reset($deviceKey);
            foreach (array_keys($buckets) as $key) {
                if ($key !== $deviceKey) {
                    $this->throttles->refund($key);
                }
            }
            $this->audit->record('Prescription check', 'public', 'prescription.checked', $rx->getAppointmentId(), 'prescription', $rx->getId(), $audit + ['result' => 'match']);
            $prescriber = $rx->getPrescriber();

            return [
                'result'      => 'match',
                'number'      => $rx->getNumber(),
                'status'      => $rx->effectiveStatus(),
                'sent_at'     => $rx->getSentAt()?->format(DATE_ATOM),
                'valid_until' => $rx->getValidUntil()?->format('Y-m-d'),
                'doctor'      => (string) ($prescriber['name'] ?? ''),
                'mdcn_number' => ($prescriber['mdcn_number'] ?? '') !== '' ? (string) $prescriber['mdcn_number'] : null,
            ];
        }

        // A miss: lock any bucket that has now reached its limit.
        $this->audit->record('Prescription check', 'public', 'prescription.checked', null, 'prescription', $rx?->getId(), $audit + ['result' => 'no_match']);
        foreach ($buckets as $key => $max) {
            if ($counts[$key] >= $max) {
                $until = $now->modify("+{$lockMinutes} minutes");
                $this->throttles->lock($key, $until);
                $lockedUntil = max($lockedUntil ?? $until, $until);
            }
        }
        if ($lockedUntil !== null) {
            return ['result' => 'locked', 'retry_at' => $lockedUntil->format(DATE_ATOM)];
        }

        return ['result' => 'no_match', 'attempts_left' => max(0, $maxFailures - $counts[$deviceKey])];
    }

    /**
     * The network an IP belongs to for throttling: the address itself for IPv4,
     * the /64 prefix for IPv6 (one subscriber typically owns a whole /64).
     */
    public static function network(string $ip): string
    {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return $ip;
        }
        $packed = inet_pton($ip);
        if ($packed === false) {
            return $ip;
        }

        return bin2hex(substr($packed, 0, 8)) . '::/64';
    }

    private function dobMatches(Prescription $rx, string $dateOfBirth): bool
    {
        $given = DateTimeImmutable::createFromFormat('!Y-m-d', trim($dateOfBirth));
        if ($given === false) {
            return false;
        }
        $stored = (string) ($rx->getPatientSnapshot()['dob_iso'] ?? '');
        if ($stored === '') {
            $patient = $this->patients->find($rx->getPatientId());
            $stored  = $patient instanceof Patient ? (string) $patient->getDateOfBirth()?->format('Y-m-d') : '';
        }

        return $stored !== '' && hash_equals($stored, $given->format('Y-m-d'));
    }

    /** One stable, non-reversible key per device (falls back to the network). */
    private function deviceKey(string $deviceId, string $network): string
    {
        $deviceId = trim($deviceId);

        return preg_match('/^[A-Za-z0-9\-]{8,64}$/', $deviceId) === 1
            ? hash('sha256', 'device|' . $deviceId . '|' . $network)
            : hash('sha256', 'device-net|' . $network);
    }
}
