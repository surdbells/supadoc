<?php

declare(strict_types=1);

namespace App\Domain\Document;

use DateTimeImmutable;

/**
 * Where an `after_*` share ends once its consultation moves (spec §1.2). Pure.
 *
 *  - The patient moved it: the share follows the new time and that becomes
 *    its new base (`original_expires_at` = the new end).
 *  - Anyone else (the doctor, staff, the system): the share follows the new
 *    time but never past its base + {@see DocumentSharingRules::RESCHEDULE_CAP_DAYS}
 *    days, so a doctor moving a consultation can't stretch what the patient
 *    agreed to; moving it earlier simply shortens it. The base is kept.
 */
final class ReschedulePolicy
{
    /**
     * @return array{expires_at: DateTimeImmutable, capped: bool, original_expires_at: ?DateTimeImmutable}
     */
    public static function newEnd(ShareDuration $d, DateTimeImmutable $newAppointmentEnd, ?DateTimeImmutable $originalEnd, string $movedBy): array
    {
        if (!$d->isAnchored()) {
            throw new \InvalidArgumentException('Only `after_*` shares follow a consultation');
        }
        $end = $d->expiryFrom($newAppointmentEnd, null, $newAppointmentEnd);
        \assert($end instanceof DateTimeImmutable);

        if ($movedBy === 'patient') {
            return ['expires_at' => $end, 'capped' => false, 'original_expires_at' => $end];
        }
        if ($originalEnd !== null) {
            $cap = $originalEnd->modify('+' . DocumentSharingRules::RESCHEDULE_CAP_DAYS . ' days');
            if ($end > $cap) {
                return ['expires_at' => $cap, 'capped' => true, 'original_expires_at' => $originalEnd];
            }
        }

        return ['expires_at' => $end, 'capped' => false, 'original_expires_at' => $originalEnd];
    }
}
