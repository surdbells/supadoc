<?php

declare(strict_types=1);

/**
 * doctrine/migrations config. Unlike the source project (schema-tool only), we
 * wire real migrations from day one — reproducible history + a down path.
 * Generate: `vendor/bin/doctrine-migrations diff`, apply: `... migrate`.
 */
return [
    'table_storage' => [
        'table_name'                 => 'doctrine_migration_versions',
        'version_column_name'        => 'version',
        'version_column_length'      => 191,
        'executed_at_column_name'    => 'executed_at',
        'execution_time_column_name' => 'execution_time',
    ],
    'migrations_paths' => [
        'App\\Migrations' => __DIR__ . '/../migrations',
    ],
    'all_or_nothing'          => true,
    'transactional'           => true,
    'check_database_platform' => true,
];
