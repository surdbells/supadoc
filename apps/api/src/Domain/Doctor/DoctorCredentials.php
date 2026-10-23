<?php

declare(strict_types=1);

namespace App\Domain\Doctor;

use App\Domain\Entity\SpecialistCredential;

/**
 * What a doctor's set of licensing documents adds up to. Pure — given the
 * documents and the clinic's date (Y-m-d, see ClinicTime), so the onboarding
 * checklist, the approval gate, reinstatement and the licence cron all read
 * them the same way.
 *
 * Route-aware (spec §4.4): a doctor licensed abroad (`$route` 'abroad') is
 * registered by a Certificate of Good Standing instead of the MDCN certificate
 * and practises on a foreign practising licence instead of an APL. A null
 * route reads as Nigeria, so existing callers are unchanged.
 */
final class DoctorCredentials
{
    /** How many days before expiry a licence counts as "expiring" in the back office. */
    public const EXPIRING_DAYS = 30;

    /** The document that registers the doctor: the MDCN certificate, or a Certificate of Good Standing abroad. */
    public static function registrationType(?string $route): string
    {
        return $route === 'abroad' ? SpecialistCredential::TYPE_GOOD_STANDING : SpecialistCredential::TYPE_MDCN;
    }

    /** The practising licence: an APL, or a foreign practising licence abroad. */
    public static function licenceType(?string $route): string
    {
        return $route === 'abroad' ? SpecialistCredential::TYPE_FOREIGN_LICENCE : SpecialistCredential::TYPE_LICENCE;
    }

    /** @param list<SpecialistCredential> $credentials */
    public static function hasVerifiedRegistration(array $credentials, ?string $route = null): bool
    {
        $type = self::registrationType($route);
        foreach ($credentials as $c) {
            if ($c->getType() === $type && $c->isVerified()) {
                return true;
            }
        }

        return false;
    }

    /** @param list<SpecialistCredential> $credentials */
    public static function hasVerifiedMdcn(array $credentials): bool
    {
        return self::hasVerifiedRegistration($credentials, 'ng');
    }

    /**
     * The verified practising licence still valid on `$todayYmd` that runs
     * longest, or null.
     *
     * @param list<SpecialistCredential> $credentials
     */
    public static function currentLicence(array $credentials, string $todayYmd, ?string $route = null): ?SpecialistCredential
    {
        $type = self::licenceType($route);
        $best = null;
        foreach ($credentials as $c) {
            if (
                $c->getType() !== $type
                || !$c->isVerified()
                || $c->expiresYmd() === null
                || $c->isExpiredOn($todayYmd)
            ) {
                continue;
            }
            if ($best === null || (string) $c->expiresYmd() > (string) $best->expiresYmd()) {
                $best = $c;
            }
        }

        return $best;
    }

    /** Registration document uploaded and not turned down (waiting or verified) — the doctor's checklist item. @param list<SpecialistCredential> $credentials */
    public static function mdcnProvided(array $credentials, ?string $route = null): bool
    {
        $type = self::registrationType($route);
        foreach ($credentials as $c) {
            if ($c->getType() === $type && ($c->isPending() || $c->isVerified())) {
                return true;
            }
        }

        return false;
    }

    /** A practising licence uploaded, not turned down and not expired — the doctor's checklist item. @param list<SpecialistCredential> $credentials */
    public static function licenceProvided(array $credentials, string $todayYmd, ?string $route = null): bool
    {
        $type = self::licenceType($route);
        foreach ($credentials as $c) {
            if (
                $c->getType() === $type
                && ($c->isPending() || $c->isVerified())
                && $c->expiresYmd() !== null
                && !$c->isExpiredOn($todayYmd)
            ) {
                return true;
            }
        }

        return false;
    }

    /** Both the registration document and a current licence are verified. @param list<SpecialistCredential> $credentials */
    public static function complete(array $credentials, string $todayYmd, ?string $route = null): bool
    {
        return self::hasVerifiedRegistration($credentials, $route) && self::currentLicence($credentials, $todayYmd, $route) !== null;
    }

    /**
     * The ids of the verified documents an approval rests on (the registration
     * document, the current licence, verified specialist certificates…) — an
     * expired licence of either kind is left out.
     *
     * @param list<SpecialistCredential> $credentials
     * @return list<string>
     */
    public static function verifiedIds(array $credentials, string $todayYmd, ?string $route = null): array
    {
        $ids = [];
        foreach ($credentials as $c) {
            if (!$c->isVerified() || (in_array($c->getType(), SpecialistCredential::LICENCE_TYPES, true) && $c->isExpiredOn($todayYmd))) {
                continue;
            }
            $ids[] = $c->getId();
        }

        return $ids;
    }

    /**
     * The licence's standing for badges and filters: valid | expiring (within
     * EXPIRING_DAYS) | expired | missing, from the stored expiry date.
     */
    public static function licenceStatus(?string $expiresYmd, string $todayYmd): string
    {
        if ($expiresYmd === null) {
            return 'missing';
        }
        if ($expiresYmd < $todayYmd) {
            return 'expired';
        }
        $soon = (new \DateTimeImmutable($todayYmd))->modify('+' . self::EXPIRING_DAYS . ' days')->format('Y-m-d');

        return $expiresYmd <= $soon ? 'expiring' : 'valid';
    }

    /** Whole days from `$todayYmd` to `$dateYmd` (negative once past). */
    public static function daysUntil(string $dateYmd, string $todayYmd): int
    {
        $from = new \DateTimeImmutable($todayYmd . ' 00:00:00', new \DateTimeZone('UTC'));
        $to   = new \DateTimeImmutable($dateYmd . ' 00:00:00', new \DateTimeZone('UTC'));

        return (int) round(($to->getTimestamp() - $from->getTimestamp()) / 86400);
    }

    /**
     * Which reminder to send now for something due in `$daysLeft` days, given
     * the reminder stages (days before, e.g. [30, 14, 7, 1]) and the most urgent
     * stage already sent (null: none). Only the most urgent stage reached is
     * sent — a doctor first noticed 5 days out gets the 7-day one, not three at
     * once — and never one already sent. Null: nothing to send (or already due).
     *
     * @param list<int> $stages
     */
    public static function dueStage(int $daysLeft, array $stages, ?int $lastSent): ?int
    {
        if ($daysLeft < 0) {
            return null;
        }
        $reached = array_values(array_filter($stages, static fn (int $s): bool => $daysLeft <= $s));
        if ($reached === []) {
            return null;
        }
        $stage = min($reached);

        return $lastSent === null || $stage < $lastSent ? $stage : null;
    }
}
