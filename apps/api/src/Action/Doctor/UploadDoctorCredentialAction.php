<?php

declare(strict_types=1);

namespace App\Action\Doctor;

use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\DoctorCredentialService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/doctor/credentials (multipart) — the doctor uploads a licensing
 * document: `file` (PDF, JPG or PNG, ≤ 10MB, checked by content), `type` —
 * by where the doctor is licensed (SpecialistCredential::uploadableTypes):
 * mdcn_full_registration | annual_practising_licence, or abroad
 * good_standing_certificate | foreign_practising_licence; plus
 * specialist_certificate | indemnity_certificate — `number` and `expires_at`
 * (YYYY-MM-DD; both required for a licence, an expiry for indemnity, never
 * already past), optional `issued_at`.
 * Stored encrypted; replaces an older one of the same kind still waiting.
 * A live doctor's upload notifies the reviewers. 201 with the document; 422
 * per field; 409 when secure storage isn't set up.
 */
final class UploadDoctorCredentialAction
{
    use ApiResponse;
    use ResolvesDoctorSpecialist;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly DoctorCredentialService $service,
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

        // Multipart text fields: the parsed body is populated from $_POST by the
        // request factory; fall back to $_POST directly in case it wasn't.
        $body = $request->getParsedBody();
        if (!is_array($body) || $body === []) {
            $body = $_POST;
        }
        $file = $request->getUploadedFiles()['file'] ?? null;
        if (!$file instanceof UploadedFileInterface) {
            return $this->error($response, 'Attach the document', 422, ['file' => 'Attach a PDF, JPG or PNG file']);
        }

        // Throws ValidationException (→ 422) per field, DomainException (→ 409) without storage.
        $credential = $this->service->upload($specialist, $file, $body, (string) $request->getAttribute('user_id'));

        return $this->created($response, $credential->toArray(), 'Document uploaded — our team will verify it');
    }
}
