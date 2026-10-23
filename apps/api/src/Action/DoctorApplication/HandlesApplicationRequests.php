<?php

declare(strict_types=1);

namespace App\Action\DoctorApplication;

use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Repository\UserRepository;
use App\Infrastructure\Middleware\ApplicantTokenMiddleware;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * Small request helpers shared by the doctor-application actions: the
 * applicant's application (published by ApplicantTokenMiddleware), the JSON or
 * multipart body, the signed-in reviewer, and streaming a document back
 * (inline, never cached, never sniffed).
 */
trait HandlesApplicationRequests
{
    private function applicant(ServerRequestInterface $request): DoctorApplication
    {
        $app = $request->getAttribute(ApplicantTokenMiddleware::ATTRIBUTE);
        if (!$app instanceof DoctorApplication) {
            throw new \LogicException('ApplicantTokenMiddleware must run before this action');
        }

        return $app;
    }

    /** @return array<string,mixed> */
    private function body(ServerRequestInterface $request): array
    {
        $body = $request->getParsedBody();

        return is_array($body) ? $body : [];
    }

    /** Multipart text fields (the parsed body, else $_POST) and the `file` part. @return array{0: array<string,mixed>, 1: ?UploadedFileInterface} */
    private function multipart(ServerRequestInterface $request): array
    {
        $body = $request->getParsedBody();
        if (!is_array($body) || $body === []) {
            $body = $_POST;
        }
        $file = $request->getUploadedFiles()['file'] ?? null;

        return [is_array($body) ? $body : [], $file instanceof UploadedFileInterface ? $file : null];
    }

    /** The signed-in reviewer as [user id, display name]. @return array{0:?string, 1:string} */
    private function reviewer(ServerRequestInterface $request, UserRepository $users): array
    {
        $id = (string) $request->getAttribute('user_id');
        try {
            $a    = $id !== '' ? ($users->find($id)?->toArray() ?? []) : [];
            $name = trim(((string) ($a['first_name'] ?? '')) . ' ' . ((string) ($a['last_name'] ?? '')));
        } catch (\Throwable) {
            $name = '';
        }

        return [$id !== '' ? $id : null, $name !== '' ? $name : 'Admin'];
    }

    private function streamDocument(ResponseInterface $response, DoctorApplicationDocument $doc, string $bytes): ResponseInterface
    {
        $safeName = preg_replace('/[^A-Za-z0-9._ -]/', '_', $doc->getOriginalName()) ?? 'document';
        $response->getBody()->write($bytes);

        return $response
            ->withHeader('Content-Type', $doc->getMime())
            ->withHeader('Content-Length', (string) strlen($bytes))
            ->withHeader('Content-Disposition', 'inline; filename="' . $safeName . '"')
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }
}
