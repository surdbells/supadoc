<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Doctor\RequestDocumentAccessAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Appointment;
use App\Infrastructure\Document\DocumentAccessNotifier;
use App\Infrastructure\Document\DocumentAccessSweeper;
use App\Infrastructure\Document\DocumentSharingService;
use DateTimeImmutable;

/**
 * Doctors' requests and the patient's answers (spec §7.2 "Lifecycle and CAS"):
 * pending, cooldown, block, approve / decline / withdraw, expiry recorded once
 * whoever gets there first, and the sweeper's cancellations.
 */
final class RequestLifecycleTest extends DocShareTestCase
{
    public function testARequestIsPendingAndASecondOneIsRefusedWithThePendingOne(): void
    {
        $first = $this->doctorAction(RequestDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], ['message' => "  Please share\u{202E} your\u{200B} results\n\n\n\nThanks  "]);
        $this->assertSame(201, $first['status'], json_encode($first['body']));
        $this->assertSame('pending', $first['body']['data']['status']);
        $this->assertSame('access', $first['body']['data']['kind']);
        $this->assertSame("Please share your results\n\nThanks", $first['body']['data']['message'], 'bidi / zero-width removed, newlines collapsed');
        // The patient was told (in-app, naming the doctor only).
        $body = (string) $this->conn()->fetchOne("SELECT body FROM notifications WHERE patient_id = ? AND type = 'document'", [$this->P]);
        $this->assertSame(sprintf(DocumentAccessNotifier::REQUEST_BODY, 'Dr. Ada Alpha'), $body);

        $second = $this->doctorAction(RequestDocumentAccessAction::class, $this->userA, ['id' => $this->apNext]);
        $this->assertSame(409, $second['status']);
        $this->assertSame('request_pending', $second['body']['errors']['code']);
        $this->assertSame($first['body']['data']['id'], $second['body']['errors']['request']['id']);
    }

    public function testDeclineCooldownBlockAndAllow(): void
    {
        $req = $this->ask($this->now);
        $this->decline($req, false, $this->now);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND title = ?", [$this->userA, DocumentAccessNotifier::DECLINED_TITLE]));

        $refusal = $this->refusal(fn () => $this->ask($this->now->modify('+1 hour')));
        $this->assertSame('request_cooldown', $refusal->errorCode());
        $this->assertSame(Rules::iso($this->now->modify('+72 hours')), $refusal->errors['available_at']);

        $again = $this->ask($this->now->modify('+72 hours'));
        $this->decline($again, true, $this->now->modify('+72 hours'));
        $this->assertSame('request_blocked', $this->refusal(fn () => $this->ask($this->now->modify('+150 hours')))->errorCode());
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'requests_blocked'"));

        [$svc, $em] = $this->request();
        $dto = $svc->allowRequests($this->patient($em, $this->P), $this->A, $this->now->modify('+150 hours'));
        $this->assertFalse($dto['requests_blocked']);
        $this->ask($this->now->modify('+150 hours'));
    }

    public function testApproveCreatesARequestGrantAndTellsTheDoctorApprovedOnly(): void
    {
        $req = $this->ask($this->now);
        [$svc, $em] = $this->request();
        $out = $svc->approveRequest($this->patient($em, $this->P), $req, ['scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '7d'], $this->now);

        $this->assertSame('approved', $out['request']['status']);
        $this->assertSame($out['grant']['id'], $out['request']['grant_id']);
        $this->assertSame('request', $out['grant']['source']);
        $this->assertSame([$this->P1], $this->visible($this->A, $this->P));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND title = ?', [$this->userA, DocumentAccessNotifier::APPROVED_TITLE]));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND title = ?', [$this->userA, DocumentAccessNotifier::SHARED_TITLE]));

        $twice = $this->refusal(fn () => $this->approve($req, $this->now));
        $this->assertSame(409, $twice->status);
        $this->assertSame('approved', $twice->errors['status']);
    }

    public function testAWithdrawnRequestCannotBeApproved(): void
    {
        $req = $this->ask($this->now);
        [$svc, $em] = $this->request();
        $svc->cancelRequest($this->doctor($em, $this->A), $this->patient($em, $this->P), $this->now);

        $this->assertSame('cancelled', $this->refusal(fn () => $this->approve($req, $this->now))->errors['status']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.request_cancelled' AND actor_role = 'doctor'"));
    }

    public function testApprovingAfterTheCloseBeforeAnySweepRecordsTheExpiryOnce(): void
    {
        $req   = $this->ask($this->now);
        $after = $this->now->modify('+7 days +1 second');

        $refusal = $this->refusal(fn () => $this->approve($req, $after));
        $this->assertSame(409, $refusal->status);
        $this->assertSame('expired', $refusal->errors['status']);
        $this->assertExpiryRecordedOnce();

        $sweep = $this->container()->get(DocumentAccessSweeper::class)->run($after);
        $this->assertSame(0, $sweep['requests_expired'], 'nothing left for the sweeper');
        $this->assertExpiryRecordedOnce();
    }

    public function testTheSweeperFirstThenApproveRecordsTheExpiryOnce(): void
    {
        $req   = $this->ask($this->now);
        $after = $this->now->modify('+7 days +1 second');
        $this->assertSame(1, $this->container()->get(DocumentAccessSweeper::class)->run($after)['requests_expired']);

        $this->assertSame('expired', $this->refusal(fn () => $this->approve($req, $after))->errors['status']);
        $this->assertExpiryRecordedOnce();
    }

    public function testTheSweeperCancelsRequestsOfADoctorWhoStoppedPractising(): void
    {
        [$svc, $em] = $this->request();
        $b = $em->find(Appointment::class, $this->bpNext);
        $svc->requestAccess($this->doctor($em, $this->B), $b, $this->userA, null, $this->now);
        $this->suspend($this->B, $this->now);

        $this->assertSame(1, $this->container()->get(DocumentAccessSweeper::class)->run($this->now)['requests_cancelled']);
        $this->assertSame('doctor_unavailable', $this->conn()->fetchOne('SELECT close_reason FROM document_access_requests WHERE specialist_id = ?', [$this->B]));
    }

    public function testACancelledConsultationCancelsTheRequestOnlyWithoutAnotherEligibleOne(): void
    {
        // A–P has a completed consultation 3 days ago as well: the request survives, with no appointment shown.
        $req = $this->ask($this->now);
        $this->conn()->executeStatement("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [$this->apNext]);
        $this->container()->get(DocumentAccessSweeper::class)->run($this->now);
        $this->assertSame('pending', $this->conn()->fetchOne('SELECT status FROM document_access_requests WHERE id = ?', [$req]));
        [$svc, $em] = $this->request();
        $this->assertNull($svc->pendingRequestFor($this->patient($em, $this->P), $this->A, $this->now)['appointment']);

        // Without another eligible consultation it is cancelled `not_eligible`.
        $this->conn()->executeStatement('UPDATE appointments SET deleted_at = ? WHERE id = ?', [Rules::sql($this->now), $this->apPast]);
        $this->container()->get(DocumentAccessSweeper::class)->run($this->now);
        $this->assertSame('not_eligible', $this->conn()->fetchOne('SELECT close_reason FROM document_access_requests WHERE id = ?', [$req]));
    }

    public function testOnlyAShareThatAnswersARequestClosesIt(): void
    {
        $req = $this->ask($this->now);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '7d']);
        $this->assertSame('pending', $this->conn()->fetchOne('SELECT status FROM document_access_requests WHERE id = ?', [$req]));

        $out = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2], 'duration' => '7d', 'answers_request_id' => $req]);
        $this->assertSame([$req], $out['approved_request_ids']);
        $this->assertSame('shared_directly', $this->conn()->fetchOne('SELECT close_reason FROM document_access_requests WHERE id = ?', [$req]));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND title = ?', [$this->userA, DocumentAccessNotifier::APPROVED_TITLE]));
    }

    public function testAnExtensionRequestWhileAFolderShareEndsSoon(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '24h']);
        $id = $this->ask($this->now);
        $this->assertSame('extend', $this->conn()->fetchOne('SELECT kind FROM document_access_requests WHERE id = ?', [$id]));

        // A folder share with no end: full access, no request.
        $this->decline($id, false, $this->now);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => 'indefinite']);
        $this->assertSame('has_full_access', $this->refusal(fn () => $this->ask($this->now->modify('+80 hours')))->errorCode());
    }

    // ----- Helpers -----

    private function ask(DateTimeImmutable $at): string
    {
        [$svc, $em] = $this->request();
        $a = $em->find(Appointment::class, $this->apNext);
        \assert($a instanceof Appointment);

        return (string) $svc->requestAccess($this->doctor($em, $this->A), $a, $this->userA, null, $at)['id'];
    }

    private function decline(string $requestId, bool $block, DateTimeImmutable $at): void
    {
        [$svc, $em] = $this->request();
        $svc->declineRequest($this->patient($em, $this->P), $requestId, $block, $at);
    }

    /** @return array<string,mixed> */
    private function approve(string $requestId, DateTimeImmutable $at): array
    {
        [$svc, $em] = $this->request();

        return $svc->approveRequest($this->patient($em, $this->P), $requestId, ['scope' => 'all', 'duration' => '7d'], $at);
    }

    private function refusal(callable $fn): DomainRefusal
    {
        try {
            $fn();
        } catch (DomainRefusal $r) {
            return $r;
        }
        $this->fail('Expected a refusal');
    }

    private function assertExpiryRecordedOnce(): void
    {
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.request_expired'"));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'request_expired'"));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND title = ?', [$this->userA, DocumentAccessNotifier::CLOSED_TITLE]));
    }
}
