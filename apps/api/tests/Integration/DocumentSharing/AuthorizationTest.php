<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Doctor\CancelDocumentAccessRequestAction;
use App\Action\Doctor\DoctorDocumentAccessAction;
use App\Action\Doctor\ListPatientDocumentsAction;
use App\Action\Doctor\RequestDocumentAccessAction;
use App\Action\DocumentSharing\ApproveAccessRequestAction;
use App\Action\DocumentSharing\CreateDocumentShareAction;
use App\Action\DocumentSharing\GetAccessRequestAction;
use App\Action\DocumentSharing\GetDocumentAccessAction;
use App\Action\DocumentSharing\RestoreDocumentGrantAction;
use App\Action\DocumentSharing\RevokeDocumentGrantAction;
use App\Action\DocumentSharing\UpdateDocumentGrantAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\User;
use Ramsey\Uuid\Uuid;

/**
 * IDOR and authorisation (spec §7.2): a patient only ever reaches their own
 * shares, documents and requests; only doctors they booked can receive a
 * share; consultations are validated whenever named; a doctor only reaches
 * their own consultations; ids are case-insensitive.
 */
final class AuthorizationTest extends DocShareTestCase
{
    public function testAPatientCannotTouchAnotherPatientsShare(): void
    {
        $qGrant = $this->share($this->Q, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->Q1]])['grants'][0]['id'];

        $this->assertSame(404, $this->patientAction(RevokeDocumentGrantAction::class, $this->P, [], ['id' => $qGrant])['status']);
        $this->assertSame(404, $this->patientAction(UpdateDocumentGrantAction::class, $this->P, ['duration' => '30d'], ['id' => $qGrant], method: 'PATCH')['status']);
        $this->assertSame(404, $this->patientAction(RestoreDocumentGrantAction::class, $this->P, [], ['id' => $qGrant])['status']);
        $this->assertSame(404, $this->patientAction(GetDocumentAccessAction::class, $this->P, [], ['id' => $this->Q1], method: 'GET')['status']);
        $this->assertSame('active', $this->conn()->fetchOne('SELECT status FROM document_access_grants WHERE id = ?', [$qGrant]));
    }

    public function testAnotherPatientsDocumentIsNotFound(): void
    {
        $res = $this->createShare($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->Q1]]);
        $this->assertSame(422, $res['status']);
        $this->assertSame('One of these documents could not be found.', $res['body']['errors']['document_ids.0']);
    }

    public function testAPatientCannotAnswerARequestAddressedToSomeoneElse(): void
    {
        [$svc, $em] = $this->request();
        $req = $svc->requestAccess($this->doctor($em, $this->A), $em->find(Appointment::class, $this->aqNext), $this->userA, null, $this->now);

        $this->assertSame(404, $this->patientAction(ApproveAccessRequestAction::class, $this->P, ['scope' => 'all', 'duration' => '7d'], ['id' => (string) $req['id']])['status']);
        $this->assertSame(404, $this->patientAction(GetAccessRequestAction::class, $this->P, [], ['id' => (string) $req['id']], method: 'GET')['status']);
    }

    public function testOnlyBookedPractisingDoctorsCanReceiveAShare(): void
    {
        $never = $this->createShare($this->P, ['specialist_ids' => [$this->C]]);
        $this->assertSame(422, $never['status']);
        $this->assertSame('doctor_not_eligible', $never['body']['errors']['code']);

        $this->suspend($this->B, $this->now);
        $away = $this->createShare($this->P, ['specialist_ids' => [$this->B]]);
        $this->assertSame(422, $away['status']);
        $this->assertSame('doctor_unavailable', $away['body']['errors']['code']);

        $unknown = $this->createShare($this->P, ['specialist_ids' => [Uuid::uuid4()->toString()]]);
        $this->assertSame('doctor_not_eligible', $unknown['body']['errors']['code'], 'unknown and foreign read the same');
    }

    public function testANamedConsultationMustBeThePatientsWithThatDoctor(): void
    {
        $proposal = $this->proposal();
        $this->conn()->executeStatement('UPDATE appointments SET deleted_at = ? WHERE id = ?', [Rules::sql($this->now), $this->apPast]);
        foreach ([$this->aqNext, $this->bpNext, $this->apPast, $proposal] as $appointmentId) {
            $res = $this->createShare($this->P, ['specialist_ids' => [$this->A], 'duration' => '7d', 'appointment_id' => $appointmentId]);
            $this->assertSame(422, $res['status'], $appointmentId);
            $this->assertSame('This consultation could not be found.', $res['body']['errors']['appointment_id']);
        }

        $grant = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P1], 'duration' => '7d'])['grants'][0]['id'];
        $patch = $this->patientAction(UpdateDocumentGrantAction::class, $this->P, ['duration' => 'after_7d', 'appointment_id' => $this->aqNext], ['id' => $grant], method: 'PATCH');
        $this->assertSame(422, $patch['status']);
        $this->assertArrayHasKey('appointment_id', $patch['body']['errors']);

        [$svc, $em] = $this->request();
        $req     = $svc->requestAccess($this->doctor($em, $this->A), $em->find(Appointment::class, $this->apNext), $this->userA, null, $this->now);
        $approve = $this->patientAction(ApproveAccessRequestAction::class, $this->P, ['scope' => 'all', 'duration' => 'after_7d', 'appointment_id' => $this->bpNext], ['id' => (string) $req['id']]);
        $this->assertSame(422, $approve['status']);
        $this->assertArrayHasKey('appointment_id', $approve['body']['errors']);
    }

    public function testADoctorOnlyReachesTheirOwnUndeletedConsultations(): void
    {
        $this->share($this->Q, ['specialist_ids' => [$this->D]]);
        $this->assertSame(403, $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->dqNext], method: 'GET')['status']);
        $this->assertSame(403, $this->doctorAction(ListPatientDocumentsAction::class, $this->userA, ['id' => $this->dqNext], method: 'GET')['status']);
        $this->assertSame(403, $this->doctorAction(RequestDocumentAccessAction::class, $this->userA, ['id' => $this->dqNext])['status']);

        $this->conn()->executeStatement('UPDATE appointments SET deleted_at = ? WHERE id = ?', [Rules::sql($this->now), $this->apNext]);
        $this->assertSame(403, $this->doctorAction(RequestDocumentAccessAction::class, $this->userA, ['id' => $this->apNext])['status']);
        $this->assertSame(403, $this->doctorAction(CancelDocumentAccessRequestAction::class, $this->userA, ['id' => $this->apNext])['status']);

        // Staff without the doctor role.
        $em   = $this->em();
        $user = new User('staff-' . bin2hex(random_bytes(3)) . '@example.test', 'Sam', 'Staff');
        $user->setRoles(['admin']);
        $em->persist($user);
        $em->flush();
        $this->assertSame(403, $this->doctorAction(DoctorDocumentAccessAction::class, $user->getId(), ['id' => $this->apPast], method: 'GET')['status']);
    }

    public function testMixedCaseIdsBehaveExactlyLikeLowerCase(): void
    {
        $this->share($this->P, ['specialist_ids' => [strtoupper($this->A)], 'scope' => 'selected', 'document_ids' => [strtoupper($this->P1)]]);
        $second = $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$this->P2]]);

        $this->assertSame('merged', $second['outcomes'][0]['outcome'], 'the same pair, the same lock, the same rows');
        $this->assertSame(1, $this->countRows('SELECT COUNT(*) FROM document_access_grants WHERE specialist_id = ?', [$this->A]));
        $this->assertSame($this->sorted([$this->P1, $this->P2]), $this->visible($this->A, $this->P));
        $res = $this->patientAction(GetDocumentAccessAction::class, $this->P, [], ['id' => strtoupper($this->P1)], method: 'GET');
        $this->assertSame(200, $res['status']);
        $this->assertSame($this->A, $res['body']['data']['doctors'][0]['specialist_id']);
    }

    // ----- Helpers -----

    /** @return array{status:int, body:array<string,mixed>} */
    private function createShare(string $patientId, array $input): array
    {
        return $this->patientAction(CreateDocumentShareAction::class, $patientId, $input + [
            'scope'      => 'all',
            'duration'   => 'indefinite',
            'client_key' => Uuid::uuid4()->toString(),
            'surface'    => 'manage_sharing',
        ]);
    }

    /** A follow-up proposal of A's completed consultation with P. */
    private function proposal(): string
    {
        $em     = $this->em();
        $parent = $em->find(Appointment::class, $this->apPast);
        $p      = Appointment::proposeFollowUp(
            $parent,
            $this->now->modify('+6 days')->setTime(10, 0),
            ['base_fee' => '0.00', 'amount' => '0.00', 'rule' => 'percent', 'discount_percent' => 0, 'window_days' => 14, 'window_ends_at' => $this->now->modify('+14 days')->format(DATE_ATOM), 'waived' => true],
            null,
            $this->now->modify('+3 days'),
        );
        $em->persist($p);
        $em->flush();

        return $p->getId();
    }
}
