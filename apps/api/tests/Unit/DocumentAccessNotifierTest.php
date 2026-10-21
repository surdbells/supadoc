<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Document\DocumentAccessNotifier as N;
use App\Domain\Settings\ClinicTime;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * Copy guard (spec §4.5): medical documents are PHI, so no notification,
 * email or reschedule sentence ever names a document's title or type, a
 * medicine, a diagnosis, a specialty, a visit reason or the doctor's note —
 * the builders take names only, and every text is exactly the spec's.
 */
final class DocumentAccessNotifierTest extends TestCase
{
    /** What a careless template could leak, from the scenario of spec §4.5. */
    private const PHI = ['HIV', 'test result', 'mental_health_report', 'Mental Health', 'suspected TB', 'TB', 'Psychiatry', 'anxiety'];

    public function testTheExactCopy(): void
    {
        $this->assertSame(
            ['title' => 'Document access request', 'body' => 'Dr. Ada Obi asked to see your medical documents. Review the request to choose what to share and for how long, or decline it.'],
            N::requestNotice('Dr. Ada Obi'),
        );
        $this->assertSame(
            ['title' => 'Sharing with your doctor', 'body' => 'Dr. Ada Obi is practising on VideoMed again and can see what you shared with them. Review sharing.'],
            N::reinstatedNotice('Dr. Ada Obi', false),
        );
        $this->assertSame(
            ['title' => 'Sharing with your doctor ended', 'body' => 'Dr. Ada Obi is practising on VideoMed again. They were away for more than 30 days, so your sharing with them ended. Share again if you want them to see your documents.'],
            N::reinstatedNotice('Dr. Ada Obi', true),
        );
        $this->assertSame(['title' => 'Documents shared with you', 'body' => 'Pat Patient shared documents with you.'], N::doctorNotice('shared', 'Pat Patient'));
        $this->assertSame(['title' => 'Access request approved', 'body' => 'Pat Patient approved your request and shared documents with you.'], N::doctorNotice('approved', 'Pat Patient'));
        $this->assertSame(['title' => 'Access request declined', 'body' => 'Pat Patient declined your request to see their documents.'], N::doctorNotice('declined', 'Pat Patient'));
        $this->assertSame(['title' => 'Access request closed', 'body' => "Pat Patient didn't answer your request to see their documents within 7 days."], N::doctorNotice('closed', 'Pat Patient'));
        $this->assertSame('/dashboard/documents?request=r-1', N::requestLink('r-1'));
        $this->assertSame('/dashboard/documents/sharing?doctor=s-1', N::sharingLink('s-1'));
        $this->assertSame('/appointments/a-1?tab=documents', N::doctorLink('a-1'));
        $this->assertSame('/schedule', N::doctorLink(null));
    }

    public function testTheRescheduleSentence(): void
    {
        $end = new DateTimeImmutable('2026-11-05 14:30:00 UTC');
        $this->assertSame('', N::rescheduleSuffix([]));
        $this->assertSame(
            'Documents you shared for this consultation stay shared until 24 hours after the new time.',
            N::rescheduleSuffix([['duration' => 'after_24h', 'expires_at' => $end, 'capped' => false]]),
        );
        $this->assertSame(
            'Documents you shared for this consultation stay shared until 7 days after the new time.',
            N::rescheduleSuffix([['duration' => 'after_7d', 'expires_at' => $end, 'capped' => false], ['duration' => 'after_7d', 'expires_at' => $end, 'capped' => false]]),
        );
        $capped = N::rescheduleSuffix([['duration' => 'after_30d', 'expires_at' => $end, 'capped' => true]]);
        $this->assertSame(
            'Documents you shared for this consultation stay shared until ' . $end->setTimezone(ClinicTime::zone())->format('j M, g:i A') . '.',
            $capped,
        );
    }

    public function testNoTextEverCarriesPhi(): void
    {
        $doctor  = 'Dr. Ada Obi';
        $patient = 'Pat Patient';
        $texts   = [
            ...array_values(N::requestNotice($doctor)),
            ...array_values(N::reinstatedNotice($doctor, true)),
            ...array_values(N::reinstatedNotice($doctor, false)),
            ...array_merge(...array_map(static fn (string $k): array => array_values(N::doctorNotice($k, $patient)), ['shared', 'approved', 'declined', 'closed'])),
            N::RELEASE_TITLE, N::RELEASE_BODY_GENERIC, N::RELEASE_BODY_UPCOMING, N::DOCTOR_RELEASE_TITLE, N::DOCTOR_RELEASE_BODY,
            N::rescheduleSuffix([['duration' => 'after_7d', 'expires_at' => new DateTimeImmutable(), 'capped' => true]]),
            N::rescheduleSuffix([['duration' => 'after_24h', 'expires_at' => new DateTimeImmutable(), 'capped' => false]]),
        ];
        $email   = N::requestEmail('Pat', $doctor, 'https://patient.example/dashboard/documents?request=r-1');
        $texts[] = $email['subject'];
        $texts[] = $email['html'];

        foreach ($texts as $text) {
            foreach (self::PHI as $phi) {
                $this->assertStringNotContainsStringIgnoringCase($phi, $text);
            }
        }
        $this->assertSame('Dr. Ada Obi asked to see your documents', $email['subject']);
        $this->assertStringContainsString('Review request', $email['html']);
        $this->assertStringContainsString("If you don&#039;t answer within 7 days, the request closes and nothing is shared.", $email['html']);
        $this->assertStringContainsString('Nothing is shared until you choose what they can see and for how long.', $email['html']);
    }

    public function testEveryTemplateTakesOnlyAName(): void
    {
        foreach ([N::REQUEST_BODY, N::REINSTATED_BODY, N::REINSTATED_ENDED_BODY, N::SHARED_BODY, N::APPROVED_BODY, N::DECLINED_BODY, N::CLOSED_BODY, N::RESCHEDULE_SUFFIX, N::RESCHEDULE_SUFFIX_CAPPED] as $template) {
            $this->assertSame(1, substr_count($template, '%s'), $template);
        }
    }
}
