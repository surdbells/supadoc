<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/specialists — onboard a new specialist from the back office.
 * Staff-scoped, gated on `specialists.manage`. Name + specialty are required;
 * everything else is optional and can be edited later (by the operator here, or
 * by the doctor via their own profile). The response echoes the private array so
 * the operator can confirm the created record, including its new id to link a
 * doctor login to.
 */
final class CreateSpecialistAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $specialists)
    {
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
        }

        $email = trim((string) ($body['email'] ?? ''));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $errors['email'] = 'Enter a valid email address';
        }

        $fee = $body['consultation_fee'] ?? null;
        if ($fee !== null && $fee !== '' && (!is_numeric($fee) || (float) $fee < 0)) {
            $errors['consultation_fee'] = 'Enter a non-negative amount';
        }

        $photo      = trim((string) ($body['photo_url'] ?? ''));
        $validPhoto = $photo === ''
            || preg_match('#^https?://#', $photo) === 1
            || (str_starts_with($photo, '/uploads/') && !str_contains($photo, '..'));
        if (!$validPhoto) {
            $errors['photo_url'] = 'Enter a full URL or an /uploads path';
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
        if ($photo !== '') {
            $specialist->setPhotoUrl($photo);
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
        if (array_key_exists('verified', $body)) {
            $specialist->setVerified((bool) $body['verified']);
        }

        $this->specialists->save($specialist);

        return $this->created($response, $specialist->toPrivateArray(), 'Specialist created');
    }
}
