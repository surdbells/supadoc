<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Reference\ReferenceCategory;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\ReferenceDataService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists — onboard a new specialist from the back office.
 * Staff-scoped, gated on `specialists.manage`. Name + specialty are required
 * (the specialty must be an active item of the `specialty` reference list —
 * else 422 "Choose a specialty from the list" — and is saved in the list's
 * spelling); everything else is optional and can be edited later (by the
 * operator here, or by the doctor via their own profile). The response echoes the private array so
 * the operator can confirm the created record, including its new id to link a
 * doctor login to. The specialist starts in onboarding: unlisted and unbookable
 * until they are invited, complete their profile and an admin approves them.
 * `verified` is ignored (it follows approval). The creation is audited.
 */
final class CreateSpecialistAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly AuditLogger $audit,
        private readonly ReferenceDataService $reference,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $body      = (array) $request->getParsedBody();
        $name      = trim((string) ($body['name'] ?? ''));
        $specialty = trim((string) ($body['specialty'] ?? ''));

        $errors = [];
        if ($name === '') {
            $errors['name'] = 'Name is required';
        }
        if ($specialty === '') {
            $errors['specialty'] = 'Speciality is required';
        } else {
            // Only an active specialty of the reference list, in its spelling.
            $choice = $this->reference->resolveChoice(ReferenceCategory::SPECIALTY, $specialty);
            if ($choice === null) {
                $errors['specialty'] = 'Choose a specialty from the list';
            } else {
                $specialty = $choice;
            }
        }

        $email = trim((string) ($body['email'] ?? ''));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $errors['email'] = 'Enter a valid email address';
        }

        $fee = $body['consultation_fee'] ?? null;
        if ($fee !== null && $fee !== '' && (!is_numeric($fee) || (float) $fee < 0)) {
            $errors['consultation_fee'] = 'Enter a non-negative amount';
        }

        // Photos are uploaded once the record exists (POST /specialists/{id}/photo),
        // never linked: an empty value is fine, anything else is refused.
        $photo = trim((string) ($body['photo_url'] ?? ''));
        if ($photo !== '') {
            $errors['photo_url'] = 'Upload the photo after creating the specialist — links are not accepted';
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $specialist = new Specialist($name, $specialty);
        if ($email !== '') {
            $specialist->setEmail($email);
        }
        if ($fee !== null && $fee !== '') {
            $specialist->setConsultationFee(number_format((float) $fee, 2, '.', ''));
        }
        if (array_key_exists('bio', $body)) {
            $specialist->setBio(trim((string) $body['bio']));
        }
        if (array_key_exists('qualifications', $body)) {
            $specialist->setQualifications(trim((string) $body['qualifications']));
        }
        if (array_key_exists('languages', $body)) {
            $specialist->setLanguages(trim((string) $body['languages']));
        }
        if (array_key_exists('location', $body)) {
            $location = trim((string) $body['location']);
            $specialist->setLocation($location !== '' ? $location : null);
            // Keep the country column in step with location for the directory filter.
            $specialist->setCountry($location);
        }
        if (array_key_exists('years_experience', $body)) {
            $years = $body['years_experience'];
            if (is_numeric($years) && (int) $years >= 0) {
                $specialist->setYearsExperience((int) $years);
            }
        }
        if (array_key_exists('gender', $body)) {
            $gender = strtolower(trim((string) $body['gender']));
            if (in_array($gender, ['male', 'female'], true)) {
                $specialist->setGender($gender);
            }
        }
        if (array_key_exists('available', $body)) {
            $specialist->setAvailable((bool) $body['available']);
        }
        // `verified` follows approval now; it is no longer set here.

        $this->specialists->save($specialist);
        $this->auditReview($request, $this->users, $this->audit, 'specialist.created', $specialist, [
            'specialty' => $specialist->getSpecialty(),
            'email'     => $specialist->getEmail(),
        ]);

        // A new specialist starts in onboarding (unlisted) with no login yet —
        // the operator invites them next.
        return $this->created(
            $response,
            $specialist->toPrivateArray() + $specialist->toReviewArray() + ['login' => null],
            'Specialist created',
        );
    }
}
