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
 *    deleted) per doctor per start time;
 *  - document sharing (behind the pair advisory lock): one active folder
 *    share per pair ({@see DOC_ACTIVE_FOLDER}), one active share per pair and
 *    client key ({@see DOC_CLIENT_KEY}), one open hidden row per pair and
 *    document ({@see DOC_HIDDEN_OPEN}), one pending request per pair
 *    ({@see DOC_REQUEST_PENDING}) and one open request block per pair
 *    ({@see DOC_BLOCK_OPEN}).
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

    // Document sharing backstops (behind the pair advisory lock; spec §1.3).
    /** One active whole-folder share per (patient, doctor). */
    public const DOC_ACTIVE_FOLDER = 'uniq_doc_grants_active_folder';
    /** One active share per (patient, doctor, client key / upload batch). */
    public const DOC_CLIENT_KEY = 'uniq_doc_grants_client_key';
    /** One open hidden row per (patient, doctor, document). */
    public const DOC_HIDDEN_OPEN = 'uniq_doc_hidden_open';
    /** One pending request per (patient, doctor). */
    public const DOC_REQUEST_PENDING = 'uniq_doc_requests_pending';
    /** One open request block per (patient, doctor). */
    public const DOC_BLOCK_OPEN = 'uniq_doc_blocks_open';

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
            self::DOC_ACTIVE_FOLDER => [
                'table'      => 'document_access_grants',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::DOC_ACTIVE_FOLDER
                    . " ON document_access_grants (patient_id, specialist_id) WHERE scope = 'all' AND status = 'active'",
                'violations' => "SELECT patient_id::text || ':' || specialist_id::text AS conflict, COUNT(*) AS bookings,
                                        string_agg(id::text, ',' ORDER BY created_at) AS ids
                                   FROM document_access_grants WHERE scope = 'all' AND status = 'active'
                                  GROUP BY patient_id, specialist_id HAVING COUNT(*) > 1 ORDER BY 1",
            ],
            self::DOC_CLIENT_KEY => [
                'table'      => 'document_access_grants',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::DOC_CLIENT_KEY
                    . " ON document_access_grants (patient_id, specialist_id, client_key) WHERE client_key IS NOT NULL AND status = 'active'",
                'violations' => "SELECT patient_id::text || ':' || specialist_id::text || ':' || client_key AS conflict, COUNT(*) AS bookings,
                                        string_agg(id::text, ',' ORDER BY created_at) AS ids
                                   FROM document_access_grants WHERE client_key IS NOT NULL AND status = 'active'
                                  GROUP BY patient_id, specialist_id, client_key HAVING COUNT(*) > 1 ORDER BY 1",
            ],
            self::DOC_HIDDEN_OPEN => [
                'table'      => 'document_access_hidden',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::DOC_HIDDEN_OPEN
                    . ' ON document_access_hidden (patient_id, specialist_id, document_id) WHERE cleared_at IS NULL',
                'violations' => "SELECT patient_id::text || ':' || specialist_id::text || ':' || document_id::text AS conflict, COUNT(*) AS bookings,
                                        string_agg(id::text, ',' ORDER BY created_at) AS ids
                                   FROM document_access_hidden WHERE cleared_at IS NULL
                                  GROUP BY patient_id, specialist_id, document_id HAVING COUNT(*) > 1 ORDER BY 1",
            ],
            self::DOC_REQUEST_PENDING => [
                'table'      => 'document_access_requests',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::DOC_REQUEST_PENDING
                    . " ON document_access_requests (patient_id, specialist_id) WHERE status = 'pending'",
                'violations' => "SELECT patient_id::text || ':' || specialist_id::text AS conflict, COUNT(*) AS bookings,
                                        string_agg(id::text, ',' ORDER BY created_at) AS ids
                                   FROM document_access_requests WHERE status = 'pending'
                                  GROUP BY patient_id, specialist_id HAVING COUNT(*) > 1 ORDER BY 1",
            ],
            self::DOC_BLOCK_OPEN => [
                'table'      => 'document_access_blocks',
                'ddl'        => 'CREATE UNIQUE INDEX IF NOT EXISTS ' . self::DOC_BLOCK_OPEN
                    . ' ON document_access_blocks (patient_id, specialist_id) WHERE lifted_at IS NULL',
                'violations' => "SELECT patient_id::text || ':' || specialist_id::text AS conflict, COUNT(*) AS bookings,
                                        string_agg(id::text, ',' ORDER BY created_at) AS ids
                                   FROM document_access_blocks WHERE lifted_at IS NULL
                                  GROUP BY patient_id, specialist_id HAVING COUNT(*) > 1 ORDER BY 1",
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
