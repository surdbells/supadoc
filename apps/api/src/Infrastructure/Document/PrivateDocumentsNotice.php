<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Document\DocumentSharingRules as Rules;
use DateTimeImmutable;
use Doctrine\DBAL\Connection;

/**
 * bin/prod-migrate.php step 12 "Private documents notices" (spec §5.2): once
 * sharing is switched on, tell every patient with documents — once, with no
 * medical details — that doctors now see only what they share, and every
 * active doctor login that patients now choose what they see.
 *
 *  - 12a patients (setting `prod_migrate.documents_private_notice`): patients
 *    with an open future consultation that has attachments get the
 *    "upcoming" variant linking to the earliest such consultation; everyone
 *    else with documents the generic one. Both use one title, so `NOT EXISTS`
 *    keeps it to one notice per patient even if the setting is lost.
 *  - 12b doctors (setting `prod_migrate.documents_private_doctor_notice`).
 *
 * Runs only when {@see Rules::enabled()}; a dry run does the same work in a
 * transaction it rolls back and reports `would notify`. Never creates a grant.
 */
final class PrivateDocumentsNotice
{
    public const PATIENT_KEY = 'prod_migrate.documents_private_notice';
    public const DOCTOR_KEY  = 'prod_migrate.documents_private_doctor_notice';

    /**
     * @return array{ran: bool, documents_private_notice: string, patients_upcoming?: int, patients_generic?: int, documents_private_doctor_notice?: string, doctors?: int}
     */
    public static function run(Connection $conn, bool $dryRun, DateTimeImmutable $now): array
    {
        if (!Rules::enabled()) {
            return ['ran' => false, 'documents_private_notice' => 'skipped (sharing not enabled)'];
        }
        $report = ['ran' => true];
        $at     = Rules::sql($now);

        $conn->beginTransaction();
        try {
            if (self::setting($conn, self::PATIENT_KEY) !== null) {
                $report['documents_private_notice'] = 'already sent';
            } else {
                $upcoming = (int) $conn->executeStatement(
                    "INSERT INTO notifications (id, patient_id, type, title, body, link, created_at, updated_at)
                     SELECT gen_random_uuid()::text, p.id, 'system', CAST(:title AS VARCHAR(160)), CAST(:bodyUpcoming AS TEXT),
                            '/dashboard/appointments/' || TRIM((
                              SELECT a.id FROM appointments a
                               WHERE a.patient_id = p.id AND a.deleted_at IS NULL
                                 AND a.status IN ('pending','confirmed','rescheduled') AND a.scheduled_at > :now
                                 AND EXISTS (SELECT 1 FROM medical_documents d WHERE d.appointment_id = a.id)
                               ORDER BY a.scheduled_at ASC LIMIT 1)),
                            CAST(:now AS TIMESTAMP(0)), CAST(:now AS TIMESTAMP(0))
                       FROM patients p
                      WHERE p.deleted_at IS NULL
                        AND EXISTS (SELECT 1 FROM appointments a
                                     WHERE a.patient_id = p.id AND a.deleted_at IS NULL
                                       AND a.status IN ('pending','confirmed','rescheduled') AND a.scheduled_at > :now
                                       AND EXISTS (SELECT 1 FROM medical_documents d WHERE d.appointment_id = a.id))
                        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.patient_id = p.id AND n.title = :title)",
                    ['title' => DocumentAccessNotifier::RELEASE_TITLE, 'bodyUpcoming' => DocumentAccessNotifier::RELEASE_BODY_UPCOMING, 'now' => $at],
                );
                $generic = (int) $conn->executeStatement(
                    "INSERT INTO notifications (id, patient_id, type, title, body, link, created_at, updated_at)
                     SELECT gen_random_uuid()::text, p.id, 'system', CAST(:title AS VARCHAR(160)), CAST(:bodyGeneric AS TEXT),
                            '/dashboard/documents/sharing', CAST(:now AS TIMESTAMP(0)), CAST(:now AS TIMESTAMP(0))
                       FROM patients p
                      WHERE p.deleted_at IS NULL
                        AND EXISTS (SELECT 1 FROM medical_documents d WHERE d.patient_id = p.id)
                        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.patient_id = p.id AND n.title = :title)",
                    ['title' => DocumentAccessNotifier::RELEASE_TITLE, 'bodyGeneric' => DocumentAccessNotifier::RELEASE_BODY_GENERIC, 'now' => $at],
                );
                self::record($conn, self::PATIENT_KEY, ['sent_at' => Rules::iso($now), 'patients_upcoming' => $upcoming, 'patients_generic' => $generic]);
                $report['documents_private_notice'] = $dryRun ? sprintf('would notify %d + %d', $upcoming, $generic) : 'sent';
                $report['patients_upcoming']        = $upcoming;
                $report['patients_generic']         = $generic;
            }

            if (self::setting($conn, self::DOCTOR_KEY) !== null) {
                $report['documents_private_doctor_notice'] = 'already sent';
            } else {
                $doctors = (int) $conn->executeStatement(
                    "INSERT INTO staff_notifications (id, user_id, type, title, body, link, created_at, updated_at)
                     SELECT gen_random_uuid()::text, u.id, 'document_access', CAST(:title AS VARCHAR(200)), CAST(:body AS TEXT), '/schedule',
                            CAST(:now AS TIMESTAMP(0)), CAST(:now AS TIMESTAMP(0))
                       FROM users u
                      WHERE u.active = true
                        AND u.deleted_at IS NULL
                        AND u.specialist_id IS NOT NULL
                        AND u.roles::jsonb @> '[\"doctor\"]'::jsonb
                        AND NOT EXISTS (SELECT 1 FROM staff_notifications s WHERE s.user_id = u.id AND s.title = :title)",
                    ['title' => DocumentAccessNotifier::DOCTOR_RELEASE_TITLE, 'body' => DocumentAccessNotifier::DOCTOR_RELEASE_BODY, 'now' => $at],
                );
                self::record($conn, self::DOCTOR_KEY, ['sent_at' => Rules::iso($now), 'doctors' => $doctors]);
                $report['documents_private_doctor_notice'] = $dryRun ? sprintf('would notify %d', $doctors) : 'sent';
                $report['doctors']                         = $doctors;
            }

            if ($dryRun) {
                $conn->rollBack();
            } else {
                $conn->commit();
            }
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }
            throw $e;
        }

        return $report;
    }

    private static function setting(Connection $conn, string $key): ?string
    {
        $value = $conn->fetchOne('SELECT value FROM app_settings WHERE setting_key = :k', ['k' => $key]);

        return $value === false ? null : (string) $value;
    }

    /** @param array<string,mixed> $value */
    private static function record(Connection $conn, string $key, array $value): void
    {
        $conn->insert('app_settings', ['setting_key' => $key, 'value' => (string) json_encode($value, JSON_UNESCAPED_SLASHES)]);
    }
}
