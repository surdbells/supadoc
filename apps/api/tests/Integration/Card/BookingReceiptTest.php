<?php

declare(strict_types=1);

namespace App\Tests\Integration\Card;

use App\Action\Appointment\AcceptFollowUpAction;
use App\Action\Appointment\CreateMyAppointmentAction;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\WalletTransaction;
use App\Domain\Enum\ConsultationType;
use App\Infrastructure\Service\SlotLock;
use App\Tests\Integration\Card\Support\CardHarness;
use DateTimeImmutable;
use DateTimeZone;
use DI\Container;
use Doctrine\ORM\EntityManagerInterface;
use Monolog\Handler\TestHandler;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Card concurrency review #4: the wallet debit that pays for a booking or a
 * follow-up acceptance is emailed only once the booking's transaction has
 * committed — never from inside it (while the doctor's slot lock and the
 * wallet row are held), and never for a debit that transaction then rolled
 * back.
 */
final class BookingReceiptTest extends CardIntegrationTestCase
{
    public function testAWalletBookingIsEmailedOnceItHasCommitted(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('10000.00');
        $this->fundWallet($patientId, '10000.00');

        $app                 = $this->app();
        [$receipts, $atSend] = $this->recordReceipts($app, $patientId);
        $request             = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments')
            ->withAttribute('customer_id', $patientId)
            ->withParsedBody(['specialist_id' => $doctor->getId(), 'scheduled_at' => $slots[0], 'type' => 'video']);
        $res = $app->get(CreateMyAppointmentAction::class)($request, (new ResponseFactory())->createResponse());

        $this->assertSame(201, $res->getStatusCode(), (string) $res->getBody());
        $this->assertSame(1, CardHarness::receipts($receipts), 'one receipt');
        $this->assertSame([1], $atSend->getArrayCopy(), 'sent once the debit was committed (visible to another session)');
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testAWalletFollowUpAcceptanceIsEmailedOnceItHasCommitted(): void
    {
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('20000.00');
        $proposalId                   = $this->proposal($patientId, $doctor, $slots[1]);
        $this->fundWallet($patientId, '10000.00');

        $app                 = $this->app();
        [$receipts, $atSend] = $this->recordReceipts($app, $patientId);
        $request             = (new ServerRequestFactory())->createServerRequest('POST', '/api/portal/appointments/' . $proposalId . '/follow-up/accept')
            ->withAttribute('customer_id', $patientId)
            ->withParsedBody(['payment_method' => 'wallet']);
        $res = $app->get(AcceptFollowUpAction::class)($request, (new ResponseFactory())->createResponse(), ['id' => $proposalId]);

        $this->assertSame(200, $res->getStatusCode(), (string) $res->getBody());
        $this->assertSame(1, CardHarness::receipts($receipts), 'one receipt');
        $this->assertSame([1], $atSend->getArrayCopy(), 'sent once the debit was committed (visible to another session)');
        $this->assertSame(1, $this->postings('appt_debit_' . $proposalId));
        $this->assertSame('0.00', $this->balanceOf($patientId));
    }

    public function testADebitRolledBackWithItsFollowUpSendsNoReceipt(): void
    {
        // The patient accepts at another time, paying from the wallet. Between
        // the re-check under the slot lock and the save, a write that didn't
        // wait for the lock takes that time: the save hits the slot index
        // AFTER the debit posted, and the whole acceptance rolls back.
        [$patientId, $doctor, $slots] = $this->patientAndDoctor('20000.00');
        $proposalId                   = $this->proposal($patientId, $doctor, $slots[1]);
        $other                        = $this->anotherPatient();
        $this->fundWallet($patientId, '50000.00');

        $accept  = [
            'op'             => 'accept',
            'customer_id'    => $patientId,
            'appointment_id' => $proposalId,
            'body'           => ['payment_method' => 'wallet', 'scheduled_at' => $slots[2]],
        ];
        $results = $this->race([$accept], $this->takeSlotWithoutTheLock($other, $doctor, $slots[2]), 'card_it_receipt');
        [$result] = $results;

        $this->assertSame(422, $result['status'] ?? null, json_encode($results));
        $this->assertSame(SlotLock::TAKEN, $result['body']['errors']['scheduled_at']);
        $this->assertSame(0, $result['receipts'], 'no receipt for a debit that was rolled back');
        $this->assertSame('50000.00', $this->balanceOf($patientId), 'nothing charged');
        $this->assertSame(0, $this->countRows('SELECT COUNT(*) FROM wallet_transactions WHERE reference = ?', ['appt_debit_' . $proposalId]));
        $row = $this->em()->getConnection()->fetchAssociative('SELECT status, scheduled_at, payment_status FROM appointments WHERE id = ?', [$proposalId]);
        $this->assertSame('proposed', $row['status'], 'the proposal is as the doctor made it');
        $this->assertSame((new DateTimeImmutable($slots[1]))->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('Y-m-d H:i:s'), $row['scheduled_at']);
    }

    /**
     * Record `$app`'s wallet receipts, and — as each is sent — how many
     * consultation debits of `$patientId` another session sees committed.
     *
     * @return array{0: TestHandler, 1: \ArrayObject<int, int>}
     */
    private function recordReceipts(Container $app, string $patientId): array
    {
        $observer = $this->em('card_it_observer');
        $atSend   = new \ArrayObject();
        $receipts = CardHarness::recordReceipts($app, static function () use ($observer, $patientId, $atSend): void {
            $atSend[] = (int) $observer->getConnection()->fetchOne(
                "SELECT COUNT(*) FROM wallet_transactions WHERE patient_id = ? AND type = ? AND direction = 'debit' AND status = 'success'",
                [$patientId, WalletTransaction::TYPE_CONSULTATION],
            );
        });

        return [$receipts, $atSend];
    }

    /** @return callable(EntityManagerInterface): void booking `$slot` in the open transaction, without the slot lock */
    private function takeSlotWithoutTheLock(string $patientId, Specialist $doctor, string $slot): callable
    {
        return static function (EntityManagerInterface $em) use ($patientId, $doctor, $slot): void {
            $taken = new Appointment($em->find(Patient::class, $patientId), $em->find(Specialist::class, $doctor->getId()), new DateTimeImmutable($slot), ConsultationType::VIDEO);
            $taken->setAmount('20000.00');
            $em->persist($taken);
            $em->flush();
        };
    }
}
