<?php

declare(strict_types=1);

namespace App\Domain\Document;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use DateTimeImmutable;
use DateTimeZone;
use Ramsey\Uuid\Uuid;

/**
 * The pure rules of patient-controlled document sharing (spec §1.2, §3.2):
 * limits, the kill switch, id / date / message normalisation, the `after_*`
 * options of a consultation, display ends and the idempotency hash.
 *
 * Time zone: the database stores naive timestamps in the PROCESS zone
 * (`date_default_timezone_get()`), so every incoming instant is converted to
 * that zone before it is bound or stored ({@see sql()}), output uses
 * DATE_ATOM ({@see iso()}), and SQL comparisons bind PHP's `$now` — never
 * SQL `NOW()`.
 */
final class DocumentSharingRules
{
    /** The review copy the patient saw when sharing; bump when that copy changes. */
    public const CONSENT_VERSION = '2026-10.1';

    public const MAX_DOCTORS            = 5;
    public const MAX_DOCUMENTS          = 200;
    public const MAX_PATCH_DOCUMENTS    = 200;
    public const MAX_EXCLUDE            = 20;
    public const MESSAGE_MAX            = 500;
    public const REQUEST_TTL_DAYS       = 7;
    public const DECLINE_COOLDOWN_HOURS = 72;
    public const PAIR_REQUESTS_30D      = 3;
    public const DOCTOR_REQUESTS_24H    = 30;
    public const RESTORE_MINUTES        = 10;
    public const REPLAY_HOURS           = 24;
    public const EXTEND_WINDOW_HOURS    = 48;
    public const REINSTATE_PAUSE_DAYS   = 30;
    public const RESCHEDULE_CAP_DAYS    = 30;
    public const MIN_LEAD_MINUTES       = 60;
    public const MAX_UNTIL_DAYS         = 366;
    /** `DocumentGrantDto.document_ids` is capped here (`document_count` stays exact). */
    public const GRANT_DOCUMENT_IDS_MAX = 500;
    /** `hidden_document_ids` is capped here. */
    public const HIDDEN_IDS_MAX = 200;
    /** Ended grants listed for this long. */
    public const ENDED_LIST_DAYS = 90;

    /** Where the patient made the decision (`grants.surface`). */
    public const SURFACES = ['documents_page', 'manage_sharing', 'document_access', 'upload', 'booking', 'appointment_details', 'call', 'request'];

    /** Upload surfaces (`share_surface`). */
    public const UPLOAD_SURFACES = ['documents_page', 'appointment_details'];

    /** Every 503 of the kill switch says this (spec §2.10). */
    public const UNAVAILABLE_MESSAGE = 'Document sharing is unavailable right now. Your documents stay private.';

    /** Is document sharing switched on (`DOC_SHARING_ENABLED` = true / 1)? Default off. */
    public static function enabled(): bool
    {
        $raw = $_ENV['DOC_SHARING_ENABLED'] ?? getenv('DOC_SHARING_ENABLED');

        return in_array(strtolower(trim((string) ($raw === false ? '' : $raw))), ['true', '1'], true);
    }

    /** A uuid from the API boundary, trimmed and lower-cased; null when it isn't one. */
    public static function lowerUuid(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $v = strtolower(trim($value));

        return $v !== '' && Uuid::isValid($v) ? $v : null;
    }

    /**
     * A list of uuids from the body: lower-cased, de-duplicated (first wins),
     * at most `$max`. Errors are keyed `field` (not a list / too many) or
     * `field.N` (that entry is not an id).
     *
     * @return array{0: list<string>, 1: array<string,string>}
     */
    public static function uuidList(mixed $raw, string $field, int $max, string $tooMany, string $invalid = 'Invalid id'): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            return [[], []];
        }
        if (!is_array($raw)) {
            return [[], [$field => 'Send a list of ids']];
        }
        $ids    = [];
        $errors = [];
        foreach (array_values($raw) as $i => $value) {
            $id = self::lowerUuid($value);
            if ($id === null) {
                $errors["$field.$i"] = $invalid;
                continue;
            }
            if (!in_array($id, $ids, true)) {
                $ids[] = $id;
            }
        }
        if (count($ids) > $max) {
            return [[], [$field => $tooMany]];
        }

        return [$ids, $errors];
    }

    /**
     * Parse an `until` share's exclusive end. It must carry `Z` or `±hh:mm`
     * (a bare local time is ambiguous), lie at least an hour ahead and at most
     * {@see MAX_UNTIL_DAYS} days ahead; it is returned in the process zone.
     *
     * @return DateTimeImmutable|string the instant, or the error message
     */
    public static function parseUntil(string $raw, DateTimeImmutable $now): DateTimeImmutable|string
    {
        $raw = trim($raw);
        if ($raw === '' || preg_match('/(Z|[+-]\d{2}:?\d{2})$/i', $raw) !== 1) {
            return 'Send the end date with its time zone offset';
        }
        try {
            $at = new DateTimeImmutable($raw);
        } catch (\Throwable) {
            return 'Choose a valid end date';
        }
        $at = $at->setTimezone(self::processZone());
        if ($at < $now->modify('+' . self::MIN_LEAD_MINUTES . ' minutes')) {
            return 'Choose an end at least an hour from now';
        }
        if ($at > $now->modify('+' . self::MAX_UNTIL_DAYS . ' days')) {
            return 'Choose an end within a year';
        }

        return $at;
    }

    /**
     * A doctor's request note, cleaned: trimmed; format and control characters
     * (bidi overrides, zero-width marks, tabs …) removed except newlines; 3+
     * newlines collapsed to 2. Null when nothing is left. Length is checked by
     * the caller ({@see MESSAGE_MAX}, after cleaning).
     */
    public static function sanitizeMessage(?string $raw): ?string
    {
        if ($raw === null) {
            return null;
        }
        $text = str_replace(["\r\n", "\r"], "\n", $raw);
        $text = (string) preg_replace('/[^\P{Cc}\n]|\p{Cf}/u', '', $text);
        $text = (string) preg_replace("/\n{3,}/", "\n\n", $text);
        $text = trim($text);

        return $text !== '' ? $text : null;
    }

    /**
     * The `after_*` options of one consultation for the pair (spec §1.2): each
     * the ISO exclusive end, or null when not offered — the appointment isn't
     * this pair's, is a proposal, cancelled or deleted, or that end is less
     * than an hour away.
     *
     * @return array{after_24h:?string, after_7d:?string, after_30d:?string}
     */
    public static function afterOptions(?Appointment $a, string $patientId, string $specialistId, DateTimeImmutable $now): array
    {
        $none = ['after_24h' => null, 'after_7d' => null, 'after_30d' => null];
        if (
            $a === null
            || strtolower($a->getPatient()->getId()) !== strtolower($patientId)
            || strtolower($a->getSpecialist()->getId()) !== strtolower($specialistId)
            || $a->isDeleted()
            || in_array($a->getStatus(), [AppointmentStatus::PROPOSED, AppointmentStatus::CANCELLED], true)
        ) {
            return $none;
        }
        $end   = AppointmentLifecycle::endsAt($a);
        $floor = $now->modify('+' . self::MIN_LEAD_MINUTES . ' minutes');
        $out   = [];
        foreach ([ShareDuration::AFTER_24H, ShareDuration::AFTER_7D, ShareDuration::AFTER_30D] as $d) {
            $at             = $d->expiryFrom($now, null, $end);
            $out[$d->value] = $at !== null && $at > $floor ? self::iso($at) : null;
        }

        return $out + $none;
    }

    /**
     * The instant apps format for an end: one second before it for `until`
     * shares (the exclusive start of the next day reads as "30 Oct, 11:59 PM"),
     * else the end itself. Null for no end.
     */
    public static function untilLabelAt(?DateTimeImmutable $expiresAt, string $duration): ?DateTimeImmutable
    {
        if ($expiresAt === null) {
            return null;
        }

        return $duration === ShareDuration::UNTIL->value ? $expiresAt->modify('-1 second') : $expiresAt;
    }

    /**
     * sha256 of the canonical JSON of a normalised request: keys sorted at
     * every level, list values sorted, ids lower-cased by the caller.
     *
     * @param array<string,mixed> $canonical
     */
    public static function requestHash(array $canonical): string
    {
        return hash('sha256', (string) json_encode(self::canonical($canonical), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private static function canonical(mixed $value): mixed
    {
        if (!is_array($value)) {
            return is_string($value) ? strtolower($value) : $value;
        }
        if (array_is_list($value)) {
            $items = array_map([self::class, 'canonical'], $value);
            sort($items);

            return $items;
        }
        ksort($value);

        return array_map([self::class, 'canonical'], $value);
    }

    // ----- Time -----

    public static function processZone(): DateTimeZone
    {
        return new DateTimeZone(date_default_timezone_get());
    }

    /** The current instant, to the second, in the process zone (stored timestamps carry no fraction). */
    public static function now(): DateTimeImmutable
    {
        return (new DateTimeImmutable('@' . time()))->setTimezone(self::processZone());
    }

    /** DATE_ATOM, or null. */
    public static function iso(?DateTimeImmutable $at): ?string
    {
        return $at?->setTimezone(self::processZone())->format(DATE_ATOM);
    }

    /** The naive process-zone string a timestamp column holds. */
    public static function sql(DateTimeImmutable $at): string
    {
        return $at->setTimezone(self::processZone())->format('Y-m-d H:i:s');
    }

    /** A naive timestamp read from the database (process zone), or null. */
    public static function fromSql(mixed $raw): ?DateTimeImmutable
    {
        if ($raw instanceof DateTimeImmutable) {
            return $raw;
        }
        if ($raw === null || $raw === '') {
            return null;
        }

        return new DateTimeImmutable((string) $raw, self::processZone());
    }
}
