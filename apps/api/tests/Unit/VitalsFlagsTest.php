<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\VitalReading;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Vitals\UpcomingConsultations;
use App\Infrastructure\Vitals\VitalsFlags;
use App\Infrastructure\Vitals\VitalsForm;
use App\Infrastructure\Vitals\VitalsService;
use DateTimeImmutable;
use DI\ContainerBuilder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** What each reading means (VitalsFlags), and the reminder's "consultation coming up" reason. */
final class VitalsFlagsTest extends TestCase
{
    private const ATTENTION = VitalsFlags::SEEK_ATTENTION;
    private const URGENT    = VitalsFlags::SEEK_URGENT_ATTENTION;

    private function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('2026-10-14T12:00:00+00:00');
    }

    /** @return iterable<string, array{string, string, string, string, ?string}> key, value, level, label, advice */
    public static function boundaries(): iterable
    {
        // Temperature (°C)
        yield 'temp 34.9' => ['temperature', '34.9', 'critical', 'Very low', self::URGENT];
        yield 'temp 35.0' => ['temperature', '35.0', 'low', 'Low', null];
        yield 'temp 35.9' => ['temperature', '35.9', 'low', 'Low', null];
        yield 'temp 36.0' => ['temperature', '36', 'normal', 'Normal', null];
        yield 'temp 37.5' => ['temperature', '37.5', 'normal', 'Normal', null];
        yield 'temp 37.6' => ['temperature', '37.6', 'elevated', 'Elevated', null];
        yield 'temp 37.9' => ['temperature', '37.9', 'elevated', 'Elevated', null];
        yield 'temp 38.0' => ['temperature', '38', 'high', 'High', self::ATTENTION];
        yield 'temp 39.4' => ['temperature', '39.4', 'high', 'High', self::ATTENTION];
        yield 'temp 39.5' => ['temperature', '39.5', 'critical', 'Very high', self::URGENT];

        // Heart rate (beats/min)
        yield 'hr 39' => ['heart_rate', '39', 'critical', 'Very low', self::URGENT];
        yield 'hr 40' => ['heart_rate', '40', 'low', 'Low', null];
        yield 'hr 49' => ['heart_rate', '49', 'low', 'Low', null];
        yield 'hr 50' => ['heart_rate', '50', 'normal', 'Normal', null];
        yield 'hr 100' => ['heart_rate', '100', 'normal', 'Normal', null];
        yield 'hr 101' => ['heart_rate', '101', 'elevated', 'Elevated', null];
        yield 'hr 120' => ['heart_rate', '120', 'elevated', 'Elevated', null];
        yield 'hr 121' => ['heart_rate', '121', 'high', 'High', self::ATTENTION];
        yield 'hr 130' => ['heart_rate', '130', 'high', 'High', self::ATTENTION];
        yield 'hr 131' => ['heart_rate', '131', 'critical', 'Very high', self::URGENT];

        // Oxygen (%)
        yield 'spo2 100' => ['oxygen_saturation', '100', 'normal', 'Normal', null];
        yield 'spo2 95' => ['oxygen_saturation', '95', 'normal', 'Normal', null];
        yield 'spo2 94' => ['oxygen_saturation', '94', 'low', 'Low', null];
        yield 'spo2 92' => ['oxygen_saturation', '92', 'low', 'Low', null];
        yield 'spo2 91' => ['oxygen_saturation', '91', 'critical', 'Very low', self::URGENT];

        // Blood pressure (mmHg) — the worse number decides
        yield 'bp 120/80' => ['blood_pressure', '120/80', 'normal', 'Normal', null];
        yield 'bp 90/60' => ['blood_pressure', '90/60', 'normal', 'Normal', null];
        yield 'bp 129/84' => ['blood_pressure', '129/84', 'normal', 'Normal', null];
        yield 'bp 130/80' => ['blood_pressure', '130/80', 'elevated', 'Elevated', null];
        yield 'bp 139/84' => ['blood_pressure', '139/84', 'elevated', 'Elevated', null];
        yield 'bp 120/85' => ['blood_pressure', '120/85', 'elevated', 'Elevated', null];
        yield 'bp 120/89' => ['blood_pressure', '120/89', 'elevated', 'Elevated', null];
        yield 'bp 140/80' => ['blood_pressure', '140/80', 'high', 'High', self::ATTENTION];
        yield 'bp 179/80' => ['blood_pressure', '179/80', 'high', 'High', self::ATTENTION];
        yield 'bp 120/90' => ['blood_pressure', '120/90', 'high', 'High', self::ATTENTION];
        yield 'bp 150/119' => ['blood_pressure', '150/119', 'high', 'High', self::ATTENTION];
        yield 'bp 180/100' => ['blood_pressure', '180/100', 'critical', 'Very high', self::URGENT];
        yield 'bp 170/120' => ['blood_pressure', '170/120', 'critical', 'Very high', self::URGENT];
        yield 'bp 89/70' => ['blood_pressure', '89/70', 'low', 'Low', null];
        yield 'bp 110/59' => ['blood_pressure', '110/59', 'low', 'Low', null];
        yield 'bp high beats low' => ['blood_pressure', '145/55', 'high', 'High', self::ATTENTION];
        yield 'bp elevated beats low' => ['blood_pressure', '132/55', 'elevated', 'Elevated', null];
        yield 'bp spaced' => ['blood_pressure', ' 128 / 88 ', 'elevated', 'Elevated', null];

        // Blood sugar (mmol/L)
        yield 'sugar 2.9' => ['blood_sugar', '2.9', 'critical', 'Very low', self::URGENT];
        yield 'sugar 3.0' => ['blood_sugar', '3.0', 'low', 'Low', null];
        yield 'sugar 3.9' => ['blood_sugar', '3.9', 'low', 'Low', null];
        yield 'sugar 4.0' => ['blood_sugar', '4', 'normal', 'Normal', null];
        yield 'sugar 7.8' => ['blood_sugar', '7.8', 'normal', 'Normal', null];
        yield 'sugar 7.9' => ['blood_sugar', '7.9', 'elevated', 'Elevated', null];
        yield 'sugar 11.0' => ['blood_sugar', '11', 'elevated', 'Elevated', null];
        yield 'sugar 11.1' => ['blood_sugar', '11.1', 'high', 'High', self::ATTENTION];
        yield 'sugar 16.6' => ['blood_sugar', '16.6', 'high', 'High', self::ATTENTION];
        yield 'sugar 16.7' => ['blood_sugar', '16.7', 'critical', 'Very high', self::URGENT];

        // Breathing rate (breaths/min)
        yield 'rr 7' => ['respiratory_rate', '7', 'critical', 'Very low', self::URGENT];
        yield 'rr 8' => ['respiratory_rate', '8', 'low', 'Low', null];
        yield 'rr 11' => ['respiratory_rate', '11', 'low', 'Low', null];
        yield 'rr 12' => ['respiratory_rate', '12', 'normal', 'Normal', null];
        yield 'rr 20' => ['respiratory_rate', '20', 'normal', 'Normal', null];
        yield 'rr 21' => ['respiratory_rate', '21', 'elevated', 'Elevated', null];
        yield 'rr 24' => ['respiratory_rate', '24', 'elevated', 'Elevated', null];
        yield 'rr 25' => ['respiratory_rate', '25', 'high', 'High', self::ATTENTION];
        yield 'rr 29' => ['respiratory_rate', '29', 'high', 'High', self::ATTENTION];
        yield 'rr 30' => ['respiratory_rate', '30', 'critical', 'Very high', self::URGENT];

        // BMI (kg/m²) — never "seek medical attention"
        yield 'bmi 18.4' => ['bmi', '18.4', 'low', 'Low', null];
        yield 'bmi 18.5' => ['bmi', '18.5', 'normal', 'Normal', null];
        yield 'bmi 24.9' => ['bmi', '24.9', 'normal', 'Normal', null];
        yield 'bmi 25' => ['bmi', '25', 'elevated', 'Elevated', null];
        yield 'bmi 29.9' => ['bmi', '29.9', 'elevated', 'Elevated', null];
        yield 'bmi 30' => ['bmi', '30', 'high', 'High', null];
        yield 'bmi 45' => ['bmi', '45', 'high', 'High', null];

        // Pain (0–10) — severe has no advice either
        yield 'pain 0' => ['pain_score', '0', 'normal', 'None', null];
        yield 'pain 1' => ['pain_score', '1', 'normal', 'Mild', null];
        yield 'pain 3' => ['pain_score', '3', 'normal', 'Mild', null];
        yield 'pain 4' => ['pain_score', '4', 'elevated', 'Moderate', null];
        yield 'pain 6' => ['pain_score', '6', 'elevated', 'Moderate', null];
        yield 'pain 7' => ['pain_score', '7', 'high', 'Severe', null];
        yield 'pain 10' => ['pain_score', '10', 'high', 'Severe', null];
    }

    #[DataProvider('boundaries')]
    public function testEachBoundary(string $key, string $value, string $level, string $label, ?string $advice): void
    {
        $this->assertSame(['level' => $level, 'label' => $label, 'advice' => $advice], VitalsFlags::flag($key, $value));
    }

    public function testWeightIsJudgedByItsBmiWithTheLatestHeight(): void
    {
        // 175 cm: 56.5 kg → BMI 18.4, 56.6 → 18.5, 68 → 22.2, 76.6 → 25.0, 92 → 30.0
        $this->assertSame('low', VitalsFlags::flag('weight', '56.5', '175')['level']);
        $this->assertSame('normal', VitalsFlags::flag('weight', '56.6', '175')['level']);
        $this->assertSame('normal', VitalsFlags::flag('weight', '68', '175')['level']);
        $this->assertSame('elevated', VitalsFlags::flag('weight', '76.6', '175')['level']);
        $high = VitalsFlags::flag('weight', '92', '175');
        $this->assertSame(['level' => 'high', 'label' => 'High', 'advice' => null], $high, 'never "seek medical attention" for weight');

        $this->assertNull(VitalsFlags::flag('weight', '68'), 'no height on file — no flag');
        $this->assertNull(VitalsFlags::flag('weight', '68', 'tall'));
    }

    public function testHeightAndUnreadableValuesHaveNoFlag(): void
    {
        $this->assertNull(VitalsFlags::flag('height', '172'));
        $this->assertNull(VitalsFlags::flag('temperature', 'hot'));
        $this->assertNull(VitalsFlags::flag('blood_pressure', '120'));
        $this->assertNull(VitalsFlags::flag('mood', '5'));
    }

    public function testAdviceOnlyForHighAndCriticalReadings(): void
    {
        foreach (self::boundaries() as $name => [$key, $value, $level, , $advice]) {
            $expected = match (true) {
                in_array($key, ['bmi', 'pain_score'], true) => null,
                $level === 'high'                           => self::ATTENTION,
                $level === 'critical'                       => self::URGENT,
                default                                     => null,
            };
            $this->assertSame($expected, $advice, $name);
        }
    }

    public function testLatestListAndFormCarryTheFlags(): void
    {
        $at    = '2026-10-13T08:00:00+00:00';
        $cache = [
            'temperature' => ['value' => '38.6', 'unit' => '°C', 'taken_at' => $at, 'source' => 'self_reported', 'recorded_by' => 'patient'],
            'weight'      => ['value' => '68', 'unit' => 'kg', 'taken_at' => $at, 'source' => 'self_reported', 'recorded_by' => 'patient'],
            'height'      => ['value' => '172', 'unit' => 'cm', 'taken_at' => '2025-01-01T08:00:00+00:00', 'source' => 'clinic'],
        ];
        $list = array_column(VitalsService::latestList($cache, $this->now()), null, 'key');
        $this->assertSame(['level' => 'high', 'label' => 'High', 'advice' => self::ATTENTION], $list['temperature']['flag']);
        $this->assertSame('normal', $list['weight']['flag']['level'], '68 kg at 172 cm is a BMI of 23');
        $this->assertNull($list['height']['flag']);

        $fields = array_column(VitalsForm::fields(), null, 'key');
        $this->assertSame('36.0–37.5', $fields['temperature']['normal_range']);
        $this->assertSame('95–100', $fields['oxygen_saturation']['normal_range']);
        $this->assertNull($fields['height']['normal_range']);
        $this->assertNull($fields['weight']['normal_range']);
    }

    public function testANewHeightOnItsOwnUpdatesTheBmiFromTheWeightOnFile(): void
    {
        $at    = '2026-10-01T08:00:00+00:00';
        $cache = [
            'weight' => ['value' => '68', 'unit' => 'kg', 'taken_at' => $at, 'source' => 'self_reported'],
            'height' => ['value' => '175', 'unit' => 'cm', 'taken_at' => $at, 'source' => 'self_reported'],
            'bmi'    => ['value' => '22.2', 'unit' => 'kg/m²', 'taken_at' => $at, 'source' => 'self_reported'],
        ];
        [$values] = VitalsService::validatePatientInput(['readings' => ['height' => '160']], $cache, $this->now());
        $this->assertSame('26.6', $values['bmi'], '68 kg at 160 cm');

        [$values] = VitalsService::validatePatientInput(['readings' => ['height' => '160']], [], $this->now());
        $this->assertArrayNotHasKey('bmi', $values, 'no weight anywhere — no BMI');

        [$values] = VitalsService::validatePatientInput(['readings' => ['heart_rate' => '70']], $cache, $this->now());
        $this->assertArrayNotHasKey('bmi', $values, 'neither weight nor height given — the BMI on file stands');
    }

    public function testWeightAndBmiCardsNeverDisagree(): void
    {
        $old = '2026-10-01T08:00:00+00:00';
        $new = '2026-10-13T08:00:00+00:00';
        $row = static fn (string $value, string $at): array => ['value' => $value, 'unit' => '', 'taken_at' => $at, 'source' => 'video', 'recorded_by' => 'doctor'];

        // A BMI that still describes the latest weight and height is judged, and agrees with the weight.
        $list = array_column(VitalsService::latestList(
            ['weight' => $row('80', $new), 'height' => $row('175', $old), 'bmi' => $row('26.1', $new)],
            $this->now(),
        ), null, 'key');
        $this->assertSame('elevated', $list['bmi']['flag']['level']);
        $this->assertSame($list['weight']['flag'], $list['bmi']['flag']);

        // A doctor's new weight with no height left the BMI behind: no flag, rather than "Normal" beside an "Elevated" weight.
        $list = array_column(VitalsService::latestList(
            ['weight' => $row('80', $new), 'height' => $row('175', $old), 'bmi' => $row('22.2', $old)],
            $this->now(),
        ), null, 'key');
        $this->assertSame('elevated', $list['weight']['flag']['level']);
        $this->assertNull($list['bmi']['flag']);

        // So did a newer height.
        $list = array_column(VitalsService::latestList(
            ['weight' => $row('68', $old), 'height' => $row('160', $new), 'bmi' => $row('22.2', $old)],
            $this->now(),
        ), null, 'key');
        $this->assertNull($list['bmi']['flag']);

        // No height on file: neither weight nor BMI is judged.
        $list = array_column(VitalsService::latestList(
            ['weight' => $row('68', $new), 'bmi' => $row('31', $new)],
            $this->now(),
        ), null, 'key');
        $this->assertNull($list['weight']['flag']);
        $this->assertNull($list['bmi']['flag']);
    }

    public function testHistoryJudgesABmiOnlyWithAHeightOnFile(): void
    {
        $reading = new VitalReading('00000000-0000-0000-0000-000000000000', 'bmi', '31', 'kg/m²', new DateTimeImmutable('2026-10-13T08:00:00+00:00'), 'self_reported', 'patient', null);
        $row     = new \ReflectionMethod(VitalsService::class, 'readingRow');

        $this->assertNull($row->invoke(null, $reading, $this->now(), null)['flag']);
        $this->assertSame(['level' => 'high', 'label' => 'High', 'advice' => null], $row->invoke(null, $reading, $this->now(), '175')['flag']);
    }

    // ----- reminder: a consultation coming up -----

    /** @return array{id: string, scheduled_at: DateTimeImmutable} */
    private function appt(string $id, string $at): array
    {
        return ['id' => $id, 'scheduled_at' => new DateTimeImmutable($at)];
    }

    public function testUpcomingConsultationWithoutRecentReadingsIsDue(): void
    {
        // Consultation tomorrow at 10:00; newest reading three days ago (fresh by the 7-day rule).
        $r = VitalsService::reminder(
            new DateTimeImmutable('2026-10-11T12:00:00+00:00'),
            $this->now(),
            [$this->appt('a-1', '2026-10-15T10:00:00+00:00')],
        );
        $this->assertTrue($r['due']);
        $this->assertSame('upcoming', $r['reason']);
        $this->assertSame(['id' => 'a-1', 'scheduled_at' => '2026-10-15T10:00:00+00:00'], $r['appointment']);
        $this->assertSame(3, $r['days_old']);
    }

    public function testAReadingInThe48HoursBeforeTheConsultationIsEnough(): void
    {
        $appointment = [$this->appt('a-1', '2026-10-15T10:00:00+00:00')];
        // Exactly 48 hours before it counts; a minute earlier does not.
        $onTime = VitalsService::reminder(new DateTimeImmutable('2026-10-13T10:00:00+00:00'), $this->now(), $appointment);
        $this->assertFalse($onTime['due']);
        $this->assertNull($onTime['reason']);
        $this->assertNull($onTime['appointment']);

        $early = VitalsService::reminder(new DateTimeImmutable('2026-10-13T09:59:00+00:00'), $this->now(), $appointment);
        $this->assertSame('upcoming', $early['reason']);
    }

    public function testOnlyConsultationsStartingWithinTheNext48HoursCount(): void
    {
        $last = new DateTimeImmutable('2026-10-10T12:00:00+00:00'); // 4 days old — fresh by the 7-day rule
        $at   = static fn (string $when): array => VitalsService::reminder($last, new DateTimeImmutable('2026-10-14T12:00:00+00:00'), [
            ['id' => 'a', 'scheduled_at' => new DateTimeImmutable($when)],
        ]);

        $this->assertSame('upcoming', $at('2026-10-14T12:00:00+00:00')['reason'], 'starting now');
        $this->assertSame('upcoming', $at('2026-10-16T12:00:00+00:00')['reason'], 'exactly 48 hours away');
        $this->assertNull($at('2026-10-16T12:01:00+00:00')['reason'], 'just over 48 hours away');
        $this->assertNull($at('2026-10-14T11:59:00+00:00')['reason'], 'already started');
    }

    public function testTheSoonestConsultationNeedingReadingsIsNamed(): void
    {
        // A reading 30 hours ago covers the consultation in 10 hours, not the one in 40.
        $r = VitalsService::reminder(new DateTimeImmutable('2026-10-13T06:00:00+00:00'), $this->now(), [
            $this->appt('later', '2026-10-16T04:00:00+00:00'),
            $this->appt('sooner', '2026-10-14T22:00:00+00:00'),
        ]);
        $this->assertSame('upcoming', $r['reason']);
        $this->assertSame('later', $r['appointment']['id']);

        $both = VitalsService::reminder(new DateTimeImmutable('2026-10-01T06:00:00+00:00'), $this->now(), [
            $this->appt('later', '2026-10-16T04:00:00+00:00'),
            $this->appt('sooner', '2026-10-14T22:00:00+00:00'),
        ]);
        $this->assertSame('sooner', $both['appointment']['id'], 'soonest first, whatever order they came in');
    }

    public function testReasonPrecedenceIsNeverThenUpcomingThenStale(): void
    {
        $soon = [$this->appt('a-1', '2026-10-15T10:00:00+00:00')];

        $never = VitalsService::reminder(null, $this->now(), $soon);
        $this->assertSame('never', $never['reason']);
        $this->assertNull($never['appointment']);

        $staleAndSoon = VitalsService::reminder(new DateTimeImmutable('2026-09-01T12:00:00+00:00'), $this->now(), $soon);
        $this->assertSame('upcoming', $staleAndSoon['reason']);
        $this->assertSame('a-1', $staleAndSoon['appointment']['id']);

        $staleOnly = VitalsService::reminder(new DateTimeImmutable('2026-09-01T12:00:00+00:00'), $this->now());
        $this->assertSame('stale', $staleOnly['reason']);
        $this->assertNull($staleOnly['appointment']);
    }

    public function testUpcomingQueryCompilesAndActionsResolve(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();

        $sql = $container->get(UpcomingConsultations::class)
            ->query('00000000-0000-0000-0000-000000000000', $this->now(), $this->now()->modify('+48 hours'))
            ->getQuery()
            ->getSQL();
        $this->assertStringContainsStringIgnoringCase('appointments', $sql);
        $this->assertStringContainsStringIgnoringCase('scheduled_at', $sql);
        $this->assertStringContainsStringIgnoringCase('deleted_at IS NULL', $sql);
        $this->assertStringContainsStringIgnoringCase('ORDER BY', $sql);
    }
}
