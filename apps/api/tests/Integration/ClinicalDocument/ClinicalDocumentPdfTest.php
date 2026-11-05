<?php

declare(strict_types=1);

namespace App\Tests\Integration\ClinicalDocument;

use App\Action\Appointment\RenderMyDocumentAction;
use App\Action\Doctor\RenderDoctorDocumentAction;
use App\Domain\Document\DocumentSharingRules as Rules;
use App\Domain\Entity\MedicalCertificate;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Referral;
use App\Tests\Integration\DocumentSharing\DocShareTestCase;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Referrals and medical certificates as PDF (document viewer spec §5, §8.2)
 * on the existing routes, on the document-sharing fixtures (doctor A with
 * patient P's consultation `apPast`; doctor D and patient Q are strangers to
 * it): `?format=pdf` answers exactly the §5 headers on the doctor and the
 * patient route; without it, or with any other value, the HTML is unchanged;
 * authorization (403 / 404), the `prescription` 404 (for a real, signed
 * prescription on the same consultation) and unknown ids are as before in
 * both formats; and neither format writes an audit event.
 */
final class ClinicalDocumentPdfTest extends DocShareTestCase
{
    private string $referral = '';

    private string $certificate = '';

    private string $prescription = '';

    protected function setUp(): void
    {
        parent::setUp();
        $em = $this->em();
        // Doctor A works on Chicago time: the issue date in the file name is theirs.
        $em->getConnection()->executeStatement("UPDATE specialists SET timezone = 'America/Chicago', timezone_source = 'manual' WHERE id = ?", [$this->A]);

        $r = new Referral($this->apPast, $this->P);
        $r->setType('specialist');
        $r->setTarget('Neurology clinic');
        $r->setReason('Persistent headaches');
        $r->setClinicalSummary("BP 150/95.\nNo focal neurology.");
        $r->setPriority('urgent');
        $r->setAuthor('Dr. Ada Alpha');
        $em->persist($r);

        $c = new MedicalCertificate($this->apPast, $this->P);
        $c->setType('sick_leave');
        $c->setStatement('Requires rest and is unfit for work.');
        $c->setDiagnosis('Migraine');
        $c->setPeriod(new DateTimeImmutable('2026-11-04'), new DateTimeImmutable('2026-11-06'));
        $c->setAuthor('Dr. Ada Alpha');
        $em->persist($c);

        // A real, signed prescription on the same consultation: the route must
        // refuse the kind, not merely miss the record (prescriptions go out only
        // through the signed, audited PDF links). The shared reset doesn't
        // clear prescriptions, so the previous test's row goes first (its
        // number is unique).
        $em->getConnection()->executeStatement('DELETE FROM prescriptions');
        $rx = new Prescription($this->P, $this->A, $this->apPast, 'GVM-RX-20261104-00001', new DateTimeImmutable('2026-12-04'));
        $rx->send(['name' => 'Dr. Ada Alpha'], ['name' => 'Pat Patient'], 'saved', null, new DateTimeImmutable('2026-11-04T12:00:00+00:00'));
        $em->persist($rx);
        $em->flush();
        $this->prescription = $rx->getId();

        // 03:12 UTC on 5 Nov is 21:12 CST on 4 Nov; 12:00 UTC on 4 Nov is 06:00 CST.
        $em->getConnection()->executeStatement('UPDATE referrals SET created_at = ? WHERE id = ?', [Rules::sql(new DateTimeImmutable('2026-11-05T03:12:00+00:00')), $r->getId()]);
        $em->getConnection()->executeStatement('UPDATE medical_certificates SET created_at = ? WHERE id = ?', [Rules::sql(new DateTimeImmutable('2026-11-04T12:00:00+00:00')), $c->getId()]);
        $this->referral    = $r->getId();
        $this->certificate = $c->getId();
    }

    public function testFormatPdfAnswersExactlyTheViewerHeadersOnBothRoutes(): void
    {
        $audit = $this->countRows('SELECT COUNT(*) FROM audit_events');
        foreach ([
            ['referral', $this->referral, 'referral-2026-11-04.pdf'],
            ['certificate', $this->certificate, 'medical-certificate-2026-11-04.pdf'],
        ] as [$kind, $docId, $filename]) {
            foreach (['doctor' => $this->asDoctor($this->userA, $this->apPast, $kind, $docId, 'format=pdf'), 'patient' => $this->asPatient($this->P, $this->apPast, $kind, $docId, 'format=pdf')] as $who => $res) {
                $body = (string) $res->getBody();
                $this->assertSame(200, $res->getStatusCode(), "$who $kind");
                $this->assertSame([
                    'Content-Type'            => ['application/pdf'],
                    'Content-Length'          => [(string) strlen($body)],
                    'Content-Disposition'     => ['inline; filename="' . $filename . '"'],
                    'Cache-Control'           => ['private, no-store, max-age=0'],
                    'Pragma'                  => ['no-cache'],
                    'X-Content-Type-Options'  => ['nosniff'],
                    'Content-Security-Policy' => ["default-src 'none'; sandbox"],
                    'Referrer-Policy'         => ['no-referrer'],
                ], $res->getHeaders(), "$who $kind");
                $this->assertMatchesRegularExpression('/^inline; filename="(referral|medical-certificate)-\d{4}-\d{2}-\d{2}\.pdf"$/', $res->getHeaderLine('Content-Disposition'));
                $this->assertStringStartsWith('%PDF-', $body, "$who $kind");
                $this->assertLessThan(1024 * 1024, strlen($body));

                $text = self::text($body);
                $this->assertStringContainsString('(Pat Patient) Tj', $text, "$who $kind");
                $this->assertStringContainsString('(Dr. Ada Alpha) Tj', $text, "$who $kind");
                $this->assertStringContainsString('(Ref: ' . strtoupper(substr($docId, 0, 8)) . ') Tj', $text, "$who $kind");
            }
        }
        $referral = self::text((string) $this->asPatient($this->P, $this->apPast, 'referral', $this->referral, 'format=pdf')->getBody());
        $this->assertStringContainsString('(REFERRAL LETTER) Tj', $referral);
        $this->assertStringContainsString('(Issued: 4 Nov 2026, 21:12 CST) Tj', $referral, "stamped in the issuing doctor's zone");
        $this->assertStringContainsString('(URGENT) Tj', $referral);
        $this->assertStringContainsString('(Neurology clinic) Tj', $referral);
        $cert = self::text((string) $this->asDoctor($this->userA, $this->apPast, 'certificate', $this->certificate, 'format=pdf')->getBody());
        $this->assertStringContainsString('(SICK LEAVE CERTIFICATE) Tj', $cert);
        $this->assertStringContainsString('(Requires rest and is unfit for work.) Tj', $cert);

        $this->assertSame($audit, $this->countRows('SELECT COUNT(*) FROM audit_events'), 'no audit event, as the HTML');
    }

    public function testWithoutFormatOrWithAnyOtherValueTheHtmlIsUnchanged(): void
    {
        $audit = $this->countRows('SELECT COUNT(*) FROM audit_events');
        foreach (['referral' => $this->referral, 'certificate' => $this->certificate] as $kind => $docId) {
            $calls = [
                'doctor'  => fn (string $q): ResponseInterface => $this->asDoctor($this->userA, $this->apPast, $kind, $docId, $q),
                'patient' => fn (string $q): ResponseInterface => $this->asPatient($this->P, $this->apPast, $kind, $docId, $q),
            ];
            foreach ($calls as $who => $call) {
                $plain = $call('');
                $html  = (string) $plain->getBody();
                $this->assertSame(200, $plain->getStatusCode(), "$who $kind");
                $this->assertSame([
                    'Content-Type'           => ['text/html; charset=utf-8'],
                    'Cache-Control'          => ['no-store'],
                    'X-Content-Type-Options' => ['nosniff'],
                ], $plain->getHeaders(), "$who $kind: the headers of today");
                $this->assertStringStartsWith('<!doctype html>', $html);
                $this->assertStringContainsString('Print / Save as PDF', $html, 'the old tab keeps its print button');
                $this->assertStringContainsString('Pat Patient', $html);

                foreach (['format=xml', 'format=html', 'format=PDF', 'format=pdf%20', 'format[]=pdf', 'format='] as $q) {
                    $other = $call($q);
                    $this->assertSame(200, $other->getStatusCode(), "$who $kind $q");
                    $this->assertSame('text/html; charset=utf-8', $other->getHeaderLine('Content-Type'), "$who $kind $q");
                    $this->assertSame($html, (string) $other->getBody(), "$who $kind $q: byte for byte");
                }
            }
        }
        $this->assertSame($audit, $this->countRows('SELECT COUNT(*) FROM audit_events'));
    }

    public function testAuthorizationIsUnchangedInBothFormats(): void
    {
        foreach (['', 'format=pdf'] as $q) {
            foreach (['referral' => $this->referral, 'certificate' => $this->certificate] as $kind => $docId) {
                // Another doctor: 403, as before.
                $this->assertJsonError(403, 'Consultation not found', $this->asDoctor($this->userD, $this->apPast, $kind, $docId, $q), "doctor D $kind $q");
                // Another patient: 404, as before.
                $this->assertJsonError(404, 'Appointment not found', $this->asPatient($this->Q, $this->apPast, $kind, $docId, $q), "patient Q $kind $q");
                // The record exists but belongs to another consultation of the same people: 404.
                $this->assertJsonError(404, 'Document not found', $this->asDoctor($this->userA, $this->apNext, $kind, $docId, $q), "doctor A other consultation $kind $q");
                $this->assertJsonError(404, 'Document not found', $this->asPatient($this->P, $this->apNext, $kind, $docId, $q), "patient P other consultation $kind $q");
            }
        }
    }

    public function testPrescriptionsAndUnknownDocumentsAre404InBothFormats(): void
    {
        // The prescription is real, signed and on this very consultation, so a
        // 404 for it can only be the kind being refused.
        $this->assertSame(1, $this->countRows(
            'SELECT COUNT(*) FROM prescriptions WHERE id = ? AND appointment_id = ? AND patient_id = ? AND specialist_id = ? AND status = ? AND signed_at IS NOT NULL',
            [$this->prescription, $this->apPast, $this->P, $this->A, Prescription::STATUS_ACTIVE],
        ));
        $unknown = '00000000-0000-4000-8000-000000000000';
        foreach (['', 'format=pdf'] as $q) {
            foreach (['prescription' => $this->prescription, 'referral' => $unknown, 'certificate' => $unknown, 'letter' => $this->referral] as $kind => $docId) {
                $this->assertJsonError(404, 'Document not found', $this->asDoctor($this->userA, $this->apPast, $kind, $docId, $q), "doctor $kind $q");
                $this->assertJsonError(404, 'Document not found', $this->asPatient($this->P, $this->apPast, $kind, $docId, $q), "patient $kind $q");
            }
            // A referral id asked for as a certificate (and the reverse) is not found either.
            $this->assertJsonError(404, 'Document not found', $this->asDoctor($this->userA, $this->apPast, 'certificate', $this->referral, $q), "doctor swapped $q");
            $this->assertJsonError(404, 'Document not found', $this->asPatient($this->P, $this->apPast, 'referral', $this->certificate, $q), "patient swapped $q");
        }
    }

    // ----- helpers -----

    private function asDoctor(string $userId, string $appointmentId, string $kind, string $docId, string $query): ResponseInterface
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', self::path('/api/doctor/appointments', $appointmentId, $kind, $docId, $query))
            ->withAttribute('user_id', $userId)
            ->withAttribute('user_roles', ['doctor']);

        return $this->container()->get(RenderDoctorDocumentAction::class)($request, new Response(), ['id' => $appointmentId, 'kind' => $kind, 'docId' => $docId]);
    }

    private function asPatient(string $customerId, string $appointmentId, string $kind, string $docId, string $query): ResponseInterface
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', self::path('/api/portal/appointments', $appointmentId, $kind, $docId, $query))
            ->withAttribute('customer_id', $customerId);

        return $this->container()->get(RenderMyDocumentAction::class)($request, new Response(), ['id' => $appointmentId, 'kind' => $kind, 'docId' => $docId]);
    }

    private static function path(string $base, string $appointmentId, string $kind, string $docId, string $query): string
    {
        return 'http://localhost' . $base . '/' . $appointmentId . '/documents/' . $kind . '/' . $docId . ($query !== '' ? '?' . $query : '');
    }

    private function assertJsonError(int $status, string $message, ResponseInterface $res, string $label): void
    {
        $this->assertSame($status, $res->getStatusCode(), $label);
        $this->assertStringStartsWith('application/json', $res->getHeaderLine('Content-Type'), $label);
        $body = json_decode((string) $res->getBody(), true);
        $this->assertSame($message, is_array($body) ? ($body['message'] ?? null) : null, $label);
    }

    /** The inflated page streams of a PDF. */
    private static function text(string $pdf): string
    {
        $out = '';
        if (preg_match_all('/stream\r?\n(.*?)\r?\nendstream/s', $pdf, $m) > 0) {
            foreach ($m[1] as $stream) {
                $plain = @gzuncompress($stream);
                $out  .= ($plain !== false ? $plain : $stream) . "\n";
            }
        }

        return $out;
    }
}
