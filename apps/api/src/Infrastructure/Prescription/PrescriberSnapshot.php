<?php

declare(strict_types=1);

namespace App\Infrastructure\Prescription;

use App\Domain\Entity\Specialist;

/**
 * The prescriber's details as a signed document prints them, frozen at send:
 * prescriptions (GVM-F-RX-01) and lab requests use the same snapshot. Keys:
 * id, name, specialty, qualifications, mdcn_number (the MDCN number — or, for
 * a doctor licensed abroad, their regulator's) and registration_label.
 */
final class PrescriberSnapshot
{
    /** @return array{id:string, name:string, specialty:string, qualifications:string, mdcn_number:string, registration_label:string} */
    public static function of(Specialist $doctor): array
    {
        return [
            'id'             => $doctor->getId(),
            'name'           => $doctor->getName(),
            'specialty'      => $doctor->getSpecialty(),
            'qualifications' => (string) ($doctor->getQualifications() ?? ''),
            // The MDCN number — or, for a doctor licensed abroad, their regulator's (spec §3.7).
            'mdcn_number'        => (string) ($doctor->registrationNumberForRoute() ?? ''),
            'registration_label' => $doctor->registrationLabel(),
        ];
    }
}
