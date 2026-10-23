<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Doctor\DoctorStanding;
use App\Domain\Entity\ReferenceItem;
use App\Domain\Entity\Specialist;
use App\Domain\Reference\ReferenceCategory;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorOnboardingService;
use App\Infrastructure\Service\ReferenceDataService;
use App\Infrastructure\Storage\ProfilePhotoStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/doctor/profile — a doctor edits their OWN profile: contact email,
 * photo, location, spoken languages, years of experience, gender, in-person
 * availability, the on/off booking toggle, and weekly availability hours. Only
 * the keys present in the body change. Fee and verified status stay back-office
 * controlled and are ignored here.
 *
 * Once approved, the identity fields ({@see Specialist::LOCKED_FIELDS}: name,
 * specialty, MDCN number, qualifications, qualification entries,
 * certifications) don't change here: a value that differs waits in
 * `pending_changes` until a reviewer approves it (reviewers are notified; the
 * request is audited), and one equal to the current value takes back an
 * earlier request for it. `specialty` must be an active item of the specialty
 * reference list (422 "Choose a specialty from the list"), saved in the
 * list's spelling — or the doctor's current / already-requested one, kept as
 * it is even if the list has since switched it off. Everything else saves at
 * once — except that a suspended doctor may not change their availability (`weekly_hours`,
 * `slot_minutes`, `available`: 403, `errors.code` doctor_suspended).
 */
final class UpdateDoctorProfileAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly DoctorOnboardingService $onboarding,
        private readonly ReferenceDataService $reference,
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

        $body = (array) $request->getParsedBody();
        // A suspended doctor keeps their profile, but not their availability.
        $refused = DoctorStanding::profileEditProblem($specialist, $body);
        if ($refused !== null) {
            return $this->error($response, $refused[1], 403, ['standing' => $refused[1], 'code' => $refused[0]]);
        }

        $errors = [];
        // Identity fields, validated and normalised like the setters do —
        // applied at once while onboarding, staged for review once approved.
        $locked = [];

        if (array_key_exists('name', $body)) {
            $name = trim((string) $body['name']);
            if ($name === '') {
                $errors['name'] = 'Name cannot be empty';
            } elseif (mb_strlen($name) > 200) {
                $errors['name'] = 'Keep the name under 200 characters';
            } else {
                $locked['name'] = $name;
            }
        }

        if (array_key_exists('specialty', $body)) {
            $specialty = is_scalar($body['specialty']) ? trim((string) $body['specialty']) : '';
            if ($specialty === '') {
                $errors['specialty'] = 'Speciality cannot be empty';
            } elseif (mb_strlen($specialty) > 120) {
                $errors['specialty'] = 'Keep the speciality under 120 characters';
            } else {
                // An active specialty of the reference list (saved in its
                // spelling) — or the one they already have / already asked
                // for, kept as it is even if the list has since switched it off.
                $kept = array_filter(
                    [$specialist->getSpecialty(), $specialist->getPendingFields()['specialty'] ?? null],
                    static fn (mixed $v): bool => is_string($v) && ReferenceItem::keyOf($v) === ReferenceItem::keyOf($specialty),
                );
                $choice = $kept !== []
                    ? (string) reset($kept)
                    : $this->reference->resolveChoice(ReferenceCategory::SPECIALTY, $specialty);
                if ($choice === null) {
                    $errors['specialty'] = 'Choose a specialty from the list';
                } else {
                    $locked['specialty'] = $choice;
                }
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
            $locked['qualification_entries'] = $this->cleanEntries($body['qualification_entries'], ['title', 'institution', 'year']);
        }

        if (array_key_exists('certifications', $body)) {
            $locked['certifications'] = $this->cleanEntries($body['certifications'], ['name', 'body', 'year']);
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
            // Photos come only from the avatar upload (POST /doctor/avatar): this
            // field may clear the photo or repeat the current one — never point
            // it at an outside link or another file.
            $photo      = trim((string) ($body['photo_url'] ?? ''));
            $photoError = ProfilePhotoStore::staffPhotoUrlError($photo, $specialist->getPhotoUrl());
            if ($photoError !== null) {
                $errors['photo_url'] = $photoError;
            } elseif ($photo === '') {
                $specialist->setPhotoUrl(null);
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
            $qualifications = trim((string) $body['qualifications']);
            if (mb_strlen($qualifications) > 300) {
                $errors['qualifications'] = 'Keep your qualifications under 300 characters';
            } else {
                $locked['qualifications'] = $qualifications !== '' ? $qualifications : null;
            }
        }

        // MDCN registration number — printed on prescriptions and shown to
        // pharmacists on the public check page, so keep it to a sane shape.
        if (array_key_exists('mdcn_number', $body)) {
            $mdcn = strtoupper(trim((string) $body['mdcn_number']));
            if ($mdcn !== '' && preg_match('/^[A-Z0-9\/\- ]{3,40}$/', $mdcn) !== 1) {
                $errors['mdcn_number'] = 'Enter your MDCN registration number (letters, numbers, / or -)';
            } else {
                $locked['mdcn_number'] = $mdcn !== '' ? $mdcn : null;
            }
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $staged = false;
        // Locked once they have practised here — or from the start for a doctor vetted through an application (D5).
        if ($specialist->identityLocked()) {
            $staged = $specialist->stageChanges($locked);
        } else {
            $specialist->applyLockedValues($locked);
        }

        $this->specialists->save($specialist);
        if ($staged) {
            $this->onboarding->changesSubmitted($specialist, (string) $request->getAttribute('user_id'));
        }

        return $this->success(
            $response,
            $specialist->toPrivateArray(),
            $staged ? 'Profile saved. Your changes to your name, specialty or credentials were sent for review.' : 'Profile updated',
        );
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
