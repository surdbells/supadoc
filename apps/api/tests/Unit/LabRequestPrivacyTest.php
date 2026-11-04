<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestEvent;
use App\Domain\Entity\LabRequestResult;
use App\Domain\Entity\MedicalDocument;
use App\Domain\Lab\LabRequestRules;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Lab\LabRequestNotifier;
use App\Infrastructure\Lab\LabRequestPresenter;
use DateTimeImmutable;
use PHPUnit\Framework\TestCase;

/**
 * Lab requests are PHI (lab spec §7, §2.3, §2.5): no notice or email names a
 * test, the clinical question, an infection alert, pregnancy or a review
 * outcome (the doctor emails not even the patient); the patient's payloads
 * carry no outcome or clinical flags; a correction's staff note reaches
 * `labs.manage` staff only.
 */
final class LabRequestPrivacyTest extends TestCase
{
    use LabFixtures;

    private const QUESTION = 'Suspected iron-deficiency anaemia';

    public function testNoNoticeOrEmailNamesATestAConditionOrAnOutcome(): void
    {
        $texts = [];
        foreach (['routine', 'urgent', 'stat'] as $priority) {
            $r = self::labRequest([
                'priority'          => $priority,
                'clinical_question' => self::QUESTION,
                'items'             => [['code' => 'HIV'], ['code' => 'XR-CHEST'], ['code' => 'UPT']],
                'imaging_safety'    => ['contrast_allergy' => 'yes', 'mobility' => 'walking'],
                'clinical'          => ['fasting' => true, 'fasting_hours' => 8, 'pregnant' => true, 'weeks_pregnant' => 9, 'infection_alerts' => ['hiv', 'hep_b', 'hep_c', 'tb'], 'transfusion_3m' => true],
            ], true);
            foreach (LabRequestNotifier::KEYS as $key) {
                foreach ([[], ['share_outcome' => 'private'], ['viewable' => false], ['to' => 'in_lab']] as $extra) {
                    [$title, $body] = LabRequestNotifier::copy($key, $r, $extra);
                    $texts[]        = $title . "\n" . $body;
                }
            }
            $patientMails = [
                EmailTemplates::labRequestSent('Chika', 'Dr. James Smith', $r->getNumber(), LabRequestRules::priorityLabel($priority), $priority === 'stat', '4 Dec 2026', 'https://example.test/x'),
                EmailTemplates::labRequestReminder('Chika', 'Dr. James Smith', $r->getNumber(), '4 Dec 2026', 'https://example.test/x'),
                EmailTemplates::labRequestCancelled('Chika', 'Dr. James Smith', $r->getNumber(), 'https://example.test/x'),
                EmailTemplates::labResultReviewed('Chika', 'Dr. James Smith', $r->getNumber(), 'https://example.test/x'),
            ];
            $doctorMails = [
                EmailTemplates::labResultAdded('Dr. James Smith', $r->getNumber(), 'https://example.test/x', LabRequestRules::priorityLabel($priority)),
                EmailTemplates::labReviewReminder('Dr. James Smith', $r->getNumber(), 'https://example.test/x'),
            ];
            foreach ([...$patientMails, ...$doctorMails] as $mail) {
                $texts[] = $mail['subject'] . "\n" . html_entity_decode(strip_tags($mail['html']));
            }
            foreach ($doctorMails as $mail) {
                $this->assertStringNotContainsString('Chika', $mail['subject'] . $mail['html'], 'a doctor email never names the patient');
                $this->assertStringNotContainsString('Osuji', $mail['subject'] . $mail['html']);
            }
        }

        $forbidden = [self::QUESTION, 'pregnan', 'abnormal', 'normal', 'Hep B', 'Hep C', 'infection', 'transfusion', 'fasting'];
        foreach (self::catalogue()->items() as $item) {
            foreach ([$item['label'], $item['name'], $item['short']] as $name) {
                $forbidden[] = $name;
            }
        }
        foreach (array_unique($forbidden) as $word) {
            $pattern = strlen($word) <= 4
                ? '/(?<![A-Za-z0-9])' . preg_quote($word, '/') . '(?![A-Za-z0-9])/'
                : '/' . preg_quote($word, '/') . '/i';
            foreach ($texts as $text) {
                $this->assertDoesNotMatchRegularExpression($pattern, $text, "\"$word\" in: $text");
            }
        }
    }

    public function testThePatientPayloadsCarryNoOutcomeOrClinicalContent(): void
    {
        $r = self::labRequest([
            'items'          => [['code' => 'FBC'], ['code' => 'XR-CHEST']],
            'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'walking'],
            'clinical'       => ['fasting' => false, 'pregnant' => false, 'infection_alerts' => ['hiv']],
        ], true, null, 'result_ready');
        $result = $r->getResults()[0];
        $result->review('abnormal', 'Low haemoglobin. Please book a follow-up.', '22222222-2222-4222-8222-222222222222', new DateTimeImmutable());
        $doc    = new MedicalDocument($r->getPatientId(), MedicalDocument::UPLOADER_PATIENT, 'Chika Osuji', 'laboratory_test_report', 'FBC result', 'x.pdf', 'application/pdf', 'pdf', 1200);
        $doc->initTimestamps();
        $note   = 'Patient phoned support: sample taken 5 Nov';
        $events = [new LabRequestEvent($r->getId(), 'status_corrected', 'booked', 'in_lab', 'staff', '33333333-3333-4333-8333-333333333333', LabRequestEvent::STAFF_NAME, ['reason_given' => true], new DateTimeImmutable(), $note)];
        $now    = new DateTimeImmutable();

        $patient = LabRequestPresenter::patient($r, $now, [$result->getDocumentId() => $doc], [$result->getDocumentId() => true], true, 'active', $events, self::catalogue());
        $summary = LabRequestPresenter::patientSummary($r, $now, ['reviewed' => true, 'awaiting_review' => false]);
        foreach (['outcome', 'review_outcome', 'abnormal', 'clinical', 'clinical_flags', 'history', 'medication', 'allergies', 'imaging_safety', 'staff_note', 'prescriber', 'patient_snapshot'] as $key) {
            $this->assertNotContains($key, self::keys($patient), $key);
            $this->assertNotContains($key, self::keys($summary), $key);
        }
        $json = (string) json_encode([$patient, $summary]);
        foreach (['abnormal', 'phoned', 'Fatigue', 'Paracetamol', 'Penicillin', '"hiv"'] as $word) {
            $this->assertStringNotContainsString($word, $json, $word);
        }
        $this->assertSame('Low haemoglobin. Please book a follow-up.', $patient['results'][0]['review']['comment'], 'the note itself is the patient\'s');

        $doctor = LabRequestPresenter::doctorDetail($r, $now, [], null, $events);
        $this->assertNotContains('staff_note', self::keys($doctor));
        $this->assertStringNotContainsString('phoned', (string) json_encode($doctor), 'never the staff note to the doctor');
    }

    public function testTheAdminRowAndTheCorrectionNote(): void
    {
        $r    = self::labRequest([], false, null, 'booked');
        $note = 'Patient phoned support';
        $row  = LabRequestPresenter::admin($r, new DateTimeImmutable(), $note, false);
        $this->assertSame(['id', 'number', 'status', 'priority', 'doctor_name', 'items_count', 'results_count', 'sent_at', 'last_activity_at', 'corrections', 'consented_on', 'last_correction_note'], array_keys($row));
        $this->assertNull($row['last_correction_note'], 'monitoring.view only');
        $this->assertSame($note, LabRequestPresenter::admin($r, new DateTimeImmutable(), $note, true)['last_correction_note']);
        $this->assertStringNotContainsString('anaemia', (string) json_encode($row), 'no clinical content');
    }

    /** Every key at every level. @return list<string> */
    private static function keys(array $data): array
    {
        $keys = [];
        foreach ($data as $k => $v) {
            if (is_string($k)) {
                $keys[] = $k;
            }
            if (is_array($v)) {
                $keys = [...$keys, ...self::keys($v)];
            }
        }

        return $keys;
    }
}
