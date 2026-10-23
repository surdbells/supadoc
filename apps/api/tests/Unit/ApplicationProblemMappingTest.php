<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Exception\ApplicationProblem;
use App\Infrastructure\Middleware\ErrorHandler;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/** Spec §3.1 / D30: ErrorHandler maps ApplicationProblem (status, code, extras); a 503 keeps its message and logs nothing. */
final class ApplicationProblemMappingTest extends TestCase
{
    /** @return array{0:int, 1:array<string,mixed>, 2:TestHandler} */
    private function handle(\Throwable $e, bool $debug = false): array
    {
        $log      = new TestHandler();
        $handler  = new ErrorHandler(new ResponseFactory(), new Logger('t', [$log]), $debug);
        $response = $handler((new ServerRequestFactory())->createServerRequest('POST', '/api/x'), $e, $debug, true, true);

        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true), $log];
    }

    public function testStatusCodeAndExtras(): void
    {
        [$status, $body, $log] = $this->handle(new ApplicationProblem(422, 'code_invalid', "That code isn't right. Check it and try again.", ['attempts_left' => 2]));
        $this->assertSame(422, $status);
        $this->assertSame("That code isn't right. Check it and try again.", $body['message']);
        $this->assertSame(['code' => 'code_invalid', 'attempts_left' => 2], $body['errors']);
        $this->assertSame([], $log->getRecords());

        [$status, $body] = $this->handle(new ApplicationProblem(409, 'draft_submitted', 'Already submitted.', ['reference' => 'GVM-DR-2026-12345']));
        $this->assertSame(409, $status);
        $this->assertSame('GVM-DR-2026-12345', $body['errors']['reference']);
    }

    public function testA503KeepsItsMessageAndLogsNothing(): void
    {
        foreach ([false, true] as $debug) {
            [$status, $body, $log] = $this->handle(new ApplicationProblem(503, 'storage_unavailable', "Documents can't be uploaded right now. Please try again later."), $debug);
            $this->assertSame(503, $status);
            $this->assertSame("Documents can't be uploaded right now. Please try again later.", $body['message'], 'not masked as "Internal server error"');
            $this->assertSame(['code' => 'storage_unavailable'], $body['errors'], 'no debug block');
            $this->assertSame([], $log->getRecords());
        }
        // An ordinary 500 is still masked and logged.
        [$status, $body, $log] = $this->handle(new \RuntimeException('boom'));
        $this->assertSame(500, $status);
        $this->assertSame('Internal server error', $body['message']);
        $this->assertCount(1, $log->getRecords());
    }

    public function testACooldownAlsoAnswersInTheRetryAfterHeader(): void
    {
        $handler = new ErrorHandler(new ResponseFactory(), new Logger('t', [new TestHandler()]));
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/x');

        $response = $handler($request, new ApplicationProblem(429, 'resend_cooldown', 'Please wait a minute before asking for another code.', ['retry_after' => 42]), false, true, true);
        $this->assertSame(429, $response->getStatusCode());
        $this->assertSame('42', $response->getHeaderLine('Retry-After'));
        $this->assertSame(42, json_decode((string) $response->getBody(), true)['errors']['retry_after'], 'the body keeps it too');

        // Never below one second, and only for an integer wait.
        $response = $handler($request, new ApplicationProblem(429, 'resend_cooldown', 'Wait.', ['retry_after' => 0]), false, true, true);
        $this->assertSame('1', $response->getHeaderLine('Retry-After'));
        $response = $handler($request, new ApplicationProblem(422, 'code_invalid', 'No.', ['attempts_left' => 2]), false, true, true);
        $this->assertFalse($response->hasHeader('Retry-After'));
    }

    public function testAMappedApplicationProblemComesBeforeTheDomainExceptionArm(): void
    {
        [$status] = $this->handle(new ApplicationProblem(410, 'track_expired', 'This check has timed out. Start again.'));
        $this->assertSame(410, $status);
    }
}
