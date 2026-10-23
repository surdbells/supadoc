<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Entity\SpecialistCredential;

/**
 * The application's document slots per licence route (spec §2.12) and how each
 * becomes a doctor's credential at approval (spec §4.3). Pure.
 */
final class ApplicationDocuments
{
    public const MDCN_CERTIFICATE   = 'mdcn_certificate';
    public const GOOD_STANDING      = 'good_standing_certificate';
    public const GOVERNMENT_ID      = 'government_id';
    public const MEDICAL_DEGREE     = 'medical_degree';
    public const PRACTISING_LICENCE = 'practising_licence';
    public const CV                 = 'curriculum_vitae';
    public const INDEMNITY          = 'indemnity_certificate';
    public const ADDITIONAL         = 'additional';

    public const ALL = [
        self::MDCN_CERTIFICATE, self::GOOD_STANDING, self::GOVERNMENT_ID, self::MEDICAL_DEGREE,
        self::PRACTISING_LICENCE, self::CV, self::INDEMNITY, self::ADDITIONAL,
    ];

    /** The four documents of step 5 ("Documents"). */
    public const DOCUMENTS_STEP = [self::GOVERNMENT_ID, self::MEDICAL_DEGREE, self::PRACTISING_LICENCE, self::CV];

    /**
     * The slots an applicant may upload to on a draft for `$route` (never `additional`).
     *
     * @return list<string>
     */
    public static function slotsFor(string $route): array
    {
        return [
            $route === 'abroad' ? self::GOOD_STANDING : self::MDCN_CERTIFICATE,
            ...self::DOCUMENTS_STEP,
            self::INDEMNITY,
        ];
    }

    /**
     * Every slot that must hold an active document before submit (and approval).
     *
     * @return list<string>
     */
    public static function requiredFor(string $route): array
    {
        return self::slotsFor($route);
    }

    /** The certificate of the Licence step for `$route`. */
    public static function licenceCertificate(string $route): string
    {
        return $route === 'abroad' ? self::GOOD_STANDING : self::MDCN_CERTIFICATE;
    }

    /**
     * The slots a step needs before it is complete.
     *
     * @return list<string>
     */
    public static function requiredForStep(string $step, string $route): array
    {
        return match ($step) {
            'licence'   => [self::licenceCertificate($route)],
            'documents' => self::DOCUMENTS_STEP,
            'indemnity' => [self::INDEMNITY],
            default     => [],
        };
    }

    /** Whether `$slot` is a slot a request-info item may ask for on `$route`. */
    public static function requestable(string $slot, string $route): bool
    {
        return $slot === self::ADDITIONAL || in_array($slot, self::slotsFor($route), true);
    }

    public static function label(string $slot, string $route): string
    {
        return match ($slot) {
            self::MDCN_CERTIFICATE   => 'MDCN full registration certificate',
            self::GOOD_STANDING      => 'Certificate of Good Standing',
            self::GOVERNMENT_ID      => 'Government-issued ID',
            self::MEDICAL_DEGREE     => 'Medical degree certificate',
            self::PRACTISING_LICENCE => $route === 'abroad' ? 'Current practising licence' : 'Current MDCN practising licence',
            self::CV                 => 'Curriculum vitae',
            self::INDEMNITY          => 'Indemnity certificate',
            default                  => 'Additional document',
        };
    }

    public static function helper(string $slot, string $route, ?string $regulatorName = null): string
    {
        return match ($slot) {
            self::MDCN_CERTIFICATE   => 'The certificate MDCN issued when you were fully registered',
            self::GOOD_STANDING      => 'Issued within the last 6 months',
            self::GOVERNMENT_ID      => "Passport, driver's licence or national ID",
            self::MEDICAL_DEGREE     => 'MBBS / MBChB or equivalent',
            self::PRACTISING_LICENCE => $route === 'abroad'
                ? 'Issued by ' . (trim((string) $regulatorName) !== '' ? trim((string) $regulatorName) : 'your regulator')
                : 'Valid for the current year',
            self::CV                 => 'Your current CV',
            self::INDEMNITY          => 'Proof of current professional indemnity cover',
            default                  => '',
        };
    }

    /** The credential type a carried document becomes, or null (`additional` stays on the application). */
    public static function typeFor(string $slot, string $route): ?string
    {
        return match ($slot) {
            self::MDCN_CERTIFICATE   => SpecialistCredential::TYPE_MDCN,
            self::GOOD_STANDING      => SpecialistCredential::TYPE_GOOD_STANDING,
            self::PRACTISING_LICENCE => $route === 'abroad' ? SpecialistCredential::TYPE_FOREIGN_LICENCE : SpecialistCredential::TYPE_LICENCE,
            self::INDEMNITY          => SpecialistCredential::TYPE_INDEMNITY,
            self::GOVERNMENT_ID      => SpecialistCredential::TYPE_GOVERNMENT_ID,
            self::MEDICAL_DEGREE     => SpecialistCredential::TYPE_MEDICAL_DEGREE,
            self::CV                 => SpecialistCredential::TYPE_CV,
            default                  => null,
        };
    }

    /**
     * The approval dialog's prefill for one carried document (spec §4.3).
     *
     * @param array<string,mixed> $promoted reference, mdcn_number, registration_number, regulator_name,
     *                                      licence_expires_on, good_standing_issued_on, policy_number, cover_expires_on
     * @return array{needs_number:bool, needs_issue_date:bool, needs_expiry:bool,
     *               prefill: array{number:?string, issued_on:?string, expires_on:?string, register_reference:string},
     *               reference_hint:string, expiry_hint:?string}
     */
    public static function prefill(string $slot, string $route, array $promoted): array
    {
        $ref      = (string) ($promoted['reference'] ?? '');
        $reg      = trim((string) ($promoted['regulator_name'] ?? ''));
        $reg      = $reg !== '' ? $reg : 'Regulator';
        $checked  = 'Checked with application ' . $ref;
        $none     = ['number' => null, 'issued_on' => null, 'expires_on' => null, 'register_reference' => ''];
        $gsIssued = is_string($promoted['good_standing_issued_on'] ?? null) ? $promoted['good_standing_issued_on'] : null;

        return match (true) {
            $slot === self::MDCN_CERTIFICATE => [
                'needs_number' => true, 'needs_issue_date' => false, 'needs_expiry' => false,
                'prefill' => ['number' => $promoted['mdcn_number'] ?? null] + $none,
                'reference_hint' => 'MDCN register entry or search reference', 'expiry_hint' => null,
            ],
            $slot === self::PRACTISING_LICENCE && $route !== 'abroad' => [
                'needs_number' => true, 'needs_issue_date' => false, 'needs_expiry' => true,
                'prefill' => ['number' => $promoted['mdcn_number'] ?? null, 'expires_on' => $promoted['licence_expires_on'] ?? null] + $none,
                'reference_hint' => 'MDCN register entry or APL number checked', 'expiry_hint' => null,
            ],
            $slot === self::GOOD_STANDING => [
                'needs_number' => true, 'needs_issue_date' => true, 'needs_expiry' => false,
                'prefill' => ['number' => $promoted['registration_number'] ?? null, 'issued_on' => $gsIssued] + $none,
                'reference_hint' => $reg . ' register entry or certificate number', 'expiry_hint' => null,
            ],
            $slot === self::PRACTISING_LICENCE => [
                'needs_number' => true, 'needs_issue_date' => false, 'needs_expiry' => true,
                'prefill' => [
                    'number'     => $promoted['registration_number'] ?? null,
                    'expires_on' => $gsIssued !== null ? (new \DateTimeImmutable($gsIssued))->modify('+12 months')->format('Y-m-d') : null,
                ] + $none,
                'reference_hint' => $reg . ' register entry',
                'expiry_hint'    => "No expiry printed? Use 12 months from the Certificate of Good Standing date. They'll be asked for a new certificate then.",
            ],
            $slot === self::INDEMNITY => [
                'needs_number' => true, 'needs_issue_date' => false, 'needs_expiry' => true,
                'prefill' => ['number' => $promoted['policy_number'] ?? null, 'expires_on' => $promoted['cover_expires_on'] ?? null, 'register_reference' => $checked] + $none,
                'reference_hint' => 'Provider and policy checked', 'expiry_hint' => null,
            ],
            $slot === self::GOVERNMENT_ID => [
                'needs_number' => false, 'needs_issue_date' => false, 'needs_expiry' => false,
                'prefill' => ['register_reference' => $checked] + $none,
                'reference_hint' => 'ID matched to applicant', 'expiry_hint' => null,
            ],
            $slot === self::MEDICAL_DEGREE => [
                'needs_number' => false, 'needs_issue_date' => false, 'needs_expiry' => false,
                'prefill' => ['register_reference' => $checked] + $none,
                'reference_hint' => 'Degree and institution checked', 'expiry_hint' => null,
            ],
            default => [
                'needs_number' => false, 'needs_issue_date' => false, 'needs_expiry' => false,
                'prefill' => ['register_reference' => $checked] + $none,
                'reference_hint' => 'CV reviewed', 'expiry_hint' => null,
            ],
        };
    }
}
