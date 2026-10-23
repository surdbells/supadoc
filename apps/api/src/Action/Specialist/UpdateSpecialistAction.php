<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\ReferenceItem;
use App\Domain\Entity\Specialist;
use App\Domain\Reference\ReferenceCategory;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\ReferenceDataService;
use App\Infrastructure\Storage\ProfilePhotoStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/specialists/{id} — back-office edit of a specialist's contact,
 * booking and public-profile fields: `email` (drives confirmation + join-link
 * delivery), consultation_fee, photo_url, available, bio, location, country,
 * languages, years_experience, gender, offers_in_person, expertise.
 * `photo_url` only clears the photo ('' or null — the stored file is deleted
 * when it is this doctor's own upload) or re-sends the current value (a
 * no-op); anything else is a 422 — new photos go through
 * POST /specialists/{id}/photo.
 * Staff-scoped, gated on `specialists.manage`. Only the keys present in the
 * body change, and every change is audited with its before/after values.
 *
 * The identity fields (name, specialty, MDCN number, qualifications,
 * certifications) are not edited here — the doctor changes them, through a
 * review once approved — except `specialty` while the doctor is still
 * onboarding (an active item of the specialty reference list, else 422
 * "Choose a specialty from the list"; once approved a different value is a
 * 422, and re-sending the current one is a no-op). `verified` is no longer a toggle: it follows approval
 * (sent, it is ignored).
 *
 * The email is normally kept out of Specialist::toArray() (server-side only),
 * but this staff response echoes it back so the operator can confirm the save.
 */
final class UpdateSpecialistAction
{
    use ApiResponse;
    use AuditsSpecialistReview;

    public function __construct(
        private readonly SpecialistRepository $specialists,
        private readonly UserRepository $users,
        private readonly AuditLogger $audit,
        private readonly ReferenceDataService $reference,
        private readonly ProfilePhotoStore $photos,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        // findOrFail throws → 404 for an unknown id.
        /** @var Specialist $specialist */
        $specialist = $this->specialists->findOrFail((string) $args['id']);
        $body       = (array) $request->getParsedBody();
        $before     = self::editable($specialist);

        $errors = [];

        if (array_key_exists('email', $body)) {
            $email = trim((string) $body['email']);
            if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $errors['email'] = 'Enter a valid email address';
            } else {
                // An empty string clears the email (nullable column).
                $specialist->setEmail($email !== '' ? $email : null);
            }
        }

        if (array_key_exists('consultation_fee', $body)) {
            $fee = $body['consultation_fee'];
            if (!is_numeric($fee) || (float) $fee < 0) {
                $errors['consultation_fee'] = 'Enter a non-negative amount';
            } else {
                $specialist->setConsultationFee(number_format((float) $fee, 2, '.', ''));
            }
        }

        // The photo this request clears (its file is deleted after the save
        // when it is this doctor's own upload).
        $clearedPhoto = null;
        if (array_key_exists('photo_url', $body)) {
            $raw   = $body['photo_url'];
            $photo = $raw === null || is_scalar($raw) ? trim((string) $raw) : null;
            // Photos are uploaded (POST /specialists/{id}/photo), never linked:
            // only clearing it ('' / null) or re-sending the current value (a
            // no-op) is accepted — no external URL, no /uploads path, not even
            // an earlier upload of this doctor (its file is gone).
            $current    = $specialist->getPhotoUrl();
            $photoError = $photo === null
                ? 'Upload a photo instead — links are not accepted'
                : ProfilePhotoStore::staffPhotoUrlError($photo, $current);
            if ($photoError !== null) {
                $errors['photo_url'] = $photoError;
            } elseif ($photo === '' && $current !== null) {
                $specialist->setPhotoUrl(null);
                $clearedPhoto = $current;
            }
        }

        if (array_key_exists('available', $body)) {
            $specialist->setAvailable((bool) $body['available']);
        }

        if (array_key_exists('bio', $body)) {
            $bio = trim((string) $body['bio']);
            if (mb_strlen($bio) > 5000) {
                $errors['bio'] = 'Keep the bio under 5000 characters';
            } else {
                $specialist->setBio($bio);
            }
        }

        if (array_key_exists('location', $body)) {
            $location = trim((string) $body['location']);
            if (mb_strlen($location) > 200) {
                $errors['location'] = 'Keep the location under 200 characters';
            } else {
                $specialist->setLocation($location !== '' ? $location : null);
            }
        }

        if (array_key_exists('country', $body)) {
            $country = trim((string) $body['country']);
            if (mb_strlen($country) > 120) {
                $errors['country'] = 'Keep the country under 120 characters';
            } else {
                $specialist->setCountry($country);
            }
        }

        if (array_key_exists('languages', $body)) {
            $languages = trim((string) $body['languages']);
            if (mb_strlen($languages) > 200) {
                $errors['languages'] = 'Keep the languages under 200 characters';
            } else {
                $specialist->setLanguages($languages);
            }
        }

        if (array_key_exists('years_experience', $body)) {
            $years = $body['years_experience'];
            if ($years === null || $years === '') {
                $specialist->setYearsExperience(null);
            } elseif (!is_numeric($years) || (int) $years < 0 || (int) $years > 80) {
                $errors['years_experience'] = 'Enter a whole number of years (0–80)';
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

        if (array_key_exists('expertise', $body)) {
            $specialist->setExpertise(is_array($body['expertise']) ? array_slice($body['expertise'], 0, 30) : []);
        }

        // Specialty: set here only while the doctor is onboarding — an active
        // item of the specialty reference list, saved in the list's spelling.
        // Once approved it changes only through the doctor's change request.
        // Re-sending the current value (any case) is a no-op, so a specialty
        // since switched off in the list is kept.
        if (array_key_exists('specialty', $body)) {
            $wanted = is_scalar($body['specialty']) ? trim((string) $body['specialty']) : '';
            if ($wanted === '') {
                $errors['specialty'] = 'Speciality is required';
            } elseif (ReferenceItem::keyOf($wanted) !== ReferenceItem::keyOf($specialist->getSpecialty())) {
                if ($specialist->identityLocked()) {
                    $errors['specialty'] = "An approved doctor's specialty changes only through their own change request";
                } else {
                    $choice = $this->reference->resolveChoice(ReferenceCategory::SPECIALTY, $wanted);
                    if ($choice === null) {
                        $errors['specialty'] = 'Choose a specialty from the list';
                    } else {
                        $specialist->setSpecialty($choice);
                    }
                }
            }
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->specialists->save($specialist);
        if ($clearedPhoto !== null && ProfilePhotoStore::isOwnSpecialistUpload($clearedPhoto, $specialist->getId())) {
            $this->photos->deleteLocal($clearedPhoto);
        }

        $after   = self::editable($specialist);
        $changed = array_keys(array_filter($after, static fn (mixed $value, string $key): bool => $value !== $before[$key], ARRAY_FILTER_USE_BOTH));
        if ($changed !== []) {
            $this->auditReview($request, $this->users, $this->audit, 'specialist.updated', $specialist, [
                'before' => array_intersect_key($before, array_flip($changed)),
                'after'  => array_intersect_key($after, array_flip($changed)),
            ]);
        }

        return $this->success(
            $response,
            $specialist->toArray() + ['email' => $specialist->getEmail()] + $specialist->toReviewArray(),
            'Specialist updated',
        );
    }

    /**
     * The fields this endpoint edits, for the before/after audit.
     *
     * @return array<string,mixed>
     */
    private static function editable(Specialist $s): array
    {
        $a = $s->toArray();

        return [
            'email'            => $s->getEmail(),
            'consultation_fee' => $a['consultation_fee'],
            'photo_url'        => $a['photo_url'],
            'available'        => $a['available'],
            'bio'              => $a['bio'],
            'location'         => $a['location'],
            'country'          => $a['country'],
            'languages'        => $a['languages'],
            'years_experience' => $a['years_experience'],
            'gender'           => $a['gender'],
            'offers_in_person' => $a['offers_in_person'],
            'expertise'        => $a['expertise'],
            'specialty'        => $s->getSpecialty(),
        ];
    }
}
