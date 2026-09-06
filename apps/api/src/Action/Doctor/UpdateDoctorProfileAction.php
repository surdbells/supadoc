<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/doctor/profile — a doctor edits their OWN profile: contact email,
 * photo, location, spoken languages, years of experience, gender, in-person
 * availability, the on/off booking toggle, and weekly availability hours. Only
 * the keys present in the body change. Fee and verified status stay back-office
 * controlled and are ignored here.
 */
final class UpdateDoctorProfileAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
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

        $body   = (array) $request->getParsedBody();
        $errors = [];

        if (array_key_exists('email', $body)) {
            $email = trim((string) $body['email']);
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $errors['email'] = 'Enter a valid email address';
            } else {
                $specialist->setEmail($email !== '' ? $email : null);
            }
        }

        if (array_key_exists('photo_url', $body)) {
            $photo = trim((string) $body['photo_url']);
            if ($photo !== '' && !preg_match('#^(https?://|/uploads/)#', $photo)) {
                $errors['photo_url'] = 'Enter a full URL or an /uploads path';
            } else {
                $specialist->setPhotoUrl($photo !== '' ? $photo : null);
            }
        }

        if (array_key_exists('location', $body)) {
            $location = trim((string) $body['location']);
            $specialist->setLocation($location !== '' ? $location : null);
        }

        if (array_key_exists('languages', $body)) {
            $specialist->setLanguages(trim((string) $body['languages']));
        }

        if (array_key_exists('years_experience', $body)) {
            $years = $body['years_experience'];
            if ($years === null || $years === '') {
                $specialist->setYearsExperience(null);
            } elseif (!is_numeric($years) || (int) $years < 0) {
                $errors['years_experience'] = 'Enter a non-negative whole number';
            } else {
                $specialist->setYearsExperience((int) $years);
            }
        }

        if (array_key_exists('gender', $body)) {
            $gender = strtolower(trim((string) $body['gender']));
            if ($gender !== '' && !in_array($gender, ['male', 'female'], true)) {
                $errors['gender'] = 'Choose male or female';
            } else {
                $specialist->setGender($gender !== '' ? $gender : null);
            }
        }

        if (array_key_exists('offers_in_person', $body)) {
            $specialist->setOffersInPerson((bool) $body['offers_in_person']);
        }

        if (array_key_exists('available', $body)) {
            $specialist->setAvailable((bool) $body['available']);
        }

        if (array_key_exists('weekly_hours', $body)) {
            $hours = $body['weekly_hours'];
            $specialist->setWeeklyHours(is_array($hours) && $hours !== [] ? $hours : null);
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->specialists->save($specialist);

        return $this->success(
            $response,
            $specialist->toArray() + ['email' => $specialist->getEmail()],
            'Profile updated',
        );
    }
}
