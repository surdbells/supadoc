<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Lab\LabRequestService;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Service\JwtService;
use DI\Container;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;

/**
 * Signed PDF links (lab spec §2.4): a lab link never opens a prescription and
 * a prescription link never opens a lab request (both refused before any
 * lookup); the viewer is re-checked — a patient before accepting, or staff
 * without `labs.manage`, get nothing.
 */
final class LabRequestLinkTest extends TestCase
{
    use LabFixtures;

    private function container(): Container
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');

        $container = $builder->build();
        // A secret of its own (the unit suite loads no .env).
        $container->set(JwtService::class, new JwtService('lab-link-test-secret-that-is-32-bytes-long!!', 900, 43200));

        return $container;
    }

    public function testLabAndPrescriptionLinksNeverCross(): void
    {
        $c   = $this->container();
        $jwt = $c->get(JwtService::class);
        $lab = $jwt->issueFileLink(['k' => 'lab_request', 'lr' => '44444444-4444-4444-8444-444444444444', 'vt' => 'patient', 'vid' => 'p', 'dl' => 0], 900);
        $rx  = $jwt->issueFileLink(['rx' => '44444444-4444-4444-8444-444444444444', 'vt' => 'patient', 'vid' => 'p', 'dl' => 0], 900);

        $this->assertNull($c->get(PrescriptionService::class)->resolveLink($lab), 'a lab token is no prescription link');
        $this->assertNull($c->get(LabRequestService::class)->resolveLink($rx), 'an Rx token is no lab link');
        $this->assertNull(LabRequestService::linkRequestId($jwt->verifyFileLink($rx)));
        $this->assertSame('44444444-4444-4444-8444-444444444444', LabRequestService::linkRequestId($jwt->verifyFileLink($lab)));
        $this->assertNull(LabRequestService::linkRequestId(null));
        $this->assertNull(LabRequestService::linkRequestId(['k' => 'prescription', 'lr' => 'x']));
    }

    public function testTheViewerIsCheckedAgain(): void
    {
        $r       = self::labRequest();
        $patient = ['vt' => 'patient', 'vid' => strtoupper($r->getPatientId())];
        $never   = static fn (string $id): bool => false;
        $always  = static fn (string $id): bool => true;
        $this->assertFalse(LabRequestService::linkViewerAllowed($patient, $r, $always), 'a patient before accepting');
        $this->assertTrue(LabRequestService::linkViewerAllowed(['vt' => 'doctor', 'vid' => $r->getSpecialistId()], $r, $never), 'the requesting doctor');
        $this->assertFalse(LabRequestService::linkViewerAllowed(['vt' => 'doctor', 'vid' => '55555555-5555-4555-8555-555555555555'], $r, $always), 'another doctor');
        $this->assertFalse(LabRequestService::linkViewerAllowed(['vt' => 'staff', 'vid' => 'u-1'], $r, $never), 'staff without labs.manage');
        $this->assertTrue(LabRequestService::linkViewerAllowed(['vt' => 'staff', 'vid' => 'u-1'], $r, $always));
        $this->assertFalse(LabRequestService::linkViewerAllowed(['vt' => 'admin', 'vid' => 'u-1'], $r, $always));
        $this->assertFalse(LabRequestService::linkViewerAllowed(['vt' => 'staff', 'vid' => ''], $r, $always));

        $accepted = self::labRequest([], false, null, 'booked');
        $this->assertTrue(LabRequestService::linkViewerAllowed(['vt' => 'patient', 'vid' => $accepted->getPatientId()], $accepted, $never), 'after accepting');
    }
}
