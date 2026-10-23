<?php

declare(strict_types=1);

namespace App\Infrastructure\Http;

use Psr\Http\Message\ServerRequestInterface;

/**
 * The client's IP address as the trusted proxies saw it.
 *
 * X-Forwarded-For is client-controlled, so trusting its leftmost value lets an
 * attacker rotate the header to get a fresh bucket per request (or forge a
 * consent IP). It is read only when TRUSTED_PROXY_HOPS says how many reverse
 * proxies sit in front, and then the entry those proxies set is taken
 * (Nth-from-right); otherwise the connecting address. Used by the rate limiter
 * and for the doctor-application consent evidence (never
 * RequestClientTrait::clientIp, which takes the leftmost entry).
 */
final class TrustedClientIp
{
    public static function from(ServerRequestInterface $request): string
    {
        $params = $request->getServerParams();
        $remote = (string) ($params['REMOTE_ADDR'] ?? 'unknown');
        $hops   = (int) ($_ENV['TRUSTED_PROXY_HOPS'] ?? 0);

        if ($hops > 0) {
            $fwd = $request->getHeaderLine('X-Forwarded-For');
            if ($fwd !== '') {
                $chain = array_values(array_filter(array_map('trim', explode(',', $fwd)), static fn (string $v): bool => $v !== ''));
                $idx   = count($chain) - $hops;
                if ($idx >= 0 && isset($chain[$idx])) {
                    return $chain[$idx];
                }
            }
        }

        return $remote;
    }
}
