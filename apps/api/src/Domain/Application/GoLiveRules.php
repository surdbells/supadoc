<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\DoctorApplicationStatus;
use App\Infrastructure\Service\DoctorOnboardingService;

/**
 * Whether a doctor who came from an approved application goes live at once
 * when they press "Go live" (spec §4.6, D1), or falls back to a quick human
 * check: everything an approval needs is in place (the readiness checks:
 * profile, verified documents for their route, the terms in force), a fee is
 * set, no change request is waiting, and the vetted identity still reads as
 * last approved — the specialist's approval snapshot after an approved change
 * request, otherwise the application's. Pure.
 */
final class GoLiveRules
{
    /**
     * @param array<string,bool>         $checklist
     * @param list<SpecialistCredential> $credentials
     * @return array<string,string> problem key => message (empty: go live)
     */
    public static function problems(
        Specialist $s,
        ?DoctorApplication $application,
        array $checklist,
        array $credentials,
        string $termsVersion,
        string $todayYmd,
    ): array {
        $problems = DoctorOnboardingService::readinessProblems($s, $checklist, $credentials, $termsVersion, $todayYmd);

        if (bccomp($s->getConsultationFee(), '0', 2) !== 1) {
            $problems['fee'] = 'A consultation fee has not been set.';
        }
        if ($s->getPendingFields() !== []) {
            $problems['pending_changes'] = 'A change to the profile is waiting for review.';
        }
        $approved = self::lastApprovedLocked($s, $application);
        if ($approved === null || !Specialist::sameLockedValues($s->lockedValues(), $approved)) {
            $problems['locked_values'] = 'The name, specialty or credentials differ from what was approved.';
        }
        if ($application === null || $application->getStatus() !== DoctorApplicationStatus::APPROVED) {
            $problems['application'] = 'The application this doctor came from is not approved.';
        }

        return $problems;
    }

    /**
     * The identity last approved by a reviewer: the specialist's snapshot once
     * a change request was approved, else what the application approval locked.
     *
     * @return array<string,mixed>|null
     */
    public static function lastApprovedLocked(Specialist $s, ?DoctorApplication $application): ?array
    {
        $snapshot = $s->getApprovedSnapshot();
        if ($snapshot !== null) {
            return array_intersect_key($snapshot, array_flip(Specialist::LOCKED_FIELDS));
        }
        $locked = $application?->getApprovalSnapshot()['locked'] ?? null;

        return is_array($locked) ? $locked : null;
    }
}
