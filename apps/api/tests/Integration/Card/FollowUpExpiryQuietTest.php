<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Domain\Document\DocumentSharingRules;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Infrastructure\Service\FollowUpService;
use DateTimeImmutable;

/**
 * The cron's first run works through a backlog: a follow-up proposal that
 * expired more than FollowUpService::EXPIRY_NOTIFY_WITHIN_DAYS days ago is
 * closed quietly (audited, no messages to the patient or the doctor); a recent
 * one is closed and both sides are told, as before.
 */
final class FollowUpExpiryQuietTest extends CardIntegrationTestCase
{
    /** A doctor login, so the doctor's in-app notices have somewhere to go. */
    private function doctorLogin(Specialist $doctor): string
    {
        $em   = $this->em();
        $user = new User('fu-quiet-' . bin2hex(random_bytes(4)) . '@example.test', 'Doc', 'Tor');
        $user->setRoles(['doctor']);
        $user->setSpecialistId($doctor->getId());
        $em->persist($user);
        $em->flush();

        return $user->getId();
    }

    private function doctorNotices(string $userId): int
    {
        return $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE user_id = ? AND title = 'Follow-up expired'", [$userId]);
    }

    private function expiredProposal(string $patientId, Specialist $doctor, string $slot, string $expiredAgo): string
    {
        $id = $this->proposal($patientId, $doctor, $slot);
        $this->em()->getConnection()->executeStatement(
            'UPDATE appointments SET expires_at = ? WHERE id = ?',
            [DocumentSharingRules::sql(new DateTimeImmutable($expiredAgo)), $id],
        );

        return $id;
    }

    /** @return array<string,mixed> */
    private function closed(string $id): array
    {
        $row = $this->em()->getConnection()->fetchAssociative(
            "SELECT a.status, a.follow_up_outcome, (SELECT e.metadata->>'quiet' FROM audit_events e
                     WHERE e.action = 'appointment.follow_up_expired' AND e.resource_id = a.id ORDER BY e.created_at DESC LIMIT 1) AS quiet
               FROM appointments a WHERE a.id = ?",
            [$id],
        );
        $this->assertIsArray($row);

        return $row;
    }

    public function testAnExpiryOlderThanThreeDaysClosesQuietly(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $login = $this->doctorLogin($doctor);
        $old   = $this->expiredProposal($patientId, $doctor, $slots[0], '-4 days');

        $this->assertGreaterThanOrEqual(1, $this->app()->get(FollowUpService::class)->expireDue(new DateTimeImmutable()));
        $this->assertSame(['status' => 'cancelled', 'follow_up_outcome' => 'expired', 'quiet' => 'true'], $this->closed($old));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM notifications WHERE patient_id = ? AND title = 'Follow-up proposal closed'", [$patientId]));
        $this->assertSame(0, $this->doctorNotices($login));
    }

    public function testARecentExpiryIsNotifiedAsBefore(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $login  = $this->doctorLogin($doctor);
        $recent = $this->expiredProposal($patientId, $doctor, $slots[1], '-1 hour');

        $this->assertGreaterThanOrEqual(1, $this->app()->get(FollowUpService::class)->expireDue(new DateTimeImmutable()));
        $this->assertSame(['status' => 'cancelled', 'follow_up_outcome' => 'expired', 'quiet' => 'false'], $this->closed($recent));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM notifications WHERE patient_id = ? AND title = 'Follow-up proposal closed'", [$patientId]));
        $this->assertSame(1, $this->doctorNotices($login));
    }
}
