<?php

declare(strict_types=1);

/**
 * OpenAPI paths of the doctor applications (spec §3.2, §3.3), merged into
 * config/openapi.php's `paths`. The applicant routes need no account: drafts
 * use a draft token (`application_draft`, 4 h), the status page an access
 * token (`application_access`, 30 min), both as Bearer. Coded errors carry
 * `errors.code` (and extras such as `reference`, `attempts_left`, `steps`,
 * `retry_after`). Schemas mirror libs/shared/models/src/lib/doctor-application.ts.
 */
return static function (callable $envelope, callable $json, callable $paginated): array {
    $tag     = ['Doctor applications'];
    $obj     = ['type' => 'object'];
    $ok      = static fn (string $what) => ['description' => $what, ...$json($envelope($obj))];
    $coded   = static fn (string $what) => ['description' => $what, ...$json(['$ref' => '#/components/schemas/Error'])];
    $id      = ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']];
    $docId   = ['name' => 'docId', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']];
    $section = ['name' => 'section', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['personal', 'professional', 'licence', 'qualifications', 'indemnity', 'consent']]];
    $draft   = [['applicantDraft' => []]];
    $access  = [['applicantAccess' => []]];
    $none    = [];
    $file    = ['description' => 'The file (inline, no-store, nosniff)', 'content' => ['application/pdf' => ['schema' => ['type' => 'string', 'format' => 'binary']], 'image/*' => ['schema' => ['type' => 'string', 'format' => 'binary']]]];
    $upload  = ['required' => true, 'content' => ['multipart/form-data' => ['schema' => ['type' => 'object', 'required' => ['slot', 'file'], 'properties' => [
        'slot' => ['type' => 'string', 'enum' => ['mdcn_certificate', 'good_standing_certificate', 'government_id', 'medical_degree', 'practising_licence', 'curriculum_vitae', 'indemnity_certificate', 'additional']],
        'file' => ['type' => 'string', 'format' => 'binary', 'description' => 'PDF, PNG or JPG, up to 5MB'],
    ]]]]];
    $body    = static fn (array $props, array $required = []) => ['required' => true, ...$json(['type' => 'object', 'required' => $required, 'properties' => $props])];
    $op      = static fn (string $summary, string $operationId, array $responses, array $security, array $extra = []) => [
        'tags' => $tag, 'summary' => $summary, 'operationId' => $operationId, 'security' => $security, 'responses' => $responses,
    ] + $extra;
    $staff   = static fn (string $summary, string $operationId, array $responses, array $extra = []) => [
        'tags' => $tag, 'summary' => $summary . ' (`specialists.manage`)', 'operationId' => $operationId,
        'responses' => $responses + ['401' => ['$ref' => '#/components/responses/Unauthorized'], '403' => ['description' => 'Missing specialists.manage']],
    ] + $extra;
    $p = '/api/public/doctor-applications';

    return [
        $p . '/config' => ['get' => $op('Applicant site settings (consent version, upload limits, doctor portal, SMS on/off, legal links)', 'docAppConfig', ['200' => $ok('ApplicationConfigDto')], $none)],
        $p . '/drafts' => ['post' => $op('Create a draft from step 1 (email required even when partial); emails the resume link + code after the response', 'docAppCreateDraft', [
            '201' => $ok('CreateDraftResultDto'), '422' => $coded('Field errors'), '429' => $coded('rate_limited'),
        ], $none, ['requestBody' => $body(['licence_route' => ['type' => 'string', 'enum' => ['ng', 'abroad']], 'personal' => $obj, 'partial' => ['type' => 'boolean']], ['licence_route', 'personal'])])],
        $p . '/drafts/resume' => ['post' => $op('Resume with email + 6-character draft code', 'docAppResume', [
            '200' => $ok('DraftSessionDto'), '422' => $coded('resume_invalid'), '429' => $coded('resume_locked'), '503' => $coded('codes_unavailable'),
        ], $none, ['requestBody' => $body(['email' => ['type' => 'string'], 'draft_code' => ['type' => 'string']], ['email', 'draft_code'])])],
        $p . '/drafts/resume-link' => ['post' => $op('Resume with the token from the emailed link (#t=…)', 'docAppResumeLink', [
            '200' => $ok('DraftSessionDto'), '422' => $coded('link_invalid'),
        ], $none, ['requestBody' => $body(['token' => ['type' => 'string']], ['token'])])],
        $p . '/drafts/resend' => ['post' => $op('Lost the email: always 202 with the same message', 'docAppResend', ['202' => $ok('Accepted')], $none, [
            'requestBody' => $body(['email' => ['type' => 'string']], ['email']),
        ])],
        $p . '/drafts/current' => [
            'get'    => $op('The draft', 'docAppGetDraft', ['200' => $ok('ApplicationDraftDto'), '401' => $coded('applicant_token_invalid'), '404' => $coded('draft_not_found'), '409' => $coded('draft_submitted')], $draft),
            'patch'  => $op('Change the licence route (clears licence details + certificate)', 'docAppChangeRoute', ['200' => $ok('ApplicationDraftDto'), '422' => $coded('licence_route')], $draft, [
                'requestBody' => $body(['licence_route' => ['type' => 'string', 'enum' => ['ng', 'abroad']]], ['licence_route']),
            ]),
            'delete' => $op('Cancel the draft (files + details deleted)', 'docAppDiscard', ['200' => $ok('{deleted: true}')], $draft),
        ],
        $p . '/drafts/current/sections/{section}' => ['put' => $op('Save a section (`partial` for Save & continue later)', 'docAppSaveSection', [
            '200' => $ok('ApplicationDraftDto'), '409' => $coded('consent_outdated'), '422' => $coded('Field errors'),
        ], $draft, ['parameters' => [$section], 'requestBody' => $body(['values' => $obj, 'partial' => ['type' => 'boolean']], ['values'])])],
        $p . '/drafts/current/documents' => ['post' => $op('Upload a document (replaces the slot\'s)', 'docAppUpload', [
            '201' => $ok('ApplicationDocumentDto'), '422' => $coded('file_invalid | upload_limit | upload_slot_invalid'), '503' => $coded('storage_unavailable'),
        ], $draft, ['requestBody' => $upload])],
        $p . '/drafts/current/documents/{docId}' => ['delete' => $op('Remove a document', 'docAppDeleteDocument', ['200' => $ok('{deleted: true}'), '404' => ['$ref' => '#/components/responses/NotFound']], $draft, ['parameters' => [$docId]])],
        $p . '/drafts/current/documents/{docId}/file' => ['get' => $op('A document\'s file', 'docAppDocumentFile', ['200' => $file, '404' => ['$ref' => '#/components/responses/NotFound']], $draft, ['parameters' => [$docId]])],
        $p . '/drafts/current/resume-email' => ['post' => $op('Save & continue later: a new link + code by email', 'docAppResumeEmail', [
            '202' => $ok('ResumeEmailSentDto'), '429' => $coded('resend_cooldown'), '503' => $coded('codes_unavailable'),
        ], $draft)],
        $p . '/drafts/current/email-code' => ['post' => $op('Send the confirm-email code', 'docAppEmailCode', [
            '200' => $ok('Already confirmed'), '202' => $ok('CodeSentDto'), '429' => $coded('resend_cooldown | rate_limited'), '503' => $coded('codes_unavailable'),
        ], $draft)],
        $p . '/drafts/current/email-verify' => ['post' => $op('Check the confirm-email code', 'docAppEmailVerify', [
            '200' => $ok('ApplicationDraftDto'), '422' => $coded('code_invalid | code_expired | code_locked'), '503' => $coded('codes_unavailable'),
        ], $draft, ['requestBody' => $body(['code' => ['type' => 'string']], ['code'])])],
        $p . '/drafts/current/submit' => ['post' => $op('Submit (idempotent)', 'docAppSubmit', [
            '200' => $ok('SubmittedApplicationDto'), '409' => $coded('email_unverified | duplicate_open_application | already_registered | consent_outdated'), '422' => $coded('incomplete (steps)'),
        ], $draft)],
        $p . '/track/start' => ['post' => $op('Status check: reference + email or phone (always the same shape)', 'docAppTrackStart', [
            '200' => $ok('TrackStartDto'), '422' => $coded('reference | contact'),
        ], $none, ['requestBody' => $body(['reference' => ['type' => 'string'], 'contact' => ['type' => 'string']], ['reference', 'contact'])])],
        $p . '/track/request-code' => ['post' => $op('Send a status code (always 202)', 'docAppTrackCode', [
            '202' => $ok('CodeSentDto'), '410' => $coded('track_expired'),
        ], $none, ['requestBody' => $body(['track_id' => ['type' => 'string'], 'channel' => ['type' => 'string', 'enum' => ['sms', 'email']]], ['track_id', 'channel'])])],
        $p . '/track/verify' => ['post' => $op('Check the status code → access token (30 min)', 'docAppTrackVerify', [
            '200' => $ok('TrackSessionDto'), '410' => $coded('track_expired'), '422' => $coded('code_invalid | code_expired | code_locked'),
        ], $none, ['requestBody' => $body(['track_id' => ['type' => 'string'], 'code' => ['type' => 'string']], ['track_id', 'code'])])],
        $p . '/track/status' => ['get' => $op('The status page', 'docAppStatus', ['200' => $ok('ApplicationStatusDto'), '401' => $coded('applicant_token_invalid')], $access)],
        $p . '/track/application' => ['get' => $op('Sections, active documents and the open request (respond page)', 'docAppApplicantApplication', ['200' => $ok('ApplicantApplicationDto')], $access)],
        $p . '/track/info-response/sections/{section}' => ['put' => $op('Update a requested section', 'docAppInfoSection', [
            '200' => $ok('ApplicantApplicationDto'), '403' => $coded('item_not_requested'), '409' => $coded('not_allowed'), '422' => $coded('Field errors'),
        ], $access, ['parameters' => [$section], 'requestBody' => $body(['values' => $obj], ['values'])])],
        $p . '/track/info-response/documents' => ['post' => $op('Upload a requested document', 'docAppInfoUpload', [
            '201' => $ok('ApplicationDocumentDto'), '403' => $coded('item_not_requested'), '409' => $coded('not_allowed'), '422' => $coded('file_invalid | upload_limit'), '503' => $coded('storage_unavailable'),
        ], $access, ['requestBody' => $upload])],
        $p . '/track/info-response/documents/{docId}' => ['delete' => $op('Remove a document sent in this response', 'docAppInfoDelete', ['200' => $ok('{deleted: true}'), '404' => ['$ref' => '#/components/responses/NotFound']], $access, ['parameters' => [$docId]])],
        $p . '/track/info-response/submit' => ['post' => $op('Send the requested items (back to Under review)', 'docAppInfoSubmit', [
            '200' => $ok('ApplicationStatusDto'), '409' => $coded('not_allowed'), '422' => $coded('incomplete (items)'),
        ], $access, ['requestBody' => $body(['note' => ['type' => 'string', 'maxLength' => 1000, 'nullable' => true]])])],
        $p . '/track/documents/{docId}/file' => ['get' => $op('An active document\'s file', 'docAppTrackFile', ['200' => $file, '404' => ['$ref' => '#/components/responses/NotFound']], $access, ['parameters' => [$docId]])],
        $p . '/track/withdraw' => ['post' => $op('Withdraw (while open)', 'docAppWithdraw', [
            '200' => $ok('ApplicationStatusDto'), '409' => $coded('not_allowed'), '422' => $coded('confirm'),
        ], $access, ['requestBody' => $body(['confirm' => ['type' => 'boolean'], 'reason' => ['type' => 'string', 'nullable' => true, 'enum' => ['accepted_other_role', 'apply_later', 'made_mistake', 'not_right_for_me', 'other', null]]], ['confirm'])])],

        // ----- Staff -----
        '/api/doctor-applications' => ['get' => $staff('List applications (never drafts)', 'docAppList', ['200' => ['description' => 'OK', ...$json(['type' => 'object'])]], ['parameters' => [
            ['name' => 'q', 'in' => 'query', 'schema' => ['type' => 'string']],
            ['name' => 'filter', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['all', 'needs_action', 'submitted', 'under_review', 'more_info_needed', 'interview_scheduled', 'approved', 'rejected', 'withdrawn']]],
            ['name' => 'route', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['ng', 'abroad']]],
            ['name' => 'sort', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['waiting', 'newest', 'interview']]],
            ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
            ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 50]],
        ]])],
        '/api/doctor-applications/queue' => ['get' => $staff('Badge + filter counts (not cached)', 'docAppQueue', ['200' => $ok('DoctorApplicationQueueDto')])],
        '/api/doctor-applications/{id}' => ['get' => $staff('Detail, actions and approval preview (a draft is 404)', 'docAppDetail', ['200' => $ok('DoctorApplicationDetailDto'), '404' => ['$ref' => '#/components/responses/NotFound']], ['parameters' => [$id]])],
        '/api/doctor-applications/{id}/documents/{docId}/file' => ['get' => $staff('A document (every view audited)', 'docAppStaffFile', ['200' => $file, '404' => ['$ref' => '#/components/responses/NotFound']], ['parameters' => [$id, $docId]])],
        '/api/doctor-applications/{id}/start-review' => ['post' => $staff('Start or resume the review', 'docAppStartReview', ['200' => $ok('DoctorApplicationDetailDto'), '409' => $coded('status_changed | not_allowed')], ['parameters' => [$id], 'requestBody' => $body(['expected_status' => ['type' => 'string']])])],
        '/api/doctor-applications/{id}/request-info' => ['post' => $staff('Request more information (cancels a scheduled interview)', 'docAppRequestInfo', ['200' => $ok('DoctorApplicationDetailDto'), '409' => $coded('status_changed | not_allowed'), '422' => $coded('message | items')], ['parameters' => [$id], 'requestBody' => $body([
            'expected_status' => ['type' => 'string'], 'message' => ['type' => 'string', 'maxLength' => 2000], 'items' => ['type' => 'array', 'items' => $obj, 'minItems' => 1, 'maxItems' => 10],
        ], ['message', 'items'])])],
        '/api/doctor-applications/{id}/schedule-interview' => ['post' => $staff('Schedule or move the interview', 'docAppScheduleInterview', ['200' => $ok('DoctorApplicationDetailDto'), '409' => $coded('status_changed | not_allowed'), '422' => $coded('starts_at | duration_minutes | meeting_url | note')], ['parameters' => [$id], 'requestBody' => $body([
            'expected_status' => ['type' => 'string'], 'starts_at' => ['type' => 'string', 'description' => 'ISO 8601 WITH offset'], 'duration_minutes' => ['type' => 'integer', 'enum' => [15, 30, 45, 60]],
            'meeting_url' => ['type' => 'string', 'description' => 'https only'], 'note' => ['type' => 'string', 'nullable' => true, 'maxLength' => 500],
        ], ['starts_at', 'duration_minutes', 'meeting_url'])])],
        '/api/doctor-applications/{id}/resend-interview' => ['post' => $staff('Send the interview details again', 'docAppResendInterview', ['200' => $ok('DoctorApplicationDetailDto'), '409' => $coded('not_allowed'), '429' => $coded('resend_cooldown')], ['parameters' => [$id]])],
        '/api/doctor-applications/{id}/approve' => ['post' => $staff('Approve: create the doctor (invited) with verified documents; email the set-password link', 'docAppApprove', [
            '200' => $ok('ApproveApplicationResultDto'), '409' => $coded('status_changed | not_allowed'), '422' => $coded('attest | consultation_fee | specialty | email | documents.{id}.{field}'), '503' => $coded('storage_unavailable'),
        ], ['parameters' => [$id], 'requestBody' => $body([
            'expected_status' => ['type' => 'string'], 'attest' => ['type' => 'boolean'], 'consultation_fee' => ['type' => 'string'], 'specialty' => ['type' => 'string'], 'documents' => $obj,
        ], ['attest', 'consultation_fee', 'documents'])])],
        '/api/doctor-applications/{id}/reject' => ['post' => $staff('Reject with a reason shown to the applicant', 'docAppReject', ['200' => $ok('DoctorApplicationDetailDto'), '409' => $coded('status_changed | not_allowed'), '422' => $coded('reason')], ['parameters' => [$id], 'requestBody' => $body([
            'expected_status' => ['type' => 'string'], 'reason' => ['type' => 'string', 'maxLength' => 2000],
        ], ['reason'])])],
        '/api/doctor-applications/{id}/notes' => [
            'get'  => $staff('Internal notes, newest first', 'docAppNotes', ['200' => $ok('DoctorApplicationNoteDto[]')], ['parameters' => [$id]]),
            'post' => $staff('Add an internal note', 'docAppAddNote', ['201' => $ok('DoctorApplicationNoteDto'), '422' => $coded('body')], ['parameters' => [$id], 'requestBody' => $body(['body' => ['type' => 'string', 'maxLength' => 4000]], ['body'])]),
        ],
    ];
};
