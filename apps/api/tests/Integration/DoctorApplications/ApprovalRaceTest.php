<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Tests\Integration\DoctorApplications\Support\ApplicationsHarness as H;

/** Spec §3.6: two reviewers approving at once create exactly one doctor and one login. */
final class ApprovalRaceTest extends DoctorApplicationsTestCase
{
    public function testTwoConcurrentApprovalsCreateOneSpecialist(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $body = $this->approveBody($staff, $app['id']);
        unset($body['expected_status']);

        $observer = $this->em();
        $observer->getConnection()->executeStatement('SELECT pg_advisory_lock(' . 0x0DA1 . ', hashtext(?))', [$app['id']]);
        $job     = ['schema' => self::$schema, 'app' => 'docapp_approve', 'method' => 'POST', 'path' => '/api/doctor-applications/' . $app['id'] . '/approve', 'body' => $body, 'token' => $staff];
        $workers = [H::startWorker('approve-worker.php', $job), H::startWorker('approve-worker.php', $job)];
        try {
            H::awaitLockWaiters($observer, 'docapp_approve', 2);
        } finally {
            $observer->getConnection()->executeStatement('SELECT pg_advisory_unlock(' . 0x0DA1 . ', hashtext(?))', [$app['id']]);
        }
        $results  = array_map(static fn (array $w): array => H::finishWorker($w), $workers);
        $statuses = array_map(static fn (array $r): int => (int) ($r['status'] ?? 0), $results);
        sort($statuses);

        $this->assertSame([200, 409], $statuses, json_encode($results));
        $loser = $results[0]['status'] === 409 ? $results[0] : $results[1];
        $this->assertSame('not_allowed', $loser['body']['errors']['code']);
        $this->assertSame(1, $this->rows('SELECT COUNT(*) FROM specialists'));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM users WHERE email = 'ada.obi@example.com'"));
        $this->assertSame(6, $this->rows('SELECT COUNT(*) FROM specialist_credentials'));
    }
}
