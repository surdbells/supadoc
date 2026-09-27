<?php

declare(strict_types=1);

namespace App\Action\Admin;

use App\Domain\Entity\Payout;
use App\Domain\Repository\SpecialistRepository;
use App\Infrastructure\Email\EmailTemplates;
use App\Infrastructure\Email\MailService;

/**
 * Shared "email the doctor about a payout decision" helper for the approve / paid
 * / reject actions, so a money event reaches a doctor who isn't currently in the
 * portal (they already get the in-app StaffNotification). Best-effort.
 */
trait NotifiesPayout
{
    private function emailPayoutUpdate(
        SpecialistRepository $specialists,
        MailService $mail,
        Payout $payout,
        string $status,
    ): void {
        try {
            $specialist = $specialists->find($payout->getSpecialistId());
            $email      = $specialist?->getEmail();
            if ($specialist === null || $email === null || $email === '') {
                return;
            }

            $data        = $payout->toArray();
            $amountLabel  = '₦' . number_format((float) ($data['amount'] ?? $payout->getAmount()), 2);
            $reference   = (string) ($data['reference'] ?? $payout->getId());
            $reason      = (string) ($data['admin_note'] ?? ($data['reason'] ?? ''));
            $webUrl      = rtrim((string) ($_ENV['STAFF_WEB_URL'] ?? $_ENV['APP_WEB_URL'] ?? 'http://localhost:4204'), '/');

            $tpl = EmailTemplates::payoutUpdate($specialist->getName(), $status, $amountLabel, $reference, $webUrl, $reason);
            $mail->send($email, $specialist->getName(), $tpl['subject'], $tpl['html']);
        } catch (\Throwable) {
            // non-fatal — the payout decision already succeeded.
        }
    }
}
