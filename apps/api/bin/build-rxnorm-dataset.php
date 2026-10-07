<?php

declare(strict_types=1);

/**
 * Builds the compact drug catalogue the API ships with, from an RxNorm
 * "Current Prescribable Content" release zip published by the U.S. National
 * Library of Medicine (https://www.nlm.nih.gov/research/umls/rxnorm/).
 *
 *   php bin/build-rxnorm-dataset.php /path/to/RxNorm_full_prescribe_MMDDYYYY.zip
 *
 * Keeps only prescribable products (SAB=RXNORM, TTY in SCD/SBD/GPCK/BPCK,
 * not suppressed) and writes one row per product to
 * resources/rxnorm/rxnorm-prescribable.tsv.gz:
 *
 *   rxcui  tty  name  psn  brand  dose_form  route  synonyms(|-joined)
 *
 * The output is what `bin/import-rxnorm.php` loads into the `drugs` table.
 * Re-run it against each new monthly release to refresh the catalogue.
 */

require __DIR__ . '/../vendor/autoload.php';

use App\Infrastructure\Drug\DrugRoute;

$zipPath = $argv[1] ?? '';
if ($zipPath === '' || !is_file($zipPath)) {
    fwrite(STDERR, "Usage: php bin/build-rxnorm-dataset.php /path/to/RxNorm_full_prescribe_MMDDYYYY.zip\n");
    exit(1);
}

$zip = new ZipArchive();
if ($zip->open($zipPath) !== true) {
    fwrite(STDERR, "Could not open {$zipPath}\n");
    exit(1);
}
$stream = $zip->getStream('rrf/RXNCONSO.RRF');
if ($stream === false) {
    fwrite(STDERR, "rrf/RXNCONSO.RRF not found in the zip\n");
    exit(1);
}

const PRODUCT_TTYS = ['SCD', 'SBD', 'GPCK', 'BPCK'];

$products  = [];   // rxcui => [tty, name]
$psn       = [];   // rxcui => prescribable name
$synonyms  = [];   // rxcui => list<string>
$doseForms = [];   // dose-form names (TTY=DF)

// RXNCONSO columns: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
while (($line = fgets($stream)) !== false) {
    $c = explode('|', $line);
    if (count($c) < 17 || $c[11] !== 'RXNORM' || $c[1] !== 'ENG') {
        continue;
    }
    if ($c[16] !== 'N' && $c[16] !== '') {
        continue; // suppressed
    }
    [$rxcui, $tty, $str] = [$c[0], $c[12], trim($c[14])];
    if (in_array($tty, PRODUCT_TTYS, true)) {
        $products[$rxcui] = [$tty, $str];
    } elseif ($tty === 'PSN') {
        $psn[$rxcui] = $str;
    } elseif ($tty === 'SY' || $tty === 'TMSY') {
        $synonyms[$rxcui][] = $str;
    } elseif ($tty === 'DF') {
        $doseForms[] = $str;
    }
}
fclose($stream);

// Longest dose-form names first so "Extended Release Oral Tablet" beats "Oral Tablet".
usort($doseForms, static fn (string $a, string $b): int => strlen($b) <=> strlen($a));

$clean = static fn (string $s): string => str_replace(["\t", "\r", "\n", '|'], ' ', $s);

$outDir = __DIR__ . '/../resources/rxnorm';
if (!is_dir($outDir)) {
    mkdir($outDir, 0o775, true);
}
$outPath = $outDir . '/rxnorm-prescribable.tsv.gz';
$gz      = gzopen($outPath, 'wb9');
gzwrite($gz, "rxcui\ttty\tname\tpsn\tbrand\tdose_form\troute\tsynonyms\n");

ksort($products, SORT_NUMERIC);
$count = 0;
foreach ($products as $rxcui => [$tty, $name]) {
    $brand = '';
    if (($tty === 'SBD' || $tty === 'BPCK') && preg_match('/\[([^\]]+)\]\s*$/', $name, $m) === 1) {
        $brand = trim($m[1]);
    }
    $generic = trim(preg_replace('/\s*\[[^\]]+\]\s*$/', '', $name) ?? $name);

    if ($tty === 'GPCK' || $tty === 'BPCK') {
        $form = 'Pack';
        $inner = '';
        foreach ($doseForms as $df) {
            if (stripos($generic, $df) !== false) {
                $inner = $df;
                break;
            }
        }
        $route = DrugRoute::fromDoseForm($inner);
    } else {
        $form = '';
        foreach ($doseForms as $df) {
            if (strcasecmp(substr($generic, -strlen($df)), $df) === 0) {
                $form = $df;
                break;
            }
        }
        $route = DrugRoute::fromDoseForm($form);
    }

    $syn = array_values(array_unique(array_filter(
        $synonyms[$rxcui] ?? [],
        static fn (string $s): bool => strcasecmp($s, $name) !== 0 && strcasecmp($s, $psn[$rxcui] ?? '') !== 0,
    )));

    gzwrite($gz, implode("\t", [
        $rxcui,
        $tty,
        $clean($name),
        $clean($psn[$rxcui] ?? ''),
        $clean($brand),
        $clean($form),
        $route,
        implode('|', array_map($clean, $syn)),
    ]) . "\n");
    ++$count;
}
gzclose($gz);

printf("Wrote %d products to %s (%s KB)\n", $count, realpath($outPath), number_format(filesize($outPath) / 1024));
