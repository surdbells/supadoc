<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\PaymentIntent;
use App\Domain\Entity\Specialist;
use App\Infrastructure\Persistence\RawIndexes;
use App\Infrastructure\Service\SlotLock;
use DateTimeImmutable;
use DateTimeZone;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Tools\SchemaTool;
use Doctrine\ORM\Tools\ToolEvents;

/**
 * Booking atomicity: two bookings of one doctor's time at the same moment
 * produce one appointment and one charge — the other is refused with nothing
 * stored or charged (a card payment for it goes to the wallet). Backstopped by
 * the partial unique indexes.
 */
final class SlotRaceTest extends CardIntegrationTestCase
{
    public function testTwoPatientsBookingOneSlotAtOnceGetOneBookingAndOneCharge(): void
    {
        [$first, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $second                   = $this->anotherPatient();
        $this->fundWallet($first, '10000.00');
        $this->fundWallet($second, '10000.00');

        $book = static fn (string $patientId): array => [
            'op'          => 'book',
            'customer_id' => $patientId,
            'body'        => ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video'],
        ];
        // Both have seen the slot open; each now waits on the doctor's slot lock.
        $results = $this->race([$book($first), $book($second)], $this->holdDoctor($doctor), 'card_it_slot');

        $statuses = array_column($results, 'status');
        sort($statuses);
        $this->assertSame([201, 409], $statuses, json_encode($results));
        $loser = $results[0]['status'] === 409 ? $results[0] : $results[1];
        $this->assertSame(SlotLock::TAKEN, $loser['body']['errors']['scheduled_at']);

        $this->assertSame(1, $this->liveAt($doctor, $slots[0]), 'one booking of that time');
        $balances = [$this->balanceOf($first), $this->balanceOf($second)];
        sort($balances);
        $this->assertSame(['0.00', '10000.00'], $balances, 'only the winner was charged');
    }

    public function testTheSlotLockAloneKeepsOneBookingWithoutTheIndex(): void
    {
        // The lock + re-check is the real guard; the index is only a backstop.
        // Without the index, two bookings of one time at once still make one.
        [$first, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $second                   = $this->anotherPatient();
        $this->fundWallet($first, '10000.00');
        $this->fundWallet($second, '10000.00');
        $this->em()->getConnection()->executeStatement('DROP INDEX ' . RawIndexes::SLOT);
        try {
            $book = static fn (string $patientId): array => [
                'op'          => 'book',
                'customer_id' => $patientId,
                'body'        => ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[1], 'type' => 'video'],
            ];
            $results = $this->race([$book($first), $book($second)], $this->holdDoctor($doctor), 'card_it_slot_noindex');
        } finally {
            RawIndexes::ensure($this->em()->getConnection());
        }

        $statuses = array_column($results, 'status');
        sort($statuses);
        $this->assertSame([201, 409], $statuses, json_encode($results));
        $this->assertSame(1, $this->liveAt($doctor, $slots[1]));
        $this->assertTrue(RawIndexes::exists($this->em()->getConnection(), RawIndexes::SLOT), 'the backstop is back for the other tests');
    }

    public function testACardBookingThatLosesTheSlotIsCreditedToTheWallet(): void
    {
        [$walletPatient, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $cardPatient                      = $this->anotherPatient();
        $this->fundWallet($walletPatient, '10000.00');
        $ref = $this->checkout($cardPatient, PaymentIntent::PURPOSE_BOOKING, ['specialist_id' => $doctor->getId()], '10000.00', '10000.00', markPaid: true)->getReference();

        $body    = ['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video'];
        $results = $this->race([
            ['op' => 'book', 'customer_id' => $walletPatient, 'body' => $body],
            ['op' => 'book', 'customer_id' => $cardPatient, 'body' => $body + ['payment_reference' => $ref]],
        ], $this->holdDoctor($doctor), 'card_it_slot_card');

        $this->assertSame(1, $this->liveAt($doctor, $slots[0]), json_encode($results));
        [$walletResult, $cardResult] = $results;
        if ($cardResult['status'] === 201) {
            // The card booking won: the wallet booking was refused and not charged.
            $this->assertSame(409, $walletResult['status']);
            $this->assertSame('10000.00', $this->balanceOf($walletPatient));
            $this->assertSame(PaymentIntent::STATUS_CONSUMED, $this->intentRow($ref)['status']);
        } else {
            // The wallet booking won: the card payment went to the card patient's wallet, said so.
            $this->assertSame(201, $walletResult['status']);
            $this->assertSame(409, $cardResult['status'], json_encode($cardResult));
            $this->assertSame('credited_to_wallet', $cardResult['body']['errors']['card_payment']);
            $this->assertSame('10000.00', $this->balanceOf($cardPatient));
            $this->assertSame('0.00', $this->balanceOf($walletPatient));
            $this->assertSame(PaymentIntent::STATUS_CREDITED, $this->intentRow($ref)['status']);
        }
    }

    public function testTheIndexesRefuseWhatSlipsPastTheLock(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $em      = $this->em();
        $patient = $em->find(Patient::class, $patientId);
        $doctor  = $em->find(Specialist::class, $doctor->getId());
        $at      = new DateTimeImmutable($slots[0]);

        $em->persist($this->appointment($patient, $doctor, $at, 'vma_index_one'));
        $em->flush();
        // A cancelled booking of the same time doesn't hold it.
        $cancelled = $this->appointment($patient, $doctor, $at, null);
        $cancelled->transitionTo(\App\Domain\Enum\AppointmentStatus::CANCELLED);
        $em->persist($cancelled);
        $em->flush();

        try {
            $em->persist($this->appointment($patient, $doctor, $at, null));
            $em->flush();
            $this->fail('a second live booking of the same time must be refused');
        } catch (UniqueConstraintViolationException $e) {
            $this->assertTrue(SlotLock::isSlotTaken($e));
        }

        $em = $this->em();
        try {
            $em->persist($this->appointment($em->find(Patient::class, $patientId), $em->find(Specialist::class, $doctor->getId()), new DateTimeImmutable($slots[1]), 'vma_index_one'));
            $em->flush();
            $this->fail('one card payment reference on two appointments must be refused');
        } catch (UniqueConstraintViolationException $e) {
            $this->assertStringContainsString(RawIndexes::PAYMENT_REFERENCE, $e->getMessage());
            $this->assertFalse(SlotLock::isSlotTaken($e));
        }
    }

    public function testTheIndexStepReportsRowsThatBreakItAndChangesNothing(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor();
        $em   = $this->em();
        $conn = $em->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('DROP INDEX ' . RawIndexes::SLOT);
            $patient = $em->find(Patient::class, $patientId);
            $doc     = $em->find(Specialist::class, $doctor->getId());
            $em->persist($a = $this->appointment($patient, $doc, new DateTimeImmutable($slots[2]), null));
            $em->persist($b = $this->appointment($patient, $doc, new DateTimeImmutable($slots[2]), null));
            $em->flush();

            $report = RawIndexes::ensure($conn);
            $this->assertSame('exists', $report[RawIndexes::PAYMENT_REFERENCE]['status']);
            $this->assertSame('blocked', $report[RawIndexes::SLOT]['status']);
            $this->assertCount(1, $report[RawIndexes::SLOT]['violations']);
            $this->assertSame(2, (int) $report[RawIndexes::SLOT]['violations'][0]['bookings']);
            $this->assertStringContainsString($a->getId(), $report[RawIndexes::SLOT]['violations'][0]['ids']);
            $this->assertStringContainsString($b->getId(), $report[RawIndexes::SLOT]['violations'][0]['ids']);
            $this->assertFalse(RawIndexes::exists($conn, RawIndexes::SLOT), 'not created over the duplicates');
            $this->assertSame(2, (int) $conn->fetchOne('SELECT COUNT(*) FROM appointments WHERE scheduled_at = ?', [(new DateTimeImmutable($slots[2]))->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('Y-m-d H:i:s')]), 'nothing deleted');
        } finally {
            $conn->rollBack(); // the index and the class's other rows are back as they were
        }
        $this->assertTrue(RawIndexes::exists($this->em()->getConnection(), RawIndexes::SLOT));
    }

    public function testTheSchemaToolLeavesTheIndexesAlone(): void
    {
        // The deploy's orm:schema-tool:update drops every index the mapping
        // doesn't declare. RawIndexes, its listener, declares these two as the
        // database has them, so the update neither drops nor re-creates them.
        $em       = $this->em();
        $tool     = new SchemaTool($em);
        $metadata = $em->getMetadataFactory()->getAllMetadata();
        $touching = static fn (array $sql): array => array_values(array_filter(
            $sql,
            static fn (string $s): bool => str_contains($s, RawIndexes::SLOT) || str_contains($s, RawIndexes::PAYMENT_REFERENCE),
        ));
        $this->assertSame([], $touching($tool->getUpdateSchemaSql($metadata)));

        // It is the listener that keeps them: without it, the update would drop both.
        $events = $em->getEventManager();
        foreach ($events->getListeners(ToolEvents::postGenerateSchema) as $listener) {
            $events->removeEventListener([ToolEvents::postGenerateSchema], $listener);
        }
        $drops = array_filter($touching($tool->getUpdateSchemaSql($metadata)), static fn (string $s): bool => str_starts_with($s, 'DROP INDEX'));
        $this->assertCount(2, $drops);
    }

    /** @return callable(EntityManagerInterface): void holding the doctor's slot lock */
    private function holdDoctor(Specialist $doctor): callable
    {
        return static function (EntityManagerInterface $em) use ($doctor): void {
            (new SlotLock($em))->lockDoctor($doctor->getId());
        };
    }

    private function liveAt(Specialist $doctor, string $slot): int
    {
        return $this->countRows(
            "SELECT COUNT(*) FROM appointments WHERE specialist_id = ? AND scheduled_at = ? AND status IN ('pending','confirmed','rescheduled') AND deleted_at IS NULL",
            // Stored as the slot's instant on the process clock.
            [$doctor->getId(), (new DateTimeImmutable($slot))->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('Y-m-d H:i:s')],
        );
    }

    private function appointment(Patient $patient, Specialist $doctor, DateTimeImmutable $at, ?string $reference): Appointment
    {
        $appointment = new Appointment($patient, $doctor, $at, \App\Domain\Enum\ConsultationType::VIDEO);
        $appointment->setAmount('10000.00');
        if ($reference !== null) {
            $appointment->payByCard($reference);
        }

        return $appointment;
    }
}
