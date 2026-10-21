<?php

declare(strict_types=1);

/**
 * OpenAPI 3.0 description of the VideoMed API, served as JSON at
 * /api/docs/openapi.json and rendered by Swagger UI at /api/docs.
 *
 * Hand-maintained: when you add or change a route, update the matching path
 * here. Kept as a PHP array (not annotations) so there is no build step.
 */

$envelope = static fn (array $dataSchema): array => [
    'type'       => 'object',
    'properties' => [
        'status'  => ['type' => 'string', 'example' => 'success'],
        'message' => ['type' => 'string', 'example' => 'OK'],
        'data'    => $dataSchema,
    ],
];

$paginated = static fn (string $ref): array => [
    'type'       => 'object',
    'properties' => [
        'status'  => ['type' => 'string', 'example' => 'success'],
        'message' => ['type' => 'string', 'example' => 'OK'],
        'data'    => ['type' => 'array', 'items' => ['$ref' => $ref]],
        'meta'    => ['$ref' => '#/components/schemas/PageMeta'],
    ],
];

$paginationParams = [
    ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
    ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 100]],
    ['name' => 'sort_by', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'created_at']],
    ['name' => 'sort_dir', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['asc', 'desc'], 'default' => 'desc']],
];

$json = static fn (array $schema): array => ['content' => ['application/json' => ['schema' => $schema]]];

// Session payload = the shared token fields plus the endpoint-specific user.
$authData = static fn (string $userRef): array => [
    'allOf' => [
        ['$ref' => '#/components/schemas/AuthTokens'],
        ['type' => 'object', 'properties' => ['user' => ['$ref' => $userRef]]],
    ],
];

return [
    'openapi' => '3.0.3',
    'info'    => [
        'title'       => 'VideoMed API',
        'version'     => '1.0.0',
        'description' => "Patient telehealth backend (Slim 4 · Doctrine · PostgreSQL).\n\n"
            . "Every response uses one envelope: `{status, message, data}`, plus `meta` when "
            . "paginated and `errors` on validation failures. Authenticate with a bearer token "
            . "from a login endpoint; tokens are audience-scoped (staff vs customer).\n\n"
            . "**401 contract.** Every 401 from an authenticated route or from `/api/auth/refresh` "
            . "carries `errors: {auth: <message>, code, reason?}` (the human message first; `message` "
            . "is unchanged). `token_missing`, `token_expired` and `token_invalid` mean *refresh the access "
            . "token once and retry*; `token_wrong_audience` is a client bug (no refresh fixes it); "
            . "`session_expired` (with `reason` `idle` or `lifetime`), `session_revoked`, `session_invalid`, "
            . "`refresh_invalid`, `account_missing` and `account_deactivated` mean *the sign-in is over: "
            . "sign out now*. A 401 without a code is a credential failure on a sign-in endpoint.\n\n"
            . "**429.** Rate-limited requests answer 429 with `errors: {rate, code: rate_limited}` and a "
            . "`Retry-After` header (seconds), exposed to browsers by CORS.",
    ],
    'servers' => [
        ['url' => 'http://localhost:8080', 'description' => 'Local dev'],
    ],
    'tags' => [
        ['name' => 'Auth', 'description' => 'Sign-in and token refresh'],
        ['name' => 'Staff', 'description' => 'Staff-scoped endpoints'],
        ['name' => 'Portal', 'description' => 'Customer (patient) portal endpoints'],
        ['name' => 'Document sharing', 'description' => 'Medical documents are private by default. The patient chooses which doctors they have booked can see the whole folder or selected documents, '
            . 'and for how long (24h, 7d, 30d, until a date, no end, or until after a consultation); they can change or stop sharing at any time (stopping does not recall copies already downloaded). '
            . 'Doctors see only what is shared now (one policy decides), every file view is recorded and visible to the patient, and doctors can ask for access. '
            . 'Background polls send `X-SD-Passive: 1`, which never extends the session idle clock.'],
        ['name' => 'System'],
    ],
    'components' => [
        'securitySchemes' => [
            'bearerAuth' => ['type' => 'http', 'scheme' => 'bearer', 'bearerFormat' => 'JWT'],
        ],
        'schemas' => [
            'PageMeta' => [
                'type'       => 'object',
                'properties' => [
                    'total'       => ['type' => 'integer', 'example' => 42],
                    'page'        => ['type' => 'integer', 'example' => 1],
                    'per_page'    => ['type' => 'integer', 'example' => 20],
                    'total_pages' => ['type' => 'integer', 'example' => 3],
                ],
            ],
            'Error' => [
                'type'       => 'object',
                'properties' => [
                    'status'  => ['type' => 'string', 'example' => 'error'],
                    'message' => ['type' => 'string', 'example' => 'Invalid email or password'],
                    'errors'  => [
                        'type'                 => 'object',
                        'description'          => 'Field → message. May also carry a machine-readable `code` (e.g. `rate_limited`, `phone_proof_expired`, `doctor_portal_only`), always after a human message key.',
                        'additionalProperties' => ['type' => 'string'],
                        'nullable'             => true,
                        'example'              => ['email' => 'Email is required'],
                    ],
                ],
            ],
            'AuthError' => [
                'type'        => 'object',
                'description' => 'A refused token or session (401). Branch on `errors.code`, show `message`.',
                'properties'  => [
                    'status'  => ['type' => 'string', 'example' => 'error'],
                    'message' => ['type' => 'string', 'example' => 'Invalid or expired token'],
                    'errors'  => [
                        'type'       => 'object',
                        'required'   => ['auth', 'code'],
                        'properties' => [
                            'auth'   => ['type' => 'string', 'description' => 'The human message again (first key)', 'example' => 'Invalid or expired token'],
                            'code'   => [
                                'type'        => 'string',
                                'enum'        => ['token_missing', 'token_expired', 'token_invalid', 'token_wrong_audience', 'session_expired', 'session_revoked', 'session_invalid', 'refresh_invalid', 'account_missing', 'account_deactivated'],
                                'description' => 'token_missing / token_expired / token_invalid: refresh once and retry. token_wrong_audience: wrong portal\'s token, do not refresh. The rest: the sign-in is over, sign out.',
                                'example'     => 'token_expired',
                            ],
                            'reason' => ['type' => 'string', 'enum' => ['idle', 'lifetime'], 'description' => 'session_expired only: idle window or absolute lifetime'],
                        ],
                    ],
                ],
            ],
            'RateLimited' => [
                'type'       => 'object',
                'properties' => [
                    'status'  => ['type' => 'string', 'example' => 'error'],
                    'message' => ['type' => 'string', 'example' => 'Too many requests'],
                    'errors'  => [
                        'type'       => 'object',
                        'properties' => [
                            'rate' => ['type' => 'string', 'example' => 'Too many requests. Please wait a moment and try again.'],
                            'code' => ['type' => 'string', 'enum' => ['rate_limited']],
                        ],
                    ],
                ],
            ],
            'Credentials' => [
                'type'       => 'object',
                'required'   => ['email', 'password'],
                'properties' => [
                    'email'    => ['type' => 'string', 'format' => 'email', 'example' => 'patient@videomed.test'],
                    'password' => ['type' => 'string', 'format' => 'password', 'example' => 'password123'],
                ],
            ],
            'AuthTokens' => [
                'type'       => 'object',
                'description' => 'Bearer tokens returned on sign-in.',
                'properties' => [
                    'access_token'  => ['type' => 'string', 'description' => 'Short-lived JWT for the Authorization header'],
                    'refresh_token' => ['type' => 'string', 'description' => 'Long-lived token for /api/auth/refresh'],
                    'token_type'    => ['type' => 'string', 'example' => 'Bearer'],
                    'expires_in'    => ['type' => 'integer', 'example' => 900, 'description' => 'Access token lifetime in seconds'],
                ],
            ],
            'AccessToken' => [
                'type'       => 'object',
                'description' => 'A refreshed access token (no new refresh token).',
                'properties' => [
                    'access_token' => ['type' => 'string'],
                    'token_type'   => ['type' => 'string', 'example' => 'Bearer'],
                    'expires_in'   => ['type' => 'integer', 'example' => 900],
                ],
            ],
            'StaffUser' => [
                'type'       => 'object',
                'properties' => [
                    'id'          => ['type' => 'string', 'format' => 'uuid'],
                    'email'       => ['type' => 'string', 'format' => 'email'],
                    'first_name'  => ['type' => 'string'],
                    'last_name'   => ['type' => 'string'],
                    'roles'       => ['type' => 'array', 'items' => ['type' => 'string'], 'example' => ['admin']],
                    'permissions' => ['type' => 'array', 'items' => ['type' => 'string'], 'example' => ['appointments.view', 'appointments.create']],
                    'active'      => ['type' => 'boolean'],
                    'created_at'  => ['type' => 'string', 'format' => 'date-time'],
                ],
            ],
            'Specialist' => [
                'type'       => 'object',
                'properties' => [
                    'id'               => ['type' => 'string', 'format' => 'uuid'],
                    'name'             => ['type' => 'string', 'example' => 'Dr. Grace Bell'],
                    'specialty'        => ['type' => 'string', 'example' => 'Cardiology'],
                    'location'         => ['type' => 'string', 'nullable' => true],
                    'consultation_fee' => ['type' => 'string', 'example' => '150.00'],
                    'rating'           => ['type' => 'string', 'example' => '4.80'],
                    'reviews_count'    => ['type' => 'integer', 'example' => 128],
                    'available'        => ['type' => 'boolean'],
                    'years_experience' => ['type' => 'integer', 'nullable' => true, 'example' => 14],
                    'languages'        => ['type' => 'string', 'nullable' => true, 'example' => 'English, French'],
                    'verified'         => ['type' => 'boolean'],
                    'gender'           => ['type' => 'string', 'nullable' => true, 'enum' => ['male', 'female']],
                    'offers_in_person' => ['type' => 'boolean'],
                    'photo_url'        => ['type' => 'string', 'nullable' => true],
                    'availability'     => ['$ref' => '#/components/schemas/SpecialistAvailability'],
                ],
            ],
            'SpecialistAvailability' => [
                'type'        => 'object',
                'description' => 'On directory listings and suggestions. `date` is the day described (a filtered date\'s first matching opening, else the next opening), in the request\'s `tz`. Never booked counts.',
                'properties'  => [
                    'date'              => ['type' => 'string', 'format' => 'date', 'nullable' => true],
                    'open_slots'        => ['type' => 'integer'],
                    'first_slot_at'     => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'slots_preview'     => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'date-time'], 'maxItems' => 3],
                    'next_available_at' => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                ],
            ],
            'AvailabilityRange' => [
                'type'       => 'object',
                'properties' => [
                    'tz'             => ['type' => 'string', 'example' => 'Africa/Lagos'],
                    'today'          => ['type' => 'string', 'format' => 'date'],
                    'bookable_from'  => ['type' => 'string', 'format' => 'date', 'description' => 'Date (in tz) of the earliest bookable time (now + lead)'],
                    'bookable_until' => ['type' => 'string', 'format' => 'date', 'description' => 'Date (in tz) of the last bookable time (now + horizon)'],
                    'horizon_days'   => ['type' => 'integer', 'example' => 60],
                    'slot_minutes'   => ['type' => 'integer', 'example' => 30],
                    'next_available' => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'days'           => ['type' => 'array', 'items' => [
                        'type'       => 'object',
                        'properties' => [
                            'date'   => ['type' => 'string', 'format' => 'date'],
                            'status' => ['type' => 'string', 'enum' => ['available', 'few', 'full', 'closed', 'blocked', 'past', 'beyond']],
                            'open'   => ['type' => 'integer'],
                            'first'  => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                        ],
                    ]],
                ],
            ],
            'DaySlots' => [
                'type'       => 'object',
                'properties' => [
                    'date'  => ['type' => 'string', 'format' => 'date'],
                    'tz'    => ['type' => 'string'],
                    'slots' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                        'iso'    => ['type' => 'string', 'format' => 'date-time'],
                        'time'   => ['type' => 'string', 'example' => '09:30'],
                        'label'  => ['type' => 'string', 'example' => '9:30 AM'],
                        'period' => ['type' => 'string', 'enum' => ['morning', 'afternoon', 'evening']],
                    ]]],
                ],
            ],
            'BookingSettings' => [
                'type'       => 'object',
                'properties' => [
                    'horizon_days' => ['type' => 'integer', 'minimum' => 7, 'maximum' => 180, 'example' => 60],
                    'lead_minutes' => ['type' => 'integer', 'minimum' => 15, 'maximum' => 1440, 'example' => 60],
                    'few_left'     => ['type' => 'integer', 'minimum' => 1, 'maximum' => 10, 'example' => 3],
                    'missed_after_hours'                   => ['type' => 'integer', 'minimum' => 1, 'maximum' => 168, 'example' => 12, 'description' => 'A past consultation is closed this long after its slot ended: completed on proof it took place (confirmed or not), else a confirmed one is marked missed'],
                    'unconfirmed_expiry_minutes_after_end' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 1440, 'example' => 0, 'description' => 'A request the doctor never confirmed is cancelled (refunded in full, closure_reason expired_unconfirmed) this long after its slot ended — never inside the doctor\'s 30-minute confirm grace (effective minimum 30). One both sides joined the call of is left for proof / the back office.'],
                    'noshow_patient_refund_pct'            => ['type' => 'integer', 'minimum' => 0, 'maximum' => 100, 'example' => 0, 'description' => 'Missed, the patient didn\'t come: share of the consultation fee refunded (the doctor earns the rest). Guest fees always go back.'],
                    'noshow_both_refund_pct'               => ['type' => 'integer', 'minimum' => 0, 'maximum' => 100, 'example' => 0, 'description' => 'Missed, neither came: share of the fee refunded (the doctor earns nothing). A doctor no-show always refunds 100%.'],
                    'late_cancel_hours'                    => ['type' => 'integer', 'minimum' => 0, 'maximum' => 168, 'example' => 0, 'description' => 'A confirmed consultation cancelled by the patient within this many hours of its start refunds late_cancel_refund_pct, and can no longer be moved by the patient (0 = off: a full refund until the start). Never applies to a booking the doctor moved (rescheduled_by doctor).'],
                    'late_cancel_refund_pct'               => ['type' => 'integer', 'minimum' => 0, 'maximum' => 100, 'example' => 100],
                    'doctor_noshow_alert_threshold'        => ['type' => 'integer', 'minimum' => 1, 'maximum' => 20, 'example' => 2, 'description' => 'Staff (specialists.manage) are alerted when a doctor reaches this many no-shows in 30 days'],
                ],
            ],
            'Appointment' => [
                'type'       => 'object',
                'properties' => [
                    'id'           => ['type' => 'string', 'format' => 'uuid'],
                    'patient_id'   => ['type' => 'string', 'format' => 'uuid'],
                    'specialist'   => [
                        'type'       => 'object',
                        'properties' => [
                            'id'        => ['type' => 'string', 'format' => 'uuid'],
                            'name'      => ['type' => 'string'],
                            'specialty' => ['type' => 'string'],
                        ],
                    ],
                    'scheduled_at' => ['type' => 'string', 'format' => 'date-time'],
                    'type'         => ['type' => 'string', 'enum' => ['video', 'follow_up', 'urgent', 'routine']],
                    'type_label'   => ['type' => 'string'],
                    'status'       => [
                        'type'        => 'string',
                        'enum'        => ['proposed', 'pending', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'missed'],
                        'description' => '`proposed`: a follow-up the doctor offered that the patient has not answered — it holds the slot until `expires_at` but is not a booking (no reminders, call, completion or earnings). Accepting moves it to confirmed; declining, withdrawal or expiry to cancelled. '
                            . '`missed`: a confirmed consultation whose time passed with no proof it took place (closed by the reminders cron, or the back office) — terminal; `no_show` says who didn\'t come. Show lists by `phase` / `display_status`, not by status.',
                    ],
                    'status_label' => ['type' => 'string'],
                    'amount'         => ['type' => 'string', 'example' => '150.00'],
                    'notes'          => ['type' => 'string', 'nullable' => true],
                    'document_url'   => ['type' => 'string', 'nullable' => true, 'deprecated' => true, 'description' => 'Legacy public attachment URL; always null once bin/prod-migrate.php has run. Booking attachments are medical documents — list them with GET /portal/documents?appointment_id='],
                    'payment_status' => ['type' => 'string', 'enum' => ['unpaid', 'pending', 'paid', 'refunded'], 'description' => 'A free consultation (amount 0) is `paid` from the start — nothing is owed. `refunded` once everything paid went back; a partial refund leaves it `paid` (see refunded_amount).'],
                    'guests'         => [
                        'type'        => 'array',
                        'description' => 'Invited third parties (max 3) — names only, in every payload (patient, doctor, back office). The patient\'s guest list with emails, status and links is GET /portal/appointments/{id}/guests.',
                        'items'       => ['type' => 'object', 'properties' => ['id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true], 'name' => ['type' => 'string']]],
                    ],
                    'parent_appointment_id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true, 'description' => 'Follow-ups: the consultation this one follows on from'],
                    'parent'                => [
                        'type'        => 'object',
                        'nullable'    => true,
                        'description' => 'Follow-ups: a summary of the consultation it follows on from',
                        'properties'  => [
                            'id'              => ['type' => 'string', 'format' => 'uuid'],
                            'scheduled_at'    => ['type' => 'string', 'format' => 'date-time'],
                            'status'          => ['type' => 'string'],
                            'specialist_name' => ['type' => 'string'],
                        ],
                    ],
                    'proposed_by'       => ['type' => 'string', 'enum' => ['doctor', 'patient'], 'nullable' => true, 'description' => 'Follow-ups: doctor = proposed by the doctor; patient = booked by the patient'],
                    'follow_up_note'    => ['type' => 'string', 'nullable' => true, 'description' => "The doctor's note to the patient on a proposal (patient and doctor payloads only — never in emails or notifications)"],
                    'follow_up_pricing' => ['$ref' => '#/components/schemas/FollowUpPrice'],
                    'expires_at'        => ['type' => 'string', 'format' => 'date-time', 'nullable' => true, 'description' => 'A proposal closes then (2h before it starts, at most 72h after proposing). Meaningful while status is proposed.'],
                    'decline_reason'    => ['type' => 'string', 'nullable' => true, 'description' => "The patient's reason for declining a proposal (patient and doctor payloads only)"],
                    'follow_up_outcome' => ['type' => 'string', 'enum' => ['declined', 'withdrawn', 'expired'], 'nullable' => true, 'description' => 'How a doctor\'s proposal closed unaccepted (status cancelled): declined by the patient, withdrawn by the doctor or the back office, or expired unanswered. null while open, once accepted, on an ordinary booking, and on proposals closed before it was recorded.'],
                    'closure_reason'    => ['type' => 'string', 'nullable' => true, 'enum' => ['expired_unconfirmed', 'no_show', 'auto_completed', 'staff_cancelled', 'staff_completed'], 'description' => 'Why it was closed when not by an ordinary patient / doctor action: expired_unconfirmed (the doctor never confirmed it before it ended — cancelled, refunded in full), no_show (missed), auto_completed (closed by the cron on proof it took place), staff_cancelled / staff_completed (the back office).'],
                    'no_show'           => ['type' => 'string', 'nullable' => true, 'enum' => ['doctor', 'patient', 'both'], 'description' => 'A missed consultation: who didn\'t come'],
                    'closed_at'         => ['type' => 'string', 'format' => 'date-time', 'nullable' => true, 'description' => 'When it reached completed / cancelled / missed (null on rows closed before it was recorded)'],
                    'rescheduled_by'    => ['type' => 'string', 'nullable' => true, 'enum' => ['patient', 'doctor', 'staff'], 'description' => 'Who moved it last. A doctor\'s move confirms it at once; a patient\'s waits for the doctor (status rescheduled).'],
                    'refunded_amount'   => ['type' => 'string', 'nullable' => true, 'example' => '5000.00', 'description' => 'What went back to the wallet for it so far (null: nothing). Partial on a missed consultation or a late cancellation — payment_status stays paid until all of it went back.'],
                    'created_at'     => ['type' => 'string', 'format' => 'date-time'],
                    // Lifecycle (server-computed — one mapping for every app).
                    'ends_at'           => ['type' => 'string', 'format' => 'date-time', 'description' => 'scheduled_at + the doctor\'s slot length'],
                    'phase'             => ['type' => 'string', 'enum' => ['upcoming', 'live', 'past'], 'description' => 'By TIME: upcoming (still to come), live (started and not yet 30 min past ends_at, or someone in the call — lists that know it), past (over: closed — completed / cancelled / missed — or ended over 30 min ago, or an expired proposal)'],
                    'display_status'    => ['type' => 'string', 'enum' => ['upcoming', 'live', 'finalising', 'completed', 'cancelled', 'missed', 'not_confirmed', 'expired'], 'description' => 'How to show it: upcoming / live; finalising (ended, being closed — confirmed, or both sides came); completed; cancelled (incl. a declined / withdrawn proposal); missed; not_confirmed (the doctor didn\'t confirm in time); expired (a proposal not taken up)'],
                    'display_label'     => ['type' => 'string', 'example' => 'Missed', 'description' => 'Upcoming: the status label (Pending, Confirmed, Rescheduled, Proposed); else In progress, Being finalised, Completed, Cancelled, Declined, Withdrawn, Missed, Not confirmed, Expired'],
                    'display_detail'    => ['type' => 'string', 'nullable' => true, 'example' => "You didn't join", 'description' => 'Worded for the viewer — missed: patient "You didn\'t join" / "Doctor didn\'t attend" / "Neither joined" (doctor: "Patient didn\'t join" / "You didn\'t attend"); not_confirmed: "Doctor didn\'t confirm in time" (doctor: "You didn\'t confirm in time"); upcoming: "Awaiting doctor confirmation", "Awaiting your reply", "Your doctor moved this consultation"…'],
                    'needs_attention'   => ['type' => 'boolean', 'description' => 'Past and still open (pending / confirmed / rescheduled): the cron closes it, or the back office resolves it'],
                    'can_cancel'        => ['type' => 'boolean', 'description' => 'Patient payloads: an open booking before its start'],
                    'can_reschedule'    => ['type' => 'boolean', 'description' => 'Patient payloads: an open booking before its start (GET /portal/appointments and /{id}: false inside the late-cancellation window). Doctor payloads: an open booking until 30 min after its end'],
                    'can_confirm'       => ['type' => 'boolean', 'description' => 'Doctor payloads: pending / rescheduled and not yet 30 min past its end'],
                    'can_decline'       => ['type' => 'boolean', 'description' => 'Doctor payloads: POST .../decline is allowed now — a confirmed booking before its start; a pending / rescheduled one until 30 min after its end'],
                    'doctor_first_joined_at'  => ['type' => 'string', 'format' => 'date-time', 'nullable' => true, 'description' => 'Admin payloads: the doctor\'s first call heartbeat inside [start − 15 min, end + 30 min] (from 2026-10 on)'],
                    'patient_first_joined_at' => ['type' => 'string', 'format' => 'date-time', 'nullable' => true, 'description' => 'Admin payloads: the patient\'s first call heartbeat inside the same window'],
                ],
            ],
            'Pricing' => [
                'type'        => 'object',
                'description' => 'Back-office-configurable consultation pricing. Follow-ups starting within `follow_up_window_days` of the consultation they follow on from cost the doctor\'s fee (`full`), that fee less `follow_up_discount_percent` (`percent`) or nothing (`free`); later than that, the full fee.',
                'properties'  => [
                    'currency'                   => ['type' => 'string', 'example' => 'NGN'],
                    'guest_fee'                  => ['type' => 'number', 'example' => 5000, 'description' => 'Added per invited guest'],
                    'platform_fee'               => ['type' => 'number', 'example' => 200],
                    'follow_up_fee_mode'         => ['type' => 'string', 'enum' => ['full', 'percent', 'free'], 'example' => 'percent'],
                    'follow_up_discount_percent' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 100, 'example' => 50],
                    'follow_up_window_days'      => ['type' => 'integer', 'minimum' => 1, 'maximum' => 365, 'example' => 14],
                ],
            ],
            'FollowUpPrice' => [
                'type'        => 'object',
                'nullable'    => true,
                'description' => 'How a follow-up was priced. rule: waived (the doctor waived the fee) | free (free mode, in the window) | percent (fee less discount_percent, in the window) | full (full mode, in the window) | outside_window (more than window_days after the original consultation: the full fee).',
                'properties'  => [
                    'base_fee'         => ['type' => 'string', 'example' => '20000.00', 'description' => "The doctor's full consultation fee"],
                    'amount'           => ['type' => 'string', 'example' => '10000.00', 'description' => 'The follow-up consultation price (before any guest fees)'],
                    'rule'             => ['type' => 'string', 'enum' => ['waived', 'free', 'percent', 'full', 'outside_window']],
                    'discount_percent' => ['type' => 'integer', 'example' => 50],
                    'window_days'      => ['type' => 'integer', 'example' => 14],
                    'window_ends_at'   => ['type' => 'string', 'format' => 'date-time', 'description' => 'Follow-up pricing applies to follow-ups starting up to this time'],
                    'waived'           => ['type' => 'boolean'],
                ],
            ],
            'FollowUpQuote' => [
                'allOf' => [
                    ['$ref' => '#/components/schemas/FollowUpPrice'],
                    [
                        'type'       => 'object',
                        'properties' => [
                            'parent_appointment_id' => ['type' => 'string', 'format' => 'uuid'],
                            'scheduled_at'          => ['type' => 'string', 'format' => 'date-time', 'description' => 'The start time this price is for'],
                            'currency'              => ['type' => 'string', 'example' => 'NGN'],
                            'within_window'         => ['type' => 'boolean'],
                            'free'                  => ['type' => 'boolean', 'description' => 'Nothing to pay: no card checkout, no wallet posting, no platform fee'],
                            'platform_fee'          => ['type' => 'number', 'example' => 200, 'description' => '0 when free'],
                        ],
                    ],
                ],
            ],
            'PatientProfile' => [
                'type'       => 'object',
                'properties' => [
                    'id'            => ['type' => 'string', 'format' => 'uuid'],
                    'email'         => ['type' => 'string', 'format' => 'email'],
                    'first_name'    => ['type' => 'string'],
                    'last_name'     => ['type' => 'string'],
                    'phone'          => ['type' => 'string', 'nullable' => true],
                    'phone_verified' => ['type' => 'boolean'],
                    'date_of_birth'  => ['type' => 'string', 'format' => 'date', 'nullable' => true],
                    'gender'         => ['type' => 'string', 'nullable' => true],
                    'address'        => ['type' => 'string', 'nullable' => true],
                    'avatar_url'     => ['type' => 'string', 'nullable' => true, 'description' => 'Relative URL of the uploaded avatar'],
                    'created_at'     => ['type' => 'string', 'format' => 'date-time'],
                ],
            ],
            'PatientSettings' => [
                'type'        => 'object',
                'description' => 'Boolean preference toggles, grouped by area. Every key defaults in.',
                'properties'  => [
                    'notifications' => [
                        'type'       => 'object',
                        'properties' => [
                            'appointment_reminder'    => ['type' => 'boolean'],
                            'consultation_updates'    => ['type' => 'boolean'],
                            'payment_notifications'   => ['type' => 'boolean'],
                            'account_security_alerts' => ['type' => 'boolean'],
                            'marketing_announcements' => ['type' => 'boolean'],
                        ],
                    ],
                    'delivery' => [
                        'type'       => 'object',
                        'properties' => [
                            'sms'   => ['type' => 'boolean'],
                            'push'  => ['type' => 'boolean'],
                            'email' => ['type' => 'boolean'],
                        ],
                    ],
                    'privacy' => [
                        'type'       => 'object',
                        'properties' => [
                            'two_factor' => ['type' => 'boolean'],
                            'biometrics' => ['type' => 'boolean'],
                        ],
                    ],
                ],
            ],
            'HealthProfile' => [
                'type'        => 'object',
                'description' => 'Emergency contact, insurance and medical records. Each section is replaced wholesale on save.',
                'properties'  => [
                    'emergency_contact' => [
                        'type'       => 'object',
                        'properties' => [
                            'full_name'    => ['type' => 'string'],
                            'relationship' => ['type' => 'string'],
                            'phone'        => ['type' => 'string'],
                            'email'        => ['type' => 'string'],
                        ],
                    ],
                    'insurance' => [
                        'type'       => 'object',
                        'properties' => [
                            'provider'        => ['type' => 'string'],
                            'plan'            => ['type' => 'string'],
                            'policy_number'   => ['type' => 'string'],
                            'coverage_status' => ['type' => 'string'],
                            'expiry_date'     => ['type' => 'string'],
                        ],
                    ],
                    'medical' => [
                        'type'       => 'object',
                        'properties' => [
                            'history'     => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['condition' => ['type' => 'string'], 'year' => ['type' => 'string'], 'note' => ['type' => 'string']]]],
                            'allergies'   => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['allergen' => ['type' => 'string'], 'severity' => ['type' => 'string'], 'reaction' => ['type' => 'string']]]],
                            'medications' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'dosage' => ['type' => 'string'], 'frequency' => ['type' => 'string']]]],
                            'conditions'  => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['condition' => ['type' => 'string'], 'status' => ['type' => 'string'], 'since' => ['type' => 'string']]]],
                        ],
                    ],
                ],
            ],
            'Session' => [
                'type'       => 'object',
                'properties' => [
                    'id'         => ['type' => 'string'],
                    'device'     => ['type' => 'string', 'example' => 'Chrome on Windows'],
                    'icon'       => ['type' => 'string', 'enum' => ['laptop', 'smartphone']],
                    'ip'         => ['type' => 'string', 'nullable' => true],
                    'created_at' => ['type' => 'string', 'format' => 'date-time'],
                    'current'    => ['type' => 'boolean'],
                ],
            ],
            'Notification' => [
                'type'       => 'object',
                'properties' => [
                    'id'         => ['type' => 'string', 'format' => 'uuid'],
                    'type'       => ['type' => 'string', 'enum' => ['appointment', 'prescription', 'payment', 'system']],
                    'type_label' => ['type' => 'string'],
                    'title'      => ['type' => 'string'],
                    'body'       => ['type' => 'string'],
                    'read'       => ['type' => 'boolean'],
                    'created_at' => ['type' => 'string', 'format' => 'date-time'],
                ],
            ],
            // ----- Guests + multi-party calls -----
            'CallParticipant' => [
                'type'        => 'object',
                'description' => 'Someone who may be in the call, by Agora uid — names only, never an email. The patient is uid 1, the doctor uid 2, each guest their own stable uid (100+).',
                'properties'  => [
                    'uid'       => ['type' => 'integer', 'example' => 100],
                    'role'      => ['type' => 'string', 'enum' => ['patient', 'doctor', 'guest']],
                    'name'      => ['type' => 'string', 'description' => 'A guest: the name they chose in the lobby, else the invitation\'s'],
                    'id'        => ['type' => 'string', 'format' => 'uuid', 'description' => 'Guests only: their guest id (matches presence.guests)'],
                    'consented' => ['type' => 'boolean', 'description' => 'Guests only: accepted the recording + privacy notice'],
                ],
            ],
            'CallPresence' => [
                'type'        => 'object',
                'description' => 'Who is in the call now (heartbeats younger than 40 s).',
                'properties'  => [
                    'doctor'  => ['type' => 'boolean'],
                    'patient' => ['type' => 'boolean'],
                    'guests'  => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid'], 'description' => 'Ids of the guests in the call'],
                ],
            ],
            'GuestConsentState' => [
                'type'        => 'object',
                'description' => 'A guest\'s recording + privacy notice. `required`: recording could happen (cloud recording is set up and the patient agreed, or one is running) — the guest must POST /public/call/{token}/consent before joining (else 403 consent_required). Otherwise the lobby shows the privacy notice only; accepting it is still worth recording.',
                'properties'  => [
                    'required'           => ['type' => 'boolean'],
                    'recording_possible' => ['type' => 'boolean'],
                    'recording_active'   => ['type' => 'boolean'],
                    'given'              => ['type' => 'boolean'],
                    'consented_at'       => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'version'            => ['type' => 'string', 'example' => '1.0'],
                ],
            ],
            'CallMeeting' => [
                'type'        => 'object',
                'description' => 'What every call screen shows. Never health data (except `patient` on the doctor\'s join), never emails.',
                'properties'  => [
                    'appointment_id'   => ['type' => 'string', 'format' => 'uuid'],
                    'scheduled_at'     => ['type' => 'string', 'format' => 'date-time'],
                    'ends_at'          => ['type' => 'string', 'format' => 'date-time', 'description' => 'scheduled_at + the booked slot length'],
                    'duration_minutes' => ['type' => 'integer', 'example' => 30],
                    'status'           => ['type' => 'string'],
                    'specialist'       => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'specialty' => ['type' => 'string']]],
                    'you'              => ['type' => 'object', 'properties' => [
                        'name' => ['type' => 'string'],
                        'role' => ['type' => 'string', 'enum' => ['patient', 'doctor', 'guest']],
                        'uid'  => ['type' => 'integer'],
                        'id'   => ['type' => 'string', 'format' => 'uuid', 'description' => 'Guests only: their guest id'],
                    ]],
                    'uid'              => ['type' => 'integer', 'description' => 'The Agora uid to join as (= you.uid)'],
                    'participants'     => ['type' => 'array', 'items' => ['$ref' => '#/components/schemas/CallParticipant']],
                    'invited_by'       => ['type' => 'object', 'description' => 'Guests only', 'properties' => ['first_name' => ['type' => 'string']]],
                    'opens_at'         => ['type' => 'string', 'format' => 'date-time', 'description' => 'Guests only: 15 minutes before the start'],
                    'closes_at'        => ['type' => 'string', 'format' => 'date-time', 'description' => 'Guests only: 60 minutes after the slot ends'],
                    'consent'          => ['$ref' => '#/components/schemas/GuestConsentState'],
                ],
            ],
            'CallRefusal' => [
                'type'        => 'object',
                'description' => 'Why a join link can\'t be used now. `errors.call` is the message (shown by apiErrorMessage); `errors.code`: cancelled | ended | withdrawn (410), not_confirmed (409, also `status: proposed`), too_early (425, with `starts_at`, `opens_at`, `server_time` to count down), consent_required (403, with `consent`).',
                'properties'  => [
                    'status'  => ['type' => 'string', 'example' => 'error'],
                    'message' => ['type' => 'string', 'example' => 'This consultation has ended.'],
                    'errors'  => ['type' => 'object', 'properties' => [
                        'call'        => ['type' => 'string'],
                        'code'        => ['type' => 'string', 'enum' => ['cancelled', 'ended', 'withdrawn', 'not_confirmed', 'too_early', 'consent_required', 'doctor_suspended', 'doctor_not_approved', 'terms_required']],
                        'status'      => ['type' => 'string', 'example' => 'proposed'],
                        'starts_at'   => ['type' => 'string', 'format' => 'date-time'],
                        'opens_at'    => ['type' => 'string', 'format' => 'date-time'],
                        'server_time' => ['type' => 'string', 'format' => 'date-time'],
                        'consent'     => ['$ref' => '#/components/schemas/GuestConsentState'],
                    ]],
                ],
            ],
            'PublicReferenceItem' => [
                'type'        => 'object',
                'description' => 'An active pick-list item, as a form offers it.',
                'properties'  => [
                    'id'         => ['type' => 'string', 'format' => 'uuid'],
                    'code'       => ['type' => 'string', 'example' => 'cardiology', 'description' => 'Stable slug (kept through renames)'],
                    'label'      => ['type' => 'string', 'example' => 'Cardiology', 'description' => 'What records store (a doctor\'s specialty)'],
                    'sort_order' => ['type' => 'integer', 'example' => 40],
                ],
            ],
            'ReferenceItem' => [
                'description' => 'A pick-list item, back-office view.',
                'allOf'       => [
                    ['$ref' => '#/components/schemas/PublicReferenceItem'],
                    ['type' => 'object', 'properties' => [
                        'category'    => ['type' => 'string', 'enum' => ['specialty']],
                        'active'      => ['type' => 'boolean', 'description' => 'Offered in the pick list'],
                        'usage_count' => ['type' => 'integer', 'description' => 'Doctors (not deleted) with this label'],
                        'created_at'  => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                        'updated_at'  => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    ]],
                ],
            ],
            'PatientGuest' => [
                'type'        => 'object',
                'description' => 'One of the patient\'s guests, as the patient sees them.',
                'properties'  => [
                    'id'                  => ['type' => 'string', 'format' => 'uuid', 'nullable' => true, 'description' => 'null only before bin/prod-migrate.php has given older guests an identity'],
                    'uid'                 => ['type' => 'integer', 'nullable' => true],
                    'name'                => ['type' => 'string'],
                    'email'               => ['type' => 'string', 'format' => 'email'],
                    'display_name'        => ['type' => 'string', 'nullable' => true, 'description' => 'The name they chose in the call lobby'],
                    'status'              => ['type' => 'string', 'enum' => ['invited', 'consented', 'joined']],
                    'in_call'             => ['type' => 'boolean'],
                    'fee'                 => ['type' => 'string', 'example' => '5000.00'],
                    'paid_by'             => ['type' => 'string', 'enum' => ['booking', 'wallet', 'card', 'free']],
                    'invited_at'          => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'last_sent_at'        => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'resend_available_at' => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'joined_at'           => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'consented_at'        => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'join_url'            => ['type' => 'string', 'nullable' => true, 'description' => 'The guest\'s personal join link — a bearer credential; for the patient to copy and share with that guest only'],
                ],
            ],
            'PatientGuestList' => [
                'type'       => 'object',
                'properties' => [
                    'guests'                  => ['type' => 'array', 'items' => ['$ref' => '#/components/schemas/PatientGuest']],
                    'max_guests'              => ['type' => 'integer', 'example' => 3],
                    'guest_fee'               => ['type' => 'string', 'example' => '5000.00', 'description' => 'What inviting one more costs now (0.00: free)'],
                    'currency'                => ['type' => 'string', 'example' => 'NGN'],
                    'can_manage'              => ['type' => 'boolean', 'description' => 'Guests can be added / removed / re-sent (pending, confirmed or rescheduled, before the guest window closes)'],
                    'can_add'                 => ['type' => 'boolean'],
                    'manage_problem'          => ['type' => 'string', 'nullable' => true, 'description' => 'Why not, when can_manage is false'],
                    'refundable_until'        => ['type' => 'string', 'format' => 'date-time', 'description' => 'Removing a paid guest before this refunds their fee to the wallet'],
                    'window_closes_at'        => ['type' => 'string', 'format' => 'date-time'],
                    'resend_interval_seconds' => ['type' => 'integer', 'example' => 120],
                ],
            ],
        ],
        'responses' => [
            'Unauthorized' => $json(['oneOf' => [['$ref' => '#/components/schemas/AuthError'], ['$ref' => '#/components/schemas/Error']]]) + ['description' => 'Missing / expired / invalid token or ended session (`errors.code`, see AuthError), or wrong credentials on a sign-in endpoint (no code)'],
            'TooManyRequests' => $json(['$ref' => '#/components/schemas/RateLimited']) + [
                'description' => 'Rate limited (`errors.code` rate_limited)',
                'headers'     => ['Retry-After' => ['description' => 'Seconds until the limit resets', 'schema' => ['type' => 'integer']]],
            ],
            'Forbidden'    => $json(['$ref' => '#/components/schemas/Error']) + ['description' => 'Not allowed'],
            'NotFound'     => $json(['$ref' => '#/components/schemas/Error']) + ['description' => 'Not found'],
            'Validation'   => $json(['$ref' => '#/components/schemas/Error']) + ['description' => 'Validation failed'],
        ],
    ],
    'paths' => [
        // ----- Wallet (customer) -----
        '/api/portal/wallet' => [
            'get' => ['tags' => ['Wallet'], 'summary' => 'Get wallet balance + recent entries', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/wallet/transactions' => [
            'get' => ['tags' => ['Wallet'], 'summary' => 'List wallet ledger (paginated, ?type=)', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/wallet/fund' => [
            'post' => ['tags' => ['Wallet'], 'summary' => 'Start a Paystack top-up', 'responses' => ['201' => ['description' => 'Checkout URL']]],
        ],
        '/api/portal/wallet/verify' => [
            'post' => [
                'tags'        => ['Wallet'],
                'summary'     => 'Verify + settle a top-up',
                'description' => 'Re-verifies the reference with Paystack, then credits the top-up at most once — only when the verified amount and currency equal what it asked for. '
                    . 'Safe to repeat: an already decided top-up is answered from the ledger without calling Paystack again (no second receipt).',
                'responses'   => [
                    '200' => ['description' => 'Credited now (`message`: "Wallet funded") or earlier — `data.status` "success", with the wallet and the transaction'],
                    '402' => ['description' => 'Paystack says the payment was not completed (failed / abandoned / reversed) — nothing added'],
                    '404' => ['description' => 'No such top-up for this patient'],
                    '409' => ['description' => 'Still processing at the bank (credited once Paystack confirms), or paid with a different amount/currency and held for support review — `message` says which'],
                    '422' => ['description' => 'Missing reference'],
                    '502' => ['description' => 'Paystack could not be reached — try again'],
                ],
            ],
        ],
        '/api/webhooks/paystack' => [
            'post' => [
                'tags'        => ['Webhooks'],
                'summary'     => 'Paystack event webhook',
                'security'    => [],
                'description' => 'The `x-paystack-signature` header (HMAC-SHA512 of the raw body with the secret key) is required. '
                    . '`charge.success` is re-verified with Paystack, then settled by reference: a wallet top-up is credited at most once (only for the verified amount and currency it expected); '
                    . 'a card checkout (booking / follow-up / guest) is marked paid — used by the patient\'s request, or credited to their wallet by the cron once unused for CARD_INTENT_CREDIT_AFTER_MINUTES. '
                    . 'Idempotent: repeats change nothing. Other events are acknowledged and ignored. Not rate-limited per IP.',
                'responses'   => [
                    '200' => ['description' => 'Received (`data.outcome` says what happened)'],
                    '401' => ['description' => 'Missing or invalid signature — nothing was read'],
                    '503' => ['description' => 'Paystack could not confirm the charge just now — Paystack retries the event'],
                ],
            ],
        ],

        // ----- Consultation: doctor clinical actions -----
        '/api/doctor/appointments/{id}/note' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Get SOAP note', 'responses' => ['200' => ['description' => 'OK']]],
            'put' => ['tags' => ['Doctor'], 'summary' => 'Save SOAP note draft', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/note/finalize' => [
            'post' => ['tags' => ['Doctor'], 'summary' => 'Finalize (lock) the SOAP note', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/messages' => [
            'get'  => ['tags' => ['Doctor'], 'summary' => 'Read the patient message thread', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'post' => ['tags' => ['Doctor'], 'summary' => 'Post a message to the patient', 'responses' => ['201' => ['description' => 'Created'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/appointments/{id}/patient-documents' => [
            'get' => [
                'tags'        => ['Doctor', 'Document sharing'],
                'summary'     => 'Documents the patient has shared with you (legacy list)',
                'description' => 'Only what the consultation\'s patient chose to share with this doctor, now (DocumentAccessPolicy), newest first, '
                    . 'as the doctor allowlist (`uploader_name` only for the patient\'s own uploads; `appointment_id` only when that consultation is yours). '
                    . 'Fails closed to `[]` (reported). New clients use GET …/document-access. `Cache-Control: no-store`.',
                'responses'   => ['200' => ['description' => 'OK (possibly empty)'], '403' => ['$ref' => '#/components/responses/Forbidden']],
            ],
        ],
        '/api/doctor/appointments/{id}/patient-documents/{docId}/file' => [
            'get' => [
                'tags'        => ['Doctor', 'Document sharing'],
                'summary'     => 'Open one document the patient shares with you',
                'description' => 'Bound to THIS consultation\'s patient. The view is recorded before a byte is streamed (audit `document.viewed`, the patient\'s ledger, the share\'s counter) — '
                    . 'the patient can see every view.',
                'responses'   => [
                    '200' => ['description' => 'File'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` not_shared — not (or no longer) shared with you; nothing is recorded'],
                    '503' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` view_unavailable — the view could not be recorded, so nothing was streamed'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/document-access' => [
            'get' => [
                'tags'        => ['Doctor', 'Document sharing'],
                'summary'     => 'What the patient shares with you, and whether you may ask (DoctorDocumentAccessDto)',
                'description' => 'Patients choose what each doctor sees and for how long (time-boxed; stopping a share does not recall copies already downloaded). '
                    . '`access` (none | active, scope, until_label_at / indefinite = latest end of everything visible, folder_until_label_at / folder_indefinite = the whole-folder share\'s own end, ends_soon …), `documents` (allowlist + via / shared_until_label_at), `request` (can_request, kind access | extend, '
                    . 'blocked_reason, available_at, pending, last), `server_time`. Audited `document.list_viewed` at most every 15 min — never for `X-SD-Passive: 1`, '
                    . 'which also never extends the session idle clock. With sharing switched off: 200, state none, blocked_reason sharing_unavailable. `Cache-Control: no-store`.',
                'parameters'  => [['name' => 'X-SD-Passive', 'in' => 'header', 'required' => false, 'schema' => ['type' => 'string', 'enum' => ['1']], 'description' => 'Background poll']],
                'responses'   => [
                    '200' => ['description' => 'OK'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '503' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` sharing_unavailable — could not be worked out right now (never a false empty list)'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/document-access/request' => [
            'post' => [
                'tags'        => ['Doctor', 'Document sharing'],
                'summary'     => 'Ask the patient to share documents (DoctorAccessRequestDto)',
                'description' => 'Body `{message?}` (≤ 500 characters after cleaning; shown in the patient app only). The patient gets an in-app notice and an email naming the doctor only. '
                    . 'Pending for 7 days; 72 h cooldown after a decline; ≤ 3 per patient per 30 days and ≤ 30 per day.',
                'requestBody' => $json(['type' => 'object', 'properties' => ['message' => ['type' => 'string', 'maxLength' => 500, 'nullable' => true]]]),
                'responses'   => [
                    '201' => ['description' => 'Request sent'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '409' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` request_pending (+ `errors.request`) | request_cooldown / request_limit (+ `errors.available_at`) | has_full_access | request_blocked'],
                    '422' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` appointment_not_eligible | doctor_unavailable, or `errors.message`'],
                    '503' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` sharing_unavailable'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/document-access/request/cancel' => [
            'post' => [
                'tags'      => ['Doctor', 'Document sharing'],
                'summary'   => 'Withdraw your pending request (no patient notice)',
                'responses' => [
                    '200' => ['description' => 'Withdrawn (DoctorAccessRequestDto)'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '409' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` request_not_pending (+ `errors.status`)'],
                    '503' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => '`errors.code` sharing_unavailable'],
                ],
            ],
        ],

        // ----- Document sharing (patient) -----
        '/api/portal/document-access/doctors' => [
            'get' => [
                'tags'        => ['Document sharing'],
                'summary'     => 'Doctors you have booked and what each can see (SharingDoctorDto[])',
                'description' => 'Most recent consultation first. `access` (state none | active | paused, scope, until_label_at, folder_until_label_at, hidden_count …), '
                    . '`next_appointment` with its `after_options`, `pending_request`, `requests_blocked`. 503 `sharing_unavailable` while sharing is switched off (every route of this tag).',
                'responses'   => ['200' => ['description' => 'OK'], '503' => ['description' => '`errors.code` sharing_unavailable']],
            ],
        ],
        '/api/portal/document-access/revoke-all' => [
            'post' => ['tags' => ['Document sharing'], 'summary' => 'Stop sharing with everyone (one Undo batch; pending requests stay)', 'responses' => ['200' => ['description' => 'RevokeResultDto']]],
        ],
        '/api/portal/document-access/doctors/{specialistId}/revoke' => [
            'post' => ['tags' => ['Document sharing'], 'summary' => 'Stop sharing with one doctor (Undo for 10 minutes)', 'responses' => ['200' => ['description' => 'RevokeResultDto'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/document-access/doctors/{specialistId}/allow-requests' => [
            'post' => ['tags' => ['Document sharing'], 'summary' => 'Let a doctor ask for access again (idempotent)', 'responses' => ['200' => ['description' => 'SharingDoctorDto'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/document-access/grants' => [
            'get'  => [
                'tags'       => ['Document sharing'],
                'summary'    => 'Your shares (DocumentGrantDto[])',
                'parameters' => [
                    ['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['active', 'ended'], 'default' => 'active']],
                    ['name' => 'specialist_id', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'  => ['200' => ['description' => 'OK']],
            ],
            'post' => [
                'tags'        => ['Document sharing'],
                'summary'     => 'Share documents with doctors you booked (CreateDocumentShareInput)',
                'description' => 'Patient-chosen and time-boxed: `scope` all (the whole folder, including later uploads, minus hidden ones) or selected (`document_ids`, 1–200); '
                    . '`duration` 24h | 7d | 30d | until (`expires_at` with Z or ±hh:mm, exclusive) | indefinite | after_24h | after_7d | after_30d (after the `appointment_id` consultation ends). '
                    . '1–5 doctors, each booked and practising, all in one transaction (any refusal shares nothing). A folder share merges into an existing one taking the later end. '
                    . '`client_key` (uuid per submission): a repeat within 24 h answers 200 `replayed`. `answers_request_id` closes that request as answered. Stopping a share does not recall copies.',
                'requestBody' => $json(['type' => 'object', 'required' => ['specialist_ids', 'scope', 'duration', 'client_key', 'surface'], 'properties' => [
                    'specialist_ids' => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid'], 'maxItems' => 5],
                    'scope'          => ['type' => 'string', 'enum' => ['all', 'selected']],
                    'document_ids'   => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid'], 'maxItems' => 200],
                    'duration'       => ['type' => 'string', 'enum' => ['24h', '7d', '30d', 'until', 'indefinite', 'after_24h', 'after_7d', 'after_30d']],
                    'expires_at'     => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                    'appointment_id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true],
                    'client_key'     => ['type' => 'string', 'format' => 'uuid'],
                    'answers_request_id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true],
                    'show_hidden_for_specialist_ids' => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid']],
                    'surface'        => ['type' => 'string', 'enum' => ['documents_page', 'manage_sharing', 'document_access', 'upload', 'booking', 'appointment_details', 'call', 'request']],
                ]]),
                'responses'   => [
                    '201' => ['description' => 'DocumentShareResultDto (outcomes created | merged | extended | unchanged)'],
                    '200' => ['description' => 'Replay of the same submission (`replayed: true`)'],
                    '409' => ['description' => '`errors.code` idempotency_conflict'],
                    '422' => ['description' => 'Field errors, or `errors.code` doctor_not_eligible | doctor_unavailable | nothing_selected'],
                    '503' => ['description' => '`errors.code` sharing_unavailable'],
                ],
            ],
        ],
        '/api/portal/document-access/grants/{id}' => [
            'patch' => [
                'tags'        => ['Document sharing'],
                'summary'     => 'Change a share (UpdateDocumentGrantInput): end, scope, documents',
                'description' => 'The doctor is told only when access widens. Scope → all merges into an existing folder share (the survivor is returned).',
                'responses'   => ['200' => ['description' => 'DocumentGrantDto'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => '`errors.code` grant_ended'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/portal/document-access/grants/{id}/revoke' => [
            'post' => ['tags' => ['Document sharing'], 'summary' => 'Stop one share (idempotent; Undo for 10 minutes; no doctor notice)', 'responses' => ['200' => ['description' => 'DocumentGrantDto'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/document-access/grants/{id}/restore' => [
            'post' => ['tags' => ['Document sharing'], 'summary' => 'Undo a revoke within 10 minutes (the whole batch)', 'responses' => ['200' => ['description' => 'RestoreResultDto'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => '`errors.code` restore_expired']]],
        ],
        '/api/portal/document-access/requests' => [
            'get' => [
                'tags'       => ['Document sharing'],
                'summary'    => "Doctors' requests to see your documents (DocumentAccessRequestDto[])",
                'parameters' => [['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['pending', 'all'], 'default' => 'pending']]],
                'responses'  => ['200' => ['description' => 'OK']],
            ],
        ],
        '/api/portal/document-access/requests/{id}' => [
            'get' => ['tags' => ['Document sharing'], 'summary' => 'One request (any status)', 'responses' => ['200' => ['description' => 'DocumentAccessRequestDto'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/document-access/requests/{id}/approve' => [
            'post' => [
                'tags'      => ['Document sharing'],
                'summary'   => 'Approve with scope and duration (ApproveAccessRequestInput)',
                'responses' => [
                    '200' => ['description' => '`{request, grant}`'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '409' => ['description' => '`errors.code` request_not_pending (+ `errors.status`)'],
                    '422' => ['description' => 'Field errors, or doctor_unavailable / doctor_not_eligible (the request is closed)'],
                ],
            ],
        ],
        '/api/portal/document-access/requests/{id}/decline' => [
            'post' => [
                'tags'        => ['Document sharing'],
                'summary'     => 'Decline (optionally stop this doctor asking again)',
                'requestBody' => $json(['type' => 'object', 'properties' => ['block_future_requests' => ['type' => 'boolean']]]),
                'responses'   => ['200' => ['description' => 'DocumentAccessRequestDto'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => '`errors.code` request_not_pending']],
            ],
        ],
        '/api/portal/document-access/history' => [
            'get' => [
                'tags'       => ['Document sharing'],
                'summary'    => 'Your sharing ledger, every doctor view included (DocumentAccessEventDto, paginated)',
                'parameters' => [
                    ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
                    ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 50]],
                    ['name' => 'specialist_id', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'document_id', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'  => ['200' => ['description' => 'OK']],
            ],
        ],
        '/api/portal/documents/{id}/access' => [
            'get' => ['tags' => ['Document sharing'], 'summary' => 'Who can see this document (DocumentAccessDetailDto)', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/documents/{id}/access/{specialistId}' => [
            'delete' => ['tags' => ['Document sharing'], 'summary' => "Remove a doctor's access to this document (lasting; idempotent)", 'responses' => ['200' => ['description' => 'DocumentAccessDetailDto'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/documents/{id}/access/{specialistId}/unhide' => [
            'post' => ['tags' => ['Document sharing'], 'summary' => "Show this document through the doctor's whole-folder share again", 'responses' => ['200' => ['description' => 'DocumentAccessDetailDto'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/appointments/{id}/document-access' => [
            'get' => [
                'tags'        => ['Document sharing'],
                'summary'     => 'What this consultation\'s doctor can see (AppointmentDocumentAccessDto)',
                'description' => 'Same policy query as the doctor\'s own view. `unshared_attachments` = files attached when booking that the doctor cannot see. Accepts `X-SD-Passive: 1`.',
                'parameters'  => [['name' => 'X-SD-Passive', 'in' => 'header', 'required' => false, 'schema' => ['type' => 'string', 'enum' => ['1']], 'description' => 'Background poll: never extends the session idle clock']],
                'responses'   => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/doctor/appointments/{id}/prescriptions' => [
            'get'  => ['tags' => ['Doctor'], 'summary' => "This consultation's prescriptions (drafts included)", 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/drugs' => [
            'get' => [
                'tags' => ['Prescriptions'],
                'summary' => 'Search the RxNorm prescribable catalogue (?q=&limit=)',
                'description' => 'Generic products first. INN/British names (paracetamol, salbutamol, adrenaline…) map to their RxNorm names. Source: RxNorm, U.S. National Library of Medicine.',
                'parameters' => [['name' => 'q', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string']], ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer', 'maximum' => 50]]],
                'responses' => ['200' => ['description' => 'Matching products'], '403' => ['$ref' => '#/components/responses/Forbidden']],
            ],
        ],
        '/api/doctor/prescriptions/options' => [
            'get' => ['tags' => ['Prescriptions'], 'summary' => 'Form defaults + option lists (default validity, routes, reading boxes, limits, has_signature, mdcn_number)', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/prescriptions' => [
            'get'  => ['tags' => ['Prescriptions'], 'summary' => "The doctor's prescriptions (?status=draft|active|expired|cancelled&patient_id=&page=&per_page=)", 'responses' => ['200' => ['description' => 'Paginated summaries'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'post' => [
                'tags' => ['Prescriptions'],
                'summary' => 'Start a draft prescription',
                'description' => 'With appointment_id it belongs to that consultation (during or after the call); otherwise patient_id must be a patient the doctor has consulted. The rest of the body is the (possibly partial) GVM-F-RX-01 form: readings, reason, icd_code, current_medications, pregnancy_status, items[{rxcui, dose, route, frequency, duration, quantity, repeats, no_substitute, instructions}], advice, follow_up_date, follow_up_mode, tests_referrals, valid_until, allows_repeats.',
                'responses' => ['201' => ['description' => 'Draft created (numbered GVM-RX-YYYYMMDD-NNNNN)'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/doctor/prescriptions/{rxId}' => [
            'get'    => ['tags' => ['Prescriptions'], 'summary' => 'One of my prescriptions', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
            'put'    => ['tags' => ['Prescriptions'], 'summary' => 'Save the whole form of a draft (409 once sent)', 'responses' => ['200' => ['description' => 'Saved'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => 'Sent prescriptions are locked'], '422' => ['$ref' => '#/components/responses/Validation']]],
            'delete' => ['tags' => ['Prescriptions'], 'summary' => 'Delete a draft (409 once sent)', 'responses' => ['200' => ['description' => 'Deleted'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => 'Sent prescriptions can only be cancelled']]],
        ],
        '/api/doctor/prescriptions/{rxId}/send' => [
            'post' => [
                'tags' => ['Prescriptions'],
                'summary' => 'Sign, lock and send to the patient',
                'description' => 'Body: optional form (final edits), confirm {allergies, doses, patient} (all true), signature {mode: saved|drawn, image?: data URL, save?: bool}. The patient is notified in-app and by email naming only the doctor and the number.',
                'responses' => ['200' => ['description' => 'Sent (Active)'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => 'Already sent'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/doctor/prescriptions/{rxId}/cancel' => [
            'post' => ['tags' => ['Prescriptions'], 'summary' => 'Cancel an active prescription {reason, replace?}; replace returns a pre-filled draft', 'responses' => ['200' => ['description' => 'Cancelled'], '404' => ['$ref' => '#/components/responses/NotFound'], '409' => ['description' => 'Not active'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/doctor/prescriptions/{rxId}/link' => [
            'post' => ['tags' => ['Prescriptions'], 'summary' => 'Signed short-lived URL to the PDF {download?} (drafts carry a DRAFT watermark)', 'responses' => ['200' => ['description' => '{url, expires_at, filename}'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/doctor/patients/{id}/clinical-summary' => [
            'get' => ['tags' => ['Prescriptions'], 'summary' => 'Read-only side panel: allergies (most serious first), latest readings, current medicines, pregnancy question flag', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/doctor/signature' => [
            'get'    => ['tags' => ['Prescriptions'], 'summary' => 'My saved signature {has_signature, image}', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'post'   => ['tags' => ['Prescriptions'], 'summary' => 'Save my signature (multipart `signature` PNG/JPG < 500 KB, or JSON {image: data URL})', 'responses' => ['200' => ['description' => 'Saved'], '422' => ['$ref' => '#/components/responses/Validation']]],
            'delete' => ['tags' => ['Prescriptions'], 'summary' => 'Remove my saved signature', 'responses' => ['200' => ['description' => 'Removed']]],
        ],
        '/api/doctor/appointments/{id}/lab-orders' => [
            'get'  => ['tags' => ['Doctor'], 'summary' => 'List lab orders', 'responses' => ['200' => ['description' => 'OK']]],
            'post' => ['tags' => ['Doctor'], 'summary' => 'Create a lab order', 'responses' => ['201' => ['description' => 'Created']]],
        ],
        '/api/doctor/appointments/{id}/referrals' => [
            'get'  => ['tags' => ['Doctor'], 'summary' => 'List referrals', 'responses' => ['200' => ['description' => 'OK']]],
            'post' => ['tags' => ['Doctor'], 'summary' => 'Create a referral', 'responses' => ['201' => ['description' => 'Created']]],
        ],
        '/api/doctor/appointments/{id}/certificates' => [
            'get'  => ['tags' => ['Doctor'], 'summary' => 'List medical certificates', 'description' => '`meta.earliest_from_date` (Y-m-d, clinic calendar) is the earliest sick-leave start the POST accepts; `meta.backdate_days` is the window.', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'post' => ['tags' => ['Doctor'], 'summary' => 'Issue a medical certificate', 'description' => 'Sick leave may start at most 7 days ago (clinic calendar); `to_date` must be on or after `from_date`.', 'responses' => ['201' => ['description' => 'Created'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/doctor/appointments/{id}/documents/{kind}/{docId}' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Render a printable clinical document (HTML)', 'responses' => ['200' => ['description' => 'HTML document'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/doctor/appointments/{id}/care-plan' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Get care plan', 'responses' => ['200' => ['description' => 'OK']]],
            'put' => ['tags' => ['Doctor'], 'summary' => 'Save care plan', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/consents' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Read the patient consent state', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/recording' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Recording availability + active session + `guest_consent: {connected, pending, pending_ids, unknown}` (guests in the call now — by heartbeat, or given a token in the last 10 minutes and not left since — who haven\'t accepted the recording notice; recording waits for them. `unknown`: presence couldn\'t be read, so every invited guest counts)', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/recording/files' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Recording playback/download URLs', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/appointments/{id}/recording/start' => [
            'post' => ['tags' => ['Doctor'], 'summary' => 'Start cloud recording (consent-gated)', 'description' => 'Needs the patient\'s recording consent (403) and every guest in the call now to have accepted the recording notice: otherwise 422 "N guest(s) in the call haven\'t agreed to recording yet" with `errors.guests_without_consent` (count), `errors.guest_ids` and `errors.presence_unknown` (true: presence couldn\'t be read, so every invited guest who hasn\'t agreed counts — "We can\'t check who is in the call right now, and N invited guest(s) haven\'t agreed…").', 'responses' => ['201' => ['description' => 'Started'], '403' => ['description' => 'No patient consent'], '422' => ['description' => 'A guest in the call has not consented']]],
        ],
        '/api/doctor/appointments/{id}/recording/stop' => [
            'post' => ['tags' => ['Doctor'], 'summary' => 'Stop cloud recording', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/metrics' => [
            'post' => ['tags' => ['Doctor'], 'summary' => 'Report an RTC quality sample', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/transcript' => [
            'get'  => ['tags' => ['Doctor'], 'summary' => 'Get the consultation transcript', 'responses' => ['200' => ['description' => 'OK']]],
            'post' => ['tags' => ['Doctor'], 'summary' => 'Append a transcript segment', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/copilot' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Get the AI copilot draft', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/doctor/appointments/{id}/copilot/draft' => [
            'post' => ['tags' => ['Doctor'], 'summary' => 'Generate an AI clinical draft', 'responses' => ['200' => ['description' => 'OK']]],
        ],

        // ----- Consultation: patient views -----
        '/api/portal/appointments/{id}/consultation' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'Consultation summary', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/messages' => [
            'get'  => ['tags' => ['Consultation'], 'summary' => 'Read the doctor message thread', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
            'post' => ['tags' => ['Consultation'], 'summary' => 'Post a message to the doctor', 'responses' => ['201' => ['description' => 'Created'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/document-types' => [
            'get' => ['tags' => ['Documents'], 'summary' => 'Medical document type catalogue', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/documents' => [
            'get'  => [
                'tags'        => ['Documents'],
                'summary'     => 'List my medical documents (?search=&type=&sort_dir=&appointment_id=)',
                'description' => '`appointment_id` narrows the list to the files attached to one of my bookings (each document carries `appointment_id`, null when it is not attached to one). Booking attachments have `document_type` `booking_attachment`. '
                    . 'Each row carries `shared_with` (DocumentSharedWithDto[]: who can see it now, via folder or document, until when, paused); the key is left out when it could not be worked out.',
                'parameters'  => [
                    ...$paginationParams,
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'type', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'appointment_id', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'   => ['200' => ['description' => 'OK'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
            'post' => [
                'tags'        => ['Documents', 'Document sharing'],
                'summary'     => 'Upload a medical document (multipart) and choose who can see it',
                'description' => 'Fields `file`, `document_type`, `custom_type`; optional sharing: `share_specialist_ids[]` (≤ 5 booked, practising doctors) with `share_duration`, '
                    . '`share_expires_at`, `share_appointment_id`, `share_batch_id` (one uuid per upload batch), `exclude_specialist_ids[]` (whole-folder holders who must not see it) '
                    . 'and `share_surface` (documents_page | appointment_details). Checked before the bytes are stored. Without them the file is private except to whole-folder holders. '
                    . 'Answer UploadedDocumentDto: `shared_with`, `share_outcome` (shared | partly_shared | share_ended | private | sharing_unavailable), `share_ended_for`.',
                'responses'   => [
                    '201' => ['description' => 'Created'],
                    '409' => ['description' => '`errors.code` idempotency_conflict — this batch id was sent with other choices'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/documents/{id}/file' => [
            'get' => ['tags' => ['Documents'], 'summary' => 'Stream one of my documents', 'responses' => ['200' => ['description' => 'File'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/appointments/{id}/prescriptions' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'My prescriptions for this consultation (sent only)', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/prescriptions' => [
            'get' => ['tags' => ['Prescriptions'], 'summary' => 'My prescriptions (number, doctor, date sent, valid until, status), newest first', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized']]],
        ],
        '/api/portal/prescriptions/{id}' => [
            'get' => ['tags' => ['Prescriptions'], 'summary' => 'One of my sent prescriptions (opening is audited)', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/prescriptions/{id}/link' => [
            'post' => ['tags' => ['Prescriptions'], 'summary' => 'Signed short-lived URL to view/download/print the PDF {download?}', 'responses' => ['200' => ['description' => '{url, expires_at, filename}'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/appointments/{id}/lab-orders' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'My lab orders', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/referrals' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'My referrals', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/certificates' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'My medical certificates', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/documents/{kind}/{docId}' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'Render one of my clinical documents (HTML)', 'responses' => ['200' => ['description' => 'HTML document'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/appointments/{id}/care-plan' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'My care plan', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/consents' => [
            'get'  => ['tags' => ['Consultation'], 'summary' => 'My consent state', 'responses' => ['200' => ['description' => 'OK']]],
            'post' => ['tags' => ['Consultation'], 'summary' => 'Grant/withdraw a consent', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/recordings' => [
            'get' => ['tags' => ['Consultation'], 'summary' => 'Recording state + finished files', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/transcript' => [
            'get'  => ['tags' => ['Consultation'], 'summary' => 'Transcript tail (captions)', 'responses' => ['200' => ['description' => 'OK']]],
            'post' => ['tags' => ['Consultation'], 'summary' => 'Append a transcript segment', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/portal/appointments/{id}/metrics' => [
            'post' => ['tags' => ['Consultation'], 'summary' => 'Report an RTC quality sample', 'responses' => ['200' => ['description' => 'OK']]],
        ],

        // ----- Back-office monitoring -----
        '/api/admin/monitoring/overview' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'Platform activity overview', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/admin/monitoring/consultations' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'Recent consultations', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/admin/monitoring/recordings' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'Recent recordings', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/admin/recordings/{id}/files' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'Recording playback/download URLs', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/admin/monitoring/audit' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'Audit log (paginated)', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/admin/monitoring/quality' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'RTC quality per consultation', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/admin/analytics' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'Booking + revenue analytics (?range=7d|30d|90d|12m)', 'responses' => ['200' => ['description' => 'OK']]],
        ],
        '/api/admin/dashboard' => [
            'get' => [
                'tags'        => ['Monitoring'],
                'summary'     => 'Back-office dashboard: KPIs vs the previous period, live now, needs attention, 30-day trends, breakdowns',
                'description' => "Needs any of monitoring.view, appointments.view, specialists.manage, payouts.manage, support.manage — and each part only comes back for the permission its back-office page needs: "
                    . "kpis.activity / live / trends.activity / breakdowns.status / breakdowns.specialties / breakdowns.activity → monitoring.view; kpis.money / trends.revenue (and the revenue columns of the breakdowns) → monitoring.view or payouts.manage; "
                    . "kpis.doctors → monitoring.view or specialists.manage; attention.appointments → appointments.view; attention.doctors / breakdowns.doctors → specialists.manage; attention.payouts → payouts.manage; attention.support → support.manage; attention.payments → payouts.manage or support.manage. "
                    . "A doctor login without a back-office permission gets 403. `parts` lists the granted parts, `sections` the sections returned (kpis, live, attention, trends, breakdowns), `unavailable` any that failed to load. "
                    . "KPI tiles (`kpis[]`: key, label, format count|money|rating, value, previous, change_pct, trend up|down|flat, higher_is_better, count, previous_count, breakdown): bookings, consultations_completed, revenue (paid bookings incl. follow-ups and guest fees, net of refunds, by booking date), wallet_topups, refunds (wallet refunds posted), new_patients, active_doctors (approved + taking bookings; a snapshot, breakdown {approved, taking_bookings}), cancellations, missed (breakdown by no-show party: patient, doctor, both, unknown), average_rating (count = reviews). "
                    . "The current window is the period up to now in `tz`; the previous one is the same span one period earlier. Money is a string in `currency`. "
                    . "live: in_progress (someone in the call now), starting_soon (open bookings in the next window_minutes), with counts. attention[]: key, label, description, count, amount (money queues), tone info|warning|alert, link {path, query} to the filtered back-office page (null when there is none). "
                    . "trends: 30 local days, days[] {date, bookings, completed, revenue} (null for a series the caller can't see), series, totals. breakdowns (consultations scheduled from the period start to the end of today): by_status[], top_specialties[], top_doctors[], recent_activity[] {action, label, summary, actor_name, actor_role, created_at, link}. Cached server-side for up to a minute (refresh=1 skips it).",
                'parameters'  => [
                    ['name' => 'period', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['today', '7d', '30d'], 'default' => 'today']],
                    ['name' => 'tz', 'in' => 'query', 'description' => "The viewer's IANA time zone (default the clinic's)", 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                    ['name' => 'refresh', 'in' => 'query', 'description' => '1 = skip the short server cache', 'schema' => ['type' => 'string', 'enum' => ['1']]],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'period'       => ['type' => 'string', 'enum' => ['today', '7d', '30d']],
                            'timezone'     => ['type' => 'string'],
                            'currency'     => ['type' => 'string', 'example' => 'NGN'],
                            'generated_at' => ['type' => 'string', 'format' => 'date-time'],
                            'range'        => ['type' => 'object', 'properties' => [
                                'from'          => ['type' => 'string', 'format' => 'date-time'],
                                'to'            => ['type' => 'string', 'format' => 'date-time'],
                                'previous_from' => ['type' => 'string', 'format' => 'date-time'],
                                'previous_to'   => ['type' => 'string', 'format' => 'date-time'],
                            ]],
                            'parts'        => ['type' => 'array', 'items' => ['type' => 'string']],
                            'sections'     => ['type' => 'array', 'items' => ['type' => 'string']],
                            'unavailable'  => ['type' => 'array', 'items' => ['type' => 'string']],
                            'kpis'         => ['type' => 'array', 'items' => ['type' => 'object']],
                            'live'         => ['type' => 'object'],
                            'attention'    => ['type' => 'array', 'items' => ['type' => 'object']],
                            'trends'       => ['type' => 'object'],
                            'breakdowns'   => ['type' => 'object'],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/admin/patients' => [
            'get' => ['tags' => ['Staff'], 'summary' => 'Patient roster (paginated, ?search=)', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/admin/patients/{id}' => [
            'get' => ['tags' => ['Staff'], 'summary' => 'A patient record + recent appointments', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/admin/patients/{id}/prescriptions' => [
            'get' => ['tags' => ['Staff'], 'summary' => "A patient's sent prescriptions (monitoring.view)", 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/admin/prescriptions/{rxId}/link' => [
            'post' => ['tags' => ['Staff'], 'summary' => 'Signed short-lived URL to a sent prescription PDF (monitoring.view; audited on open)', 'responses' => ['200' => ['description' => '{url, expires_at, filename}'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/settings/prescriptions' => [
            'get'   => ['tags' => ['Staff'], 'summary' => 'Prescription rules: valid_days, reminder_days, check_max_attempts, check_lock_minutes, link_minutes (settings.manage)', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'patch' => ['tags' => ['Staff'], 'summary' => 'Update prescription rules (settings.manage)', 'responses' => ['200' => ['description' => 'Updated'], '403' => ['$ref' => '#/components/responses/Forbidden'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/settings/booking' => [
            'get'   => ['tags' => ['Staff'], 'summary' => 'Booking rules: calendar (horizon_days, lead_minutes, few_left) and past consultations (missed_after_hours, unconfirmed_expiry_minutes_after_end, noshow_patient_refund_pct, noshow_both_refund_pct, late_cancel_hours, late_cancel_refund_pct, doctor_noshow_alert_threshold) (settings.manage)', 'responses' => ['200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/BookingSettings']))], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => 'Update booking-calendar rules (settings.manage)',
                'description' => 'Partial update. horizon_days 7–180 (how far ahead patients may book; staff and doctors are not held to it), lead_minutes 15–1440 (minimum notice for everyone), few_left 1–10. Whole numbers; out of range → 422.',
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/BookingSettings'])],
                'responses'   => ['200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/BookingSettings']))], '403' => ['$ref' => '#/components/responses/Forbidden'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/admin/support/tickets' => [
            'get' => ['tags' => ['Support'], 'summary' => 'Support ticket queue (?status=)', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/admin/support/tickets/{id}' => [
            'get'   => ['tags' => ['Support'], 'summary' => 'One ticket + its thread', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
            'patch' => ['tags' => ['Support'], 'summary' => 'Change a ticket status', 'responses' => ['200' => ['description' => 'OK'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/admin/support/tickets/{id}/messages' => [
            'post' => ['tags' => ['Support'], 'summary' => 'Post a staff reply', 'responses' => ['201' => ['description' => 'Created'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],

        '/health' => [
            'get' => [
                'tags'      => ['System'],
                'summary'   => 'Liveness probe',
                'security'  => [],
                'responses' => ['200' => ['description' => 'OK', ...$json(['type' => 'object', 'properties' => ['status' => ['type' => 'string', 'example' => 'ok']]])]],
            ],
        ],
        '/health/ready' => [
            'get' => [
                'tags'      => ['System'],
                'summary'   => 'Readiness probe (checks Postgres + Redis)',
                'security'  => [],
                'responses' => [
                    '200' => ['description' => 'Ready', ...$json(['type' => 'object', 'properties' => [
                        'status' => ['type' => 'string', 'example' => 'ready'],
                        'checks' => ['type' => 'object'],
                        'tz'     => ['type' => 'string', 'example' => 'UTC', 'description' => 'The PHP process time zone (naive timestamps are stored in it; the CLI must match — bin/doc-sharing-check.php --expect-tz)'],
                    ]])],
                    '503' => ['description' => 'A dependency is unavailable'],
                ],
            ],
        ],
        '/api/auth/login' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Staff sign-in',
                'operationId' => 'staffLogin',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/Credentials'])],
                'responses'   => [
                    '200' => ['description' => 'Signed in', ...$json($envelope($authData('#/components/schemas/StaffUser')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/login' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Customer (patient) sign-in',
                'description' => 'Also accepts `userName` in place of `email` for the shared frontend client.',
                'operationId' => 'customerLogin',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/Credentials'])],
                'responses'   => [
                    '200' => ['description' => 'Signed in', ...$json($envelope($authData('#/components/schemas/PatientProfile')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/google' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Customer sign-in with a Google (Firebase) ID token',
                'description' => 'Verifies the Firebase ID token, then signs in or provisions the patient by email.',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['id_token'], 'properties' => ['id_token' => ['type' => 'string', 'description' => 'Firebase ID token from the Google provider']]])],
                'responses'   => [
                    '200' => ['description' => 'Signed in', ...$json($envelope($authData('#/components/schemas/PatientProfile')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/email/request-otp' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Email a verification code (register or reset)',
                'description' => 'purpose=register (email must be free) or reset (account must exist). In non-production the response includes dev_code.',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['email'], 'properties' => ['email' => ['type' => 'string', 'format' => 'email'], 'purpose' => ['type' => 'string', 'enum' => ['register', 'reset']]]])],
                'responses'   => [
                    '200' => ['description' => 'Code sent', ...$json($envelope(['type' => 'object', 'properties' => ['sent' => ['type' => 'boolean'], 'dev_code' => ['type' => 'string', 'description' => 'non-production only']]]))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/email/verify-otp' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Verify an emailed code',
                'description' => 'Returns a verification_token consumed by register / reset-password.',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['email', 'otp'], 'properties' => ['email' => ['type' => 'string', 'format' => 'email'], 'otp' => ['type' => 'string'], 'purpose' => ['type' => 'string', 'enum' => ['register', 'reset']]]])],
                'responses'   => [
                    '200' => ['description' => 'Verified', ...$json($envelope(['type' => 'object', 'properties' => ['verified' => ['type' => 'boolean'], 'verification_token' => ['type' => 'string']]]))],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/2fa' => [
            'post' => [
                'tags'     => ['Auth'],
                'summary'  => 'Complete sign-in with a 2FA / recovery code',
                'security' => [],
                'responses' => [
                    '200' => ['description' => 'Signed in'],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/register' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Register a patient after email verification',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['verification_token', 'email', 'first_name', 'password'],
                    'properties' => [
                        'verification_token' => ['type' => 'string'],
                        'email'              => ['type' => 'string', 'format' => 'email'],
                        'first_name'         => ['type' => 'string'],
                        'last_name'          => ['type' => 'string'],
                        'password'           => ['type' => 'string', 'format' => 'password', 'minLength' => 8],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Account created', ...$json($envelope($authData('#/components/schemas/PatientProfile')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/reset-password' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Set a new password after email verification',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['verification_token', 'email', 'new_password'], 'properties' => ['verification_token' => ['type' => 'string'], 'email' => ['type' => 'string', 'format' => 'email'], 'new_password' => ['type' => 'string', 'format' => 'password', 'minLength' => 8]]])],
                'responses'   => [
                    '200' => ['description' => 'Password updated', ...$json($envelope($authData('#/components/schemas/PatientProfile')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/phone/request-otp' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Send an SMS verification code (Termii)',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['phone'], 'properties' => ['phone' => ['type' => 'string', 'example' => '2348060080034']]])],
                'responses'   => [
                    '200' => ['description' => 'Code sent', ...$json($envelope(['type' => 'object', 'properties' => ['pin_id' => ['type' => 'string'], 'to' => ['type' => 'string']]]))],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '502' => ['description' => 'SMS provider error'],
                    '503' => ['description' => 'Phone verification not configured'],
                ],
            ],
        ],
        '/api/portal/auth/phone/verify-otp' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Verify an SMS code (Termii)',
                'description' => 'On success returns a short-lived verification_token consumed by register/login.',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['pin_id', 'otp'], 'properties' => ['pin_id' => ['type' => 'string'], 'otp' => ['type' => 'string'], 'phone' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'Verified', ...$json($envelope(['type' => 'object', 'properties' => ['verified' => ['type' => 'boolean'], 'verification_token' => ['type' => 'string']]]))],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '503' => ['description' => 'Phone verification not configured'],
                ],
            ],
        ],
        '/api/portal/auth/phone/register' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Register a patient after phone verification',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['verification_token', 'email', 'first_name', 'password'],
                    'properties' => [
                        'verification_token' => ['type' => 'string'],
                        'email'              => ['type' => 'string', 'format' => 'email'],
                        'first_name'         => ['type' => 'string'],
                        'last_name'          => ['type' => 'string'],
                        'password'           => ['type' => 'string', 'format' => 'password', 'minLength' => 8],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Account created', ...$json($envelope($authData('#/components/schemas/PatientProfile')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/auth/phone/login' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Sign in with a verified phone number',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['verification_token'], 'properties' => ['verification_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'Signed in', ...$json($envelope($authData('#/components/schemas/PatientProfile')))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/auth/refresh' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Exchange a refresh token for a new access token',
                'description' => 'The refresh token is not rotated; its expiry is the absolute session lifetime. Every 401 means the sign-in is over: '
                    . '`session_expired` (`reason` lifetime: the refresh token expired; idle: no request for SESSION_IDLE_TIMEOUT), `session_revoked` '
                    . '(signed out), `session_invalid` (no such session), `refresh_invalid` (malformed / bad signature / not a refresh token), '
                    . '`account_missing`, `account_deactivated` (the session is revoked too). A 429 (own per-IP bucket, RATE_LIMIT_AUTH_REQUESTS) '
                    . 'is transient: retry after `Retry-After`. A refresh started by a background poll sends `X-SD-Passive: 1`: '
                    . 'the session is still checked but its idle clock is not extended.',
                'operationId' => 'refreshToken',
                'security'    => [],
                'parameters'  => [['name' => 'X-SD-Passive', 'in' => 'header', 'required' => false, 'schema' => ['type' => 'string', 'enum' => ['1']], 'description' => 'Background poll: never extends the session idle clock']],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['refresh_token'], 'properties' => ['refresh_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'New access token', ...$json($envelope(['$ref' => '#/components/schemas/AccessToken']))],
                    '401' => $json(['$ref' => '#/components/schemas/AuthError']) + ['description' => 'The sign-in is over (see the codes above)'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '429' => ['$ref' => '#/components/responses/TooManyRequests'],
                ],
            ],
        ],
        '/api/auth/logout' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Sign out the session a refresh token belongs to (staff or customer)',
                'description' => 'Revokes the server session bound to the refresh token so neither of its tokens works again. Always 200 — unreadable or already-revoked tokens are a no-op.',
                'operationId' => 'logout',
                'security'    => [],
                'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => ['refresh_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'Signed out'],
                ],
            ],
        ],
        '/api/me' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'The signed-in staff user',
                'operationId' => 'staffMe',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/StaffUser']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/me/notifications' => [
            'get' => ['tags' => ['Staff'], 'summary' => "The staff user's notifications (paginated, ?unread)", 'parameters' => [...$paginationParams, ['name' => 'unread', 'in' => 'query', 'schema' => ['type' => 'boolean']]], 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized']]],
        ],
        '/api/me/notifications/unread' => [
            'get' => ['tags' => ['Staff'], 'summary' => 'Unread notification count', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized']]],
        ],
        '/api/me/notifications/read-all' => [
            'post' => ['tags' => ['Staff'], 'summary' => 'Mark all notifications read', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized']]],
        ],
        '/api/me/notifications/{id}/read' => [
            'post' => ['tags' => ['Staff'], 'summary' => 'Mark one notification read', 'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]], 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/me/password' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Change the signed-in staff user's password",
                'description' => 'Requires the current password; the new one must be at least 8 characters. Works for any staff account (admin, doctor, viewer).',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['current_password', 'new_password'], 'properties' => ['current_password' => ['type' => 'string', 'format' => 'password'], 'new_password' => ['type' => 'string', 'format' => 'password', 'minLength' => 8]]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['type' => 'object', 'properties' => ['changed' => ['type' => 'boolean']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/appointments' => [
            'get' => [
                'tags'       => ['Staff'],
                'summary'    => 'List appointments',
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string'], 'description' => 'Comma-separated statuses (e.g. rescheduled, missed)'],
                    ['name' => 'when', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['upcoming', 'past', 'attention']], 'description' => 'By time (see Appointment.phase): upcoming (soonest first), past (newest first), attention — "needs attention": past and still open (pending / confirmed / rescheduled), newest first. With `when` the order is fixed.'],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Appointment'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing appointments.view'],
                ],
            ],
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Book an appointment',
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['patient_id', 'specialist_id'],
                    'properties' => [
                        'patient_id'    => ['type' => 'string', 'format' => 'uuid'],
                        'specialist_id' => ['type' => 'string', 'format' => 'uuid'],
                        'scheduled_at'  => ['type' => 'string', 'format' => 'date-time'],
                        'type'          => ['type' => 'string', 'enum' => ['video', 'follow_up', 'urgent', 'routine']],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Created', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing appointments.create/book'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/patients' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'Search patients (name / email / phone)',
                'description' => 'Staff lookup for booking on a patient\'s behalf. Requires a 2+ char query; returns a slim projection. Needs appointments.create/book.',
                'parameters'  => [
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string'], 'description' => 'Name, email or phone (min 2 chars)'],
                    ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 10]],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => [
                        'type'       => 'object',
                        'properties' => [
                            'id'         => ['type' => 'string', 'format' => 'uuid'],
                            'first_name' => ['type' => 'string'],
                            'last_name'  => ['type' => 'string'],
                            'email'      => ['type' => 'string'],
                            'phone'      => ['type' => 'string', 'nullable' => true],
                        ],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing appointments.create/book'],
                ],
            ],
        ],
        '/api/staff' => [
            'get' => [
                'tags'      => ['Staff'],
                'summary'   => 'List staff accounts',
                'description' => 'The staff directory. Needs staff.manage.',
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/StaffUser']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing staff.manage'],
                ],
            ],
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Create a staff account',
                'description' => 'Needs staff.manage. Only a super_admin may grant the super_admin role. For a doctor login linked to a specialist, `send_invite: true` replaces the temporary password: the doctor is emailed a one-time link (7 days) to choose their own. A linked specialist must exist and not belong to another login.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['email', 'first_name', 'last_name'], 'properties' => [
                    'email' => ['type' => 'string', 'format' => 'email'],
                    'first_name' => ['type' => 'string'],
                    'last_name' => ['type' => 'string'],
                    'password' => ['type' => 'string', 'format' => 'password', 'minLength' => 8, 'description' => 'Required unless send_invite'],
                    'send_invite' => ['type' => 'boolean', 'description' => 'Doctor logins only: email a set-password link instead'],
                    'roles' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'permissions' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'specialist_id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true],
                ]])],
                'responses'   => [
                    '201' => ['description' => 'Created', ...$json($envelope(['$ref' => '#/components/schemas/StaffUser']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing staff.manage / super_admin'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/staff/{id}' => [
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => 'Update a staff account',
                'description' => 'Partial. Only a super_admin may grant super_admin or edit a super_admin; you cannot deactivate yourself. Deactivating a login (`active: false`) signs it out of every session at once.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => [
                    'email' => ['type' => 'string', 'format' => 'email'],
                    'first_name' => ['type' => 'string'],
                    'last_name' => ['type' => 'string'],
                    'roles' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'permissions' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'active' => ['type' => 'boolean'],
                    'specialist_id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/StaffUser']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing staff.manage / super_admin'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/staff/{id}/password' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Reset a staff account's password (admin)",
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['new_password'], 'properties' => ['new_password' => ['type' => 'string', 'format' => 'password', 'minLength' => 8]]])],
                'responses'   => [
                    '200' => ['description' => 'Reset', ...$json($envelope(['type' => 'object', 'properties' => ['changed' => ['type' => 'boolean']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing staff.manage / super_admin'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/appointments/{id}' => [
            'get' => [
                'tags'       => ['Staff'],
                'summary'    => 'One appointment',
                'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/appointments/{id}/status' => [
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => 'Transition an appointment status',
                'description' => 'Enforces the state machine; illegal transitions return 422. Nothing moves into `proposed`, and a proposed follow-up can only be cancelled here (the patient accepting it confirms it). '
                    . 'Cancelling a proposal is a compare-and-set, like the doctor withdrawing it: 422 `errors.status` when the patient accepted it a moment earlier (cancel the confirmed appointment instead), 200 "Follow-up proposal already closed" when it had already closed. '
                    . 'Audited (`appointment.follow_up_withdrawn`, actor role admin); the doctor gets an in-app notice and the patient the usual status email. '
                    . 'Cancelling a booking (or a missed consultation) refunds by default — in full, guest fees included (`refund` full) — or keeps the money with `refund: none` and a `reason` (422 `errors.reason` without), or refunds `amount` (`refund: amount`); closure_reason staff_cancelled; audited `appointment.cancelled_by_staff` {from, refund, refunded, reason}; the patient, the doctor and (while their links still work) the guests are told. The response adds `refunded_now`. '
                    . '`completed` goes through the consultation completer (audit `appointment.completed_by_staff`, the patient\'s notice, earnings; closure_reason staff_completed) — only once its time has come, and also from pending / rescheduled (took place unconfirmed) or missed (held after all). '
                    . '`missed` is refused here (422) — use POST /appointments/{id}/resolve (who didn\'t come). Other moves are audited `appointment.status_changed`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['status'], 'properties' => [
                    'status' => ['type' => 'string', 'enum' => ['pending', 'confirmed', 'rescheduled', 'completed', 'cancelled']],
                    'refund' => ['type' => 'string', 'enum' => ['full', 'none', 'amount'], 'default' => 'full', 'description' => 'status cancelled only'],
                    'amount' => ['type' => 'string', 'example' => '5000.00', 'description' => 'With refund amount: at most what is left to refund'],
                    'reason' => ['type' => 'string', 'minLength' => 3, 'maxLength' => 500, 'description' => 'Required with refund none; kept in the audit trail'],
                    'idempotency_key' => ['type' => 'string', 'pattern' => '^[A-Za-z0-9_-]{8,64}$', 'description' => 'Makes an amount refund safe to retry'],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/appointments/{id}/resolve' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Settle a missed or stale consultation (appointments.update)',
                'description' => 'For "needs attention" rows (past and still open) and missed ones; audited with the staff member and `reason` (required, 3–500 characters). '
                    . '`action` held: mark it held → completed through the consultation completer (patient notice, earnings; closure_reason staff_completed; no_show cleared; audit `appointment.completed_by_staff`) — once its time has come; `refund` none (default) | full | amount. '
                    . 'no_show: a past open booking → missed, or change who didn\'t come to a missed one (`no_show` doctor | patient | both; closure_reason no_show; audit `appointment.no_show_set`); `refund` policy (default: the no-show rules for that party, topping up what already went back, never taking any back) | full | none | amount; both sides are told, and a doctor no-show counts towards the repeated no-show alert. '
                    . 'cancel: an open booking or a missed one → cancelled (closure_reason staff_cancelled; audit `appointment.cancelled_by_staff`); `refund` full (default, guest fees included) | none | amount. '
                    . 'refund: give back more of a closed one (completed / missed / cancelled); `refund` full (default: all that is left) | amount (audit `appointment.refunded_by_staff`). '
                    . '`amount` is never more than is left to refund (422 `errors.amount`); send `idempotency_key` (8–64 of A–Z a–z 0–9 _ -) so a retry or double submit of an amount refund posts once (`full` / `policy` only ever top up, so repeating them refunds nothing more). Answers the appointment (admin shape) plus `refunded_now`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['action', 'reason'], 'properties' => [
                    'action'  => ['type' => 'string', 'enum' => ['held', 'no_show', 'cancel', 'refund']],
                    'no_show' => ['type' => 'string', 'enum' => ['doctor', 'patient', 'both'], 'description' => 'action no_show'],
                    'refund'  => ['type' => 'string', 'enum' => ['policy', 'full', 'none', 'amount']],
                    'amount'  => ['type' => 'string', 'example' => '5000.00'],
                    'reason'  => ['type' => 'string', 'minLength' => 3, 'maxLength' => 500],
                    'idempotency_key' => ['type' => 'string', 'pattern' => '^[A-Za-z0-9_-]{8,64}$', 'description' => 'Makes an amount refund safe to retry'],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Settled', ...$json($envelope(['allOf' => [
                        ['$ref' => '#/components/schemas/Appointment'],
                        ['type' => 'object', 'properties' => ['refunded_now' => ['type' => 'string', 'example' => '15000.00']]],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing appointments.update'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/profile' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "The signed-in doctor's own profile",
                'description' => 'Doctor self-service — the linked specialist profile, including the contact email, plus `locked_fields` (the identity fields that change only through a review once approved; [] while onboarding), `pending_changes` ({field: requested value} waiting for review, or null), `pending_changes_submitted_at` and `changes_review_note` (why the last request was turned down).',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Specialist']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                ],
            ],
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => "Update the signed-in doctor's own profile",
                'description' => 'Doctor self-service: name, specialty, email, phone, date_of_birth, country, photo_url, location, languages, years_experience, gender, expertise, qualifications, mdcn_number, qualification_entries, certifications, slot_minutes, bio, offers_in_person, available, weekly_hours. Fee and verified stay back-office controlled. '
                    . 'Once the doctor is approved (or suspended), the locked identity fields — name, specialty, mdcn_number, qualifications, qualification_entries, certifications — do not change here: a differing value is staged in `pending_changes` for a reviewer (reviewers are notified; audited `specialist.changes_submitted`) and the message says so; a value equal to the current one takes back an earlier request for that field. Everything else saves at once. '
                    . '`specialty` must be an active item of GET /public/reference/specialty (any case; saved in the list\'s spelling) or the doctor\'s current / already-requested specialty (kept even if the list has since switched it off) — else 422 "Choose a specialty from the list". '
                    . 'A suspended doctor may not change their availability: a body with weekly_hours, slot_minutes or available is refused with 403 (`errors.code` doctor_suspended).',
                'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => [
                    'name' => ['type' => 'string'],
                    'specialty' => ['type' => 'string'],
                    'email' => ['type' => 'string', 'format' => 'email'],
                    'phone' => ['type' => 'string'],
                    'date_of_birth' => ['type' => 'string', 'format' => 'date'],
                    'country' => ['type' => 'string'],
                    'photo_url' => ['type' => 'string', 'description' => 'Empty clears the photo; the current value unchanged is a no-op; anything else (a link, another path) is a 422 — upload with POST /api/doctor/avatar'],
                    'location' => ['type' => 'string'],
                    'languages' => ['type' => 'string'],
                    'years_experience' => ['type' => 'integer'],
                    'gender' => ['type' => 'string', 'enum' => ['male', 'female']],
                    'expertise' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'qualification_entries' => ['type' => 'array', 'items' => ['type' => 'object']],
                    'certifications' => ['type' => 'array', 'items' => ['type' => 'object']],
                    'slot_minutes' => ['type' => 'integer', 'enum' => [15, 30, 45, 60]],
                    'bio' => ['type' => 'string'],
                    'qualifications' => ['type' => 'string'],
                    'mdcn_number' => ['type' => 'string'],
                    'offers_in_person' => ['type' => 'boolean'],
                    'available' => ['type' => 'boolean'],
                    'weekly_hours' => ['type' => 'object'],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/Specialist']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/avatar' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Upload the signed-in doctor's headshot",
                'description' => 'Multipart form-data, field `avatar` (JPG/PNG/WEBP/GIF, ≤2MB). Returns the updated profile.',
                'requestBody' => ['required' => true, 'content' => ['multipart/form-data' => ['schema' => [
                    'type' => 'object', 'properties' => ['avatar' => ['type' => 'string', 'format' => 'binary']], 'required' => ['avatar'],
                ]]]],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/Specialist']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
            'delete' => [
                'tags'        => ['Staff'],
                'summary'     => "Remove the signed-in doctor's headshot",
                'responses'   => [
                    '200' => ['description' => 'Removed', ...$json($envelope(['$ref' => '#/components/schemas/Specialist']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                ],
            ],
        ],
        '/api/doctor/availability' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "The doctor's date-specific availability slots",
                'description' => 'Open/booked/blocked slots across [from, to] (YYYY-MM-DD query params; defaults to a 36-day window). "booked" is derived from live appointments.',
                'parameters'  => [
                    ['name' => 'from', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'to', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type' => 'object',
                        'properties' => [
                            'from' => ['type' => 'string', 'format' => 'date'],
                            'to' => ['type' => 'string', 'format' => 'date'],
                            'slot_minutes' => ['type' => 'integer'],
                            'slots' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                                'id' => ['type' => 'string'],
                                'starts_at' => ['type' => 'string', 'format' => 'date-time'],
                                'ends_at' => ['type' => 'string', 'format' => 'date-time'],
                                'kind' => ['type' => 'string', 'enum' => ['open', 'block']],
                                'status' => ['type' => 'string', 'enum' => ['open', 'booked', 'blocked']],
                                'reason' => ['type' => 'string', 'nullable' => true],
                                'patient_name' => ['type' => 'string'],
                            ]]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                ],
            ],
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Publish open availability slots for a date',
                'description' => 'Splits [start, end) into `duration`-minute slots; `recurring` repeats weekly for `weeks` weeks. Existing slots at the same start are skipped. A past date, a start that has already passed (UTC), or a range too short for one slot is a 422.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'properties' => [
                    'date' => ['type' => 'string', 'format' => 'date'],
                    'start' => ['type' => 'string', 'example' => '09:00'],
                    'end' => ['type' => 'string', 'example' => '12:00'],
                    'duration' => ['type' => 'integer', 'enum' => [15, 30, 45, 60]],
                    'recurring' => ['type' => 'boolean'],
                    'weeks' => ['type' => 'integer'],
                ], 'required' => ['date', 'start', 'end', 'duration']])],
                'responses'   => [
                    '200' => ['description' => 'Created', ...$json($envelope(['type' => 'object']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/availability/block' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Block a date (or a span within it)',
                'description' => '`entire_day` blocks the whole day; otherwise blocks [start, end). Blocks subtract from generated availability. A past date, or a specific span starting before now (UTC), is a 422.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'properties' => [
                    'date' => ['type' => 'string', 'format' => 'date'],
                    'entire_day' => ['type' => 'boolean'],
                    'start' => ['type' => 'string', 'example' => '09:00'],
                    'end' => ['type' => 'string', 'example' => '12:00'],
                    'reason' => ['type' => 'string'],
                ], 'required' => ['date']])],
                'responses'   => [
                    '200' => ['description' => 'Blocked', ...$json($envelope(['type' => 'object']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/availability/{id}' => [
            'delete' => [
                'tags'        => ['Staff'],
                'summary'     => 'Remove an availability slot or block',
                'description' => 'Deletes one of the doctor\'s own slots. An open slot with a booking on it is refused (409).',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'responses'   => [
                    '200' => ['description' => 'Removed', ...$json($envelope(['type' => 'object']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => ['description' => 'Slot not found'],
                    '409' => ['description' => 'Slot is booked'],
                ],
            ],
        ],
        '/api/doctor/calendar' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => "The doctor's own booking calendar (reschedule / follow-up picker)",
                'description' => 'AvailabilityRange for the signed-in doctor, same statuses as /api/public/specialists/{id}/availability, but not held to the patient horizon: the window (bookable_until, horizon_days) reaches 365 days ahead, and times still show while the doctor is switched off for bookings. from … to: at most 42 days, starting between 42 days before today and bookable_until. Clinical: 403 doctor_suspended / doctor_not_approved while the doctor may not practise.',
                'parameters'  => [
                    ['name' => 'from', 'in' => 'query', 'description' => 'Default today (in tz)', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'to', 'in' => 'query', 'description' => 'Default from + 41 days', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'tz', 'in' => 'query', 'description' => 'IANA zone (an unknown one falls back to the clinic zone — use the response tz)', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/AvailabilityRange']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/calendar/slots' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => "The doctor's own open times on one date",
                'description' => 'DaySlots {date, tz, slots: [{iso, time, label, period}]} for the signed-in doctor — the times their reschedule and follow-up proposals may use (a follow-up must still be at least 2½ hours away). Not held to the patient horizon (empty after 365 days or before today).',
                'parameters'  => [
                    ['name' => 'date', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'tz', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/DaySlots']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "A doctor's own consultations (minimal doctor portal)",
                'parameters'  => [
                    ['name' => 'when', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['upcoming', 'past', 'attention']], 'description' => 'Split by time instead (100 rows): upcoming (still to come or live, soonest first — the Pending / Upcoming tabs), past (over, newest first), attention (past and still open, newest first)'],
                ],
                'description' => 'Staff token from a doctor login (role doctor). The schedule, soonest first: the next 100 from a day ago on (all of today and what\'s coming), then, if there is room, the most recent earlier ones — GET /doctor/appointments/{id} loads any one, /doctor/appointments/history pages through the rest. Rows carry the doctor-worded lifecycle fields (phase, display_*, can_confirm, can_reschedule). Each row includes a preauthenticated join_url — null on a follow-up proposal (status proposed) the patient hasn\'t accepted yet, and null with `join_blocked` {code, message} on every row while the doctor may not start clinical work (code terms_required: accept the practitioner terms first — terms_required only blocks a consultation whose start time is still ahead; one already under way keeps its join_url). 403 (`errors.code`) for a suspended / not-approved doctor.',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'specialist'   => ['$ref' => '#/components/schemas/Specialist'],
                            'appointments' => [
                                'type'  => 'array',
                                'items' => [
                                    'allOf' => [
                                        ['$ref' => '#/components/schemas/Appointment'],
                                        ['type' => 'object', 'properties' => [
                                            'patient_name' => ['type' => 'string'],
                                            'join_url'     => ['type' => 'string', 'nullable' => true, 'description' => 'null while the row is an unaccepted follow-up proposal, or while join_blocked is set'],
                                            'join_blocked' => ['type' => 'object', 'nullable' => true, 'properties' => ['code' => ['type' => 'string', 'example' => 'terms_required'], 'message' => ['type' => 'string']]],
                                        ]],
                                    ],
                                ],
                            ],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Not a doctor login, or the doctor is suspended / not approved (`errors.code`)'],
                ],
            ],
        ],
        '/api/doctor/dashboard' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "Doctor dashboard metrics + today's agenda",
                'description' => 'Counts, deltas, earnings this month, rating, and `next` + `agenda` (today\'s consultations): each the same row as GET /doctor/appointments — `patient_name`, a preauthenticated `join_url`, and `join_blocked` {code, message} (with join_url null) while the doctor may not start clinical work (doctor_not_approved while onboarding, terms_required — terms_required only blocks a consultation whose start time is still ahead; one already under way keeps its join_url). 403 (`errors.code` doctor_suspended) for a suspended doctor.',
                'responses'   => [
                    '200' => ['description' => 'OK'],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                ],
            ],
        ],
        '/api/doctor/appointments/history' => [
            'get' => [
                'tags'       => ['Staff'],
                'summary'    => "A doctor's appointment history (paginated)",
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string'], 'description' => 'Comma-separated statuses (e.g. missed)'],
                    ['name' => 'when', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['past', 'upcoming', 'attention', 'all'], 'default' => 'past'], 'description' => 'past (default: over — closed, or ended over 30 min ago with nobody in the call; newest first), upcoming (soonest first), attention (past and still open), all (everything, newest first)'],
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string'], 'description' => 'Patient name or email'],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Appointment'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "One of the doctor's own consultations",
                'description' => 'The same row GET /doctor/appointments lists, whatever its date (the record page and the links in notices load it by id): the Appointment plus `patient_name` and a preauthenticated `join_url` — null on a follow-up proposal (status proposed) the patient hasn\'t accepted yet, and null with `join_blocked` {code, message} while the doctor may not start clinical work (code terms_required: accept the practitioner terms first — terms_required only blocks a consultation whose start time is still ahead; one already under way keeps its join_url). 403 when it is not this doctor\'s consultation (or does not exist), or the doctor is suspended / not approved (`errors.code`).',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/Appointment'],
                            ['type' => 'object', 'properties' => [
                                'patient_name' => ['type' => 'string'],
                                'join_url'     => ['type' => 'string', 'nullable' => true, 'description' => 'null while it is an unaccepted follow-up proposal, or while join_blocked is set'],
                                'join_blocked' => ['type' => 'object', 'nullable' => true, 'properties' => ['code' => ['type' => 'string', 'example' => 'terms_required'], 'message' => ['type' => 'string']]],
                            ]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Not a doctor login, or not this doctor\'s consultation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/decline' => [
            'post' => [
                'tags'       => ['Staff'],
                'summary'     => 'Decline a booking (assigned doctor); refunds if paid',
                'description' => 'Each guest is emailed that the consultation was cancelled (their links stop working). On the doctor\'s own unanswered follow-up proposal it withdraws it instead, like POST .../follow-up/withdraw (message "Follow-up withdrawn"). A confirmed booking only before its start (422 `errors.status` "This consultation has started, so it can no longer be cancelled — it closes as completed or missed"); a pending / rescheduled one until 30 minutes after its slot ended (422 `errors.status` "This consultation has ended, so it can no longer be declined"; the cron expires it). The payload\'s `can_decline` says whether it is allowed now. Runs under the row lock, so it never cancels or refunds over the cron closing it. Optional `reason`: a message to the patient (trimmed, ≤ 500 chars, else 422 `errors.reason`), included in their email — not stored, and never in the in-app notice.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => ['reason' => ['type' => 'string', 'maxLength' => 500, 'description' => 'Optional message to the patient, shown in their email']]])],
                'responses'  => [
                    '200' => ['description' => 'Declined', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/reschedule' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Reschedule a booking (assigned doctor)',
                'description' => 'The new time must be one of the doctor\'s open slots under the patient booking rules (1h lead, on the schedule, not blocked or booked); otherwise 422. The moved booking is CONFIRMED at once (rescheduled_by doctor): the patient is told and may still move or cancel it (in full) before it starts. Any open booking (pending, confirmed, rescheduled); 422 `errors.status` once it ended over 30 minutes ago, and on a follow-up proposal — withdraw it and propose the new time. Each guest is emailed the new time with their link.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['scheduled_at'], 'properties' => ['scheduled_at' => ['type' => 'string', 'format' => 'date-time']]])],
                'responses'   => [
                    '200' => ['description' => 'Rescheduled', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/patients' => [
            'get' => [
                'tags'       => ['Staff'],
                'summary'    => "The doctor's own patients (paginated)",
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']],
                ],
                'responses'  => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']],
            ],
        ],
        '/api/doctor/patients/{id}' => [
            'get' => [
                'tags'       => ['Staff'],
                'summary'    => "A patient's record (doctor must have seen them)",
                'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'  => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/doctor/reviews' => [
            'get' => ['tags' => ['Staff'], 'summary' => "The doctor's reviews (paginated)", 'parameters' => [...$paginationParams], 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/reviews/summary' => [
            'get' => ['tags' => ['Staff'], 'summary' => 'Rating average, count and distribution', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/reviews/{id}/respond' => [
            'post' => ['tags' => ['Staff'], 'summary' => 'Respond to a review', 'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]], 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/doctor/earnings' => [
            'get' => ['tags' => ['Staff'], 'summary' => "Doctor earnings summary + available balance", 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/earnings/transactions' => [
            'get' => ['tags' => ['Staff'], 'summary' => 'Earnings lines per earning consultation (paginated)', 'description' => '{appointment_id, patient_name, date, status, no_show, gross, commission, net} per line — completed consultations and missed ones the patient didn\'t come to; gross is the amount less any refund. While the doctor is suspended `patient_name` is "Patient" (no patient data).', 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
        ],
        '/api/doctor/payout-account' => [
            'get' => ['tags' => ['Staff'], 'summary' => "The doctor's payout beneficiary", 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'put' => ['tags' => ['Staff'], 'summary' => 'Save the payout beneficiary', 'responses' => ['200' => ['description' => 'Saved'], '403' => ['$ref' => '#/components/responses/Forbidden'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/doctor/payouts' => [
            'get'  => ['tags' => ['Staff'], 'summary' => "The doctor's payout requests", 'responses' => ['200' => ['description' => 'OK'], '403' => ['$ref' => '#/components/responses/Forbidden']]],
            'post' => ['tags' => ['Staff'], 'summary' => 'Request a payout of available earnings', 'description' => 'A suspended or not-yet-approved doctor is refused: 403 with `errors.code` doctor_suspended | doctor_not_approved (they can still see earnings and payout history).', 'responses' => ['201' => ['description' => 'Requested'], '403' => ['$ref' => '#/components/responses/Forbidden'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/admin/payouts' => [
            'get' => ['tags' => ['Monitoring'], 'summary' => 'All payout requests (paginated, ?status)', 'responses' => ['200' => ['description' => 'OK'], '403' => ['description' => 'Missing payouts.manage']]],
        ],
        '/api/admin/payouts/{id}/approve' => [
            'post' => ['tags' => ['Monitoring'], 'summary' => 'Approve a payout', 'responses' => ['200' => ['description' => 'Approved'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/admin/payouts/{id}/mark-paid' => [
            'post' => ['tags' => ['Monitoring'], 'summary' => 'Mark a payout paid', 'responses' => ['200' => ['description' => 'Paid'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/admin/payouts/{id}/reject' => [
            'post' => ['tags' => ['Monitoring'], 'summary' => 'Reject a payout', 'responses' => ['200' => ['description' => 'Rejected'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/portal/me' => [
            'get' => [
                'tags'      => ['Portal'],
                'summary'   => "The signed-in patient's profile",
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
            'patch' => [
                'tags'        => ['Portal'],
                'summary'     => 'Update the profile',
                'description' => 'Only the fields present are changed. Changing the phone clears phone_verified.',
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'properties' => [
                        'first_name'    => ['type' => 'string'],
                        'last_name'     => ['type' => 'string'],
                        'phone'         => ['type' => 'string', 'nullable' => true],
                        'date_of_birth' => ['type' => 'string', 'format' => 'date', 'nullable' => true],
                        'gender'        => ['type' => 'string'],
                        'address'       => ['type' => 'string'],
                    ],
                ])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/settings' => [
            'get' => [
                'tags'      => ['Portal'],
                'summary'   => "The signed-in patient's preferences",
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/PatientSettings']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
            'patch' => [
                'tags'        => ['Portal'],
                'summary'     => 'Update preferences',
                'description' => 'Accepts a partial map; only known keys are applied. Returns the full settings.',
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/PatientSettings'])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/PatientSettings']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/password' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Change the password',
                'description' => 'Requires the current password; the new one must be at least 8 characters.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['current_password', 'new_password'], 'properties' => ['current_password' => ['type' => 'string', 'format' => 'password'], 'new_password' => ['type' => 'string', 'format' => 'password', 'minLength' => 8]]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['type' => 'object', 'properties' => ['changed' => ['type' => 'boolean']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/avatar' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Upload a profile photo',
                'description' => 'multipart/form-data with an `avatar` image field (JPG/PNG/WEBP/GIF, <= 2MB).',
                'requestBody' => [
                    'required' => true,
                    'content'  => [
                        'multipart/form-data' => [
                            'schema' => [
                                'type'       => 'object',
                                'required'   => ['avatar'],
                                'properties' => ['avatar' => ['type' => 'string', 'format' => 'binary']],
                            ],
                        ],
                    ],
                ],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
            'delete' => [
                'tags'      => ['Portal'],
                'summary'   => 'Remove the profile photo',
                'responses' => [
                    '200' => ['description' => 'Removed', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/portal/me/sessions' => [
            'get' => [
                'tags'      => ['Portal'],
                'summary'   => "The signed-in patient's active sessions",
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/Session']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/portal/me/sessions/{id}' => [
            'delete' => [
                'tags'       => ['Portal'],
                'summary'    => 'Sign out of a session (device)',
                'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'responses'  => [
                    '200' => ['description' => 'Revoked', ...$json($envelope(['type' => 'object', 'properties' => ['revoked' => ['type' => 'boolean']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/portal/me/health-profile' => [
            'get' => [
                'tags'      => ['Portal'],
                'summary'   => "The signed-in patient's health profile",
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/HealthProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
            'patch' => [
                'tags'        => ['Portal'],
                'summary'     => 'Save health-profile sections',
                'description' => 'Send any of emergency_contact / insurance / medical; each present section replaces the stored one.',
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/HealthProfile'])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/HealthProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/vitals' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "The signed-in patient's latest health readings",
                'description' => 'latest: newest reading of each type {key, label, value, unit, taken_at, source, source_label, recorded_by: patient|doctor, stale (older than 7 days), '
                    . 'flag} — flag is where the reading sits against typical adult resting ranges, worked out on the server: {level: normal|low|elevated|high|critical, '
                    . 'label: Normal|Low|Elevated|High|Very high|Very low (pain: None|Mild|Moderate|Severe), advice: null|"Seek medical attention" (high)|"Seek urgent medical attention" (critical)}; '
                    . 'weight is judged by the BMI it gives with the latest height (no height, no flag); BMI is flagged only with a height on file and while it is no older than the latest weight and height (so it never contradicts the weight); '
                    . 'BMI/weight and pain never carry advice, height has no flag (null). '
                    . 'fields: the reading catalogue {key, label, unit, min, max, step, normal_range} (blood_pressure adds systolic/diastolic bounds, bmi is derived); '
                    . 'sources / patient_sources; reminder {due, reason, last_taken_at, days_old, stale_after_days, appointment} where reason is, most pressing first, '
                    . 'never (no readings yet), upcoming (a pending/confirmed/rescheduled consultation starts within 48 hours and nothing was taken in the 48 hours before it — '
                    . 'appointment {id, scheduled_at} names the soonest such one) or stale (newest reading older than 7 days); appointment is null unless reason is upcoming.',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'object', 'properties' => [
                        'latest'          => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                            'key'   => ['type' => 'string', 'example' => 'temperature'],
                            'value' => ['type' => 'string', 'example' => '38.6'],
                            'unit'  => ['type' => 'string', 'example' => '°C'],
                            'stale' => ['type' => 'boolean'],
                            'flag'  => ['type' => 'object', 'nullable' => true, 'properties' => [
                                'level'  => ['type' => 'string', 'enum' => ['normal', 'low', 'elevated', 'high', 'critical']],
                                'label'  => ['type' => 'string', 'example' => 'High'],
                                'advice' => ['type' => 'string', 'enum' => ['Seek medical attention', 'Seek urgent medical attention'], 'nullable' => true],
                            ]],
                        ]]],
                        'fields'          => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                            'key'          => ['type' => 'string'],
                            'normal_range' => ['type' => 'string', 'nullable' => true, 'example' => '36.0–37.5'],
                        ]]],
                        'sources'         => ['type' => 'object', 'additionalProperties' => ['type' => 'string']],
                        'patient_sources' => ['type' => 'array', 'items' => ['type' => 'string']],
                        'reminder'        => ['type' => 'object', 'properties' => [
                            'due'              => ['type' => 'boolean'],
                            'reason'           => ['type' => 'string', 'enum' => ['never', 'upcoming', 'stale'], 'nullable' => true],
                            'last_taken_at'    => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                            'days_old'         => ['type' => 'integer', 'nullable' => true],
                            'stale_after_days' => ['type' => 'integer', 'example' => 7],
                            'appointment'      => ['type' => 'object', 'nullable' => true, 'properties' => [
                                'id'           => ['type' => 'string', 'format' => 'uuid'],
                                'scheduled_at' => ['type' => 'string', 'format' => 'date-time'],
                            ]],
                        ]],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Add my own health readings (self-reported)',
                'description' => 'Same rules as the prescription form: each reading within its range, blood_pressure as systolic/diastolic (e.g. 120/80), BMI worked out from weight and height '
                    . '(a weight or height given on its own uses the other one on file). taken_at defaults to now and may not be in the future or more than a year ago. Readings are append-only and always recorded as the patient\'s. Returns the same body as GET.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['readings'], 'properties' => [
                    'readings' => ['type' => 'object', 'additionalProperties' => ['type' => 'string'], 'example' => ['blood_pressure' => '120/80', 'weight' => '72.5']],
                    'taken_at' => ['type' => 'string', 'format' => 'date-time'],
                    'source'   => ['type' => 'string', 'enum' => ['self_reported', 'patient_device'], 'default' => 'self_reported'],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Saved'],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/vitals/history' => [
            'get' => [
                'tags'       => ['Portal'],
                'summary'    => 'My health-reading history, newest first',
                'parameters' => [
                    ['name' => 'key', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'blood_pressure']],
                    ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 50, 'maximum' => 200]],
                ],
                'responses'  => [
                    '200' => ['description' => '[{id, key, label, value, unit, taken_at, source, source_label, recorded_by, stale, flag, created_at}] — flag as on GET /api/portal/me/vitals (weight judged with the latest height; a BMI row only with a height on file)'],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/verify-phone' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => "Confirm the signed-in patient's phone number",
                'description' => 'Consumes a verification_token from verify-otp and marks the number verified. An expired or invalid proof is a 422 '
                    . '(`errors.verification_token` + `errors.code` phone_proof_expired), not a 401: the sign-in itself is fine.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['verification_token'], 'properties' => ['verification_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'Verified', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/email/request-otp' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Start changing the account email',
                'description' => 'Emails a verification code to the requested new address (which must be well-formed, not the current one, and not already in use). In non-production the response includes dev_code.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['email'], 'properties' => ['email' => ['type' => 'string', 'format' => 'email']]])],
                'responses'   => [
                    '200' => ['description' => 'Code sent', ...$json($envelope(['type' => 'object', 'properties' => ['sent' => ['type' => 'boolean'], 'dev_code' => ['type' => 'string']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/me/email' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Confirm and change the account email',
                'description' => 'Verifies the code sent to the new address, swaps the email, and notifies the previous address. Returns the updated profile.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['email', 'otp'], 'properties' => ['email' => ['type' => 'string', 'format' => 'email'], 'otp' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/support/tickets' => [
            'get'  => ['tags' => ['Portal'], 'summary' => 'My support tickets', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized']]],
            'post' => ['tags' => ['Portal'], 'summary' => 'Open a support ticket', 'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['subject', 'message'], 'properties' => ['subject' => ['type' => 'string'], 'category' => ['type' => 'string'], 'message' => ['type' => 'string']]])], 'responses' => ['201' => ['description' => 'Created'], '422' => ['$ref' => '#/components/responses/Validation']]],
        ],
        '/api/portal/support/tickets/{id}' => [
            'get' => ['tags' => ['Portal'], 'summary' => 'One of my tickets + its thread', 'responses' => ['200' => ['description' => 'OK'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/support/tickets/{id}/messages' => [
            'post' => ['tags' => ['Portal'], 'summary' => 'Reply to my ticket', 'responses' => ['201' => ['description' => 'Created'], '404' => ['$ref' => '#/components/responses/NotFound']]],
        ],
        '/api/portal/me/2fa/setup' => [
            'post' => [
                'tags'      => ['Portal'],
                'summary'   => 'Begin enabling 2FA (returns secret + otpauth URI)',
                'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '409' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/portal/me/2fa/enable' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Confirm + activate 2FA, returns one-time recovery codes',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['code'], 'properties' => ['code' => ['type' => 'string']]])],
                'responses'   => ['200' => ['description' => 'Enabled'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/portal/me/2fa/disable' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Disable 2FA (requires the account password)',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['password'], 'properties' => ['password' => ['type' => 'string']]])],
                'responses'   => ['200' => ['description' => 'Disabled'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/portal/specialists' => [
            'get' => [
                'tags'       => ['Portal'],
                'summary'    => 'Specialist directory',
                'description' => 'Only approved (or legacy) doctors who are available for booking are listed. Every doctor carries `availability` (SpecialistAvailability). With a "when" filter (available_on, available_within, or part_of_day alone = within the booking window) doctors without a matching opening are dropped before paging (up to 500 candidates), so meta.total is exact; the default order is then soonest (first opening, weighted rating, name). Dates are calendar days in `tz` within today … today + horizon_days.',
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'search', 'in' => 'query', 'description' => 'Matches name or specialty', 'schema' => ['type' => 'string']],
                    ['name' => 'specialty', 'in' => 'query', 'description' => 'Exact specialty filter', 'schema' => ['type' => 'string']],
                    ['name' => 'available', 'in' => 'query', 'description' => 'Accepted for compatibility; unavailable doctors are never listed', 'schema' => ['type' => 'boolean']],
                    ['name' => 'location', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'language', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'gender', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['male', 'female']]],
                    ['name' => 'mode', 'in' => 'query', 'description' => 'in_person to require in-person visits', 'schema' => ['type' => 'string', 'enum' => ['online', 'in_person']]],
                    ['name' => 'fee_max', 'in' => 'query', 'description' => 'Consultation fee ceiling', 'schema' => ['type' => 'number', 'minimum' => 0]],
                    ['name' => 'min_rating', 'in' => 'query', 'schema' => ['type' => 'number', 'minimum' => 0, 'maximum' => 5]],
                    ['name' => 'min_years', 'in' => 'query', 'description' => 'Minimum years in practice', 'schema' => ['type' => 'integer', 'minimum' => 0]],
                    ['name' => 'available_on', 'in' => 'query', 'description' => 'Free on this date (YYYY-MM-DD in tz); not with available_within', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'available_within', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['today', 'tomorrow', 'week']]],
                    ['name' => 'part_of_day', 'in' => 'query', 'description' => 'Local morning 05–12, afternoon 12–17, evening 17–05', 'schema' => ['type' => 'string', 'enum' => ['morning', 'afternoon', 'evening', 'any']]],
                    ['name' => 'tz', 'in' => 'query', 'description' => 'IANA zone of the patient (default: the clinic zone)', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK (sort_by also accepts soonest)', ...$json($paginated('#/components/schemas/Specialist'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/public/specialties' => [
            'get' => [
                'tags'      => ['Public'],
                'summary'   => 'Specialties with specialist counts (homepage)',
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'count' => ['type' => 'integer']]]]))],
                ],
            ],
        ],
        // ----- Reference data (back-office pick lists; first list: specialty) -----
        '/api/public/reference/{category}' => [
            'get' => [
                'tags'        => ['Public'],
                'summary'     => "A pick list's active items in list order (e.g. specialty)",
                'description' => 'Public, cacheable for 60 s (`Cache-Control: public, max-age=60`). Lists: `specialty`. Each item: id, code, label, sort_order. A doctor\'s specialty is stored as the item\'s `label`.',
                'security'    => [],
                'parameters'  => [['name' => 'category', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['specialty']]]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/PublicReferenceItem']]))],
                    '404' => ['description' => 'Unknown list', ...$json(['$ref' => '#/components/schemas/Error'])],
                ],
            ],
        ],
        '/api/reference/{category}' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'Every item of a pick list, active or not, with usage counts (settings.manage or specialists.manage)',
                'description' => '`usage_count`: how many doctors (not deleted) have the item\'s label as their specialty, case and spacing aside.',
                'parameters'  => [['name' => 'category', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['specialty']]]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/ReferenceItem']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Add an item to a pick list (settings.manage; audited reference.created)',
                'description' => '`label` required (≤ 120 characters, not already on the list in any case or spacing); `code` optional (lower-case slug, made from the label when absent; unique in the list, never changes); `sort_order` optional (default: after the last item); `active` optional (default true). 422 per field.',
                'parameters'  => [['name' => 'category', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['specialty']]]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['label'], 'properties' => [
                    'label'      => ['type' => 'string', 'maxLength' => 120, 'example' => 'Cardiology'],
                    'code'       => ['type' => 'string', 'maxLength' => 80, 'example' => 'cardiology'],
                    'sort_order' => ['type' => 'integer', 'minimum' => 0],
                    'active'     => ['type' => 'boolean', 'default' => true],
                ]])],
                'responses'   => [
                    '201' => ['description' => 'Added', ...$json($envelope(['$ref' => '#/components/schemas/ReferenceItem']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/reference/{category}/reorder' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Put a pick list in a new order (settings.manage; audited reference.reordered)',
                'description' => '`ids`: the list\'s item ids in the order wanted; items left out follow in their current order. Sort orders become 10, 20, 30… Returns the whole list. 422 when ids is missing or empty, repeats an id, or names an item that is not in this list.',
                'parameters'  => [['name' => 'category', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['specialty']]]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['ids'], 'properties' => [
                    'ids' => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid']],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Saved', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/ReferenceItem']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/reference/{category}/{id}' => [
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => 'Rename, reorder or switch an item on/off (settings.manage; audited reference.updated)',
                'description' => 'Only the keys sent change. Renaming a specialty gives every doctor who has the old label (any case or spacing) — and any change request waiting for review that asks for it — the new label in the same transaction, each audited on the doctor (`specialist.updated`); `specialists_updated` says how many doctors changed. Switching an item off (`active: false`) removes it from the public list but leaves it on the doctors who have it. 422 per field (blank / too long / duplicate label, bad sort_order or active).',
                'parameters'  => [
                    ['name' => 'category', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['specialty']]],
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'properties' => [
                    'label'      => ['type' => 'string', 'maxLength' => 120],
                    'sort_order' => ['type' => 'integer', 'minimum' => 0],
                    'active'     => ['type' => 'boolean'],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Saved', ...$json($envelope(['allOf' => [
                        ['$ref' => '#/components/schemas/ReferenceItem'],
                        ['type' => 'object', 'properties' => ['specialists_updated' => ['type' => 'integer', 'description' => 'Doctors re-labelled by a rename']]],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
            'delete' => [
                'tags'        => ['Staff'],
                'summary'     => 'Delete an unused item (settings.manage; audited reference.deleted)',
                'description' => 'An item in use is refused with 422 "In use by N doctors — deactivate it instead" (also `errors.item`); one that change requests waiting for review ask for, with 422 "Requested by N doctors — deactivate it instead".',
                'parameters'  => [
                    ['name' => 'category', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['specialty']]],
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'   => [
                    '200' => ['description' => 'Deleted', ...$json($envelope(['type' => 'object', 'properties' => ['id' => ['type' => 'string', 'format' => 'uuid']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['description' => 'In use', ...$json(['$ref' => '#/components/schemas/Error'])],
                ],
            ],
        ],
        '/api/public/facets' => [
            'get' => [
                'tags'      => ['Public'],
                'summary'   => 'Filter options: specialties (with counts), locations, languages, genders, fee range',
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'specialties' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'count' => ['type' => 'integer']]]],
                            'locations'   => ['type' => 'array', 'items' => ['type' => 'string']],
                            'languages'   => ['type' => 'array', 'items' => ['type' => 'string']],
                            'genders'     => ['type' => 'array', 'items' => ['type' => 'string']],
                            'fee_range'   => ['type' => 'object', 'nullable' => true, 'properties' => ['min' => ['type' => 'string', 'example' => '5000.00'], 'max' => ['type' => 'string', 'example' => '25000.00']]],
                        ],
                    ]))],
                ],
            ],
        ],
        '/api/public/specialists' => [
            'get' => [
                'tags'       => ['Public'],
                'summary'    => 'Public specialist search (homepage, directory, quiz)',
                'description' => 'Only approved (or legacy) doctors who are available for booking are listed; /api/public/facets and /api/public/specialties count the same set. Same filters and `availability` as /api/portal/specialists, paged by `limit` (≤ 24) + `page`; default order name asc.',
                'parameters' => [
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'specialty', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'location', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'language', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'gender', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['male', 'female']]],
                    ['name' => 'mode', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['online', 'in_person']]],
                    ['name' => 'fee_max', 'in' => 'query', 'schema' => ['type' => 'number', 'minimum' => 0]],
                    ['name' => 'min_rating', 'in' => 'query', 'schema' => ['type' => 'number', 'minimum' => 0, 'maximum' => 5]],
                    ['name' => 'min_years', 'in' => 'query', 'schema' => ['type' => 'integer', 'minimum' => 0]],
                    ['name' => 'available_on', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'available_within', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['today', 'tomorrow', 'week']]],
                    ['name' => 'part_of_day', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['morning', 'afternoon', 'evening', 'any']]],
                    ['name' => 'tz', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                    ['name' => 'sort_by', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['name', 'rating', 'consultation_fee', 'years_experience', 'reviews_count', 'soonest'], 'default' => 'name']],
                    ['name' => 'sort_dir', 'in' => 'query', 'description' => 'Default asc for name/consultation_fee, desc otherwise', 'schema' => ['type' => 'string', 'enum' => ['asc', 'desc']]],
                    ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
                    ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 12, 'maximum' => 24]],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Specialist'))],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/public/specialists/suggestions' => [
            'get' => [
                'tags'        => ['Public'],
                'summary'     => 'Similar doctors free on a date (alternative-doctor suggestions)',
                'description' => 'Same specialty (and in-person when asked), tiered: 0 = every filter holds and free that day; 1 = one filter relaxed at a time (part_of_day → location → gender → language → fee; never specialty or mode); 2 = free within the next 3 days. Within a tier: soonest, weighted rating, fee closest to the `like` doctor, name. `like` excludes that doctor and inherits their specialty and fee (as fee_max); explicit parameters win. `requested` (with `like`): is that doctor free on the date, and their first opening on/after it. A `like` doctor who isn\'t listed (onboarding, rejected, suspended, removed) is a 404; one only switched off for bookings is fine.',
                'parameters'  => [
                    ['name' => 'like', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'date', 'in' => 'query', 'description' => 'YYYY-MM-DD in tz (default today), within today … bookable_until', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'part_of_day', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['morning', 'afternoon', 'evening', 'any']]],
                    ['name' => 'tz', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'specialty', 'in' => 'query', 'description' => 'Required without like', 'schema' => ['type' => 'string']],
                    ['name' => 'language', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'gender', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'location', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'mode', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['online', 'in_person']]],
                    ['name' => 'fee_max', 'in' => 'query', 'schema' => ['type' => 'number', 'minimum' => 0]],
                    ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 4, 'maximum' => 8]],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'requested'   => ['type' => 'object', 'nullable' => true, 'properties' => [
                                'id'                => ['type' => 'string', 'format' => 'uuid'],
                                'available_on_date' => ['type' => 'boolean'],
                                'next_available_at' => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                            ]],
                            'suggestions' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                                'specialist'   => ['$ref' => '#/components/schemas/Specialist'],
                                'availability' => ['$ref' => '#/components/schemas/SpecialistAvailability'],
                                'match'        => ['type' => 'object', 'properties' => [
                                    'tier'    => ['type' => 'integer', 'enum' => [0, 1, 2]],
                                    'relaxed' => ['type' => 'array', 'items' => ['type' => 'string', 'enum' => ['part_of_day', 'location', 'gender', 'language', 'fee']]],
                                    'reason'  => ['type' => 'string', 'example' => 'Same specialty · free 10:00 AM'],
                                ]],
                            ]]],
                        ],
                    ]))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/public/specialists/{id}/availability' => [
            'get' => [
                'tags'        => ['Public'],
                'summary'     => "A specialist's booking calendar (per-day status)",
                'description' => 'One entry per date in from … to (calendar days in tz; at most 42, starting between 42 days before today and bookable_until — else 422 on `from`). status: available | few (≤ few_left open) | full (had times, all taken) | closed (no hours) | blocked | past | beyond (after bookable_until). next_available searches the whole booking window. A doctor switched off for bookings has no open days; one not approved is a 404. Staff use /api/specialists/{id}/availability and the doctor /api/doctor/calendar (not held to the patient horizon).',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'from', 'in' => 'query', 'description' => 'Default today (in tz)', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'to', 'in' => 'query', 'description' => 'Default from + 41 days', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'tz', 'in' => 'query', 'description' => 'IANA zone (an unknown one falls back to the clinic zone — use the response tz)', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/AvailabilityRange']))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/specialists/specialties' => [
            'get' => [
                'tags'      => ['Portal'],
                'summary'   => 'Distinct specialty list (for the directory filter)',
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['type' => 'string']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/public/specialists/{id}/slots' => [
            'get' => [
                'tags'       => ['Public'],
                'summary'    => "A specialist's open consultation slots",
                'description' => 'With `date`: that day\'s open times on `tz`\'s clock — DaySlots {date, tz, slots: [{iso, time, label, period}]} (empty outside today … bookable_until). Without it (legacy): the next `days` days with open times, grouped by UTC date (array below).',
                'parameters' => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'date', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'tz', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                    ['name' => 'days', 'in' => 'query', 'description' => 'Legacy form', 'schema' => ['type' => 'integer', 'default' => 7, 'maximum' => 14]],
                ],
                'responses'  => [
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '200' => ['description' => 'OK — DaySlots with `date`, else the legacy array', ...$json($envelope([
                        'type'  => 'array',
                        'items' => [
                            'type'       => 'object',
                            'properties' => [
                                'date'    => ['type' => 'string', 'format' => 'date'],
                                'weekday' => ['type' => 'string', 'example' => 'Tue'],
                                'day'     => ['type' => 'string', 'example' => '11'],
                                'slots'   => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                                    'iso'   => ['type' => 'string', 'format' => 'date-time'],
                                    'label' => ['type' => 'string', 'example' => '9:00 AM'],
                                    'time'  => ['type' => 'string', 'example' => '09:00'],
                                ]]],
                            ],
                        ],
                    ]))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/specialists/{id}/availability' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "A specialist's booking calendar for staff booking on a patient's behalf",
                'description' => 'Requires appointments.create or appointments.book. AvailabilityRange like /api/public/specialists/{id}/availability, but not held to the patient horizon: the window (bookable_until, horizon_days) reaches 365 days ahead, and a doctor switched off for bookings still shows their times (the staff booking guard allows both). A doctor who can\'t practise (onboarding, rejected, suspended) shows no open day; a removed one is a 404. from … to: at most 42 days, starting between 42 days before today and bookable_until.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'from', 'in' => 'query', 'description' => 'Default today (in tz)', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'to', 'in' => 'query', 'description' => 'Default from + 41 days', 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'tz', 'in' => 'query', 'description' => 'IANA zone (an unknown one falls back to the clinic zone — use the response tz)', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/AvailabilityRange']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing appointments.create / appointments.book'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/specialists/{id}/slots' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "A specialist's open times on one date, for staff booking",
                'description' => 'Requires appointments.create or appointments.book. DaySlots {date, tz, slots: [{iso, time, label, period}]} like the public endpoint\'s `?date=` form, but not held to the patient horizon (empty after 365 days or before today) and shown for a doctor switched off for bookings.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'date', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'date']],
                    ['name' => 'tz', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'Africa/Lagos']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/DaySlots']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing appointments.create / appointments.book'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/public/specialists/{id}' => [
            'get' => [
                'tags'       => ['Public'],
                'summary'    => 'One specialist (for the booking wizard)',
                'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Specialist']))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/public/pricing' => [
            'get' => [
                'tags'      => ['Public'],
                'summary'   => 'Consultation pricing (currency, guest fee, platform fee)',
                'security'  => [],
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Pricing']))],
                ],
            ],
        ],
        '/api/public/prescriptions/file' => [
            'get' => [
                'tags' => ['Public'],
                'summary' => 'Stream a prescription PDF through a signed link',
                'description' => 'The short-lived signed token (issued to the prescriber, the patient or authorised staff) IS the credential. Every view/download is audited; expired/cancelled prescriptions are stamped.',
                'security' => [],
                'parameters' => [['name' => 'token', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string']]],
                'responses' => ['200' => ['description' => 'application/pdf'], '410' => ['description' => 'Link expired']],
            ],
        ],
        '/api/public/prescriptions/check' => [
            'post' => [
                'tags' => ['Public'],
                'summary' => 'Pharmacist check: is this prescription real?',
                'description' => 'Body {number, date_of_birth (YYYY-MM-DD), device_id}. No sign-in. Match → status, date sent, doctor and MDCN number (never medicines or other patient details). Always 200 with data.result: match | no_match (generic, never says which field was wrong) | locked (retry_at; repeated misses lock the device).',
                'security' => [],
                'responses' => ['200' => ['description' => 'Check result'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/public/call/{token}' => [
            'get' => [
                'tags'        => ['Public'],
                'summary'     => 'Resolve a preauthenticated join link into an Agora session',
                'description' => 'The signed call-access token from the invite email IS the credential — no login. Returns the meeting details (CallMeeting: you, uid, participants by uid — names only; a guest\'s also invited_by, opens_at, closes_at, consent) plus Agora credentials when video is configured; the doctor\'s also the patient\'s clinical summary (`patient`). '
                    . 'Every appointment is its own channel (its id). Refused (CallRefusal): cancelled / completed → 410; an unaccepted follow-up → 409 (`errors.code = not_confirmed`, `errors.status = proposed`); '
                    . 'a guest no longer on the list → 410 (`withdrawn`), before 15 minutes ahead of the start → 425 (`too_early`, with `starts_at` / `opens_at` / `server_time`), after 60 minutes past the slot\'s end → 410 (`ended`); '
                    . 'a guest who has not accepted the notice while recording could happen → 403 (`consent_required`, with `consent`). The patient and the doctor have no time window. '
                    . 'Renewal: call it again with the same token for a fresh RTC token (on token-privilege-will-expire) — the same checks apply, except that a guest in the call now (by heartbeat) renews past the window\'s end (for at most 3 hours more) and, while nothing is being recorded, without having accepted the notice. '
                    . 'A guest\'s token lasts 600 s (`expires_in`), everyone else\'s 3600 s; a guest removed (or whose consultation is cancelled) mid-call is also put out of the channel.',
                'security'    => [],
                'parameters'  => [['name' => 'token', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'responses'   => [
                    '200' => ['description' => 'Ready to join', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/CallMeeting'],
                            [
                                'type'       => 'object',
                                'properties' => [
                                    'configured' => ['type' => 'boolean'],
                                    'app_id'     => ['type' => 'string'],
                                    'channel'    => ['type' => 'string'],
                                    'token'      => ['type' => 'string', 'nullable' => true],
                                    'expires_in' => ['type' => 'integer', 'example' => 3600, 'nullable' => true, 'description' => 'Seconds the token lasts: 600 for a guest, 3600 otherwise; null without one'],
                                ],
                            ],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'A guest must accept the notice first (`consent_required`); or the doctor may not practise (`doctor_suspended` | `doctor_not_approved`, or `terms_required` before the consultation\'s start time)', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '409' => ['description' => 'A follow-up proposal not accepted yet (`not_confirmed`)', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '410' => ['description' => 'Cancelled, ended, or the guest\'s invitation was withdrawn', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '425' => ['description' => 'A guest is too early (`too_early`, with `starts_at` / `opens_at`)', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                ],
            ],
        ],
        '/api/public/call/{token}/lobby' => [
            'get' => [
                'tags'        => ['Public'],
                'summary'     => 'The pre-join lobby for a join link (no Agora credentials)',
                'description' => 'CallMeeting plus `server_time` and `can_join`; a guest\'s also `consent`. The same refusals as joining except too early: an early guest gets `can_join: false` and `opens_at` to count down to. Never health data or emails.',
                'security'    => [],
                'parameters'  => [['name' => 'token', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/CallMeeting'],
                            ['type' => 'object', 'properties' => ['server_time' => ['type' => 'string', 'format' => 'date-time'], 'can_join' => ['type' => 'boolean']]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '409' => ['description' => 'Not confirmed yet', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '410' => ['description' => 'Cancelled, ended or withdrawn', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                ],
            ],
        ],
        '/api/public/call/{token}/consent' => [
            'post' => [
                'tags'        => ['Public'],
                'summary'     => 'A guest accepts the recording + privacy notice',
                'description' => 'Guest links only (422 `errors.role` otherwise). Body `{accepted: true, display_name?}` (422 `errors.accepted` unless true; `display_name` 1–60 characters, 422 `errors.display_name`) — the name they show as in the call. '
                    . 'Recorded on their guest entry with the notice version and audited (`call.guest_consented`, guest id only). Required before joining while recording could happen; send it whenever the guest ticks the notice. '
                    . 'The same refusals as the lobby (410 / 409; not too early).',
                'security'    => [],
                'parameters'  => [['name' => 'token', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['accepted'], 'properties' => [
                    'accepted'     => ['type' => 'boolean', 'enum' => [true]],
                    'display_name' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 60],
                ]])],
                'responses'   => [
                    '200' => ['description' => 'Recorded', ...$json($envelope(['type' => 'object', 'properties' => [
                        'consent'      => ['$ref' => '#/components/schemas/GuestConsentState'],
                        'you'          => ['type' => 'object'],
                        'participants' => ['type' => 'array', 'items' => ['$ref' => '#/components/schemas/CallParticipant']],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '409' => ['description' => 'Not confirmed yet', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '410' => ['description' => 'Cancelled, ended or withdrawn', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        // ----- The patient's guests -----
        '/api/portal/appointments/{id}/guests' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "The patient's guests on consultation {id}",
                'description' => 'Each guest with email, status (invited / consented / joined), whether in the call now and their personal join link (a bearer credential — for the patient to share with that guest only); plus the guest fee and whether the list can change.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/PatientGuestList']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Invite a guest to consultation {id}',
                'description' => 'Body `{name, email, payment_method?: wallet|card, payment_reference?}`. Pending / confirmed / rescheduled, until 60 minutes after the slot ends (422 `errors.status`). At most 3 guests (422 `errors.guests`); `name` 1–100 characters (`errors.name`); a valid email that is not the patient\'s, the doctor\'s or an invited guest\'s (`errors.email`). '
                    . 'The guest fee (GET .../guests `guest_fee`; 0 = free, no payment) is charged: `wallet` (too low → 422 `errors.wallet = insufficient_funds`) or `card` with the `reference` from POST .../guests/pay-init (422 `errors.payment_reference` / `errors.payment`; one reference pays once). '
                    . 'It is added to the appointment amount, so cancelling the consultation refunds it too. If the guest can\'t be stored after paying (the list closed or filled up meanwhile — `errors.status` / `errors.guests`, also when a card payment is refused for that before it is checked), the payment goes to the wallet and the 422 carries `errors.payment = credited_to_wallet` (a name / email error keeps a card payment for the retry with the same reference). '
                    . 'The guest is emailed their link ("<first name> invited you to join their video consultation with <doctor> on <time>"), the doctor gets an in-app notice (the guest\'s name only), audited `appointment.guest_added`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['name', 'email'], 'properties' => [
                    'name'              => ['type' => 'string', 'maxLength' => 100],
                    'email'             => ['type' => 'string', 'format' => 'email'],
                    'payment_method'    => ['type' => 'string', 'enum' => ['wallet', 'card'], 'description' => 'Required unless the guest fee is 0'],
                    'payment_reference' => ['type' => 'string', 'description' => 'With card: the guests/pay-init reference, once paid'],
                ]])],
                'responses'   => [
                    '201' => ['description' => 'Invited', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/PatientGuestList'],
                            ['type' => 'object', 'properties' => ['guest' => ['$ref' => '#/components/schemas/PatientGuest']]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/guests/pay-init' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Start a card payment of the guest fee for consultation {id}',
                'description' => 'Checked first: the guest list must be open (422 `errors.status`) and not full (422 `errors.guests`). A guest fee of 0 → 422 `errors.payment = free` (add the guest directly). Returns to /dashboard/appointments/{id}; then POST .../guests with `payment_method: card` and the `reference`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '201' => ['description' => 'Payment started', ...$json($envelope(['type' => 'object', 'properties' => [
                        'authorization_url' => ['type' => 'string'],
                        'access_code'       => ['type' => 'string'],
                        'reference'         => ['type' => 'string'],
                        'amount'            => ['type' => 'string', 'example' => '5000.00'],
                        'currency'          => ['type' => 'string', 'example' => 'NGN'],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '502' => ['description' => 'Paystack refused to start the payment'],
                    '503' => ['description' => 'Card payment not configured'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/guests/{gid}' => [
            'delete' => [
                'tags'        => ['Portal'],
                'summary'     => 'Remove a guest from consultation {id}',
                'description' => 'Their join link stops working at once (their call screen is refused at its next heartbeat) and they are emailed that the invitation was withdrawn. Removed before the consultation starts, a paid guest fee goes back to the wallet (`refunded`) and off the amount; after the start, nothing is refunded. 422 `errors.status` once the list can\'t change; 404 for an unknown guest. Audited `appointment.guest_removed`.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'gid', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'   => [
                    '200' => ['description' => 'Removed', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/PatientGuestList'],
                            ['type' => 'object', 'properties' => [
                                'removed'  => ['type' => 'object', 'properties' => ['id' => ['type' => 'string'], 'name' => ['type' => 'string']]],
                                'refunded' => ['type' => 'string', 'nullable' => true, 'example' => '5000.00'],
                            ]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/guests/{gid}/resend' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => "Re-send a guest's invitation",
                'description' => 'Emails the guest their invitation again with a fresh copy of their link — at most once every 2 minutes per guest (429 with `errors.retry_after` seconds and Retry-After). 422 `errors.status` once the list can\'t change; 404 for an unknown guest.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'gid', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'   => [
                    '200' => ['description' => 'Sent', ...$json($envelope(['$ref' => '#/components/schemas/PatientGuestList']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '429' => ['description' => 'Too soon (`errors.retry_after`)'],
                ],
            ],
        ],
        // ----- Doctor onboarding (invite → set password → checklist → review) -----
        '/api/auth/staff/accept-invite' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Accept a doctor invite: choose a password and sign in',
                'description' => 'Body {token, password}. The one-time token from the invite email (valid 7 days) IS the credential. Password: 8+ characters. Success returns the same session as staff sign-in; the link stops working. A bad / expired / used link is a 422 on `token`.',
                'operationId' => 'staffAcceptInvite',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['token', 'password'], 'properties' => ['token' => ['type' => 'string'], 'password' => ['type' => 'string', 'format' => 'password']]])],
                'responses'   => [
                    '200' => ['description' => 'Password set and signed in', ...$json($envelope($authData('#/components/schemas/StaffUser')))],
                    '401' => ['description' => 'Account deactivated'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/auth/staff/forgot-password' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Email a staff (doctor) login a password reset link',
                'description' => 'Body {email}. Always the same reply, in content and timing, whether or not the account exists (the lookup and email happen after the reply is sent). The link is single-use and valid for 1 hour, and only ever goes to the account\'s inbox — it is never in the reply, in any environment (outside production it is written to the app log for testing). At most one email per address per minute (plus the global rate limit).',
                'operationId' => 'staffForgotPassword',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['email'], 'properties' => ['email' => ['type' => 'string', 'format' => 'email']]])],
                'responses'   => [
                    '200' => ['description' => 'Request accepted', ...$json($envelope(['type' => 'object', 'properties' => ['sent' => ['type' => 'boolean']]]))],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '429' => ['description' => 'Too many requests'],
                ],
            ],
        ],
        '/api/auth/staff/reset-password' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Choose a new staff password from a reset link and sign in',
                'description' => 'Body {token, password}. Password: 8+ characters. Success returns the same session as staff sign-in. A bad / expired / used link is a 422 on `token`.',
                'operationId' => 'staffResetPassword',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['token', 'password'], 'properties' => ['token' => ['type' => 'string'], 'password' => ['type' => 'string', 'format' => 'password']]])],
                'responses'   => [
                    '200' => ['description' => 'Password updated and signed in', ...$json($envelope($authData('#/components/schemas/StaffUser')))],
                    '401' => ['description' => 'Account deactivated'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/onboarding' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => "The signed-in doctor's onboarding checklist and review status",
                'description' => '`checklist` booleans: photo, bio, qualifications, mdcn, mdcn_certificate (MDCN full-registration certificate uploaded, waiting or verified), practising_licence (an unexpired annual practising licence uploaded, waiting or verified), signature, availability (weekly hours or a future open slot), payout, terms (the practitioner terms in force accepted). `status`: invited | pending_review | approved | rejected | suspended (a legacy doctor reads as approved); `rejection_reason` when sent back. '
                    . 'Also: `credentials` (the doctor\'s documents, replaced ones left out: id, type, type_label, number, issued_at, expires_at, status pending|verified|rejected|expired, status_label, rejection_reason, original_name, mime, size_bytes, reviewed_at, created_at), `locked_fields`, `pending_changes` / `pending_changes_submitted_at` / `changes_review_note`, `terms` {current_version, accepted_version, accepted_at, accepted}, `licence` {expires_at, status valid|expiring|expired|missing}, `suspension` {code, code_label, reason, suspended_at} or null, `standing` {code doctor_suspended|doctor_not_approved|terms_required, message} or null when they may practise, and the review fields suspended_at, suspension_code, suspension_reason, licence_expires_at, credentials_due_at (a doctor approved before documents existed must upload them by then), has_pending_changes, terms_version, terms_accepted_at. Always reachable, whatever the standing.',
                'operationId' => 'doctorOnboarding',
                'responses'   => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login']],
            ],
        ],
        '/api/doctor/onboarding/submit' => [
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Submit the completed profile for review',
                'description' => 'Only when every checklist item is done — documents uploaded and the terms accepted included (422 names what is missing) — and the profile is onboarding or was sent back. Moves to pending_review (recorded as a status event and audited `specialist.submitted`) and notifies the reviewers (specialists.manage) in-app and by email.',
                'operationId' => 'doctorOnboardingSubmit',
                'responses'   => ['200' => ['description' => 'Submitted'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/invite' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Invite (or re-invite) a doctor by email',
                'description' => "Requires specialists.manage. Creates (from the specialist's email) or reuses the doctor login, which has no usable password, and emails it a one-time set-password link valid for 7 days; calling it again resends and the old link stops working. An existing login keeps its own email. 422 when there is no email, the email belongs to another login, the doctor has already set a password (they use forgot-password), or the doctor is already live (approved / legacy / suspended) with no login — that login is created from Staff (staff.manage). Outside production `dev_link` is included for testing.",
                'operationId' => 'specialistInvite',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'Invite sent (`email_sent`, `expires_at`, `login`)'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/review-queue' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'What is waiting for a reviewer (back-office badge)',
                'description' => 'Requires specialists.manage. Counts only — no names: profiles in pending_review, change requests (pending_changes), documents waiting for verification from live doctors (credentials_pending), `total` = those three (the badge); plus licences expiring within 30 days, licences expired and doctors still owing their documents (not in total).',
                'operationId' => 'specialistReviewQueue',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'object', 'properties' => [
                        'pending_review'      => ['type' => 'integer'],
                        'pending_changes'     => ['type' => 'integer'],
                        'credentials_pending' => ['type' => 'integer'],
                        'total'               => ['type' => 'integer'],
                        'licences_expiring'   => ['type' => 'integer'],
                        'licences_expired'    => ['type' => 'integer'],
                        'credentials_missing' => ['type' => 'integer'],
                    ]]))],
                    '403' => ['description' => 'Missing specialists.manage'],
                ],
            ],
        ],
        '/api/specialists/{id}/onboarding' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "A doctor's onboarding checklist, profile and login state (review panel)",
                'description' => 'Requires specialists.manage. The doctor\'s onboarding payload (see GET /doctor/onboarding) in the reviewer view — documents include replaced ones, `reviewed_by_name`, `attestation` and `sha256` — plus `approval` {ready, problems: {field: message}}, `credentials_missing`, `approved_snapshot`, `terms.accepted_ip`, `profile` and `login`.',
                'operationId' => 'specialistOnboarding',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'OK'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/approve' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Approve a doctor's submitted profile (listed + bookable)",
                'description' => 'Requires specialists.manage. Body {attest: true, note?}. 422 with every reason by field unless: the profile is in pending_review (`status`; a suspended doctor is reinstated with POST .../reinstate), every checklist item is done (`checklist`), the MDCN certificate is verified (`mdcn_certificate`), a current practising licence is verified (`practising_licence`), the terms in force are accepted (`terms`) and the reviewer attests (`attest`). Stores `approved_snapshot` (name, specialty, mdcn_number, qualifications, qualification_entries, certifications, credential_ids, approved_by, approved_by_name, approved_at), records a status event, audits `specialist.approved`, emails the doctor. Returns the reviewer summary.',
                'operationId' => 'specialistApprove',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['attest'], 'properties' => ['attest' => ['type' => 'boolean', 'example' => true], 'note' => ['type' => 'string', 'maxLength' => 2000]]])],
                'responses'   => ['200' => ['description' => 'Approved'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/reject' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Send a submitted profile back to the doctor with a reason',
                'description' => 'Requires specialists.manage. Body {reason} (required, ≤ 2000 chars). Only from pending_review; the doctor sees the reason and is emailed. Kept as a status event and audited (`specialist.rejected` with the reason). Returns the reviewer summary.',
                'operationId' => 'specialistReject',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['reason'], 'properties' => ['reason' => ['type' => 'string']]])],
                'responses'   => ['200' => ['description' => 'Sent back'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'List specialists with their contact email (back office, server-paginated)',
                'description' => 'Requires specialists.manage. Every specialist whatever their status, with the normally server-side email, the review fields (status, status_label, rejection_reason, submitted_at, approved_at, suspended_at, suspension_code, suspension_reason, licence_expires_at, credentials_due_at, has_pending_changes, terms_version, terms_accepted_at), `licence_status` (valid|expiring|expired|missing), `credentials_missing`, `credentials_pending` (documents waiting) and `login`. '
                    . '`q` searches name, specialty, email and MDCN number; `filter`: all | review | changes | onboarding | rejected | approved | suspended | licence_expiring (≤ 30 days) | licence_expired | credentials_missing | credentials_pending (422 otherwise). `sort_by`: name (default, asc) | specialty | created_at | submitted_at | licence_expires_at. '
                    . 'With none of page / per_page / q / filter it returns everyone (up to 500, by name) in one page, for pickers.',
                'parameters'  => [
                    ['name' => 'q', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'filter', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['all', 'review', 'changes', 'onboarding', 'rejected', 'approved', 'suspended', 'licence_expiring', 'licence_expired', 'credentials_missing', 'credentials_pending']]],
                    ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
                    ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 100]],
                    ['name' => 'sort_by', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['name', 'specialty', 'created_at', 'submitted_at', 'licence_expires_at']]],
                    ['name' => 'sort_dir', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['asc', 'desc'], 'default' => 'asc']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK (paginated: `meta`)', ...$json([
                        'type'       => 'object',
                        'properties' => [
                            'status' => ['type' => 'string'],
                            'data'   => [
                                'type'  => 'array',
                                'items' => [
                                    'allOf' => [
                                        ['$ref' => '#/components/schemas/Specialist'],
                                        ['type' => 'object', 'properties' => [
                                            'email'               => ['type' => 'string', 'nullable' => true],
                                            'status'              => ['type' => 'string'],
                                            'licence_status'      => ['type' => 'string', 'enum' => ['valid', 'expiring', 'expired', 'missing']],
                                            'credentials_missing' => ['type' => 'boolean'],
                                            'credentials_pending' => ['type' => 'integer'],
                                            'has_pending_changes' => ['type' => 'boolean'],
                                        ]],
                                    ],
                                ],
                            ],
                            'meta'   => ['$ref' => '#/components/schemas/PageMeta'],
                        ],
                    ])],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing specialists.manage'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Onboard a new specialist (back office)',
                'description' => 'Requires specialists.manage. Name + specialty required; other fields optional. `verified` is ignored (it follows approval). Audited `specialist.created`.',
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['name', 'specialty'],
                    'properties' => [
                        'name'             => ['type' => 'string'],
                        'specialty'        => ['type' => 'string', 'description' => 'An active item label of GET /public/reference/specialty (any case; saved in the list\'s spelling) — else 422 "Choose a specialty from the list"'],
                        'email'            => ['type' => 'string', 'format' => 'email', 'nullable' => true],
                        'consultation_fee' => ['type' => 'string', 'example' => '15000.00'],
                        'bio'              => ['type' => 'string'],
                        'languages'        => ['type' => 'string'],
                        'location'         => ['type' => 'string'],
                        'years_experience' => ['type' => 'integer'],
                        'gender'           => ['type' => 'string', 'enum' => ['male', 'female']],
                        'photo_url'        => ['type' => 'string', 'nullable' => true, 'description' => 'Deprecated: only empty is accepted (422 otherwise) — upload the photo after creating, with POST /api/specialists/{id}/photo'],
                        'available'        => ['type' => 'boolean'],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Created'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing specialists.manage'],
                ],
            ],
        ],
        '/api/specialists/{id}' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "A doctor's page (back office)",
                'description' => 'Requires specialists.manage. Everything GET /specialists/{id}/onboarding returns (reviewer summary: checklist, documents with attestations, change request, approved_snapshot, terms, licence, suspension, standing, approval {ready, problems}, profile incl. contact details, login) plus `payout_account` (account numbers masked to the last four digits) and `stats` {appointments_by_status: {status: n} (incl. missed), upcoming, earnings (the earnings summary), reviews {average, count, distribution}, doctor_no_shows (missed consultations this doctor did not attend, all time), doctor_no_shows_30d}.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => "Edit a specialist's contact, booking and public-profile fields (back office)",
                'description' => 'Requires specialists.manage. Only the keys present change; each change is audited (`specialist.updated` with before/after). The identity fields (name, specialty, MDCN number, qualifications, certifications) are not edited here — except `specialty` while the doctor is onboarding (an active item of the specialty reference list, else 422 "Choose a specialty from the list"; for an approved or suspended doctor a different specialty is a 422 — it changes through their change request — and re-sending the current one is a no-op) — and `verified` is ignored (it follows approval). The response echoes the (normally server-side) email so the operator can confirm it.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'properties' => [
                        'email'            => ['type' => 'string', 'format' => 'email', 'nullable' => true, 'description' => 'Empty string clears it'],
                        'specialty'        => ['type' => 'string', 'description' => 'Onboarding doctors only: an active item label of the specialty reference list'],
                        'consultation_fee' => ['type' => 'string', 'example' => '15000.00'],
                        'photo_url'        => ['type' => 'string', 'nullable' => true, 'description' => 'Empty (or null) clears it — the stored file is deleted when it is one of this doctor\'s own uploads; the current value unchanged is a no-op; anything else (a link, any other path) is a 422. Prefer DELETE /api/specialists/{id}/photo to clear and POST /api/specialists/{id}/photo to upload'],
                        'available'        => ['type' => 'boolean'],
                        'bio'              => ['type' => 'string', 'maxLength' => 5000],
                        'location'         => ['type' => 'string', 'maxLength' => 200],
                        'country'          => ['type' => 'string', 'maxLength' => 120],
                        'languages'        => ['type' => 'string', 'maxLength' => 200],
                        'years_experience' => ['type' => 'integer', 'nullable' => true, 'minimum' => 0, 'maximum' => 80],
                        'gender'           => ['type' => 'string', 'enum' => ['male', 'female', '']],
                        'offers_in_person' => ['type' => 'boolean'],
                        'expertise'        => ['type' => 'array', 'items' => ['type' => 'string']],
                    ],
                ])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/Specialist'],
                            ['type' => 'object', 'properties' => ['email' => ['type' => 'string', 'nullable' => true]]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing specialists.manage'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/specialists/{id}/photo' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Upload or replace a doctor's headshot (back office)",
                'description' => "Requires specialists.manage. Multipart form-data, field `photo`: JPG, PNG or WebP, ≤2MB, verified from the bytes (same checks and storage as the doctor's own POST /api/doctor/avatar). Saved as /uploads/avatars/dr-{id}-{random}.{ext}; the previous file is deleted when it was one of this doctor's uploads. Audited as `specialist.updated` with photo_url before/after (`via: photo_upload`). Returns the PATCH /api/specialists/{id} payload.",
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, 'content' => ['multipart/form-data' => ['schema' => [
                    'type' => 'object', 'properties' => ['photo' => ['type' => 'string', 'format' => 'binary']], 'required' => ['photo'],
                ]]]],
                'responses'   => [
                    '200' => ['description' => 'Photo updated', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/Specialist'],
                            ['type' => 'object', 'properties' => ['email' => ['type' => 'string', 'nullable' => true]]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing specialists.manage'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['description' => 'errors.photo: "No image was uploaded" | "Image must be 2MB or smaller" | "Only JPG, PNG or WEBP images are allowed"'],
                ],
            ],
            'delete' => [
                'tags'        => ['Staff'],
                'summary'     => "Remove a doctor's headshot (back office)",
                'description' => "Requires specialists.manage. Clears the photo (and deletes the stored file when it is one of this doctor's uploads). Idempotent. Audited as `specialist.updated` (`via: photo_remove`) when there was a photo. Returns the PATCH /api/specialists/{id} payload.",
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'Photo removed', ...$json($envelope([
                        'allOf' => [
                            ['$ref' => '#/components/schemas/Specialist'],
                            ['type' => 'object', 'properties' => ['email' => ['type' => 'string', 'nullable' => true]]],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing specialists.manage'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/specialists/{id}/appointments' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "One doctor's consultations (doctor page)",
                'description' => 'Requires specialists.manage. Paginated, newest first; `status` is a comma list, `search` matches the patient\'s name. Each row is the Appointment (without notes, document_url, follow_up_note, decline_reason) plus `patient_name` — no patient contact details.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string', 'example' => 'confirmed,completed']],
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
                    ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 100]],
                ],
                'responses'   => ['200' => ['description' => 'OK (paginated)'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/payouts' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "One doctor's earnings and payouts (doctor page)",
                'description' => 'Requires specialists.manage. {earnings (summary), payouts (newest first, up to 100; each account snapshot masked), payout_account (masked, or null)}. Approving and paying stays on the payouts screen (payouts.manage).',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'OK'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/reviews' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "Patients' reviews of one doctor (doctor page)",
                'description' => 'Requires specialists.manage. Paginated, newest first; each {id, specialist_id, patient_name, appointment_id, rating, comment, response, responded_at, created_at}.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
                    ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 100]],
                ],
                'responses'   => ['200' => ['description' => 'OK (paginated)'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/history' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "One doctor's history (doctor page)",
                'description' => 'Requires specialists.manage. {status_events: [{id, from_status, to_status, actor_id, actor_name, code, reason, meta, created_at}], audit: [AuditEvent with actor_id]}, each newest first, up to 200. Audit actions include specialist.created, .invited, .updated (before/after), .submitted, .approved, .rejected, .changes_submitted / _approved / _rejected / _withdrawn, .credential_uploaded / _viewed / _verified / _rejected / _deleted, .terms_accepted, .suspended, .suspension_rerun, .reinstated.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'OK'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/credentials/{cid}/file' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "Open one of a doctor's licensing documents (audited)",
                'description' => 'Requires specialists.manage. The decrypted file (PDF / JPG / PNG) inline, `Cache-Control: private, no-store` — fetch it as a blob and show it from an object URL. Every view is audited (`specialist.credential_viewed`). 404 when the document is not this doctor\'s, or can no longer be read.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'cid', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'responses'   => ['200' => ['description' => 'The file', 'content' => ['application/pdf' => [], 'image/jpeg' => [], 'image/png' => []]], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/credentials/{cid}/verify' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Verify a document against the MDCN register (with an attestation)',
                'description' => 'Requires specialists.manage. Only a document waiting for review (422 `status`). Body: register_checked (must be true), register_reference (1–120 chars), note (≤ 1000), and for a licence optionally expires_at (YYYY-MM-DD, correcting the uploaded date) and number. A licence must end up with an expiry date that has not passed. The verified document replaces the doctor\'s older verified one of its kind; a licence sets the doctor\'s licence_expires_at; a doctor who owed documents is cleared once the MDCN certificate and a current licence are both verified. Audited `specialist.credential_verified` with the attestation; the doctor is told in-app. Returns the reviewer summary.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'cid', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['register_checked', 'register_reference'], 'properties' => [
                    'register_checked'   => ['type' => 'boolean', 'example' => true],
                    'register_reference' => ['type' => 'string', 'maxLength' => 120],
                    'note'               => ['type' => 'string', 'maxLength' => 1000],
                    'expires_at'         => ['type' => 'string', 'format' => 'date'],
                    'number'             => ['type' => 'string', 'maxLength' => 60],
                ]])],
                'responses'   => ['200' => ['description' => 'Verified'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/credentials/{cid}/reject' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Turn a document down with a reason',
                'description' => 'Requires specialists.manage. Body {reason} (1–1000 chars). A document waiting for review, or a verified one found wrong (a rejected licence updates the doctor\'s licence_expires_at). The doctor is told in-app and by email. Audited `specialist.credential_rejected`. Returns the reviewer summary.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'cid', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                ],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['reason'], 'properties' => ['reason' => ['type' => 'string', 'maxLength' => 1000]]])],
                'responses'   => ['200' => ['description' => 'Turned down'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/suspend/preview' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'What suspending this doctor would do (confirm dialog)',
                'description' => 'Requires specialists.manage. Changes nothing. {already_suspended, bookings (future pending/confirmed/rescheduled to cancel — plus any in progress, its slot not over, with no proof the consultation is taking place), proposals (open follow-up proposals to withdraw), in_progress (consultations taking place now — note, prescription, the doctor on the transcript or both on the call — left to finish; the cron completes them), patients, refunds (paid bookings), refund_total, guests, guest_fees (included in refund_total), currency, codes: [{code, label}]}.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'OK'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/specialists/{id}/suspend' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Suspend a doctor (stopped practising)',
                'description' => 'Requires specialists.manage. Body {code: licence_expired|conduct|complaint|admin|other, reason (1–2000 chars, shown to the doctor)}. Only an approved (or already suspended) doctor. Unlists them, refuses all clinical work (403 doctor_suspended), signs them out everywhere, cancels every future pending/confirmed/rescheduled booking (and one in progress with no proof the consultation is taking place) and refunds it to the patient\'s wallet (guest fees included) — one transaction per batch, each booking re-read under its lock, its in-app patient notice saved with it — withdraws open follow-up proposals, and after the response emails each patient (refund and a link to doctors of the same specialty) and each guest. Records a status event; audited `specialist.suspended` (`specialist.suspension_rerun` when run again) before any booking is touched, then `specialist.suspension_bookings` with what was cancelled. Calling it again for a suspended doctor only finishes what is left. '
                    . 'Returns {summary (reviewer summary), affected: {already_suspended, sessions_revoked, cancelled, refunded_count, refunded_total, guests_notified, proposals_withdrawn, patients_notified, in_progress, failed, incomplete, currency}} — `incomplete` true: call it again; `in_progress`: consultations taking place now, left to finish.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['code', 'reason'], 'properties' => [
                    'code'   => ['type' => 'string', 'enum' => ['licence_expired', 'conduct', 'complaint', 'admin', 'other']],
                    'reason' => ['type' => 'string', 'maxLength' => 2000],
                ]])],
                'responses'   => ['200' => ['description' => 'Suspended'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/reinstate' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => 'Lift a suspension',
                'description' => 'Requires specialists.manage. Body {note} (1–2000 chars). 422 unless the doctor is suspended (`status`) and has a verified, unexpired practising licence (`practising_licence`). Back to approved — listed and bookable; cancelled bookings are not restored. Records a status event, audited `specialist.reinstated`, the doctor is emailed. Returns the reviewer summary.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['note'], 'properties' => ['note' => ['type' => 'string', 'maxLength' => 2000]]])],
                'responses'   => ['200' => ['description' => 'Reinstated'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/changes/approve' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Approve a doctor's requested changes to locked fields",
                'description' => 'Requires specialists.manage. The pending_changes go live (new prescriptions print them), the approved_snapshot is refreshed, the doctor is told in-app and by email. 422 `changes` when nothing is waiting. Audited `specialist.changes_approved` with before/after. Returns the reviewer summary plus `profile`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'Approved'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/specialists/{id}/changes/reject' => [
            'post' => [
                'tags'        => ['Staff'],
                'summary'     => "Turn down a doctor's requested changes",
                'description' => 'Requires specialists.manage. Body {reason} (1–2000 chars, shown to the doctor as changes_review_note until they ask again; emailed). Nothing on the profile changes. 422 for a blank reason or when nothing is waiting. Audited `specialist.changes_rejected`. Returns the reviewer summary.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['reason'], 'properties' => ['reason' => ['type' => 'string', 'maxLength' => 2000]]])],
                'responses'   => ['200' => ['description' => 'Turned down'], '403' => ['description' => 'Missing specialists.manage'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/doctor/profile/changes' => [
            'delete' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Withdraw a change request still waiting for review',
                'description' => 'Clears pending_changes (nothing on the profile changes); audited `specialist.changes_withdrawn`. Returns the profile as GET /doctor/profile.',
                'responses'   => ['200' => ['description' => 'Withdrawn'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login']],
            ],
        ],
        '/api/doctor/credentials' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => "The signed-in doctor's licensing documents",
                'description' => '{credentials: [{id, type, type_label, number, issued_at, expires_at, status pending|verified|rejected|expired, status_label, rejection_reason, original_name, mime, size_bytes, reviewed_at, created_at}] (newest first, replaced ones left out), types: [{type, label, requires_expiry, requires_number}], max_bytes, accepted: [MIME types]}. Reachable whatever the doctor\'s standing.',
                'responses'   => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login']],
            ],
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Upload a licensing document',
                'description' => 'multipart/form-data: `file` (PDF, JPG or PNG, ≤ 10MB, checked by content), `type` (mdcn_full_registration | annual_practising_licence | specialist_certificate), `number` and `expires_at` (YYYY-MM-DD, both required for a licence; not already past), optional `issued_at` (not in the future). Stored encrypted (owner and reviewers only). A newer upload replaces an older one of the same kind still waiting; at most 10 waiting at once. A live doctor\'s upload notifies the reviewers. Audited `specialist.credential_uploaded`. 201 with the document; 422 per field; 409 when secure storage is not set up.',
                'requestBody' => ['required' => true, 'content' => ['multipart/form-data' => ['schema' => [
                    'type'       => 'object',
                    'required'   => ['file', 'type'],
                    'properties' => [
                        'file'       => ['type' => 'string', 'format' => 'binary'],
                        'type'       => ['type' => 'string', 'enum' => ['mdcn_full_registration', 'annual_practising_licence', 'specialist_certificate']],
                        'number'     => ['type' => 'string', 'maxLength' => 60],
                        'issued_at'  => ['type' => 'string', 'format' => 'date'],
                        'expires_at' => ['type' => 'string', 'format' => 'date'],
                    ],
                ]]]],
                'responses'   => ['201' => ['description' => 'Uploaded'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login'], '409' => ['description' => 'Secure file storage is not set up'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/doctor/credentials/{id}' => [
            'delete' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Delete a document still waiting for review',
                'description' => 'The file is destroyed. A verified or turned-down document stays on record (422 `status`). Audited `specialist.credential_deleted`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'Deleted'], '403' => ['description' => 'Not a doctor login'], '404' => ['$ref' => '#/components/responses/NotFound'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/doctor/credentials/{id}/file' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Open one of my licensing documents',
                'description' => 'The decrypted file inline, never cached (fetch as a blob). 404 for anyone else\'s document.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => ['200' => ['description' => 'The file', 'content' => ['application/pdf' => [], 'image/jpeg' => [], 'image/png' => []]], '403' => ['description' => 'Not a doctor login'], '404' => ['$ref' => '#/components/responses/NotFound']],
            ],
        ],
        '/api/doctor/terms' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => 'The practitioner terms in force',
                'description' => '{version (DOCTOR_TERMS_VERSION, default 1.0), title, blocks: [{type h1|h2|h3|p|ul|ol, text}] (plain text — render without HTML), sha256, accepted_version, accepted_at, accepted (this version)}. A doctor who has not accepted the version in force may read but start no clinical work (403 terms_required) — except on a consultation of theirs already under way, which they may finish (notes, prescriptions, completion, call).',
                'responses'   => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login']],
            ],
        ],
        '/api/doctor/terms/accept' => [
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Accept the practitioner terms',
                'description' => 'Body {version, agree: true}. 422 `version` when it is not the version in force (re-read GET /doctor/terms), `agree` when not true. Records the version, time and IP on the doctor and in the audit trail (`specialist.terms_accepted`, with the text\'s sha256); accepting an already-accepted version changes nothing. Returns the same as GET /doctor/terms.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['version', 'agree'], 'properties' => [
                    'version' => ['type' => 'string', 'example' => '1.0'],
                    'agree'   => ['type' => 'boolean', 'example' => true],
                ]])],
                'responses'   => ['200' => ['description' => 'Accepted'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login'], '422' => ['$ref' => '#/components/responses/Validation']],
            ],
        ],
        '/api/settings/pricing' => [
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => 'Update consultation pricing (back office)',
                'description' => 'Requires settings.manage. Only the keys present are changed. 422 (per field) when guest_fee / platform_fee is negative or not a number, currency is blank, follow_up_fee_mode is not full|percent|free, follow_up_discount_percent is not a whole number 0–100, or follow_up_window_days is not a whole number 1–365. Read the current values with GET /public/pricing.',
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/Pricing'])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/Pricing']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing settings.manage'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointment-documents' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Upload a supporting document for a booking',
                'description' => 'multipart/form-data with one `document` file (PDF, JPG, PNG, WEBP, DOCX, DICOM or video; <= 10MB — the same checks as POST /portal/documents). '
                    . 'The file is filed privately in the patient\'s medical documents as a `booking_attachment` (never publicly reachable) and returned as a document; '
                    . 'pass its `id` in the booking\'s `document_ids`. `url` is the authenticated download route, not a public URL. '
                    . 'Private by default: hidden from every doctor holding a whole-folder share (the doctor being booked included) except those in `show_specialist_ids[]` '
                    . '(≤ 20 doctors you booked); whether the booked doctor sees it is the booking\'s `document_share`. The answer adds `shared_with`, `share_outcome`, `share_ended_for`.',
                'requestBody' => [
                    'required' => true,
                    'content'  => [
                        'multipart/form-data' => [
                            'schema' => [
                                'type'       => 'object',
                                'required'   => ['document'],
                                'properties' => [
                                    'document'              => ['type' => 'string', 'format' => 'binary'],
                                    'show_specialist_ids[]' => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid'], 'maxItems' => 20],
                                ],
                            ],
                        ],
                    ],
                ],
                'responses'   => [
                    '201' => ['description' => 'Uploaded', ...$json($envelope(['type' => 'object', 'properties' => [
                        'id'             => ['type' => 'string', 'format' => 'uuid'],
                        'title'          => ['type' => 'string', 'description' => 'From the file name, without its extension'],
                        'document_type'  => ['type' => 'string', 'example' => 'booking_attachment'],
                        'type_label'     => ['type' => 'string', 'example' => 'Booking Attachment'],
                        'appointment_id' => ['type' => 'string', 'format' => 'uuid', 'nullable' => true, 'description' => 'Null until a booking attaches it'],
                        'extension'      => ['type' => 'string'],
                        'mime_type'      => ['type' => 'string'],
                        'size_bytes'     => ['type' => 'integer'],
                        'size_label'     => ['type' => 'string', 'example' => '2.5MB'],
                        'url'            => ['type' => 'string', 'example' => '/api/portal/documents/{id}/file', 'description' => 'Authenticated download route (bearer token required)'],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['description' => 'No file, or the file was refused (empty, too big, a type not taken, or content that does not match its name) — `errors.document` says which', ...$json(['$ref' => '#/components/schemas/Error'])],
                    '500' => ['description' => 'The file was accepted but could not be stored (logged server-side; try again)'],
                ],
            ],
        ],
        '/api/portal/appointments' => [
            'get' => [
                'tags'       => ['Portal'],
                'summary'    => "The patient's own appointments",
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string'], 'description' => 'Comma-separated statuses, e.g. `proposed` for follow-ups awaiting an answer (unknown values are ignored)'],
                    ['name' => 'when', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['upcoming', 'past']], 'description' => 'By time (see Appointment.phase): upcoming — still to come or live, soonest first (the Appointments page; per_page=1 is the dashboard\'s next appointment); past — over (completed, cancelled, missed or ended), newest first (History). With `when` the order is fixed. Any other non-empty value: 422 `errors.when`.'],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Appointment'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Book a consultation',
                'description' => 'The patient is taken from the token; the appointment is created with status pending. '
                    . 'Paid by card (`payment_reference`) or from the wallet; a free consultation (amount 0) books with no payment and no wallet posting. '
                    . 'The slot and the payment are taken in one transaction under the doctor\'s slot lock (availability re-checked there): a time taken meanwhile is 409 `errors.scheduled_at` with nothing booked or charged. '
                    . 'A card payment is the patient\'s pay-init payment for this doctor (and this follow-up, or none) and books once: a second use is 422 `errors.payment` "This payment has already been used." — '
                    . 'except a repeat of the booking it made (same patient, doctor and time, booking still open), answered 200 with that booking; '
                    . 'one paid above the price books and the difference goes to the wallet. A card payment for a booking that can no longer happen (the time, the doctor or the follow-up went) is credited to the wallet: `errors.card_payment = credited_to_wallet`, the message says how much. '
                    . 'Each of `document_ids` must be one of the patient\'s own documents and not attached to another appointment, else 422 (`document_ids.N`, N = its position in the request; another patient\'s id reads as not found). '
                    . 'They are linked in the transaction that stores the appointment, guarded so two bookings can never take the same file: the one that loses gets the same 422 and nothing is booked '
                    . '(nothing is charged; a card payment stays unused, so the booking can be retried with it). '
                    . 'A follow-up: `parent_appointment_id` is one of the patient\'s COMPLETED consultations with the same doctor (422 `errors.parent_appointment_id` when it is not theirs / not completed, `errors.specialist_id` when the doctor differs). '
                    . 'It is then booked as type follow_up, linked to it (`parent_appointment_id`, `proposed_by: patient`) and priced by the follow-up rules for its start time (see Pricing; plus any guest fees); payment, status and emails are as for any booking. '
                    . 'Price it first with GET /portal/appointments/{parentId}/follow-up/quote; a card payment uses pay-init with the same parent_appointment_id + scheduled_at.',
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['specialist_id', 'scheduled_at'],
                    'properties' => [
                        'specialist_id' => ['type' => 'string', 'format' => 'uuid'],
                        'scheduled_at'  => ['type' => 'string', 'format' => 'date-time'],
                        'type'          => ['type' => 'string', 'enum' => ['video', 'follow_up', 'urgent', 'routine'], 'default' => 'video', 'description' => 'Ignored (always follow_up) when parent_appointment_id is sent'],
                        'parent_appointment_id' => ['type' => 'string', 'format' => 'uuid', 'description' => 'Book a follow-up of this completed consultation (same doctor) at the follow-up price'],
                        'notes'         => ['type' => 'string', 'description' => 'Reason for the consultation'],
                        'document_ids'  => [
                            'type'        => 'array',
                            'description' => 'Up to 10 document ids from POST /portal/appointment-documents to attach to this booking.',
                            'maxItems'    => 10,
                            'items'       => ['type' => 'string', 'format' => 'uuid'],
                        ],
                        'document_url'  => ['type' => 'string', 'deprecated' => true, 'description' => 'Older clients: the `url` from POST /portal/appointment-documents, read as one document id. Ignored when `document_ids` is sent.'],
                        'document_share' => [
                            'type'        => 'object',
                            'description' => 'Who can see the attached files (send it whenever `document_ids` is sent; validated before any money moves — 422 `document_share.duration` / `show_specialist_ids.N`). '
                                . '`duration` non-null shares them with the booked doctor alone, until after this consultation (or with no end); null keeps them private. '
                                . 'Other doctors with a whole-folder share see them only when listed in `show_specialist_ids`. Reconciled in the booking\'s transaction: a refusal books nothing. '
                                . 'Without it (older clients) the files stay private. The 201 answer then carries `document_share: {outcome: shared | private | sharing_unavailable, grant_id, until_label_at}`.',
                            'properties'  => [
                                'duration'            => ['type' => 'string', 'nullable' => true, 'enum' => ['after_24h', 'after_7d', 'after_30d', 'indefinite', null]],
                                'show_specialist_ids' => ['type' => 'array', 'items' => ['type' => 'string', 'format' => 'uuid'], 'maxItems' => 20],
                            ],
                        ],
                        'payment_reference' => ['type' => 'string', 'description' => 'Paystack reference from pay-init, to pay by card instead of the wallet'],
                        'guests'        => [
                            'type'        => 'array',
                            'description' => 'Up to 3 invited third parties; each adds the guest fee to the amount and gets a stable id + Agora uid. Not the patient\'s or the doctor\'s email, none twice (422 `guests.N.email`); name ≤ 100 characters. Each is emailed their own link naming who invited them.',
                            'maxItems'    => 3,
                            'items'       => ['type' => 'object', 'required' => ['name', 'email'], 'properties' => ['name' => ['type' => 'string'], 'email' => ['type' => 'string', 'format' => 'email']]],
                        ],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Booked', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '200' => ['description' => 'Already booked with this card payment (a repeated request): that booking', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '409' => ['description' => 'That time was just taken (`errors.scheduled_at`); nothing booked or charged — a card payment made for it is credited to the wallet (`errors.card_payment`) or kept for another time', ...$json(['$ref' => '#/components/schemas/Error'])],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/pay-init' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Start a direct card payment for a consultation',
                'description' => 'Priced one of three ways: `{specialist_id, guest_count}` — a new booking (the doctor\'s fee + guest fees); '
                    . 'plus `{parent_appointment_id, scheduled_at}` — booking a follow-up of that completed consultation at the follow-up price (422 `errors.parent_appointment_id` / `errors.specialist_id` / `errors.scheduled_at` as for the booking); '
                    . '`{appointment_id, scheduled_at?}` — accepting the doctor\'s follow-up proposal (its price, or re-priced for the other slot `scheduled_at`; 422 `errors.appointment_id` when it is not the patient\'s proposal, `errors.status` when it has closed or expired or closes within 15 minutes (pay from the wallet instead), '
                    . '`errors.specialist_id` when the doctor can no longer be booked, `errors.scheduled_at` when the other slot is no longer open — all checked before the checkout starts). '
                    . 'Then send the returned `reference` as `payment_reference` to POST /portal/appointments or POST /portal/appointments/{id}/follow-up/accept. '
                    . 'The checkout is recorded first (who pays, for what, how much): the payment can pay only for that, once; one nothing uses is credited to the patient\'s wallet automatically (CARD_INTENT_CREDIT_AFTER_MINUTES, default 30). '
                    . 'A new booking may also send `scheduled_at` (kept for the record; another time with the same doctor can still use the payment). '
                    . 'A free consultation (amount 0) has nothing to charge: 422 with `errors.payment = "free"` — book / accept it directly.',
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'properties' => [
                        'specialist_id'         => ['type' => 'string', 'format' => 'uuid', 'description' => 'Required unless appointment_id is sent'],
                        'guest_count'           => ['type' => 'integer', 'minimum' => 0, 'maximum' => 3],
                        'parent_appointment_id' => ['type' => 'string', 'format' => 'uuid', 'description' => 'Booking a follow-up of this completed consultation'],
                        'appointment_id'        => ['type' => 'string', 'format' => 'uuid', 'description' => 'Accepting this follow-up proposal'],
                        'scheduled_at'          => ['type' => 'string', 'format' => 'date-time', 'description' => 'Required with parent_appointment_id; with appointment_id, another slot than the proposed one; optional for a new booking (recorded only)'],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Payment started', ...$json($envelope(['type' => 'object', 'properties' => [
                        'authorization_url' => ['type' => 'string'],
                        'access_code'       => ['type' => 'string'],
                        'reference'         => ['type' => 'string'],
                        'amount'            => ['type' => 'string', 'example' => '10000.00'],
                        'currency'          => ['type' => 'string', 'example' => 'NGN'],
                    ]]))],
                    '422' => ['description' => 'Validation failed, or the consultation is free (`errors.payment = "free"`)', ...$json(['$ref' => '#/components/schemas/Error'])],
                    '502' => ['description' => 'Paystack refused to start the payment'],
                    '503' => ['description' => 'Card payment not configured'],
                ],
            ],
        ],
        '/api/portal/card-payments/{reference}' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "Where one of the patient's own card payments stands",
                'description' => 'A pay-init `reference` of the signed-in patient (another patient\'s, or an unknown one: 404). A checkout not yet known to be paid is checked with Paystack first. '
                    . '`status`: `paid` — paid and not used yet: it can still pay for what it was made for, else it is credited to the wallet at `credit_due_at`; '
                    . '`not_paid` — Paystack shows nothing charged; `unconfirmed` — Paystack could not be asked just now (ask again later); '
                    . '`used` — it paid for something (`used_for`: the appointment, for a booking or follow-up); `credited_to_wallet` (`credited_amount`); `review` — held for support. '
                    . 'Lets the app offer "Complete your paid booking" after a reload only for a payment that was really made. Never cached.',
                'parameters'  => [['name' => 'reference', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'maxLength' => 100]]],
                'responses'   => [
                    '200' => ['description' => 'The payment', ...$json($envelope(['type' => 'object', 'properties' => [
                        'reference'            => ['type' => 'string'],
                        'status'               => ['type' => 'string', 'enum' => ['paid', 'not_paid', 'unconfirmed', 'used', 'credited_to_wallet', 'review']],
                        'purpose'              => ['type' => 'string', 'enum' => ['appointment_booking', 'follow_up_accept', 'guest_add']],
                        'amount'               => ['type' => 'string', 'example' => '10000.00', 'description' => 'What was paid (once confirmed), else what the checkout asked for'],
                        'currency'             => ['type' => 'string', 'example' => 'NGN'],
                        'specialist_id'        => ['type' => 'string', 'nullable' => true],
                        'used_for'             => ['type' => 'string', 'nullable' => true],
                        'credited_amount'      => ['type' => 'string', 'nullable' => true],
                        'credit_due_at'        => ['type' => 'string', 'format' => 'date-time', 'nullable' => true],
                        'credit_after_minutes' => ['type' => 'integer', 'example' => 30],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "One of the patient's own appointments",
                'description' => 'Adds `cancel_policy` {refund_percent, refund_amount, late_cancel_hours} while it can still be cancelled (can_cancel), else null: what cancelling now would refund (100%, or the late-cancellation share; guest fees always in full). '
                    . 'Adds `pending_document_request`: this doctor\'s pending request to see your documents (DocumentAccessRequestDto), else null.',
                'operationId' => 'portalGetAppointment',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['allOf' => [
                        ['$ref' => '#/components/schemas/Appointment'],
                        ['type' => 'object', 'properties' => ['cancel_policy' => ['type' => 'object', 'nullable' => true, 'properties' => [
                            'refund_percent'    => ['type' => 'integer', 'example' => 100],
                            'refund_amount'     => ['type' => 'string', 'example' => '15000.00'],
                            'late_cancel_hours' => ['type' => 'integer', 'example' => 0],
                        ]]]],
                    ]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/cancel' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Cancel one of the patient\'s own appointments',
                'description' => 'Cancels the booking and, if it was paid from the wallet, refunds the fee (guest fees included) and emails a receipt; each guest is emailed that it was cancelled (their links stop working). On a follow-up proposal (status proposed) it declines it instead, like POST .../follow-up/decline (message "Follow-up declined"). '
                    . 'Only before the start: 422 `errors.status` "This consultation has started" after it (its outcome is decided by completion or the missed rules), and on a completed / missed one. A confirmed booking cancelled inside the Booking settings\' late window (late_cancel_hours, 0 = off) refunds late_cancel_refund_pct of the fee (guest fees in full) — see GET .../{id} cancel_policy.',
                'operationId' => 'portalCancelAppointment',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'Cancelled', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/reschedule' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Reschedule one of the patient\'s own appointments',
                'description' => 'Moves the booking to a new, still-open slot (status rescheduled — the doctor confirms the new time; rescheduled_by patient) and notifies both parties; each guest is emailed the new time with their link. Any open booking (pending, confirmed, rescheduled), only before its start: 422 `errors.status` "This consultation has started" after it. A confirmed one inside the late-cancellation window (Booking settings late_cancel_hours > 0, unless the doctor moved it last): 422 `errors.status` "Too close to the start to move it" (the payload\'s `can_reschedule` is false then). 422 `errors.status` on a follow-up proposal — choose the other time when accepting it (POST .../follow-up/accept `scheduled_at`).',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['scheduled_at'],
                    'properties' => ['scheduled_at' => ['type' => 'string', 'format' => 'date-time']],
                ])],
                'responses'   => [
                    '200' => ['description' => 'Rescheduled', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '409' => ['description' => 'That time was just taken (`errors.scheduled_at`; re-checked under the doctor\'s slot lock) — nothing changed', ...$json(['$ref' => '#/components/schemas/Error'])],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/review' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Review a completed consultation (1–5 + comment)',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['rating'], 'properties' => ['rating' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 5], 'comment' => ['type' => 'string']]])],
                'responses'   => [
                    '201' => ['description' => 'Created'],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/confirm' => [
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Confirm a pending appointment (assigned doctor)',
                'description' => 'Moves the appointment to CONFIRMED and emails the patient. Only the assigned doctor may confirm, and only until 30 minutes after its slot ended (422 `errors.status` after that — the cron cancels it as not confirmed and refunds the patient, never before then). A follow-up proposal is confirmed only by the patient accepting it: 422 `errors.status`.',
                'operationId' => 'doctorConfirmAppointment',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'Confirmed', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/complete' => [
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'End a consultation: mark it completed (assigned doctor)',
                'description' => 'Moves a CONFIRMED appointment to COMPLETED, so it appears in the patient\'s and the doctor\'s history, can be reviewed and counts towards earnings. Audited (`appointment.completed`); the patient gets an in-app notification (linking to /dashboard/history/{id}) and an email, neither naming the reason for the visit or any medicine. Idempotent: an already-completed appointment answers 200 ("Consultation already completed") and nothing is recorded or sent again. 422 when the appointment is not confirmed (pending, rescheduled or cancelled; `errors.status`), or when it has not started — before its scheduled time while the doctor is not in the call (`errors.scheduled_at`). Visits a doctor forgets to end are closed by the reminders cron 12 hours after their slot when there is evidence they took place (`appointment.auto_completed`). Only the assigned doctor may complete.',
                'operationId' => 'doctorCompleteAppointment',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'Completed (or already completed)', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        // ----- Follow-ups -----
        '/api/doctor/appointments/{id}/follow-up' => [
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Propose a follow-up of consultation {id} (assigned doctor)',
                'description' => '{id} must be the doctor\'s consultation, COMPLETED or CONFIRMED and under way (from 2 hours before its start), else 422 `errors.status`; '
                    . 'only one proposal per consultation may await the patient (422 `errors.follow_up` — withdraw it first). '
                    . '`scheduled_at` must be one of the doctor\'s open slots under the booking rules (not blocked or taken; 422 `errors.scheduled_at`) and at least 2h30 from now (so the patient has 30 minutes to answer). '
                    . '`note` (≤ 1000 chars, 422 `errors.note`) is shown to the patient in the app only — never in emails or notifications. `waive_fee: true` makes it free. '
                    . 'Creates a follow_up appointment with status proposed, proposed_by doctor, parent_appointment_id = {id}, priced server-side (follow_up_pricing; see Pricing) and expires_at = the earlier of 2h before its start and 72h from now. '
                    . 'It holds the slot until it expires; nothing is charged until the patient accepts. Audited (`appointment.follow_up_proposed`); the patient gets an in-app notice and an email linking to /dashboard/appointments/{proposalId}.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid'], 'description' => 'The consultation to follow up']],
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['scheduled_at'],
                    'properties' => [
                        'scheduled_at' => ['type' => 'string', 'format' => 'date-time'],
                        'note'         => ['type' => 'string', 'maxLength' => 1000],
                        'waive_fee'    => ['type' => 'boolean', 'default' => false],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Proposed (the Appointment plus patient_name)', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/follow-up/quote' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Price a follow-up of consultation {id} before proposing it',
                'description' => 'Without `scheduled_at`, prices a follow-up starting now (it holds until `window_ends_at`). `waive=1` shows the waived (free) price. 422 `errors.status` when {id} cannot have a follow-up proposed yet; 422 `errors.scheduled_at` for an invalid or past time.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'scheduled_at', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date-time']],
                    ['name' => 'waive', 'in' => 'query', 'schema' => ['type' => 'boolean', 'default' => false]],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/FollowUpQuote']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/follow-up/withdraw' => [
            'post' => [
                'tags'        => ['Doctor'],
                'summary'     => 'Withdraw an unanswered follow-up proposal {id} (assigned doctor)',
                'description' => '{id} is the proposal itself. proposed → cancelled: the slot reopens, the patient gets an in-app notice and an email. Audited (`appointment.follow_up_withdrawn`). Idempotent: an already-closed proposal answers 200 ("Follow-up proposal already closed"). 422 `errors.status` once the patient has accepted it (cancel it with POST .../decline instead) or when {id} is not a proposal.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid'], 'description' => 'The proposal']],
                'responses'   => [
                    '200' => ['description' => 'Withdrawn', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/doctor/appointments/{id}/follow-ups' => [
            'get' => [
                'tags'        => ['Doctor'],
                'summary'     => 'The follow-ups of consultation {id} (any status), soonest first',
                'description' => 'Proposals (open, accepted, declined — with decline_reason — withdrawn, expired) and follow-ups the patient booked. Each row is an Appointment plus `patient_name`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/Appointment']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['$ref' => '#/components/responses/Forbidden'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/follow-up/accept' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => "Accept the doctor's follow-up proposal {id}",
                'description' => 'It must be the patient\'s, proposed and not expired (422 `errors.status` otherwise), with a doctor who can still be booked (422 `errors.specialist_id`). `scheduled_at` takes another open slot of the same doctor instead (re-checked: 422 `errors.scheduled_at`; re-priced for that date, keeping a waiver — see the quote). '
                    . 'A free follow-up is confirmed at once. Otherwise `payment_method` (422 `errors.payment_method`): `wallet` debits the wallet (too low → 422 `errors.wallet = "insufficient_funds"` with a top-up hint in `message`; nothing changes), '
                    . 'or `card` with the `payment_reference` from POST /portal/appointments/pay-init `{appointment_id, scheduled_at?}` (422 `errors.payment_reference` when missing, `errors.payment` when it does not verify or was already used or added to the wallet). '
                    . 'If a card payment was made but the acceptance is refused (`errors.status` / `errors.specialist_id` / `errors.scheduled_at` — it closed, or the doctor or the slot went, during the checkout), the amount paid is credited to the patient\'s wallet (once per reference), the message ends "Your card payment of ₦X has been added to your VideoMed wallet instead." and `errors.card_payment = "credited_to_wallet"` flags it — retry with `payment_method: wallet`. '
                    . 'A reference that is already in the wallet answers 422 `errors.payment` with the same flag. '
                    . 'The claim, the new time/price and the payment are stored in one transaction. If another acceptance won at the same moment, anything this request took that the follow-up doesn\'t carry is credited back to the wallet (and the message says so). '
                    . 'Then it is confirmed: the doctor gets an in-app notice, everyone gets their join-link email, and it is audited (`appointment.follow_up_accepted`). Idempotent: a repeat answers 200 ("Follow-up already accepted") without charging again; '
                    . 'a card payment a repeat brings that the follow-up wasn\'t confirmed with (paid on one device while it was accepted on another) is credited to the wallet, the message says so and `meta` is `{card_payment: "credited_to_wallet", credited_amount}`.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid'], 'description' => 'The proposal']],
                'requestBody' => ['required' => false, ...$json([
                    'type'       => 'object',
                    'properties' => [
                        'payment_method'    => ['type' => 'string', 'enum' => ['wallet', 'card'], 'description' => 'Required unless the follow-up is free'],
                        'payment_reference' => ['type' => 'string', 'description' => 'With card: the pay-init reference, once paid'],
                        'scheduled_at'      => ['type' => 'string', 'format' => 'date-time', 'description' => 'Another open slot of the same doctor'],
                    ],
                ])],
                'responses'   => [
                    '200' => ['description' => 'Confirmed (or already accepted; `meta.card_payment` when a second card payment went to the wallet)', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/follow-up/decline' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => "Decline the doctor's follow-up proposal {id}",
                'description' => 'proposed → cancelled (nothing was charged); the slot reopens and the doctor gets an in-app notice (never the reason). `reason` (≤ 500 chars, 422 `errors.reason`) is kept on the follow-up as decline_reason for the doctor. Audited (`appointment.follow_up_declined`). Idempotent: an already-closed proposal answers 200; 422 `errors.status` once accepted (cancel it instead) or when {id} is not a proposal.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid'], 'description' => 'The proposal']],
                'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => ['reason' => ['type' => 'string', 'maxLength' => 500]]])],
                'responses'   => [
                    '200' => ['description' => 'Declined', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/follow-up/quote' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => 'Price a follow-up before paying',
                'description' => 'When {id} is one of the patient\'s completed consultations: booking a follow-up of it (with that doctor) starting at `scheduled_at` (default now — the price holds until `window_ends_at`). '
                    . 'When {id} is an open follow-up proposal: accepting it — at the proposed time the doctor\'s price stands; another `scheduled_at` is re-priced for that date (a waiver is kept). '
                    . '422 `errors.parent_appointment_id` when the consultation is not completed, `errors.status` when the proposal has closed or expired, `errors.scheduled_at` for an invalid or past time.',
                'parameters'  => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'scheduled_at', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date-time']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/FollowUpQuote']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/follow-ups' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => 'The follow-ups of one of the patient\'s consultations (any status), soonest first',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/Appointment']]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/public/call/{token}/presence' => [
            'post' => [
                'tags'        => ['Call'],
                'summary'     => 'Call-screen heartbeat (join token): {state: in|out}',
                'description' => 'Every ~15 s while in the call ("out" on leaving; `?state=out` works for unload-time requests). A guest is tracked by their guest id; their first heartbeat records `joined_at`, and each (re)join is audited (`call.guest_joined`, guest id only). '
                    . 'An "in" answers `{state, presence: CallPresence, participants: CallParticipant[]}` plus, to a guest, `consent` (GuestConsentState — when it turns `required` and not `given`, e.g. the patient agreed to recording mid-call, ask the guest: recording waits for them) — so a call screen can label a new uid and show live states — or refuses like joining (410 cancelled / ended / withdrawn — leave the call; 409 not confirmed; 425 before a guest\'s window opens), without the end of the guest window (a call that runs over keeps its guests for at most 3 hours more). "out" is always 200 `{state}`.',
                'security'    => [],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'object', 'properties' => [
                        'state'        => ['type' => 'string', 'enum' => ['in', 'out']],
                        'presence'     => ['$ref' => '#/components/schemas/CallPresence'],
                        'participants' => ['type' => 'array', 'items' => ['$ref' => '#/components/schemas/CallParticipant']],
                        'consent'      => ['$ref' => '#/components/schemas/GuestConsentState'],
                    ]]))],
                    '401' => ['description' => 'Invalid or expired join link'],
                    '403' => ['description' => 'The doctor may not practise (`doctor_suspended` | `doctor_not_approved`, or `terms_required` before the consultation\'s start time)', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '409' => ['description' => 'Not confirmed yet', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '410' => ['description' => 'Cancelled, ended or withdrawn — leave the call', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '425' => ['description' => 'A guest\'s window has not opened yet (`too_early`)', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                ],
            ],
        ],
        '/api/portal/appointments/presence' => [
            'get' => ['tags' => ['Portal'], 'summary' => 'Who is in the call now, per appointment of the signed-in patient: {"<id>": CallPresence}', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized']]],
        ],
        '/api/portal/appointments/{id}/presence' => [
            'post' => ['tags' => ['Portal'], 'summary' => 'Patient call-screen heartbeat: {state: in|out}; an "in" answers {state, presence: CallPresence, participants: CallParticipant[]}', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '404' => ['description' => 'Not found']]],
        ],
        '/api/doctor/appointments/presence' => [
            'get' => ['tags' => ['Doctor'], 'summary' => 'Who is in the call now, per consultation of the signed-in doctor: {"<id>": CallPresence} (guests by guest id)', 'responses' => ['200' => ['description' => 'OK'], '401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Not a doctor login']]],
        ],
        '/api/portal/notifications' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "The patient's notifications",
                'description' => 'Newest first; `meta.unread` is the unread count and `meta.counts` is `{total, unread}` for every type (appointment, prescription, payment, message, system) across the whole account, for the filter tabs. `?unread=true` filters to unread, `?type=` to one type (an unknown type is ignored), and `?before=` (a `created_at`) lists only that moment and older — for "load more" that does not shift as notifications arrive or are read.',
                'operationId' => 'portalNotifications',
                'parameters'  => [
                    ...$paginationParams,
                    ['name' => 'unread', 'in' => 'query', 'schema' => ['type' => 'boolean']],
                    ['name' => 'type', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['appointment', 'prescription', 'payment', 'message', 'system']]],
                    ['name' => 'before', 'in' => 'query', 'schema' => ['type' => 'string', 'format' => 'date-time']],
                ],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Notification'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/portal/notifications/read-all' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Mark all notifications read',
                'operationId' => 'portalNotificationsReadAll',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'object', 'properties' => ['unread' => ['type' => 'integer', 'example' => 0]]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/portal/notifications/{id}/read' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Mark one notification read',
                'operationId' => 'portalNotificationRead',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Notification']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/call-token' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => 'Agora RTC token for the consultation call',
                'description' => 'Channel is the appointment id; the token is a publisher token for uid 1 (the patient) valid for 1 hour — call again to renew. `participants` names everyone who may be in the call by uid (names only), so each tile can be labelled. 422 (`errors.status = "proposed"`) for a follow-up proposal not accepted yet; 410 for a cancelled, completed or missed consultation (as joining refuses it).',
                'operationId' => 'portalCallToken',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'Token issued', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'app_id'       => ['type' => 'string'],
                            'channel'      => ['type' => 'string'],
                            'uid'          => ['type' => 'integer', 'example' => 1],
                            'token'        => ['type' => 'string'],
                            'expires_in'   => ['type' => 'integer', 'example' => 3600],
                            'participants' => ['type' => 'array', 'items' => ['$ref' => '#/components/schemas/CallParticipant']],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '410' => ['description' => 'No call any more: cancelled (`errors.code` cancelled) or completed / missed (`errors.code` ended)', ...$json(['$ref' => '#/components/schemas/CallRefusal'])],
                    '422' => ['description' => 'A follow-up proposal not accepted yet (`errors.status = "proposed"`)', ...$json(['$ref' => '#/components/schemas/Error'])],
                    '503' => ['description' => 'Video calling not configured'],
                ],
            ],
        ],
    ],
    'security' => [['bearerAuth' => []]],
];
