<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestItem;
use App\Domain\Entity\LabRequestResult;
use App\Domain\Lab\LabCatalogue;
use App\Domain\Lab\LabRequestForm;
use App\Domain\Lab\LabRequestRules;
use DateTimeImmutable;
use Ramsey\Uuid\Uuid;

/**
 * In-memory lab requests for the unit tests: a valid form for the bundled
 * catalogue, overridden per test, turned into a LabRequest with its items.
 */
trait LabFixtures
{
    private static ?LabCatalogue $catalogue = null;

    protected static function catalogue(): LabCatalogue
    {
        return self::$catalogue ??= new LabCatalogue(LabCatalogue::defaultPath());
    }

    /** @param array<string,mixed> $over @return array<string,mixed> */
    protected static function labBody(array $over = []): array
    {
        return $over + [
            'client_key'        => Uuid::uuid4()->toString(),
            'catalogue_version' => LabCatalogue::VERSION,
            'patient_id'        => '11111111-1111-4111-8111-111111111111',
            'priority'          => 'routine',
            'purpose'           => 'diagnosis',
            'clinical_question' => 'Suspected iron-deficiency anaemia',
            'history'           => 'Fatigue for 3 weeks',
            'medication'        => 'Paracetamol',
            'allergies'         => 'Penicillin',
            'clinical'          => ['fasting' => false, 'infection_alerts' => ['hiv'], 'transfusion_3m' => false],
            'items'             => [['code' => 'FBC']],
            'attest'            => true,
            'signature'         => ['mode' => 'saved'],
        ];
    }

    /**
     * @param array<string,mixed> $over
     */
    protected static function labRequest(array $over = [], bool $asks = false, ?DateTimeImmutable $sentAt = null, string $status = 'awaiting_consent'): LabRequest
    {
        [$form, $errors] = LabRequestForm::check(self::labBody($over), $asks, self::catalogue());
        if ($errors !== []) {
            throw new \LogicException('Bad fixture: ' . json_encode($errors));
        }
        $sentAt ??= LabRequestRules::now();
        $r = new LabRequest(
            Uuid::uuid4()->toString(),
            'GVM-REQ-20261104-00012',
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            null,
            null,
            Uuid::uuid4()->toString(),
            str_repeat('a', 64),
            $form,
            LabCatalogue::VERSION,
            ['id' => '22222222-2222-4222-8222-222222222222', 'name' => 'Dr. James Smith', 'specialty' => 'Cardiologist', 'qualifications' => 'MBBS', 'mdcn_number' => '12345', 'registration_label' => 'MDCN number'],
            ['name' => 'Chika Osuji', 'reference' => 'P-11111111', 'email' => 'chika@example.test', 'date_of_birth' => '4 Nov 1971', 'dob_iso' => '1971-11-04', 'sex' => 'Female', 'age' => '55'],
            'saved',
            'lab-signatures/x.bin',
            Uuid::uuid4()->toString(),
            LabRequestRules::validity($sentAt),
            $sentAt,
        );
        foreach ($form['items'] as $n => $snap) {
            $r->addItem(new LabRequestItem($r, $n + 1, $snap));
        }
        $now = $sentAt->modify('+1 minute');
        if (in_array($status, ['booked', 'in_lab', 'result_ready'], true)) {
            $r->markAccepted(['version' => LabRequestRules::CONSENT_VERSION, 'tests' => true, 'pays_lab' => true, 'lab_disclosure' => true, 'share_results' => true], true, null, null, $now);
        }
        if (in_array($status, ['in_lab', 'result_ready'], true)) {
            $r->markSampleGiven($now);
        }
        if ($status === 'result_ready') {
            $r->addResult(new LabRequestResult($r, Uuid::uuid4()->toString(), $r->itemIds(), true, $now));
            $r->addResultCounts($now);
        }
        if ($status === 'declined') {
            $r->markDeclined(null, $now);
        }
        if ($status === 'cancelled') {
            $r->markCancelled('No longer needed', $now);
        }

        return $r;
    }
}
