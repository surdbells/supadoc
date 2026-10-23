<?php

declare(strict_types=1);

namespace App\Domain\Application;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Exception\ValidationException;
use DateTimeImmutable;

/**
 * The reviewer's approval form (spec §4.2 step 3, §4.3): the attestation, the
 * consultation fee, the specialty and — for every document carried over to the
 * doctor's record — a "checked" tick, the register reference and the number /
 * dates the credential type needs. Pure; throws one ValidationException with
 * every problem (keys `attest`, `consultation_fee`, `specialty`, `documents`,
 * `documents.{id}.{field}`).
 */
final class ApprovalInput
{
    public const MAX_FEE       = '10000000';
    public const MAX_REFERENCE = 120;
    public const MAX_NUMBER    = 60;

    /**
     * @param array<string,mixed>             $body
     * @param list<DoctorApplicationDocument> $activeDocs
     * @param callable(string):?string        $resolveSpecialty
     * @return array{fee:string, specialty:string, documents: array<string, array{checked:bool, register_reference:string, number:?string, issued_on:?DateTimeImmutable, expires_on:?DateTimeImmutable}>}
     * @throws ValidationException
     */
    public static function validate(array $body, DoctorApplication $app, array $activeDocs, string $todayYmd, callable $resolveSpecialty): array
    {
        $errors = [];
        $route  = $app->getLicenceRoute();

        if (($body['attest'] ?? null) !== true) {
            $errors['attest'] = 'Confirm that you checked this applicant\'s documents and identity against ' . self::registerName($app) . '.';
        }

        $fee = self::fee($body['consultation_fee'] ?? null);
        if ($fee === null) {
            $errors['consultation_fee'] = 'Enter the consultation fee.';
        }

        $wanted    = is_string($body['specialty'] ?? null) && trim($body['specialty']) !== '' ? trim($body['specialty']) : (string) $app->getSpecialty();
        $specialty = $wanted !== '' ? $resolveSpecialty($wanted) : null;
        if ($specialty === null) {
            $errors['specialty'] = ($wanted !== '' ? $wanted : 'The specialty') . ' is no longer on the specialty list. Choose one.';
        }

        $missing = self::missingSlots($route, $activeDocs);
        if ($missing !== []) {
            $errors['documents'] = 'The application has no ' . ApplicationDocuments::label($missing[0], $route) . '. Request it from the applicant first.';
        }

        $given = is_array($body['documents'] ?? null) ? $body['documents'] : [];
        $docs  = [];
        $min   = ApplicationSections::goodStandingEarliest($todayYmd);
        foreach (self::carried($activeDocs) as $doc) {
            $id   = $doc->getId();
            $in   = is_array($given[$id] ?? null) ? $given[$id] : [];
            $key  = 'documents.' . $id . '.';
            $type = (string) ApplicationDocuments::typeFor($doc->getSlot(), $route);

            if (($in['checked'] ?? null) !== true) {
                $errors[$key . 'checked'] = 'Tick to confirm you checked this document.';
            }
            $reference = is_string($in['register_reference'] ?? null) ? trim($in['register_reference']) : '';
            if ($reference === '' || mb_strlen($reference) > self::MAX_REFERENCE) {
                $errors[$key . 'register_reference'] = $reference === ''
                    ? 'Enter the register reference, or what you checked.'
                    : 'Keep the reference to ' . self::MAX_REFERENCE . ' characters.';
            }
            $number = is_string($in['number'] ?? null) ? trim($in['number']) : '';
            if ($number === '' && SpecialistCredential::requiresNumber($type)) {
                $errors[$key . 'number'] = 'Enter the number on the document.';
            } elseif (mb_strlen($number) > self::MAX_NUMBER) {
                $errors[$key . 'number'] = 'Keep the number to ' . self::MAX_NUMBER . ' characters.';
            }

            $expires = self::date($in['expires_on'] ?? null);
            if (SpecialistCredential::requiresExpiry($type)) {
                if ($expires === null) {
                    $errors[$key . 'expires_on'] = 'Enter the expiry date.';
                } elseif ($expires->format('Y-m-d') < $todayYmd) {
                    $errors[$key . 'expires_on'] = 'This document has expired. Request a current one.';
                }
            }

            $issued = self::date($in['issued_on'] ?? null);
            if ($doc->getSlot() === ApplicationDocuments::GOOD_STANDING) {
                if ($issued === null) {
                    $errors[$key . 'issued_on'] = 'Enter the date the certificate was issued.';
                } elseif ($issued->format('Y-m-d') > $todayYmd) {
                    $errors[$key . 'issued_on'] = 'The issue date cannot be in the future.';
                } elseif ($issued->format('Y-m-d') < $min) {
                    $errors[$key . 'issued_on'] = 'This certificate is more than 6 months old. Request a newer one.';
                }
            } elseif ($issued !== null && $issued->format('Y-m-d') > $todayYmd) {
                $errors[$key . 'issued_on'] = 'The issue date cannot be in the future.';
            }

            $docs[$id] = [
                'checked'            => true,
                'register_reference' => $reference,
                'number'             => $number !== '' ? $number : null,
                'issued_on'          => $issued,
                'expires_on'         => $expires,
            ];
        }

        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        return ['fee' => (string) $fee, 'specialty' => (string) $specialty, 'documents' => $docs];
    }

    /**
     * What stops an approval before the reviewer types anything: a required
     * document missing, the specialty off the list.
     *
     * @param list<DoctorApplicationDocument> $activeDocs
     * @param callable(string):?string        $resolveSpecialty
     * @return array<string,string>
     */
    public static function problems(DoctorApplication $app, array $activeDocs, callable $resolveSpecialty): array
    {
        $problems = [];
        $missing  = self::missingSlots($app->getLicenceRoute(), $activeDocs);
        if ($missing !== []) {
            $problems['documents'] = 'The application has no ' . ApplicationDocuments::label($missing[0], $app->getLicenceRoute()) . '. Request it from the applicant first.';
        }
        $specialty = (string) $app->getSpecialty();
        if ($specialty === '' || $resolveSpecialty($specialty) === null) {
            $problems['specialty'] = ($specialty !== '' ? $specialty : 'The specialty') . ' is no longer on the specialty list. Choose one.';
        }

        return $problems;
    }

    /** "the MDCN register" / "the General Medical Council register". */
    public static function registerName(DoctorApplication $app): string
    {
        if ($app->getLicenceRoute() !== 'abroad') {
            return 'the MDCN register';
        }
        $name = trim((string) $app->getRegulatorName());

        return 'the ' . ($name !== '' ? $name : "regulator's") . ' register';
    }

    /**
     * The documents that become credentials: every active one except `additional`.
     *
     * @param list<DoctorApplicationDocument> $activeDocs
     * @return list<DoctorApplicationDocument>
     */
    public static function carried(array $activeDocs): array
    {
        return array_values(array_filter(
            $activeDocs,
            static fn (DoctorApplicationDocument $d): bool => $d->isActive() && $d->getSlot() !== ApplicationDocuments::ADDITIONAL,
        ));
    }

    /** A money amount: > 0, ≤ 10,000,000, at most two decimals → "15000.00"; null otherwise. */
    public static function fee(mixed $raw): ?string
    {
        if (is_int($raw)) {
            $raw = (string) $raw;
        } elseif (is_float($raw)) {
            $raw = number_format($raw, 2, '.', '');
        }
        if (!is_string($raw) || preg_match('/^\d{1,8}(\.\d{1,2})?$/', trim($raw)) !== 1) {
            return null;
        }
        $fee = bcadd(trim($raw), '0', 2);
        if (bccomp($fee, '0', 2) !== 1 || bccomp($fee, self::MAX_FEE, 2) === 1) {
            return null;
        }

        return $fee;
    }

    /**
     * @param list<DoctorApplicationDocument> $activeDocs
     * @return list<string>
     */
    private static function missingSlots(string $route, array $activeDocs): array
    {
        $have = array_map(static fn (DoctorApplicationDocument $d): string => $d->getSlot(), array_filter($activeDocs, static fn (DoctorApplicationDocument $d): bool => $d->isActive()));

        return array_values(array_diff(ApplicationDocuments::requiredFor($route), $have));
    }

    private static function date(mixed $raw): ?DateTimeImmutable
    {
        if (!is_string($raw) || ApplicationSections::parseYmd(trim($raw)) === null) {
            return null;
        }

        return DateTimeImmutable::createFromFormat('!Y-m-d', trim($raw)) ?: null;
    }
}
