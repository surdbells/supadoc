<?php

declare(strict_types=1);

/**
 * Loads the RxNorm drug catalogue into the `drugs` table, replacing what is
 * there. Run once after `composer schema:apply`, and again whenever
 * resources/rxnorm/rxnorm-prescribable.tsv.gz is refreshed with
 * bin/build-rxnorm-dataset.php from a newer monthly release. (If this step is
 * skipped, the first medicine search imports the catalogue automatically.)
 *
 *   php bin/import-rxnorm.php [path/to/rxnorm-prescribable.tsv.gz]
 *
 * Source: RxNorm Current Prescribable Content, courtesy of the U.S. National
 * Library of Medicine. RxNorm-sourced content (SAB=RXNORM) is public domain.
 */

use App\Infrastructure\Drug\DrugCatalogueImporter;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$importer = new DrugCatalogueImporter(
    DoctrineEntityManagerFactory::create()->getConnection(),
    __DIR__ . '/../resources/rxnorm/rxnorm-prescribable.tsv.gz',
);

try {
    $count = $importer->import($argv[1] ?? null);
} catch (\Throwable $e) {
    fwrite(STDERR, 'Import failed: ' . $e->getMessage() . "\n");
    exit(1);
}

echo "Imported {$count} RxNorm products into `drugs`.\n";
