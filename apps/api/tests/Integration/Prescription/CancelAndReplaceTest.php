<?php

declare(strict_types=1);

namespace App\Tests\Integration\Prescription;

use App\Domain\Entity\Prescription;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Tests\Integration\DocumentSharing\DocShareTestCase;
use DateTimeImmutable;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Cancel and replace (GVM-RX-02) now that "medicines already taken" is no
 * longer on the prescription form: the replacement draft copies the cancelled
 * prescription's form except that line (a new prescription never carries it),
 * while the cancelled prescription keeps its own. On the document-sharing
 * fixtures (doctor A, patient P's completed consultation `apPast`).
 */
final class CancelAndReplaceTest extends DocShareTestCase
{
    public function testTheReplacementDraftLeavesOutMedicinesAlreadyTaken(): void
    {
        $em = $this->em();
        // The shared reset doesn't clear prescriptions.
        $em->getConnection()->executeStatement('DELETE FROM prescriptions');
        // A number from another day: the replacement is numbered from today's counter.
        $rx = new Prescription($this->P, $this->A, $this->apPast, 'GVM-RX-20200101-00001', ClinicTime::today()->modify('+30 days'));
        $rx->setConsultation('Acute sinusitis', 'CA01', 'Metformin 500 mg twice daily', 'no');
        $rx->setItems([[
            'rxcui' => '308191', 'name' => 'amoxicillin 500 MG Oral Capsule', 'dose' => '1 capsule', 'route' => 'Oral',
            'frequency' => 'Every 8 hours', 'duration' => '5 days', 'quantity' => '15', 'repeats' => 0,
            'no_substitute' => false, 'instructions' => 'After food',
        ]]);
        $rx->setAdvice('Drink plenty of fluids', null, null, null);
        $rx->send(['name' => 'Dr. Ada Alpha'], ['name' => 'Pat Patient'], 'saved', null, new DateTimeImmutable());
        $em->persist($rx);
        $em->flush();
        $id = $rx->getId();

        // One "request": the doctor cancels it and asks for a replacement.
        $c   = $this->container();
        $req = $c->get(EntityManagerInterface::class);
        $old = $req->find(Prescription::class, $id);
        \assert($old instanceof Prescription);
        [, $replacement] = $c->get(PrescriptionService::class)->cancel($old, $this->doctor($req, $this->A), 'Wrong strength', true);
        $this->assertInstanceOf(Prescription::class, $replacement);

        // As stored (a fresh session).
        $read  = $this->em();
        $draft = $read->find(Prescription::class, $replacement->getId());
        \assert($draft instanceof Prescription);
        $this->assertTrue($draft->isDraft());
        $this->assertSame($id, $draft->getReplacesId());
        $this->assertNull($draft->getCurrentMedications(), 'a new prescription has no "medicines already taken"');
        // The rest of the form is carried over.
        $this->assertSame('Acute sinusitis', $draft->getReason());
        $this->assertSame('CA01', $draft->getIcdCode());
        $this->assertSame('no', $draft->getPregnancyStatus());
        $this->assertSame('Drink plenty of fluids', $draft->getAdvice());
        $this->assertSame(['308191'], array_column($draft->getItems(), 'rxcui'));

        // The cancelled prescription is a record: it keeps what it said.
        $cancelled = $read->find(Prescription::class, $id);
        \assert($cancelled instanceof Prescription);
        $this->assertSame(Prescription::STATUS_CANCELLED, $cancelled->effectiveStatus());
        $this->assertSame('Metformin 500 mg twice daily', $cancelled->getCurrentMedications());
    }
}
