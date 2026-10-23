<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Appointment\InitGuestPaymentAction;
use App\Action\Appointment\RemoveMyGuestAction;
use App\Action\Appointment\ResendMyGuestInviteAction;
use App\Action\Call\CallLobbyAction;
use App\Action\Call\GuestConsentAction;
use App\Action\Call\JoinCallAction;
use App\Action\Doctor\StartRecordingAction;
use App\Domain\Call\CallAccess;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\SpecialistStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\ConsultationConsentRepository;
use App\Domain\Repository\RecordingRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Agora\AgoraKickingService;
use App\Infrastructure\Agora\AgoraRecordingService;
use App\Infrastructure\Agora\AgoraTokenService;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;
use App\Infrastructure\Service\PaymentIntentService;
use App\Infrastructure\Service\AppointmentPaymentService;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Service\CallPresence;
use App\Infrastructure\Service\GuestConsent;
use App\Infrastructure\Service\GuestInvitations;
use App\Infrastructure\Service\JwtService;
use App\Infrastructure\Service\PatientNotifier;
use App\Infrastructure\Service\PricingService;
use App\Infrastructure\Service\StaffNotifier;
use DateTimeImmutable;
use DI\ContainerBuilder;
use Doctrine\ORM\Decorator\EntityManagerDecorator;
use Doctrine\ORM\EntityManagerInterface;
use Doctrine\ORM\Exception\EntityManagerClosed;
use PHPUnit\Framework\TestCase;
use Predis\Client as RedisClient;
use Psr\Log\LoggerInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RoutingResults;

/**
 * Third-party (guest) invites: stable guest identities (ids, uids never
 * reused), older links, who may use a join link when (status, guest list,
 * window), who is in the call (names only), the guest-list rules and refunds,
 * the static-token guard, what guests are emailed, and the routes.
 */
final class GuestInvitesTest extends TestCase
{
    private const SECRET = 'test-secret-please-change-to-32+bytes-in-prod';

    private function doctor(): Specialist
    {
        $doctor = new Specialist('Dr. Grace Bell', 'General Practice');
        $doctor->setConsultationFee('20000.00');
        $doctor->setStatus(SpecialistStatus::APPROVED);
        $doctor->acceptTerms(\App\Domain\Settings\PractitionerTerms::version(), null); // may practise: the doctor can join
        $doctor->setEmail('grace.bell@clinic.test');

        return $doctor;
    }

    private function patient(): Patient
    {
        $patient = new Patient('ada@example.test', 'Ada', 'Obi');
        $patient->initTimestamps();

        return $patient;
    }

    private function appointment(string $startsIn = '+2 days'): Appointment
    {
        $appointment = new Appointment($this->patient(), $this->doctor(), new DateTimeImmutable($startsIn));
        $appointment->initTimestamps();
        $appointment->setPaymentStatus('paid');

        return $appointment;
    }

    private function em(): EntityManagerInterface
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();

        return DoctrineEntityManagerFactory::create();
    }

    /**
     * A JoinCallAction over an offline entity manager that already "holds"
     * `$appointment` (no recording set up, no video configured), with the
     * guest ids in `$inCall` heartbeating.
     *
     * @param list<string> $inCall
     */
    private function joinAction(Appointment $appointment, JwtService $jwt, array $inCall = []): JoinCallAction
    {
        $em  = $this->em();
        $uow = $em->getUnitOfWork();
        foreach ([$appointment->getPatient(), $appointment->getSpecialist(), $appointment] as $entity) {
            $uow->registerManaged($entity, ['id' => $entity->getId()], []);
        }
        // Just the replies CallPresence::forAppointment() reads.
        $redis = new class ($inCall) extends RedisClient {
            /** @param list<string> $inCall */
            public function __construct(private readonly array $inCall)
            {
            }

            public function __call($commandID, $arguments): mixed
            {
                return match (strtolower((string) $commandID)) {
                    'smembers' => $this->inCall,
                    'mget'     => array_map(static fn (): string => (string) time(), (array) $arguments[0]),
                    default    => throw new \LogicException("unexpected $commandID"),
                };
            }
        };
        $presence = new CallPresence($redis);
        $consent  = new GuestConsent(
            new ConsultationConsentRepository($em),
            new RecordingRepository($em),
            new AgoraRecordingService('', '', '', ['vendor' => 0, 'region' => 0, 'bucket' => '', 'accessKey' => '', 'secretKey' => '']),
            $presence,
        );

        return new JoinCallAction($jwt, new AppointmentRepository($em), new AgoraTokenService('', ''), $consent, $presence);
    }

    /** @return array{0:int, 1:array<string,mixed>} */
    private function join(JoinCallAction $action, string $token): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/public/call/' . $token);
        $res     = $action($request, (new ResponseFactory())->createResponse(), ['token' => $token]);

        return [$res->getStatusCode(), json_decode((string) $res->getBody(), true)];
    }

    // ----- Guest identities -----

    public function testEachGuestGetsAStableIdAndAUidThatIsNeverReused(): void
    {
        $appointment = $this->appointment();
        $now         = new DateTimeImmutable();
        $a           = $appointment->addGuest('Bola Ade', 'bola@example.test', '5000', 'booking', null, $now);
        $b           = $appointment->addGuest('Chi Eze', 'chi@example.test', '5000', 'booking', null, $now);

        $this->assertSame(Appointment::FIRST_GUEST_UID, $a['uid']);
        $this->assertSame(101, $b['uid']);
        $this->assertNotSame($a['id'], $b['id']);
        $this->assertSame('5000.00', $a['fee']);
        $this->assertSame($a, $appointment->findGuest($a['id']));

        $this->assertSame($b, $appointment->removeGuest($b['id']));
        $this->assertNull($appointment->findGuest($b['id']), 'a removed guest is gone');
        $this->assertNull($appointment->removeGuest($b['id']));
        $c = $appointment->addGuest('Dayo Fash', 'dayo@example.test', '0', 'free', null, $now);
        $this->assertSame(102, $c['uid'], "never a removed guest's uid");

        $appointment->removeGuest($a['id']);
        $appointment->removeGuest($c['id']);
        $this->assertSame([], $appointment->getGuests());
        $this->assertSame(103, $appointment->addGuest('Ed', 'ed@example.test', '0', 'free', null, $now)['uid'], 'not even once the list was empty');
    }

    public function testOnlyWhatHappenedToAGuestCanBeRecordedOnThem(): void
    {
        $appointment = $this->appointment();
        $guest       = $appointment->addGuest('Bola Ade', 'bola@example.test', '5000', 'wallet', null, new DateTimeImmutable());

        $updated = $appointment->updateGuest($guest['id'], [
            'consented_at' => '2026-10-14T10:00:00+00:00',
            'display_name' => 'Bola',
            'email'        => 'evil@example.test',
            'fee'          => '0.00',
            'uid'          => 1,
        ]);
        $this->assertSame('2026-10-14T10:00:00+00:00', $updated['consented_at']);
        $this->assertSame('bola@example.test', $updated['email'], 'who they are never changes');
        $this->assertSame('5000.00', $updated['fee']);
        $this->assertSame(100, $updated['uid']);
        $this->assertSame('Bola', Appointment::guestDisplayName($updated));
        $this->assertNull($appointment->updateGuest('no-such-guest', ['joined_at' => 'x']));

        $this->expectException(\InvalidArgumentException::class);
        $appointment->addGuest('X', 'x@example.test', '0', 'cash', null, new DateTimeImmutable());
    }

    public function testAppointmentPayloadsCarryGuestNamesNeverEmails(): void
    {
        $appointment = $this->appointment();
        $guest       = $appointment->addGuest('Bola Ade', 'bola@example.test', '5000', 'booking', null, new DateTimeImmutable());

        $this->assertSame([['id' => $guest['id'], 'name' => 'Bola Ade']], $appointment->toArray()['guests']);
        $this->assertStringNotContainsString('bola@example.test', (string) json_encode($appointment->toArray()));
        $this->assertStringNotContainsString('bola@example.test', (string) json_encode($appointment->toAdminArray()));
    }

    public function testOlderGuestsAreGivenIdentitiesOnceKeepingTheirLinksUid(): void
    {
        $appointment = $this->appointment();
        $appointment->setAmount('30000.00');
        $legacy = new \ReflectionProperty(Appointment::class, 'guests');
        $legacy->setValue($appointment, [
            ['name' => 'Bola Ade', 'email' => 'bola@example.test'],
            ['name' => 'Chi Eze', 'email' => 'chi@example.test'],
        ]);

        $this->assertSame('5000.00', $appointment->legacyGuestFee('5000'));
        $this->assertSame('5000.00', $appointment->legacyGuestFee('99999'), 'never more than an equal share of what was paid above the consultation');
        $this->assertSame(2, $appointment->assignGuestIdentities('5000.00'));
        [$bola, $chi] = $appointment->getGuests();
        $this->assertSame([3, 100], [$bola['legacy_uid'], $bola['uid']]);
        $this->assertSame([4, 101], [$chi['legacy_uid'], $chi['uid']]);
        $this->assertSame('booking', $bola['paid_by']);
        $this->assertSame('5000.00', $chi['fee']);

        $this->assertSame(0, $appointment->assignGuestIdentities('5000.00'), 'idempotent');
        $this->assertSame($bola['id'], $appointment->getGuests()[0]['id']);
        $this->assertSame('0.00', $appointment->legacyGuestFee('5000'), 'nobody left to give one');
        $this->assertSame(102, $appointment->addGuest('Dayo', 'dayo@example.test', '0', 'free', null, new DateTimeImmutable())['uid']);

        $free = $this->appointment();
        $free->setAmount('0.00');
        $legacy->setValue($free, [['name' => 'Bola Ade', 'email' => 'bola@example.test']]);
        $this->assertSame('0.00', $free->legacyGuestFee('5000'), 'nothing was paid for a free consultation');

        // Guests were free (or cheaper) at booking: removing them never refunds more than they cost.
        $freeGuests = $this->appointment();
        $freeGuests->setAmount('20000.00'); // the consultation fee alone
        $legacy->setValue($freeGuests, [['name' => 'Bola Ade', 'email' => 'bola@example.test'], ['name' => 'Chi Eze', 'email' => 'chi@example.test']]);
        $this->assertSame('0.00', $freeGuests->legacyGuestFee('5000'));
        $freeGuests->setAmount('23000.00');
        $this->assertSame('1500.00', $freeGuests->legacyGuestFee('5000'));
        // …nor what a guest already given an identity accounts for.
        $freeGuests->addGuest('Dayo', 'dayo@example.test', '3000', 'wallet', null, new DateTimeImmutable());
        $this->assertSame('0.00', $freeGuests->legacyGuestFee('5000'));

        // A follow-up's own price is what it was booked at, not the doctor's fee.
        $followUp = $this->appointment();
        (new \ReflectionProperty(Appointment::class, 'followUpPricing'))->setValue($followUp, ['amount' => '10000.00', 'rule' => 'discount']);
        $followUp->setAmount('20000.00');
        $legacy->setValue($followUp, [['name' => 'Bola Ade', 'email' => 'bola@example.test']]);
        $this->assertSame('5000.00', $followUp->legacyGuestFee('5000'));
        $this->assertSame('10000.00', $followUp->legacyGuestFee('12000'));
    }

    public function testAnOlderLinkWorksOnlyWhileThatSameGuestIsInvited(): void
    {
        $appointment = $this->appointment();
        (new \ReflectionProperty(Appointment::class, 'guests'))->setValue($appointment, [
            ['name' => 'Bola Ade', 'email' => 'bola@example.test'],
            ['name' => 'Chi Eze', 'email' => 'chi@example.test'],
        ]);
        $appointment->assignGuestIdentities('0.00');
        $chi = $appointment->getGuests()[1];

        $claims = static fn (int $uid, string $name, ?string $gid = null): array => ['role' => 'guest', 'uid' => $uid, 'name' => $name, 'gid' => $gid];
        $this->assertSame($chi, CallAccess::guestFor($appointment, $claims(4, 'chi eze ')));
        $this->assertNull(CallAccess::guestFor($appointment, $claims(4, 'Bola Ade')), 'uid and name must match');
        $this->assertNull(CallAccess::guestFor($appointment, $claims(5, 'Chi Eze')));
        $this->assertSame($chi, CallAccess::guestFor($appointment, $claims(0, 'whoever', $chi['id'])));
        $this->assertNull(CallAccess::guestFor($appointment, ['role' => 'patient', 'uid' => 1, 'name' => 'Ada Obi', 'gid' => null]));

        $appointment->removeGuest($chi['id']);
        $this->assertNull(CallAccess::guestFor($appointment, $claims(4, 'Chi Eze')), 'removed: the old link stops too');
        $this->assertNull(CallAccess::guestFor($appointment, $claims(0, 'Chi Eze', $chi['id'])));
    }

    public function testAGuestTokenCarriesTheirGuestId(): void
    {
        $jwt         = new JwtService(self::SECRET, 900, 1209600);
        $appointment = $this->appointment('+90 days');
        $guest       = $appointment->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());

        $claims = $jwt->verifyCallAccess(GuestInvitations::token($jwt, $appointment, $guest));
        $this->assertSame(['appointment_id' => $appointment->getId(), 'name' => 'Bola Ade', 'role' => 'guest', 'uid' => 100, 'gid' => $guest['id']], $claims);
        $this->assertNull($jwt->verifyCallAccess($jwt->issueCallAccess($appointment->getId(), 'Ada Obi', 'patient', 1))['gid']);

        // A link for a consultation 90 days out still works when it starts.
        $payload = json_decode((string) base64_decode(strtr(explode('.', GuestInvitations::token($jwt, $appointment, $guest))[1], '-_', '+/')), true);
        $this->assertGreaterThan(CallAccess::guestClosesAt($appointment)->getTimestamp(), $payload['exp']);
    }

    // ----- Who may use a join link, when -----

    public function testClosedOrUnconfirmedConsultationsHaveNoCall(): void
    {
        $now       = new DateTimeImmutable();
        $patient   = ['role' => 'patient', 'uid' => 1, 'name' => 'Ada Obi', 'gid' => null];
        $cancelled = $this->appointment();
        $cancelled->transitionTo(AppointmentStatus::CANCELLED);
        $completed = $this->appointment('-1 hour');
        $completed->transitionTo(AppointmentStatus::CONFIRMED);
        $completed->transitionTo(AppointmentStatus::COMPLETED);

        [$status, $message, $errors] = CallAccess::problem($cancelled, $patient, null, $now);
        $this->assertSame([410, CallAccess::CANCELLED, 'cancelled'], [$status, $message, $errors['code']]);
        $this->assertSame('call', array_key_first($errors), 'the message first, for apiErrorMessage');
        $this->assertSame([410, 'ended'], [CallAccess::problem($completed, $patient, null, $now)[0], CallAccess::problem($completed, $patient, null, $now)[2]['code']]);

        $this->assertNull(CallAccess::problem($this->appointment('+30 days'), $patient, null, $now), 'the patient has no window');
        $this->assertNull(CallAccess::problem($this->appointment('-5 hours'), ['role' => 'doctor', 'uid' => 2, 'name' => 'Dr', 'gid' => null], null, $now), 'nor the doctor');
    }

    public function testAGuestJoinsFrom15MinutesBeforeUntilAnHourAfterTheSlot(): void
    {
        $appointment = $this->appointment('+1 hour');
        $guest       = $appointment->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());
        $claims      = ['role' => 'guest', 'uid' => 100, 'name' => 'Bola Ade', 'gid' => $guest['id']];
        $start       = $appointment->getScheduledAt();

        [$status, , $errors] = CallAccess::problem($appointment, $claims, $guest, $start->modify('-16 minutes'));
        $this->assertSame(425, $status);
        $this->assertSame('too_early', $errors['code']);
        $this->assertSame($start->format(DATE_ATOM), $errors['starts_at']);
        $this->assertSame($start->modify('-15 minutes')->format(DATE_ATOM), $errors['opens_at']);
        $this->assertNull(CallAccess::problem($appointment, $claims, $guest, $start->modify('-16 minutes'), early: false), 'the lobby is open early');

        $this->assertNull(CallAccess::problem($appointment, $claims, $guest, $start->modify('-15 minutes')));
        $slot = $appointment->getSpecialist()->getSlotMinutes();
        $this->assertNull(CallAccess::problem($appointment, $claims, $guest, $start->modify('+' . ($slot + 60) . ' minutes')));
        $late = CallAccess::problem($appointment, $claims, $guest, $start->modify('+' . ($slot + 61) . ' minutes'));
        $this->assertSame([410, 'ended'], [$late[0], $late[2]['code']]);
        $this->assertNull(CallAccess::problem($appointment, $claims, $guest, $start->modify('+4 hours'), early: false, late: false), 'a call that runs over keeps its guests');
        $over = CallAccess::problem($appointment, $claims, $guest, $start->modify('+' . ($slot + 60 + 181) . ' minutes'), early: false, late: false);
        $this->assertSame([410, 'ended'], [$over[0], $over[2]['code']], '…for at most three hours more');

        $withdrawn = CallAccess::problem($appointment, $claims, null, $start);
        $this->assertSame([410, 'withdrawn'], [$withdrawn[0], $withdrawn[2]['code']]);
    }

    public function testTheJoinLinkRefusesWithClearReasons(): void
    {
        $jwt         = new JwtService(self::SECRET, 900, 1209600);
        $appointment = $this->appointment('+2 days');
        $guest       = $appointment->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());
        $action      = $this->joinAction($appointment, $jwt);
        $token       = GuestInvitations::token($jwt, $appointment, $guest);

        [$status, $body] = $this->join($action, $token);
        $this->assertSame(425, $status, 'two days early');
        $this->assertSame('too_early', $body['errors']['code']);
        $this->assertArrayHasKey('starts_at', $body['errors']);

        $appointment->removeGuest($guest['id']);
        [$status, $body] = $this->join($action, $token);
        $this->assertSame([410, 'withdrawn'], [$status, $body['errors']['code']], 'removed: the link stops at once');
        $this->assertSame(CallAccess::WITHDRAWN, $body['message']);

        $appointment->transitionTo(AppointmentStatus::CANCELLED);
        [$status, $body] = $this->join($action, $jwt->issueCallAccess($appointment->getId(), 'Ada Obi', 'patient', 1));
        $this->assertSame([410, 'cancelled'], [$status, $body['errors']['code']]);

        [$status] = $this->join($action, 'not-a-token');
        $this->assertSame(401, $status);
    }

    public function testAGuestStillInACallThatRunsOverCanRenew(): void
    {
        $jwt         = new JwtService(self::SECRET, 900, 1209600);
        $appointment = $this->appointment('-3 hours'); // its guest window closed an hour and a half ago
        $appointment->transitionTo(AppointmentStatus::CONFIRMED);
        $guest = $appointment->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());
        $token = GuestInvitations::token($jwt, $appointment, $guest);

        [$status, $body] = $this->join($this->joinAction($appointment, $jwt), $token);
        $this->assertSame([410, 'ended'], [$status, $body['errors']['code']], 'not in the call: too late');

        [$status, $body] = $this->join($this->joinAction($appointment, $jwt, [$guest['id']]), $token);
        $this->assertSame(200, $status, 'still in it: the renewal goes through');
        $this->assertSame(100, $body['data']['uid']);
        $this->assertSame(['name' => 'Bola Ade', 'role' => 'guest', 'uid' => 100, 'id' => $guest['id']], $body['data']['you']);
        $this->assertFalse($body['data']['consent']['required'], 'no recording set up: the privacy notice only');
        $this->assertArrayNotHasKey('patient', $body['data']);

        $longOver = $this->appointment('-5 hours');
        $longOver->transitionTo(AppointmentStatus::CONFIRMED);
        $stayer = $longOver->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());
        [$status, $body] = $this->join($this->joinAction($longOver, $jwt, [$stayer['id']]), GuestInvitations::token($jwt, $longOver, $stayer));
        $this->assertSame([410, 'ended'], [$status, $body['errors']['code']], 'renewing in the call has a limit too');
    }

    public function testAGuestInTheCallRenewsWithoutTheNoticeOnlyWhileNothingIsRecorded(): void
    {
        $consent = static fn (bool $required, bool $given, bool $active): array => ['required' => $required, 'given' => $given, 'recording_active' => $active];

        $this->assertFalse(JoinCallAction::consentBlocks($consent(false, false, false), false), 'no recording possible: the privacy notice only');
        $this->assertTrue(JoinCallAction::consentBlocks($consent(true, false, false), false), 'joining while recording could happen needs it');
        $this->assertFalse(JoinCallAction::consentBlocks($consent(true, true, true), false));
        $this->assertFalse(JoinCallAction::consentBlocks($consent(true, false, false), true), 'the patient agreed mid-call: recording waits for this guest instead');
        $this->assertTrue(JoinCallAction::consentBlocks($consent(true, false, true), true), 'never while a recording runs');
    }

    // ----- Recording waits for every guest who may be in the call -----

    /**
     * A GuestConsent whose presence reads the guest ids in `$inCall` as
     * heartbeating, or fails (Redis down) when null.
     *
     * @param list<string>|null $inCall
     */
    private function guestConsent(?array $inCall): GuestConsent
    {
        $em    = $this->em();
        $redis = new class ($inCall) extends RedisClient {
            /** @param list<string>|null $inCall */
            public function __construct(private readonly ?array $inCall)
            {
            }

            public function __call($commandID, $arguments): mixed
            {
                if ($this->inCall === null) {
                    throw new \RuntimeException('Connection refused');
                }

                return match (strtolower((string) $commandID)) {
                    'smembers' => $this->inCall,
                    'mget'     => array_map(static fn (): string => (string) time(), (array) $arguments[0]),
                    default    => throw new \LogicException("unexpected $commandID"),
                };
            }
        };

        return new GuestConsent(
            new ConsultationConsentRepository($em),
            new RecordingRepository($em),
            new AgoraRecordingService('', '', '', ['vendor' => 0, 'region' => 0, 'bucket' => '', 'accessKey' => '', 'secretKey' => '']),
            new CallPresence($redis),
        );
    }

    public function testRecordingWaitsForEveryGuestWhoMayBeInTheCall(): void
    {
        $now         = new DateTimeImmutable('2026-10-14T10:00:00+00:00');
        $appointment = $this->appointment();
        $beating     = $appointment->addGuest('A', 'a@example.test', '0', 'free', null, $now);
        $joining     = $appointment->addGuest('B', 'b@example.test', '0', 'free', null, $now);
        $agreed      = $appointment->addGuest('C', 'c@example.test', '0', 'free', null, $now);
        $appointment->updateGuest($joining['id'], ['rtc_issued_at' => $now->modify('-20 seconds')->format(DATE_ATOM)]);
        $appointment->updateGuest($agreed['id'], ['rtc_issued_at' => $now->format(DATE_ATOM), 'consented_at' => $now->format(DATE_ATOM)]);

        $state = $this->guestConsent([$beating['id']])->connectedGuests($appointment, $now);
        $this->assertSame(3, $state['connected'], 'by heartbeat, or given a token before their first one');
        $this->assertSame([$beating['id'], $joining['id']], $state['pending_ids']);
        $this->assertFalse($state['unknown']);

        $appointment->updateGuest($joining['id'], ['left_at' => $now->modify('-5 seconds')->format(DATE_ATOM)]);
        $this->assertSame([$beating['id']], $this->guestConsent([$beating['id']])->connectedGuests($appointment, $now)['pending_ids'], 'left cleanly since');
        $this->assertSame(1, $this->guestConsent([$beating['id']])->connectedGuests($appointment, $now->modify('+10 minutes'))['connected'], 'their token has expired');

        $appointment->removeGuest($beating['id']);
        $this->assertSame(0, $this->guestConsent([$beating['id']])->connectedGuests($appointment, $now)['pending'], 'removed: not waited for');

        $down = $this->guestConsent(null)->connectedGuests($appointment, $now);
        $this->assertTrue($down['unknown']);
        $this->assertSame([$joining['id']], $down['pending_ids'], "Redis down: every invited guest who hasn't agreed counts");
        $this->assertNull((new CallPresence(new class extends RedisClient {
            public function __construct()
            {
            }

            public function __call($commandID, $arguments): mixed
            {
                throw new \RuntimeException('Connection refused');
            }
        }))->tryForAppointment($appointment), 'unknown, not "nobody"');

        $this->assertSame("1 guest in the call hasn't agreed to recording yet.", StartRecordingAction::guestsWaitMessage(1, false));
        $this->assertSame("2 guests in the call haven't agreed to recording yet.", StartRecordingAction::guestsWaitMessage(2, false));
        $this->assertStringStartsWith("We can't check who is in the call right now, and 1 invited guest hasn't", StartRecordingAction::guestsWaitMessage(1, true));
    }

    public function testAGuestTokenCountsUntilItExpiresOrTheyLeave(): void
    {
        $now   = new DateTimeImmutable('2026-10-14T10:00:00+00:00');
        $guest = ['id' => 'g', 'uid' => 100, 'rtc_issued_at' => $now->modify('-9 minutes')->format(DATE_ATOM)];

        $this->assertTrue(CallAccess::guestMayHoldToken($guest, $now));
        $this->assertFalse(CallAccess::guestMayHoldToken($guest, $now->modify('+1 minute')), 'GUEST_RTC_TTL is 10 minutes');
        $this->assertFalse(CallAccess::guestMayHoldToken(['id' => 'g'], $now), 'never given one');
        $this->assertTrue(CallAccess::guestMayBeConnected($guest, $now));
        $this->assertFalse(CallAccess::guestMayBeConnected(['left_at' => $now->modify('-1 minute')->format(DATE_ATOM)] + $guest, $now));
        $this->assertTrue(CallAccess::guestMayHoldToken(['left_at' => $now->modify('-1 minute')->format(DATE_ATOM)] + $guest, $now), 'left, but the token in hand still works');
        $this->assertTrue(CallAccess::guestMayBeConnected(['left_at' => $now->modify('-10 minutes')->format(DATE_ATOM)] + $guest, $now), 'left before rejoining');
    }

    // ----- A removed guest is put out of the call -----

    public function testARemovedGuestIsPutOutOfTheChannel(): void
    {
        $sent      = [];
        $transport = static function (string $url, array $headers, string $body) use (&$sent): array {
            $sent[] = [$url, $headers, json_decode($body, true)];

            return ['status' => 200, 'body' => '{"status":"success","id":1953}'];
        };
        $kicker = new AgoraKickingService('app-id', 'customer', 'secret', null, $transport);

        $this->assertTrue($kicker->kick('appt-1', 101, 60));
        [$url, $headers, $body] = $sent[0];
        $this->assertSame('https://api.agora.io/dev/v1/kicking-rule', $url);
        $this->assertContains('Authorization: Basic ' . base64_encode('customer:secret'), $headers);
        $this->assertSame(['appid' => 'app-id', 'cname' => 'appt-1', 'uid' => 101, 'ip' => '', 'time' => 60, 'privileges' => ['join_channel']], $body);
        $kicker->kick('appt-1', 101, 99999);
        $this->assertSame(1440, $sent[1][2]['time'], "within Agora's range");

        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects($this->once())->method('error');
        $refused = new AgoraKickingService('app-id', 'customer', 'secret', $logger, static fn (): array => ['status' => 401, 'body' => '{"message":"Invalid authentication credentials"}']);
        $this->assertFalse($refused->kick('appt-1', 101, 60), 'logged, never thrown');

        $unset = new AgoraKickingService('app-id', '', '', null, static fn (): array => throw new \LogicException('must not be called'));
        $this->assertFalse($unset->isConfigured());
        $this->assertFalse($unset->kick('appt-1', 101, 60));
    }

    public function testGuestsAreToldOfACancellationAfterAFailedBatchClosedTheEntityManager(): void
    {
        $appointment = $this->appointment('+5 minutes');
        $appointment->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());
        $appointment->addGuest('Chidi Eze', 'chidi@example.test', '0', 'free', null, new DateTimeImmutable());
        // A later suspension batch failed: the entity manager is closed, though
        // this cancellation was committed before it.
        $closed = new class ($this->em()) extends EntityManagerDecorator {
            public function wrapInTransaction(callable $func): mixed
            {
                throw EntityManagerClosed::create();
            }
        };
        $mailed = [];
        $logger = $this->createMock(LoggerInterface::class);
        $logger->method('info')->willReturnCallback(static function (string $message, array $context = []) use (&$mailed): void {
            $mailed[] = $context['to_hash'] ?? ''; // the log never holds the address (spec §3.7)
        });
        // Redis down too: presence reads as "nobody", and nothing stops the notices.
        $redis = new class extends RedisClient {
            public function __construct()
            {
            }

            public function __call($commandID, $arguments): mixed
            {
                throw new \RuntimeException('redis unavailable');
            }
        };
        $blank       = static fn (string $class): object => (new \ReflectionClass($class))->newInstanceWithoutConstructor();
        $invitations = new GuestInvitations(
            new AppointmentRepository($closed),
            $blank(AppointmentPaymentService::class),
            $blank(PaymentIntentService::class),
            $blank(PricingService::class),
            new MailService('', '', '', '', $logger),
            new JwtService(self::SECRET, 900, 1209600),
            $blank(AuditLogger::class),
            $blank(PatientNotifier::class),
            $blank(StaffNotifier::class),
            new CallPresence($redis),
            new AgoraKickingService('app-id', '', ''),
        );

        $invitations->notifyCancelled($appointment);

        $this->assertSame(
            [MailService::toHash('bola@example.test'), MailService::toHash('chidi@example.test')],
            $mailed,
            'every guest is still told',
        );
    }

    public function testEveryoneSeesWhoIsInTheCallByUidNamesOnly(): void
    {
        $appointment = $this->appointment('+5 minutes');
        $guest       = $appointment->addGuest('Bola Ade', 'bola@example.test', '0', 'free', null, new DateTimeImmutable());
        $appointment->updateGuest($guest['id'], ['display_name' => 'Auntie Bola', 'consented_at' => '2026-10-14T10:00:00+00:00']);

        $this->assertSame([
            ['uid' => 1, 'role' => 'patient', 'name' => 'Ada Obi'],
            ['uid' => 2, 'role' => 'doctor', 'name' => 'Dr. Grace Bell'],
            ['uid' => 100, 'role' => 'guest', 'name' => 'Auntie Bola', 'id' => $guest['id'], 'consented' => true],
        ], CallAccess::participants($appointment));

        $claims  = ['role' => 'guest', 'uid' => 100, 'name' => 'Bola Ade', 'gid' => $guest['id']];
        $meeting = JoinCallAction::meeting($appointment, $claims, $appointment->findGuest($guest['id']));
        $this->assertSame(['name' => 'Auntie Bola', 'role' => 'guest', 'uid' => 100, 'id' => $guest['id']], $meeting['you']);
        $this->assertSame(['first_name' => 'Ada'], $meeting['invited_by']);
        $this->assertArrayNotHasKey('patient', $meeting, 'never the clinical summary');
        $json = (string) json_encode($meeting);
        foreach (['bola@example.test', 'ada@example.test', 'grace.bell@clinic.test'] as $email) {
            $this->assertStringNotContainsString($email, $json, 'never an email');
        }
    }

    // ----- The guest list -----

    public function testWhenTheGuestListCanChange(): void
    {
        $now = new DateTimeImmutable();
        $this->assertNull(GuestInvitations::manageProblem($this->appointment(), $now));
        $confirmed = $this->appointment('-10 minutes');
        $confirmed->transitionTo(AppointmentStatus::CONFIRMED);
        $this->assertNull(GuestInvitations::manageProblem($confirmed, $now), 'during the call too');
        $this->assertNotNull(GuestInvitations::manageProblem($this->appointment('-5 hours'), $now), 'not once the guest window closed');
        $cancelled = $this->appointment();
        $cancelled->transitionTo(AppointmentStatus::CANCELLED);
        $this->assertNotNull(GuestInvitations::manageProblem($cancelled, $now));
    }

    public function testAGuestIsSomeoneElseAndThereAreAtMostThree(): void
    {
        $appointment = $this->appointment();
        $problems    = static fn (string $email): array => GuestInvitations::newGuestProblems($appointment, 'Someone', $email);

        $this->assertSame([], $problems('someone@example.test'));
        $this->assertArrayHasKey('email', $problems('not-an-email'));
        $this->assertArrayHasKey('email', $problems('ADA@example.test'), "the patient's own");
        $this->assertArrayHasKey('email', $problems('grace.bell@clinic.test'), "the doctor's");
        $this->assertArrayHasKey('name', GuestInvitations::newGuestProblems($appointment, '', 'x@example.test'));

        foreach (['a', 'b', 'c'] as $who) {
            $appointment->addGuest($who, $who . '@example.test', '0', 'free', null, new DateTimeImmutable());
        }
        $this->assertArrayHasKey('email', $problems('B@example.test'), 'already invited');
        $this->assertSame('You can invite at most 3 guests', $problems('d@example.test')['guests']);

        $booking = GuestInvitations::bookingGuestProblems(
            [['name' => 'A', 'email' => 'a@example.test'], ['name' => 'A again', 'email' => 'A@example.test'], ['name' => 'Me', 'email' => 'ada@example.test']],
            $appointment->getPatient(),
            $appointment->getSpecialist(),
        );
        $this->assertSame(['guests.1.email', 'guests.2.email'], array_keys($booking));
    }

    public function testARemovedGuestsFeeIsRefundedOnlyBeforeTheStart(): void
    {
        $appointment = $this->appointment('+1 day');
        $appointment->setAmount('25000.00');
        $guest = $appointment->addGuest('Bola', 'bola@example.test', '5000', 'wallet', null, new DateTimeImmutable());
        $now   = new DateTimeImmutable();

        $this->assertSame('5000.00', GuestInvitations::refundFor($appointment, $guest, $now));
        $this->assertNull(GuestInvitations::refundFor($appointment, $guest, $appointment->getScheduledAt()), 'from the start: no refund');
        $this->assertNull(GuestInvitations::refundFor($appointment, ['fee' => '0.00'] + $guest, $now), 'free: nothing to give back');
        $appointment->setPaymentStatus('unpaid');
        $this->assertNull(GuestInvitations::refundFor($appointment, $guest, $now), 'never paid');
    }

    public function testAnInvitationIsResentAtMostEveryTwoMinutes(): void
    {
        $now   = new DateTimeImmutable('2026-10-14T10:00:00+00:00');
        $guest = ['invited_at' => '2026-10-14T09:59:00+00:00', 'last_sent_at' => null];
        $this->assertSame(60, GuestInvitations::resendWait($guest, $now));
        $this->assertSame(0, GuestInvitations::resendWait(['last_sent_at' => '2026-10-14T09:58:00+00:00'] + $guest, $now));

        $this->assertSame('invited', GuestInvitations::status([]));
        $this->assertSame('consented', GuestInvitations::status(['consented_at' => 'x']));
        $this->assertSame('joined', GuestInvitations::status(['consented_at' => 'x', 'joined_at' => 'y']));
    }

    // ----- One channel per appointment -----

    public function testTheSharedStaticChannelIsRefusedInProduction(): void
    {
        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects($this->once())->method('error');
        $prod = new AgoraTokenService('app', '', 'static-token', 'shared-room', true, $logger);
        $this->assertFalse($prod->hasStaticToken(), 'ignored in production');

        $dev = new AgoraTokenService('app', '', 'static-token', 'shared-room', false);
        $this->assertTrue($dev->hasStaticToken());
        $this->assertSame('shared-room', $dev->staticChannel());
    }

    // ----- What guests are told -----

    public function testGuestEmailsNameTheInviterAndNothingClinical(): void
    {
        ClinicTime::configure('Africa/Lagos');
        $invite = EmailTemplates::guestInvite('Bola', 'Ada', 'Dr. Grace Bell', 'Tue 20 Oct, 3:00 PM WAT', 'https://app.example/call/join/tok');
        $this->assertSame('Ada invited you to a VideoMed video consultation', $invite['subject']);
        $this->assertStringContainsString('Ada invited you to join their video consultation with Dr. Grace Bell on Tue 20 Oct, 3:00 PM WAT.', $invite['html']);
        $this->assertStringContainsString('https://app.example/call/join/tok', $invite['html']);
        $this->assertStringContainsString('because Ada invited you', $invite['html']);
        $this->assertStringNotContainsString('have a VideoMed account', $invite['html']);

        $moved = EmailTemplates::guestRescheduled('Bola', 'Ada', 'Dr. Grace Bell', 'Wed 21 Oct, 9:00 AM WAT', 'https://app.example/call/join/new');
        $this->assertStringContainsString('has moved to Wed 21 Oct, 9:00 AM WAT', $moved['html']);
        $this->assertStringContainsString('https://app.example/call/join/new', $moved['html']);

        $this->assertSame('Your VideoMed invitation was withdrawn', EmailTemplates::guestCallClosed('Bola', 'Ada', 'Dr. Grace Bell', 'x', 'removed')['subject']);
        $cancelled = EmailTemplates::guestCallClosed('Bola', 'Ada', 'Dr. Grace Bell', 'Tue 20 Oct', 'cancelled');
        $this->assertSame('The VideoMed consultation you were invited to was cancelled', $cancelled['subject']);
        $this->assertStringContainsString('Your join link no longer works.', $cancelled['html']);
    }

    // ----- Routes + queries -----

    public function testTheGuestRoutesResolve(): void
    {
        $_ENV['DB_SERVER_VERSION'] = '16';
        DoctrineEntityManagerFactory::reset();
        $builder = new ContainerBuilder();
        $builder->addDefinitions(__DIR__ . '/../../config/container.php');
        $container = $builder->build();
        AppFactory::setContainer($container);
        $app = AppFactory::create();
        (require __DIR__ . '/../../config/routes.php')($app);

        $id     = '00000000-0000-0000-0000-000000000001';
        $routes = [
            ['POST', "/api/portal/appointments/$id/guests/pay-init", InitGuestPaymentAction::class],
            ['DELETE', "/api/portal/appointments/$id/guests/$id", RemoveMyGuestAction::class],
            ['POST', "/api/portal/appointments/$id/guests/$id/resend", ResendMyGuestInviteAction::class],
            ['GET', '/api/public/call/tok/lobby', CallLobbyAction::class],
            ['POST', '/api/public/call/tok/consent', GuestConsentAction::class],
        ];
        foreach ($routes as [$method, $path, $action]) {
            $result = $app->getRouteResolver()->computeRoutingResults($path, $method);
            $this->assertSame(RoutingResults::FOUND, $result->getRouteStatus(), "$method $path");
            $this->assertSame($action, $app->getRouteCollector()->lookupRoute((string) $result->getRouteIdentifier())->getCallable());
        }
        $this->assertIsObject($container->get(GuestInvitations::class));
        $this->assertIsObject($container->get(GuestConsent::class));
    }

    public function testAGuestCardPaymentCountsAsUsed(): void
    {
        $this->assertStringContainsString('CAST(guests AS jsonb) @>', AppointmentRepository::GUEST_PAYMENT_SQL);
    }
}
