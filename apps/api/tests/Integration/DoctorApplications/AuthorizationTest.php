<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

/** Spec §3.3, §3.5, §8: who can reach what. */
final class AuthorizationTest extends DoctorApplicationsTestCase
{
    public function testStaffRoutesNeedSpecialistsManage(): void
    {
        $app = $this->submitted('ng');
        $this->assertSame(401, $this->http('GET', '/api/doctor-applications')['status']);
        $support = $this->staff(['support.manage'], 'support@videomed.test')['token'];
        foreach ([['GET', ''], ['GET', '/queue'], ['GET', '/' . $app['id']], ['POST', '/' . $app['id'] . '/start-review'], ['GET', '/' . $app['id'] . '/notes']] as [$method, $path]) {
            $this->assertSame(403, $this->staffCall($support, $method, $path, $method === 'POST' ? [] : null)['status'], "$method $path");
        }
        $staff = $this->staff()['token'];
        $this->assertCode($this->staffCall($staff, 'GET', ''), 200);
        $this->assertCode($this->staffCall($staff, 'GET', '/queue'), 200);
        $this->assertCode($this->staffCall($staff, 'GET', '/not-a-uuid'), 404);
        // An applicant token is not a staff token.
        $this->assertSame(401, $this->http('GET', '/api/doctor-applications', null, $app['token'])['status']);
    }

    public function testDraftsAreNeverShownToStaff(): void
    {
        $draft = $this->createDraft('ng', 'draft@example.com');
        $this->upload($draft['token'], 'government_id');
        $doc   = (string) $this->conn()->fetchOne('SELECT id FROM doctor_application_documents');
        $staff = $this->staff()['token'];
        $list  = $this->staffCall($staff, 'GET', '?filter=all')['body'];
        $this->assertSame(0, $list['meta']['total']);
        $this->assertSame(0, (int) $this->staffCall($staff, 'GET', '/queue')['body']['data']['needs_action']);
        $id = $draft['draft']['id'];
        $this->assertCode($this->staffCall($staff, 'GET', '/' . $id), 404);
        $this->assertCode($this->staffCall($staff, 'GET', '/' . $id . '/documents/' . $doc . '/file'), 404);
        $this->assertCode($this->staffCall($staff, 'GET', '/' . $id . '/notes'), 404);
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $id . '/notes', ['body' => 'x']), 404);
    }

    public function testApplicantsReachOnlyTheirOwnDocuments(): void
    {
        $a = $this->createDraft('ng', 'a@example.com');
        $b = $this->createDraft('ng', 'b@example.com');
        $this->upload($b['token'], 'government_id');
        $bDoc = (string) $this->conn()->fetchOne('SELECT id FROM doctor_application_documents');
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/drafts/current/documents/' . $bDoc . '/file', null, $a['token']), 404);
        $this->assertCode($this->http('DELETE', '/api/public/doctor-applications/drafts/current/documents/' . $bDoc, null, $a['token']), 404);
        $this->assertSame(1, $this->rows('SELECT COUNT(*) FROM doctor_application_documents'));

        // A document id from another application on the staff side.
        $app   = $this->submitted('ng', 'c@example.com');
        $staff = $this->staff()['token'];
        $this->assertCode($this->staffCall($staff, 'GET', '/' . $app['id'] . '/documents/' . $bDoc . '/file'), 404);

        // The status side: a draft token opens nothing there; an access token opens no draft route.
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/track/status', null, $a['token']), 401, 'applicant_token_invalid');
        $access = $this->trackToken($app['reference'], $app['email']);
        $this->assertCode($this->http('GET', '/api/public/doctor-applications/track/documents/' . $bDoc . '/file', null, $access), 404);
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/drafts/current/submit', [], $access), 401, 'applicant_token_invalid');
    }

    public function testNotesAreStaffOnly(): void
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->assertCode($this->staffCall($staff, 'POST', '/' . $app['id'] . '/notes', ['body' => '']), 422);
        $note = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/notes', ['body' => 'Called the referee']);
        $this->assertCode($note, 201);
        $this->assertSame('Rita Reviewer', $note['body']['data']['author_name']);
        $this->assertSame(1, $this->staffCall($staff, 'GET', '/' . $app['id'])['body']['data']['notes_count']);
        $access = $this->trackToken($app['reference'], $app['email']);
        $this->assertStringNotContainsString('Called the referee', (string) json_encode($this->http('GET', '/api/public/doctor-applications/track/application', null, $access)['body']));
        $meta = (string) $this->conn()->fetchOne("SELECT metadata FROM audit_events WHERE action = 'doctor_application.note_added'");
        $this->assertStringNotContainsString('referee', $meta, 'audited without its text');
    }
}
