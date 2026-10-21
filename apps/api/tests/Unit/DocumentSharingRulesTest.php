<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Document\ShareDuration;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/** The pure rules of document sharing (spec §1.2, §3.2). */
final class DocumentSharingRulesTest extends TestCase
{
    private DateTimeImmutable $now;

    protected function setUp(): void
    {
        $this->now = new DateTimeImmutable('2026-10-21 10:00:00');
    }

    public function testEachDurationEndsWhereItShould(): void
    {
        $end = new DateTimeImmutable('2026-10-25 15:30:00');
        $this->assertEquals($this->now->modify('+24 hours'), ShareDuration::H24->expiryFrom($this->now, null, null));
        $this->assertEquals($this->now->modify('+7 days'), ShareDuration::D7->expiryFrom($this->now, null, null));
        $this->assertEquals($this->now->modify('+30 days'), ShareDuration::D30->expiryFrom($this->now, null, null));
        $this->assertNull(ShareDuration::INDEFINITE->expiryFrom($this->now, null, null));
        $this->assertEquals($end, ShareDuration::UNTIL->expiryFrom($this->now, $end, null));
        $this->assertEquals($end->modify('+24 hours'), ShareDuration::AFTER_24H->expiryFrom($this->now, null, $end));
        $this->assertEquals($end->modify('+7 days'), ShareDuration::AFTER_7D->expiryFrom($this->now, null, $end));
        $this->assertEquals($end->modify('+30 days'), ShareDuration::AFTER_30D->expiryFrom($this->now, null, $end));
        $this->assertTrue(ShareDuration::AFTER_7D->isAnchored());
        $this->assertFalse(ShareDuration::D7->isAnchored());
        $this->assertSame(['24h', '7d', '30d', 'until', 'indefinite', 'after_24h', 'after_7d', 'after_30d'], ShareDuration::codes());
        $this->assertSame(['after_24h', 'after_7d', 'after_30d', 'indefinite'], ShareDuration::bookingCodes());
    }

    public function testAnUntilEndNeedsAnOffsetAndBounds(): void
    {
        $this->assertIsString(Rules::parseUntil('2026-10-30T00:00:00', $this->now), 'no offset refused');
        $this->assertIsString(Rules::parseUntil($this->now->modify('+59 minutes')->format(DATE_ATOM), $this->now));
        $this->assertInstanceOf(DateTimeImmutable::class, Rules::parseUntil($this->now->modify('+366 days')->format(DATE_ATOM), $this->now));
        $this->assertIsString(Rules::parseUntil($this->now->modify('+367 days')->format(DATE_ATOM), $this->now));

        // An offset is normalised to the process zone.
        $parsed = Rules::parseUntil('2026-10-31T00:00:00+01:00', $this->now);
        $this->assertInstanceOf(DateTimeImmutable::class, $parsed);
        $this->assertSame(date_default_timezone_get(), $parsed->getTimezone()->getName());
        $this->assertSame((new DateTimeImmutable('2026-10-30T23:00:00Z'))->getTimestamp(), $parsed->getTimestamp());
        $this->assertInstanceOf(DateTimeImmutable::class, Rules::parseUntil('2026-10-31T00:00:00Z', $this->now));
    }

    public function testAfterOptions(): void
    {
        $p = $this->patient('p-1');
        $s = $this->doctor('s-1');

        $ended = $this->appointment($p, $s, (new DateTimeImmutable())->modify('-2 days'), AppointmentStatus::COMPLETED);
        $now   = new DateTimeImmutable();
        $opts  = Rules::afterOptions($ended, 'p-1', 's-1', $now);
        $this->assertNull($opts['after_24h'], 'ended 2 days ago: 24 h after is gone');
        $this->assertNotNull($opts['after_7d']);
        $this->assertNotNull($opts['after_30d']);

        $cancelled = $this->appointment($p, $s, $now->modify('+2 days'), AppointmentStatus::CANCELLED);
        $this->assertSame(['after_24h' => null, 'after_7d' => null, 'after_30d' => null], Rules::afterOptions($cancelled, 'p-1', 's-1', $now));
        $proposal = $this->appointment($p, $s, $now->modify('+2 days'), AppointmentStatus::PROPOSED);
        $this->assertSame(['after_24h' => null, 'after_7d' => null, 'after_30d' => null], Rules::afterOptions($proposal, 'p-1', 's-1', $now));
        $upcoming = $this->appointment($p, $s, $now->modify('+2 days'), AppointmentStatus::CONFIRMED);
        $this->assertSame(['after_24h' => null, 'after_7d' => null, 'after_30d' => null], Rules::afterOptions($upcoming, 'p-2', 's-1', $now), "another patient's");
        $this->assertSame(['after_24h' => null, 'after_7d' => null, 'after_30d' => null], Rules::afterOptions($upcoming, 'p-1', 's-2', $now), "another doctor's");
        $this->assertNotNull(Rules::afterOptions($upcoming, 'P-1', 'S-1', $now)['after_24h'], 'ids compare case-insensitively');
        $upcoming->softDelete();
        $this->assertSame(['after_24h' => null, 'after_7d' => null, 'after_30d' => null], Rules::afterOptions($upcoming, 'p-1', 's-1', $now));
    }

    public function testMessagesAreCleaned(): void
    {
        $this->assertSame("Please share\nthe scan", Rules::sanitizeMessage("  Please\u{202E} share\u{200B}\nthe\t scan  "));
        $this->assertSame("a\n\nb", Rules::sanitizeMessage("a\r\n\r\n\r\n\r\nb"));
        $this->assertSame("a\nb", Rules::sanitizeMessage("a\x07\nb\x00"));
        $this->assertNull(Rules::sanitizeMessage("  \u{200B} "));
        $this->assertNull(Rules::sanitizeMessage(null));
        $this->assertSame(500, mb_strlen((string) Rules::sanitizeMessage(str_repeat('é', 500))));
        $this->assertSame(501, mb_strlen((string) Rules::sanitizeMessage(str_repeat('é', 501))), 'the caller refuses over 500');
    }

    public function testTheRequestHashIsStableUnderOrderAndCase(): void
    {
        $a = Rules::requestHash(['specialist_ids' => ['B-1', 'a-2'], 'scope' => 'all', 'document_ids' => ['x', 'y'], 'duration' => '7d']);
        $b = Rules::requestHash(['duration' => '7d', 'document_ids' => ['Y', 'X'], 'scope' => 'all', 'specialist_ids' => ['a-2', 'b-1']]);
        $this->assertSame($a, $b);
        $this->assertNotSame($a, Rules::requestHash(['specialist_ids' => ['b-1', 'a-2'], 'scope' => 'all', 'document_ids' => ['x'], 'duration' => '7d']));
        $this->assertSame(64, strlen($a));
    }

    public function testUuidsAreLowerCasedAndListsValidated(): void
    {
        $this->assertSame('0a6c2b8e-4c1f-4c55-9d8b-2f0e8f1b7a10', Rules::lowerUuid(' 0A6C2B8E-4C1F-4C55-9D8B-2F0E8F1B7A10 '));
        $this->assertNull(Rules::lowerUuid('not-a-uuid'));
        $this->assertNull(Rules::lowerUuid(42));

        [$ids, $errors] = Rules::uuidList(['0A6C2B8E-4C1F-4C55-9D8B-2F0E8F1B7A10', '0a6c2b8e-4c1f-4c55-9d8b-2f0e8f1b7a10', 'x'], 'specialist_ids', 5, 'too many');
        $this->assertSame(['0a6c2b8e-4c1f-4c55-9d8b-2f0e8f1b7a10'], $ids);
        $this->assertSame(['specialist_ids.2' => 'Invalid id'], $errors);
        $this->assertSame([[], ['specialist_ids' => 'Send a list of ids']], Rules::uuidList('x', 'specialist_ids', 5, 'too many'));
    }

    public function testUntilLabelsAreOneSecondBeforeTheExclusiveEnd(): void
    {
        $end = new DateTimeImmutable('2026-10-31 00:00:00');
        $this->assertEquals(new DateTimeImmutable('2026-10-30 23:59:59'), Rules::untilLabelAt($end, 'until'));
        $this->assertEquals($end, Rules::untilLabelAt($end, '7d'));
        $this->assertNull(Rules::untilLabelAt(null, 'indefinite'));
    }

    public function testTheKillSwitchDefaultsOff(): void
    {
        $previous = $_ENV['DOC_SHARING_ENABLED'] ?? null;
        try {
            unset($_ENV['DOC_SHARING_ENABLED']);
            putenv('DOC_SHARING_ENABLED');
            $this->assertFalse(Rules::enabled());
            foreach (['true' => true, '1' => true, 'TRUE' => true, 'false' => false, '0' => false, 'yes' => false] as $value => $on) {
                $_ENV['DOC_SHARING_ENABLED'] = (string) $value;
                $this->assertSame($on, Rules::enabled(), (string) $value);
            }
        } finally {
            if ($previous === null) {
                unset($_ENV['DOC_SHARING_ENABLED']);
            } else {
                $_ENV['DOC_SHARING_ENABLED'] = $previous;
            }
        }
    }

    // ----- Helpers -----

    private function patient(string $id): Patient
    {
        $p = new Patient($id . '@example.test', 'Pat', 'Patient');
        (new \ReflectionProperty(Patient::class, 'id'))->setValue($p, $id);

        return $p;
    }

    private function doctor(string $id): Specialist
    {
        $s = new Specialist('Dr. Test', 'General Practice');
        (new \ReflectionProperty(Specialist::class, 'id'))->setValue($s, $id);
        $s->setSlotMinutes(30);

        return $s;
    }

    private function appointment(Patient $p, Specialist $s, DateTimeImmutable $at, AppointmentStatus $status): Appointment
    {
        $a = new Appointment($p, $s, $at, ConsultationType::VIDEO);
        (new \ReflectionProperty(Appointment::class, 'status'))->setValue($a, $status);

        return $a;
    }
}
