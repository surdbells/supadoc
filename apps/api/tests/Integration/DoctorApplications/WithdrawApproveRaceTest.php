<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;

/** Spec §2.1, D32: a withdraw and an approval at once — one wins, never "withdrawn with a doctor". */
final class WithdrawApproveRaceTest extends DoctorApplicationsTestCase
{
    public function testWithdrawAndApproveNeverBothWin(): void
    {
        $app    = $this->submitted('ng');
        $staff  = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $body   = $this->approveBody($staff, $app['id']);
        unset($body['expected_status']);
        $access = $this->trackToken($app['reference'], $app['email']);

        $observer = $this->em();
        $observer->getConnection()->executeStatement('SELECT pg_advisory_lock(' . 0x0DA1 . ', hashtext(?))', [$app['id']]);
        $workers = [
            H::startWorker('withdraw-approve-worker.php', ['schema' => self::$schema, 'app' => 'docapp_wa', 'method' => 'POST', 'path' => '/api/public/doctor-applications/track/withdraw', 'body' => ['confirm' => true, 'reason' => 'apply_later'], 'token' => $access]),
            H::startWorker('withdraw-approve-worker.php', ['schema' => self::$schema, 'app' => 'docapp_wa', 'method' => 'POST', 'path' => '/api/doctor-applications/' . $app['id'] . '/approve', 'body' => $body, 'token' => $staff]),
        ];
        try {
            H::awaitLockWaiters($observer, 'docapp_wa', 2);
        } finally {
            $observer->getConnection()->executeStatement('SELECT pg_advisory_unlock(' . 0x0DA1 . ', hashtext(?))', [$app['id']]);
        }
        [$withdraw, $approve] = array_map(static fn (array $w): array => H::finishWorker($w), $workers);

        $status = (string) $this->conn()->fetchOne('SELECT status FROM doctor_applications');
        if ($status === 'approved') {
            $this->assertSame(200, $approve['status'], json_encode($approve));
            $this->assertSame(409, $withdraw['status'], json_encode($withdraw));
            $this->assertSame('not_allowed', $withdraw['body']['errors']['code']);
            $this->assertSame(1, $this->rows('SELECT COUNT(*) FROM specialists'));
        } else {
            $this->assertSame('withdrawn', $status);
            $this->assertSame(200, $withdraw['status'], json_encode($withdraw));
            $this->assertSame(409, $approve['status'], json_encode($approve));
            $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM specialists'), 'never withdrawn with a doctor');
        }
    }
}
