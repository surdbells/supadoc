<?php

declare(strict_types=1);

/**
 * OpenAPI paths of the laboratory & diagnostics requests (lab spec §2), merged
 * into config/openapi.php's `paths`. Schemas mirror
 * libs/shared/models/src/lib/lab-request.ts. Every answer is `Cache-Control:
 * no-store`; coded errors carry `errors.code` (and `errors.status` — the
 * effective status — on `status_changed`).
 */
return static function (callable $envelope, callable $json, callable $paginated): array {
    $tag     = ['Lab requests'];
    $obj     = ['type' => 'object'];
    $uuid    = ['type' => 'string', 'format' => 'uuid'];
    $ok      = static fn (string $what) => ['description' => $what, ...$json($envelope($obj))];
    $coded   = static fn (string $what) => ['description' => $what, ...$json(['$ref' => '#/components/schemas/Error'])];
    $labId   = ['name' => 'labId', 'in' => 'path', 'required' => true, 'schema' => $uuid];
    $result  = ['name' => 'resultId', 'in' => 'path', 'required' => true, 'schema' => $uuid];
    $body    = static fn (array $props, array $required = []) => ['required' => true, ...$json(['type' => 'object', 'required' => $required, 'properties' => $props])];
    $auth    = ['401' => ['$ref' => '#/components/responses/Unauthorized']];
    $limited = ['429' => ['$ref' => '#/components/responses/TooManyRequests']];
    $doctor  = static fn (string $summary, string $operationId, array $responses, array $extra = []) => [
        'tags' => $tag, 'summary' => $summary, 'operationId' => $operationId,
        'responses' => $responses + $auth + ['403' => ['description' => 'Not a doctor profile, or the doctor may not do clinical work now (`errors.code` doctor_suspended / doctor_not_approved / terms_required)']],
    ] + $extra;
    $patient = static fn (string $summary, string $operationId, array $responses, array $extra = []) => [
        'tags' => $tag, 'summary' => $summary, 'operationId' => $operationId, 'responses' => $responses + $auth,
    ] + $extra;
    $staff   = static fn (string $permission, string $summary, string $operationId, array $responses, array $extra = []) => [
        'tags' => $tag, 'summary' => $summary . ' (`' . $permission . '`)', 'operationId' => $operationId,
        'responses' => $responses + $auth + ['403' => ['description' => 'Missing ' . $permission]],
    ] + $extra;
    $statusChanged = $coded('`status_changed` (message by effective status; `errors.status`)');
    $notFound      = $coded('Lab request not found (another owner\'s reads the same)');
    $link          = $ok('LabRequestLinkDto {url, expires_at, filename}: a 15-minute signed link to the PDF');
    $download      = ['required' => false, ...$json(['type' => 'object', 'properties' => ['download' => ['type' => 'boolean']]])];
    $listParams    = [
        ['name' => 'group', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['all', 'awaiting_patient', 'in_progress', 'result_ready']]],
        ['name' => 'appointment_id', 'in' => 'query', 'schema' => $uuid],
        ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 1]],
        ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 20, 'maximum' => 100]],
    ];
    $d = '/api/doctor/lab-requests';
    $p = '/api/portal/lab-requests';

    return [
        // ----- Doctor -----
        $d . '/options' => ['get' => $doctor('The composer\'s lists (LabOptionsDto): catalogue version and active items, specimens, sites, preparations, priorities, purposes, infection alerts, mobility, limits, has_signature', 'labOptions', ['200' => $ok('LabOptionsDto')])],
        $d . '/patients' => ['get' => $doctor('Patients this doctor has consulted (LabPatientPickDto: name, email, reference "P-XXXXXXXX", last_visit), most recent visit first', 'labPatients', ['200' => $ok('LabPatientPickDto[] + meta {total, page, per_page, total_pages}')], [
            'parameters' => [['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']], ['name' => 'page', 'in' => 'query', 'schema' => ['type' => 'integer']], ['name' => 'per_page', 'in' => 'query', 'schema' => ['type' => 'integer']]],
        ])],
        $d . '/context' => ['get' => $doctor('Who the form is for (LabRequestContextDto): patient, ask_pregnancy, medication / allergy pre-fill, consultation', 'labContext', [
            '200' => $ok('LabRequestContextDto'),
            '422' => $coded('`not_consulted` (on patient_id), or `appointment_id`: "This consultation is not yours" / "This consultation is with another patient." / "This consultation hasn\'t taken place yet."'),
        ], ['parameters' => [['name' => 'patient_id', 'in' => 'query', 'required' => true, 'schema' => $uuid], ['name' => 'appointment_id', 'in' => 'query', 'schema' => $uuid]]])],
        $d => [
            'get'  => $doctor('The doctor\'s own requests, most recent activity first (effective status; `unreviewed_count` counts only results the doctor can open now). `meta.counts` has every group\'s count (honouring q / appointment_id / patient_id, not group)', 'labList', [
                '200' => $ok('LabRequestSummaryDto[] + meta {total, page, per_page, total_pages, counts}'),
                '422' => $coded('`group` "Unknown filter"'),
            ], ['parameters' => [...$listParams, ['name' => 'q', 'in' => 'query', 'schema' => ['type' => 'string', 'maxLength' => 100], 'description' => 'Patient name, request number or a test'], ['name' => 'patient_id', 'in' => 'query', 'schema' => $uuid]]]),
            'post' => $doctor('Sign and send a lab request (no drafts; numbered GVM-REQ-YYYYMMDD-NNNNN)', 'labSend', [
                '201' => $ok('LabRequestDto "Request sent"'),
                '200' => $ok('LabRequestDto "Request already sent" — the same form key and the same details (nothing written)'),
                '409' => $coded('`idempotency_conflict` (the form key was sent with other details) or `catalogue_changed` (`errors.catalogue_version`)'),
                '422' => $coded('"Complete the request before sending" with every field error; `not_consulted`; `appointment_id`; `duplicated_from` "This request is for another patient."'),
            ] + $limited, ['requestBody' => $body([
                'client_key'        => ['type' => 'string', 'format' => 'uuid', 'description' => 'uuid v4; a new one per patient and after any 409'],
                'catalogue_version' => ['type' => 'string', 'example' => '2026-11.1'],
                'patient_id'        => $uuid,
                'appointment_id'    => $uuid + ['nullable' => true],
                'duplicated_from'   => $uuid + ['nullable' => true],
                'priority'          => ['type' => 'string', 'enum' => ['routine', 'urgent', 'stat']],
                'purpose'           => ['type' => 'string', 'enum' => ['diagnosis', 'monitoring', 'screening', 'pre_operative'], 'nullable' => true],
                'clinical_question' => ['type' => 'string', 'minLength' => 3, 'maxLength' => 200],
                'history'           => ['type' => 'string', 'maxLength' => 500],
                'medication'        => ['type' => 'string', 'maxLength' => 500],
                'allergies'         => ['type' => 'string', 'maxLength' => 500],
                'clinical'          => $obj + ['description' => '{fasting, fasting_hours (1–24 when fasting), pregnant (required when asked and imaging is requested), weeks_pregnant (1–42 when pregnant), infection_alerts[], transfusion_3m}'],
                'items'             => ['type' => 'array', 'minItems' => 1, 'maxItems' => 20, 'items' => ['type' => 'object', 'properties' => ['code' => ['type' => 'string'], 'specimen_mode' => ['type' => 'string', 'enum' => ['auto', 'manual']], 'specimen_code' => ['type' => 'string'], 'preparation_code' => ['type' => 'string']]]],
                'imaging_safety'    => $obj + ['nullable' => true, 'description' => '{contrast_allergy: yes|no, mobility: walking|chair|bed|portable} — required with an imaging study'],
                'attest'            => ['type' => 'boolean', 'enum' => [true]],
                'signature'         => $obj + ['description' => '{mode: saved} or {mode: drawn, image: data URL, save?: bool}'],
            ], ['client_key', 'catalogue_version', 'patient_id', 'priority', 'clinical_question', 'items', 'attest', 'signature'])]),
        ],
        $d . '/{labId}' => ['get' => $doctor('The requesting doctor\'s view (LabRequestDto): the request as sent, timeline, results as far as the access policy lets this doctor see them now', 'labGet', [
            '200' => $ok('LabRequestDto'), '404' => $notFound,
        ], ['parameters' => [$labId]])],
        $d . '/{labId}/cancel' => ['post' => $doctor('Cancel (awaiting consent, booked or in the lab); the patient is told', 'labCancel', [
            '200' => $ok('LabRequestDto "Request cancelled"'), '404' => $notFound, '409' => $statusChanged, '422' => $coded('`reason` "Tell the patient why you\'re cancelling" (3–500)'),
        ], ['parameters' => [$labId], 'requestBody' => $body(['reason' => ['type' => 'string', 'minLength' => 3, 'maxLength' => 500]], ['reason'])])],
        $d . '/{labId}/link' => ['post' => $doctor('A signed link to the request PDF (watermarked NOT YET ACCEPTED while the patient hasn\'t answered)', 'labDoctorLink', [
            '200' => $link, '404' => $notFound,
        ] + $limited, ['parameters' => [$labId], 'requestBody' => $download])],
        $d . '/{labId}/results/{resultId}/review' => ['post' => $doctor('Review a result Normal / Abnormal (a note is required for Abnormal; reviews can be changed); the patient is told — never the outcome', 'labReview', [
            '200' => $ok('LabRequestDto "Review saved"'),
            '404' => $notFound,
            '409' => $coded('`not_shared` (not visible to you now), `not_viewable` (a file type VideoMed can\'t open, e.g. Word / DICOM) or `status_changed`'),
            '422' => $coded('`outcome` "Choose Normal or Abnormal"; `comment` "Add a note for the patient" / "Use 1,000 characters or fewer"'),
        ], ['parameters' => [$labId, $result], 'requestBody' => $body(['outcome' => ['type' => 'string', 'enum' => ['normal', 'abnormal']], 'comment' => ['type' => 'string', 'maxLength' => 1000]], ['outcome'])])],
        $d . '/{labId}/results/{resultId}/file' => ['get' => $doctor('View one result in the view-only viewer (the consultation document contract)', 'labResultFile', [
            '200' => ['description' => 'File (inline)', 'headers' => [
                'X-SD-View-Ref'  => ['schema' => ['type' => 'string', 'example' => 'VM-7F3A2C1D'], 'description' => 'This view\'s reference (watermarked, cited by a print)'],
                'X-SD-Viewed-At' => ['schema' => ['type' => 'string', 'format' => 'date-time']],
            ]],
            '404' => $coded('Lab request not found, or `not_shared` — nothing recorded'),
            '409' => $coded('`update_required` — no `X-SD-Viewer` header (an old tab); nothing recorded'),
            '415' => $coded('`not_viewable` — nothing streamed or recorded'),
            '503' => $coded('`view_unavailable` — the view could not be recorded, so nothing was streamed'),
        ], ['parameters' => [$labId, $result, ['name' => 'X-SD-Viewer', 'in' => 'header', 'required' => true, 'schema' => ['type' => 'string', 'enum' => ['1']], 'description' => 'Sent only by the view-only viewer']]])],
        $d . '/{labId}/results/{resultId}/printed' => ['post' => $doctor('Record a print of a result you are viewing (audit `document.printed` + the patient\'s ledger); allowed while you owe new terms', 'labResultPrinted', [
            '200' => $ok('{recorded: true}'), '404' => $coded('Lab request not found, or `not_shared`'), '503' => $coded('`view_unavailable`'),
        ], ['parameters' => [$labId, $result], 'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => ['view_ref' => ['type' => 'string', 'example' => 'VM-7F3A2C1D']]])]])],

        // ----- Patient -----
        $p => ['get' => $patient('My lab requests, most recent activity first (no test names); `meta.counts` per group', 'labMine', [
            '200' => $ok('PatientLabRequestSummaryDto[] + meta {…, counts}'), '422' => $coded('`group` "Unknown filter"'),
        ], ['parameters' => $listParams])],
        $p . '/{labId}' => ['get' => $patient('One of my lab requests (PatientLabRequestDto): tests, preparation, consent statements, results and the doctor\'s notes — never a review outcome', 'labMineOne', [
            '200' => $ok('PatientLabRequestDto'), '404' => $notFound,
        ], ['parameters' => [$labId]])],
        $p . '/{labId}/accept' => ['post' => $patient('Accept: consent to the tests, paying the lab and the PDF\'s clinical details, plus the share choice', 'labAccept', [
            '200' => $ok('PatientLabRequestDto "Request accepted"'),
            '404' => $notFound,
            '409' => $coded('`consent_changed` (`errors.consent_version`), `status_changed` or `expired`'),
            '422' => $coded('`agree` "Tick the three required boxes to accept."; `lab_name` (≤ 120); `lab_date` (from clinic yesterday to valid_until)'),
        ], ['parameters' => [$labId], 'requestBody' => $body([
            'consent_version'  => ['type' => 'string', 'example' => 'LAB-2026-11.1'],
            'agree_tests'      => ['type' => 'boolean'],
            'agree_pays_lab'   => ['type' => 'boolean'],
            'agree_disclosure' => ['type' => 'boolean'],
            'share_results'    => ['type' => 'boolean'],
            'lab_name'         => ['type' => 'string', 'maxLength' => 120, 'nullable' => true],
            'lab_date'         => ['type' => 'string', 'format' => 'date', 'nullable' => true],
        ], ['consent_version', 'agree_tests', 'agree_pays_lab', 'agree_disclosure'])])],
        $p . '/{labId}/decline' => ['post' => $patient('Decline (reason optional, ≤ 500)', 'labDecline', [
            '200' => $ok('PatientLabRequestDto "Request declined"'), '404' => $notFound, '409' => $statusChanged, '422' => $coded('`reason`'),
        ], ['parameters' => [$labId], 'requestBody' => ['required' => false, ...$json(['type' => 'object', 'properties' => ['reason' => ['type' => 'string', 'maxLength' => 500]]])]])],
        $p . '/{labId}/sample' => ['post' => $patient('"I\'ve given my sample" (booked → in lab)', 'labSample', [
            '200' => $ok('PatientLabRequestDto "Sample recorded"'), '404' => $notFound, '409' => $statusChanged,
        ], ['parameters' => [$labId]])],
        $p . '/{labId}/results' => ['post' => $patient('Add a result file (one transaction with its sharing; every refusal stores nothing)', 'labResultUpload', [
            '201' => $ok('LabResultUploadedDto {result, request} "Result added" (`share_outcome`: shared | private | sharing_unavailable | doctor_unavailable)'),
            '404' => $notFound,
            '409' => $coded('`status_changed` (e.g. "Accept the request before adding a result." / "This request was cancelled.") or `idempotency_conflict`'),
            '422' => $coded('`file`, `document_type`, `item_ids`, `exclude_specialist_ids` / `exclude_specialist_ids.N`, `results` "You can add up to 10 result files to one request."'),
        ] + $limited, ['parameters' => [$labId], 'requestBody' => ['required' => true, 'content' => ['multipart/form-data' => ['schema' => ['type' => 'object', 'required' => ['file'], 'properties' => [
            'file'                     => ['type' => 'string', 'format' => 'binary', 'description' => 'PDF, JPG, PNG, WEBP, DICOM (.dcm) or Word (.docx), up to 10MB'],
            'document_type'            => ['type' => 'string'],
            'item_ids[]'               => ['type' => 'array', 'items' => $uuid],
            'share'                    => ['type' => 'string', 'enum' => ['1', '0']],
            'exclude_specialist_ids[]' => ['type' => 'array', 'items' => $uuid],
        ]]]]]])],
        $p . '/{labId}/link' => ['post' => $patient('A signed link to the request PDF once accepted', 'labMyLink', [
            '200' => $link, '404' => $notFound, '409' => $coded('`status_changed` "Accept the request to download it."'),
        ] + $limited, ['parameters' => [$labId], 'requestBody' => $download])],

        // ----- Public file -----
        '/api/public/lab-requests/file' => ['get' => [
            'tags' => $tag, 'summary' => 'The request PDF (the signed token is the credential; viewer re-checked; audited)', 'operationId' => 'labFile', 'security' => [],
            'parameters' => [['name' => 'token', 'in' => 'query', 'required' => true, 'schema' => ['type' => 'string']]],
            'responses' => [
                '200' => ['description' => 'application/pdf (inline or attachment; private, no-store; nosniff; no-referrer)', 'content' => ['application/pdf' => ['schema' => ['type' => 'string', 'format' => 'binary']]]],
                '410' => $coded('"This link has expired. Go back and open the request again." (also a prescription link, or a viewer no longer entitled)'),
            ],
        ]],

        // ----- Back office -----
        '/api/admin/patients/{id}/lab-requests' => ['get' => $staff('monitoring.view', 'A patient\'s lab requests as summary rows without clinical content (AdminLabRequestSummaryDto); `last_correction_note` only for labs.manage', 'labAdminRows', [
            '200' => $ok('AdminLabRequestSummaryDto[]'),
        ], ['parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => $uuid]]])],
        '/api/admin/lab-requests/{labId}/status' => ['post' => $staff('labs.manage', 'Correct a status: booked → in_lab (optional sample_date), in_lab → booked, declined → awaiting_consent, expired → booked / awaiting_consent', 'labCorrect', [
            '200' => $ok('AdminLabRequestSummaryDto "Status updated"'),
            '404' => $notFound,
            '409' => $statusChanged,
            '422' => $coded('`status` "Choose a status from the list"; `reason` (5–500); `sample_date` "Choose a date between {consent date} and today"'),
        ], ['parameters' => [$labId], 'requestBody' => $body([
            'status'      => ['type' => 'string', 'enum' => ['booked', 'in_lab', 'awaiting_consent']],
            'reason'      => ['type' => 'string', 'minLength' => 5, 'maxLength' => 500, 'description' => 'Kept for labs.manage staff only; never in the audit metadata'],
            'sample_date' => ['type' => 'string', 'format' => 'date', 'nullable' => true],
        ], ['status', 'reason'])])],
        '/api/admin/lab-requests/{labId}/link' => ['post' => $staff('labs.manage', 'A signed link to a request PDF for support staff (audited when opened)', 'labAdminLink', [
            '200' => $link, '404' => $notFound,
        ] + $limited, ['parameters' => [$labId], 'requestBody' => $download])],
    ];
};
