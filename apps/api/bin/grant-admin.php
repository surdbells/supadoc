<?php

declare(strict_types=1);

/**
 * Grant the full back-office permission set to a staff account — a small,
 * idempotent maintenance task that (unlike bin/seed.php) is SAFE TO RUN IN
 * PRODUCTION. Use it when a new RBAC permission is added and existing admins
 * need it, since permissions live in the JWT and the seed refuses under
 * APP_ENV=production.
 *
 *   php bin/grant-admin.php                         # admin@videomed.test
 *   php bin/grant-admin.php someone@example.com     # a specific account
 *   php bin/grant-admin.php someone@example.com --super   # also make super_admin
 *
 * It only ever ADDS to an existing user (never creates one — provisioning an
 * admin without a password would be unsafe) and unions permissions, so nothing
 * already granted is lost. The account must sign out and back in afterwards for
 * the new permissions to take effect.
 */

use App\Domain\Entity\User;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

// The canonical full back-office permission set (keep in sync with bin/seed.php's
// admin grant and App\Action\Admin\ManagesStaff::PERMISSIONS).
const ADMIN_PERMISSIONS = [
    'appointments.view',
    'appointments.create',
    'appointments.book',
    'appointments.update',
    'settings.manage',
    'specialists.manage',
    'monitoring.view',
    'staff.manage',
    'payouts.manage',
    'support.manage',
];

// ----- Parse args: an optional email + an optional --super flag -----
$email    = 'admin@videomed.test';
$makeSuper = false;
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--super') {
        $makeSuper = true;
    } elseif ($arg !== '' && !str_starts_with($arg, '-')) {
        $email = strtolower(trim($arg));
    }
}

$em   = DoctrineEntityManagerFactory::create();
$user = $em->getRepository(User::class)->findOneBy(['email' => $email]);

if ($user === null) {
    fwrite(STDERR, "No staff account found for {$email}. This script only grants to an existing user.\n");
    exit(1);
}

// Union existing + canonical permissions so nothing already granted is dropped.
$permissions = array_values(array_unique(array_merge($user->getPermissions(), ADMIN_PERMISSIONS)));
$user->setPermissions($permissions);

if ($makeSuper && !in_array('super_admin', $user->getRoles(), true)) {
    $user->setRoles(array_values(array_unique(array_merge($user->getRoles(), ['super_admin']))));
}

$em->flush();

echo "Granted back-office permissions to {$email}.\n";
echo '  roles:       ' . implode(', ', $user->getRoles()) . "\n";
echo '  permissions: ' . implode(', ', $user->getPermissions()) . "\n";
echo "\nThe user must sign out and back in — permissions are embedded in the JWT at login.\n";
