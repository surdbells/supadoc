<?php

declare(strict_types=1);

namespace App\Domain\Doctor;

use App\Domain\Entity\SpecialistCredential;

/**
 * What a doctor's set of licensing documents adds up to. Pure — given the
 * documents and the clinic's date (Y-m-d, see ClinicTime), so the onboarding
 * checklist, the approval gate, reinstatement and the licence cron all read
 * them the same way.
 */
final class DoctorCredentials
{
    /** How many days before expiry a licence counts as "expiring" in the back office. */
    public const EXPIRING_DAYS = 30;

    /** @param list<SpecialistCredential> $credentials */
    public static function hasVerifiedMdcn(array $credentials): bool
    {
        foreach ($credentials as $c) {
            if ($c->getType() === SpecialistCredential::TYPE_MDCN && $c->isVerified()) {
                return true;
            }
        }

        return false;
    }

    /**
     * The verified practising licence still valid on `$todayYmd` that runs
     * longest, or null.
     *
     * @param list<SpecialistCredential> $credentials
     */
    public static function currentLicence(array $credentials, string $todayYmd): ?SpecialistCredential
    {
        $best = null;
        foreach ($credentials as $c) {
            if (
                $c->getType() !== SpecialistCredential::TYPE_LICENCE
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

    /** MDCN certificate uploaded and not turned down (waiting or verified) — the doctor's checklist item. @param list<SpecialistCredential> $credentials */
    public static function mdcnProvided(array $credentials): bool
    {
        foreach ($credentials as $c) {
            if ($c->getType() === SpecialistCredential::TYPE_MDCN && ($c->isPending() || $c->isVerified())) {
                return true;
            }
        }

        return false;
    }

    /** A practising licence uploaded, not turned down and not expired — the doctor's checklist item. @param list<SpecialistCredential> $credentials */
    public static function licenceProvided(array $credentials, string $todayYmd): bool
    {
        foreach ($credentials as $c) {
            if (
                $c->getType() === SpecialistCredential::TYPE_LICENCE
                && ($c->isPending() || $c->isVerified())
                && $c->expiresYmd() !== null
                && !$c->isExpiredOn($todayYmd)
            ) {
                return true;
            }
        }

        return false;
    }

    /** Both the MDCN certificate and a current licence are verified. @param list<SpecialistCredential> $credentials */
    public static function complete(array $credentials, string $todayYmd): bool
    {
        return self::hasVerifiedMdcn($credentials) && self::currentLicence($credentials, $todayYmd) !== null;
    }

    /**
     * The ids of the verified documents an approval rests on (the MDCN
     * certificate, the current licence, verified specialist certificates).
     *
     * @param list<SpecialistCredential> $credentials
     * @return list<string>
     */
    public static function verifiedIds(array $credentials, string $todayYmd): array
    {
        $ids = [];
        foreach ($credentials as $c) {
            if (!$c->isVerified() || ($c->getType() === SpecialistCredential::TYPE_LICENCE && $c->isExpiredOn($todayYmd))) {
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
