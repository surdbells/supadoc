<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use Doctrine\DBAL\Connection;

/**
 * Issues prescription numbers of the form GVM-RX-YYYYMMDD-NNNNN (e.g.
 * GVM-RX-20261004-00027): the date it was started plus a per-day sequence.
 * The sequence is a single atomic UPSERT on `prescription_counters`, safe under
 * concurrency without application-level locking.
 */
final class PrescriptionNumberGenerator
{
    public const PREFIX = 'GVM-RX-';

    public function __construct(private readonly Connection $db)
    {
    }

    public function next(?DateTimeImmutable $now = null): string
    {
        // The clinic's calendar date (APP_TIMEZONE), not the server's.
        $day = ($now ?? ClinicTime::now())->setTimezone(ClinicTime::zone())->format('Y-m-d');
        $seq = (int) $this->db->fetchOne(
            'INSERT INTO prescription_counters (day, last_value) VALUES (:day, 1)
             ON CONFLICT (day) DO UPDATE SET last_value = prescription_counters.last_value + 1
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
        return preg_match('/^GVM-RX-\d{8}-\d{5}$/', $number) === 1;
    }
}
