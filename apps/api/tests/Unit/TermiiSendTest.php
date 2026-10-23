<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Service\TermiiService;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use PHPUnit\Framework\TestCase;

/** Spec D8 / §5.5: TermiiService::send — the payload, unconfigured → false, never throws, PHI-free logs. */
final class TermiiSendTest extends TestCase
{
    public function testThePayload(): void
    {
        $seen      = [];
        $transport = static function (string $url, array $body) use (&$seen): array {
            $seen = ['url' => $url, 'body' => $body];

            return ['code' => 200, 'body' => '{"message_id":"m-1","message":"Successfully Sent"}'];
        };
        $sms = new TermiiService('key', '', 'https://api.ng.termii.com/', 'dnd', $transport);
        $this->assertTrue($sms->send('+2348031234567', 'VideoMed: hello'));
        $this->assertSame('https://api.ng.termii.com/api/sms/send', $seen['url']);
        $this->assertSame([
            'api_key' => 'key', 'to' => '2348031234567', 'from' => 'VideoMed', 'sms' => 'VideoMed: hello', 'type' => 'plain', 'channel' => 'dnd',
        ], $seen['body']);
    }

    public function testFailuresAreFalseAndLoggedWithoutTheNumberOrText(): void
    {
        $log = new TestHandler();
        foreach ([
            static fn (): array => ['code' => 400, 'body' => '{"message":"Insufficient balance for +2348031234567"}'],
            static fn (): array => ['code' => 200, 'body' => '{"message":"no id"}'],
            static fn (): array => throw new \RuntimeException('boom for +2348031234567'),
        ] as $transport) {
            $sms = new TermiiService('key', 'VideoMed', 'https://x', 'generic', $transport, new Logger('t', [$log]));
            $this->assertFalse($sms->send('+2348031234567', 'secret text 123456'));
        }
        foreach ($log->getRecords() as $record) {
            $dump = json_encode([$record->message, $record->context]);
            $this->assertStringNotContainsString('2348031234567', (string) $dump);
            $this->assertStringNotContainsString('123456', (string) $dump);
            $this->assertArrayHasKey('to_hash', $record->context);
        }
        $this->assertCount(3, $log->getRecords());
    }

    public function testUnconfiguredSendsNothing(): void
    {
        $called = false;
        $sms    = new TermiiService('', '', 'https://x', 'generic', static function () use (&$called): array {
            $called = true;

            return ['code' => 200, 'body' => '{}'];
        });
        $this->assertFalse($sms->isConfigured());
        $this->assertFalse($sms->send('+2348031234567', 'x'));
        $this->assertFalse($called);
    }
}
