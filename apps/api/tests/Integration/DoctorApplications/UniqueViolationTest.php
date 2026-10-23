<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\Specialist;
use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;
use Monolog\Handler\TestHandler;
use Monolog\Logger;

/** Spec §3.1: unique-index backstops become coded 409s, logged without the database's message (it holds the email). */
final class UniqueViolationTest extends DoctorApplicationsTestCase
{
    private TestHandler $log;

    protected function setUp(): void
    {
        parent::setUp();
        $this->log  = new TestHandler();
        H::$logger  = new Logger('it', [$this->log]);
    }

    protected function tearDown(): void
    {
        H::$logger = null;
        parent::tearDown();
    }

    private function assertNoLeak(): void
    {
        foreach ($this->log->getRecords() as $record) {
            $dump = (string) json_encode([$record->message, $record->context]);
            $this->assertStringNotContainsString('@example.com', $dump);
            $this->assertStringNotContainsString('Key (', $dump);
        }
    }

    public function testTheOpenEmailIndexBehindTheLock(): void
    {
        $this->submitted('ng', 'clash@example.com');
        $second = $this->createDraft('ng', 'clash@example.com');
        $this->fillDraft($second['token'], 'ng');
        $this->verifyEmail($second['token']);
        // Force the race the checks would catch: hide the first from the check by moving it to 'approved'
        // only for the duration of the check is not possible — instead drop the guard by renaming its email
        // for the check and restoring it before the insert would collide.
        $this->conn()->executeStatement("UPDATE doctor_applications SET status = 'rejected' WHERE status = 'submitted'");
        $this->conn()->executeStatement("CREATE OR REPLACE FUNCTION docapp_it_reopen() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN UPDATE doctor_applications SET status = 'submitted' WHERE status = 'rejected'; RETURN NEW; END \$\$");
        $this->conn()->executeStatement('CREATE TRIGGER docapp_it_reopen BEFORE UPDATE OF status ON doctor_applications FOR EACH ROW WHEN (NEW.status = \'submitted\' AND pg_trigger_depth() = 0) EXECUTE FUNCTION docapp_it_reopen()');
        try {
            $res = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $second['token']);
        } finally {
            $this->conn()->executeStatement('DROP TRIGGER IF EXISTS docapp_it_reopen ON doctor_applications');
            $this->conn()->executeStatement('DROP FUNCTION IF EXISTS docapp_it_reopen()');
        }
        $this->assertCode($res, 409, 'duplicate_open_application');
        $this->assertNoLeak();
        $this->assertNotEmpty($this->log->getRecords(), 'the class and the id are logged');
    }

    public function testTheSpecialistApplicationIndexAtApproval(): void
    {
        $app   = $this->submitted('ng', 'approve@example.com');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        // Another profile already claims this application (a forced violation of uniq_specialists_application).
        $em = $this->em();
        $s  = new Specialist('Dr. Squatter', 'Cardiology');
        $s->setApplicationId($app['id']);
        $em->persist($s);
        $em->flush();

        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $this->approveBody($staff, $app['id']));
        $this->assertCode($res, 409, 'status_changed');
        $this->assertSame('under_review', $this->conn()->fetchOne('SELECT status FROM doctor_applications'));
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM specialist_credentials'));
        $this->assertNoLeak();
    }
}
