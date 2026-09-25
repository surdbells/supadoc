<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\JwtService;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/doctor/dashboard — headline metrics + today's agenda for the signed-in
 * doctor: counts (today / pending / upcoming / completed this month), distinct
 * patients, this-month earnings snapshot, rating, and the next + today's
 * appointments (each with a join link).
 */
final class DoctorDashboardAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly JwtService $jwt,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not a doctor profile', 403);
        }

        $now         = new DateTimeImmutable();
        $startToday   = $now->setTime(0, 0, 0);
        $endToday     = $startToday->modify('+1 day');
        $startYesterday = $startToday->modify('-1 day');
        $startMonth   = $now->modify('first day of this month')->setTime(0, 0, 0);
        $startLastMonth = $now->modify('first day of last month')->setTime(0, 0, 0);
        $startWeek    = $now->modify('monday this week')->setTime(0, 0, 0);
        $startLastWeek = $startWeek->modify('-7 days');
        $specialistId = $specialist->getId();
        $webUrl       = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');

        // "not cancelled" — what the agenda and the Today's Appointments count show.
        $active = [
            AppointmentStatus::PENDING,
            AppointmentStatus::CONFIRMED,
            AppointmentStatus::RESCHEDULED,
            AppointmentStatus::COMPLETED,
        ];

        $agenda = array_map(
            fn (Appointment $a): array => $this->row($a, $specialist, $webUrl),
            $this->appointments->forSpecialistBetween($specialistId, $startToday, $endToday),
        );
        $next = $this->appointments->nextForSpecialist($specialistId, $now);

        $todayCount     = count($agenda);
        $yesterdayCount = $this->appointments->countForSpecialist($specialistId, $active, $startYesterday, $startToday);
        $todayCompleted = $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startToday, $endToday);

        // Compare like-for-like: cap each prior period to the SAME elapsed offset
        // into its window, so an incomplete current period isn't measured against
        // a complete previous one (which showed a large false drop at each
        // month/week start).
        $monthElapsed = $now->getTimestamp() - $startMonth->getTimestamp();
        $lastMonthTo  = $startLastMonth->modify("+{$monthElapsed} seconds");
        // Never let the baseline bleed past last month (a long current month
        // following a shorter previous one could otherwise overshoot into it).
        if ($lastMonthTo > $startMonth) {
            $lastMonthTo = $startMonth;
        }
        $weekElapsed  = $now->getTimestamp() - $startWeek->getTimestamp();
        $lastWeekTo   = $startLastWeek->modify("+{$weekElapsed} seconds");

        $completedMonth     = $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startMonth, $now);
        $completedLastMonth = $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startLastMonth, $lastMonthTo);

        $earningsMonth     = $this->appointments->sumAmountForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startMonth, $now);
        $earningsLastMonth = $this->appointments->sumAmountForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startLastMonth, $lastMonthTo);

        $patients         = $this->appointments->distinctPatientsForSpecialist($specialistId);
        $patientsThisWeek = $this->appointments->distinctPatientsForSpecialist($specialistId, $startWeek, $now);
        $patientsLastWeek = $this->appointments->distinctPatientsForSpecialist($specialistId, $startLastWeek, $lastWeekTo);

        $sp = $specialist->toArray();

        return $this->success($response, [
            'today'            => $todayCount,
            'today_completed'  => $todayCompleted,
            'today_delta'      => $this->delta((float) $todayCount, (float) $yesterdayCount),
            'pending'          => $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::PENDING]),
            'upcoming'         => $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::CONFIRMED], $now),
            'completed_month'  => $completedMonth,
            'completed_delta'  => $this->delta((float) $completedMonth, (float) $completedLastMonth),
            'patients'         => $patients,
            'patients_week'    => $patientsThisWeek,
            'patients_delta'   => $this->delta((float) $patientsThisWeek, (float) $patientsLastWeek),
            'earnings_month'   => $earningsMonth,
            'earnings_delta'   => $this->delta((float) $earningsMonth, (float) $earningsLastMonth),
            'currency'         => '₦',
            'rating'           => $sp['rating'],
            'reviews_count'    => $sp['reviews_count'],
            'next'             => $next !== null ? $this->row($next, $specialist, $webUrl) : null,
            'agenda'           => $agenda,
        ]);
    }

    /** Percentage change from $prev to $cur, rounded; null when there's no base. */
    private function delta(float $cur, float $prev): ?int
    {
        if ($prev <= 0.0) {
            return null;
        }

        return (int) round((($cur - $prev) / $prev) * 100);
    }

    /** @return array<string,mixed> */
    private function row(Appointment $appt, Specialist $specialist, string $webUrl): array
    {
        $patient = $appt->getPatient()->toArray();
        $token   = $this->jwt->issueCallAccess($appt->getId(), $specialist->getName(), 'doctor', 2);

        return $appt->toArray() + [
            'patient_name' => trim(((string) $patient['first_name']) . ' ' . ((string) $patient['last_name'])),
            'join_url'     => $webUrl . '/call/join/' . $token,
        ];
    }
}
