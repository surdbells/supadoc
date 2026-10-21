<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Middleware\ClockRepairGateMiddleware;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;

/**
 * The scheduling pause covers exactly the routes that write a scheduled time or
 * an availability slot (spec §2.7) — and not the remedies the clock repair asks
 * for (a back-office cancel, the doctor's proposal withdrawal).
 */
final class RoutesClockGateTest extends TestCase
{
    /** [method, path inside its group, action class] */
    private const GATED = [
        ['post', '/appointments', 'Action\Appointment\CreateAppointmentAction'],
        ['post', '/doctor/appointments/{id}/reschedule', 'Action\Doctor\RescheduleDoctorAppointmentAction'],
        ['post', '/doctor/appointments/{id}/follow-up', 'Action\Doctor\ProposeFollowUpAction'],
        ['post', '/doctor/availability', 'Action\Doctor\AddAvailabilityAction'],
        ['post', '/doctor/availability/block', 'Action\Doctor\BlockAvailabilityAction'],
        ['delete', '/doctor/availability/{id}', 'Action\Doctor\DeleteAvailabilityAction'],
        ['post', '/appointments', 'Action\Appointment\CreateMyAppointmentAction'],
        ['post', '/appointments/pay-init', 'Action\Appointment\InitAppointmentPaymentAction'],
        ['post', '/appointments/{id}/reschedule', 'Action\Appointment\ReschedulePortalAppointmentAction'],
        ['post', '/appointments/{id}/follow-up/accept', 'Action\Appointment\AcceptFollowUpAction'],
    ];

    private const GATE = 'ClockRepairGateMiddleware::class';

    private function routes(): string
    {
        return (string) file_get_contents(__DIR__ . '/../../config/routes.php');
    }

    /** The registration statement, from `$group-><method>('<path>', <Class>::class)` to its `;`. */
    private function statement(string $method, string $path, string $class): string
    {
        $source = $this->routes();
        $start  = strpos($source, sprintf("\$group->%s('%s', %s::class)", $method, $path, $class));
        $this->assertNotFalse($start, "route {$method} {$path} -> {$class}");
        $end = strpos($source, ';', $start);
        $this->assertNotFalse($end);

        return substr($source, $start, $end - $start + 1);
    }

    public function testEverySchedulingWriteIsGated(): void
    {
        foreach (self::GATED as [$method, $path, $class]) {
            $this->assertStringContainsString(self::GATE, $this->statement($method, $path, $class), "{$method} {$path} ({$class})");
        }
        $this->assertSame(10, substr_count($this->routes(), self::GATE), 'those 10 routes and no others');
    }

    public function testRbacRunsBeforeTheGateOnTheStaffBooking(): void
    {
        // Slim runs the middleware added LAST first.
        $statement = $this->statement('post', '/appointments', 'Action\Appointment\CreateAppointmentAction');
        $gate      = strpos($statement, '->add(\App\Infrastructure\Middleware\\' . self::GATE);
        $rbac      = strpos($statement, '->add(new RbacMiddleware(');
        $this->assertNotFalse($gate);
        $this->assertNotFalse($rbac);
        $this->assertLessThan($rbac, $gate);
    }

    public function testTheRemediesAreNotGated(): void
    {
        $this->assertStringNotContainsString(self::GATE, $this->statement('post', '/doctor/appointments/{id}/follow-up/withdraw', 'Action\Doctor\WithdrawFollowUpAction'));
        $source = $this->routes();
        $at     = strpos($source, 'Action\Appointment\UpdateAppointmentStatusAction::class');
        $this->assertNotFalse($at);
        $this->assertStringNotContainsString(self::GATE, substr($source, $at, strpos($source, ';', $at) - $at));
    }

    public function testTheGateResolvesFromTheContainer(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $container = (new ContainerBuilder())->addDefinitions(__DIR__ . '/../../config/container.php')->build();
        $this->assertInstanceOf(ClockRepairGateMiddleware::class, $container->get(ClockRepairGateMiddleware::class));
        DoctrineEntityManagerFactory::reset();
    }
}
