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
                    'years_experience' => ['type' => 'integer', 'nullable' => true, 'example' => 14],
                    'languages'        => ['type' => 'string', 'nullable' => true, 'example' => 'English, French'],
                    'verified'         => ['type' => 'boolean'],
                    'gender'           => ['type' => 'string', 'nullable' => true, 'enum' => ['male', 'female']],
                    'offers_in_person' => ['type' => 'boolean'],
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
                    'amount'         => ['type' => 'string', 'example' => '150.00'],
                    'notes'          => ['type' => 'string', 'nullable' => true],
                    'document_url'   => ['type' => 'string', 'nullable' => true],
                    'payment_status' => ['type' => 'string', 'enum' => ['unpaid', 'pending', 'paid']],
                    'guests'         => [
                        'type'        => 'array',
                        'description' => 'Invited third parties (max 3); each adds the guest fee.',
                        'items'       => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'email' => ['type' => 'string', 'format' => 'email']]],
                    ],
                    'created_at'     => ['type' => 'string', 'format' => 'date-time'],
                ],
            ],
            'Pricing' => [
                'type'        => 'object',
                'description' => 'Back-office-configurable consultation pricing.',
                'properties'  => [
                    'currency'     => ['type' => 'string', 'example' => 'NGN'],
                    'guest_fee'    => ['type' => 'number', 'example' => 5000, 'description' => 'Added per invited guest'],
                    'platform_fee' => ['type' => 'number', 'example' => 200],
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
        '/api/doctor/appointments' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => "A doctor's own consultations (minimal doctor portal)",
                'description' => 'Staff token from a doctor login (role doctor). Each row includes a preauthenticated join_url.',
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
                                            'join_url'     => ['type' => 'string'],
                                        ]],
                                    ],
                                ],
                            ],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Not a doctor login'],
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
                    ['name' => 'search', 'in' => 'query', 'description' => 'Matches name or specialty', 'schema' => ['type' => 'string']],
                    ['name' => 'specialty', 'in' => 'query', 'description' => 'Exact specialty filter', 'schema' => ['type' => 'string']],
                    ['name' => 'available', 'in' => 'query', 'schema' => ['type' => 'boolean']],
                    ['name' => 'location', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'language', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'gender', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['male', 'female']]],
                    ['name' => 'mode', 'in' => 'query', 'description' => 'in_person to require in-person visits', 'schema' => ['type' => 'string', 'enum' => ['online', 'in_person']]],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($paginated('#/components/schemas/Specialist'))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
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
        '/api/public/facets' => [
            'get' => [
                'tags'      => ['Public'],
                'summary'   => 'Filter options: specialties (with counts), locations, languages',
                'responses' => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'specialties' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'count' => ['type' => 'integer']]]],
                            'locations'   => ['type' => 'array', 'items' => ['type' => 'string']],
                            'languages'   => ['type' => 'array', 'items' => ['type' => 'string']],
                        ],
                    ]))],
                ],
            ],
        ],
        '/api/public/specialists' => [
            'get' => [
                'tags'       => ['Public'],
                'summary'    => 'Public specialist search (homepage autocomplete)',
                'parameters' => [
                    ['name' => 'search', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'specialty', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'location', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'language', 'in' => 'query', 'schema' => ['type' => 'string']],
                    ['name' => 'gender', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['male', 'female']]],
                    ['name' => 'mode', 'in' => 'query', 'schema' => ['type' => 'string', 'enum' => ['online', 'in_person']]],
                    ['name' => 'limit', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 12, 'maximum' => 24]],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($envelope(['type' => 'array', 'items' => ['$ref' => '#/components/schemas/Specialist']]))],
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
                'parameters' => [
                    ['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']],
                    ['name' => 'days', 'in' => 'query', 'schema' => ['type' => 'integer', 'default' => 7, 'maximum' => 14]],
                ],
                'responses'  => [
                    '200' => ['description' => 'OK', ...$json($envelope([
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
        '/api/public/call/{token}' => [
            'get' => [
                'tags'        => ['Public'],
                'summary'     => 'Resolve a preauthenticated join link into an Agora session',
                'description' => 'The signed call-access token from the invite email IS the credential — no login. Returns the meeting details plus an Agora token when video is configured.',
                'security'    => [],
                'parameters'  => [['name' => 'token', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string']]],
                'responses'   => [
                    '200' => ['description' => 'Ready to join', ...$json($envelope([
                        'type'       => 'object',
                        'properties' => [
                            'appointment_id' => ['type' => 'string', 'format' => 'uuid'],
                            'scheduled_at'   => ['type' => 'string', 'format' => 'date-time'],
                            'specialist'     => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'specialty' => ['type' => 'string']]],
                            'you'            => ['type' => 'object', 'properties' => ['name' => ['type' => 'string'], 'role' => ['type' => 'string', 'enum' => ['patient', 'doctor', 'guest']]]],
                            'configured'     => ['type' => 'boolean'],
                            'app_id'         => ['type' => 'string'],
                            'channel'        => ['type' => 'string'],
                            'uid'            => ['type' => 'integer'],
                            'token'          => ['type' => 'string'],
                            'expires_in'     => ['type' => 'integer', 'example' => 3600],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                ],
            ],
        ],
        '/api/specialists' => [
            'get' => [
                'tags'        => ['Staff'],
                'summary'     => 'List specialists with their contact email (back office)',
                'description' => 'Requires specialists.manage. Includes the normally server-side email so an operator can review and fix it.',
                'responses'   => [
                    '200' => ['description' => 'OK', ...$json($envelope([
                        'type'  => 'array',
                        'items' => [
                            'allOf' => [
                                ['$ref' => '#/components/schemas/Specialist'],
                                ['type' => 'object', 'properties' => ['email' => ['type' => 'string', 'nullable' => true]]],
                            ],
                        ],
                    ]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '403' => ['description' => 'Missing specialists.manage'],
                ],
            ],
        ],
        '/api/specialists/{id}' => [
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => "Edit a specialist's contact + booking fields (back office)",
                'description' => 'Requires specialists.manage. Only the keys present change. The response echoes the (normally server-side) email so the operator can confirm it.',
                'parameters'  => [['name' => 'id', 'in' => 'path', 'required' => true, 'schema' => ['type' => 'string', 'format' => 'uuid']]],
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'properties' => [
                        'email'            => ['type' => 'string', 'format' => 'email', 'nullable' => true, 'description' => 'Empty string clears it'],
                        'consultation_fee' => ['type' => 'string', 'example' => '15000.00'],
                        'available'        => ['type' => 'boolean'],
                        'verified'         => ['type' => 'boolean'],
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
        '/api/settings/pricing' => [
            'patch' => [
                'tags'        => ['Staff'],
                'summary'     => 'Update consultation pricing (back office)',
                'description' => 'Requires settings.manage. Only the keys present are changed.',
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
                'description' => 'multipart/form-data with a `document` image field (JPG/PNG, <= 5MB). Returns its URL for the booking payload.',
                'requestBody' => [
                    'required' => true,
                    'content'  => [
                        'multipart/form-data' => [
                            'schema' => [
                                'type'       => 'object',
                                'required'   => ['document'],
                                'properties' => ['document' => ['type' => 'string', 'format' => 'binary']],
                            ],
                        ],
                    ],
                ],
                'responses'   => [
                    '200' => ['description' => 'Uploaded', ...$json($envelope(['type' => 'object', 'properties' => ['url' => ['type' => 'string']]]))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
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
            'post' => [
                'tags'        => ['Portal'],
                'summary'     => 'Book a consultation',
                'description' => 'The patient is taken from the token; the appointment is created with status pending.',
                'requestBody' => ['required' => true, ...$json([
                    'type'       => 'object',
                    'required'   => ['specialist_id', 'scheduled_at'],
                    'properties' => [
                        'specialist_id' => ['type' => 'string', 'format' => 'uuid'],
                        'scheduled_at'  => ['type' => 'string', 'format' => 'date-time'],
                        'type'          => ['type' => 'string', 'enum' => ['video', 'follow_up', 'urgent', 'routine'], 'default' => 'video'],
                        'notes'         => ['type' => 'string', 'description' => 'Reason for the consultation'],
                        'document_url'  => ['type' => 'string', 'description' => 'Relative URL from POST /portal/appointment-documents'],
                        'guests'        => [
                            'type'        => 'array',
                            'description' => 'Up to 3 invited third parties; each adds the guest fee to the amount.',
                            'maxItems'    => 3,
                            'items'       => ['type' => 'object', 'required' => ['name', 'email'], 'properties' => ['name' => ['type' => 'string'], 'email' => ['type' => 'string', 'format' => 'email']]],
                        ],
                    ],
                ])],
                'responses'   => [
                    '201' => ['description' => 'Booked', ...$json($envelope(['$ref' => '#/components/schemas/Appointment']))],
                    '401' => ['$ref' => '#/components/responses/Unauthorized'],
                    '404' => ['$ref' => '#/components/responses/NotFound'],
                    '422' => ['$ref' => '#/components/responses/Validation'],
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
        '/api/portal/notifications' => [
            'get' => [
                'tags'        => ['Portal'],
                'summary'     => "The patient's notifications",
                'description' => 'Newest first; `meta.unread` is the unread count. `?unread=true` filters to unread.',
                'operationId' => 'portalNotifications',
                'parameters'  => [
                    ...$paginationParams,
                    ['name' => 'unread', 'in' => 'query', 'schema' => ['type' => 'boolean']],
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
