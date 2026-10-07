<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Domain\Exception\ValidationException;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Prescription\SignatureStore;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * The signed-in doctor's saved signature picture (GVM-RX-02 AC13) — only the
 * doctor can see, add, change or remove it, and each change is audited:
 *
 *   GET    /api/doctor/signature  → {has_signature, image: data URL|null}
 *   POST   /api/doctor/signature  ← multipart `signature` (PNG/JPG < 500 KB)
 *                                   or JSON {image: "data:image/png;base64,…"}
 *   DELETE /api/doctor/signature
 */
final class DoctorSignatureAction
{
    use DoctorPrescriptionSupport;

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly PrescriptionService $service,
        private readonly SignatureStore $signatures,
    ) {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        [$doctor, $denied] = $this->doctor($request, $response, $this->users, $this->specialists);
        if ($doctor === null) {
            return $denied;
        }

        switch ($request->getMethod()) {
            case 'POST':
                $file = $request->getUploadedFiles()['signature'] ?? null;
                if ($file instanceof UploadedFileInterface && $file->getError() === UPLOAD_ERR_OK) {
                    if (($file->getSize() ?? 0) > SignatureStore::MAX_BYTES) {
                        throw new ValidationException(['signature' => sprintf(
                            'This picture is %s KB. The limit is 500 KB.',
                            number_format(($file->getSize() ?? 0) / 1024),
                        )]);
                    }
                    $bytes = (string) $file->getStream();
                } else {
                    $body  = (array) ($request->getParsedBody() ?? []);
                    $image = (string) ($body['image'] ?? '');
                    if ($image === '') {
                        throw new ValidationException(['signature' => 'Choose a PNG or JPG picture of your signature']);
                    }
                    $bytes = $this->dataUrlBytes($image);
                }
                $this->service->saveSignature($doctor, $bytes);
                $message = 'Signature saved';
                break;
            case 'DELETE':
                $this->service->removeSignature($doctor);
                $message = 'Signature removed';
                break;
            default:
                $message = 'OK';
        }

        $png = $this->service->signatureImage($doctor);

        return $this->noStore($this->success($response, [
            'has_signature' => $png !== null,
            'image'         => $png !== null ? 'data:image/png;base64,' . base64_encode($png) : null,
        ], $message));
    }

    private function dataUrlBytes(string $dataUrl): string
    {
        if (preg_match('#^data:image/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$#', trim($dataUrl), $m) !== 1) {
            throw new ValidationException(['signature' => 'Upload a PNG or JPG picture of your signature']);
        }
        $bytes = base64_decode(preg_replace('/\s+/', '', $m[2]) ?? '', true);
        if ($bytes === false) {
            throw new ValidationException(['signature' => 'Upload a PNG or JPG picture of your signature']);
        }

        return $bytes;
    }
}
