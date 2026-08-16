<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/appointment-documents (multipart, field `document`) — upload
 * an optional supporting image for a booking and return its URL. Validated as a
 * real image and saved under a server-generated name (same hardening as avatars)
 * so nothing executable can land in the web root.
 */
final class UploadAppointmentDocumentAction
{
    use ApiResponse;

    private const MAX_BYTES = 5 * 1024 * 1024;

    /** @var array<int,string> IMAGETYPE_* => extension */
    private const ALLOWED = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
    ];

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $file       = $request->getUploadedFiles()['document'] ?? null;

        if (!$file instanceof UploadedFileInterface || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->error($response, 'Validation failed', 422, ['document' => 'No file uploaded']);
        }
        if (($file->getSize() ?? 0) > self::MAX_BYTES) {
            return $this->error($response, 'Validation failed', 422, ['document' => 'File must be 5MB or smaller']);
        }

        $tmpPath = $file->getStream()->getMetadata('uri');
        $info    = is_string($tmpPath) ? @getimagesize($tmpPath) : false;
        $ext     = is_array($info) ? (self::ALLOWED[$info[2]] ?? null) : null;
        if ($ext === null) {
            return $this->error($response, 'Validation failed', 422, ['document' => 'Only JPG or PNG images are allowed']);
        }

        $dir = dirname(__DIR__, 3) . '/public/uploads/appointment-docs';
        if (!is_dir($dir)) {
            @mkdir($dir, 0o775, true);
        }

        $filename = $customerId . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
        $file->moveTo($dir . '/' . $filename);

        return $this->success(
            $response,
            ['url' => '/uploads/appointment-docs/' . $filename],
            'Uploaded',
        );
    }
}
