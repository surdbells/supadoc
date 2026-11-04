<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\LabRequest\Admin\AdminLabRequestLinkAction;
use App\Action\LabRequest\Doctor\DoctorLabRequestLinkAction;
use App\Action\LabRequest\Patient\MyLabRequestLinkAction;
use App\Action\LabRequest\Public\LabRequestFileAction;
use App\Action\Prescription\PrescriptionFileAction;
use App\Infrastructure\Lab\LabRequestService;
use App\Infrastructure\Service\JwtService;
use Psr\Http\Message\ResponseInterface;
use Ramsey\Uuid\Uuid;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The request PDF and its 15-minute signed links (lab spec §2.4, §6): who may
 * get one, the viewer re-checked when it is opened, the watermark, the audit
 * and the separation from prescription links.
 */
final class LabRequestFileTest extends LabTestCase
{
    public function testThePatientGetsThePdfOnlyAfterAccepting(): void
    {
        $id     = $this->sent();
        $before = $this->patientAction(MyLabRequestLinkAction::class, $this->P, [], ['labId' => $id]);
        $this->assertSame(409, $before['status']);
        $this->assertSame('Accept the request to download it.', $before['body']['message']);
        $early = $this->container()->get(LabRequestService::class);
        $r     = $early->patientRequest($this->patient($this->em(), $this->P), $id);
        $this->assertSame(410, $this->openLink($this->token($early->issueLink($r, 'patient', $this->P, false)))->getStatusCode(), 'a patient token before consent');

        $this->accept($id);
        $link = $this->patientAction(MyLabRequestLinkAction::class, $this->P, ['download' => true], ['labId' => $id]);
        $this->assertSame(200, $link['status']);
        $number = (string) $this->conn()->fetchOne('SELECT number FROM lab_requests WHERE id = ?', [$id]);
        $this->assertSame($number . '.pdf', $link['body']['data']['filename']);
        $res = $this->openLink($this->token($link['body']['data']));
        $this->assertSame(200, $res->getStatusCode());
        $this->assertSame('application/pdf', $res->getHeaderLine('Content-Type'));
        $this->assertSame('private, no-store', $res->getHeaderLine('Cache-Control'));
        $this->assertSame('attachment; filename="' . $number . '.pdf"', $res->getHeaderLine('Content-Disposition'));
        $this->assertSame('nosniff', $res->getHeaderLine('X-Content-Type-Options'));
        $this->assertSame('no-referrer', $res->getHeaderLine('Referrer-Policy'));
        $this->assertStringStartsWith('%PDF-', (string) $res->getBody());
        $this->assertStringNotContainsString('NOT YET ACCEPTED', self::pdfText((string) $res->getBody()));
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'lab_request.downloaded'"));
    }

    public function testTheDoctorsCopyBeforeConsentIsWatermarked(): void
    {
        $id   = $this->sent();
        $link = $this->doctorAction(DoctorLabRequestLinkAction::class, $this->userA, ['labId' => $id]);
        $this->assertSame(200, $link['status']);
        $res = $this->openLink($this->token($link['body']['data']));
        $this->assertSame(200, $res->getStatusCode());
        $this->assertSame('inline; filename="' . $link['body']['data']['filename'] . '"', $res->getHeaderLine('Content-Disposition'));
        $this->assertStringContainsString('NOT YET ACCEPTED', self::pdfText((string) $res->getBody()));
        $meta = json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'lab_request.viewed'"), true);
        $this->assertSame(['number', 'status', 'patient_id'], array_keys($meta));
        $this->assertSame('awaiting_consent', $meta['status']);
    }

    public function testStaffNeedLabsManageWhenTheLinkIsOpened(): void
    {
        $id   = $this->sent();
        $link = $this->staffAction(AdminLabRequestLinkAction::class, $this->staffLabs, ['monitoring.view', 'labs.manage'], ['labId' => $id]);
        $this->assertSame(200, $link['status']);
        $token = $this->token($link['body']['data']);
        $this->assertSame(200, $this->openLink($token)->getStatusCode());
        $this->conn()->executeStatement("UPDATE users SET permissions = '[\"monitoring.view\"]' WHERE id = ?", [$this->staffLabs]);
        $this->assertSame(410, $this->openLink($token)->getStatusCode(), 'the permission is re-checked');
    }

    public function testLabAndPrescriptionLinksNeverOpenEachOther(): void
    {
        $id  = $this->booked();
        $jwt = $this->container()->get(JwtService::class);
        $rx  = $jwt->issueFileLink(['rx' => Uuid::uuid4()->toString(), 'vt' => 'patient', 'vid' => $this->P, 'dl' => 0], 900);
        $this->assertSame(410, $this->openLink($rx)->getStatusCode(), 'an Rx token on the lab route');

        $lab     = $this->token($this->patientAction(MyLabRequestLinkAction::class, $this->P, [], ['labId' => $id])['body']['data']);
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/test')->withQueryParams(['token' => $lab]);
        $this->assertSame(410, $this->container()->get(PrescriptionFileAction::class)($request, new Response())->getStatusCode(), 'a lab token on the Rx route');
        $this->assertSame(200, $this->openLink($lab)->getStatusCode());
    }

    /** @param array{url:string} $link */
    private function token(array $link): string
    {
        parse_str((string) parse_url($link['url'], PHP_URL_QUERY), $q);

        return (string) $q['token'];
    }

    private function openLink(string $token): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/test')->withQueryParams(['token' => $token]);

        return $this->container()->get(LabRequestFileAction::class)($request, new Response());
    }
}
