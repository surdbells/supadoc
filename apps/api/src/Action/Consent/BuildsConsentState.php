<?php

declare(strict_types=1);

namespace App\Action\Consent;

use App\Domain\Entity\ConsultationConsent;
use App\Domain\Repository\ConsultationConsentRepository;

/**
 * Normalises stored consent rows into the full set of consent types, defaulting
 * any type that has never been decided to "not granted". Both the patient and
 * doctor consent views return this shape.
 */
trait BuildsConsentState
{
    /** @return array<int, array<string, mixed>> */
    private function consentState(ConsultationConsentRepository $repo, string $appointmentId): array
    {
        $decided = [];
        foreach ($repo->forAppointment($appointmentId) as $consent) {
            $row = $consent->toArray();
            $decided[$row['type']] = $row;
        }

        $state = [];
        foreach (ConsultationConsent::TYPES as $type) {
            $state[] = $decided[$type] ?? [
                'type'       => $type,
                'granted'    => false,
                'by_role'    => null,
                'by_name'    => null,
                'version'    => ConsultationConsent::VERSION,
                'decided_at' => null,
            ];
        }

        return $state;
    }
}
