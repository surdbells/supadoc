<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\LabRequest;
use App\Domain\Lab\LabRequestTransitions;
use App\Domain\Lab\LabTransitionRefused;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * The lab request status machine (lab spec §1.7): who may do what on which
 * EFFECTIVE status — with the refusal codes and messages — expiry computed on
 * read, and the staff corrections.
 */
final class LabRequestTransitionsTest extends TestCase
{
    use LabFixtures;

    private const STATUSES = ['awaiting_consent', 'booked', 'in_lab', 'result_ready', 'declined', 'cancelled', 'expired'];

    /** action => statuses it is allowed on (a plain request: no consent, no sample, no result) */
    private const MATRIX = [
        'accept'  => ['awaiting_consent'],
        'decline' => ['awaiting_consent'],
        'sample'  => ['booked'],
        'upload'  => ['booked', 'in_lab', 'result_ready'],
        'cancel'  => ['awaiting_consent', 'booked', 'in_lab'],
        'review'  => ['result_ready'],
    ];

    public function testTheMatrixPerActor(): void
    {
        $r = self::labRequest();
        foreach (self::MATRIX as $action => $allowed) {
            $role = LabRequestTransitions::ACTIONS[$action];
            foreach (self::STATUSES as $status) {
                $ok = in_array($status, $allowed, true);
                try {
                    LabRequestTransitions::assertCan($status, $action, $role, $r);
                    $this->assertTrue($ok, "$action on $status must be refused");
                } catch (LabTransitionRefused $e) {
                    $this->assertFalse($ok, "$action on $status must be allowed");
                    $this->assertSame(409, $e->status);
                    $this->assertSame($status, $e->errors['status']);
                }
            }
            $other = $role === 'patient' ? 'doctor' : 'patient';
            try {
                LabRequestTransitions::assertCan($allowed[0], $action, $other, $r);
                $this->fail("$action by a $other");
            } catch (LabTransitionRefused $e) {
                $this->assertSame([403, 'not_allowed'], [$e->status, $e->errorCode]);
            }
        }
    }

    public function testRefusalCodesAndMessages(): void
    {
        $r      = self::labRequest();
        $expect = static function (string $status, string $action, string $role) use ($r): LabTransitionRefused {
            try {
                LabRequestTransitions::assertCan($status, $action, $role, $r);
            } catch (LabTransitionRefused $e) {
                return $e;
            }
            throw new \LogicException('allowed');
        };
        $e = $expect('expired', 'accept', 'patient');
        $this->assertSame(['expired', 'This request has expired.'], [$e->errorCode, $e->getMessage()]);
        $e = $expect('awaiting_consent', 'upload', 'patient');
        $this->assertSame(['status_changed', 'Accept the request before adding a result.'], [$e->errorCode, $e->getMessage()]);
        $e = $expect('cancelled', 'upload', 'patient');
        $this->assertSame('This request was cancelled.', $e->getMessage());
        $e = $expect('result_ready', 'cancel', 'doctor');
        $this->assertSame(['status_changed', 'A result has been added to this request.'], [$e->errorCode, $e->getMessage()]);
        $e = $expect('declined', 'sample', 'patient');
        $this->assertSame('The patient declined this request.', $e->getMessage());
    }

    public function testExpiredAcceptedAndCancelledAfterTheSample(): void
    {
        $booked = self::labRequest([], false, null, 'booked');
        $this->assertTrue(LabRequestTransitions::allowed('expired', 'upload', $booked), 'accepted before it expired');
        $this->assertFalse(LabRequestTransitions::allowed('expired', 'upload', self::labRequest()), 'never accepted');

        $inLab = self::labRequest([], false, null, 'in_lab');
        $inLab->markCancelled('No longer needed', new DateTimeImmutable());
        $this->assertTrue(LabRequestTransitions::allowed('cancelled', 'upload', $inLab), 'T6c: the sample was given');
        $this->assertFalse(LabRequestTransitions::allowed('cancelled', 'upload', self::labRequest([], false, null, 'cancelled')), 'no sample');
        $this->assertFalse(LabRequestTransitions::allowed('cancelled', 'review', $inLab), 'no result yet');
        $inLab->addResultCounts(new DateTimeImmutable());
        $this->assertSame('cancelled', $inLab->getStatus(), 'stays cancelled');
        $this->assertTrue(LabRequestTransitions::allowed('cancelled', 'review', $inLab), 'reviewable once it holds a result');
    }

    public function testExpiryIsComputedOnRead(): void
    {
        foreach (['awaiting_consent', 'booked', 'in_lab'] as $status) {
            $r  = self::labRequest([], false, null, $status);
            $at = $r->getExpiresAt();
            $this->assertSame($status, $r->effectiveStatus($at->modify('-1 second')), $status);
            $this->assertSame($status === 'in_lab' ? 'in_lab' : 'expired', $r->effectiveStatus($at), $status . ' at expires_at');
            $this->assertSame($status === 'in_lab' ? 'in_lab' : 'expired', $r->effectiveStatus($at->modify('+1 second')), $status);
        }
    }

    public function testEveryEventMovesTheListOrderForwardOnly(): void
    {
        $sent = self::labRequest();
        $at   = $sent->getSentAt()->modify('+49 hours');
        $sent->markReminded($at);
        $this->assertSame($at->getTimestamp(), $sent->getLastActivityAt()->getTimestamp(), 'T10 reminded bumps the list order');

        $plain = self::labRequest([], false, null, 'booked');
        $plain->markExpired();
        $this->assertSame($plain->getExpiresAt()->getTimestamp(), $plain->getLastActivityAt()->getTimestamp(), 'T9 at expires_at');

        $late  = self::labRequest([], false, null, 'booked');
        $after = $late->getExpiresAt()->modify('+3 days');
        $late->touch($after);
        $late->markExpired();
        $this->assertSame($after->getTimestamp(), $late->getLastActivityAt()->getTimestamp(), 'a late-settled expiry never moves it backwards');
    }

    public function testStaffTargets(): void
    {
        $now = new DateTimeImmutable();
        $this->assertSame(['in_lab'], LabRequestTransitions::staffTargets(self::labRequest([], false, null, 'booked'), $now));
        $this->assertSame(['booked'], LabRequestTransitions::staffTargets(self::labRequest([], false, null, 'in_lab'), $now));
        $this->assertSame(['awaiting_consent'], LabRequestTransitions::staffTargets(self::labRequest([], false, null, 'declined'), $now));
        $this->assertSame([], LabRequestTransitions::staffTargets(self::labRequest([], false, null, 'result_ready'), $now));
        $this->assertSame([], LabRequestTransitions::staffTargets(self::labRequest([], false, null, 'cancelled'), $now));
        $this->assertSame([], LabRequestTransitions::staffTargets(self::labRequest(), $now));
        $later = $now->modify('+40 days');
        $this->assertSame(['booked'], LabRequestTransitions::staffTargets(self::labRequest([], false, null, 'booked'), $later), 'expired after accepting');
        $this->assertSame(['awaiting_consent'], LabRequestTransitions::staffTargets(self::labRequest(), $later), 'expired unanswered');

        $r = self::labRequest([], false, null, 'booked');
        $r->correctTo(LabRequest::STATUS_IN_LAB, null, null, $now);
        $this->assertSame('in_lab', $r->getStatus());
        $this->assertNotNull($r->getSampleAt());
        $this->assertNotNull($r->getCorrectedAt());
    }
}
