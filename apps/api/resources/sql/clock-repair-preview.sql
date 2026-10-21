-- clock-repair-preview.sql — READ-ONLY preview of prod-migrate step 13 (the clock repair)
--
-- Run on the API box (inside a READ ONLY transaction that is rolled back):
--   psql -X -v off=28800 -f clock-repair-preview.sql   (with the PG* variables from DEPLOY.md)
--
-- Runs on the schema before AND after the clock-fix release (it never references the new marker columns).
-- After the release, `php bin/prod-migrate.php --dry-run --fix-clock=<zone>` is the authoritative preview: it
-- alone applies the evidence overrides, the overlap rules (different starts, open proposals, blocks) and the
-- document-share rules.
--
-- :off    = the PHP process zone's UTC offset in seconds on the dates involved.
--           PRC = 28800 (fixed +08:00, no DST since 1991). On a UTC server use 0:
--           nothing would shift.
-- :clinic = the clinic zone's offset (Africa/Lagos = 3600, no DST) — only for the
--           "clinic hour" histogram column.
--
-- No time-zone NAMES are used (Debian 13's Postgres may lack the 'PRC' alias):
--   * an instant comes from an ISO string with a numeric offset (::timestamptz),
--   * a naive column is read with extract(epoch FROM ts) = nominal seconds, zone-free,
--   * shifts are interval arithmetic on naive timestamps.
-- Output: ids, statuses, types, times and counts only — no names, emails, phones,
-- notes or other clinical text.

\set ON_ERROR_STOP on
\if :{?off}
\else
  \set off 28800
\endif
\if :{?clinic}
\else
  \set clinic 3600
\endif

BEGIN TRANSACTION READ ONLY;

\echo
\echo '== 0. Process-zone history: offsets PHP wrote into ISO strings (+08:00 everywhere => PRC throughout)'
SELECT src, month, utc_offset, count(*) AS n
  FROM (
        SELECT 'appointments.guests[].invited_at' AS src,
               to_char(a.created_at, 'YYYY-MM') AS month,
               substring(g->>'invited_at' FROM '([+-]\d{2}:\d{2}|Z)$') AS utc_offset
          FROM appointments a
         CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(a.guests) = 'array' THEN a.guests ELSE '[]'::json END) g
         WHERE json_typeof(g) = 'object' AND g->>'invited_at' IS NOT NULL
        UNION ALL
        SELECT 'audit_events.metadata.' || k.key || ' (' || e.action || ')',
               to_char(e.created_at, 'YYYY-MM'),
               substring(e.metadata->>k.key FROM '([+-]\d{2}:\d{2}|Z)$')
          FROM audit_events e
         CROSS JOIN LATERAL (VALUES ('scheduled_at'), ('expires_at')) k(key)
         WHERE json_typeof(e.metadata) = 'object'
           AND e.metadata->>k.key ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
        UNION ALL
        SELECT 'app_settings.' || s.setting_key, '-', substring(s.value FROM '([+-]\d{2}:\d{2}|Z)$')
          FROM app_settings s
         WHERE s.setting_key IN ('prod_migrate.legacy_done', 'prod_migrate.reference_specialty_seeded')
       ) t
 GROUP BY 1, 2, 3
 ORDER BY 1, 2, 3;

\echo
\echo '== 1. appointments.scheduled_at — provenance class of the CURRENT value (last writer) x status'
WITH fu AS (   -- the latest follow-up audit per appointment: the instant parseStart() stored (absolute)
    SELECT DISTINCT ON (e.resource_id)
           e.resource_id AS id, e.action AS fu_action,
           extract(epoch FROM (e.metadata->>'scheduled_at')::timestamptz)::bigint AS audit_epoch
      FROM audit_events e
     WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
       AND e.resource_type = 'appointment'
       AND json_typeof(e.metadata) = 'object'
       AND e.metadata->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
     ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC
), pi AS (     -- a card payment records the slot the patient paid for (absolute; intents exist since 2026-10-16)
    SELECT DISTINCT ON (i.consumed_by)
           i.consumed_by AS id,
           extract(epoch FROM (i.context->>'scheduled_at')::timestamptz)::bigint AS pay_epoch
      FROM payment_intents i
     WHERE i.consumed_by IS NOT NULL
       AND json_typeof(i.context) = 'object'
       AND i.context->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)$'
     ORDER BY i.consumed_by, i.created_at DESC
), a AS (
    SELECT a.id, a.specialist_id, a.status, a.type, a.proposed_by, a.rescheduled_by,
           a.deleted_at IS NOT NULL AS deleted, a.scheduled_at, a.created_at, a.expires_at,
           extract(epoch FROM a.scheduled_at)::bigint AS naive_epoch,
           fu.fu_action, fu.audit_epoch, pi.pay_epoch
      FROM appointments a
      LEFT JOIN fu ON fu.id = a.id::text
      LEFT JOIN pi ON pi.id = a.id::text
), k AS (
    SELECT a.*,
           CASE
             WHEN a.proposed_by = 'doctor' AND a.rescheduled_by IS NULL THEN CASE
                  WHEN a.audit_epoch = a.naive_epoch - :off THEN 'keep:proposal_parsestart'
                  WHEN a.audit_epoch = a.naive_epoch THEN 'shift:proposal_written_on_utc_clock'
                  WHEN a.audit_epoch IS NOT NULL AND a.fu_action = 'appointment.follow_up_accepted'
                       AND a.status <> 'proposed' THEN 'shift:proposal_moved_after_accept'
                  WHEN a.audit_epoch IS NULL AND a.expires_at = a.scheduled_at - interval '2 hours'
                       THEN 'keep:proposal_parsestart_by_expiry'
                  ELSE 'review:proposal_unproven' END
             WHEN a.proposed_by = 'doctor' THEN 'shift:proposal_then_rescheduled_by_' || a.rescheduled_by
             WHEN a.rescheduled_by IS NOT NULL THEN 'shift:rescheduled_by_' || a.rescheduled_by
             WHEN a.status = 'rescheduled' THEN 'shift:rescheduled_before_rescheduled_by_existed'
             WHEN a.proposed_by = 'patient' THEN 'shift:patient_follow_up_booking'
             ELSE 'shift:booking_patient_or_backoffice'
           END AS class
      FROM a
), cls AS (
    SELECT k.*,
           CASE WHEN k.class LIKE 'shift:%' THEN k.scheduled_at + make_interval(secs => :off) ELSE k.scheduled_at END AS new_scheduled_at,
           CASE WHEN k.pay_epoch IS NULL THEN NULL
                WHEN k.pay_epoch = k.naive_epoch THEN 'utc_clock'
                WHEN k.pay_epoch = k.naive_epoch - :off THEN 'process_clock'
                ELSE 'moved_since_payment' END AS pay_check,
           EXISTS (SELECT 1 FROM availability_slots s
                    WHERE s.specialist_id = k.specialist_id AND s.kind = 'open'
                      AND s.starts_at = k.scheduled_at + make_interval(secs => :off)) AS on_published_slot
      FROM k
)
SELECT class, status, count(*) AS n,
       count(*) FILTER (WHERE deleted)                          AS soft_deleted,
       count(*) FILTER (WHERE pay_check = 'utc_clock')          AS paid_slot_on_utc_clock,
       count(*) FILTER (WHERE pay_check = 'process_clock')      AS paid_slot_on_process_clock,
       count(*) FILTER (WHERE pay_check = 'moved_since_payment') AS moved_since_payment,
       count(*) FILTER (WHERE scheduled_at < created_at)        AS starts_before_booked_now,
       count(*) FILTER (WHERE new_scheduled_at < created_at)    AS starts_before_booked_after,
       count(*) FILTER (WHERE class LIKE 'shift:%' AND on_published_slot) AS on_wrong_clock_published_slot
  FROM cls
 GROUP BY 1, 2
 ORDER BY 1, 2;

\echo
\echo '== 2. Row listing: what would change (ids and times only)'
WITH fu AS (
    SELECT DISTINCT ON (e.resource_id)
           e.resource_id AS id, e.action AS fu_action,
           extract(epoch FROM (e.metadata->>'scheduled_at')::timestamptz)::bigint AS audit_epoch
      FROM audit_events e
     WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
       AND e.resource_type = 'appointment'
       AND json_typeof(e.metadata) = 'object'
       AND e.metadata->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
     ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC
), pi AS (
    SELECT DISTINCT ON (i.consumed_by)
           i.consumed_by AS id,
           extract(epoch FROM (i.context->>'scheduled_at')::timestamptz)::bigint AS pay_epoch
      FROM payment_intents i
     WHERE i.consumed_by IS NOT NULL
       AND json_typeof(i.context) = 'object'
       AND i.context->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)$'
     ORDER BY i.consumed_by, i.created_at DESC
), a AS (
    SELECT a.id, a.specialist_id, a.status, a.type, a.proposed_by, a.rescheduled_by,
           a.deleted_at IS NOT NULL AS deleted, a.scheduled_at, a.created_at, a.expires_at,
           extract(epoch FROM a.scheduled_at)::bigint AS naive_epoch,
           fu.fu_action, fu.audit_epoch, pi.pay_epoch
      FROM appointments a
      LEFT JOIN fu ON fu.id = a.id::text
      LEFT JOIN pi ON pi.id = a.id::text
), k AS (
    SELECT a.*,
           CASE
             WHEN a.proposed_by = 'doctor' AND a.rescheduled_by IS NULL THEN CASE
                  WHEN a.audit_epoch = a.naive_epoch - :off THEN 'keep:proposal_parsestart'
                  WHEN a.audit_epoch = a.naive_epoch THEN 'shift:proposal_written_on_utc_clock'
                  WHEN a.audit_epoch IS NOT NULL AND a.fu_action = 'appointment.follow_up_accepted'
                       AND a.status <> 'proposed' THEN 'shift:proposal_moved_after_accept'
                  WHEN a.audit_epoch IS NULL AND a.expires_at = a.scheduled_at - interval '2 hours'
                       THEN 'keep:proposal_parsestart_by_expiry'
                  ELSE 'review:proposal_unproven' END
             WHEN a.proposed_by = 'doctor' THEN 'shift:proposal_then_rescheduled_by_' || a.rescheduled_by
             WHEN a.rescheduled_by IS NOT NULL THEN 'shift:rescheduled_by_' || a.rescheduled_by
             WHEN a.status = 'rescheduled' THEN 'shift:rescheduled_before_rescheduled_by_existed'
             WHEN a.proposed_by = 'patient' THEN 'shift:patient_follow_up_booking'
             ELSE 'shift:booking_patient_or_backoffice'
           END AS class
      FROM a
), cls AS (
    SELECT k.*,
           CASE WHEN k.class LIKE 'shift:%' THEN k.scheduled_at + make_interval(secs => :off) ELSE k.scheduled_at END AS new_scheduled_at,
           CASE WHEN k.pay_epoch IS NULL THEN NULL
                WHEN k.pay_epoch = k.naive_epoch THEN 'utc_clock'
                WHEN k.pay_epoch = k.naive_epoch - :off THEN 'process_clock'
                ELSE 'moved_since_payment' END AS pay_check,
           EXISTS (SELECT 1 FROM availability_slots s
                    WHERE s.specialist_id = k.specialist_id AND s.kind = 'open'
                      AND s.starts_at = k.scheduled_at + make_interval(secs => :off)) AS on_published_slot
      FROM k
)
SELECT id, specialist_id, status, type, class,
       scheduled_at     AS stored_now,
       new_scheduled_at AS stored_after,
       new_scheduled_at - scheduled_at AS delta,
       pay_check, on_published_slot, deleted, created_at
  FROM cls
 ORDER BY class, scheduled_at, id;

\echo
\echo '== 3. Stored-hour histogram now vs after (+ the clinic-clock hour after the repair)'
WITH fu AS (
    SELECT DISTINCT ON (e.resource_id)
           e.resource_id AS id, e.action AS fu_action,
           extract(epoch FROM (e.metadata->>'scheduled_at')::timestamptz)::bigint AS audit_epoch
      FROM audit_events e
     WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
       AND e.resource_type = 'appointment'
       AND json_typeof(e.metadata) = 'object'
       AND e.metadata->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
     ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC
), a AS (
    SELECT a.id, a.status, a.proposed_by, a.rescheduled_by, a.scheduled_at, a.expires_at,
           extract(epoch FROM a.scheduled_at)::bigint AS naive_epoch, fu.fu_action, fu.audit_epoch
      FROM appointments a LEFT JOIN fu ON fu.id = a.id::text
), k AS (
    SELECT a.*,
           CASE
             WHEN a.proposed_by = 'doctor' AND a.rescheduled_by IS NULL THEN CASE
                  WHEN a.audit_epoch = a.naive_epoch - :off THEN 'keep'
                  WHEN a.audit_epoch = a.naive_epoch THEN 'shift'
                  WHEN a.audit_epoch IS NOT NULL AND a.fu_action = 'appointment.follow_up_accepted'
                       AND a.status <> 'proposed' THEN 'shift'
                  WHEN a.audit_epoch IS NULL AND a.expires_at = a.scheduled_at - interval '2 hours' THEN 'keep'
                  ELSE 'review' END
             ELSE 'shift'
           END AS verdict
      FROM a
), x AS (
    SELECT verdict,
           extract(hour FROM scheduled_at)::int AS h_now,
           extract(hour FROM CASE WHEN verdict = 'shift' THEN scheduled_at + make_interval(secs => :off) ELSE scheduled_at END)::int AS h_after,
           extract(hour FROM CASE WHEN verdict = 'shift' THEN scheduled_at + make_interval(secs => :off) ELSE scheduled_at END
                             - make_interval(secs => :off - :clinic))::int AS h_clinic_after
      FROM k
)
SELECT h.h AS hour,
       count(*) FILTER (WHERE x.h_now = h.h)          AS stored_now,
       count(*) FILTER (WHERE x.h_after = h.h)        AS stored_after,
       count(*) FILTER (WHERE x.h_clinic_after = h.h) AS clinic_clock_after,
       count(*) FILTER (WHERE x.h_now = h.h AND x.verdict = 'keep') AS kept_now
  FROM generate_series(0, 23) AS h(h)
  LEFT JOIN x ON x.h_now = h.h OR x.h_after = h.h OR x.h_clinic_after = h.h
 GROUP BY h.h
HAVING count(x.verdict) > 0
 ORDER BY h.h;

\echo
\echo '== 4. One live booking per doctor per start (uniq_appointments_live_slot): duplicates now vs after'
WITH fu AS (
    SELECT DISTINCT ON (e.resource_id)
           e.resource_id AS id, e.action AS fu_action,
           extract(epoch FROM (e.metadata->>'scheduled_at')::timestamptz)::bigint AS audit_epoch
      FROM audit_events e
     WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
       AND e.resource_type = 'appointment'
       AND json_typeof(e.metadata) = 'object'
       AND e.metadata->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
     ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC
), a AS (
    SELECT a.id, a.specialist_id, a.status, a.proposed_by, a.rescheduled_by, a.scheduled_at, a.expires_at,
           a.deleted_at IS NOT NULL AS deleted,
           extract(epoch FROM a.scheduled_at)::bigint AS naive_epoch, fu.fu_action, fu.audit_epoch
      FROM appointments a LEFT JOIN fu ON fu.id = a.id::text
), k AS (
    SELECT a.*,
           CASE
             WHEN a.proposed_by = 'doctor' AND a.rescheduled_by IS NULL THEN CASE
                  WHEN a.audit_epoch = a.naive_epoch - :off THEN 'keep'
                  WHEN a.audit_epoch = a.naive_epoch THEN 'shift'
                  WHEN a.audit_epoch IS NOT NULL AND a.fu_action = 'appointment.follow_up_accepted'
                       AND a.status <> 'proposed' THEN 'shift'
                  WHEN a.audit_epoch IS NULL AND a.expires_at = a.scheduled_at - interval '2 hours' THEN 'keep'
                  ELSE 'review' END
             ELSE 'shift'
           END AS verdict
      FROM a
), live AS (
    SELECT k.*, CASE WHEN verdict = 'shift' THEN scheduled_at + make_interval(secs => :off) ELSE scheduled_at END AS new_at
      FROM k
     WHERE status IN ('pending', 'confirmed', 'rescheduled') AND NOT deleted
)
SELECT 'now' AS when_, specialist_id, scheduled_at AS stored_start, count(*) AS bookings,
       string_agg(id::text || ':' || status || ':' || verdict, ', ' ORDER BY id) AS ids
  FROM live GROUP BY specialist_id, scheduled_at HAVING count(*) > 1
UNION ALL
SELECT 'after', specialist_id, new_at, count(*),
       string_agg(id::text || ':' || status || ':' || verdict, ', ' ORDER BY id)
  FROM live GROUP BY specialist_id, new_at HAVING count(*) > 1
 ORDER BY 1 DESC, 2, 3;

\echo
\echo '== 5. Values DERIVED from a shifting scheduled_at, and other wrong-clock tables'
WITH fu AS (
    SELECT DISTINCT ON (e.resource_id)
           e.resource_id AS id, e.action AS fu_action,
           extract(epoch FROM (e.metadata->>'scheduled_at')::timestamptz)::bigint AS audit_epoch
      FROM audit_events e
     WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
       AND e.resource_type = 'appointment'
       AND json_typeof(e.metadata) = 'object'
       AND e.metadata->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
     ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC
), a AS (
    SELECT a.id, a.status, a.type, a.proposed_by, a.rescheduled_by, a.scheduled_at, a.expires_at,
           a.deleted_at IS NOT NULL AS deleted,
           extract(epoch FROM a.scheduled_at)::bigint AS naive_epoch, fu.fu_action, fu.audit_epoch
      FROM appointments a LEFT JOIN fu ON fu.id = a.id::text
), k AS (
    SELECT a.*,
           CASE
             WHEN a.proposed_by = 'doctor' AND a.rescheduled_by IS NULL THEN CASE
                  WHEN a.audit_epoch = a.naive_epoch - :off THEN 'keep'
                  WHEN a.audit_epoch = a.naive_epoch THEN 'shift'
                  WHEN a.audit_epoch IS NOT NULL AND a.fu_action = 'appointment.follow_up_accepted'
                       AND a.status <> 'proposed' THEN 'shift'
                  WHEN a.audit_epoch IS NULL AND a.expires_at = a.scheduled_at - interval '2 hours' THEN 'keep'
                  ELSE 'review' END
             ELSE 'shift'
           END AS verdict
      FROM a
), clock AS (   -- "now" as naive wall-clock on the UTC and the process clocks, without zone names
    SELECT timestamp '1970-01-01 00:00:00' + make_interval(secs => extract(epoch FROM now())) AS now_utc,
           timestamp '1970-01-01 00:00:00' + make_interval(secs => extract(epoch FROM now()) + :off) AS now_proc
)
SELECT 'document_access_grants (after_* anchored to a shifting appointment)' AS what,
       g.status || ' / ' || g.duration || ' / ' || coalesce(g.end_reason, '-') AS bucket,
       count(*) AS n,
       count(*) FILTER (WHERE g.status <> 'active' AND g.end_reason = 'expired'
                          AND g.ended_at < g.expires_at + make_interval(secs => :off)) AS ended_before_corrected_end
  FROM document_access_grants g JOIN k ON k.id = g.appointment_id
 WHERE k.verdict = 'shift' AND g.duration IN ('after_24h', 'after_7d', 'after_30d')
 GROUP BY 2
UNION ALL
SELECT 'follow-ups priced from a shifting parent (follow_up_pricing.window_ends_at, report only)',
       ch.status || ' / ' || ch.type, count(*), NULL
  FROM appointments ch JOIN k ON k.id = ch.parent_appointment_id
 WHERE k.verdict = 'shift' AND ch.follow_up_pricing IS NOT NULL
 GROUP BY 2
UNION ALL
SELECT 'open proposals (expires_at is PHP-computed from a parseStart value: right clock)',
       CASE WHEN a.expires_at > c.now_proc THEN 'open' ELSE 'past expiry (cron never ran)' END, count(*), NULL
  FROM appointments a CROSS JOIN clock c
 WHERE a.status = 'proposed' AND a.deleted_at IS NULL
 GROUP BY 2
UNION ALL
SELECT 'live consultations still ahead after the repair (their shown time moves)',
       k.status, count(*), NULL
  FROM k CROSS JOIN clock c
 WHERE k.verdict = 'shift' AND k.status IN ('pending', 'confirmed', 'rescheduled') AND NOT k.deleted
   AND k.scheduled_at + make_interval(secs => :off) > c.now_proc
 GROUP BY 2
UNION ALL
SELECT 'live consultations already past (closer/cron backlog: presence windows were wrong)',
       k.status, count(*), NULL
  FROM k CROSS JOIN clock c
 WHERE k.verdict = 'shift' AND k.status IN ('pending', 'confirmed', 'rescheduled') AND NOT k.deleted
   AND k.scheduled_at + make_interval(secs => :off) <= c.now_proc
 GROUP BY 2
UNION ALL
SELECT 'availability_slots (UTC-clock writer: Add/BlockAvailabilityAction)',
       s.kind || ' / ' || CASE WHEN s.ends_at > c.now_utc THEN 'not yet over' ELSE 'over' END, count(*), NULL
  FROM availability_slots s CROSS JOIN clock c
 GROUP BY 2
UNION ALL
SELECT 'appointment_reminders (sent markers; cron never ran on prod)', '-', count(*), NULL FROM appointment_reminders
UNION ALL
SELECT 'appointments with presence stamps (PHP clock: unchanged)', '-', count(*), NULL
  FROM appointments WHERE doctor_first_joined_at IS NOT NULL OR patient_first_joined_at IS NOT NULL
 ORDER BY 1, 2;

\echo
\echo '== 6. Money decided against the wrong clock (report only, never changed): paid bookings closed with less than a full refund'
WITH fu AS (
    SELECT DISTINCT ON (e.resource_id)
           e.resource_id AS id, e.action AS fu_action,
           extract(epoch FROM (e.metadata->>'scheduled_at')::timestamptz)::bigint AS audit_epoch
      FROM audit_events e
     WHERE e.action IN ('appointment.follow_up_proposed', 'appointment.follow_up_accepted')
       AND e.resource_type = 'appointment'
       AND json_typeof(e.metadata) = 'object'
       AND e.metadata->>'scheduled_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$'
     ORDER BY e.resource_id, e.created_at DESC, (e.action = 'appointment.follow_up_accepted') DESC
), k AS (
    SELECT a.*,
           CASE
             WHEN a.proposed_by = 'doctor' AND a.rescheduled_by IS NULL THEN CASE
                  WHEN fu.audit_epoch = extract(epoch FROM a.scheduled_at)::bigint - :off THEN 'keep'
                  WHEN fu.audit_epoch = extract(epoch FROM a.scheduled_at)::bigint THEN 'shift'
                  WHEN fu.audit_epoch IS NOT NULL AND fu.fu_action = 'appointment.follow_up_accepted'
                       AND a.status <> 'proposed' THEN 'shift'
                  WHEN fu.audit_epoch IS NULL AND a.expires_at = a.scheduled_at - interval '2 hours' THEN 'keep'
                  ELSE 'review' END
             ELSE 'shift'
           END AS verdict
      FROM appointments a LEFT JOIN fu ON fu.id = a.id::text
)
SELECT k.id, k.status, coalesce(k.closure_reason, '-') AS closure_reason, coalesce(k.no_show, '-') AS no_show,
       k.payment_status, k.amount, k.refunded_amount,
       k.closed_at,
       k.scheduled_at AS stored_now,
       k.scheduled_at + make_interval(secs => :off) AS stored_after,
       k.closed_at < k.scheduled_at + make_interval(secs => :off) AS closed_before_real_start
  FROM k
 WHERE k.verdict = 'shift'
   AND k.status IN ('cancelled', 'missed')
   AND k.payment_status IN ('paid', 'refunded')
   AND coalesce(k.refunded_amount, CASE WHEN k.payment_status = 'refunded' THEN k.amount ELSE 0 END) < k.amount
 ORDER BY k.closed_at NULLS LAST, k.id;

ROLLBACK;
