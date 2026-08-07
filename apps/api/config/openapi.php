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
            . "from a login endpoint; tokens are audience-scoped (staff vs customer).",
    ],
    'servers' => [
        ['url' => 'http://localhost:8080', 'description' => 'Local dev'],
    ],
    'tags' => [
        ['name' => 'Auth', 'description' => 'Sign-in and token refresh'],
        ['name' => 'Staff', 'description' => 'Staff-scoped endpoints'],
        ['name' => 'Portal', 'description' => 'Customer (patient) portal endpoints'],
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
                        'additionalProperties' => ['type' => 'string'],
                        'nullable'             => true,
                        'example'              => ['email' => 'Email is required'],
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
                    'status'       => ['type' => 'string', 'enum' => ['pending', 'confirmed', 'rescheduled', 'completed', 'cancelled']],
                    'status_label' => ['type' => 'string'],
                    'amount'       => ['type' => 'string', 'example' => '150.00'],
                    'created_at'   => ['type' => 'string', 'format' => 'date-time'],
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
                    'created_at'     => ['type' => 'string', 'format' => 'date-time'],
                ],
            ],
        ],
        'responses' => [
            'Unauthorized' => $json(['$ref' => '#/components/schemas/Error']) + ['description' => 'Missing/invalid token'],
            'NotFound'     => $json(['$ref' => '#/components/schemas/Error']) + ['description' => 'Not found'],
            'Validation'   => $json(['$ref' => '#/components/schemas/Error']) + ['description' => 'Validation failed'],
        ],
    ],
    'paths' => [
        '/health' => [
            'get' => [
                'tags'      => ['System'],
                'summary'   => 'Liveness probe',
                'security'  => [],
                'responses' => ['200' => ['description' => 'OK', ...$json(['type' => 'object', 'properties' => ['status' => ['type' => 'string', 'example' => 'ok']]])]],
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
                'operationId' => 'refreshToken',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['refresh_token'], 'properties' => ['refresh_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'New access token', ...$json($envelope(['$ref' => '#/components/schemas/AccessToken']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
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
        '/api/appointments' => [
            'get' => [
                'tags'       => ['Staff'],
                'summary'    => 'List appointments',
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'status', 'in' => 'query', 'schema' => ['type' => 'string'], 'description' => 'Comma-separated statuses'],
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
                'description' => 'Enforces the state machine; illegal transitions return 422.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['status'], 'properties' => ['status' => ['type' => 'string', 'enum' => ['pending', 'confirmed', 'rescheduled', 'completed', 'cancelled']]]])],
                'responses'   => [
                    '200' => ['description' => 'Updated', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
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
        ],
        '/api/portal/me/verify-phone' => [
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => "Confirm the signed-in patient's phone number",
                'description' => 'Consumes a verification_token from verify-otp and marks the number verified.',
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['verification_token'], 'properties' => ['verification_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'Verified', ...$json($envelope(['$ref' => '#/components/schemas/PatientProfile']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/portal/specialists' => [
            'get' => [
                'tags'       => ['Portal'],
                'summary'    => 'Specialist directory',
                'parameters' => [
                    ...$paginationParams,
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'available', 'in' => 'query', 'schema' => ['type' => 'boolean']],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Specialist'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/portal/appointments' => [
            'get' => [
                'tags'       => ['Portal'],
                'summary'    => "The patient's own appointments",
                'parameters' => $paginationParams,
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Appointment'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "One of the patient's own appointments",
                'operationId' => 'portalGetAppointment',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/portal/appointments/{id}/call-token' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => 'Agora RTC token for the consultation call',
                'description' => 'Channel is the appointment id; the token is a publisher token valid for 1 hour.',
                'operationId' => 'portalCallToken',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'   => [
                    '200' => ['description' => 'Token issued', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'app_id'     => ['type' => 'string'],
                            'channel'    => ['type' => 'string'],
                            'uid'        => ['type' => 'integer', 'example' => 0],
                            'token'      => ['type' => 'string'],
                            'expires_in' => ['type' => 'integer', 'example' => 3600],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '503' => ['description' => 'Video calling not configured'],
                ],
            ],
        ],
    ],
    'security' => [['bearerAuth' => []]],
];
