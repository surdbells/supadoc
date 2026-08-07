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
                'properties' => [
                    'access_token'  => ['type' => 'string'],
                    'refresh_token' => ['type' => 'string'],
                    'token_type'    => ['type' => 'string', 'example' => 'Bearer'],
                    'expires_in'    => ['type' => 'integer', 'example' => 900],
                    'user'          => ['type' => 'object'],
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
                    'phone'         => ['type' => 'string', 'nullable' => true],
                    'date_of_birth' => ['type' => 'string', 'format' => 'date', 'nullable' => true],
                    'created_at'    => ['type' => 'string', 'format' => 'date-time'],
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
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/Credentials'])],
                'responses'   => [
                    '200' => ['description' => 'Signed in', ...$json($envelope(['$ref' => '#/components/schemas/AuthTokens']))],
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
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['$ref' => '#/components/schemas/Credentials'])],
                'responses'   => [
                    '200' => ['description' => 'Signed in', ...$json($envelope(['$ref' => '#/components/schemas/AuthTokens']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
                ],
            ],
        ],
        '/api/auth/refresh' => [
            'post' => [
                'tags'        => ['Auth'],
                'summary'     => 'Exchange a refresh token for a new access token',
                'security'    => [],
                'requestBody' => ['required' => true, ...$json(['type' => 'object', 'required' => ['refresh_token'], 'properties' => ['refresh_token' => ['type' => 'string']]])],
                'responses'   => [
                    '200' => ['description' => 'New access token', ...$json($envelope(['type' => 'object']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                ],
            ],
        ],
        '/api/me' => [
            'get' => [
                'tags'      => ['Staff'],
                'summary'   => 'The signed-in staff user',
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'object']))],
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
                'tags'       => ['Portal'],
                'summary'    => "One of the patient's own appointments",
                'parameters' => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
    ],
    'security' => [['bearerAuth' => []]],
];
