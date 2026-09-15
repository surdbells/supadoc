<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * POST /api/portal/appointment-documents (multipart, field `document`) — upload a
 * supporting file for a booking and return its URL. Accepts PDFs and images
 * (patients typically attach lab reports/scans). Validated by content and saved
 * under a server-generated name with a whitelisted extension, so nothing
 * executable can land in the web root.
 */
final class UploadAppointmentDocumentAction
{
    use ApiResponse;

    private const MAX_BYTES = 10 * 1024 * 1024;

    /** @var array<int,string> IMAGETYPE_* => extension */
    private const IMAGE_TYPES = [
        IMAGETYPE_JPEG => 'jpg',
        IMAGETYPE_PNG  => 'png',
        IMAGETYPE_WEBP => 'webp',
    ];

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $file       = $request->getUploadedFiles()['document'] ?? null;

        if (!$file instanceof UploadedFileInterface || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->error($response, 'No file uploaded', 422, ['document' => 'Attach a file to upload']);
        }
        if (($file->getSize() ?? 0) > self::MAX_BYTES) {
            return $this->error($response, 'File is too large', 422, ['document' => 'File must be 10MB or smaller']);
        }

        $tmpPath = $file->getStream()->getMetadata('uri');
        $tmpPath = is_string($tmpPath) ? $tmpPath : '';
        $ext     = $this->resolveExtension($tmpPath);
        if ($ext === null) {
            return $this->error($response, 'Unsupported file type', 422, [
                'document' => 'Upload a PDF, JPG, PNG or WEBP file',
            ]);
        }

        try {
            $dir = dirname(__DIR__, 3) . '/public/uploads/appointment-docs';
            if (!is_dir($dir) && !@mkdir($dir, 0o775, true) && !is_dir($dir)) {
                throw new \RuntimeException('upload directory is not writable');
            }

            $filename = $customerId . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
            $file->moveTo($dir . '/' . $filename);
        } catch (\Throwable $e) {
            error_log('[appointment-documents] upload failed: ' . $e->getMessage());

            return $this->error($response, 'Could not save the file. Please try again.', 500);
        }

        return $this->success(
            $response,
            ['url' => '/uploads/appointment-docs/' . $filename],
            'Uploaded',
        );
    }

    /** Canonical extension if the bytes are an accepted type, else null. */
    private function resolveExtension(string $tmpPath): ?string
    {
        if ($tmpPath === '' || !is_file($tmpPath)) {
            return null;
        }

        // PDF: "%PDF-" magic at the start.
        $fh = @fopen($tmpPath, 'rb');
        if ($fh !== false) {
            $head = (string) @fread($fh, 5);
            @fclose($fh);
            if ($head === '%PDF-') {
                return 'pdf';
            }
        }

        // Images: trust the decoded type, not the client's name.
        $info = @getimagesize($tmpPath);
        $type = is_array($info) ? ($info[2] ?? 0) : 0;

        return self::IMAGE_TYPES[$type] ?? null;
    }
}
