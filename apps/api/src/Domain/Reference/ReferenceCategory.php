<?php

declare(strict_types=1);

namespace App\Domain\Reference;

/**
 * The reference-data lists the back office manages ({@see \App\Domain\Entity\ReferenceItem}).
 * A list is known here or it does not exist (an unknown `{category}` is a 404),
 * so adding one — `language`, say — is one entry below plus, when records use
 * its labels, their usage count and rename hook in
 * {@see \App\Infrastructure\Service\ReferenceDataService}.
 */
final class ReferenceCategory
{
    /** Doctors' medical specialty — stored on each specialist as the label string. */
    public const SPECIALTY = 'specialty';

    /**
     * Each list with how its records are described in messages.
     *
     * @var array<string, array{label:string, used_by:array{0:string,1:string}}>
     */
    private const LISTS = [
        self::SPECIALTY => ['label' => 'Specialty', 'used_by' => ['doctor', 'doctors']],
    ];

    /**
     * The standard specialties offered from the start (seeded by
     * bin/prod-migrate.php alongside the ones doctors already have).
     */
    public const STANDARD_SPECIALTIES = [
        'General Practice',
        'Family Medicine',
        'Internal Medicine',
        'Cardiology',
        'Dermatology',
        'Pediatrics',
        'Psychiatry',
        'Psychology',
        'Gynecology',
        'Obstetrics',
        'Orthopedics',
        'Ophthalmology',
        'ENT (Otolaryngology)',
        'Neurology',
        'Endocrinology',
        'Gastroenterology',
        'Urology',
        'Nephrology',
        'Pulmonology',
        'Oncology',
        'Rheumatology',
        'Infectious Diseases',
        'Nutrition & Dietetics',
        'Physiotherapy',
    ];

    public static function exists(string $category): bool
    {
        return array_key_exists($category, self::LISTS);
    }

    /** @return list<string> */
    public static function all(): array
    {
        return array_keys(self::LISTS);
    }

    public static function label(string $category): string
    {
        return self::LISTS[$category]['label'] ?? ucfirst($category);
    }

    /** "1 doctor" / "3 doctors" — who uses an item of this list, counted. */
    public static function usedBy(string $category, int $count): string
    {
        [$one, $many] = self::LISTS[$category]['used_by'] ?? ['record', 'records'];

        return $count . ' ' . ($count === 1 ? $one : $many);
    }
}
