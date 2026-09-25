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

        if (array_key_exists('name', $body)) {
            $name = trim((string) $body['name']);
            if ($name === '') {
                $errors['name'] = 'Name cannot be empty';
            } else {
                $specialist->setName($name);
            }
        }

        if (array_key_exists('specialty', $body)) {
            $specialty = trim((string) $body['specialty']);
            if ($specialty === '') {
                $errors['specialty'] = 'Speciality cannot be empty';
            } else {
                $specialist->setSpecialty($specialty);
            }
        }

        if (array_key_exists('phone', $body)) {
            $specialist->setPhone(trim((string) $body['phone']));
        }

        if (array_key_exists('country', $body)) {
            $specialist->setCountry(trim((string) $body['country']));
        }

        if (array_key_exists('date_of_birth', $body)) {
            $dob = trim((string) $body['date_of_birth']);
            if ($dob === '') {
                $specialist->setDateOfBirth(null);
            } else {
                $parsed = \DateTimeImmutable::createFromFormat('!Y-m-d', $dob);
                $valid  = $parsed !== false && $parsed->format('Y-m-d') === $dob;
                if (!$valid || $parsed > new \DateTimeImmutable('today')) {
                    $errors['date_of_birth'] = 'Enter a valid past date (YYYY-MM-DD)';
                } else {
                    $specialist->setDateOfBirth($parsed);
                }
            }
        }

        if (array_key_exists('expertise', $body)) {
            $specialist->setExpertise(is_array($body['expertise']) ? $body['expertise'] : []);
        }

        if (array_key_exists('qualification_entries', $body)) {
            $specialist->setQualificationEntries(
                $this->cleanEntries($body['qualification_entries'], ['title', 'institution', 'year']),
            );
        }

        if (array_key_exists('certifications', $body)) {
            $specialist->setCertifications(
                $this->cleanEntries($body['certifications'], ['name', 'body', 'year']),
            );
        }

        if (array_key_exists('slot_minutes', $body)) {
            $minutes = (int) $body['slot_minutes'];
            if (!in_array($minutes, [15, 30, 45, 60], true)) {
                $errors['slot_minutes'] = 'Choose 15, 30, 45 or 60 minutes';
            } else {
                $specialist->setSlotMinutes($minutes);
            }
        }

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
            // Accept a full URL or a safe /uploads path — never a traversal
            // string ('..'), which would let the delete-avatar sink reach files
            // outside the web root.
            $validPhoto = $photo === ''
                || preg_match('#^https?://#', $photo) === 1
                || (str_starts_with($photo, '/uploads/') && !str_contains($photo, '..'));
            if (!$validPhoto) {
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

        if (array_key_exists('bio', $body)) {
            $specialist->setBio(trim((string) $body['bio']));
        }

        if (array_key_exists('qualifications', $body)) {
            $specialist->setQualifications(trim((string) $body['qualifications']));
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->specialists->save($specialist);

        return $this->success($response, $specialist->toPrivateArray(), 'Profile updated');
    }

    /**
     * Normalise a repeatable-entry array into rows with exactly $keys (all strings),
     * dropping rows where every field is blank.
     *
     * @param list<string> $keys
     * @return list<array<string,string>>
     */
    private function cleanEntries(mixed $raw, array $keys): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $out = [];
        foreach ($raw as $row) {
            if (!is_array($row)) {
                continue;
            }
            $entry = [];
            $any   = false;
            foreach ($keys as $k) {
                $value    = trim((string) ($row[$k] ?? ''));
                $entry[$k] = $value;
                $any      = $any || $value !== '';
            }
            if ($any) {
                $out[] = $entry;
            }
        }

        return $out;
    }
}
