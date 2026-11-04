<?php

declare(strict_types=1);

namespace App\Tests\Integration\DocumentSharing;

use App\Action\Doctor\DoctorDocumentAccessAction;
use App\Action\Doctor\DownloadPatientDocumentAction;
use App\Action\Doctor\RecordPatientDocumentPrintAction;
use App\Domain\Doctor\DoctorStanding;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Enum\AppointmentStatus;
use App\Infrastructure\Middleware\CorsMiddleware;
use App\Infrastructure\Middleware\DoctorStandingMiddleware;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Doctors view and print patient documents, never download them (spec §4.2):
 * only the view-only viewer may ask (`X-SD-Viewer: 1`), types it can't show
 * are never sent, every view carries a reference written to the audit row and
 * the patient's ledger, the file is served inline with no caching, and every
 * print is recorded too — citing a view only when that view is real.
 */
final class ViewOnlyTest extends DocShareTestCase
{
    private const VIEWER = ['X-SD-Viewer' => '1'];

    /** A document of P's with this extension / stored MIME, shared with A, with bytes. */
    private function sharedDoc(string $ext, string $mime, string $title = 'Scan'): string
    {
        $em  = $this->em();
        $doc = new MedicalDocument($this->P, MedicalDocument::UPLOADER_PATIENT, 'Pat Patient', 'laboratory_test_report', $title, bin2hex(random_bytes(8)) . '.' . $ext, $mime, $ext, 120);
        $em->persist($doc);
        $em->flush();
        $this->share($this->P, ['specialist_ids' => [$this->A], 'scope' => 'selected', 'document_ids' => [$doc->getId()]]);
        $this->storeBytes($doc->getId());

        return $doc->getId();
    }

    /** @return array{status:int, body:array<string,mixed>, response:\Psr\Http\Message\ResponseInterface} */
    private function view(string $docId, array $headers = self::VIEWER, ?string $user = null): array
    {
        return $this->doctorAction(DownloadPatientDocumentAction::class, $user ?? $this->userA, ['id' => $this->apNext, 'docId' => $docId], [], $headers, 'GET');
    }

    /** @param array<string,mixed> $body */
    private function printed(string $docId, array $body = [], ?string $user = null, ?string $appointment = null): array
    {
        $res = $this->doctorAction(RecordPatientDocumentPrintAction::class, $user ?? $this->userA, ['id' => $appointment ?? $this->apNext, 'docId' => $docId], $body);
        unset($res['response']);

        return $res;
    }

    /** @return array{0:int, 1:int, 2:int} audit rows, ledger rows, access count */
    private function recorded(): array
    {
        return [
            $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action IN ('document.viewed', 'document.printed')"),
            $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event IN ('viewed', 'printed')"),
            $this->countRows('SELECT COALESCE(SUM(access_count), 0) FROM document_access_grants'),
        ];
    }

    public function testAnOldTabWithoutTheViewerHeaderMustReload(): void
    {
        $doc    = $this->sharedDoc('pdf', 'application/pdf');
        $before = $this->recorded();
        $res    = $this->view($doc, []);
        $this->assertSame(409, $res['status']);
        $this->assertSame(['status' => 'error', 'message' => 'Reload VideoMed to open documents.', 'errors' => ['code' => 'update_required', 'message' => 'Reload VideoMed to open documents.']], $res['body']);
        $this->assertSame($before, $this->recorded(), 'nothing recorded');
    }

    public function testAViewIsInlineUncachedAndCarriesItsReference(): void
    {
        $doc = $this->sharedDoc('pdf', 'application/pdf');
        $res = $this->view($doc);
        $this->assertSame(200, $res['status']);
        $r = $res['response'];
        $this->assertSame('application/pdf', $r->getHeaderLine('Content-Type'));
        $this->assertSame('inline', $r->getHeaderLine('Content-Disposition'), 'no file name');
        $this->assertStringNotContainsString('filename=', $r->getHeaderLine('Content-Disposition'));
        $this->assertSame('private, no-store, max-age=0', $r->getHeaderLine('Cache-Control'));
        $this->assertSame('no-cache', $r->getHeaderLine('Pragma'));
        $this->assertSame('nosniff', $r->getHeaderLine('X-Content-Type-Options'));
        $this->assertSame("default-src 'none'; sandbox", $r->getHeaderLine('Content-Security-Policy'));
        $this->assertSame('no-referrer', $r->getHeaderLine('Referrer-Policy'));
        $this->assertGreaterThan(0, (int) $r->getHeaderLine('Content-Length'));
        $this->assertNotFalse(\DateTimeImmutable::createFromFormat(DATE_ATOM, $r->getHeaderLine('X-SD-Viewed-At')));
        $ref = $r->getHeaderLine('X-SD-View-Ref');
        $this->assertMatchesRegularExpression('/^VM-[0-9A-F]{8}$/', $ref);

        $ledger = $this->conn()->fetchAssociative("SELECT CAST(id AS TEXT) AS id, details FROM document_access_log WHERE event = 'viewed'");
        $this->assertIsArray($ledger);
        $this->assertSame('VM-' . strtoupper(substr(str_replace('-', '', (string) $ledger['id']), 0, 8)), $ref, 'the first 8 hex digits of the ledger row');
        $this->assertSame($ref, json_decode((string) $ledger['details'], true)['view_ref']);
        $audit = json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'document.viewed'"), true);
        $this->assertSame($ref, $audit['view_ref'], 'the audit row carries the same reference');
        $this->assertSame([1, 1, 1], $this->recorded());
    }

    public function testAnIphoneVideoIsServedAsMp4(): void
    {
        $doc = $this->sharedDoc('mp4', 'video/quicktime', 'Rash video');
        $res = $this->view($doc);
        $this->assertSame(200, $res['status']);
        $this->assertSame('video/mp4', $res['response']->getHeaderLine('Content-Type'), 'the fixed type, never the sniffed one');
    }

    public function testATypeTheViewerCantShowIsNeverSent(): void
    {
        $doc    = $this->sharedDoc('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Letter');
        $before = $this->recorded();
        $res    = $this->view($doc);
        $this->assertSame(415, $res['status']);
        $this->assertSame(['status' => 'error', 'message' => "This file type can't be viewed in VideoMed.", 'errors' => ['code' => 'not_viewable']], $res['body']);
        $this->assertSame('', (string) $res['response']->getHeaderLine('X-SD-View-Ref'));
        $this->assertSame($before, $this->recorded(), 'no audit, no ledger, no touch');

        // The doctor's list says so up front.
        $list = $this->doctorAction(DoctorDocumentAccessAction::class, $this->userA, ['id' => $this->apNext], [], [], 'GET');
        $byId = array_column($list['body']['data']['documents'], 'viewable', 'id');
        $this->assertFalse($byId[$doc]);
    }

    public function testTheBrowserMayReadTheViewHeaders(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/test')->withHeader('Origin', 'https://doctor.example');
        $res     = $this->container()->get(CorsMiddleware::class)->decorate($request, new Response());
        $this->assertStringContainsString('X-SD-Viewer', $res->getHeaderLine('Access-Control-Allow-Headers'));
        $this->assertSame('Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-SD-View-Ref, X-SD-Viewed-At', $res->getHeaderLine('Access-Control-Expose-Headers'));
    }

    public function testAPrintIsRecordedAndCitesOnlyARealView(): void
    {
        $doc = $this->sharedDoc('pdf', 'application/pdf');
        $ref = $this->view($doc)['response']->getHeaderLine('X-SD-View-Ref');

        $ok = $this->printed($doc, ['view_ref' => $ref]);
        $this->assertSame(200, $ok['status'], json_encode($ok['body']));
        $this->assertSame(['status' => 'success', 'message' => 'Recorded', 'data' => ['recorded' => true]], $ok['body']);
        $ledger = json_decode((string) $this->conn()->fetchOne("SELECT details FROM document_access_log WHERE event = 'printed'"), true);
        $this->assertSame(['via' => 'document', 'view_ref' => $ref], $ledger);
        $audit = json_decode((string) $this->conn()->fetchOne("SELECT CAST(metadata AS TEXT) FROM audit_events WHERE action = 'document.printed'"), true);
        $this->assertSame($ref, $audit['view_ref']);

        // Well-formed but no such view, another's view, or none at all: recorded without a ref.
        $this->assertSame(200, $this->printed($doc, ['view_ref' => 'VM-00000000'])['status']);
        $this->assertSame(200, $this->printed($doc, ['view_ref' => 'not-a-ref'])['status']);
        $this->assertSame(200, $this->printed($doc)['status']);
        $refs = array_map(static fn (string $d): ?string => json_decode($d, true)['view_ref'] ?? null, $this->conn()->fetchFirstColumn("SELECT details FROM document_access_log WHERE event = 'printed' ORDER BY created_at, id"));
        $this->assertSame(4, count($refs));
        $this->assertSame(1, count(array_filter($refs, static fn (?string $r): bool => $r === $ref)), 'only the real view is cited');

        // A ref from doctor D's view of the SAME document (P booked D too and
        // shares it with them) doesn't count for A: only the doctor differs.
        $em     = $this->em();
        $dpNext = $this->appointment($em, $this->patient($em, $this->P), $this->doctor($em, $this->D), '+6 days', [AppointmentStatus::CONFIRMED]);
        $this->share($this->P, ['specialist_ids' => [$this->D], 'scope' => 'selected', 'document_ids' => [$doc]]);
        $dView = $this->doctorAction(DownloadPatientDocumentAction::class, $this->userD, ['id' => $dpNext, 'docId' => $doc], [], self::VIEWER, 'GET');
        $this->assertSame(200, $dView['status'], json_encode($dView['body']));
        $dRef = $dView['response']->getHeaderLine('X-SD-View-Ref');
        $this->assertMatchesRegularExpression('/^VM-[0-9A-F]{8}$/', $dRef);
        $this->assertNotSame($ref, $dRef);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'viewed' AND document_id = ? AND specialist_id = ?", [strtolower($doc), strtolower($this->D)]), "D's view of this very document is in the ledger");

        $this->assertSame(200, $this->printed($doc, ['view_ref' => $dRef])['status']);
        $printed = $this->conn()->fetchFirstColumn("SELECT details FROM document_access_log WHERE event = 'printed' AND specialist_id = ?", [strtolower($this->A)]);
        $this->assertCount(5, $printed);
        $cited = array_values(array_filter(array_map(static fn (string $d): ?string => json_decode($d, true)['view_ref'] ?? null, $printed)));
        $this->assertSame([$ref], $cited, "another doctor's view of the same document is not cited (stored as null)");
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM audit_events WHERE action = 'document.printed' AND CAST(metadata AS TEXT) LIKE ?", ['%' . $dRef . '%']));
    }

    public function testTheAuditRowIsWrittenBeforeTheLedgerRow(): void
    {
        $doc    = $this->sharedDoc('pdf', 'application/pdf');
        $schema = (string) self::$schema;
        $conn   = $this->conn();
        // Every insert into either table takes the next number of a sequence
        // (which no transaction rolls back), so the numbers give the order.
        $conn->executeStatement("CREATE TABLE {$schema}.it_insert_order (n BIGSERIAL PRIMARY KEY, tbl TEXT NOT NULL)");
        $conn->executeStatement(
            "CREATE FUNCTION {$schema}.it_note_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$
             BEGIN INSERT INTO {$schema}.it_insert_order (tbl) VALUES (TG_TABLE_NAME); RETURN NEW; END \$\$",
        );
        try {
            foreach (['audit_events', 'document_access_log'] as $table) {
                $conn->executeStatement("CREATE TRIGGER it_order_{$table} AFTER INSERT ON {$schema}.{$table} FOR EACH ROW EXECUTE FUNCTION {$schema}.it_note_insert()");
            }
            $ref = $this->view($doc)['response']->getHeaderLine('X-SD-View-Ref');
            $this->assertSame(200, $this->printed($doc, ['view_ref' => $ref])['status']);

            $order = $conn->fetchFirstColumn("SELECT tbl FROM {$schema}.it_insert_order ORDER BY n");
            $this->assertSame(['audit_events', 'document_access_log', 'audit_events', 'document_access_log'], $order, 'view, then print: each audit row before its ledger row');
        } finally {
            foreach (['audit_events', 'document_access_log'] as $table) {
                $conn->executeStatement("DROP TRIGGER IF EXISTS it_order_{$table} ON {$schema}.{$table}");
            }
            $conn->executeStatement("DROP FUNCTION IF EXISTS {$schema}.it_note_insert()");
            $conn->executeStatement("DROP TABLE IF EXISTS {$schema}.it_insert_order");
        }
    }

    public function testADoctorWhoOwesTheTermsCanStillPrintThroughTheStandingGate(): void
    {
        $doc = $this->sharedDoc('pdf', 'application/pdf');
        $this->conn()->executeStatement('UPDATE specialists SET terms_version = NULL, terms_accepted_at = NULL WHERE id = ?', [$this->A]);
        $this->assertSame(DoctorStanding::TERMS, DoctorStanding::problem($this->doctor($this->em(), $this->A))[0] ?? null);

        $through = function (string $tail, array $body, string $class) use ($doc): array {
            $c       = $this->container();
            $args    = ['id' => $this->apNext, 'docId' => $doc];
            $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/doctor/appointments/' . $this->apNext . $tail)
                ->withAttribute('user_id', $this->userA)
                ->withAttribute('user_roles', ['doctor'])
                ->withParsedBody($body);
            $handler = new class ($c, $class, $args) implements RequestHandlerInterface {
                public bool $reached = false;

                /** @param array<string,string> $args */
                public function __construct(private readonly \DI\Container $c, private readonly string $class, private readonly array $args)
                {
                }

                public function handle(ServerRequestInterface $request): ResponseInterface
                {
                    $this->reached = true;

                    return $this->c->get($this->class)($request, new Response(), $this->args);
                }
            };
            $res = $c->get(DoctorStandingMiddleware::class)->process($request, $handler);

            return $this->decode($res) + ['reached' => $handler->reached];
        };

        $print = $through('/patient-documents/' . $doc . '/printed', [], RecordPatientDocumentPrintAction::class);
        $this->assertSame(200, $print['status'], json_encode($print['body']));
        $this->assertTrue($print['reached']);
        $this->assertSame(1, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'printed'"));

        // Other clinical work on a consultation that hasn't started stays refused.
        $note = $through('/note', ['note' => 'x'], RecordPatientDocumentPrintAction::class);
        $this->assertSame(403, $note['status']);
        $this->assertSame(DoctorStanding::TERMS, $note['body']['errors']['code']);
        $this->assertFalse($note['reached']);
    }

    public function testAPrintOfADocumentNoLongerSharedIsRefused(): void
    {
        $res = $this->printed($this->P2);
        $this->assertSame(404, $res['status']);
        $this->assertSame('not_shared', $res['body']['errors']['code']);
        $this->assertSame(0, $this->countRows("SELECT COUNT(*) FROM document_access_log WHERE event = 'printed'"));

        $foreign = $this->printed($this->P1, [], $this->userD, $this->apNext);
        $this->assertSame(403, $foreign['status'], 'not their consultation');
    }
}
