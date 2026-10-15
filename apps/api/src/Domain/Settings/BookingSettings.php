<?php

declare(strict_types=1);

namespace App\Domain\Settings;

use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppSettingRepository;

/**
 * The booking rules the Platform Admin can change without a release.
 *
 * Calendar: how far ahead patients may book (`horizon_days`), the minimum
 * notice before a consultation (`lead_minutes`) and when a day reads as "few
 * left" in the calendar (`few_left` open times or fewer). Staff and doctors
 * are not held to the horizon — only patients are (see AvailabilityService).
 *
 * Past consultations ({@see \App\Infrastructure\Service\PastAppointmentCloser}):
 *  - missed_after_hours: a confirmed consultation with no proof it took place
 *    is marked missed this long after its slot ended (and one with proof,
 *    confirmed or not, completed);
 *  - unconfirmed_expiry_minutes_after_end: a request the doctor never
 *    confirmed is cancelled (fully refunded) this long after its slot ended —
 *    never inside the doctor's confirm grace (effectively at least
 *    AppointmentLifecycle::CONFIRM_GRACE_MINUTES);
 *  - noshow_patient_refund_pct: what a patient who didn't come gets back of
 *    the consultation fee (the doctor keeps the rest);
 *  - noshow_both_refund_pct: the same when neither came (the doctor earns
 *    nothing either way). A doctor who didn't come always refunds 100%, and
 *    guest fees always go back on a missed consultation;
 *  - late_cancel_hours / late_cancel_refund_pct: a confirmed consultation the
 *    patient cancels within late_cancel_hours of its start refunds
 *    late_cancel_refund_pct of the fee, and the patient can no longer move it
 *    (0 hours = off: a full refund until the start). Never a booking the
 *    doctor moved (rescheduled_by doctor);
 *  - doctor_noshow_alert_threshold: staff (specialists.manage) are alerted
 *    when a doctor reaches this many no-shows in 30 days.
 *
 * Persisted in app_settings (keys `booking_*`); each value is clamped to a
 * safe range.
 */
final class BookingSettings
{
    /** key => [default, min, max, label] */
    public const RULES = [
        'horizon_days'                         => [60, 7, 180, 'Booking window (days ahead)'],
        'lead_minutes'                         => [60, 15, 1440, 'Minimum notice (minutes)'],
        'few_left'                             => [3, 1, 10, '"Few left" threshold (open times)'],
        'missed_after_hours'                   => [12, 1, 168, 'Close missed consultations after (hours)'],
        'unconfirmed_expiry_minutes_after_end' => [0, 0, 1440, 'Cancel unconfirmed requests after their end (minutes)'],
        'noshow_patient_refund_pct'            => [0, 0, 100, 'Refund when the patient didn\'t come (%)'],
        'noshow_both_refund_pct'               => [0, 0, 100, 'Refund when neither came (%)'],
        'late_cancel_hours'                    => [0, 0, 168, 'Late cancellation window (hours before the start)'],
        'late_cancel_refund_pct'               => [100, 0, 100, 'Refund for a late cancellation (%)'],
        'doctor_noshow_alert_threshold'        => [2, 1, 20, 'Alert after this many doctor no-shows in 30 days'],
    ];

    /** The window doctor_noshow_alert_threshold counts no-shows over. */
    public const DOCTOR_NOSHOW_WINDOW_DAYS = 30;

    /** @var array<string,int>|null read once per request */
    private ?array $cache = null;

    public function __construct(private readonly ?AppSettingRepository $settings = null)
    {
    }

    /** The default for `$key` (used when nothing is stored, and without a repository). */
    public static function default(string $key): int
    {
        return self::RULES[$key][0];
    }

    public function get(string $key): int
    {
        return $this->all()[$key] ?? self::default($key);
    }

    /** @return array<string,int> every key of RULES */
    public function all(): array
    {
        if ($this->cache !== null) {
            return $this->cache;
        }
        $out = [];
        foreach (self::RULES as $key => [$default, $min, $max]) {
            $raw       = $this->settings?->get('booking_' . $key);
            $out[$key] = $raw !== null && is_numeric($raw) ? max($min, min($max, (int) $raw)) : $default;
        }

        return $this->cache = $out;
    }

    /**
     * Apply a partial update; returns the full set.
     *
     * @return array<string,int>
     * @throws ValidationException
     */
    public function update(array $patch): array
    {
        $errors = [];
        foreach (self::RULES as $key => [, $min, $max, $label]) {
            if (!array_key_exists($key, $patch)) {
                continue;
            }
            $value = $patch[$key];
            if (!is_numeric($value) || (int) $value != $value || (int) $value < $min || (int) $value > $max) {
                $errors[$key] = sprintf('%s must be a whole number from %d to %d', $label, $min, $max);
            }
        }
        if ($errors !== []) {
            throw new ValidationException($errors);
        }
        if ($this->settings === null) {
            return $this->all();
        }
        foreach (array_keys(self::RULES) as $key) {
            if (array_key_exists($key, $patch)) {
                $this->settings->set('booking_' . $key, (string) (int) $patch[$key]);
            }
        }
        $this->cache = null;

        return $this->all();
    }
}
