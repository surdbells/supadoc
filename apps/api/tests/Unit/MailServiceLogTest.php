<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Email\MailService;
use Monolog\Handler\TestHandler;
use Monolog\Logger;
use PHPUnit\Framework\TestCase;

/** Spec §3.7: MailService logs a hashed recipient, the HTTP code and the template key — never the address, subject, body or message. */
final class MailServiceLogTest extends TestCase
{
    public function testTheSkippedPath(): void
    {
        $log  = new TestHandler();
        $mail = new MailService('', '', 'VideoMed', 'https://api.zeptomail.com', new Logger('mail', [$log]));
        $this->assertFalse($mail->send('Ada.Obi@Example.com', 'Ada Obi', 'New doctor application: Ada Obi', '<p>secret</p>', 'reviewerNotice'));

        $record = $log->getRecords()[0];
        $this->assertStringContainsString('Email skipped', $record->message);
        $this->assertSame(['to_hash' => MailService::toHash('ada.obi@example.com'), 'template' => 'reviewerNotice'], $record->context);
        $this->assertSame(12, strlen(MailService::toHash('x@y.z')));
        $dump = json_encode([$record->message, $record->context]);
        foreach (['Ada', 'Obi', 'example.com', 'secret', 'application:'] as $leak) {
            $this->assertStringNotContainsStringIgnoringCase($leak, (string) $dump);
        }
    }

    public function testTheFailedAndThrewPaths(): void
    {
        $log  = new TestHandler();
        // An unroutable base URL: curl fails fast, the request never leaves the machine.
        $mail = new MailService('token', 'from@videomed.test', 'VideoMed', 'http://127.0.0.1:1', new Logger('mail', [$log]));
        $this->assertFalse($mail->send('ada@example.com', 'Ada Obi', 'Subject with Ada Obi', '<p>body</p>', 'applicationSubmitted'));
        foreach ($log->getRecords() as $record) {
            $this->assertSame(MailService::toHash('ada@example.com'), $record->context['to_hash']);
            $this->assertSame('applicationSubmitted', $record->context['template']);
            $this->assertArrayNotHasKey('to', $record->context);
            $this->assertArrayNotHasKey('subject', $record->context);
            $this->assertArrayNotHasKey('body', $record->context);
            $dump = (string) json_encode([$record->message, $record->context]);
            $this->assertStringNotContainsString('ada@example.com', $dump);
            $this->assertStringNotContainsString('Ada Obi', $dump);
        }
        $this->assertNotEmpty($log->getRecords());
    }
}
