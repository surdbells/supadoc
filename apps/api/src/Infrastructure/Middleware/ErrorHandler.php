<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Domain\Exception\AuthenticationException;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;
use Slim\Exception\HttpMethodNotAllowedException;
use Slim\Exception\HttpNotFoundException;
use Throwable;

/**
 * Default error handler. Two things that matter (see ARCHITECTURE §4):
 *   - it re-applies CORS headers, so a 500 doesn't reach the browser as an
 *     opaque CORS failure and send you debugging the wrong thing;
 *   - it reports only >= 500 to Sentry — 4xx are expected and pure noise.
 * Domain exceptions map to their HTTP status through the shared envelope.
 */
final class ErrorHandler
{
    use ApiResponse;

    public function __construct(
        private readonly ResponseFactoryInterface $responseFactory,
        private readonly LoggerInterface $logger,
        private readonly bool $displayErrorDetails = false,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        Throwable $exception,
        bool $displayErrorDetails,
        bool $logErrors,
        bool $logErrorDetails,
    ): ResponseInterface {
        [$status, $message, $errors] = $this->map($exception);

        if ($status >= 500) {
            $this->logger->error($exception->getMessage(), ['exception' => $exception]);
            if (function_exists('\Sentry\captureException')) {
                \Sentry\captureException($exception);
            }
            if ($this->displayErrorDetails || $displayErrorDetails) {
                $errors['debug'] = [
                    'exception' => $exception::class,
                    'message'   => $exception->getMessage(),
                    'file'      => $exception->getFile() . ':' . $exception->getLine(),
                ];
            } else {
                $message = 'Internal server error';
            }
        }

        $response = $this->error($this->responseFactory->createResponse(), $message, $status, $errors);

        // Re-apply CORS so the error is readable by the browser, not opaque.
        return (new CorsMiddleware(array_filter(array_map(
            'trim',
            explode(',', $_ENV['CORS_ALLOWED_ORIGINS'] ?? '*'),
        ))))->decorate($request, $response);
    }

    /** @return array{0:int, 1:string, 2:array} */
    private function map(Throwable $e): array
    {
        return match (true) {
            $e instanceof ValidationException          => [422, $e->getMessage(), $e->getErrors()],
            $e instanceof AuthenticationException       => [401, $e->getMessage(), []],
            $e instanceof EntityNotFoundException       => [404, $e->getMessage(), []],
            $e instanceof HttpNotFoundException         => [404, 'Not found', []],
            $e instanceof HttpMethodNotAllowedException => [405, 'Method not allowed', []],
            default                                     => [500, $e->getMessage(), []],
        };
    }
}
