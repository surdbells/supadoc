<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use Doctrine\DBAL\Connection;
use Doctrine\ORM\Tools\Event\GenerateSchemaEventArgs;

/**
 * Partial unique indexes the entity mapping can't express, owned by
 * bin/prod-migrate.php instead of the schema tool:
 *
 *  - {@see PAYMENT_REFERENCE}: one appointment per card payment reference;
 *  - {@see SLOT}: one live booking (pending / confirmed / rescheduled, not
 *    deleted) per doctor per start time.
 *
 * {@see ensure()} creates one only when the data already obeys it — otherwise
 * it reports the rows that break it (nothing is changed or deleted; a person
 * decides). And because `orm:schema-tool:update` drops any index the mapping
 * doesn't know, this class is also a schema-tool listener
 * ({@see postGenerateSchema()}, registered by DoctrineEntityManagerFactory):
 * an index that exists is declared exactly as the database has it, so the
 * schema tool neither drops nor re-creates it — and one that doesn't exist yet
 * is left to prod-migrate's check.
 */
final class RawIndexes
{
    public const PAYMENT_REFERENCE = 'uniq_appointments_payment_reference';
    public const SLOT              = 'uniq_appointments_live_slot';

    /** The appointment statuses that hold a slot for good (a proposal holds it only until it expires, so it is left out). */
    public const LIVE_STATUSES = ['pending', 'confirmed', 'rescheduled'];

    /**
     * @return array<string, array{table:string, ddl:string, violations:string}>
     */
    public static function definitions(): array
    {
        $live = "status IN ('" . implode("', '", self::LIVE_STATUSES) . "') AND deleted_at IS NULL";

        return [
            self::PAYMENT_REFERENCE => [
                'table'      => 'appointments',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::PAYMENT_REFERENCE
                    . ' ON appointments (payment_reference) WHERE payment_reference IS NOT NULL',
                'violations' => "SELECT payment_reference AS conflict, COUNT(*) AS bookings, string_agg(id::text, ',' ORDER BY created_at) AS ids
                                   FROM appointments WHERE payment_reference IS NOT NULL
                                  GROUP BY payment_reference HAVING COUNT(*) > 1 ORDER BY payment_reference",
            ],
            self::SLOT => [
                'table'      => 'appointments',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::SLOT
                    . ' ON appointments (specialist_id, scheduled_at) WHERE ' . $live,
                'violations' => "SELECT specialist_id::text || ' @ ' || to_char(scheduled_at, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS conflict,
                                        COUNT(*) AS bookings, string_agg(id::text || ':' || status, ',' ORDER BY created_at) AS ids
                                   FROM appointments WHERE {$live}
                                  GROUP BY specialist_id, scheduled_at HAVING COUNT(*) > 1 ORDER BY 1",
            ],
        ];
    }

    /** How long creating an index waits for the table's in-flight writes before giving up (reported as `busy`). */
    public const LOCK_TIMEOUT = '10s';

    /**
     * Create each missing index whose data allows it. Per index: `exists`,
     * `created` (`would_create` in a dry run), `blocked` with the offending
     * groups (`{conflict, bookings, ids}`) — reported, never fixed here — or
     * `busy` when the table stayed locked by other work past
     * {@see LOCK_TIMEOUT} (nothing changed; re-run).
     *
     * Never fails on data: each index is checked and created in a transaction
     * of its own that first locks `appointments` against writes (SHARE ROW
     * EXCLUSIVE — reads go on), so no duplicate can be committed between the
     * check and the CREATE (old code still serving during a deploy takes no
     * slot lock); and a unique violation that slips through anyway is caught
     * and reported as `blocked`. A dry run only checks: it creates nothing and
     * takes no lock (its caller's transaction stays open until the end of the
     * run, and must not hold writes back meanwhile).
     *
     * @return array<string, array{status:string, violations?:list<array<string,mixed>>, error?:string}>
     */
    public static function ensure(Connection $conn, bool $dryRun = false, string $lockTimeout = self::LOCK_TIMEOUT): array
    {
        if (preg_match('/^\d{1,6}(ms|s)$/', $lockTimeout) !== 1) {
            throw new \InvalidArgumentException('lock timeout like "10s" or "500ms"');
        }
        $report = [];
        foreach (self::definitions() as $name => $def) {
            if (self::exists($conn, $name)) {
                $report[$name] = ['status' => 'exists'];
                continue;
            }
            if ($dryRun) {
                $violations    = $conn->fetchAllAssociative($def['violations']);
                $report[$name] = $violations === [] ? ['status' => 'would_create'] : ['status' => 'blocked', 'violations' => $violations];
                continue;
            }
            $report[$name] = self::create($conn, $name, $def, $lockTimeout);
        }

        return $report;
    }

    /**
     * Check-and-create one index in its own transaction (a savepoint when the
     * caller has one open), under a write lock on its table.
     *
     * @param array{table:string, ddl:string, violations:string} $def
     * @return array{status:string, violations?:list<array<string,mixed>>, error?:string}
     */
    private static function create(Connection $conn, string $name, array $def, string $lockTimeout): array
    {
        $level = $conn->getTransactionNestingLevel();
        $conn->beginTransaction();
        try {
            $conn->executeStatement("SET LOCAL lock_timeout = '" . $lockTimeout . "'");
            $conn->executeStatement('LOCK TABLE ' . $def['table'] . ' IN SHARE ROW EXCLUSIVE MODE');
            $violations = $conn->fetchAllAssociative($def['violations']);
            if ($violations !== []) {
                $conn->rollBack();

                return ['status' => 'blocked', 'violations' => $violations];
            }
            $conn->executeStatement($def['ddl']);
            $conn->commit();

            return ['status' => 'created'];
        } catch (\Throwable $e) {
            if ($conn->getTransactionNestingLevel() > $level) {
                $conn->rollBack(); // only what this call began
            }
            if ($e instanceof \Doctrine\DBAL\Exception\UniqueConstraintViolationException) {
                // A duplicate got in after all: report it like any other.
                return ['status' => 'blocked', 'violations' => $conn->fetchAllAssociative($def['violations']), 'error' => $e->getMessage()];
            }
            if ($e instanceof \Doctrine\DBAL\Exception\DriverException && $e->getSQLState() === '55P03') {
                return ['status' => 'busy', 'error' => sprintf('%s: %s stayed locked by other work for over %s — nothing changed, re-run', $name, $def['table'], $lockTimeout)];
            }
            throw $e;
        }
    }

    public static function exists(Connection $conn, string $name): bool
    {
        return $conn->fetchOne(
            'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?',
            [$name],
        ) !== false;
    }

    /**
     * Schema-tool listener: declare each of these indexes that exists, exactly
     * as introspected (same columns, same `pg_get_expr` predicate text DBAL
     * compares), so `orm:schema-tool:update` leaves it alone.
     */
    public function postGenerateSchema(GenerateSchemaEventArgs $args): void
    {
        $schema = $args->getSchema();
        try {
            $rows = $args->getEntityManager()->getConnection()->fetchAllAssociative(
                "SELECT ic.relname AS name, t.relname AS tbl, pg_get_expr(i.indpred, i.indrelid) AS predicate,
                        ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                               ORDER BY k.ord)::text AS columns
                   FROM pg_index i
                   JOIN pg_class ic ON ic.oid = i.indexrelid
                   JOIN pg_class t ON t.oid = i.indrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = current_schema() AND ic.relname IN (?)",
                [array_keys(self::definitions())],
                [\Doctrine\DBAL\ArrayParameterType::STRING],
            );
        } catch (\Throwable) {
            return; // no database to look at: nothing to preserve
        }
        foreach ($rows as $row) {
            $table = (string) $row['tbl'];
            if (!$schema->hasTable($table)) {
                continue;
            }
            $columns = array_values(array_filter(explode(',', trim((string) $row['columns'], '{}'))));
            $options = $row['predicate'] !== null ? ['where' => (string) $row['predicate']] : [];
            $schema->getTable($table)->addUniqueIndex($columns, (string) $row['name'], $options);
        }
    }
}
