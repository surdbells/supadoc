<?php

declare(strict_types=1);

namespace App\Infrastructure\Vitals;

use App\Domain\Entity\Patient;
use App\Domain\Entity\VitalReading;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\VitalReadingRepository;
use DateTimeImmutable;
use DateTimeZone;

/**
 * A patient's health readings. Every write goes through {@see record()}: one
 * `vital_readings` history row per value, then the newest-per-type cache on the
 * patient (`latest_vitals`) that the doctor's side panel, the call screens and
 * the patient's own Medical Information read.
 *
 * Patients add readings of their own (self-reported, or from their own device);
 * they never edit or remove what a doctor recorded — history is append-only.
 */
final class VitalsService
{
    /** Older than this a reading "may be out of date" — the doctor's side panel uses the same rule. */
    public const STALE_AFTER_DAYS = 7;

    /**
     * A consultation starting within this many hours, with no reading taken in
     * the same span before it, is a reason to remind the patient ("update your
     * vitals 24–48 hours before every consultation").
     */
    public const UPCOMING_WITHIN_HOURS = 48;

    public const HISTORY_LIMIT = 50;
    public const HISTORY_MAX   = 200;

    public function __construct(
        private readonly VitalReadingRepository $readings,
        private readonly PatientRepository $patients,
    ) {
    }

    /**
     * Write one set of readings, all taken at the same time.
     *
     * @param array<string,string> $values validated reading key => value (see VitalsForm::normalize())
     * @return int how many readings were written
     */
    public function record(
        Patient $patient,
        array $values,
        DateTimeImmutable $takenAt,
        string $source,
        string $recordedByType,
        ?string $recordedById,
        ?string $appointmentId = null,
        ?string $prescriptionId = null,
    ): int {
        // Stored without an offset and read back in the server's zone — convert first.
        $takenAt = $takenAt->setTimezone(new DateTimeZone(date_default_timezone_get()));
        $entries = [];
        foreach (VitalsForm::READINGS as $key => [, $unit]) {
            $value = trim((string) ($values[$key] ?? ''));
            if ($value === '') {
                continue;
            }
            $this->readings->persist(new VitalReading(
                $patient->getId(),
                $key,
                $value,
                $unit,
                $takenAt,
                $source,
                $recordedByType,
                $recordedById,
                $appointmentId,
                $prescriptionId,
            ));
            $entries[$key] = [
                'value'       => $value,
                'unit'        => $unit,
                'taken_at'    => $takenAt->format(DATE_ATOM),
                'source'      => $source,
                'recorded_by' => $recordedByType,
            ];
        }
        if ($entries === []) {
            return 0;
        }
        $patient->recordVitals($entries);
        $this->patients->save($patient); // one flush: the history rows and the cache together

        return count($entries);
    }

    /**
     * POST /api/portal/me/vitals — the patient's own readings, checked with the
     * same rules as the prescription form. Body: {readings: {key: value},
     * taken_at?, source?}. When only a new weight (or height) is given, BMI is
     * worked out with the last height (or weight) on file.
     *
     * @throws ValidationException
     */
    public function recordByPatient(Patient $patient, array $body, DateTimeImmutable $now): int
    {
        [$values, $takenAt, $source] = self::validatePatientInput($body, $patient->getLatestVitals(), $now);

        return $this->record($patient, $values, $takenAt, $source, VitalsForm::RECORDED_BY_PATIENT, $patient->getId());
    }

    /**
     * GET /api/portal/me/vitals — latest readings, the form catalogue and the reminder.
     *
     * @param list<array{id: string, scheduled_at: DateTimeImmutable}> $upcoming the patient's
     *        consultations starting soon ({@see UpcomingConsultations})
     */
    public function overview(Patient $patient, DateTimeImmutable $now, array $upcoming = []): array
    {
        $cache = $patient->getLatestVitals();

        return [
            'latest'          => self::latestList($cache, $now),
            'fields'          => VitalsForm::fields(),
            'sources'         => VitalsForm::SOURCES,
            'patient_sources' => array_keys(VitalsForm::PATIENT_SOURCES),
            'reminder'        => self::reminder(self::lastTakenAt($cache), $now, $upcoming),
        ];
    }

    /**
     * GET /api/portal/me/vitals/history — newest first, optionally one type.
     *
     * @throws ValidationException
     * @return list<array<string,mixed>>
     */
    public function history(Patient $patient, mixed $key, mixed $limit, DateTimeImmutable $now): array
    {
        [$key, $limit] = self::validateHistoryQuery($key, $limit);
        $height        = self::heightOnFile($patient->getLatestVitals());

        return array_map(
            static fn (VitalReading $r): array => self::readingRow($r, $now, $height),
            $this->readings->history($patient->getId(), $key, $limit),
        );
    }

    // ----- pure rules (unit-tested) -----

    /**
     * The history endpoint's `key` and `limit` query values. A list or object
     * (`?key[]=x`) is a 422 like any other bad value — never read as "not given".
     *
     * @return array{0: ?string, 1: int} [reading key or null for every type, limit]
     * @throws ValidationException
     */
    public static function validateHistoryQuery(mixed $key, mixed $limit): array
    {
        $errors    = [];
        $keyText   = $key !== null && is_scalar($key) ? trim((string) $key) : '';
        if (($key !== null && !is_scalar($key)) || ($keyText !== '' && !array_key_exists($keyText, VitalsForm::READINGS))) {
            $errors['key'] = 'Choose one of the readings we record, e.g. blood_pressure';
        }
        $limitText = $limit !== null && is_scalar($limit) ? trim((string) $limit) : '';
        if ($limitText === '' && ($limit === null || is_scalar($limit))) {
            $limitText = (string) self::HISTORY_LIMIT;
        }
        if (!ctype_digit($limitText) || (int) $limitText < 1 || (int) $limitText > self::HISTORY_MAX) {
            $errors['limit'] = sprintf('Limit must be a whole number from 1 to %d', self::HISTORY_MAX);
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }

        return [$keyText !== '' ? $keyText : null, (int) $limitText];
    }

    /**
     * Validate the patient's body. Errors use the request's field names:
     * `readings.<key>`, `readings`, `taken_at`, `source`.
     *
     * @param array<string,array<string,string>> $cache the patient's latest readings (for the BMI height)
     * @return array{0: array<string,string>, 1: DateTimeImmutable, 2: string} [values, taken at, source]
     * @throws ValidationException
     */
    public static function validatePatientInput(array $body, array $cache, DateTimeImmutable $now): array
    {
        $raw = $body['readings'] ?? null;
        if (!is_array($raw) || $raw === []) {
            throw new ValidationException(['readings' => 'Enter at least one reading'], 'Enter at least one reading');
        }

        $errors = [];
        $input  = [];
        foreach ($raw as $key => $value) {
            $key = (string) $key;
            if (!array_key_exists($key, VitalsForm::READINGS)) {
                $errors["readings.$key"] = 'This is not a reading we record';
            } elseif ($value !== null && !is_string($value) && !is_int($value) && !is_float($value)) {
                // A list, an object or true/false is never a reading — say so rather than drop it.
                $errors["readings.$key"] = $key === 'blood_pressure'
                    ? 'Enter blood pressure as systolic/diastolic, e.g. 120/80'
                    : sprintf('Enter a number for %s', strtolower(VitalsForm::READINGS[$key][0]));
            } else {
                $input[$key] = $value;
            }
        }
        // `taken_at` and `source` are text when given; anything else is an error, not "now" / self-reported.
        foreach ([
            'taken_at' => 'Enter when the readings were taken as a date and time',
            'source'   => 'Choose where the readings came from',
        ] as $field => $message) {
            $value = $body[$field] ?? null;
            if ($value !== null && !is_string($value)) {
                $errors[$field] = $message;
                $value          = null;
            }
            $input[$field] = $value ?? '';
        }
        // A little slack for a phone whose clock runs a few minutes fast.
        [$clean, $formErrors] = VitalsForm::normalize($input, $now->modify('+5 minutes'), VitalsForm::PATIENT_SOURCES);
        foreach ($formErrors as $key => $message) {
            $errors[in_array($key, ['source', 'taken_at'], true) ? $key : "readings.$key"] = $message;
        }

        $takenAt = isset($clean['taken_at']) ? new DateTimeImmutable($clean['taken_at']) : $now;
        if (!isset($errors['taken_at']) && $takenAt < $now->modify('-1 year')) {
            $errors['taken_at'] = 'Enter a time within the last year';
        }
        $source = $clean['source'] ?? 'self_reported';
        unset($clean['source'], $clean['taken_at']);

        // A new weight or a new height on its own: work BMI out with the other one
        // already on file, so the BMI on file keeps describing the latest of both.
        if (!isset($clean['bmi']) && isset($clean['weight']) !== isset($clean['height'])) {
            $weight = $clean['weight'] ?? ($cache['weight']['value'] ?? null);
            $height = $clean['height'] ?? ($cache['height']['value'] ?? null);
            $bmi    = is_numeric($weight) && is_numeric($height) ? VitalsForm::bmi((float) $weight, (float) $height) : null;
            if ($bmi !== null) {
                $clean['bmi'] = $bmi;
            }
        }

        if ($errors === [] && $clean === []) {
            $errors['readings'] = 'Enter at least one reading';
        }
        if ($errors !== []) {
            throw new ValidationException($errors, 'Check your readings');
        }

        return [$clean, $takenAt, $source];
    }

    /**
     * The latest-per-type cache as a display list, in catalogue order. Each
     * reading carries its `flag` ({@see VitalsFlags}). Weight and BMI always
     * tell the same story: weight is judged by the BMI it gives with the latest
     * height, and the BMI is flagged only while there is a height on file and
     * it is no older than the latest weight and height — one left behind (a
     * doctor's new weight without a height, say) has no flag rather than one
     * that contradicts the weight's.
     *
     * @param array<string,array<string,string>> $cache Patient::getLatestVitals()
     * @return list<array<string,mixed>>
     */
    public static function latestList(array $cache, DateTimeImmutable $now): array
    {
        $staleBefore = $now->modify('-' . self::STALE_AFTER_DAYS . ' days')->getTimestamp();
        $height      = self::heightOnFile($cache);
        $judgeBmi    = $height !== null && self::bmiIsCurrent($cache);
        $list        = [];
        foreach (VitalsForm::READINGS as $key => [$label, $unit]) {
            $v = $cache[$key] ?? null;
            if (!is_array($v) || (string) ($v['value'] ?? '') === '') {
                continue;
            }
            $at     = strtotime((string) ($v['taken_at'] ?? '')) ?: null;
            $source = (string) ($v['source'] ?? '');
            $list[] = [
                'key'          => $key,
                'label'        => $label,
                'value'        => (string) $v['value'],
                'unit'         => $unit,
                'taken_at'     => $at !== null ? date(DATE_ATOM, $at) : null,
                'source'       => $source !== '' ? $source : null,
                'source_label' => VitalsForm::SOURCES[$source] ?? null,
                'recorded_by'  => self::recordedBy($v),
                'stale'        => $at === null || $at < $staleBefore,
                'flag'         => $key === 'bmi' && !$judgeBmi ? null : VitalsFlags::flag($key, (string) $v['value'], $height),
            ];
        }

        return $list;
    }

    /**
     * Whether the BMI on file is at least as new as the latest weight and
     * height, i.e. it still describes them.
     *
     * @param array<string,array<string,string>> $cache
     */
    private static function bmiIsCurrent(array $cache): bool
    {
        $takenAt = static fn (string $key): ?int => is_array($cache[$key] ?? null)
            ? (strtotime((string) ($cache[$key]['taken_at'] ?? '')) ?: null)
            : null;
        $bmiAt = $takenAt('bmi');
        if ($bmiAt === null) {
            return false;
        }
        foreach (['weight', 'height'] as $key) {
            $at = $takenAt($key);
            if ($at !== null && $at > $bmiAt) {
                return false;
            }
        }

        return true;
    }

    /**
     * Whether to nudge the patient to add readings, most pressing reason first:
     * `never` — none on file yet; `upcoming` — a consultation starts within
     * {@see UPCOMING_WITHIN_HOURS} and nothing was taken in that span before it
     * (`appointment` says which); `stale` — the newest is older than
     * {@see STALE_AFTER_DAYS}.
     *
     * @param list<array{id: string, scheduled_at: DateTimeImmutable}> $upcoming the patient's
     *        consultations starting soon, any order (ones outside the window are ignored)
     * @return array{due: bool, reason: ?string, last_taken_at: ?string, days_old: ?int, stale_after_days: int, appointment: ?array{id: string, scheduled_at: string}}
     */
    public static function reminder(?DateTimeImmutable $lastTakenAt, DateTimeImmutable $now, array $upcoming = []): array
    {
        $base = ['stale_after_days' => self::STALE_AFTER_DAYS, 'appointment' => null];
        if ($lastTakenAt === null) {
            return ['due' => true, 'reason' => 'never', 'last_taken_at' => null, 'days_old' => null] + $base;
        }
        $daysOld = $lastTakenAt > $now ? 0 : (int) $lastTakenAt->diff($now)->days;
        $stale   = $lastTakenAt < $now->modify('-' . self::STALE_AFTER_DAYS . ' days');
        $soon    = self::consultationNeedingVitals($lastTakenAt, $now, $upcoming);

        return [
            'due'           => $soon !== null || $stale,
            'reason'        => $soon !== null ? 'upcoming' : ($stale ? 'stale' : null),
            'last_taken_at' => $lastTakenAt->format(DATE_ATOM),
            'days_old'      => $daysOld,
            'appointment'   => $soon !== null
                ? ['id' => $soon['id'], 'scheduled_at' => $soon['scheduled_at']->format(DATE_ATOM)]
                : null,
        ] + $base;
    }

    /**
     * The soonest consultation starting in [now, now + 48h] that has no reading
     * taken in the 48 hours before it, if any.
     *
     * @param list<array{id: string, scheduled_at: DateTimeImmutable}> $upcoming
     * @return ?array{id: string, scheduled_at: DateTimeImmutable}
     */
    private static function consultationNeedingVitals(DateTimeImmutable $lastTakenAt, DateTimeImmutable $now, array $upcoming): ?array
    {
        $window = sprintf('%d hours', self::UPCOMING_WITHIN_HOURS);
        usort($upcoming, static fn (array $a, array $b): int => $a['scheduled_at'] <=> $b['scheduled_at']);
        foreach ($upcoming as $appointment) {
            $at = $appointment['scheduled_at'];
            if ($at < $now || $at > $now->modify('+' . $window)) {
                continue;
            }
            if ($lastTakenAt < $at->modify('-' . $window)) {
                return $appointment;
            }
        }

        return null;
    }

    /**
     * When the newest reading of any type was taken.
     *
     * @param array<string,array<string,string>> $cache
     */
    public static function lastTakenAt(array $cache): ?DateTimeImmutable
    {
        $newest = null;
        foreach ($cache as $key => $v) {
            if (!array_key_exists((string) $key, VitalsForm::READINGS) || !is_array($v)) {
                continue;
            }
            $at = strtotime((string) ($v['taken_at'] ?? ''));
            if ($at !== false && ($newest === null || $at > $newest)) {
                $newest = $at;
            }
        }

        return $newest !== null ? (new DateTimeImmutable())->setTimestamp($newest) : null;
    }

    /** `patient` or `doctor`; cache entries from before the history existed came from prescriptions. */
    private static function recordedBy(array $entry): string
    {
        $by = (string) ($entry['recorded_by'] ?? '');
        if (in_array($by, [VitalsForm::RECORDED_BY_PATIENT, VitalsForm::RECORDED_BY_DOCTOR], true)) {
            return $by;
        }

        return ($entry['source'] ?? '') === 'self_reported' ? VitalsForm::RECORDED_BY_PATIENT : VitalsForm::RECORDED_BY_DOCTOR;
    }

    /** The latest height on file (cm), for judging a weight by its BMI. */
    private static function heightOnFile(array $cache): ?string
    {
        $height = $cache['height']['value'] ?? null;

        return is_scalar($height) && is_numeric((string) $height) ? (string) $height : null;
    }

    /**
     * One history row. Weight is judged with the latest height; a BMI only
     * while there is a height on file (as on the latest list).
     *
     * @return array<string,mixed>
     */
    private static function readingRow(VitalReading $r, DateTimeImmutable $now, ?string $height): array
    {
        [$label] = VitalsForm::READINGS[$r->getKey()] ?? [$r->getKey()];

        return [
            'id'           => $r->getId(),
            'key'          => $r->getKey(),
            'label'        => $label,
            'value'        => $r->getValue(),
            'unit'         => $r->getUnit(),
            'taken_at'     => $r->getTakenAt()->format(DATE_ATOM),
            'source'       => $r->getSource(),
            'source_label' => VitalsForm::SOURCES[$r->getSource()] ?? null,
            'recorded_by'  => $r->getRecordedByType(),
            'stale'        => $r->getTakenAt() < $now->modify('-' . self::STALE_AFTER_DAYS . ' days'),
            'flag'         => $r->getKey() === 'bmi' && $height === null ? null : VitalsFlags::flag($r->getKey(), $r->getValue(), $height),
            'created_at'   => $r->getCreatedAt()->format(DATE_ATOM),
        ];
    }
}
