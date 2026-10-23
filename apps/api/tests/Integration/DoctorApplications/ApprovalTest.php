<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

use App\Domain\Entity\Specialist;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Entity\User;
use App\Infrastructure\Storage\CredentialStore;

/** Spec §4.2–4.3: approval creates the doctor, carries the documents as verified credentials, emails the link. */
final class ApprovalTest extends DoctorApplicationsTestCase
{
    public function testApprovalCreatesTheDoctorAndCarriesTheDocuments(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);

        $detail = $this->staffCall($staff, 'GET', '/' . $app['id'])['body']['data'];
        $this->assertTrue($detail['approval']['ready'], json_encode($detail['approval']['problems']));
        $this->assertSame('new', $detail['approval']['login']['state']);
        $this->assertCount(6, $detail['approval']['documents']);
        $this->assertSame('the MDCN register', $detail['approval']['register_name']);

        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $this->approveBody($staff, $app['id']));
        $this->assertCode($res, 200);
        $data = $res['body']['data'];
        $this->assertSame('approved', $data['application']['status']);
        $this->assertArrayHasKey('dev_link', $data['invite']);
        $this->assertFalse($data['invite']['email_sent'], 'mail is unconfigured in tests');
        $this->assertSame('ada.obi@example.com', $data['invite']['login']['email']);

        $em = $this->em();
        $s  = $em->find(Specialist::class, $data['specialist_id']);
        $this->assertInstanceOf(Specialist::class, $s);
        $this->assertSame('invited', $s->getStatus()->value, 'not bookable until they go live');
        $this->assertSame('Dr. Ada Obi', $s->getName());
        $this->assertSame($app['id'], $s->getApplicationId());
        $this->assertSame('MDCN/12345', $s->getMdcnNumber());
        $this->assertSame('15000.00', $s->getConsultationFee());
        $this->assertSame('ng', $s->getLicenceRoute());
        $this->assertNotNull($s->getLicenceExpiresAt());
        $this->assertTrue($s->identityLocked());
        $user = $em->getRepository(User::class)->findOneBy(['email' => 'ada.obi@example.com']);
        $this->assertSame($s->getId(), $user?->getSpecialistId());
        $this->assertSame(['doctor'], $user?->getRoles());

        $creds = $em->getRepository(SpecialistCredential::class)->findBy(['specialistId' => $s->getId()]);
        $this->assertCount(6, $creds);
        $store = $this->container()->get(CredentialStore::class);
        foreach ($creds as $c) {
            $this->assertTrue($c->isVerified());
            $this->assertStringStartsWith('credentials/', $c->getVaultKey());
            $this->assertStringStartsWith('%PDF-', (string) $store->bytes($c->getVaultKey()), 're-sealed and readable');
            $this->assertStringContainsString('Verified at application ' . $app['reference'], (string) json_encode($c->toArray(true)['attestation']));
        }

        $this->assertSame(6, $this->rows('SELECT COUNT(*) FROM doctor_application_documents WHERE credential_id IS NOT NULL AND file_purged_at IS NOT NULL'), 'the application copies are purged');
        $snapshot = json_decode((string) $this->conn()->fetchOne('SELECT approval_snapshot FROM doctor_applications'), true);
        $this->assertSame('Dr. Ada Obi', $snapshot['locked']['name']);
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind = 'approved'"));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM doctor_application_events WHERE kind = 'specialist_created'"));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM specialist_status_events WHERE code = 'from_application'"));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM audit_events WHERE action = 'doctor_application.approved'"));
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM audit_events WHERE action = 'specialist.created_from_application'"));

        // After the purge, the staff file view streams the credential's copy (and audits it).
        $doc  = $detail['documents'][0]['id'];
        $file = $this->http('GET', '/api/doctor-applications/' . $app['id'] . '/documents/' . $doc . '/file', null, $staff);
        $this->assertSame(200, $file['status']);
        $this->assertStringStartsWith('%PDF-', (string) $file['response']->getBody());
        $this->assertGreaterThanOrEqual(1, $this->rows("SELECT COUNT(*) FROM audit_events WHERE action = 'doctor_application.document_viewed'"));
    }

    public function testFieldErrorsAndTakeoverRefusals(): void
    {
        $app   = $this->submitted('ng', 'taken@example.com');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);

        $body = $this->approveBody($staff, $app['id']);
        $first = array_key_first($body['documents']);
        $body['documents'][$first]['checked'] = false;
        $body['consultation_fee'] = '0';
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $body);
        $this->assertCode($res, 422);
        $this->assertArrayHasKey('documents.' . $first . '.checked', $res['body']['errors']);
        $this->assertArrayHasKey('consultation_fee', $res['body']['errors']);

        // A staff login with this email: refused (reviewer only), and the preview says so.
        $em    = $this->em();
        $other = new User('taken@example.com', 'Staff', 'Member');
        $other->setRoles(['admin']);
        $em->persist($other);
        $em->flush();
        $detail = $this->staffCall($staff, 'GET', '/' . $app['id'])['body']['data'];
        $this->assertSame('blocked', $detail['approval']['login']['state']);
        $this->assertFalse($detail['approval']['ready']);
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $this->approveBody($staff, $app['id']));
        $this->assertCode($res, 422);
        $this->assertStringContainsString('staff account', $res['body']['errors']['email']);

        // A soft-deleted login.
        $this->conn()->executeStatement("UPDATE users SET deleted_at = '2026-01-01 00:00:00' WHERE email = 'taken@example.com'");
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $this->approveBody($staff, $app['id']));
        $this->assertCode($res, 422);
        $this->assertStringContainsString('deleted login', $res['body']['errors']['email']);
        $this->conn()->executeStatement("DELETE FROM users WHERE email = 'taken@example.com'");

        // An existing doctor profile with this email.
        $em = $this->em();
        $s  = new Specialist('Dr. Earlier Profile', 'Cardiology');
        $s->setEmail('taken@example.com');
        $em->persist($s);
        $em->flush();
        $detail = $this->staffCall($staff, 'GET', '/' . $app['id'])['body']['data'];
        $this->assertSame('blocked', $detail['approval']['login']['state']);
        $this->assertStringContainsString('Dr. Earlier Profile', (string) $detail['approval']['login']['problem']);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/approve', $this->approveBody($staff, $app['id'])), 422);
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM specialist_credentials'), 'nothing was created');
        $this->assertSame('under_review', $this->conn()->fetchOne('SELECT status FROM doctor_applications'));
    }

    public function testLongNamesAndTenLongDegreesFit(): void
    {
        $d = $this->createDraft('ng', 'long@example.com');
        $personal = ['first_name' => str_repeat('A', 100), 'last_name' => str_repeat('B', 99)] + self::personal('long@example.com'); // 100 + 100 could not sign within 200 characters
        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/personal', ['values' => $personal], $d['token']), 200);
        $sections = self::sections('ng');
        $sections['qualifications'] = ['entries' => array_fill(0, 10, ['degree' => str_repeat('D', 100), 'institution' => 'University of Lagos', 'year_awarded' => 2010])];
        $sections['consent']['signature_name'] = str_repeat('A', 100) . ' ' . str_repeat('B', 99);
        foreach ($sections as $section => $values) {
            $this->assertCode($this->http('PUT', '/api/public/doctor-applications/drafts/current/sections/' . $section, ['values' => $values], $d['token']), 200, null, $section);
        }
        foreach (\App\Domain\Application\ApplicationDocuments::requiredFor('ng') as $slot) {
            $this->upload($d['token'], $slot);
        }
        $this->verifyEmail($d['token']);
        $sub   = $this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $d['token']);
        $this->assertCode($sub, 200);
        $id    = $sub['body']['data']['id'];
        $staff = $this->staff()['token'];
        $this->underReview($staff, $id);
        $res = $this->staffCall($staff, 'POST', '/' . $id . '/approve', $this->approveBody($staff, $id));
        $this->assertCode($res, 200);
        $s = $this->em()->find(Specialist::class, $res['body']['data']['specialist_id']);
        $this->assertLessThanOrEqual(200, mb_strlen($s->getName()));
        $this->assertLessThanOrEqual(300, mb_strlen((string) $s->getQualifications()));
        $this->assertCount(10, $s->getQualificationEntries());
    }
}
