<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\MedicalCertificate;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\MedicalCertificateRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/certificates — issue a medical certificate
 * (sick-leave note, fitness statement, or general). Issued signed and visible to
 * the patient; a certificate is never edited (issue a new one instead).
 */
final class CreateCertificateAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly MedicalCertificateRepository $certificates,
        private readonly AuditLogger $audit,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $id = (string) $args['id'];
        $appointment = $this->doctorAppointment($request, $this->users, $this->appointments, $id);
        if ($appointment === null) {
            return $this->error($response, 'Consultation not found', 403);
        }

        $body      = (array) ($request->getParsedBody() ?? []);
        $type      = (string) ($body['type'] ?? 'sick_leave');
        $statement = trim((string) ($body['statement'] ?? ''));
        if ($statement === '') {
            return $this->error($response, 'A statement is required', 422, ['statement' => 'Describe what you are certifying']);
        }

        [$from, $to] = $this->period($body, $type);
        if ($type === 'sick_leave' && ($from === null || $to === null)) {
            return $this->error($response, 'A leave period is required', 422, ['from_date' => 'Provide the leave dates']);
        }
        if ($from !== null && $to !== null && $to < $from) {
            return $this->error($response, 'The end date cannot be before the start date', 422, ['to_date' => 'Must be on or after the start date']);
        }

        $certificate = new MedicalCertificate($id, $appointment->getPatient()->getId());
        $certificate->setType($type);
        $certificate->setStatement($statement);
        $certificate->setDiagnosis(is_string($body['diagnosis'] ?? null) ? $body['diagnosis'] : null);
        $certificate->setPeriod($from, $to);
        $author = $appointment->getSpecialist()->getName();
        $certificate->setAuthor($author);
        $this->certificates->save($certificate);

        $this->audit->record(
            $author,
            'doctor',
            'certificate.issued',
            $id,
            'certificate',
            $certificate->getId(),
            ['type' => $type],
        );

        return $this->success($response, $certificate->toArray(), 'Certificate issued', 201)
            ->withHeader('Cache-Control', 'no-store');
    }

    /**
     * @param array<string,mixed> $body
     * @return array{0: ?\DateTimeImmutable, 1: ?\DateTimeImmutable}
     */
    private function period(array $body, string $type): array
    {
        if ($type !== 'sick_leave') {
            return [null, null];
        }

        return [$this->date($body['from_date'] ?? null), $this->date($body['to_date'] ?? null)];
    }

    private function date(mixed $v): ?\DateTimeImmutable
    {
        if (!is_string($v) || trim($v) === '') {
            return null;
        }
        try {
            return new \DateTimeImmutable(trim($v));
        } catch (\Throwable) {
            return null;
        }
    }
}
