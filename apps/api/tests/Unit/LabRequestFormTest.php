<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Domain\Exception\ValidationException;
use App\Domain\Lab\LabRequestForm;
use PHPUnit\Framework\TestCase;

/**
 * The doctor's lab request form (lab spec §2.2): every validation rule and its
 * exact message, the snapshot it builds, and the canonical form the send
 * idempotency hash is taken over.
 */
final class LabRequestFormTest extends TestCase
{
    use LabFixtures;

    /** @param array<string,mixed> $over @return array<string,string> */
    private function errors(array $over, bool $asks = false): array
    {
        return LabRequestForm::check(self::labBody($over), $asks, self::catalogue())[1];
    }

    public function testAValidFormNormalisesAndSnapshotsTheItems(): void
    {
        $form = LabRequestForm::validate(self::labBody([
            'clinical_question' => '  Chest pain, rule out ACS ',
            'history'           => '   ',
            'purpose'           => '',
            'items'             => [['code' => 'fbc', 'specimen_mode' => 'manual', 'specimen_code' => 'capillary_blood'], ['code' => 'GRAM-BLOOD', 'specimen_mode' => 'manual', 'specimen_code' => 'serum'], ['code' => 'US-PELVIS'], ['code' => 'ECG12']],
            'imaging_safety'    => ['contrast_allergy' => 'no', 'mobility' => 'chair'],
            'clinical'          => ['fasting' => true, 'fasting_hours' => '8', 'infection_alerts' => ['tb', 'hiv'], 'transfusion_3m' => null],
        ]), false, self::catalogue());
        $this->assertSame('Chest pain, rule out ACS', $form['clinical_question']);
        $this->assertNull($form['history']);
        $this->assertNull($form['purpose']);
        $this->assertSame(['fasting' => true, 'fasting_hours' => 8, 'pregnancy_asked' => false, 'pregnant' => null, 'weeks_pregnant' => null, 'infection_alerts' => ['hiv', 'tb'], 'transfusion_3m' => null], $form['clinical_flags']);
        [$fbc, $gram, $us, $ecg] = $form['items'];
        $this->assertSame(['manual', 'capillary_blood', 'Capillary blood'], [$fbc['specimen_mode'], $fbc['specimen_code'], $fbc['specimen_label']]);
        $this->assertSame(['auto', 'blood_culture'], [$gram['specimen_mode'], $gram['specimen_code']], 'microbiology: fixed by the site');
        $this->assertSame(['full_bladder', 'Full bladder', null], [$us['preparation_code'], $us['preparation_label'], $us['specimen_code']], 'the catalogue default');
        $this->assertSame([null, null], [$ecg['specimen_mode'], $ecg['preparation_code']]);
        $this->assertSame(['contrast_allergy' => 'no', 'mobility' => 'chair', 'pregnant' => 'na'], $form['imaging_safety']);
    }

    public function testEveryRuleAndItsMessage(): void
    {
        $cases = [
            'client_key'                => [['client_key' => '1234'], 'Send the form key'],
            'catalogue_version'         => [['catalogue_version' => ''], 'Send the catalogue version'],
            'priority'                  => [['priority' => 'asap'], 'Choose a priority'],
            'purpose'                   => [['purpose' => 'research'], 'Choose a purpose from the list'],
            'clinical_question'         => [['clinical_question' => 'ab'], 'Add the provisional diagnosis or clinical question'],
            'history'                   => [['history' => str_repeat('x', 501)], 'Use 500 characters or fewer'],
            'medication'                => [['medication' => str_repeat('x', 501)], 'Use 500 characters or fewer'],
            'allergies'                 => [['allergies' => str_repeat('x', 501)], 'Use 500 characters or fewer'],
            'clinical.fasting_hours'    => [['clinical' => ['fasting' => true, 'fasting_hours' => 25]], 'Enter fasting hours from 1 to 24'],
            'clinical.infection_alerts' => [['clinical' => ['infection_alerts' => ['hiv', 'hiv']]], 'Choose from the list'],
            'items'                     => [['items' => []], 'Add at least one test'],
            'items.0.code'              => [['items' => [['code' => 'NOPE']]], "This test isn't in the list any more. Remove it and add it again."],
            'items.0.specimen_code'     => [['items' => [['code' => 'FBC', 'specimen_mode' => 'manual', 'specimen_code' => 'blood_culture']]], 'Choose a specimen for FBC'],
            'items.0.preparation_code'  => [['items' => [['code' => 'XR-CHEST', 'preparation_code' => 'sedation']], 'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'bed']], 'Choose a preparation from the list'],
            'imaging_safety'            => [['items' => [['code' => 'XR-CHEST']]], 'Complete the imaging safety screen'],
            'attest'                    => [['attest' => 'true'], 'Confirm these tests are clinically indicated'],
            'signature'                 => [['signature' => ['mode' => 'stamp']], 'Choose how to sign'],
        ];
        foreach ($cases as $key => [$over, $message]) {
            $this->assertSame($message, $this->errors($over)[$key] ?? null, $key);
        }
        $this->assertSame('Use 200 characters or fewer', $this->errors(['clinical_question' => str_repeat('x', 201)])['clinical_question']);
        $this->assertSame('Add up to 20 tests', $this->errors(['items' => array_fill(0, 21, ['code' => 'FBC'])])['items']);
        $this->assertSame('Each test can be added once', $this->errors(['items' => [['code' => 'FBC'], ['code' => 'fbc']]])['items']);
        $this->assertArrayNotHasKey('clinical.fasting_hours', $this->errors(['items' => [['code' => 'FBS']], 'clinical' => ['fasting' => false]]), 'FBS fasting is not forced');
        $this->assertSame([], $this->errors([]));

        try {
            LabRequestForm::validate(self::labBody(['attest' => false, 'items' => []]), false, self::catalogue());
            $this->fail('invalid');
        } catch (ValidationException $e) {
            $this->assertSame('Complete the request before sending', $e->getMessage());
            $this->assertCount(2, $e->getErrors(), 'every error at once');
        }
    }

    public function testPregnancyIsAskedOnceAndRequiredWithImaging(): void
    {
        $imaging = ['items' => [['code' => 'XR-CHEST']], 'imaging_safety' => ['contrast_allergy' => 'no', 'mobility' => 'walking']];
        [$notAsked] = LabRequestForm::check(self::labBody($imaging + ['clinical' => ['pregnant' => true, 'weeks_pregnant' => 9]]), false, self::catalogue());
        $this->assertSame([false, null, null], [$notAsked['clinical_flags']['pregnancy_asked'], $notAsked['clinical_flags']['pregnant'], $notAsked['clinical_flags']['weeks_pregnant']], 'ignored when not asked');
        $this->assertSame('na', $notAsked['imaging_safety']['pregnant']);

        $this->assertSame('Answer Pregnant? for the imaging safety screen', $this->errors($imaging + ['clinical' => ['pregnant' => null]], true)['clinical.pregnant']);
        $this->assertArrayNotHasKey('clinical.pregnant', $this->errors(['clinical' => ['pregnant' => null]], true), 'without imaging it may stay unanswered');
        $this->assertSame('Enter weeks from 1 to 42', $this->errors($imaging + ['clinical' => ['pregnant' => true, 'weeks_pregnant' => 43]], true)['clinical.weeks_pregnant']);
        [$yes] = LabRequestForm::check(self::labBody($imaging + ['clinical' => ['pregnant' => true, 'weeks_pregnant' => 12]]), true, self::catalogue());
        $this->assertSame(['yes', true, 12], [$yes['imaging_safety']['pregnant'], $yes['clinical_flags']['pregnancy_asked'], $yes['clinical_flags']['weeks_pregnant']]);
        [$no] = LabRequestForm::check(self::labBody($imaging + ['clinical' => ['pregnant' => false]]), true, self::catalogue());
        $this->assertSame('no', $no['imaging_safety']['pregnant']);
    }

    public function testTheCanonicalFormIsStableAndDistinguishesWhatMatters(): void
    {
        $body = self::labBody([
            'patient_id' => 'ABCDEF01-1111-4111-8111-111111111111',
            'clinical'   => ['fasting' => false, 'infection_alerts' => ['tb', 'hiv']],
        ]);
        $same = [
            'patient_id'        => 'abcdef01-1111-4111-8111-111111111111',
            'clinical_question' => '  ' . $body['clinical_question'] . "\n",
            'clinical'          => ['fasting' => false, 'infection_alerts' => ['hiv', 'tb']],
            'client_key'        => 'another',
            'attest'            => false,
            'signature'         => ['mode' => 'drawn'],
        ] + $body;
        $this->assertSame(LabRequestForm::hash($body), LabRequestForm::hash($same), 'whitespace, id case, alert order, key, attest, signature');
        $this->assertNotSame(LabRequestForm::hash($body), LabRequestForm::hash(['patient_id' => '33333333-3333-4333-8333-333333333333'] + $body), 'another patient');
        $this->assertNotSame(LabRequestForm::hash($body), LabRequestForm::hash(['items' => [['code' => 'MP']]] + $body), 'other items');
        $this->assertNotSame(LabRequestForm::hash($body), LabRequestForm::hash(['items' => [['code' => 'FBC'], ['code' => 'MP']]] + $body));
        $this->assertSame(['patient_id', 'appointment_id', 'duplicated_from', 'priority', 'purpose', 'clinical_question', 'history', 'medication', 'allergies', 'clinical', 'items', 'imaging_safety', 'catalogue_version'], array_keys(LabRequestForm::canonical($body)));
    }
}
