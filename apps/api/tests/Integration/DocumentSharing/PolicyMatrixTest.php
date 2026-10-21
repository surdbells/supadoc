<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Doctor\DoctorDocumentAccessAction;
use App\Action\Doctor\DownloadPatientDocumentAction;
use App\Action\Doctor\ListPatientDocumentsAction;
use App\Action\DocumentSharing\ListDocumentGrantsAction;
use App\Action\DocumentSharing\ListSharingDoctorsAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\DocumentAccessGrantRepository;
use App\Infrastructure\Document\DocumentAccessNotifier;
use App\Infrastructure\Document\DocumentAccessSweeper;
use App\Infrastructure\Document\DocumentSharingService;

/**
 * The policy matrix of spec §7.2: what doctor A (unless noted) can see of P's
 * documents in each situation — every row also checks parity between the
 * doctor's list and the patient-side set.
 */
final class PolicyMatrixTest extends DocShareTestCase
{
    public function testRow1NoGrantsMeansNothingAndTheLegacyListIsEmpty(): void
    {
        $this->assertSame([], $this->visible($this->A, $this->P));
        $legacy = $this->doctorAction(ListPatientDocumentsAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $this->assertSame(200, $legacy['status']);
        $this->assertSame([], $legacy['body']['data']);
    }

    public function testRow2AFolderShareIncludesLaterUploads(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $p4 = $this->newDocument($this->P, 'Later upload', $this->now->modify('+1 minute'));

        $this->assertSame($this->sorted([$this->P1, $this->P2, $this->P3, $p4]), $this->visible($this->A, $this->P, $this->now->modify('+2 minutes')));
        // The legacy list returns the allowlist, never patient-side extras.
        $legacy = $this->doctorAction(ListPatientDocumentsAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $this->assertCount(4, $legacy['body']['data']);
        $this->assertArrayNotHasKey('shared_with', $legacy['body']['data'][0]);
    }

    public function testRow3RemoveAccessHidesOneDocumentFromTheFolder(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);

        $this->assertSame($this->sorted([$this->P1, $this->P3]), $this->visible($this->A, $this->P));
    }

    public function testRow4ASelectedShareShowsOnlyItsDocuments(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '7d']);

        $this->assertSame([$this->P1], $this->visible($this->A, $this->P));
    }

    public function testRow5TheEndIsExclusive(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '24h']);
        $end = $this->now->modify('+24 hours');

        $this->assertSame([$this->P1], $this->visible($this->A, $this->P, $end->modify('-1 second')));
        $this->assertSame([], $this->visible($this->A, $this->P, $end));
    }

    public function testRow6ARevokedShareShowsNothing(): void
    {
        $result = $this->share($this->P, ['specialist_ids' => [$this->A]]);
        [$svc, $em] = $this->request();
        $svc->revokeGrant($this->patient($em, $this->P), $result['grants'][0]['id'], $this->now);

        $this->assertSame([], $this->visible($this->A, $this->P));
    }

    public function testRow7APausedDoctorSeesNothingAndAfterAShortPauseTheShareResumes(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->B]]);
        $this->suspend($this->B, $this->now->modify('-10 days'));
        $this->assertSame([], $this->visible($this->B, $this->P));

        $notices = $this->reinstate($this->B);
        $this->assertSame(1, $notices, 'one notice per affected patient');
        $this->assertSame($this->sorted([$this->P1, $this->P2, $this->P3]), $this->visible($this->B, $this->P));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM notifications WHERE patient_id = ? AND title = ?', [$this->P, DocumentAccessNotifier::REINSTATED_TITLE]));
        $body = (string) $this->conn()->fetchOne('SELECT body FROM notifications WHERE patient_id = ? AND title = ?', [$this->P, DocumentAccessNotifier::REINSTATED_TITLE]);
        $this->assertStringContainsString('can see what you shared', $body);
    }

    public function testRow7bAfterMoreThanThirtyDaysAwayTheSharesEnd(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->B]]);
        $this->suspend($this->B, $this->now->modify('-31 days'));

        $this->reinstate($this->B);
        $this->assertSame([], $this->visible($this->B, $this->P));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE specialist_id = ? AND end_reason = 'doctor_unavailable' AND status = 'revoked' AND ended_by = 'system'", [$this->B]));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM notifications WHERE patient_id = ? AND title = ?', [$this->P, DocumentAccessNotifier::REINSTATED_ENDED_TITLE]));
    }

    public function testRow8AGrantForADoctorNeverBookedShowsNothing(): void
    {
        (new DocumentAccessGrantRepository($this->em()))->insertGrant([
            'patient_id' => $this->P, 'specialist_id' => $this->C, 'scope' => 'all', 'source' => 'share', 'surface' => 'manage_sharing', 'duration' => 'indefinite', 'expires_at' => null,
        ], $this->now);

        $this->assertSame([], $this->visible($this->C, $this->P));
    }

    public function testRow9WhenEveryConsultationOfThePairIsDeletedNothingShows(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $this->conn()->executeStatement('UPDATE appointments SET deleted_at = ? WHERE patient_id = ? AND specialist_id = ?', [Rules::sql($this->now), $this->P, $this->A]);

        $this->assertSame([], $this->visible($this->A, $this->P));
    }

    public function testRow10ADeletedPatientShowsNothing(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $this->conn()->executeStatement('UPDATE patients SET deleted_at = ? WHERE id = ?', [Rules::sql($this->now), $this->P]);

        $this->assertSame([], $this->visible($this->A, $this->P));
    }

    public function testRow11CancellingTheAnchorConsultationEndsAnAfterShareAtOnce(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => 'after_24h', 'appointment_id' => $this->apNext]);
        $this->assertSame([$this->P1], $this->visible($this->A, $this->P));

        $this->conn()->executeStatement("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [$this->apNext]);
        $this->assertSame([], $this->visible($this->A, $this->P), 'inactive at once — no sweep needed');

        // Before the sweeper runs, the patient's lists agree: the share is in
        // "ended" (expired, consultation cancelled), not in "active".
        $active = $this->patientAction(ListDocumentGrantsAction::class, $this->P, query: ['status' => 'active'], method: 'GET')['body']['data'];
        $this->assertSame([], $active, 'a share whose consultation was cancelled is not listed as active');
        $ended = $this->patientAction(ListDocumentGrantsAction::class, $this->P, query: ['status' => 'ended'], method: 'GET')['body']['data'];
        $this->assertCount(1, $ended);
        $this->assertSame(['expired', 'appointment_cancelled', 'system'], [$ended[0]['status'], $ended[0]['end_reason'], $ended[0]['ended_by']]);

        $sweep = $this->container()->get(DocumentAccessSweeper::class)->run($this->now);
        $this->assertSame(1, $sweep['ended_cancelled']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE end_reason = 'appointment_cancelled'"));
    }

    public function testRow12APatientRescheduleMovesAnAfterShareAndRebasesIt(): void
    {
        $result = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => 'after_7d', 'appointment_id' => $this->apNext]);
        $before = Rules::fromSql($this->conn()->fetchOne('SELECT expires_at FROM document_access_grants WHERE id = ?', [$result['grants'][0]['id']]));

        $moved = $this->move($this->apNext, '+3 days', 'patient');
        $this->assertCount(1, $moved);
        $row = $this->conn()->fetchAssociative('SELECT expires_at, original_expires_at FROM document_access_grants WHERE id = ?', [$result['grants'][0]['id']]);
        $this->assertEquals($before->modify('+3 days'), Rules::fromSql($row['expires_at']));
        $this->assertSame($row['expires_at'], $row['original_expires_at'], "the patient's own move re-bases it");
    }

    public function testRow12bADoctorRescheduleIsCappedAtTheOriginalEndPlusThirtyDays(): void
    {
        $result   = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => 'after_7d', 'appointment_id' => $this->apNext]);
        $original = Rules::fromSql($this->conn()->fetchOne('SELECT expires_at FROM document_access_grants WHERE id = ?', [$result['grants'][0]['id']]));

        $moved = $this->move($this->apNext, '+40 days', 'doctor');
        $this->assertTrue($moved[0]['capped']);
        $this->assertEquals($original->modify('+30 days'), Rules::fromSql($this->conn()->fetchOne('SELECT expires_at FROM document_access_grants WHERE id = ?', [$result['grants'][0]['id']])));
        $log = $this->conn()->fetchAssociative("SELECT actor_role, details FROM document_access_log WHERE event = 'extended'");
        $this->assertSame('system', $log['actor_role']);
        $this->assertTrue(json_decode((string) $log['details'], true)['capped']);
        $this->assertStringStartsWith('Documents you shared for this consultation stay shared until ', DocumentAccessNotifier::rescheduleSuffix($moved));
        $this->assertStringNotContainsString('after the new time', DocumentAccessNotifier::rescheduleSuffix($moved), 'the capped variant names the date');

        // Moving it again never goes past original + 30 days.
        $this->move($this->apNext, '+30 days', 'doctor');
        $this->assertEquals($original->modify('+30 days'), Rules::fromSql($this->conn()->fetchOne('SELECT expires_at FROM document_access_grants WHERE id = ?', [$result['grants'][0]['id']])));
    }

    public function testRow13TheLongestCoveringShareWins(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => 'indefinite']);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'all', 'duration' => '24h']);
        $after = $this->now->modify('+24 hours +1 second');

        $this->assertSame([$this->P1], $this->visible($this->A, $this->P, $after));
        [, $em, $c] = $this->request();
        $v = $c->get(\App\Infrastructure\Document\DocumentAccessPolicy::class)->visibleDocuments($this->doctor($em, $this->A), $this->patient($em, $this->P), $this->now);
        $p1 = array_values(array_filter($v, fn ($x): bool => $x->documentId === $this->P1))[0];
        $this->assertNull($p1->until, 'NULL beats any date');
        $this->assertSame('folder', $p1->via);
    }

    public function testRow14HiddenSurvivesARevokeAndANewFolderShare(): void
    {
        $first = $this->share($this->P, ['specialist_ids' => [$this->A]]);
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);
        [$svc, $em] = $this->request();
        $svc->revokeGrant($this->patient($em, $this->P), $first['grants'][0]['id'], $this->now);
        $this->share($this->P, ['specialist_ids' => [$this->A]]);

        $this->assertSame($this->sorted([$this->P1, $this->P3]), $this->visible($this->A, $this->P));
    }

    public function testRow15HiddenSurvivesAScopeRoundTrip(): void
    {
        $grant = $this->share($this->P, ['specialist_ids' => [$this->A]])['grants'][0]['id'];
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);
        [$svc, $em] = $this->request();
        $svc->updateGrant($this->patient($em, $this->P), $grant, ['scope' => 'selected', 'document_ids' => [$this->P1]], $this->now);
        $this->assertSame([$this->P1], $this->visible($this->A, $this->P));
        [$svc, $em] = $this->request();
        $svc->updateGrant($this->patient($em, $this->P), $grant, ['scope' => 'all'], $this->now);

        $this->assertSame($this->sorted([$this->P1, $this->P3]), $this->visible($this->A, $this->P));
    }

    public function testRow16TwoFolderSharesMergeAndHiddenStays(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '7d']);
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);
        $selected = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P3], 'duration' => '30d'])['grants'][0]['id'];

        [$svc, $em] = $this->request();
        $survivor = $svc->updateGrant($this->patient($em, $this->P), $selected, ['scope' => 'all'], $this->now);

        $this->assertNotSame($selected, $survivor['id'], 'the existing folder share survives');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active' AND scope = 'all'"));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE id = ? AND end_reason = 'merged'", [$selected]));
        $this->assertSame($this->sorted([$this->P1, $this->P3]), $this->visible($this->A, $this->P));
        $this->assertEquals($this->now->modify('+30 days'), new \DateTimeImmutable($survivor['expires_at']), 'the later end wins');
    }

    public function testRow17ASelectedShareOfAHiddenDocumentEndsOnTime(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2], 'duration' => '24h']);

        $this->assertContains($this->P2, $this->visible($this->A, $this->P, $this->now->modify('+23 hours')));
        $this->assertNotContains($this->P2, $this->visible($this->A, $this->P, $this->now->modify('+25 hours')), 'the hidden row was not cleared');
    }

    public function testRow18ShowThemTooClearsTheHiddenRows(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'show_hidden_for_specialist_ids' => [$this->A]]);

        $this->assertSame($this->sorted([$this->P1, $this->P2, $this->P3]), $this->visible($this->A, $this->P));
    }

    public function testRow19ADocumentOfAnotherPatientIsNeverReachableThroughThisConsultation(): void
    {
        // Q (A's patient too) shares Q1 with A.
        $this->share($this->Q, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->Q1]]);
        $audits = $this->countRows('SELECT COUNT(*) FROM audit_events');
        $logs   = $this->countRows('SELECT COUNT(*) FROM document_access_log');

        $res = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->apNext, 'docId' => $this->Q1], method: 'GET');
        $this->assertSame(404, $res['status']);
        $this->assertSame('not_shared', $res['body']['errors']['code']);
        $this->assertSame($audits, $this->countRows('SELECT COUNT(*) FROM audit_events'), 'no audit row');
        $this->assertSame($logs, $this->countRows('SELECT COUNT(*) FROM document_access_log'), 'no ledger row');
        $this->assertSame(0, $this->countRows('SELECT COALESCE(SUM(access_count), 0) FROM document_access_grants'));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_log WHERE patient_id = ? AND document_id = ?', [$this->P, $this->Q1]));

        // Through Q's own consultation it opens (and is recorded).
        $this->storeBytes($this->Q1);
        $ok = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->aqNext, 'docId' => $this->Q1], method: 'GET');
        $this->assertSame(200, $ok['status']);
        $this->assertSame('application/pdf', $ok['response']->getHeaderLine('Content-Type'));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE patient_id = ? AND event = 'viewed'", [$this->Q]));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE patient_id = ? AND event = 'viewed'", [$this->P]));
    }

    public function testRow20WithSharingSwitchedOffEverythingIsPrivate(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $_ENV['DOC_SHARING_ENABLED'] = 'false';

        $this->assertSame([], $this->visible($this->A, $this->P));
        $legacy = $this->doctorAction(ListPatientDocumentsAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $this->assertSame([], $legacy['body']['data']);
        $file = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userA, ['id' => $this->apNext, 'docId' => $this->P1], method: 'GET');
        $this->assertSame(404, $file['status']);
        $this->assertSame('not_shared', $file['body']['errors']['code']);
        $access = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], method: 'GET');
        $this->assertSame(200, $access['status']);
        $this->assertSame('none', $access['body']['data']['access']['state']);
        $this->assertSame([], $access['body']['data']['documents']);
        $this->assertFalse($access['body']['data']['request']['can_request']);
        $this->assertSame('sharing_unavailable', $access['body']['data']['request']['blocked_reason']);
        $patient = $this->patientAction(ListSharingDoctorsAction::class, $this->P, method: 'GET');
        $this->assertSame(503, $patient['status']);
        $this->assertSame('sharing_unavailable', $patient['body']['errors']['code']);
    }

    // ----- Helpers -----

    /** Reinstate a suspended doctor the way SpecialistSuspensionService does; returns the notices sent. */
    private function reinstate(string $specialistId): int
    {
        [$svc, $em] = $this->request();
        $s       = $this->doctor($em, $specialistId);
        $notices = $svc->doctorReinstated($s, $this->now);
        $s->reinstate();
        $em->flush();
        $count = $notices->count();
        $notices->dispatch();

        return $count;
    }

    /**
     * Move a consultation by `$by` (inside a transaction, as the reschedule actions do).
     *
     * @return list<array{duration:string, expires_at:\DateTimeImmutable, capped:bool}>
     */
    private function move(string $appointmentId, string $by, string $movedBy): array
    {
        [$svc, $em] = $this->request();
        $a = $em->find(Appointment::class, $appointmentId);
        \assert($a instanceof Appointment);

        return $em->wrapInTransaction(function () use ($svc, $em, $a, $by, $movedBy): array {
            $a->setScheduledAt($a->getScheduledAt()->modify($by));
            $a->setRescheduledBy($movedBy);
            $em->flush();

            return $svc->appointmentMoved($a, $movedBy, $this->now);
        });
    }
}
