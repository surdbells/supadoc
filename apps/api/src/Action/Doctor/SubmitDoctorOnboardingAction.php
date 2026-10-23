<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/doctor/onboarding/submit — send the finished profile for review.
 * Only allowed once every checklist item is done — the documents uploaded and
 * the practitioner terms accepted included (else 422 naming what is missing);
 * moves the doctor to pending_review, records it in their history and the
 * audit trail, and notifies the admins.
 *
 * A doctor vetted through an approved application presses "Go live" instead
 * (spec §4.6): they are approved at once when every gate passes (`status`
 * approved), else it is the same quick final check (`status` pending_review).
 */
final class SubmitDoctorOnboardingAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly DoctorOnboardingService $onboarding,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $specialist = $this->doctorSpecialist($request, $this->users, $this->specialists);
        if ($specialist === null) {
            return $this->error($response, 'This account is not linked to a doctor profile. Please contact your administrator.', 403);
        }

        $goLive = $specialist->getApplicationId() !== null && $specialist->getStatus() === \App\Domain\Enum\SpecialistStatus::INVITED;
        // Throws ValidationException (→ 422) when incomplete or not submittable.
        $status = $this->onboarding->submit($specialist, (string) $request->getAttribute('user_id'));

        $message = match (true) {
            $status === 'approved' => "You're live. Patients can now find and book you.",
            $goLive                => "Sent for a quick final check. We'll email you when you're live.",
            default                => 'Submitted for review',
        };

        return $this->success($response, $this->onboarding->summary($specialist), $message);
    }
}
