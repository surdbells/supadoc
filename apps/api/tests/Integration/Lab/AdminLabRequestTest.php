<?php

declare(strict_types=1);

namespace App\Tests\Integration\Lab;

use App\Action\Admin\MonitoringAuditAction;
use App\Action\Admin\MonitoringOverviewAction;
use App\Action\LabRequest\Admin\AdminPatientLabRequestsAction;
use App\Action\LabRequest\Admin\CorrectLabRequestStatusAction;
use App\Action\LabRequest\Doctor\GetDoctorLabRequestAction;
use App\Action\LabRequest\Patient\DeclineLabRequestAction;
use App\Action\LabRequest\Patient\GetMyLabRequestAction;
use App\Action\LabRequest\Patient\ReportLabSampleAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Lab\LabRequestSweeper;
use App\Infrastructure\Middleware\RbacMiddleware;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The back office (lab spec §2.5): summary rows without clinical content,
 * the correction note for `labs.manage` only, C1–C4 with their rules and
 * notices, the reason kept out of the audit trail, and the overview counts.
 */
final class AdminLabRequestTest extends LabTestCase
{
    private const ADMIN_ROW = ['id', 'number', 'status', 'priority', 'doctor_name', 'items_count', 'results_count', 'sent_at', 'last_activity_at', 'corrections', 'consented_on', 'last_correction_note'];

    public function testTheListNeedsMonitoringViewAndCarriesNoClinicalContent(): void
    {
        $this->booked();
        $this->assertSame(403, $this->viaRbac('monitoring.view', AdminPatientLabRequestsAction::class, [], ['id' => $this->P], 'GET')['status']);
        $res = $this->viaRbac('monitoring.view', AdminPatientLabRequestsAction::class, ['monitoring.view'], ['id' => $this->P], 'GET');
        $this->assertSame(200, $res['status']);
        $row = $res['body']['data'][0];
        $this->assertSame(self::ADMIN_ROW, array_keys($row));
        $this->assertSame(['in_lab'], $row['corrections']);
        $this->assertSame(LabRequestRules::clinicDate(LabRequestRules::now()), $row['consented_on']);
        $this->assertStringNotContainsString('anaemia', (string) json_encode($res['body']));
    }

    public function testCorrectionsNeedLabsManageAndARealTarget(): void
    {
        $id = $this->booked();
        $this->assertSame(403, $this->viaRbac('labs.manage', CorrectLabRequestStatusAction::class, ['monitoring.view'], ['labId' => $id], 'POST', ['status' => 'in_lab', 'reason' => 'Patient phoned support'])['status']);
        $wrong = $this->correct($id, ['status' => 'awaiting_consent', 'reason' => 'Patient phoned support']);
        $this->assertSame(422, $wrong['status']);
        $this->assertSame('Choose a status from the list', $wrong['body']['errors']['status']);
        $this->assertSame('Add a reason (at least 5 characters)', $this->correct($id, ['status' => 'in_lab', 'reason' => 'ok'])['body']['errors']['reason'] ?? null);
    }

    public function testC1WithASampleDateAndTheReasonKeptForLabsManageOnly(): void
    {
        $id     = $this->booked();
        $reason = 'Patient phoned support: sample taken yesterday';
        $today  = ClinicTime::todayYmd();
        $this->assertSame(422, $this->correct($id, ['status' => 'in_lab', 'reason' => $reason, 'sample_date' => (new DateTimeImmutable($today))->modify('+1 day')->format('Y-m-d')])['status'], 'not in the future');
        $this->assertSame(422, $this->correct($id, ['status' => 'in_lab', 'reason' => $reason, 'sample_date' => (new DateTimeImmutable($today))->modify('-2 days')->format('Y-m-d')])['status'], 'not before consent');

        $ok = $this->correct($id, ['status' => 'in_lab', 'reason' => $reason, 'sample_date' => $today]);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame('Status updated', $ok['body']['message']);
        $this->assertSame('in_lab', $ok['body']['data']['status']);
        $this->assertSame($reason, $ok['body']['data']['last_correction_note']);
        $sampleAt = new DateTimeImmutable((string) $this->conn()->fetchOne('SELECT sample_at FROM lab_requests WHERE id = ?', [$id]));
        $this->assertSame($today . ' 12:00', $sampleAt->setTimezone(ClinicTime::zone())->format('Y-m-d H:i'), '12:00 clinic time that day');
        $event = $this->conn()->fetchAssociative("SELECT actor_name, staff_note, CAST(details AS TEXT) AS details FROM lab_request_events WHERE event = 'status_corrected'");
        $this->assertSame('VideoMed support', $event['actor_name']);
        $this->assertSame($reason, $event['staff_note']);
        $this->assertSame(['reason_given' => true, 'sample_date' => $today], json_decode((string) $event['details'], true));
        $meta = json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'lab_request.status_corrected'"), true);
        $keys = array_keys($meta);
        sort($keys);
        $this->assertSame(['from', 'number', 'patient_id', 'reason_given', 'to'], $keys);

        $audit = $this->viaRbac('monitoring.view', MonitoringAuditAction::class, ['monitoring.view'], [], 'GET');
        $this->assertSame(200, $audit['status']);
        $this->assertStringNotContainsString('sample taken yesterday', (string) json_encode($audit['body']), 'the reason never reaches the audit feed');
        $rows = $this->viaRbac('monitoring.view', AdminPatientLabRequestsAction::class, ['monitoring.view'], ['id' => $this->P], 'GET')['body']['data'];
        $this->assertNull($rows[0]['last_correction_note'], 'monitoring.view only: no note');
        $this->assertSame($reason, $this->viaRbac('monitoring.view', AdminPatientLabRequestsAction::class, ['monitoring.view', 'labs.manage'], ['id' => $this->P], 'GET')['body']['data'][0]['last_correction_note']);

        $doctor = $this->doctorAction(GetDoctorLabRequestAction::class, $this->userA, ['labId' => $id], [], [], 'GET')['body']['data'];
        $this->assertStringNotContainsString('phoned', (string) json_encode($doctor), 'never to the doctor');
        $corrected = array_values(array_filter($doctor['timeline'], static fn (array $e): bool => $e['event'] === 'status_corrected'));
        $this->assertSame($today, $corrected[0]['sample_date']);
        $this->assertSame('status_corrected', end($doctor['timeline'])['event'], 'same-second events in lifecycle order');
        $patient = $this->patientAction(GetMyLabRequestAction::class, $this->P, [], ['labId' => $id], [], 'GET')['body']['data'];
        $this->assertStringNotContainsString('phoned', (string) json_encode($patient), 'never to the patient');
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM staff_notifications WHERE title = 'Lab request updated'"));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request open again'"), 'C1: no patient notice');

        $back = $this->correct($id, ['status' => 'booked', 'reason' => 'Reported by mistake']);
        $this->assertSame('booked', $back['body']['data']['status'], 'C2');
        $this->assertNull($this->conn()->fetchOne('SELECT sample_at FROM lab_requests WHERE id = ?', [$id]));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request open again'"));
    }

    public function testReopeningTellsThePatientAndRemindsAgain(): void
    {
        $declined = $this->sent();
        $this->conn()->executeStatement('UPDATE lab_requests SET sent_at = ?, reminded_at = ? WHERE id = ?', [Rules::sql(Rules::now()->modify('-3 days')), Rules::sql(Rules::now()->modify('-1 day')), $declined]);
        $this->patientAction(DeclineLabRequestAction::class, $this->P, [], ['labId' => $declined]);
        $c3 = $this->correct($declined, ['status' => 'awaiting_consent', 'reason' => 'Patient tapped decline by mistake']);
        $this->assertSame(200, $c3['status'], json_encode($c3['body']));
        $this->assertSame('awaiting_consent', $c3['body']['data']['status']);
        $number = (string) $this->conn()->fetchOne('SELECT number FROM lab_requests WHERE id = ?', [$declined]);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request open again' AND body = ?", ['Lab request ' . $number . ' is open again.']));
        $this->assertNull($this->conn()->fetchOne('SELECT reminded_at FROM lab_requests WHERE id = ?', [$declined]));
        $run = $this->container()->get(LabRequestSweeper::class)->run();
        $this->assertSame(1, $run['reminded'], 'T10 again after a reopen');

        $expired = $this->booked();
        $this->conn()->executeStatement('UPDATE lab_requests SET valid_until = ?, expires_at = ? WHERE id = ?', [Rules::now()->modify('-3 days')->format('Y-m-d'), Rules::sql(Rules::now()->modify('-1 hour')), $expired]);
        $rows = $this->viaRbac('monitoring.view', AdminPatientLabRequestsAction::class, ['monitoring.view'], ['id' => $this->P], 'GET')['body']['data'];
        $row  = $rows[array_search($expired, array_column($rows, 'id'), true)];
        $this->assertSame(['expired', ['booked']], [$row['status'], $row['corrections']], 'accepted before: back to booked');
        $c4 = $this->correct($expired, ['status' => 'booked', 'reason' => 'Patient went to the lab last week']);
        $this->assertSame('booked', $c4['body']['data']['status']);
        $this->assertGreaterThan(Rules::sql(Rules::now()), (string) $this->conn()->fetchOne('SELECT expires_at FROM lab_requests WHERE id = ?', [$expired]), 'a fresh validity');
        $this->assertSame(2, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request open again'"));
    }

    public function testC2AfterTheValidityLapsedLeavesAUsableBookedRequest(): void
    {
        $id = $this->booked();
        $this->assertSame(200, $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $id])['status']);
        // Sample reported by mistake; support corrects it after the validity ran out (in the lab never expires).
        $this->conn()->executeStatement('UPDATE lab_requests SET valid_until = ?, expires_at = ? WHERE id = ?', [Rules::now()->modify('-4 days')->format('Y-m-d'), Rules::sql(Rules::now()->modify('-3 days')), $id]);

        $c2 = $this->correct($id, ['status' => 'booked', 'reason' => 'Sample reported by mistake']);
        $this->assertSame(200, $c2['status'], json_encode($c2['body']));
        $this->assertSame(['booked', ['in_lab']], [$c2['body']['data']['status'], $c2['body']['data']['corrections']], 'booked, not expired on arrival');
        $this->assertGreaterThan(Rules::sql(Rules::now()->modify('+29 days')), (string) $this->conn()->fetchOne('SELECT expires_at FROM lab_requests WHERE id = ?', [$id]), 'a fresh validity');
        $this->assertNull($this->conn()->fetchOne('SELECT sample_at FROM lab_requests WHERE id = ?', [$id]));
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM notifications WHERE title = 'Lab request open again'"), 'C2: still no patient notice');

        $corrected = (string) $this->conn()->fetchOne('SELECT last_activity_at FROM lab_requests WHERE id = ?', [$id]);
        $this->assertSame(0, $this->container()->get(LabRequestSweeper::class)->run()['expired'], 'nothing to settle');
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM lab_request_events WHERE event = 'expired'"));
        $this->assertSame($corrected, (string) $this->conn()->fetchOne('SELECT last_activity_at FROM lab_requests WHERE id = ?', [$id]), 'the list order stays at the correction');
        $again = $this->patientAction(ReportLabSampleAction::class, $this->P, [], ['labId' => $id]);
        $this->assertSame(200, $again['status'], json_encode($again['body']));
    }

    public function testACorrectionRacingThePatientIsRefused(): void
    {
        $id      = $this->booked();
        $results = $this->race($id, [[
            'op' => 'staff_action', 'class' => CorrectLabRequestStatusAction::class, 'user_id' => $this->staffLabs, 'permissions' => ['labs.manage'],
            'args' => ['labId' => $id], 'body' => ['status' => 'in_lab', 'reason' => 'Patient phoned support'],
        ]], function (\Doctrine\DBAL\Connection $locked) use ($id): void {
            // The patient reported the sample meanwhile (written under the lock the test holds).
            $locked->executeStatement("UPDATE lab_requests SET status = 'in_lab', sample_at = ? WHERE id = ?", [Rules::sql(Rules::now()), $id]);
        });
        $this->assertSame(409, $results[0]['result']['status'] ?? null, json_encode($results));
        $this->assertSame('status_changed', $results[0]['result']['body']['errors']['code']);
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM lab_request_events WHERE event = 'status_corrected'"));
    }

    public function testTheOverviewCountsOnlyReviewableResultsAndOverdueOnes(): void
    {
        $shared = $this->booked();
        $this->upload($shared);
        $private = $this->booked();
        $this->upload($private, null, ['share' => '0']);
        $docx = $this->booked();
        $this->upload($docx, $this->docx());
        $this->sent();

        $overview = $this->viaRbac('monitoring.view', MonitoringOverviewAction::class, ['monitoring.view'], [], 'GET')['body']['data']['lab_requests'];
        $this->assertSame(['total' => 4, 'awaiting_consent' => 1, 'in_progress' => 0, 'result_ready' => 3, 'needs_review' => 1, 'review_overdue' => 0], $overview);

        $this->conn()->executeStatement('UPDATE lab_request_results SET uploaded_at = ?', [Rules::sql(Rules::now()->modify('-73 hours'))]);
        $overview = $this->viaRbac('monitoring.view', MonitoringOverviewAction::class, ['monitoring.view'], [], 'GET')['body']['data']['lab_requests'];
        $this->assertSame(1, $overview['review_overdue'], 'the shared PDF only (private and DOCX are never review-due)');
    }

    // ----- helpers -----

    /** @param array<string,mixed> $body @return array{status:int, body:array<string,mixed>} */
    private function correct(string $id, array $body): array
    {
        return $this->staffAction(CorrectLabRequestStatusAction::class, $this->staffLabs, ['monitoring.view', 'labs.manage'], ['labId' => $id], $body);
    }

    /**
     * Run `$class` behind `new RbacMiddleware($permission)` as a staff user
     * holding `$held`.
     *
     * @param list<string>         $held
     * @param array<string,string> $args
     * @param array<string,mixed>  $body
     * @return array{status:int, body:array<string,mixed>}
     */
    private function viaRbac(string $permission, string $class, array $held, array $args, string $method, array $body = []): array
    {
        $action  = $this->container()->get($class);
        $request = (new ServerRequestFactory())->createServerRequest($method, '/api/test')
            ->withAttribute('user_id', $this->staffLabs)
            ->withAttribute('user_roles', ['staff'])
            ->withAttribute('user_permissions', $held)
            ->withParsedBody($body);
        $handler = new class ($action, $args) implements RequestHandlerInterface {
            /** @param array<string,string> $args */
            public function __construct(private readonly object $action, private readonly array $args)
            {
            }

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return ($this->action)($request, new Response(), $this->args);
            }
        };

        return $this->decode((new RbacMiddleware($permission))->process($request, $handler));
    }
}
