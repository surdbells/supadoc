<?php

declare(strict_types=1);

namespace App\Infrastructure\Drug;

use DomainException;
use Doctrine\DBAL\Connection;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * Loads the bundled RxNorm prescribable catalogue
 * (resources/rxnorm/rxnorm-prescribable.tsv.gz) into the `drugs` table.
 *
 * Used by `bin/import-rxnorm.php`, and lazily by the medicine search: if the
 * table is still empty (the deploy step was skipped), the first search imports
 * the catalogue itself. A Postgres advisory lock makes sure only one request
 * does the work; concurrent searches get a "being prepared" message instead of
 * an empty list.
 */
final class DrugCatalogueImporter
{
    /** Arbitrary, stable advisory-lock id for the catalogue import. */
    private const LOCK_ID = 7310427;

    /** Once a process has seen a loaded catalogue it never checks again. */
    private static bool $loaded = false;

    public function __construct(
        private readonly Connection $db,
        private readonly string $datasetPath,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * Make sure the catalogue is loaded, importing it now if the table is empty.
     *
     * @throws DomainException while another request is importing it
     */
    public function ensureLoaded(): void
    {
        if (self::$loaded) {
            return;
        }
        if ($this->hasRows()) {
            self::$loaded = true;

            return;
        }
        if (!(bool) $this->db->fetchOne('SELECT pg_try_advisory_lock(' . self::LOCK_ID . ')')) {
            throw new DomainException('The medicine list is being prepared. Please try again in a minute.');
        }
        try {
            if (!$this->hasRows()) {
                @set_time_limit(300);
                $count = $this->import();
                $this->logger?->info('RxNorm catalogue imported on first search', ['products' => $count]);
            }
            self::$loaded = true;
        } catch (\Throwable $e) {
            $this->logger?->error('RxNorm catalogue import failed', ['error' => $e->getMessage()]);

            throw new DomainException('The medicine list could not be loaded. Please contact support.');
        } finally {
            $this->db->fetchOne('SELECT pg_advisory_unlock(' . self::LOCK_ID . ')');
        }
    }

    /**
     * Replace the catalogue with the dataset at `$path` (default: the bundled
     * one). Returns the number of products loaded.
     */
    public function import(?string $path = null): int
    {
        $path ??= $this->datasetPath;
        if (!is_file($path)) {
            throw new RuntimeException("Dataset not found: {$path}");
        }
        $gz = gzopen($path, 'rb');
        if ($gz === false) {
            throw new RuntimeException("Could not read {$path}");
        }
        gzgets($gz); // header row

        $sql    = 'INSERT INTO drugs (rxcui, tty, name, generic_name, brand, dose_form, route, search_text) VALUES ';
        $rows   = [];
        $params = [];
        $count  = 0;
        $flush  = function () use (&$rows, &$params, $sql): void {
            if ($rows !== []) {
                $this->db->executeStatement($sql . implode(',', $rows), $params);
            }
            $rows   = [];
            $params = [];
        };

        $this->db->beginTransaction();
        try {
            $this->db->executeStatement('DELETE FROM drugs');
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
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollBack();
            throw $e;
        } finally {
            gzclose($gz);
        }

        return $count;
    }

    private function hasRows(): bool
    {
        return (bool) $this->db->fetchOne('SELECT EXISTS (SELECT 1 FROM drugs)');
    }
}
