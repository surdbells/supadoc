<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Appointment\InitAppointmentPaymentAction;
use App\Domain\Entity\AppSetting;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AppSettingRepository;
use App\Domain\Repository\NotificationRepository;
use App\Domain\Repository\PatientRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AppointmentCheckout;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\FollowUpService;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\PaystackService;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\WalletService;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * A ₦0 consultation books, cancels and checks out without touching money: the
 * wallet ledger only takes positive postings, so a free booking posts nothing
 * (it used to 500 on the ledger's "greater than zero" guard), cancelling it
 * refunds nothing, and the card checkout refuses to start for it.
 */
final class FreeBookingTest extends TestCase
{
    private function appointment(string $fee): Appointment
    {
        $specialist = new Specialist('Dr. Grace Bell', 'General Practice');
        $specialist->setConsultationFee($fee);

        return new Appointment(new Patient('ada@example.test', 'Ada', 'Obi'), $specialist, new DateTimeImmutable('+1 day'));
    }

    /** Any wallet call on this fails loudly — it has no state at all. */
    private function untouchedWallet(): WalletService
    {
        return (new \ReflectionClass(WalletService::class))->newInstanceWithoutConstructor();
    }

    public function testOnlyANothingToPayBookingIsFree(): void
    {
        self::assertTrue($this->appointment('0.00')->isFree());
        self::assertTrue($this->appointment('0')->isFree());
        self::assertFalse($this->appointment('5000.00')->isFree());

        // A free doctor with a paid guest is not free.
        $withGuest = $this->appointment('0.00');
        $withGuest->setAmount('5000.00');
        self::assertFalse($withGuest->isFree());
    }

    public function testBookingAFreeConsultationPostsNothing(): void
    {
        $appointment = $this->appointment('0.00');

        self::assertNull((new AppointmentPaymentService($this->untouchedWallet()))->chargeForBooking($appointment));
        self::assertSame('paid', $appointment->getPaymentStatus(), 'nothing is owed');
    }

    public function testCancellingAFreeConsultationRefundsNothing(): void
    {
        $appointment = $this->appointment('0.00');
        $payments    = new AppointmentPaymentService($this->untouchedWallet());
        $payments->chargeForBooking($appointment);

        self::assertNull($payments->refundForCancellation($appointment));
        self::assertSame('paid', $appointment->getPaymentStatus(), 'never reads as refunded');
    }

    public function testTheLedgerStillRefusesZeroPostings(): void
    {
        // Why the guards above exist: a ₦0 posting is not a valid ledger entry.
        $this->expectException(\InvalidArgumentException::class);
        $this->untouchedWallet()->normalise('0.00');
    }

    public function testCardCheckoutIsRefusedForAFreeConsultation(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $em  = DoctrineEntityManagerFactory::create();
        $uow = $em->getUnitOfWork();

        // Everything the action loads, found in the identity map (no database).
        $patient    = new Patient('ada@example.com', 'Ada', 'Obi');
        $specialist = new Specialist('Dr. Grace Bell', 'General Practice');
        $specialist->setStatus(SpecialistStatus::APPROVED); // bookable
        $specialist->setConsultationFee('0.00');
        $uow->registerManaged($patient, ['id' => $patient->getId()], []);
        $uow->registerManaged($specialist, ['id' => $specialist->getId()], []);
        foreach (['currency' => 'NGN', 'guest_fee' => '5000'] as $key => $value) {
            $uow->registerManaged(new AppSetting($key, $value), ['key' => $key], []);
        }

        $pricing      = new PricingService(new AppSettingRepository($em));
        $appointments = new AppointmentRepository($em);
        $action       = new InitAppointmentPaymentAction(
            new PatientRepository($em),
            new SpecialistRepository($em),
            $appointments,
            $pricing,
            new AppointmentCheckout(
                new PaystackService('', '', ''), // not configured: reaching it would be a 503
                $pricing,
                new PatientNotifier(new NotificationRepository($em)),
                // No checkout may even be recorded for a free consultation: a state-less service fails loudly.
                (new \ReflectionClass(\App\Infrastructure\Service\PaymentIntentService::class))->newInstanceWithoutConstructor(),
            ),
            // Only a follow-up is priced by it — never reached for a plain booking.
            (new \ReflectionClass(FollowUpService::class))->newInstanceWithoutConstructor(),
        );
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/portal/appointments/pay-init')
            ->withAttribute('customer_id', $patient->getId())
            ->withParsedBody(['specialist_id' => $specialist->getId(), 'guest_count' => 0]);

        $res  = $action($request, (new ResponseFactory())->createResponse());
        $body = json_decode((string) $res->getBody(), true);

        self::assertSame(422, $res->getStatusCode());
        self::assertSame('free', $body['errors']['payment']);
    }
}
