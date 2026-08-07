<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** DELETE /api/portal/me/avatar — remove the profile photo. */
final class DeleteMyAvatarAction
{
    use ApiResponse;

    public function __construct(private readonly PatientRepository $patients)
    {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');

        /** @var Patient $patient */
        $patient = $this->patients->findOrFail($customerId);

        UploadMyAvatarAction::deleteLocalAvatar($patient->getAvatarUrl());
        $patient->setAvatarUrl(null);
        $this->patients->save($patient);

        return $this->success($response, $patient->toArray(), 'Photo removed');
    }
}
