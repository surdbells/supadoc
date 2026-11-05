<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Action\Admin\ManagesStaff;
use PHPUnit\Framework\TestCase;

/**
 * The full back-office admin (bin/grant-admin.php, and the admin bin/seed.php
 * creates) holds every permission Back office › Staff can assign. A staff
 * member may only grant what they hold, so a permission missing from these
 * lists could never be handed out from the app (as `labs.manage` once was).
 */
final class AdminPermissionSetsTest extends TestCase
{
    /** @return list<string> */
    private static function assignable(): array
    {
        $perms = (new \ReflectionClass(ManagesStaff::class))->getConstant('PERMISSIONS');
        self::assertIsArray($perms);

        return array_values($perms);
    }

    /**
     * The quoted strings of the first `[ … ]` after `$marker` in a bin script.
     *
     * @return list<string>
     */
    private static function listAfter(string $file, string $marker): array
    {
        $src = (string) file_get_contents(__DIR__ . '/../../bin/' . $file);
        $at  = strpos($src, $marker);
        self::assertNotFalse($at, "{$marker} in bin/{$file}");
        $open  = (int) strpos($src, '[', $at);
        $close = (int) strpos($src, ']', $open);
        preg_match_all("/'([^']+)'/", substr($src, $open, $close - $open), $m);

        return $m[1];
    }

    public function testGrantAdminGrantsEveryAssignablePermission(): void
    {
        $granted = self::listAfter('grant-admin.php', 'const ADMIN_PERMISSIONS');
        $this->assertEqualsCanonicalizing(self::assignable(), $granted);
        $this->assertContains('labs.manage', $granted);
    }

    public function testTheSeededAdminHoldsEveryAssignablePermission(): void
    {
        $seeded = self::listAfter('seed.php', '$admin->setPermissions(');
        $this->assertEqualsCanonicalizing(self::assignable(), $seeded);
    }
}
