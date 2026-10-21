<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\DomainRefusal;
use App\Domain\Entity\Appointment;
use App\Domain\Repository\DocumentAccessGrantRepository;
use DateTimeImmutable;
use Ramsey\Uuid\Uuid;

/**
 * Writes and idempotency (spec §7.2): merge rules, replay / conflict,
 * removal, emptied shares, ended shares, revoke / Undo / revoke-all.
 */
final class WritesAndIdempotencyTest extends DocShareTestCase
{
    public function testAFolderShareNeverShortensAndALaterEndExtendsIt(): void
    {
        $first = $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '7d']);
        $this->assertSame('created', $first['outcomes'][0]['outcome']);

        $later = $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '30d']);
        $this->assertSame('extended', $later['outcomes'][0]['outcome']);
        $this->assertSame($first['grants'][0]['id'], $later['grants'][0]['id']);
        $this->assertSame('30d', $later['grants'][0]['duration']);

        $earlier = $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '24h']);
        $this->assertSame('unchanged', $earlier['outcomes'][0]['outcome']);
        $this->assertSame($later['grants'][0]['expires_at'], $earlier['grants'][0]['expires_at'], 'the end is kept');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active'"));
    }

    public function testSelectedSharesMergeOnlyOnTheSameDurationConsultationEndAndSource(): void
    {
        $a = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1]]);
        $b = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2]]);
        $this->assertSame('merged', $b['outcomes'][0]['outcome']);
        $this->assertSame($a['grants'][0]['id'], $b['grants'][0]['id']);
        $this->assertSame(2, $b['grants'][0]['document_count']);

        $c = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P3], 'duration' => '7d']);
        $this->assertSame('created', $c['outcomes'][0]['outcome'], 'another duration: a share of its own');
    }

    public function testTheSameSubmissionReplaysAndADifferentOneConflicts(): void
    {
        $key   = Uuid::uuid4()->toString();
        $first = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'client_key' => $key]);
        $this->assertFalse($first['replayed']);

        $again = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'client_key' => strtoupper($key)]);
        $this->assertTrue($again['replayed']);
        $this->assertSame($first['grants'][0]['id'], $again['grants'][0]['id']);

        $grants = $this->countRows('SELECT COUNT(*) FROM document_access_grants');
        try {
            $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2], 'client_key' => $key]);
            $this->fail('A different body with the same key must conflict');
        } catch (DomainRefusal $r) {
            $this->assertSame(409, $r->status);
            $this->assertSame('idempotency_conflict', $r->errorCode());
        }
        $this->assertSame($grants, $this->countRows('SELECT COUNT(*) FROM document_access_grants'), 'nothing written');
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM document_access_grant_documents'));
    }

    public function testARetryOfASubmissionThatMergedIsAReplay(): void
    {
        // Selected: the second submission merged into the first share.
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1]]);
        $key    = Uuid::uuid4()->toString();
        $merged = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2], 'client_key' => $key]);
        $this->assertSame('merged', $merged['outcomes'][0]['outcome']);
        $audits = $this->countRows('SELECT COUNT(*) FROM audit_events');
        $logs   = $this->countRows('SELECT COUNT(*) FROM document_access_log');

        $again = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2], 'client_key' => $key], $this->now->modify('+1 hour'));
        $this->assertTrue($again['replayed']);
        $this->assertSame('merged', $again['outcomes'][0]['outcome'], 'the outcome it first answered');
        $this->assertSame($merged['grants'][0]['id'], $again['grants'][0]['id']);
        $this->assertSame($audits, $this->countRows('SELECT COUNT(*) FROM audit_events'), 'a replay writes nothing');
        $this->assertSame($logs, $this->countRows('SELECT COUNT(*) FROM document_access_log'));

        // Folder: the second submission extended the first.
        $this->share($this->P, ['specialist_ids' => [$this->G], 'duration' => '7d']);
        $key2     = Uuid::uuid4()->toString();
        $extended = $this->share($this->P, ['specialist_ids' => [$this->G], 'duration' => '30d', 'client_key' => $key2]);
        $this->assertSame('extended', $extended['outcomes'][0]['outcome']);
        $again = $this->share($this->P, ['specialist_ids' => [$this->G], 'duration' => '30d', 'client_key' => strtoupper($key2)]);
        $this->assertTrue($again['replayed']);
        $this->assertSame('extended', $again['outcomes'][0]['outcome']);
        $this->assertSame($extended['grants'][0]['expires_at'], $again['grants'][0]['expires_at'], 'not extended twice');

        // Another body under a merged submission's key still conflicts; and after 24 hours the key is spent.
        foreach ([[['document_ids' => [$this->P3]], $this->now], [['document_ids' => [$this->P2]], $this->now->modify('+25 hours')]] as [$change, $at]) {
            try {
                $this->share($this->P, $change + ['specialist_ids' => [$this->A], 'scope' => 'selected', 'client_key' => $key], $at);
                $this->fail('Must conflict');
            } catch (DomainRefusal $r) {
                $this->assertSame('idempotency_conflict', $r->errorCode());
            }
        }
        $this->assertSame(4, $this->countRows('SELECT COUNT(*) FROM document_access_submissions WHERE patient_id = ?', [$this->P]), 'one record per submission, none per replay');
    }

    public function testARetryOfAShareThatAnsweredARequestIsAReplayNotAClosedRequest(): void
    {
        [$svc, $em] = $this->request();
        $appt = $em->find(Appointment::class, $this->apNext);
        \assert($appt instanceof Appointment);
        $req = (string) $svc->requestAccess($this->doctor($em, $this->A), $appt, $this->userA, null, $this->now)['id'];
        // A folder share already exists, so the answer merges into it.
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '30d']);

        $key   = Uuid::uuid4()->toString();
        $input = ['specialist_ids' => [$this->A], 'duration' => '7d', 'answers_request_id' => $req, 'client_key' => $key];
        $first = $this->share($this->P, $input);
        $this->assertFalse($first['replayed']);
        $this->assertSame('unchanged', $first['outcomes'][0]['outcome']);
        $this->assertSame([$req], $first['approved_request_ids']);
        $notices = $this->countRows('SELECT COUNT(*) FROM staff_notifications');

        $again = $this->share($this->P, $input);
        $this->assertTrue($again['replayed'], 'the request is closed now, but this is the same submission');
        $this->assertSame([$req], $again['approved_request_ids']);
        $this->assertSame($first['grants'][0]['id'], $again['grants'][0]['id']);
        $this->assertSame($notices, $this->countRows('SELECT COUNT(*) FROM staff_notifications'), 'nobody is told twice');

        // A new submission answering the closed request is still refused.
        try {
            $this->share($this->P, ['client_key' => Uuid::uuid4()->toString()] + $input);
            $this->fail('A closed request cannot be answered again');
        } catch (DomainRefusal $r) {
            $this->assertArrayHasKey('answers_request_id', $r->errors);
        }
    }

    public function testRemoveAccessHandlesAFolderAndASelectedShareAndAnEmptiedShareEnds(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A]]);
        $selected = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2]])['grants'][0]['id'];
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), strtoupper($this->P2), strtoupper($this->A), $this->now);

        $this->assertNotContains($this->P2, $this->visible($this->A, $this->P));
        $this->assertSame('emptied', $this->conn()->fetchOne('SELECT end_reason FROM document_access_grants WHERE id = ?', [$selected]));
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM document_access_hidden WHERE cleared_at IS NULL'));

        // Idempotent: again changes nothing and records nothing.
        $logs = $this->countRows('SELECT COUNT(*) FROM document_access_log');
        [$svc, $em] = $this->request();
        $svc->removeDocumentAccess($this->patient($em, $this->P), $this->P2, $this->A, $this->now);
        $this->assertSame($logs, $this->countRows('SELECT COUNT(*) FROM document_access_log'));
    }

    public function testTurningAFolderShareIntoSelectedKeepsExactlyTheChosenDocuments(): void
    {
        $grant = $this->share($this->P, ['specialist_ids' => [$this->A]])['grants'][0]['id'];
        // A stray include row on the folder share (as an older race could leave).
        (new DocumentAccessGrantRepository($this->em()))->addDocuments($grant, [$this->P3], $this->now);

        [$svc, $em] = $this->request();
        $dto = $svc->updateGrant($this->patient($em, $this->P), $grant, ['scope' => 'selected', 'document_ids' => [$this->P1]], $this->now);

        $this->assertSame('selected', $dto['scope']);
        $this->assertSame([$this->P1], $this->conn()->fetchFirstColumn('SELECT document_id FROM document_access_grant_documents WHERE grant_id = ?', [$grant]));
        $this->assertSame([$this->P1], $this->visible($this->A, $this->P), 'never wider than what the patient picked');
    }

    public function testRemovingTheLastDocumentOfASelectedShareEndsItEmptied(): void
    {
        $id = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1]])['grants'][0]['id'];
        [$svc, $em] = $this->request();
        $dto = $svc->updateGrant($this->patient($em, $this->P), $id, ['remove_document_ids' => [$this->P1]], $this->now);

        $this->assertSame('revoked', $dto['status']);
        $this->assertSame('emptied', $dto['end_reason']);
    }

    public function testChangingAnExpiredShareIsGrantEndedAndTheExpiryIsRecordedOnce(): void
    {
        $id    = $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '24h'])['grants'][0]['id'];
        $after = $this->now->modify('+25 hours');
        foreach ([1, 2] as $attempt) {
            try {
                [$svc, $em] = $this->request();
                $svc->updateGrant($this->patient($em, $this->P), $id, ['duration' => '30d'], $after);
                $this->fail('An expired share cannot be changed');
            } catch (DomainRefusal $r) {
                $this->assertSame('grant_ended', $r->errorCode(), "attempt $attempt");
            }
        }
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.expired'"));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'expired'"));
    }

    public function testRevokeIsIdempotentAndUndoRestoresWithinTenMinutes(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1, $this->P2], 'duration' => '30d']);
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '7d']);

        [$svc, $em] = $this->request();
        $stopped = $svc->stopSharing($this->patient($em, $this->P), $this->A, $this->now);
        $this->assertCount(2, $stopped['revoked']);
        $this->assertNotNull($stopped['revoke_batch_id']);
        $this->assertSame(Rules::iso($this->now->modify('+10 minutes')), $stopped['restorable_until']);
        $this->assertSame([], $this->visible($this->A, $this->P));

        [$svc, $em] = $this->request();
        $again = $svc->revokeGrant($this->patient($em, $this->P), $stopped['revoked'][0]['id'], $this->now);
        $this->assertSame('revoked', $again['status'], 'revoking twice answers the ended share');

        $at = $this->now->modify('+5 minutes');
        [$svc, $em] = $this->request();
        $restored = $svc->restore($this->patient($em, $this->P), $stopped['revoked'][0]['id'], $at);
        $this->assertCount(2, $restored['restored']);
        $this->assertSame(['restore'], array_values(array_unique(array_column($restored['restored'], 'source'))));
        $this->assertSame($this->sorted([$this->P1, $this->P2, $this->P3]), $this->visible($this->A, $this->P, $at));

        [$svc, $em] = $this->request();
        $repeat = $svc->restore($this->patient($em, $this->P), $stopped['revoked'][1]['id'], $at);
        $this->assertSame(array_column($restored['restored'], 'id'), array_column($repeat['restored'], 'id'), 'a repeat returns what was restored');

        // A second revoke batch, restored after 11 minutes: too late.
        [$svc, $em] = $this->request();
        $later = $svc->stopSharing($this->patient($em, $this->P), $this->A, $at);
        try {
            [$svc, $em] = $this->request();
            $svc->restore($this->patient($em, $this->P), $later['revoked'][0]['id'], $at->modify('+11 minutes'));
            $this->fail('Undo after 10 minutes must be refused');
        } catch (DomainRefusal $r) {
            $this->assertSame('restore_expired', $r->errorCode());
        }
    }

    public function testRevokeAllEndsEveryPairUnderOneBatch(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A, $this->G]]);
        $this->share($this->P, ['specialist_ids' => [$this->B], 'scope' => 'selected', 'document_ids' => [$this->P1]]);

        $notices = $this->countRows('SELECT COUNT(*) FROM staff_notifications');
        [$svc, $em] = $this->request();
        $all = $svc->revokeAll($this->patient($em, $this->P), $this->now);
        $this->assertCount(3, $all['revoked']);
        $this->assertSame(1, $this->countRows('SELECT COUNT(DISTINCT revoke_batch_id) FROM document_access_grants WHERE revoke_batch_id IS NOT NULL'));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_grants WHERE status = 'active'"));
        $this->assertSame(3, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document_access.revoked'"));
        $this->assertSame($notices, $this->countRows('SELECT COUNT(*) FROM staff_notifications'), 'no doctor is told about a revoke');
    }

    public function testExtendingAndShorteningRebaseTheShareAndOnlyWideningNotifies(): void
    {
        $id = $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '7d'])['grants'][0]['id'];
        $notices = $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE type = 'document_access'");

        [$svc, $em] = $this->request();
        $short = $svc->updateGrant($this->patient($em, $this->P), $id, ['duration' => '24h'], $this->now);
        $this->assertSame('24h', $short['duration']);
        $this->assertSame($notices, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE type = 'document_access'"), 'shortening says nothing');

        $until = $this->now->modify('+20 days')->setTime(0, 0)->modify('+1 day');
        [$svc, $em] = $this->request();
        $long = $svc->updateGrant($this->patient($em, $this->P), $id, ['duration' => 'until', 'expires_at' => $until->format('Y-m-d\TH:i:sP')], $this->now);
        $this->assertSame(Rules::iso($until->modify('-1 second')), $long['until_label_at'], 'an until share is labelled one second before its exclusive end');
        $this->assertSame(Rules::sql($until), $this->conn()->fetchOne('SELECT original_expires_at FROM document_access_grants WHERE id = ?', [$id]));
    }
}
