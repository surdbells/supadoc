<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Exception\ApplicationProblem;
use App\Infrastructure\Application\ApplicationCodeService as Codes;
use App\Infrastructure\Application\ArrayCodeStore;
use PHPUnit\Framework\TestCase;

/** Spec §2.8 / §8: codes, attempts, burn, cooldown, per-email caps, counter windows, fail closed. */
final class ApplicationCodeServiceTest extends TestCase
{
    private ArrayCodeStore $store;
    private Codes $codes;

    protected function setUp(): void
    {
        $this->store = new ArrayCodeStore(1_800_000_000);
        $this->codes = new Codes($this->store, Codes::codeKeyFrom('test-secret-that-is-long-enough-000000'), true);
    }

    private function problem(callable $call): ApplicationProblem
    {
        try {
            $call();
        } catch (ApplicationProblem $p) {
            return $p;
        }
        $this->fail('expected an ApplicationProblem');
    }

    public function testIssueVerifyBurn(): void
    {
        $code = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $this->assertMatchesRegularExpression('/^\d{6}$/', $code);
        $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code);
        $p = $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code));
        $this->assertSame('code_expired', $p->errorCode, 'single use');
    }

    public function testAttemptsThenBurnedAndANewCodeResetsThem(): void
    {
        $code  = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $wrong = $code === '000000' ? '111111' : '000000';
        for ($left = 4; $left >= 1; $left--) {
            $p = $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $wrong));
            $this->assertSame('code_invalid', $p->errorCode);
            $this->assertSame($left, $p->extra['attempts_left']);
        }
        $this->assertSame('code_locked', $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $wrong))->errorCode);
        $this->assertSame('code_expired', $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code))->errorCode, 'burned');

        $this->store->advance(61);
        $fresh = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $this->assertSame('code_invalid', $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $fresh === '000000' ? '111111' : '000000'))->errorCode);
        $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $fresh); // attempts were reset
        $this->addToAssertionCount(1);
    }

    public function testExpiryAndCooldown(): void
    {
        $code = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $p    = $this->problem(fn () => $this->codes->issueEmailConfirm('app-1', 'ada@example.com'));
        $this->assertSame(429, $p->status);
        $this->assertSame('resend_cooldown', $p->errorCode);
        $this->assertGreaterThan(0, $p->extra['retry_after']);
        $this->store->advance(601);
        $this->assertSame('code_expired', $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code))->errorCode);
    }

    public function testDailyCapsPerEmailAcrossDrafts(): void
    {
        for ($i = 1; $i <= 10; $i++) {
            $this->codes->issueEmailConfirm('draft-' . $i, 'Ada@Example.com');
        }
        $p = $this->problem(fn () => $this->codes->issueEmailConfirm('draft-11', 'ada@example.com'));
        $this->assertSame('rate_limited', $p->errorCode);
        $this->assertSame(429, $p->status);

        // 15 failures a day across drafts → every verify for the email is locked.
        $fails = 0;
        for ($i = 1; $fails < 15; $i++) {
            $this->store->advance(61);
            $other = 'f-' . $i;
            $this->store->setEx('onb:econf:' . $other, (string) json_encode(['h' => 'x', 'e' => Codes::emailHash('ada@example.com')]), 600);
            $this->assertSame('code_invalid', $this->problem(fn () => $this->codes->verifyEmailConfirm($other, 'ada@example.com', '123456'))->errorCode);
            $fails++;
        }
        $code = $this->codes->issueEmailConfirm('draft-1', 'other@example.com');
        $this->assertNotSame('', $code);
        $p = $this->problem(fn () => $this->codes->verifyEmailConfirm('draft-1', 'ada@example.com', '123456'));
        $this->assertSame('code_locked', $p->errorCode);
        $this->assertSame('Too many attempts today. Try again tomorrow.', $p->getMessage());
    }

    public function testTheMailCapIsFivePerAddressAndClosedWithoutRedis(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->assertTrue($this->codes->claimMailSlot('ada@example.com'));
        }
        $this->assertFalse($this->codes->claimMailSlot('ADA@example.com'));
        $this->assertTrue($this->codes->claimMailSlot('bola@example.com'));
        $this->store->failing = true;
        $this->assertFalse($this->codes->claimMailSlot('chidi@example.com'), 'no Redis: nothing is sent');
    }

    public function testACounterWindowIsNeverExtendedByFailures(): void
    {
        for ($i = 0; $i < 4; $i++) {
            $this->codes->beginResumeAttempt('ada@example.com'); // a failed attempt stays counted
            $this->store->advance(400); // 4 × 400 s = 1600 s, still inside the 1800 s window
        }
        $this->codes->beginResumeAttempt('ada@example.com'); // the 5th
        $this->assertSame('resume_locked', $this->problem(fn () => $this->codes->beginResumeAttempt('ada@example.com'))->errorCode);
        $this->store->advance(201); // 1801 s after the FIRST failure
        $this->codes->beginResumeAttempt('ada@example.com');
        $this->addToAssertionCount(1);
    }

    public function testASuccessfulResumeGivesItsAttemptBack(): void
    {
        for ($i = 0; $i < 20; $i++) {
            $this->codes->beginResumeAttempt('ada@example.com');
            $this->codes->resumeSucceeded('ada@example.com');
        }
        $this->assertSame(0, $this->store->peek('onb:resume:fail:' . Codes::emailHash('ada@example.com')));
        $this->codes->beginResumeAttempt('ada@example.com');
        $this->addToAssertionCount(1);
    }

    public function testAConfirmCodeVerifiesOnlyTheAddressItWasSentTo(): void
    {
        $code = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $p    = $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'someone.else@example.com', $code));
        $this->assertSame('code_expired', $p->errorCode, 'the draft now has another address');
        $this->assertSame(0, $this->store->peek('onb:econf:fail:' . Codes::emailHash('someone.else@example.com')), 'not counted as a wrong guess');
        $this->codes->verifyEmailConfirm('app-1', 'ADA@example.com', $code);
        $this->addToAssertionCount(1);
    }

    public function testAttemptsAreCountedBeforeTheComparison(): void
    {
        // Stand-in for concurrent guesses that all read the record before any of them wrote:
        // the attempt counter is the authority, so the 6th attempt is refused even with the right code.
        $code = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $this->store->setEx('onb:econf:app-1:a', '5', 600);
        $this->assertSame('code_locked', $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code))->errorCode);
        $this->assertSame('code_expired', $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code))->errorCode, 'burned');

        // The per-email failure cap is counted up front too: at 15 even the right code is refused …
        $this->store->advance(61);
        $code = $this->codes->issueEmailConfirm('app-1', 'ada@example.com');
        $fail = 'onb:econf:fail:' . Codes::emailHash('ada@example.com');
        $this->store->setEx($fail, '15', 86400);
        $p = $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code));
        $this->assertSame('Too many attempts today. Try again tomorrow.', $p->getMessage());
        // … and below it a success (or an expired code) gives its count back; a wrong guess keeps it.
        $this->store->setEx($fail, '3', 86400);
        $wrong = $code === '000000' ? '111111' : '000000';
        $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $wrong));
        $this->assertSame(4, $this->store->peek($fail));
        $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code);
        $this->assertSame(4, $this->store->peek($fail));
        $this->problem(fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', $code));
        $this->assertSame(4, $this->store->peek($fail), 'code_expired is not a wrong guess');
    }

    public function testTrackCodesForAMatchAndANonMatchBehaveTheSame(): void
    {
        $match   = $this->codes->startTrack('app-1', 'email', ['email' => 'ada***@example.com', 'sms' => 'The phone number on your application']);
        $nomatch = $this->codes->startTrack(null, 'email', ['email' => 'zz***@example.com', 'sms' => 'The phone number on your application']);

        $this->assertTrue($this->codes->openTrackCode($match, 'email')['fresh']);
        $this->assertTrue($this->codes->openTrackCode($nomatch, 'email')['fresh']);
        $this->assertFalse($this->codes->openTrackCode($nomatch, 'email')['fresh'], 'per-check cooldown');
        $this->assertSame('code_invalid', $this->problem(fn () => $this->codes->verifyTrackCode($nomatch, '123456'))->errorCode, 'a dummy code record exists');

        $code = $this->codes->armTrackCode($match, 'app-1', 'email', 'ada@example.com');
        $this->assertNotNull($code);
        $this->assertSame('app-1', $this->codes->verifyTrackCode($match, (string) $code));
        $this->assertSame('track_expired', $this->problem(fn () => $this->codes->verifyTrackCode($match, (string) $code))->errorCode, 'one session per check');
        $this->assertSame(410, $this->problem(fn () => $this->codes->openTrackCode('unknown-track-id-123', 'email'))->status);
    }

    public function testAStatusCodeThatWasNotSentNeverVerifies(): void
    {
        $first = $this->codes->startTrack('app-1', 'email', ['email' => 'ada***@example.com', 'sms' => 'x']);
        $this->codes->openTrackCode($first, 'email');
        $this->assertNotNull($this->codes->armTrackCode($first, 'app-1', 'email', 'ada@example.com'));

        // A second check within 60 s: the per-application cooldown holds the send back …
        $second = $this->codes->startTrack('app-1', 'email', ['email' => 'ada***@example.com', 'sms' => 'x']);
        $this->codes->openTrackCode($second, 'email');
        $this->assertNull($this->codes->armTrackCode($second, 'app-1', 'email', 'ada@example.com'));
        // … so its record is a placeholder: even a record whose hash is known never matches.
        $record = json_decode((string) $this->store->get('onb:trk:code:' . $second), true);
        $this->assertSame(1, $record['n']);
        $record['h'] = $this->codes->hash($second, '123456');
        $this->store->setEx('onb:trk:code:' . $second, (string) json_encode($record), 600);
        $this->assertSame('code_invalid', $this->problem(fn () => $this->codes->verifyTrackCode($second, '123456'))->errorCode);

        // The daily caps hold sends back the same way (8 per application).
        $this->store->advance(61);
        for ($i = 0; $i < 7; $i++) {
            $tid = $this->codes->startTrack('app-1', 'email', ['email' => 'a', 'sms' => 'x']);
            $this->codes->openTrackCode($tid, 'email');
            $this->assertNotNull($this->codes->armTrackCode($tid, 'app-1', 'email', 'ada' . $i . '@example.com'), 'send ' . ($i + 2));
            $this->store->advance(61);
        }
        $tid = $this->codes->startTrack('app-1', 'email', ['email' => 'a', 'sms' => 'x']);
        $this->codes->openTrackCode($tid, 'email');
        $this->assertNull($this->codes->armTrackCode($tid, 'app-1', 'email', 'zed@example.com'), 'the 9th today');
        $this->assertSame(1, json_decode((string) $this->store->get('onb:trk:code:' . $tid), true)['n']);
    }

    public function testDraftCodes(): void
    {
        $code = Codes::newDraftCode();
        $this->assertMatchesRegularExpression('/^[0-9A-HJKMNP-TV-Z]{6}$/', $code);
        $this->assertSame('0A1B11', Codes::normaliseDraftCode(' oa-ib il '));
        $this->assertTrue($this->codes->matches('app-1', $code, $this->codes->hash('app-1', $code)));
        $this->assertFalse($this->codes->matches('app-2', $code, $this->codes->hash('app-1', $code)), 'bound to the application');
    }

    public function testRedisDownIs503(): void
    {
        $this->store->failing = true;
        foreach ([
            fn () => $this->codes->issueEmailConfirm('app-1', 'ada@example.com'),
            fn () => $this->codes->verifyEmailConfirm('app-1', 'ada@example.com', '123456'),
            fn () => $this->codes->beginResumeAttempt('ada@example.com'),
            fn () => $this->codes->openTrackCode('a-track-id-that-looks-ok', 'email'),
            fn () => $this->codes->startTrack('app-1', 'email', ['email' => 'x', 'sms' => 'y']),
        ] as $call) {
            $p = $this->problem($call);
            $this->assertSame(503, $p->status);
            $this->assertSame('codes_unavailable', $p->errorCode);
        }
    }
}
