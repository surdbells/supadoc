<?php

declare(strict_types=1);

namespace App\Infrastructure\Drug;

/**
 * Turns what a Nigerian prescriber types into RxNorm search terms. RxNorm uses
 * US (USAN) names, while doctors trained on British/INN usage type
 * "paracetamol", "salbutamol" or "adrenaline" — so those are mapped to the
 * RxNorm names before searching. Every resulting term must match.
 */
final class DrugSearchTerms
{
    /** INN / British / local trade name → RxNorm (USAN) name. Keys are lower-case. */
    public const ALIASES = [
        'paracetamol'             => 'acetaminophen',
        'salbutamol'              => 'albuterol',
        'adrenaline'              => 'epinephrine',
        'noradrenaline'           => 'norepinephrine',
        'frusemide'               => 'furosemide',
        'lignocaine'              => 'lidocaine',
        'glibenclamide'           => 'glyburide',
        'pethidine'               => 'meperidine',
        'amoxycillin'             => 'amoxicillin',
        'co-amoxiclav'            => 'amoxicillin clavulanate',
        'coamoxiclav'             => 'amoxicillin clavulanate',
        'co-trimoxazole'          => 'sulfamethoxazole trimethoprim',
        'cotrimoxazole'           => 'sulfamethoxazole trimethoprim',
        'septrin'                 => 'sulfamethoxazole trimethoprim',
        'hyoscine'                => 'scopolamine',
        'isoprenaline'            => 'isoproterenol',
        'thyroxine'               => 'levothyroxine',
        'oestradiol'              => 'estradiol',
        'ciclosporin'             => 'cyclosporine',
        'rifampicin'              => 'rifampin',
        'bendrofluazide'          => 'bendroflumethiazide',
        'chlorphenamine'          => 'chlorpheniramine',
        'phenobarbitone'          => 'phenobarbital',
        'beclometasone'           => 'beclomethasone',
        'aciclovir'               => 'acyclovir',
        'valaciclovir'            => 'valacyclovir',
        'sulphasalazine'          => 'sulfasalazine',
        'sulphadoxine'            => 'sulfadoxine',
        'sulphate'                => 'sulfate',
        'mesalazine'              => 'mesalamine',
        'colecalciferol'          => 'cholecalciferol',
        'dexamfetamine'           => 'dextroamphetamine',
        'amfetamine'              => 'amphetamine',
        'phytomenadione'          => 'phytonadione',
        'gtn'                     => 'nitroglycerin',
        'clomifene'               => 'clomiphene',
        'cefalexin'               => 'cephalexin',
        'cefradine'               => 'cephradine',
        'tetracosactide'          => 'cosyntropin',
        'suxamethonium'           => 'succinylcholine',
        'artemether-lumefantrine' => 'artemether lumefantrine',
        'coartem'                 => 'artemether lumefantrine',
        // Multi-word names (matched as phrases before splitting into words).
        'ferrous sulphate'        => 'ferrous sulfate',
        'glyceryl trinitrate'     => 'nitroglycerin',
        'vitamin b12'             => 'cyanocobalamin',
        'vitamin b6'              => 'pyridoxine',
        'vitamin b1'              => 'thiamine',
        'vitamin c'               => 'ascorbic acid',
        'vitamin k'               => 'phytonadione',
    ];

    /**
     * Lower-case, alias-expanded search terms for a query (at most six); empty
     * when the query is too short to be meaningful.
     *
     * @return list<string>
     */
    public static function from(string $query): array
    {
        $q = strtolower(trim(preg_replace('/\s+/', ' ', $query) ?? ''));
        if (mb_strlen($q) < 2) {
            return [];
        }
        foreach (self::ALIASES as $from => $to) {
            if (str_contains($from, ' ') && str_contains($q, $from)) {
                $q = str_replace($from, $to, $q);
            }
        }
        $terms = [];
        foreach (preg_split('/[\s,\/+]+/', $q) ?: [] as $word) {
            $word = trim($word, ' -.');
            if ($word === '') {
                continue;
            }
            foreach (explode(' ', self::ALIASES[$word] ?? $word) as $term) {
                if ($term !== '' && !in_array($term, $terms, true)) {
                    $terms[] = $term;
                }
            }
        }

        return array_slice($terms, 0, 6);
    }

    /** Lower-cased search blob for a catalogue row. */
    public static function blob(string ...$parts): string
    {
        return strtolower(trim(preg_replace('/\s+/', ' ', implode(' ', array_filter($parts))) ?? ''));
    }
}
