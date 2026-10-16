<?php

declare(strict_types=1);

namespace App\Domain\Dashboard;

use App\Domain\Reference\ReferenceCategory;

/**
 * Plain-language wording for audit events, for the back-office dashboard's
 * "Recent activity" feed: a short `label` per action ("Doctor approved"), a
 * `summary` that adds who or what it was about when the event says
 * ("Doctor approved · Dr. Grace Bell"), and the back-office page it concerns.
 * Unknown actions read as their name in words ("lab_order.created" → "Lab
 * order created"), so a new event never shows up as code.
 */
final class AuditEventDescriber
{
    /** @var array<string,string> action => label */
    private const LABELS = [
        // Doctors (back office + the doctor's own onboarding)
        'specialist.created'             => 'Doctor added',
        'specialist.updated'             => 'Doctor profile updated',
        'specialist.invited'             => 'Doctor invited',
        'specialist.submitted'           => 'Doctor profile submitted for review',
        'specialist.approved'            => 'Doctor approved',
        'specialist.rejected'            => 'Doctor profile sent back',
        'specialist.suspended'           => 'Doctor suspended',
        'specialist.reinstated'          => 'Doctor reinstated',
        'specialist.suspension_bookings' => 'Bookings cancelled after a suspension',
        'specialist.suspension_rerun'    => 'Suspension clean-up run again',
        'specialist.changes_submitted'   => 'Profile change requested',
        'specialist.changes_approved'    => 'Profile change approved',
        'specialist.changes_rejected'    => 'Profile change turned down',
        'specialist.changes_withdrawn'   => 'Profile change withdrawn',
        'specialist.credential_uploaded' => 'Doctor document uploaded',
        'specialist.credential_verified' => 'Doctor document verified',
        'specialist.credential_rejected' => 'Doctor document rejected',
        'specialist.credential_deleted'  => 'Doctor document deleted',
        'specialist.credential_viewed'   => 'Doctor document viewed',
        'specialist.terms_accepted'      => 'Practitioner terms accepted',
        'signature.updated'              => 'Prescribing signature updated',
        'signature.removed'              => 'Prescribing signature removed',
        // Consultations
        'appointment.status_changed'            => 'Consultation status changed',
        'appointment.completed'                 => 'Consultation completed',
        'appointment.auto_completed'            => 'Consultation closed as held',
        'appointment.auto_completed_unconfirmed' => 'Unconfirmed consultation closed as held',
        'appointment.completed_by_staff'        => 'Consultation marked as held',
        'appointment.cancelled_by_staff'        => 'Consultation cancelled by staff',
        'appointment.refunded_by_staff'         => 'Consultation refunded by staff',
        'appointment.missed'                    => 'Consultation missed',
        'appointment.no_show_set'               => 'No-show recorded',
        'appointment.expired_unconfirmed'       => 'Unconfirmed booking expired',
        'appointment.guest_added'               => 'Guest invited to a consultation',
        'appointment.guest_removed'             => 'Guest removed from a consultation',
        'appointment.guest_invite_resent'       => 'Guest invite re-sent',
        'appointment.follow_up_proposed'        => 'Follow-up proposed',
        'appointment.follow_up_accepted'        => 'Follow-up accepted',
        'appointment.follow_up_declined'        => 'Follow-up declined',
        'appointment.follow_up_withdrawn'       => 'Follow-up withdrawn',
        'appointment.follow_up_expired'         => 'Follow-up proposal expired',
        'call.guest_joined'                     => 'Guest joined a call',
        'call.guest_consented'                  => 'Guest accepted the call notice',
        'recording.started'                     => 'Recording started',
        'recording.stopped'                     => 'Recording stopped',
        'consent.granted'                       => 'Patient consent given',
        'consent.withdrawn'                     => 'Patient consent withdrawn',
        // Clinical documents
        'note.finalized'          => 'Clinical note finalised',
        'note.amended'            => 'Clinical note amended',
        'prescription.drafted'    => 'Prescription drafted',
        'prescription.draft_deleted' => 'Prescription draft deleted',
        'prescription.sent'       => 'Prescription sent',
        'prescription.cancelled'  => 'Prescription cancelled',
        'lab_order.created'       => 'Lab order created',
        'referral.created'        => 'Referral created',
        'certificate.issued'      => 'Medical certificate issued',
        'care_plan.updated'       => 'Care plan updated',
        'copilot.draft_generated' => 'AI note draft generated',
        // Money
        'wallet.topup_credited'          => 'Wallet top-up credited',
        'wallet.topup_failed'            => 'Wallet top-up failed',
        'wallet.topup_held_for_review'   => 'Wallet top-up held for review',
        'wallet.topup_review_resolved'   => 'Held wallet top-up resolved',
        'wallet.topup_posted_status_restored' => 'Wallet top-up status restored',
        'wallet.topup_settle_refused_already_posted' => 'Duplicate wallet top-up refused',
        'wallet.ledger_discrepancy_recorded' => 'Wallet ledger discrepancy recorded',
        'wallet.credited'                => 'Wallet credited',
        'wallet.debited'                 => 'Wallet debited',
        'payment.card_paid'              => 'Card payment received',
        'payment.card_consumed'          => 'Card payment used',
        'payment.card_adopted'           => 'Card payment matched to a booking',
        'payment.card_credited_to_wallet' => 'Card payment credited to the wallet',
        'payment.card_held_for_review'   => 'Card payment held for review',
        'payment.card_review_closed'     => 'Card payment review closed',
    ];

    /**
     * Reference-list (pick list) changes, worded for the list they changed —
     * `%s` is the list's name from the event's `category` ("Specialty list
     * item added"); "Reference" when the event doesn't say.
     *
     * @var array<string,string> action => label pattern
     */
    private const REFERENCE_LABELS = [
        'reference.created'   => '%s list item added',
        'reference.updated'   => '%s list item changed',
        'reference.deleted'   => '%s list item deleted',
        'reference.reordered' => '%s list reordered',
    ];

    /** A doctor's photo changed from the back office (`specialist.updated` with this `via`). */
    private const PHOTO_LABELS = [
        'photo_upload' => 'Doctor photo updated',
        'photo_remove' => 'Doctor photo removed',
    ];

    /**
     * The label for an action ("Doctor approved"). `$metadata` refines a few:
     * a reference-list change names its list, a photo change says so.
     *
     * @param array<string,mixed> $metadata
     */
    public static function label(string $action, array $metadata = []): string
    {
        if (isset(self::REFERENCE_LABELS[$action])) {
            $category = $metadata['category'] ?? null;
            $list     = is_string($category) && ReferenceCategory::exists($category) ? ReferenceCategory::label($category) : 'Reference';

            return sprintf(self::REFERENCE_LABELS[$action], $list);
        }
        $via = $metadata['via'] ?? null;
        if ($action === 'specialist.updated' && is_string($via) && isset(self::PHOTO_LABELS[$via])) {
            return self::PHOTO_LABELS[$via];
        }
        if (isset(self::LABELS[$action])) {
            return self::LABELS[$action];
        }
        $words = trim(preg_replace('/[._]+/', ' ', $action) ?? $action);

        return $words !== '' ? ucfirst(strtolower($words)) : 'Activity';
    }

    /**
     * Who or what the event is about, when its metadata names it (a doctor,
     * a patient; for a reference-list change, the item's label), else null.
     *
     * @param array<string,mixed> $metadata
     */
    public static function subject(array $metadata, ?string $action = null): ?string
    {
        $reference = $action !== null && str_starts_with($action, 'reference.');
        if ($reference) {
            // A rename reads as "Old → New".
            $from = is_array($metadata['before'] ?? null) ? ($metadata['before']['label'] ?? null) : null;
            $to   = is_array($metadata['after'] ?? null) ? ($metadata['after']['label'] ?? null) : null;
            if (is_string($from) && is_string($to) && trim($from) !== '' && trim($to) !== '') {
                return mb_substr(trim($from) . ' → ' . trim($to), 0, 120);
            }
        }
        $keys = $reference ? ['label'] : ['doctor', 'patient_name', 'patient', 'guest_name', 'specialist'];
        foreach ($keys as $key) {
            $value = $metadata[$key] ?? null;
            if (is_string($value) && trim($value) !== '') {
                return mb_substr(trim($value), 0, 120);
            }
        }

        return null;
    }

    /**
     * The event in words: its label, plus its subject when known
     * ("Doctor approved · Dr. Grace Bell", "Specialty list item changed ·
     * Cardiology").
     *
     * @param array<string,mixed> $metadata
     */
    public static function summary(string $action, array $metadata): string
    {
        $subject = self::subject($metadata, $action);

        return self::label($action, $metadata) . ($subject !== null ? ' · ' . $subject : '');
    }

    /**
     * The back-office page the event concerns, with the permission that page
     * needs: a doctor (`specialist`), a consultation (`appointment` or an
     * event tied to one), a patient (`patient`) — else null.
     *
     * @return array{path:string, query:array<string,string>, permission:string}|null
     */
    public static function link(?string $resourceType, ?string $resourceId, ?string $appointmentId): ?array
    {
        $id = is_string($resourceId) ? trim($resourceId) : '';
        if ($resourceType === 'specialist' && self::isUuid($id)) {
            return ['path' => '/specialists/' . $id, 'query' => [], 'permission' => 'specialists.manage'];
        }
        if ($resourceType === 'appointment' && self::isUuid($id)) {
            return ['path' => '/appointments/' . $id, 'query' => [], 'permission' => 'appointments.view'];
        }
        if (is_string($appointmentId) && self::isUuid($appointmentId)) {
            return ['path' => '/appointments/' . $appointmentId, 'query' => [], 'permission' => 'appointments.view'];
        }
        if ($resourceType === 'patient' && self::isUuid($id)) {
            return ['path' => '/patients/' . $id, 'query' => [], 'permission' => 'monitoring.view'];
        }

        return null;
    }

    private static function isUuid(string $value): bool
    {
        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value) === 1;
    }
}
