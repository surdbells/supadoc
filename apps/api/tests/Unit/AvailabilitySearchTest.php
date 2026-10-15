<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Doctor\DoctorCalendarAction;
use App\Action\Doctor\DoctorCalendarSlotsAction;
use App\Action\Public\GetPublicSpecialistAction;
use App\Action\Public\SpecialistSuggestionsAction;
use App\Action\Settings\BookingSettingsAction;
use App\Action\Specialist\GetSpecialistAvailabilityAction;
use App\Action\Specialist\GetStaffSpecialistAvailabilityAction;
use App\Action\Specialist\GetStaffSpecialistSlotsAction;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\AvailabilitySlotRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Availability\BookingFrame;
use App\Infrastructure\Availability\DirectorySearch;
use App\Infrastructure\Availability\SpecialistSuggestions;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\AvailabilityService;
use DateTimeImmutable;
use DateTimeZone;
use DI\ContainerBuilder;
use Doctrine\ORM\EntityManagerInterface;
use PHPUnit\Framework\TestCase;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;
use Slim\Routing\RoutingResults;

/**
 * Searching by availability and suggesting similar doctors: the "when"
 * filters, the soonest-first order, the suggestion tiers, and the batched
 * queries behind them (compiled offline). A regression here lists doctors who
 * aren't free, hides ones who are, or suggests a different specialty.
 */
final class AvailabilitySearchTest extends TestCase
{
    private const ID = '00000000-0000-0000-0000-000000000001';

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    private function at(string $utc): int
    {
        return (new DateTimeImmutable($utc, new DateTimeZone('UTC')))->getTimestamp();
    }

    private function frame(string $nowUtc = '2026-10-15 06:00', string $tz = 'UTC'): BookingFrame
    {
        return new BookingFrame(new DateTimeZone($tz), $this->at($nowUtc), 60, 60);
    }

    // ----- Batched queries compile -----

    public function testTheBatchedAvailabilityQueriesCompile(): void
    {
        $em   = $this->em();
        $from = new DateTimeImmutable('2026-10-15');
        $to   = new DateTimeImmutable('2026-10-22');

        $rows = (new AvailabilitySlotRepository($em))->rowsForSpecialistsBetweenQuery([self::ID], $from, $to)->getSQL();
        $this->assertStringContainsStringIgnoringCase('availability_slots', $rows);
        $this->assertStringContainsStringIgnoringCase('specialist_id IN', $rows);
        $this->assertStringNotContainsStringIgnoringCase('reason', $rows, 'never a block reason');

        $publishing = (new AvailabilitySlotRepository($em))->specialistIdsWithOpenSlotsQuery([self::ID], $from, $to)->getSQL();
        $this->assertStringContainsStringIgnoringCase('DISTINCT', $publishing);

        $taken = (new AppointmentRepository($em))->takenStartsForQuery([self::ID], $from, $to, $from)->getSQL();
        $this->assertStringContainsStringIgnoringCase('scheduled_at', $taken);
        $this->assertStringContainsStringIgnoringCase('expires_at', $taken, 'an open proposal holds its time until it expires');
        $this->assertStringContainsStringIgnoringCase('deleted_at IS NULL', $taken);
    }

    public function testTheDirectorySearchQueryCompilesWithEveryFilter(): void
    {
        $repo = new SpecialistRepository($this->em());

        $qb  = $repo->searchQuery('ada', 'Cardiology', 'Lagos', 'Yoruba', 'female', true, '15000.00', '4.00', 5);
        $dql = (string) $qb->getDQL();
        $this->assertStringContainsString('e.consultationFee <= :feeMax', $dql);
        $this->assertStringContainsString('e.rating >= :minRating', $dql);
        $this->assertStringContainsString('e.yearsExperience >= :minYears', $dql);
        $this->assertStringContainsString('e.status IS NULL OR e.status = :listedStatus', $dql, 'listed doctors only');
        $qb->getQuery()->getSQL();

        $suggest = $repo->suggestionCandidatesQuery('Cardiology', true, self::ID);
        $this->assertStringContainsString('e.id != :exclude', (string) $suggest->getDQL());
        $this->assertStringContainsString('e.offersInPerson = true', (string) $suggest->getDQL());
        $suggest->getQuery()->getSQL();
    }

    // ----- The "when" filters -----

    /** @param array<string,string> $query */
    private function errorsFor(array $query): array
    {
        try {
            DirectorySearch::filters($query, $this->frame());
        } catch (ValidationException $e) {
            return $e->getErrors();
        }

        return [];
    }

    public function testBadFiltersAre422WithFieldErrors(): void
    {
        $this->assertArrayHasKey('available_on', $this->errorsFor(['available_on' => '16/10/2026']));
        $this->assertArrayHasKey('available_on', $this->errorsFor(['available_on' => '2026-10-14']), 'yesterday');
        $this->assertArrayHasKey('available_on', $this->errorsFor(['available_on' => '2026-12-15']), 'past the booking window');
        $this->assertArrayHasKey('available_within', $this->errorsFor(['available_on' => '2026-10-16', 'available_within' => 'today']));
        $this->assertArrayHasKey('available_within', $this->errorsFor(['available_within' => 'month']));
        $this->assertArrayHasKey('part_of_day', $this->errorsFor(['part_of_day' => 'night']));
        $this->assertArrayHasKey('fee_max', $this->errorsFor(['fee_max' => '-1']));
        $this->assertArrayHasKey('min_rating', $this->errorsFor(['min_rating' => '6']));
        $this->assertArrayHasKey('min_years', $this->errorsFor(['min_years' => '-2']));
        $this->assertSame([], $this->errorsFor(['available_on' => '2026-12-14', 'part_of_day' => 'any', 'fee_max' => '20000']));
    }

    public function testTheWhenFiltersBecomeADateWindow(): void
    {
        $f = $this->frame();
        $this->assertSame(['2026-10-15', '2026-10-15'], DirectorySearch::filters(['available_within' => 'today'], $f)['window']);
        $this->assertSame(['2026-10-16', '2026-10-16'], DirectorySearch::filters(['available_within' => 'tomorrow'], $f)['window']);
        $this->assertSame(['2026-10-15', '2026-10-21'], DirectorySearch::filters(['available_within' => 'week'], $f)['window']);
        $this->assertSame(['2026-10-20', '2026-10-20'], DirectorySearch::filters(['available_on' => '2026-10-20'], $f)['window']);

        // A part of the day on its own searches the whole booking window.
        $evening = DirectorySearch::filters(['part_of_day' => 'evening'], $f);
        $this->assertSame(['2026-10-15', '2026-12-14'], $evening['window']);
        $this->assertSame('evening', $evening['part_of_day']);

        $any = DirectorySearch::filters(['part_of_day' => 'any', 'fee_max' => '12000', 'mode' => 'in_person'], $f);
        $this->assertNull($any['window']);
        $this->assertNull($any['part_of_day']);
        $this->assertSame('12000.00', $any['fee_max']);
        $this->assertTrue($any['in_person']);
    }

    public function testSoonestFirstThenWeightedRatingThenName(): void
    {
        $make = static function (string $name, string $rating, int $reviews): Specialist {
            $s = new Specialist($name, 'GP');
            $s->setRating($rating);
            $s->setReviewsCount($reviews);

            return $s;
        };
        $early    = $make('Dr. Zed', '3.00', 2);
        $popular  = $make('Dr. Bee', '4.80', 200);
        $lucky    = $make('Dr. Aye', '5.00', 1); // one 5-star review shouldn't beat 4.8 from 200
        $nothing  = $make('Dr. Abe', '5.00', 500);
        $openings = [
            $early->getId()   => ['first_at' => $this->at('2026-10-16 09:00')],
            $popular->getId() => ['first_at' => $this->at('2026-10-16 10:00')],
            $lucky->getId()   => ['first_at' => $this->at('2026-10-16 10:00')],
            $nothing->getId() => null,
        ];

        $sorted = DirectorySearch::soonestFirst([$nothing, $lucky, $popular, $early], $openings);
        $this->assertSame(['Dr. Zed', 'Dr. Bee', 'Dr. Aye', 'Dr. Abe'], array_map(static fn (Specialist $s): string => $s->getName(), $sorted));
        $this->assertGreaterThan(DirectorySearch::weightedRating(5.0, 1), DirectorySearch::weightedRating(4.8, 200));
    }

    // ----- Suggestions -----

    /**
     * @param array<string, list<string>> $days date => "HH:MM" UTC times
     * @return array{id:string, profile:array<string,mixed>, days:array<string, list<array{at:int, period:string}>>}
     */
    private function doctor(string $id, array $profile, array $days, BookingFrame $frame): array
    {
        $out = [];
        foreach ($days as $date => $times) {
            $day = $frame->day($date);
            foreach ($times as $hm) {
                $at           = $this->at("$date $hm");
                $out[$date][] = ['at' => $at, 'period' => BookingFrame::partOf($day, $at)];
            }
        }

        return ['id' => $id, 'profile' => $profile + [
            'name' => $id, 'location' => 'Lagos', 'gender' => 'female', 'languages' => 'English, Yoruba',
            'consultation_fee' => '10000.00', 'rating' => '4.50', 'reviews_count' => 20,
        ], 'days' => $out];
    }

    public function testSuggestionsAreTieredAndSayWhy(): void
    {
        $f       = $this->frame();
        $date    = '2026-10-16';
        $filters = ['part_of_day' => 'morning', 'location' => 'Lagos', 'gender' => 'female', 'language' => 'Yoruba', 'fee' => '15000.00'];
        $doctors = [
            $this->doctor('fits', [], [$date => ['10:00']], $f),
            $this->doctor('afternoon', [], [$date => ['14:00']], $f),
            $this->doctor('english', ['languages' => 'English'], [$date => ['09:00']], $f),
            $this->doctor('pricey', ['consultation_fee' => '20000.00'], [$date => ['11:00']], $f),
            $this->doctor('later', [], ['2026-10-18' => ['11:00']], $f),
            $this->doctor('two-off', ['location' => 'Abuja', 'languages' => 'English'], [$date => ['09:00']], $f),
            $this->doctor('too-late', [], ['2026-10-20' => ['09:00']], $f),
        ];

        $picks = SpecialistSuggestions::rank($doctors, $filters, '10000.00', $date, 8, $f);

        $this->assertSame(['fits', 'afternoon', 'english', 'pricey', 'later'], array_column($picks, 'id'), 'two filters off, or free only after 3 days: not suggested');
        $this->assertSame([0, 1, 1, 1, 2], array_column($picks, 'tier'));
        $this->assertSame([[], ['part_of_day'], ['language'], ['fee'], []], array_column($picks, 'relaxed'));
        $this->assertSame([
            'Same specialty · free 10:00 AM',
            'Different time of day · free 2:00 PM',
            'Different language · free 9:00 AM',
            'Higher fee · free 11:00 AM',
            'Same specialty · free Sun 18 Oct, 11:00 AM',
        ], array_column($picks, 'reason'));
        $this->assertSame('2026-10-18', $picks[4]['availability']['date']);
        $this->assertSame('2026-10-16T10:00:00+00:00', $picks[0]['availability']['first_slot_at']);

        $this->assertSame(['fits', 'afternoon'], array_column(SpecialistSuggestions::rank($doctors, $filters, '10000.00', $date, 2, $f), 'id'), 'limit');
    }

    public function testWithinATierTheSoonestThenTheBestRatedLead(): void
    {
        $f       = $this->frame();
        $date    = '2026-10-16';
        $filters = ['part_of_day' => null, 'location' => null, 'gender' => null, 'language' => null, 'fee' => null];
        $doctors = [
            $this->doctor('late', ['rating' => '5.00', 'reviews_count' => 300], [$date => ['15:00']], $f),
            $this->doctor('ok', ['rating' => '4.00', 'reviews_count' => 10], [$date => ['09:00']], $f),
            $this->doctor('best', ['rating' => '4.90', 'reviews_count' => 100], [$date => ['09:00']], $f),
        ];

        $this->assertSame(['best', 'ok', 'late'], array_column(SpecialistSuggestions::rank($doctors, $filters, null, $date, 4, $f), 'id'));
    }

    /** `like` must not confirm that an unlisted doctor exists: the same 404 as their profile and calendar. */
    public function testSuggestionsLikeAnUnlistedDoctorIsUnknown(): void
    {
        $em      = $this->em();
        $uow     = $em->getUnitOfWork();
        $suggest = new SpecialistSuggestions(
            new SpecialistRepository($em),
            new AvailabilityService(new AppointmentRepository($em), new AvailabilitySlotRepository($em)),
        );

        foreach ([SpecialistStatus::INVITED, SpecialistStatus::PENDING_REVIEW, SpecialistStatus::REJECTED, SpecialistStatus::SUSPENDED] as $status) {
            $doctor = new Specialist('Dr. Hidden', 'Cardiology');
            $doctor->setStatus($status);
            $uow->registerManaged($doctor, ['id' => $doctor->getId()], []);
            try {
                $suggest->suggest(['like' => $doctor->getId()]);
                $this->fail($status->value . ' must be unknown');
            } catch (EntityNotFoundException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    // ----- Moving an appointment -----

    public function testAnAppointmentBeingMovedDoesNotTakeItsOwnTime(): void
    {
        $repo  = new AppointmentRepository($this->em());
        $from  = new DateTimeImmutable('2026-10-15');
        $to    = new DateTimeImmutable('2026-10-22');
        $other = '00000000-0000-0000-0000-000000000002';

        $moving = $repo->takenStartsForQuery([self::ID], $from, $to, $from, $other);
        $this->assertStringContainsString('e.id != :ignore', (string) $moving->getDQL());
        $this->assertSame($other, $moving->getParameter('ignore')?->getValue());
        $moving->getSQL();

        $this->assertStringNotContainsString(':ignore', (string) $repo->takenStartsForQuery([self::ID], $from, $to, $from)->getDQL());
    }

    // ----- The calendar endpoints -----

    public function testTheCalendarEndpointRefusesAYear9999Start(): void
    {
        $em     = $this->em();
        $doctor = new Specialist('Dr. Ada', 'General Practice');
        $doctor->setStatus(SpecialistStatus::APPROVED);
        $em->getUnitOfWork()->registerManaged($doctor, ['id' => $doctor->getId()], []);
        $action  = new GetSpecialistAvailabilityAction(
            new SpecialistRepository($em),
            new AvailabilityService(new AppointmentRepository($em), new AvailabilitySlotRepository($em)),
        );
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', '/api/public/specialists/' . $doctor->getId() . '/availability')
            ->withQueryParams(['from' => '9999-12-31', 'to' => '9999-12-31']);

        try {
            $action($request, new Response(), ['id' => $doctor->getId()]);
            $this->fail('accepted a year-9999 start');
        } catch (ValidationException $e) {
            $this->assertArrayHasKey('from', $e->getErrors());
        }
    }

    // ----- Wiring -----

    public function testRoutesResolveToTheRightActions(): void
    {
        $this->em(); // offline Doctrine for the container
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();
        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);

        $handler = function (string $path, string $method = 'GET') use ($app): string {
            $result = $app->getRouteResolver()->computeRoutingResults($path, $method);
            $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus(), "$method $path");

            return (string) $app->getRouteResolver()->resolveRoute((string) $result->getRouteIdentifier())->getCallable();
        };
        $this->assertSame(SpecialistSuggestionsAction::class, $handler('/api/public/specialists/suggestions'), 'not shadowed by /public/specialists/{id}');
        $this->assertSame(GetSpecialistAvailabilityAction::class, $handler('/api/public/specialists/' . self::ID . '/availability'));
        $this->assertSame(GetPublicSpecialistAction::class, $handler('/api/public/specialists/' . self::ID));
        $this->assertSame(BookingSettingsAction::class, $handler('/api/settings/booking', 'PATCH'));
        // The staff and doctor calendars (not held to the patient horizon).
        $this->assertSame(GetStaffSpecialistAvailabilityAction::class, $handler('/api/specialists/' . self::ID . '/availability'));
        $this->assertSame(GetStaffSpecialistSlotsAction::class, $handler('/api/specialists/' . self::ID . '/slots'));
        $this->assertSame(DoctorCalendarAction::class, $handler('/api/doctor/calendar'));
        $this->assertSame(DoctorCalendarSlotsAction::class, $handler('/api/doctor/calendar/slots'));

        foreach ([AvailabilityService::class, BookingSettings::class, DirectorySearch::class, SpecialistSuggestions::class] as $id) {
            $this->assertIsObject($container->get($id), "could not resolve $id");
        }
    }
}
