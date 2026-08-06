<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Per-route permission check. Runs after an auth middleware has published
 * `user_roles` / `user_permissions`.
 *
 *   new RbacMiddleware('loans.view')                       // single
 *   new RbacMiddleware(['loans.create', 'loans.originate']) // ANY (default)
 *   new RbacMiddleware(['loans.delete', 'admin'], true)     // ALL
 *
 * Getting the ANY/ALL default backwards locks everyone out. `super_admin`
 * bypasses every check (see ARCHITECTURE §8).
 */
final class RbacMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    /** @var list<string> */
    private readonly array $required;

    /** @param string|list<string> $permissions */
    public function __construct(
        string|array $permissions,
        private readonly bool $requireAll = false,
    ) {
        $this->required = array_values((array) $permissions);
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        /** @var list<string> $roles */
        $roles = (array) $request->getAttribute('user_roles', []);
        if (in_array('super_admin', $roles, true)) {
            return $handler->handle($request);
        }

        /** @var list<string> $held */
        $held    = (array) $request->getAttribute('user_permissions', []);
        $matches = count(array_intersect($this->required, $held));

        $granted = $this->requireAll
            ? $matches === count($this->required) // ALL
            : $matches > 0;                       // ANY (default)

        if (!$granted) {
            return $this->error(new Response(), 'Insufficient permissions', 403);
        }

        return $handler->handle($request);
    }
}
