<?php

declare(strict_types=1);

namespace App\Action\Specialist;

use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PATCH /api/specialists/{id} — back-office edit of a specialist's contact and
 * booking fields (its `email`, which drives confirmation + join-link delivery,
 * plus consultation_fee / availability / verified). Staff-scoped, gated on
 * `specialists.manage`. Only the keys present in the body change.
 *
 * The email is normally kept out of Specialist::toArray() (server-side only),
 * but this staff response echoes it back so the operator can confirm the save.
 */
final class UpdateSpecialistAction
{
    use ApiResponse;

    public function __construct(private readonly SpecialistRepository $specialists)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        // findOrFail throws → 404 for an unknown id.
        $specialist = $this->specialists->findOrFail((string) $args['id']);
        $body       = (array) $request->getParsedBody();

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

        if (array_key_exists('available', $body)) {
            $specialist->setAvailable((bool) $body['available']);
        }

        if (array_key_exists('verified', $body)) {
            $specialist->setVerified((bool) $body['verified']);
        }

        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $this->specialists->save($specialist);

        return $this->success(
            $response,
            $specialist->toArray() + ['email' => $specialist->getEmail()],
            'Specialist updated',
        );
    }
}
