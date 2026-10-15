<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PayoutRepository;
use DateTimeImmutable;

/**
 * Computes a doctor's earnings from their consultations. Gross is what they
 * earned: every completed consultation, and a missed one the patient didn't
 * come to (the doctor waited; the fee is theirs) — each less what was refunded
 * for it (guest fees, a no-show refund percentage, a back-office refund). A
 * consultation the doctor missed, or neither side came to, earns nothing. The
 * platform keeps a configurable
 * commission (DOCTOR_COMMISSION_PERCENT); net is the remainder. The available
 * payout balance is net earned minus payouts already committed (pending /
 * approved / paid). All money is bcmath decimal-string, scale 2.
 */
final class EarningsService
{
    private const SCALE = 2;

    public function __construct(
        private readonly AppointmentRepository $appointments,
        private readonly PayoutRepository $payouts,
        private readonly float $commissionPercent,
    ) {
    }

    public function commissionPercent(): float
    {
        return $this->commissionPercent;
    }

    /** Platform commission on a gross amount. */
    public function commission(string $gross): string
    {
        return bcdiv(bcmul($gross, (string) $this->commissionPercent, 4), '100', self::SCALE);
    }

    /** Doctor's net (gross minus commission). */
    public function net(string $gross): string
    {
        return bcsub($gross, $this->commission($gross), self::SCALE);
    }

    /** @return array<string,mixed> */
    public function summary(string $specialistId): array
    {
        $now        = new DateTimeImmutable();
        $startMonth = $now->modify('first day of this month')->setTime(0, 0, 0);

        $gross       = $this->appointments->sumEarnedForSpecialist($specialistId);
        $grossMonth  = $this->appointments->sumEarnedForSpecialist($specialistId, $startMonth, $now);
        $commission  = $this->commission($gross);
        $net         = bcsub($gross, $commission, self::SCALE);
        $committed   = $this->payouts->committedTotalForSpecialist($specialistId);
        $available   = bcsub($net, $committed, self::SCALE);
        if (bccomp($available, '0', self::SCALE) < 0) {
            $available = '0.00';
        }

        return [
            'currency'           => '₦',
            'commission_percent' => $this->commissionPercent,
            'gross_total'        => $gross,
            'commission_total'   => $commission,
            'net_total'          => $net,
            'payouts_total'      => $committed,
            'available_balance'  => $available,
            'gross_month'        => $grossMonth,
            'net_month'          => $this->net($grossMonth),
            'completed_count'    => $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::COMPLETED]),
            // Missed consultations the patient didn't come to (they count towards gross).
            'patient_no_show_count' => $this->appointments->countPatientNoShowsForSpecialist($specialistId),
            'has_open_payout'    => $this->payouts->hasOpenRequest($specialistId),
        ];
    }
}
