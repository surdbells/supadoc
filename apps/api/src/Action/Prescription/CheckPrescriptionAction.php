<?php

declare(strict_types=1);

namespace App\Action\Prescription;

use App\Infrastructure\Prescription\PrescriptionCheckService;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * POST /api/public/prescriptions/check — the pharmacist check page. Body:
 * {number, date_of_birth (YYYY-MM-DD), device_id}. No sign-in. Answers with the
 * status, date sent, doctor and MDCN number on a match, `no_match` (generic —
 * never which field was wrong) or `locked` (with retry_at) otherwise.
 */
final class CheckPrescriptionAction
{
    use ApiResponse;

    public function __construct(private readonly PrescriptionCheckService $checks)
    {
    }

    public function __invoke(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $body   = (array) ($request->getParsedBody() ?? []);
        $number = trim((string) ($body['number'] ?? ''));
        $dob    = trim((string) ($body['date_of_birth'] ?? ''));

        $errors = [];
        if ($number === '') {
            $errors['number'] = 'Enter the prescription number';
        }
        if ($dob === '') {
            $errors['date_of_birth'] = "Enter the patient's date of birth";
        }
        if ($errors !== []) {
            return $this->error($response, 'Validation failed', 422, $errors);
        }

        $result = $this->checks->check($number, $dob, (string) ($body['device_id'] ?? ''), $this->ip($request));

        // Always 200 with a `result` the page can render (match / no_match /
        // locked); a miss never says which field was wrong.
        $message = match ($result['result']) {
            'match'  => 'Prescription found',
            'locked' => 'Too many checks that did not match. Try again later.',
            default  => 'No matching prescription. Check the number and date of birth.',
        };
        $out = $this->success($response, $result, $message);
        if ($result['result'] === 'locked' && isset($result['retry_at'])) {
            $out = $out->withHeader('Retry-After', (string) max(1, (int) strtotime($result['retry_at']) - time()));
        }

        return $out->withHeader('Cache-Control', 'no-store');
    }

    /** The client IP, honouring TRUSTED_PROXY_HOPS like the rate limiter does. */
    private function ip(ServerRequestInterface $request): string
    {
        $remote = (string) ($request->getServerParams()['REMOTE_ADDR'] ?? 'unknown');
        $hops   = (int) ($_ENV['TRUSTED_PROXY_HOPS'] ?? 0);
        if ($hops > 0) {
            $chain = array_values(array_filter(array_map('trim', explode(',', $request->getHeaderLine('X-Forwarded-For')))));
            $idx   = count($chain) - $hops;
            if ($idx >= 0 && isset($chain[$idx])) {
                return $chain[$idx];
            }
        }

        return $remote;
    }
}
