<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Infrastructure\Persistence\ClockRepair;
use App\Infrastructure\Service\ApiResponse;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Pauses scheduling writes (503 `scheduling_paused`, Retry-After) while the
 * clock repair (prod-migrate step 13, {@see ClockRepair}) is pending for this
 * database and process zone: between the PHP reload of the clock-fix release
 * and the repair, stored times are partly on the wrong clock, so no conflict
 * check may run against them. Attached to every route that writes a scheduled
 * time or an availability slot (config/routes.php); cancelling and the
 * doctor's proposal withdrawal stay open (they are the step's remedies).
 *
 * `CLOCK_REPAIR_GATE=off` in .env is the documented emergency override — only
 * while /health/ready shows "marker":true (DEPLOY.md "One-time: the clock fix").
 * When the check itself fails the request goes through: the action meets the
 * same database and answers for itself.
 */
final class ClockRepairGateMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    public const MESSAGE = 'Scheduling is paused for a few minutes while we finish an update. Please try again shortly.';

    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        if (strtolower(trim((string) ($_ENV['CLOCK_REPAIR_GATE'] ?? 'on'))) !== 'off') {
            try {
                $pending = ClockRepair::isPending($this->em->getConnection());
            } catch (\Throwable $e) {
                error_log('[clock-repair] gate check failed: ' . $e::class);
                $pending = false; // the action meets the same database and answers for itself
            }
            if ($pending) {
                return $this->error(new Response(), self::MESSAGE, 503, ['scheduling' => self::MESSAGE, 'code' => 'scheduling_paused'])
                    ->withHeader('Retry-After', '120');
            }
        }

        return $handler->handle($request);
    }
}
