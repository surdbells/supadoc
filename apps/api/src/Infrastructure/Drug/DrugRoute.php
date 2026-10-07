<?php

declare(strict_types=1);

namespace App\Infrastructure\Drug;

/**
 * The route of administration a prescriber would write ("By mouth", "Into the
 * eye"…), derived from an RxNorm dose form name ("Oral Tablet", "Ophthalmic
 * Solution"…). Used to pre-fill the "how to take it" box; the doctor can change it.
 */
final class DrugRoute
{
    /** The routes offered on the prescription form, in display order. */
    public const ALL = [
        'Oral', 'Sublingual', 'Buccal', 'Injection', 'Topical', 'Transdermal',
        'Inhalation', 'Nasal', 'Eye', 'Ear', 'Rectal', 'Vaginal', 'Dental', 'Other',
    ];

    /** Keyword → route, checked in order (more specific first). */
    private const RULES = [
        'sublingual'   => 'Sublingual',
        'buccal'       => 'Buccal',
        'ophthalmic'   => 'Eye',
        'otic'         => 'Ear',
        'nasal'        => 'Nasal',
        'inhal'        => 'Inhalation',
        'transdermal'  => 'Transdermal',
        'patch'        => 'Transdermal',
        'rectal'       => 'Rectal',
        'suppositor'   => 'Rectal',
        'enema'        => 'Rectal',
        'vaginal'      => 'Vaginal',
        'intrauterine' => 'Vaginal',
        'inject'       => 'Injection',
        'syringe'      => 'Injection',
        'cartridge'    => 'Injection',
        'pen injector' => 'Injection',
        'auto-injector' => 'Injection',
        'intravenous'  => 'Injection',
        'implant'      => 'Injection',
        'dental'       => 'Dental',
        'toothpaste'   => 'Dental',
        'mouthwash'    => 'Oral',
        'oral'         => 'Oral',
        'chewable'     => 'Oral',
        'lozenge'      => 'Oral',
        'chewing gum'  => 'Oral',
        'topical'      => 'Topical',
        'cream'        => 'Topical',
        'ointment'     => 'Topical',
        'lotion'       => 'Topical',
        'gel'          => 'Topical',
        'shampoo'      => 'Topical',
        'foam'         => 'Topical',
        'paste'        => 'Topical',
        'medicated pad' => 'Topical',
        'soap'         => 'Topical',
    ];

    public static function fromDoseForm(string $doseForm): string
    {
        $df = strtolower($doseForm);
        if ($df === '') {
            return '';
        }
        foreach (self::RULES as $needle => $route) {
            if (str_contains($df, $needle)) {
                return $route;
            }
        }

        return 'Other';
    }
}
