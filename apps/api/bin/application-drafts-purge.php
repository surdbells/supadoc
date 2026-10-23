<?php

declare(strict_types=1);

/**
 * Delete doctor-application drafts nobody saved for 30 days, with their files
 * (spec §2.10, D11). There is no cron for this: drafts also expire lazily when
 * read, and up to 20 go on each new draft. Prints counts only — never an
 * email, a name or a file.
 *
 *   php bin/application-drafts-purge.php --dry-run   # how many would go
 *   php bin/application-drafts-purge.php --run       # delete them (batches of 200)
 */

use App\Infrastructure\Application\ApplicationDraftPurger;
use DI\ContainerBuilder;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$mode = $argv[1] ?? '';
if (!in_array($mode, ['--dry-run', '--run'], true)) {
    fwrite(STDERR, "Usage: php bin/application-drafts-purge.php --dry-run|--run\n");
    exit(2);
}

$container = (new ContainerBuilder())->addDefinitions(__DIR__ . '/../config/container.php')->build();
$purger    = $container->get(ApplicationDraftPurger::class);
$expired   = $purger->countExpired();

if ($mode === '--dry-run') {
    fwrite(STDOUT, json_encode(['mode' => 'dry-run', 'expired_drafts' => $expired]) . "\n");
    exit(0);
}

$deleted = 0;
do {
    $batch    = $purger->purgeExpired(200);
    $deleted += $batch;
} while ($batch === 200);

fwrite(STDOUT, json_encode(['mode' => 'run', 'expired_drafts' => $expired, 'deleted' => $deleted, 'left' => $purger->countExpired()]) . "\n");
