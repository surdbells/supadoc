<?php

declare(strict_types=1);

namespace App\Action\Reference;

use App\Domain\Repository\UserRepository;
use Psr\Http\Message\ServerRequestInterface;

/**
 * The signed-in staff member a reference-data change is audited against:
 * their user id and display name ("Admin" when it can't be read).
 */
trait ResolvesReferenceActor
{
    /** @return array{0:?string, 1:string} [user id, display name] */
    private function actor(ServerRequestInterface $request, UserRepository $users): array
    {
        $id = trim((string) $request->getAttribute('user_id'));
        try {
            $a    = $id !== '' ? ($users->find($id)?->toArray() ?? []) : [];
            $name = trim(((string) ($a['first_name'] ?? '')) . ' ' . ((string) ($a['last_name'] ?? '')));
        } catch (\Throwable) {
            $name = '';
        }

        return [$id !== '' ? $id : null, $name !== '' ? $name : 'Admin'];
    }
}
