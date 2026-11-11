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

        [$clean, $errors] = VitalsForm::normalize(['temperature' => '60', 'heart_rate' => 'fast', 'oxygen_saturation' => '101'], $this->now());
        $this->assertSame('60', $clean['temperature'], 'above the usual range is accepted');
        $this->assertArrayNotHasKey('temperature', $errors);
        $this->assertArrayHasKey('heart_rate', $errors);
        $this->assertSame('Oxygen level must be a number between 50 and 100', $errors['oxygen_saturation']);

        [, $errors] = VitalsForm::normalize(['temperature' => '29'], $this->now());
        $this->assertSame('Temperature must be a number of at least 30 °C', $errors['temperature']);
    }

    public function testBloodPressureMustBeSystolicOverDiastolic(): void
    {
        foreach (['80/120', '120', '120/80/60', '120/20', '120-80', '90/90', '40/30', '170/180'] as $bad) {
            [, $errors] = VitalsForm::normalize(['blood_pressure' => $bad], $this->now());
            $this->assertSame(VitalsForm::BP_FORMAT_ERROR, $errors['blood_pressure'] ?? null, "blood_pressure={$bad}");
        }
        $this->assertSame('120/80', VitalsForm::bloodPressure(' 120/ 80 '));
        $this->assertSame('120/80', VitalsForm::bloodPressure('0120/080'), 'leading zeros are dropped');
    }

    public function testValuesAboveTheUsualRangeAreAccepted(): void
    {
        [$clean, $errors] = VitalsForm::normalize([
            'temperature' => '46', 'heart_rate' => '260', 'respiratory_rate' => '61', 'blood_sugar' => '41.25',
            'weight' => '401', 'height' => '251', 'blood_pressure' => '300 / 170',
        ], $this->now());
        $this->assertSame([], $errors);
        $this->assertSame('46', $clean['temperature']);
        $this->assertSame('260', $clean['heart_rate']);
        $this->assertSame('61', $clean['respiratory_rate']);
        $this->assertSame('41.3', $clean['blood_sugar']);
        $this->assertSame('401', $clean['weight']);
        $this->assertSame('251', $clean['height']);
        $this->assertSame('300/170', $clean['blood_pressure']);
    }

    public function testTheSanityCeilingIsRejectedWithAClearMessage(): void
    {
        [$clean, $errors] = VitalsForm::normalize(['temperature' => '10000', 'heart_rate' => '1e400', 'weight' => '9999'], $this->now());
        $this->assertSame('Temperature is too large to be a reading. Check what you entered.', $errors['temperature']);
        $this->assertSame('Heart rate is too large to be a reading. Check what you entered.', $errors['heart_rate']);
        $this->assertSame('9999', $clean['weight']);

        foreach (['1000/80', '120/1000', '99999/80'] as $bad) {
            [, $errors] = VitalsForm::normalize(['blood_pressure' => $bad], $this->now());
            $this->assertSame('Each blood pressure number must be 3 digits or fewer. Check what you entered.', $errors['blood_pressure'] ?? null, $bad);
        }
        [$clean, $errors] = VitalsForm::normalize(['blood_pressure' => '999/998'], $this->now());
        $this->assertSame([], $errors);
        $this->assertSame('999/998', $clean['blood_pressure']);
    }

    public function testBoundedReadingsKeepTheirMaximum(): void
    {
        [, $errors] = VitalsForm::normalize(['oxygen_saturation' => '101', 'pain_score' => '11'], $this->now());
        $this->assertSame('Oxygen level must be a number between 50 and 100', $errors['oxygen_saturation']);
        $this->assertSame('Pain score must be a number between 0 and 10', $errors['pain_score']);
        [$clean, $errors] = VitalsForm::normalize(['oxygen_saturation' => '100', 'pain_score' => '10'], $this->now());
        $this->assertSame([], $errors);
        $this->assertSame(['oxygen_saturation' => '100', 'pain_score' => '10'], $clean);
    }

    public function testIsAboveRangeAndUsualMax(): void
    {
        $this->assertTrue(VitalsForm::isAboveRange('temperature', '45.1'));
        $this->assertFalse(VitalsForm::isAboveRange('temperature', '45'));
        $this->assertTrue(VitalsForm::isAboveRange('blood_pressure', '261/80'));
        $this->assertTrue(VitalsForm::isAboveRange('blood_pressure', '200/161'));
        $this->assertFalse(VitalsForm::isAboveRange('blood_pressure', '260/160'));
        $this->assertFalse(VitalsForm::isAboveRange('oxygen_saturation', '101'), 'bounded readings never are');
        $this->assertFalse(VitalsForm::isAboveRange('temperature', 'hot'));
        $this->assertFalse(VitalsForm::isAboveRange('mood', '99'));
        $this->assertTrue(VitalsForm::isAboveRange('bmi', '90.1'));

        $this->assertSame('45', VitalsForm::usualMax('temperature'));
        $this->assertSame('260/160', VitalsForm::usualMax('blood_pressure'));
        $this->assertSame('400', VitalsForm::usualMax('weight'));
        $this->assertNull(VitalsForm::usualMax('pain_score'));

        $this->assertSame(9999, VitalsForm::hardMax('temperature'));
        $this->assertSame(100, VitalsForm::hardMax('oxygen_saturation'));
        $this->assertSame(999, VitalsForm::hardMax('blood_pressure'));
        $this->assertFalse(VitalsForm::acceptsAbove('pain_score'));
        $this->assertTrue(VitalsForm::acceptsAbove('bmi'));
    }

    public function testDerivedBmiAbove90IsKept(): void
    {
        [$values] = VitalsService::validatePatientInput(['readings' => ['weight' => '300', 'height' => '150']], [], $this->now());
        $this->assertSame('133.3', $values['bmi']);

        $cache = ['height' => ['value' => '150', 'taken_at' => '2026-10-01T00:00:00+00:00']];
        [$values] = VitalsService::validatePatientInput(['readings' => ['weight' => '300']], $cache, $this->now());
        $this->assertSame('133.3', $values['bmi'], 'weight alone, with the height on file');
    }

    public function testPrescriptionFormAcceptsAboveRangeReadings(): void
    {
        [$clean, $errors] = PrescriptionForm::normalize(
            ['readings' => ['temperature' => '46', 'blood_pressure' => '300/170']],
            static fn (string $rxcui): ?Drug => null,
            new DateTimeImmutable('2026-10-14'),
        );
        $this->assertArrayNotHasKey('readings.temperature', $errors);
        $this->assertArrayNotHasKey('readings.blood_pressure', $errors);
        $this->assertSame('46', $clean['readings']['temperature']);
        $this->assertSame('300/170', $clean['readings']['blood_pressure']);
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
        $this->assertNull(VitalsForm::bmi(9999, 30), 'beyond the sanity ceiling');
        $this->assertSame('22.9', VitalsForm::bmi(70, 175));
        $this->assertSame('133.3', VitalsForm::bmi(300, 150), 'above the usual 90 is still worked out');
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
        $this->assertSame(['min' => 50, 'max' => 260, 'max_hard' => 999], $fields['blood_pressure']['systolic']);
        $this->assertSame(['min' => 30, 'max' => 160, 'max_hard' => 999], $fields['blood_pressure']['diastolic']);
        $this->assertNull($fields['blood_pressure']['max_hard']);
        $this->assertTrue($fields['blood_pressure']['accepts_above']);
        $this->assertSame(45, $fields['temperature']['max'], 'max stays the usual entry maximum');
        $this->assertSame(9999, $fields['temperature']['max_hard']);
        $this->assertTrue($fields['temperature']['accepts_above']);
        $this->assertSame(100, $fields['oxygen_saturation']['max_hard']);
        $this->assertFalse($fields['oxygen_saturation']['accepts_above']);
        $this->assertSame(10, $fields['pain_score']['max_hard']);
        $this->assertFalse($fields['pain_score']['accepts_above']);
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
            'readings' => ['temperature' => '20', 'mood' => 'great'],
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
