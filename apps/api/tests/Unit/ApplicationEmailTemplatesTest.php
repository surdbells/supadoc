<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Email\EmailTemplates as T;
use PHPUnit\Framework\TestCase;

/** Spec §5.2 / §5.3: the applicant's emails and texts. Every template escapes, uses the applicant footer and its subject. */
final class ApplicationEmailTemplatesTest extends TestCase
{
    private const EVIL = '<script>alert(1)</script>';

    /** @return array<string, array{subject:string, html:string}> */
    private static function all(string $x): array
    {
        return [
            'saved'        => T::applicationSaved($x, 'https://join.example/resume#t=abc', 'A1B2C3', 7, 30),
            'code'         => T::applicationCode('123456', 'confirm_email'),
            'track'        => T::applicationCode('123456', 'track'),
            'submitted'    => T::applicationSubmitted($x, 'GVM-DR-2026-12345', 'https://join.example/?dialog=track'),
            'under_review' => T::applicationUnderReview($x, 'GVM-DR-2026-12345', 'https://join.example/?dialog=track'),
            'info'         => T::applicationInfoRequested($x, 'GVM-DR-2026-12345', $x, [$x, 'Licence'], 'https://join.example/?dialog=track', $x),
            'received'     => T::applicationInfoReceived($x, 'GVM-DR-2026-12345'),
            'interview'    => T::applicationInterview($x, 'GVM-DR-2026-12345', '2026-10-14T10:00:00+01:00', 30, 'https://meet.google.com/abc-defg-hij', $x, false),
            'moved'        => T::applicationInterview($x, 'GVM-DR-2026-12345', '2026-10-14T10:00:00+01:00', 30, 'https://meet.google.com/abc-defg-hij', null, true),
            'approved'     => T::applicationApproved($x, $x, 'GVM-DR-2026-12345', 'https://doctor.example/auth/set-password?token=t', 7),
            'rejected'     => T::applicationRejected($x, 'GVM-DR-2026-12345', $x, 'support@videomed.app'),
            'withdrawn'    => T::applicationWithdrawn($x, 'GVM-DR-2026-12345'),
        ];
    }

    public function testEveryTemplateEscapesItsInput(): void
    {
        foreach (self::all(self::EVIL) as $name => $tpl) {
            $this->assertStringNotContainsString('<script>', $tpl['html'], $name);
        }
    }

    public function testTheApplicantFooterAndSubjects(): void
    {
        $all = self::all('Ada');
        foreach ($all as $name => $tpl) {
            $why = $name === 'saved' ? T::SAVED_WHY : T::APPLICANT_WHY;
            $this->assertStringContainsString(htmlspecialchars($why, ENT_QUOTES), $tpl['html'], $name);
            $this->assertStringNotContainsString('you have a VideoMed account', $tpl['html'], $name);
        }
        $this->assertSame('Your VideoMed application is saved', $all['saved']['subject']);
        $this->assertSame('Your VideoMed code', $all['code']['subject']);
        $this->assertSame('Application received — GVM-DR-2026-12345', $all['submitted']['subject']);
        $this->assertSame('Your application is under review — GVM-DR-2026-12345', $all['under_review']['subject']);
        $this->assertSame('Action needed on your application — GVM-DR-2026-12345', $all['info']['subject']);
        $this->assertSame("We've received your update — GVM-DR-2026-12345", $all['received']['subject']);
        $this->assertSame('Interview scheduled — GVM-DR-2026-12345', $all['interview']['subject']);
        $this->assertSame('Your interview has moved — GVM-DR-2026-12345', $all['moved']['subject']);
        $this->assertSame('Welcome aboard — your VideoMed doctor account is ready', $all['approved']['subject']);
        $this->assertSame('Update on your application — GVM-DR-2026-12345', $all['rejected']['subject']);
        $this->assertSame('Application withdrawn — GVM-DR-2026-12345', $all['withdrawn']['subject']);
        $this->assertStringContainsString('A1B2C3', $all['saved']['html']);
        $this->assertStringContainsString('Wed, 14 Oct 2026 at 10:00 AM WAT', $all['interview']['html'], 'clinic time');
        $this->assertStringContainsString('meet.google.com', $all['interview']['html']);
        $this->assertStringContainsString('Set up your profile and availability so patients can start booking you', $all['approved']['html']);
        $this->assertStringContainsString('is cancelled', $all['info']['html']);
    }

    public function testReviewerNoticesCarryTheNameOnly(): void
    {
        $tpl = T::reviewerNotice('New doctor application: Ada Obi', 'Ada Obi submitted application GVM-DR-2026-12345.', 'https://backoffice.example', '/applications/x');
        $this->assertSame('New doctor application: Ada Obi', $tpl['subject']);
        $this->assertStringContainsString('https://backoffice.example/applications/x', $tpl['html']);
    }
}
