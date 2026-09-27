<?php

declare(strict_types=1);

namespace App\Action\Admin;

use Psr\Http\Message\ServerRequestInterface;

/**
 * Shared allow-lists + guardrails for staff/role management. Roles and
 * permissions are validated against known values so a typo can't create a
 * dead grant, and the sensitive `super_admin` role is protected: only a
 * super_admin actor may grant it or edit an account that has it.
 */
trait ManagesStaff
{
    /** Assignable roles. */
    private const ROLES = ['super_admin', 'admin', 'staff', 'doctor'];

    /** Roles only a super_admin may grant to an account that doesn't already have them. */
    private const PRIVILEGED_ROLES = ['super_admin', 'admin'];

    /** Assignable permissions (the strings the API's RbacMiddleware checks). */
    private const PERMISSIONS = [
        'appointments.view',
        'appointments.create',
        'appointments.book',
        'appointments.update',
        'specialists.manage',
        'settings.manage',
        'monitoring.view',
        'staff.manage',
        'payouts.manage',
        'support.manage',
    ];

    /** @return list<string> the given roles filtered to the known set */
    private function cleanRoles(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        return array_values(array_unique(array_filter(
            array_map(static fn ($r): string => strtolower(trim((string) $r)), $raw),
            static fn (string $r): bool => in_array($r, self::ROLES, true),
        )));
    }

    /** @return list<string> the given permissions filtered to the known set */
    private function cleanPermissions(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        return array_values(array_unique(array_filter(
            array_map(static fn ($p): string => strtolower(trim((string) $p)), $raw),
            static fn (string $p): bool => in_array($p, self::PERMISSIONS, true),
        )));
    }

    /** Whether the signed-in actor holds super_admin (from the token). */
    private function actorIsSuperAdmin(ServerRequestInterface $request): bool
    {
        $roles = $request->getAttribute('user_roles');

        return is_array($roles) && in_array('super_admin', $roles, true);
    }

    /**
     * Guard role/permission grants against privilege escalation. A non-super_admin
     * actor may NOT grant a privileged role the target lacks, nor grant any
     * permission the actor does not already hold themselves. Returns an error
     * message when the grant is disallowed, or null when it is permitted.
     *
     * @param list<string> $roles              roles being set on the target
     * @param list<string> $permissions        permissions being set on the target
     * @param list<string> $currentRoles       roles the target already has
     * @param list<string> $currentPermissions permissions the target already has
     */
    private function grantViolation(
        ServerRequestInterface $request,
        array $roles,
        array $permissions,
        array $currentRoles = [],
        array $currentPermissions = [],
    ): ?string {
        if ($this->actorIsSuperAdmin($request)) {
            return null;
        }

        foreach (self::PRIVILEGED_ROLES as $priv) {
            if (in_array($priv, $roles, true) && !in_array($priv, $currentRoles, true)) {
                return 'Only a super admin can grant the ' . $priv . ' role';
            }
        }

        $actorPermissions = (array) $request->getAttribute('user_permissions', []);
        foreach ($permissions as $p) {
            if (!in_array($p, $actorPermissions, true) && !in_array($p, $currentPermissions, true)) {
                return 'You can only grant permissions you already hold';
            }
        }

        return null;
    }
}
