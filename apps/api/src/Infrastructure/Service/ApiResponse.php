<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use Psr\Http\Message\ResponseInterface;

/**
 * One envelope for the entire API. Mixed into Actions.
 *
 *   { "status": "success", "message": "...", "data": {...} }
 *   { "status": "success", "message": "...", "data": [...],
 *     "meta": { "total": 0, "page": 1, "per_page": 20, "total_pages": 0 } }
 *   { "status": "error", "message": "...", "errors": { "field": "..." } }
 *
 * A single shape means the frontend gets one response handler, one error path,
 * one pagination reader (see ARCHITECTURE §7).
 */
trait ApiResponse
{
    protected function success(
        ResponseInterface $response,
        mixed $data = null,
        string $message = 'OK',
        int $status = 200,
    ): ResponseInterface {
        return $this->json($response, [
            'status'  => 'success',
            'message' => $message,
            'data'    => $data,
        ], $status);
    }

    protected function created(
        ResponseInterface $response,
        mixed $data = null,
        string $message = 'Created',
    ): ResponseInterface {
        return $this->success($response, $data, $message, 201);
    }

    protected function paginated(
        ResponseInterface $response,
        array $items,
        int $total,
        int $page,
        int $perPage,
        string $message = 'OK',
    ): ResponseInterface {
        return $this->json($response, [
            'status'  => 'success',
            'message' => $message,
            'data'    => $items,
            'meta'    => [
                'total'       => $total,
                'page'        => $page,
                'per_page'    => $perPage,
                'total_pages' => $perPage > 0 ? (int) ceil($total / $perPage) : 0,
            ],
        ], 200);
    }

    protected function error(
        ResponseInterface $response,
        string $message,
        int $status = 400,
        array $errors = [],
    ): ResponseInterface {
        $payload = ['status' => 'error', 'message' => $message];
        if ($errors !== []) {
            $payload['errors'] = $errors;
        }

        return $this->json($response, $payload, $status);
    }

    protected function json(
        ResponseInterface $response,
        array $payload,
        int $status = 200,
    ): ResponseInterface {
        $response->getBody()->write(
            json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        );

        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withStatus($status);
    }

    /**
     * Clamps per_page to 1..100 and converts sort_by from snake_case to
     * camelCase so `?sort_by=created_at` maps onto the DQL field `createdAt`.
     * Without this every sort param 500s (see ARCHITECTURE §7).
     *
     * @return array{page:int, per_page:int, offset:int, sort_by:string, sort_dir:string}
     */
    protected function getPaginationParams(array $query): array
    {
        $page    = max(1, (int) ($query['page'] ?? 1));
        $perPage = (int) ($query['per_page'] ?? 20);
        $perPage = max(1, min(100, $perPage));

        $sortByRaw = (string) ($query['sort_by'] ?? 'created_at');
        $sortBy    = lcfirst(str_replace(' ', '', ucwords(str_replace('_', ' ', $sortByRaw))));

        $sortDir = strtolower((string) ($query['sort_dir'] ?? 'desc'));
        $sortDir = in_array($sortDir, ['asc', 'desc'], true) ? $sortDir : 'desc';

        return [
            'page'     => $page,
            'per_page' => $perPage,
            'offset'   => ($page - 1) * $perPage,
            'sort_by'  => $sortBy,
            'sort_dir' => $sortDir,
        ];
    }
}
