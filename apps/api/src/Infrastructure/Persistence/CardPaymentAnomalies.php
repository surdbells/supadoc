<?php

declare(strict_types=1);

namespace App\Infrastructure\Persistence;

use Doctrine\DBAL\Connection;

/**
 * Read-only checks for card payments that moved money twice — what the old
 * check-then-act code could leave behind (one Paystack reference used for two
 * things, or used AND credited to the wallet), and the invariant the payment
 * intents keep from now on. Reported by bin/prod-migrate.php (step 10, every
 * deploy, dry run included); nothing here changes data — each finding is for a
 * person to look at (see DEPLOY.md "Card payments to review").
 *
 *  - `reference_used_twice`: one reference on more than one booking / guest
 *    entry (appointments.payment_reference and the guests' payment_reference,
 *    together — the unique index only covers bookings);
 *  - `used_and_credited`: a reference a booking or guest entry used that was
 *    ALSO credited to the wallet as unused (`fu_card_credit_<ref>`, success);
 *  - `intent_consumed_and_credited`: a payment intent recorded as used that
 *    also has that wallet credit (must never happen);
 *  - `intents_in_review`: paid card payments held for support (they move no
 *    money until support closes them: PaymentIntentService::closeReview()).
 */
final class CardPaymentAnomalies
{
    /** Every reference a booking or a guest entry used, with what used it. */
    private const USES = "SELECT a.payment_reference AS ref, 'appointment:' || CAST(a.id AS text) AS used_by
                            FROM appointments a
                           WHERE a.payment_reference IS NOT NULL AND a.payment_reference <> ''
                          UNION ALL
                          SELECT g.value ->> 'payment_reference' AS ref,
                                 'guest:' || CAST(a.id AS text) || '/' || COALESCE(g.value ->> 'id', '?') AS used_by
                            FROM appointments a
                           CROSS JOIN LATERAL jsonb_array_elements(
                                 CASE WHEN jsonb_typeof(CAST(a.guests AS jsonb)) = 'array' THEN CAST(a.guests AS jsonb) ELSE '[]'::jsonb END
                               ) AS g(value)
                           WHERE a.guests IS NOT NULL AND COALESCE(g.value ->> 'payment_reference', '') <> ''";

    /**
     * Run every check; never fails: each runs in its own (sub)transaction, and
     * a check that errors reports `[['error' => …]]` instead of stopping the
     * caller (a deploy) — or aborting the caller's open dry-run transaction.
     *
     * @return array<string, list<array<string,mixed>>> each check's findings (an empty list: none)
     */
    public static function report(Connection $conn, int $limit = 200): array
    {
        $report = [];
        foreach (self::queries(max(1, $limit)) as $check => $sql) {
            $level = $conn->getTransactionNestingLevel();
            try {
                $conn->beginTransaction(); // a savepoint inside a dry run's transaction
                $report[$check] = $conn->fetchAllAssociative($sql);
                $conn->rollBack(); // read-only: nothing to keep
            } catch (\Throwable $e) {
                if ($conn->getTransactionNestingLevel() > $level) {
                    $conn->rollBack();
                }
                $report[$check] = [['error' => $e->getMessage()]];
            }
        }

        return $report;
    }

    /**
     * The findings that need a person, without the empty checks.
     *
     * @param array<string, list<array<string,mixed>>> $report {@see report()}
     * @return array<string, list<array<string,mixed>>>
     */
    public static function findings(array $report): array
    {
        return array_filter($report, static fn (array $rows): bool => $rows !== []);
    }

    /** @return array<string,string> check => SQL */
    private static function queries(int $limit): array
    {
        $uses = self::USES;

        return [
            'reference_used_twice' => "SELECT u.ref AS reference, COUNT(*) AS uses, string_agg(u.used_by, ',' ORDER BY u.used_by) AS used_by
                                         FROM ({$uses}) u
                                        GROUP BY u.ref HAVING COUNT(*) > 1
                                        ORDER BY u.ref LIMIT {$limit}",
            'used_and_credited' => "SELECT u.ref AS reference, u.used_by, wt.patient_id, wt.amount AS credited, wt.currency, wt.reference AS wallet_reference
                                      FROM ({$uses}) u
                                      JOIN wallet_transactions wt ON wt.reference = 'fu_card_credit_' || u.ref AND wt.status = 'success'
                                     ORDER BY u.ref LIMIT {$limit}",
            'intent_consumed_and_credited' => "SELECT p.reference, p.patient_id, p.consumed_by, p.verified_amount, wt.amount AS credited, wt.reference AS wallet_reference
                                                 FROM payment_intents p
                                                 JOIN wallet_transactions wt ON wt.reference = 'fu_card_credit_' || p.reference AND wt.status = 'success'
                                                WHERE p.status = 'consumed'
                                                ORDER BY p.reference LIMIT {$limit}",
            'intents_in_review' => "SELECT reference, patient_id, purpose, verified_amount, verified_currency, failure_reason, paid_at
                                      FROM payment_intents WHERE status = 'review'
                                     ORDER BY paid_at NULLS LAST, reference LIMIT {$limit}",
        ];
    }
}
