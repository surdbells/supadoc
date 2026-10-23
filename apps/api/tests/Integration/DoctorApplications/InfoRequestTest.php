<?php

declare(strict_types=1);

namespace App\Tests\Integration\DoctorApplications;

/** Spec §3.2.22–3.2.26, D17: the applicant answers a request for more information. */
final class InfoRequestTest extends DoctorApplicationsTestCase
{
    /** @return array{0: array{token:string, id:string, reference:string, email:string}, 1: string, 2: string} [app, staff token, access token] */
    private function requested(array $items): array
    {
        $app   = $this->submitted('ng');
        $staff = $this->staff()['token'];
        $this->underReview($staff, $app['id']);
        $res = $this->staffCall($staff, 'POST', '/' . $app['id'] . '/request-info', ['message' => "Please send:\n- a clearer licence", 'items' => $items, 'expected_status' => 'under_review']);
        $this->assertCode($res, 200);
        $this->assertSame('more_info_needed', $res['body']['data']['status']);
        $this->assertFalse($res['body']['data']['awaiting_staff']);

        return [$app, $staff, $this->trackToken($app['reference'], $app['email'])];
    }

    public function testOnlyRequestedItemsAreEditableAndTheEmailIsFixed(): void
    {
        [$app, $staff, $access] = $this->requested([['kind' => 'section', 'key' => 'licence'], ['kind' => 'document', 'key' => 'curriculum_vitae'], ['kind' => 'document', 'key' => 'additional', 'label' => 'Letter of good conduct']]);

        $status = $this->http('GET', '/api/public/doctor-applications/track/status', null, $access)['body']['data'];
        $this->assertSame('Please send:' . "\n" . '- a clearer licence', $status['info_request']['message']);
        $this->assertSame(['Licence', 'Curriculum vitae', 'Letter of good conduct'], array_column($status['info_request']['items'], 'label'));

        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/track/info-response/sections/professional', ['values' => self::sections('ng')['professional']], $access), 403, 'item_not_requested');
        $this->assertCode($this->upload($access, 'indemnity_certificate', null, true), 403, 'item_not_requested', 'an indemnity certificate outside the request');
        $this->assertCode($this->upload($access, 'mdcn_certificate', null, true), 403, 'item_not_requested', 'a licence certificate outside the request');

        $personal = self::personal('changed@example.com');
        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/track/info-response/sections/personal', ['values' => $personal], $access), 403, 'item_not_requested');

        $before = $this->http('GET', '/api/public/doctor-applications/track/application', null, $access)['body']['data'];
        $this->assertSame([], $before['info_request']['updated_sections'], 'nothing saved for this request yet');
        $this->assertArrayNotHasKey('updated_sections', $status['info_request'], 'the status page does not carry it');

        $licence = self::sections('ng')['licence'];
        $licence['mdcn_number'] = 'MDCN/99999';
        $this->assertCode($this->http('PUT', '/api/public/doctor-applications/track/info-response/sections/licence', ['values' => ['mdcn_number' => 'AB']], $access), 422);
        $saved = $this->http('PUT', '/api/public/doctor-applications/track/info-response/sections/licence', ['values' => $licence], $access);
        $this->assertCode($saved, 200);
        $this->assertSame(['licence'], $saved['body']['data']['info_request']['updated_sections']);
        $this->assertSame('MDCN/99999', $this->conn()->fetchOne('SELECT mdcn_number FROM doctor_applications'));
        // A fresh read (another tab or device) knows it too.
        $again = $this->http('GET', '/api/public/doctor-applications/track/application', null, $access)['body']['data'];
        $this->assertSame(['licence'], $again['info_request']['updated_sections']);

        // Submitting needs every item.
        $missing = $this->http('POST', '/api/public/doctor-applications/track/info-response/submit', [], $access);
        $this->assertCode($missing, 422, 'incomplete');
        $this->assertStringContainsString('Curriculum vitae, Letter of good conduct', $missing['body']['message']);

        $this->assertCode($this->upload($access, 'curriculum_vitae', null, true), 201);
        $extra = $this->upload($access, 'additional', null, true);
        $this->assertCode($extra, 201);
        $this->assertSame('Letter of good conduct', $extra['body']['data']['label']);
        $this->assertSame('Letter of good conduct', $extra['body']['data']['slot_label']);

        $done = $this->http('POST', '/api/public/doctor-applications/track/info-response/submit', ['note' => 'All sent'], $access);
        $this->assertCode($done, 200);
        $this->assertSame('under_review', $done['body']['data']['status']);
        $this->assertSame(
            ['submitted:done', 'more_info_needed:done', 'under_review:current', 'approved:pending'],
            array_map(static fn (array $r): string => $r['key'] . ':' . $r['state'], $done['body']['data']['timeline']),
        );
        $this->assertNull($done['body']['data']['info_request']);
        $this->assertTrue((bool) $this->conn()->fetchOne('SELECT awaiting_staff FROM doctor_applications'));
        $this->assertSame(1, (int) $this->staffCall($staff, 'GET', '/queue')['body']['data']['needs_action']);
        $this->assertSame(1, $this->rows("SELECT COUNT(*) FROM audit_events WHERE action = 'doctor_application.info_received'"));
        $this->assertCode($this->http('POST', '/api/public/doctor-applications/track/info-response/submit', [], $access), 409, 'not_allowed');
    }

    public function testASecondUploadKeepsPointingAtTheOriginalAndDeletingReactivatesIt(): void
    {
        [, , $access] = $this->requested([['kind' => 'document', 'key' => 'government_id']]);
        $original = (string) $this->conn()->fetchOne("SELECT id FROM doctor_application_documents WHERE slot = 'government_id'");

        $first  = $this->upload($access, 'government_id', $this->pdf('id-v2.pdf'), true)['body']['data'];
        $second = $this->upload($access, 'government_id', $this->pdf('id-v3.pdf'), true)['body']['data'];
        $this->assertSame(0, $this->rows('SELECT COUNT(*) FROM doctor_application_documents WHERE id = ?', [$first['id']]), 'replaced within the response: deleted');
        $this->assertSame($original, $this->conn()->fetchOne('SELECT replaces_document_id FROM doctor_application_documents WHERE id = ?', [$second['id']]));
        $this->assertSame('replaced', $this->conn()->fetchOne('SELECT state FROM doctor_application_documents WHERE id = ?', [$original]));

        $this->assertCode($this->http('DELETE', '/api/public/doctor-applications/track/info-response/documents/' . $original, null, $access), 404, null, 'only documents sent in this response');
        $this->assertCode($this->http('DELETE', '/api/public/doctor-applications/track/info-response/documents/' . $second['id'], null, $access), 200);
        $this->assertSame('active', $this->conn()->fetchOne('SELECT state FROM doctor_application_documents WHERE id = ?', [$original]));
        $active = $this->http('GET', '/api/public/doctor-applications/track/application', null, $access)['body']['data']['documents'];
        $this->assertContains($original, array_column($active, 'id'));
    }
}
