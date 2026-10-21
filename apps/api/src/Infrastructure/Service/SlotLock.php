<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Infrastructure\Persistence\RawIndexes;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Taking a doctor's time slot is check-then-insert, so every path that puts an
 * appointment on a time (booking, follow-up proposal / acceptance, either
 * side's reschedule, a staff booking) does it in one transaction that first
 * takes this doctor's transaction-scoped advisory lock ({@see lockDoctor()}),
 * then re-runs the availability check, then writes. Two of them for the same
 * doctor run one after the other, so the second sees the first's appointment.
 *
 * Backstop: a partial unique index on (specialist_id, scheduled_at) over live
 * bookings ({@see RawIndexes::SLOT}). A write that still collides with it is
 * recognised by {@see isSlotTaken()} and answered "That time was just taken".
 */
final class SlotLock
{
    /** The first key of the two-key advisory lock: "slots" (the second is the doctor). */
    public const NAMESPACE = 0x5107;

    public const TAKEN = 'That time was just taken — please pick another slot';

    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    /**
     * Hold doctor `$specialistId`'s slot lock until the current transaction
     * ends (call inside one — outside a transaction it would end at once).
     */
    public function lockDoctor(string $specialistId): void
    {
        $conn = $this->em->getConnection();
        if (!$conn->isTransactionActive()) {
            throw new \LogicException('SlotLock::lockDoctor() must run inside a transaction');
        }
        $conn->executeQuery('SELECT pg_advisory_xact_lock(' . self::NAMESPACE . ', hashtext(?))', [strtolower($specialistId)]);
    }

    /** Whether `$e` (or what caused it) is the live-slot unique index refusing a second booking of one time. */
    public static function isSlotTaken(\Throwable $e): bool
    {
        for ($cause = $e; $cause !== null; $cause = $cause->getPrevious()) {
            if ($cause instanceof UniqueConstraintViolationException && str_contains($cause->getMessage(), RawIndexes::SLOT)) {
                return true;
            }
        }

        return false;
    }
}
