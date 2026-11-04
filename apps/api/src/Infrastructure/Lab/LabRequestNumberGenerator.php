<?php

declare(strict_types=1);

namespace App\Infrastructure\Lab;

use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use Doctrine\DBAL\Connection;

/**
 * Issues lab request numbers GVM-REQ-YYYYMMDD-NNNNN (e.g.
 * GVM-REQ-20261104-00012): the clinic calendar day of the send plus a per-day
 * sequence — a single atomic UPSERT on `lab_request_counters`, safe under
 * concurrency without application locking (mirrors the prescription numbers;
 * `prescription_counters` is never touched).
 */
final class LabRequestNumberGenerator
{
    public const PREFIX = 'GVM-REQ-';

    public function __construct(private readonly Connection $db)
    {
    }

    public function next(?DateTimeImmutable $now = null): string
    {
        // The clinic's calendar date (APP_TIMEZONE), not the server's.
        $day = ($now ?? ClinicTime::now())->setTimezone(ClinicTime::zone())->format('Y-m-d');
        $seq = (int) $this->db->fetchOne(
            'INSERT INTO lab_request_counters (day, last_value) VALUES (:day, 1)
             ON CONFLICT (day) DO UPDATE SET last_value = lab_request_counters.last_value + 1
             RETURNING last_value',
            ['day' => $day],
        );

        return self::format($day, $seq);
    }

    public static function format(string $day, int $sequence): string
    {
        return self::PREFIX . str_replace('-', '', $day) . '-' . str_pad((string) $sequence, 5, '0', STR_PAD_LEFT);
    }

    public static function isValid(string $number): bool
    {
        return preg_match('/^GVM-REQ-\d{8}-\d{5}$/', $number) === 1;
    }
}
