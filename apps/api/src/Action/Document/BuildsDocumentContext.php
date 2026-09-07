<?php

declare(strict_types=1);

namespace App\Action\Document;

use App\Domain\Entity\Appointment;

/**
 * Assembles the shared letterhead context (patient + doctor + consultation)
 * that every clinical document is rendered against. Kind-specific fields are
 * merged on top by the calling action.
 */
trait BuildsDocumentContext
{
    /** @return array<string,mixed> */
    private function documentContext(Appointment $appointment): array
    {
        $p          = $appointment->getPatient()->toArray();
        $specialist = $appointment->getSpecialist();

        return [
            'patient_name'     => trim((string) ($p['first_name'] ?? '') . ' ' . (string) ($p['last_name'] ?? '')),
            'patient_gender'   => (string) ($p['gender'] ?? ''),
            'patient_dob'      => (string) ($p['date_of_birth'] ?? ''),
            'doctor_name'      => $specialist->getName(),
            'doctor_specialty' => $specialist->getSpecialty(),
            'consult_date'     => $appointment->getScheduledAt()->format(DATE_ATOM),
        ];
    }
}
