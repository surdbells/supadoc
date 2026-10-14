<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Call\JoinCallAction;
use App\Action\Patient\MyVitalsAction;
use App\Action\Patient\MyVitalsHistoryAction;
use App\Action\Patient\RecordMyVitalsAction;
use App\Domain\Entity\Drug;
use App\Domain\Entity\Patient;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\VitalReadingRepository;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Prescription\PrescriptionForm;
use App\Infrastructure\Prescription\PrescriptionService;
use App\Infrastructure\Vitals\VitalsForm;
use App\Infrastructure\Vitals\VitalsService;
use DateTimeImmutable;
use DI\ContainerBuilder;
use PHPUnit\Framework\TestCase;

/** Patient vitals: the shared reading rules, the patient's own input, the latest list and the reminder. */
final class VitalsTest extends TestCase
{
    private function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('2026-10-14T12:00:00+00:00');
    }

    // ----- VitalsForm -----

    public function testReadingsAreRangeCheckedAndBmiIsWorkedOut(): void
    {
        [$clean, $errors] = VitalsForm::normalize([
            'blood_pressure' => '148 / 92', 'weight' => '72', 'height' => '168', 'temperature' => '37.85', 'pain_score' => '',
        ], $this->now());
        $this->assertSame([], $errors);
        $this->assertSame('148/92', $clean['blood_pressure']);
        $this->assertSame('25.5', $clean['bmi']);
        $this->assertSame('37.9', $clean['temperature'], 'one decimal place');
        $this->assertArrayNotHasKey('pain_score', $clean, 'blank boxes are skipped');

        [, $errors] = VitalsForm::normalize(['temperature' => '60', 'heart_rate' => 'fast', 'oxygen_saturation' => '101'], $this->now());
        $this->assertSame('Temperature must be a number between 30 and 45', $errors['temperature']);
        $this->assertArrayHasKey('heart_rate', $errors);
        $this->assertArrayHasKey('oxygen_saturation', $errors);
    }

    public function testBloodPressureMustBeSystolicOverDiastolic(): void
    {
        foreach (['80/120', '120', '120/80/60', '300/80', '120/20', '120-80', '90/90'] as $bad) {
            [, $errors] = VitalsForm::normalize(['blood_pressure' => $bad], $this->now());
            $this->assertArrayHasKey('blood_pressure', $errors, "blood_pressure={$bad}");
        }
        $this->assertSame('120/80', VitalsForm::bloodPressure(' 120/ 80 '));
    }

    public function testSourceAndTakenAtAreChecked(): void
    {
        [, $errors] = VitalsForm::normalize(['temperature' => '37', 'source' => 'tv', 'taken_at' => '2026-10-15T12:00:00+00:00'], $this->now());
        $this->assertArrayHasKey('source', $errors);
        $this->assertArrayHasKey('taken_at', $errors, 'not in the future');

        // A doctor source is not one the patient may choose, and vice versa.
        [, $errors] = VitalsForm::normalize(['temperature' => '37', 'source' => 'clinic'], $this->now(), VitalsForm::PATIENT_SOURCES);
        $this->assertArrayHasKey('source', $errors);
        [, $errors] = VitalsForm::normalize(['temperature' => '37', 'source' => 'self_reported'], $this->now(), VitalsForm::DOCTOR_SOURCES);
        $this->assertArrayHasKey('source', $errors);
    }

    public function testBmiOutsideItsRangeIsNotWorkedOut(): void
    {
        $this->assertNull(VitalsForm::bmi(0.5, 250));
        $this->assertSame('22.9', VitalsForm::bmi(70, 175));
    }

    public function testPrescriptionFormKeepsItsReadingRules(): void
    {
        $catalogue = static fn (string $rxcui): ?Drug => null;
        [$clean, $errors] = PrescriptionForm::normalize(['readings' => [
            'blood_pressure' => '148/92', 'weight' => '72', 'height' => '168', 'source' => 'video', 'taken_at' => '2026-10-14T09:00:00+00:00',
        ]], $catalogue, new DateTimeImmutable('2026-10-14'));
        $this->assertSame([], $errors);
        $this->assertSame('25.5', $clean['readings']['bmi']);
        $this->assertSame('video', $clean['readings']['source']);

        [, $errors] = PrescriptionForm::normalize(['readings' => ['blood_pressure' => '80/120', 'source' => 'self_reported']], $catalogue, new DateTimeImmutable('2026-10-14'));
        $this->assertArrayHasKey('readings.blood_pressure', $errors, 'errors keep the readings. prefix');
        $this->assertArrayHasKey('readings.source', $errors, 'a doctor never records "self-reported"');
        $this->assertSame(VitalsForm::READINGS, PrescriptionForm::READINGS);
    }

    public function testFieldsCatalogueDescribesTheForm(): void
    {
        $fields = array_column(VitalsForm::fields(), null, 'key');
        $this->assertSame(array_keys(VitalsForm::READINGS), array_keys($fields));
        $this->assertSame('°C', $fields['temperature']['unit']);
        $this->assertSame(['min' => 50, 'max' => 260], $fields['blood_pressure']['systolic']);
        $this->assertTrue($fields['bmi']['derived']);
        $this->assertSame(0.1, $fields['temperature']['step']);
    }

    // ----- the patient's own readings -----

    public function testPatientInputDefaultsToSelfReportedNow(): void
    {
        [$values, $takenAt, $source] = VitalsService::validatePatientInput(['readings' => ['heart_rate' => '72']], [], $this->now());
        $this->assertSame(['heart_rate' => '72'], $values);
        $this->assertSame('self_reported', $source);
        $this->assertEquals($this->now(), $takenAt);

        [, , $source] = VitalsService::validatePatientInput(['readings' => ['heart_rate' => '72'], 'source' => 'patient_device'], [], $this->now());
        $this->assertSame('patient_device', $source);
    }

    public function testPatientInputErrorsUseTheRequestFieldNames(): void
    {
        $errors = $this->patientErrors([
            'readings' => ['temperature' => '50', 'mood' => 'great'],
            'taken_at' => '2026-10-20T08:00:00+00:00',
            'source'   => 'lab',
        ]);
        $this->assertArrayHasKey('readings.temperature', $errors);
        $this->assertSame('This is not a reading we record', $errors['readings.mood']);
        $this->assertArrayHasKey('taken_at', $errors);
        $this->assertArrayHasKey('source', $errors);

        $this->assertArrayHasKey('readings', $this->patientErrors([]));
        $this->assertArrayHasKey('readings', $this->patientErrors(['readings' => ['weight' => '  ']]));
        $this->assertArrayHasKey('taken_at', $this->patientErrors(['readings' => ['weight' => '70'], 'taken_at' => '2024-01-01T00:00:00+00:00']), 'more than a year ago');
        $this->assertArrayHasKey('taken_at', $this->patientErrors(['readings' => ['weight' => '70'], 'taken_at' => 'yesterday-ish']));
    }

    public function testAPhoneClockAFewMinutesFastIsAccepted(): void
    {
        [, $takenAt] = VitalsService::validatePatientInput(['readings' => ['weight' => '70'], 'taken_at' => '2026-10-14T12:03:00+00:00'], [], $this->now());
        $this->assertSame('2026-10-14T12:03:00+00:00', $takenAt->format(DATE_ATOM));
    }

    public function testPatientInputRejectsValuesThatAreNotText(): void
    {
        // Never "now" / self-reported / silently dropped — each is a 422 on its own field.
        $errors = $this->patientErrors([
            'readings' => ['weight' => [70], 'pain_score' => true, 'blood_pressure' => ['sys' => 120], 'heart_rate' => '72'],
            'taken_at' => [],
            'source'   => ['patient_device'],
        ]);
        $this->assertSame('Enter a number for weight', $errors['readings.weight']);
        $this->assertSame('Enter a number for pain score', $errors['readings.pain_score']);
        $this->assertSame('Enter blood pressure as systolic/diastolic, e.g. 120/80', $errors['readings.blood_pressure']);
        $this->assertArrayHasKey('taken_at', $errors);
        $this->assertArrayHasKey('source', $errors);
        $this->assertArrayNotHasKey('readings.heart_rate', $errors);

        $this->assertArrayHasKey('taken_at', $this->patientErrors(['readings' => ['weight' => '70'], 'taken_at' => 1760443200]));
        $this->assertArrayHasKey('source', $this->patientErrors(['readings' => ['weight' => '70'], 'source' => false]));

        // Numbers, nulls and a null taken_at / source are all fine.
        [$values, $takenAt, $source] = VitalsService::validatePatientInput(
            ['readings' => ['weight' => 70.5, 'heart_rate' => 72, 'temperature' => null], 'taken_at' => null, 'source' => null],
            [],
            $this->now(),
        );
        $this->assertSame(['heart_rate' => '72', 'weight' => '70.5'], $values);
        $this->assertEquals($this->now(), $takenAt);
        $this->assertSame('self_reported', $source);
    }

    public function testHistoryQueryIsChecked(): void
    {
        $this->assertSame([null, VitalsService::HISTORY_LIMIT], VitalsService::validateHistoryQuery(null, null));
        $this->assertSame([null, VitalsService::HISTORY_LIMIT], VitalsService::validateHistoryQuery('', ' '));
        $this->assertSame(['weight', 10], VitalsService::validateHistoryQuery(' weight ', '10'));

        foreach ([
            [['weight'], null, 'key'],          // ?key[]=weight
            [['a' => 'weight'], null, 'key'],   // ?key[a]=weight
            ['mood', null, 'key'],
            [null, ['5'], 'limit'],             // ?limit[]=5
            [null, '0', 'limit'],
            [null, (string) (VitalsService::HISTORY_MAX + 1), 'limit'],
            [null, '2.5', 'limit'],
        ] as [$key, $limit, $field]) {
            try {
                VitalsService::validateHistoryQuery($key, $limit);
                $this->fail('expected a validation error for ' . json_encode([$key, $limit]));
            } catch (ValidationException $e) {
                $this->assertArrayHasKey($field, $e->getErrors(), json_encode([$key, $limit]));
            }
        }
    }

    public function testNewWeightUsesTheHeightOnFileForBmi(): void
    {
        $cache = ['height' => ['value' => '175', 'unit' => 'cm', 'taken_at' => '2025-01-01T00:00:00+00:00', 'source' => 'clinic']];
        [$values] = VitalsService::validatePatientInput(['readings' => ['weight' => '70']], $cache, $this->now());
        $this->assertSame('22.9', $values['bmi']);

        [$values] = VitalsService::validatePatientInput(['readings' => ['weight' => '70']], [], $this->now());
        $this->assertArrayNotHasKey('bmi', $values, 'no height anywhere — no BMI');
    }

    // ----- latest list + reminder -----

    public function testLatestListLabelsWhoRecordedEachReadingAndStaleness(): void
    {
        $cache = [
            'temperature'    => ['value' => '37.2', 'unit' => '°C', 'taken_at' => '2026-10-13T08:00:00+00:00', 'source' => 'self_reported', 'recorded_by' => 'patient'],
            // Written before the history existed: no recorded_by — it came from a prescription.
            'blood_pressure' => ['value' => '120/80', 'unit' => 'mmHg', 'taken_at' => '2026-09-01T08:00:00+00:00', 'source' => 'video'],
            'unknown_thing'  => ['value' => '1', 'unit' => '', 'taken_at' => '2026-10-13T08:00:00+00:00', 'source' => 'video'],
        ];
        $list = array_column(VitalsService::latestList($cache, $this->now()), null, 'key');

        $this->assertSame(['temperature', 'blood_pressure'], array_keys($list), 'catalogue order, unknown keys dropped');
        $this->assertSame('patient', $list['temperature']['recorded_by']);
        $this->assertSame('Self-reported', $list['temperature']['source_label']);
        $this->assertFalse($list['temperature']['stale']);
        $this->assertSame('doctor', $list['blood_pressure']['recorded_by']);
        $this->assertSame('Seen on video', $list['blood_pressure']['source_label']);
        $this->assertTrue($list['blood_pressure']['stale'], 'older than 7 days');
    }

    public function testReminderIsDueWhenNeverRecordedOrStale(): void
    {
        $never = VitalsService::reminder(null, $this->now());
        $this->assertTrue($never['due']);
        $this->assertSame('never', $never['reason']);
        $this->assertSame(7, $never['stale_after_days']);

        $fresh = VitalsService::reminder(new DateTimeImmutable('2026-10-08T12:00:00+00:00'), $this->now());
        $this->assertFalse($fresh['due'], 'six days old is still fresh');
        $this->assertNull($fresh['reason']);
        $this->assertSame(6, $fresh['days_old']);

        $stale = VitalsService::reminder(new DateTimeImmutable('2026-10-01T12:00:00+00:00'), $this->now());
        $this->assertTrue($stale['due']);
        $this->assertSame('stale', $stale['reason']);
        $this->assertSame(13, $stale['days_old']);
        $this->assertSame('2026-10-01T12:00:00+00:00', $stale['last_taken_at']);
    }

    public function testReminderLooksAtTheNewestReadingOfAnyType(): void
    {
        $cache = [
            'weight' => ['value' => '70', 'unit' => 'kg', 'taken_at' => '2026-01-01T08:00:00+00:00', 'source' => 'clinic'],
            'heart_rate' => ['value' => '70', 'unit' => 'beats/min', 'taken_at' => '2026-10-12T08:00:00+00:00', 'source' => 'self_reported'],
        ];
        $this->assertSame('2026-10-12T08:00:00+00:00', VitalsService::lastTakenAt($cache)?->setTimezone(new \DateTimeZone('UTC'))->format(DATE_ATOM));
        $this->assertFalse(VitalsService::reminder(VitalsService::lastTakenAt($cache), $this->now())['due']);
        $this->assertNull(VitalsService::lastTakenAt([]));
    }

    public function testRecordingCachesSourceAndRecordedBy(): void
    {
        $patient = new Patient('vitals@example.test', 'Ada', 'Obi');
        $patient->recordVitals(['weight' => ['value' => '70', 'unit' => 'kg', 'taken_at' => '2026-10-14T08:00:00+00:00', 'source' => 'self_reported', 'recorded_by' => 'patient']]);
        // An older doctor reading never replaces the patient's newer one.
        $patient->recordVitals(['weight' => ['value' => '72', 'unit' => 'kg', 'taken_at' => '2026-10-01T08:00:00+00:00', 'source' => 'clinic', 'recorded_by' => 'doctor']]);
        $this->assertSame('70', $patient->getLatestVitals()['weight']['value']);
        $this->assertSame('patient', $patient->getLatestVitals()['weight']['recorded_by']);
    }

    // ----- wiring -----

    public function testHistoryQueryCompilesAndServicesResolve(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();

        $sql = $container->get(VitalReadingRepository::class)
            ->historyQuery('00000000-0000-0000-0000-000000000000', 'weight')
            ->getQuery()
            ->getSQL();
        $this->assertStringContainsStringIgnoringCase('vital_readings', $sql);
        $this->assertStringContainsStringIgnoringCase('reading_key', $sql);
        $this->assertStringContainsStringIgnoringCase('ORDER BY', $sql);

        foreach ([VitalsService::class, PrescriptionService::class, MyVitalsAction::class, RecordMyVitalsAction::class, MyVitalsHistoryAction::class, JoinCallAction::class] as $id) {
            $this->assertIsObject($container->get($id), "could not resolve $id");
        }
    }

    /** @return array<string,string> */
    private function patientErrors(array $body): array
    {
        try {
            VitalsService::validatePatientInput($body, [], $this->now());
        } catch (ValidationException $e) {
            return $e->getErrors();
        }
        $this->fail('expected a validation error');
    }
}
