<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Patient;
use App\Domain\Entity\User;
use App\Infrastructure\Document\DocumentAccessNotifier;
use App\Infrastructure\Document\DocumentAccessSweeper;
use App\Infrastructure\Document\PrivateDocumentsNotice;
use App\Infrastructure\Persistence\RawIndexes;

/**
 * prod-migrate step 12 (PrivateDocumentsNotice) and the sweeper's run
 * (spec §7.2 "Migration" and "Sweeper").
 */
final class MigrationAndSweeperTest extends DocShareTestCase
{
    public function testWithSharingOffTheNoticesWait(): void
    {
        $_ENV['DOC_SHARING_ENABLED'] = 'false';
        $report = PrivateDocumentsNotice::run($this->conn(), false, $this->now);

        $this->assertFalse($report['ran']);
        $this->assertSame('skipped (sharing not enabled)', $report['documents_private_notice']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM notifications'));
    }

    public function testEachPatientWithDocumentsAndEachActiveDoctorIsToldOnce(): void
    {
        // P has a file attached to the upcoming consultation with A; Q has a private one.
        $this->conn()->executeStatement('UPDATE medical_documents SET appointment_id = ? WHERE id = ?', [$this->apNext, $this->P1]);
        $em      = $this->em();
        $deleted = new Patient('gone-' . bin2hex(random_bytes(3)) . '@example.test', 'Gone', 'Away');
        $deleted->softDelete();
        $em->persist($deleted);
        $inactive = new User('inactive-' . bin2hex(random_bytes(3)) . '@example.test', 'In', 'Active');
        $inactive->setRoles(['doctor']);
        $inactive->setSpecialistId($this->B);
        $inactive->setActive(false);
        $em->persist($inactive);
        $admin = new User('admin-' . bin2hex(random_bytes(3)) . '@example.test', 'Ad', 'Min');
        $admin->setRoles(['admin']);
        $em->persist($admin);
        $em->flush();
        $this->newDocument($deleted->getId(), 'Deleted patient file');

        // Dry run: same work, nothing kept.
        $dry = PrivateDocumentsNotice::run($this->conn(), true, $this->now);
        $this->assertSame('would notify 1 + 1', $dry['documents_private_notice']);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM notifications'));

        $run = PrivateDocumentsNotice::run($this->conn(), false, $this->now);
        $this->assertSame('sent', $run['documents_private_notice']);
        $this->assertSame(1, $run['patients_upcoming']);
        $this->assertSame(1, $run['patients_generic']);
        $this->assertSame(2, $run['doctors'], 'active doctor logins with a specialist only');

        $p = $this->conn()->fetchAssociative('SELECT type, title, body, link FROM notifications WHERE patient_id = ?', [$this->P]);
        $this->assertSame(['system', DocumentAccessNotifier::RELEASE_TITLE, DocumentAccessNotifier::RELEASE_BODY_UPCOMING, '/dashboard/appointments/' . $this->apNext], [$p['type'], $p['title'], $p['body'], $p['link']]);
        $q = $this->conn()->fetchAssociative('SELECT body, link FROM notifications WHERE patient_id = ?', [$this->Q]);
        $this->assertSame([DocumentAccessNotifier::RELEASE_BODY_GENERIC, '/dashboard/documents/sharing'], [$q['body'], $q['link']]);
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM notifications WHERE patient_id = ?', [$deleted->getId()]));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND type = 'document_access'", [$this->userA]));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM staff_notifications WHERE user_id IN (?, ?)', [$inactive->getId(), $admin->getId()]));

        // A second run sends nothing; neither does one after the setting is lost.
        $again = PrivateDocumentsNotice::run($this->conn(), false, $this->now);
        $this->assertSame('already sent', $again['documents_private_notice']);
        $this->assertSame('already sent', $again['documents_private_doctor_notice']);
        $this->conn()->executeStatement("DELETE FROM app_settings WHERE setting_key LIKE 'prod_migrate.documents_private%'");
        PrivateDocumentsNotice::run($this->conn(), false, $this->now);
        $this->assertSame(2, $this->countRows('SELECT COUNT(*) FROM notifications'));
        $this->assertSame(2, $this->countRows('SELECT COUNT(*) FROM staff_notifications'));
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM document_access_grants'), 'nothing is ever shared by the release');
    }

    public function testTheSweeperCountsAndASecondConcurrentRunIsSkipped(): void
    {
        $this->share($this->P, ['specialist_ids' => [$this->A], 'duration' => '24h']);
        $this->share($this->P, ['specialist_ids' => [$this->G], 'scope' => 'selected', 'document_ids' => [$this->P1]]);
        $later = $this->now->modify('+25 hours');

        // Another run holds the sweep lock.
        $holder = $this->conn();
        $holder->executeQuery('SELECT pg_advisory_lock(' . DocumentAccessSweeper::SWEEP_LOCK . ', 1)');
        try {
            $skipped = $this->container()->get(DocumentAccessSweeper::class)->run($later);
            $this->assertTrue($skipped['skipped']);
        } finally {
            $holder->executeQuery('SELECT pg_advisory_unlock(' . DocumentAccessSweeper::SWEEP_LOCK . ', 1)');
        }

        $this->conn()->executeStatement('DELETE FROM medical_documents WHERE id = ?', [$this->P1]);
        $run = $this->container()->get(DocumentAccessSweeper::class)->run($later);
        $this->assertFalse($run['skipped']);
        $this->assertSame(1, $run['expired']);
        $this->assertSame(1, $run['emptied'], 'a selected share whose only document is gone');
        $this->assertSame(0, $run['active_grants']);
        $this->assertSame(0, $run['pending_requests']);
        $this->assertSame(0, $run['errors']);
    }

    public function testThePartialUniqueIndexesExist(): void
    {
        foreach ([RawIndexes::DOC_ACTIVE_FOLDER, RawIndexes::DOC_CLIENT_KEY, RawIndexes::DOC_HIDDEN_OPEN, RawIndexes::DOC_REQUEST_PENDING, RawIndexes::DOC_BLOCK_OPEN] as $index) {
            $this->assertTrue(RawIndexes::exists($this->conn(), $index), $index);
        }
        $this->assertSame('exists', RawIndexes::ensure($this->conn(), true)[RawIndexes::DOC_ACTIVE_FOLDER]['status']);
        $this->assertSame(Rules::CONSENT_VERSION, '2026-10.1');
    }
}
