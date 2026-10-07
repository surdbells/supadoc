<?php

declare(strict_types=1);

/**
 * Loads the RxNorm drug catalogue into the `drugs` table, replacing what is
 * there. Run once after `composer schema:apply`, and again whenever
 * resources/rxnorm/rxnorm-prescribable.tsv.gz is refreshed with
 * bin/build-rxnorm-dataset.php from a newer monthly release.
 *
 *   php bin/import-rxnorm.php [path/to/rxnorm-prescribable.tsv.gz]
 *
 * Source: RxNorm Current Prescribable Content, courtesy of the U.S. National
 * Library of Medicine. RxNorm-sourced content (SAB=RXNORM) is public domain.
 */

use App\Infrastructure\Drug\DrugSearchTerms;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$path = $argv[1] ?? __DIR__ . '/../resources/rxnorm/rxnorm-prescribable.tsv.gz';
if (!is_file($path)) {
    fwrite(STDERR, "Dataset not found: {$path}\n");
    exit(1);
}
$gz = gzopen($path, 'rb');
if ($gz === false) {
    fwrite(STDERR, "Could not read {$path}\n");
    exit(1);
}
gzgets($gz); // header row

$conn = DoctrineEntityManagerFactory::create()->getConnection();
$sql  = 'INSERT INTO drugs (rxcui, tty, name, generic_name, brand, dose_form, route, search_text) VALUES ';

$conn->beginTransaction();
try {
    $conn->executeStatement('DELETE FROM drugs');
    $rows   = [];
    $params = [];
    $count  = 0;
    $flush  = static function () use (&$rows, &$params, $conn, $sql): void {
        if ($rows !== []) {
            $conn->executeStatement($sql . implode(',', $rows), $params);
        }
        $rows   = [];
        $params = [];
    };

    while (($line = gzgets($gz)) !== false) {
        $c = explode("\t", rtrim($line, "\r\n"));
        if (count($c) < 8) {
            continue;
        }
        [$rxcui, $tty, $name, $psn, $brand, $form, $route, $synonyms] = $c;
        $display = $psn !== '' ? $psn : $name;
        $rows[]  = '(?, ?, ?, ?, ?, ?, ?, ?)';
        array_push(
            $params,
            $rxcui,
            $tty,
            $display,
            trim(preg_replace('/\s*\[[^\]]+\]\s*$/', '', $name) ?? $name),
            $brand !== '' ? $brand : null,
            $form !== '' ? $form : null,
            $route !== '' ? $route : null,
            DrugSearchTerms::blob($display, $name, $brand, str_replace('|', ' ', $synonyms)),
        );
        ++$count;
        if (count($rows) >= 500) {
            $flush();
        }
    }
    $flush();
    $conn->commit();
} catch (\Throwable $e) {
    $conn->rollBack();
    fwrite(STDERR, 'Import failed: ' . $e->getMessage() . "\n");
    exit(1);
}
gzclose($gz);

echo "Imported {$count} RxNorm products into `drugs`.\n";
