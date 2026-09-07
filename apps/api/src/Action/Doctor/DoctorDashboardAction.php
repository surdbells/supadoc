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

        $now        = new DateTimeImmutable();
        $startToday  = $now->setTime(0, 0, 0);
        $endToday    = $startToday->modify('+1 day');
        $startMonth  = $now->modify('first day of this month')->setTime(0, 0, 0);
        $specialistId = $specialist->getId();
        $webUrl      = rtrim((string) ($_ENV['APP_WEB_URL'] ?? 'http://localhost:4201'), '/');

        $agenda = array_map(
            fn (Appointment $a): array => $this->row($a, $specialist, $webUrl),
            $this->appointments->forSpecialistBetween($specialistId, $startToday, $endToday),
        );
        $next = $this->appointments->nextForSpecialist($specialistId, $now);

        $sp = $specialist->toArray();

        return $this->success($response, [
            'today'           => count($agenda),
            'pending'         => $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::PENDING]),
            'upcoming'        => $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::CONFIRMED], $now),
            'completed_month' => $this->appointments->countForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startMonth, $now),
            'patients'        => $this->appointments->distinctPatientsForSpecialist($specialistId),
            'earnings_month'  => $this->appointments->sumAmountForSpecialist($specialistId, [AppointmentStatus::COMPLETED], $startMonth, $now),
            'currency'        => '₦',
            'rating'          => $sp['rating'],
            'reviews_count'   => $sp['reviews_count'],
            'next'            => $next !== null ? $this->row($next, $specialist, $webUrl) : null,
            'agenda'          => $agenda,
        ]);
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
