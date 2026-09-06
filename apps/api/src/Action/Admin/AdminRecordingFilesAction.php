<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Recording;
use App\Domain\Repository\RecordingRepository;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\RecordingStorage;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/admin/recordings/{id}/files — playback/download URLs for a recording
 * (back-office monitoring). Resolves each stored file key to a short-lived URL
 * (null when storage isn't configured). Needs `monitoring.view`.
 */
final class AdminRecordingFilesAction
{
    use ApiResponse;

    public function __construct(
        private readonly RecordingRepository $recordings,
        private readonly RecordingStorage $storage,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
        array $args,
    ): ResponseInterface {
        $recording = $this->recordings->find((string) $args['id']);
        if (!$recording instanceof Recording) {
            return $this->error($response, 'Recording not found', 404);
        }

        $files = array_map(
            fn (string $key): array => [
                'key'  => $key,
                'name' => basename($key),
                'url'  => $this->storage->url($key),
            ],
            $recording->getFiles(),
        );

        return $this->success($response, [
            'configured' => $this->storage->isConfigured(),
            'recording'  => $recording->toArray(),
            'files'      => $files,
        ])->withHeader('Cache-Control', 'no-store');
    }
}
