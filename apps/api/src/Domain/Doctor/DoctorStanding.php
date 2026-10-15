<?php

declare(strict_types=1);

namespace App\Domain\Doctor;

use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Settings\PractitionerTerms;

/**
 * Whether a doctor may do clinical work, and which doctor-portal routes they
 * may use when they may not. Pure — the middleware, the call-join check and
 * the actions resolve the doctor and ask here.
 *
 *  - doctor_suspended: stopped practising. They may sign in to see why, their
 *    earnings and payout history (patients unnamed), edit their profile and
 *    upload a new licence — nothing clinical, no patient data, no availability
 *    (not even through PATCH /doctor/profile: {@see profileEditProblem()}),
 *    no new payout request.
 *  - doctor_not_approved: still onboarding (or sent back). They may set up
 *    their profile (signature, availability, payout account, documents,
 *    terms) but do no clinical work.
 *  - terms_required: approved, but hasn't accepted the practitioner terms in
 *    force. They may read everything but start no new clinical work (no
 *    clinical writes, and no call join for a consultation that hasn't started —
 *    {@see CallAccess::doctorProblem()}) until they accept; one already under
 *    way they may finish (DoctorStandingMiddleware lets its writes through).
 */
final class DoctorStanding
{
    public const SUSPENDED    = 'doctor_suspended';
    public const NOT_APPROVED = 'doctor_not_approved';
    public const TERMS        = 'terms_required';

    /** Doctor-portal routes every doctor may use, whatever their standing ("METHOD /pattern", `*` any method, a trailing `/*` any sub-path). */
    private const ALWAYS = [
        'GET /doctor/onboarding',
        'POST /doctor/onboarding/submit',
        '* /doctor/credentials',
        '* /doctor/credentials/*',
        '* /doctor/terms',
        '* /doctor/terms/*',
        'GET /doctor/profile',
        'PATCH /doctor/profile',
        'DELETE /doctor/profile/changes',
        'POST /doctor/avatar',
        'DELETE /doctor/avatar',
        'GET /doctor/earnings',
        'GET /doctor/earnings/transactions',
        'GET /doctor/payouts',
        'GET /doctor/payout-account',
        'PUT /doctor/payout-account',
    ];

    /** What a doctor still setting up also needs (the onboarding checklist). */
    private const SETUP = [
        '* /doctor/signature',
        '* /doctor/availability',
        '* /doctor/availability/*',
        'GET /doctor/dashboard',
    ];

    /** Clinical work a doctor who hasn't accepted the current terms may not start (writes only). */
    private const CLINICAL_PREFIXES = ['/doctor/appointments', '/doctor/prescriptions', '/doctor/patients'];

    /** PATCH /doctor/profile keys that are availability — refused to a suspended doctor (the rest of the profile stays theirs). */
    public const AVAILABILITY_FIELDS = ['weekly_hours', 'slot_minutes', 'available'];

    /**
     * Why this doctor may not do clinical work now, as [code, message], or null.
     *
     * @return array{0:string, 1:string}|null
     */
    public static function problem(Specialist $doctor, ?string $termsVersion = null): ?array
    {
        $status = $doctor->getStatus();
        if ($status === SpecialistStatus::SUSPENDED) {
            return [self::SUSPENDED, 'Your VideoMed account is suspended, so you cannot do clinical work. '
                . 'Open your onboarding page to see why and what to do next.'];
        }
        if (!$doctor->isApproved()) {
            return [self::NOT_APPROVED, 'Your profile has not been approved yet, so you cannot do clinical work. '
                . 'Finish your onboarding checklist and submit it for review.'];
        }
        $version = $termsVersion ?? PractitionerTerms::version();
        if (!$doctor->hasAcceptedTerms($version)) {
            return [self::TERMS, 'Please read and accept the VideoMed practitioner terms (version ' . $version . ') '
                . 'in your doctor portal before you start new clinical work.'];
        }

        return null;
    }

    /**
     * Why this doctor may not make this PATCH /doctor/profile edit, as
     * [code, message], or null: a suspended doctor keeps editing their profile
     * but not their availability ({@see AVAILABILITY_FIELDS}).
     *
     * @param array<string,mixed> $body
     * @return array{0:string, 1:string}|null
     */
    public static function profileEditProblem(Specialist $doctor, array $body): ?array
    {
        if (!$doctor->isSuspended() || array_intersect_key($body, array_flip(self::AVAILABILITY_FIELDS)) === []) {
            return null;
        }

        return [self::SUSPENDED, 'Your VideoMed account is suspended, so you cannot change your availability. '
            . 'Open your onboarding page to see why and what to do next.'];
    }

    /** The doctor's standing for the portals: {code, message}, or null when they may practise. */
    public static function payload(Specialist $doctor, ?string $termsVersion = null): ?array
    {
        $problem = self::problem($doctor, $termsVersion);

        return $problem !== null ? ['code' => $problem[0], 'message' => $problem[1]] : null;
    }

    /**
     * May a doctor whose standing is `$code` (null: in good standing) call
     * `$method $path`? `$path` is the route pattern (or path) after `/api`,
     * e.g. "/doctor/appointments/{id}/note".
     */
    public static function allows(?string $code, string $method, string $path): bool
    {
        if ($code === null) {
            return true;
        }
        $method = strtoupper($method);
        $path   = '/' . trim($path, '/');

        if (self::matches(self::ALWAYS, $method, $path)) {
            return true;
        }

        return match ($code) {
            self::NOT_APPROVED => self::matches(self::SETUP, $method, $path),
            self::TERMS        => $method === 'GET' || !self::isClinical($path),
            default            => false, // suspended: only the always-allowed routes
        };
    }

    private static function isClinical(string $path): bool
    {
        foreach (self::CLINICAL_PREFIXES as $prefix) {
            if ($path === $prefix || str_starts_with($path, $prefix . '/')) {
                return true;
            }
        }

        return false;
    }

    /** @param list<string> $rules */
    private static function matches(array $rules, string $method, string $path): bool
    {
        foreach ($rules as $rule) {
            [$ruleMethod, $rulePath] = explode(' ', $rule, 2);
            if ($ruleMethod !== '*' && $ruleMethod !== $method) {
                continue;
            }
            if (str_ends_with($rulePath, '/*')) {
                if (str_starts_with($path, substr($rulePath, 0, -1))) {
                    return true;
                }
            } elseif ($path === $rulePath) {
                return true;
            }
        }

        return false;
    }
}
