<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Entity\Specialist;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\AuditLogger;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/specialists/{id} — back-office edit of a specialist's contact,
 * booking and public-profile fields: `email` (drives confirmation + join-link
 * delivery), consultation_fee, photo_url, available, bio, location, country,
 * languages, years_experience, gender, offers_in_person, expertise.
 * Staff-scoped, gated on `specialists.manage`. Only the keys present in the
 * body change, and every change is audited with its before/after values.
 *
 * The identity fields (name, specialty, MDCN number, qualifications,
 * certifications) are not edited here — the doctor changes them, through a
 * review once approved. `verified` is no longer a toggle: it follows approval
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

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->specialists->save($specialist);

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
        ];
    }
}
