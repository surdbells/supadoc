<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\StaffNotification;
use App\Domain\Repository\StaffNotificationRepository;
use App\Domain\Repository\UserRepository;

/**
 * Creates in-app notifications for staff users. Best-effort — a notification
 * failure must never break the action that triggered it, so every method
 * swallows errors.
 */
final class StaffNotifier
{
    public function __construct(
        private readonly StaffNotificationRepository $notifications,
        private readonly UserRepository $users,
    ) {
    }

    public function notifyUser(string $userId, string $type, string $title, ?string $body = null, ?string $link = null): void
    {
        try {
            $this->notifications->save(new StaffNotification($userId, $type, $title, $body, $link));
        } catch (\Throwable) {
            // non-fatal
        }
    }

    /** Notify the doctor login linked to a specialist, if one exists. */
    public function notifyDoctor(string $specialistId, string $type, string $title, ?string $body = null, ?string $link = null): void
    {
        try {
            $user = $this->users->findBySpecialist($specialistId);
            if ($user !== null) {
                $this->notifications->save(new StaffNotification($user->getId(), $type, $title, $body, $link));
            }
        } catch (\Throwable) {
            // non-fatal
        }
    }
}
