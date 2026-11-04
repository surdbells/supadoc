<?php

declare(strict_types=1);

namespace App\Domain\Lab;

use App\Domain\Entity\LabRequest;
use DateTimeImmutable;

/**
 * Who may move a lab request where (spec §1.7) — pure. Every check is made
 * on the EFFECTIVE status (expiry computed on read). The service runs each
 * transition under the request's row lock and asks here first.
 *
 *  - patient: accept / decline (awaiting consent), sample (booked), upload
 *    (booked, in lab, result ready; also an expired request they had
 *    accepted, and a cancelled one whose sample was already given — T6c);
 *  - requesting doctor: cancel (awaiting consent, booked, in lab), review
 *    (result ready; cancelled once it holds a result);
 *  - staff (`labs.manage`): the corrections C1–C4 ({@see staffTargets()}).
 */
final class LabRequestTransitions
{
    public const PATIENT_UPLOAD_FROM = ['booked', 'in_lab', 'result_ready'];
    public const DOCTOR_CANCEL_FROM  = ['awaiting_consent', 'booked', 'in_lab'];
    public const DOCTOR_REVIEW_ON    = ['result_ready', 'cancelled'];
    public const STAFF_CORRECTIONS   = ['booked' => ['in_lab'], 'in_lab' => ['booked'], 'declined' => ['awaiting_consent'], 'expired' => ['booked|awaiting_consent']];

    /** action => the only role that may take it */
    public const ACTIONS = [
        'accept'  => 'patient',
        'decline' => 'patient',
        'sample'  => 'patient',
        'upload'  => 'patient',
        'cancel'  => 'doctor',
        'review'  => 'doctor',
        'correct' => 'staff',
    ];

    /** @throws LabTransitionRefused */
    public static function assertCan(string $effectiveStatus, string $action, string $actorRole, LabRequest $r): void
    {
        if ((self::ACTIONS[$action] ?? null) !== $actorRole) {
            throw new LabTransitionRefused(403, 'not_allowed', "You can't do that on this request.", ['code' => 'not_allowed']);
        }
        if (!self::allowed($effectiveStatus, $action, $r)) {
            throw self::refusal($effectiveStatus, $action);
        }
    }

    /** May `$action` happen on a request whose effective status is `$effectiveStatus`? */
    public static function allowed(string $effectiveStatus, string $action, LabRequest $r): bool
    {
        return match ($action) {
            'accept', 'decline' => $effectiveStatus === LabRequest::STATUS_AWAITING_CONSENT,
            'sample'  => $effectiveStatus === LabRequest::STATUS_BOOKED,
            'upload'  => in_array($effectiveStatus, self::PATIENT_UPLOAD_FROM, true)
                || ($effectiveStatus === LabRequest::STATUS_EXPIRED && $r->getConsentedAt() !== null)
                || ($effectiveStatus === LabRequest::STATUS_CANCELLED && $r->getSampleAt() !== null),
            'cancel'  => in_array($effectiveStatus, self::DOCTOR_CANCEL_FROM, true),
            'review'  => $effectiveStatus === LabRequest::STATUS_RESULT_READY
                || ($effectiveStatus === LabRequest::STATUS_CANCELLED && $r->getResultsCount() > 0),
            'correct' => self::targetsFor($effectiveStatus, $r) !== [],
            default   => false,
        };
    }

    /** The refusal for `$action` on this effective status (spec §2.1 codes and messages). */
    public static function refusal(string $effectiveStatus, string $action): LabTransitionRefused
    {
        if ($effectiveStatus === LabRequest::STATUS_EXPIRED && in_array($action, ['accept', 'decline'], true)) {
            return new LabTransitionRefused(409, 'expired', LabRequestRules::STATUS_MESSAGES['expired'], ['code' => 'expired', 'status' => $effectiveStatus]);
        }
        $message = $action === 'upload' && $effectiveStatus === LabRequest::STATUS_AWAITING_CONSENT
            ? 'Accept the request before adding a result.'
            : (LabRequestRules::STATUS_MESSAGES[$effectiveStatus] ?? 'This request changed. Reload it and try again.');

        return new LabTransitionRefused(409, 'status_changed', $message, ['code' => 'status_changed', 'status' => $effectiveStatus]);
    }

    /**
     * The statuses staff may correct this request to now (E16): booked → in
     * lab, in lab → booked, declined → awaiting consent, expired → booked when
     * the patient had accepted (else awaiting consent).
     *
     * @return list<string>
     */
    public static function staffTargets(LabRequest $r, DateTimeImmutable $now): array
    {
        return self::targetsFor($r->effectiveStatus($now), $r);
    }

    /** @return list<string> */
    private static function targetsFor(string $effectiveStatus, LabRequest $r): array
    {
        $targets = self::STAFF_CORRECTIONS[$effectiveStatus] ?? [];
        if ($targets === ['booked|awaiting_consent']) {
            return [$r->getConsentedAt() !== null ? LabRequest::STATUS_BOOKED : LabRequest::STATUS_AWAITING_CONSENT];
        }

        return $targets;
    }
}
