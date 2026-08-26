<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Entity\Referral;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ReferralRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/appointments/{id}/referrals — raise a referral for the
 * consultation. Requires a target and a reason; visible to the patient and audited.
 */
final class CreateReferralAction
{
    use ApiResponse;
    use ResolvesDoctorAppointment;

    public function __construct(
        private readonly UserRepository $users,
        private readonly AppointmentRepository $appointments,
        private readonly ReferralRepository $referrals,
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

        $body = (array) ($request->getParsedBody() ?? []);

        $referral = new Referral($id, $appointment->getPatient()->getId());
        $referral->setType((string) ($body['referral_type'] ?? 'specialist'));
        $referral->setTarget((string) ($body['target'] ?? ''));
        $referral->setReason((string) ($body['reason'] ?? ''));
        $referral->setClinicalSummary(is_string($body['clinical_summary'] ?? null) ? $body['clinical_summary'] : null);
        $referral->setPriority((string) ($body['priority'] ?? 'routine'));

        $errors = [];
        if ($referral->getTarget() === '') {
            $errors['target'] = 'A referral target is required';
        }
        if ($referral->getReason() === '') {
            $errors['reason'] = 'A reason is required';
        }
        if ($errors !== []) {
            return $this->error($response, 'Please complete the referral', 422, $errors);
        }

        $author = $appointment->getSpecialist()->getName();
        $referral->setAuthor($author);
        $this->referrals->save($referral);

        $this->audit->record(
            $author,
            'doctor',
            'referral.created',
            $id,
            'referral',
            $referral->getId(),
            ['target' => $referral->getTarget()],
        );

        return $this->success($response, $referral->toArray(), 'Referral created', 201)
            ->withHeader('Cache-Control', 'no-store');
    }
}
