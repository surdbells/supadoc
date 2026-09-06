<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Turns a stored recording file key into an accessible URL for playback/download.
 *
 * Recordings live in the cloud bucket Agora uploaded them to; the DB only keeps
 * the object keys. Two resolution modes, in order:
 *   1. A configured public/CDN base (AGORA_RECORDING_PUBLIC_BASE) → base + key.
 *   2. An S3-compatible bucket (bucket + region + access/secret) → a short-lived
 *      SigV4 presigned GET URL (default 15 min), so private buckets stay private.
 * If neither is configured, {@see url()} returns null and the UI shows the file
 * name without a link.
 */
final class RecordingStorage
{
    public function __construct(
        private readonly string $publicBase,
        private readonly string $bucket,
        private readonly string $region,
        private readonly string $accessKey,
        private readonly string $secretKey,
        private readonly string $endpoint,
        private readonly int $ttl = 900,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->publicBase !== '' || $this->s3Ready();
    }

    private function s3Ready(): bool
    {
        return $this->bucket !== '' && $this->region !== '' && $this->accessKey !== '' && $this->secretKey !== '';
    }

    /** Resolve a file key to a URL, or null when storage isn't configured. */
    public function url(string $key): ?string
    {
        $key = ltrim($key, '/');
        if ($key === '') {
            return null;
        }
        if ($this->publicBase !== '') {
            return rtrim($this->publicBase, '/') . '/' . $key;
        }
        if ($this->s3Ready()) {
            return $this->presignS3($key, new DateTimeImmutable('now', new DateTimeZone('UTC')));
        }

        return null;
    }

    /**
     * Build an AWS SigV4 presigned GET URL (virtual-hosted style). Exposed for
     * testing against AWS's published example vectors; callers use {@see url()}.
     */
    public function presignS3(string $key, DateTimeImmutable $now): string
    {
        $host      = $this->host();
        $amzDate   = $now->format('Ymd\THis\Z');
        $dateStamp = $now->format('Ymd');
        $scope     = $dateStamp . '/' . $this->region . '/s3/aws4_request';

        $params = [
            'X-Amz-Algorithm'     => 'AWS4-HMAC-SHA256',
            'X-Amz-Credential'    => $this->accessKey . '/' . $scope,
            'X-Amz-Date'          => $amzDate,
            'X-Amz-Expires'       => (string) $this->ttl,
            'X-Amz-SignedHeaders' => 'host',
        ];
        ksort($params);
        $canonicalQuery = implode('&', array_map(
            fn (string $k): string => $this->enc($k) . '=' . $this->enc($params[$k]),
            array_keys($params),
        ));

        // Encode each path segment but keep the slashes between them.
        $canonicalUri = '/' . implode('/', array_map(
            fn (string $seg): string => $this->enc($seg),
            explode('/', $key),
        ));

        $canonicalRequest = implode("\n", [
            'GET',
            $canonicalUri,
            $canonicalQuery,
            'host:' . $host . "\n",
            'host',
            'UNSIGNED-PAYLOAD',
        ]);

        $stringToSign = implode("\n", [
            'AWS4-HMAC-SHA256',
            $amzDate,
            $scope,
            hash('sha256', $canonicalRequest),
        ]);

        $signature = hash_hmac('sha256', $stringToSign, $this->signingKey($dateStamp));

        return $this->scheme() . '://' . $host . $canonicalUri . '?' . $canonicalQuery
            . '&X-Amz-Signature=' . $signature;
    }

    private function host(): string
    {
        if ($this->endpoint !== '') {
            $h = parse_url($this->endpoint, PHP_URL_HOST);
            return $this->bucket . '.' . (is_string($h) && $h !== '' ? $h : $this->endpoint);
        }

        return $this->region === 'us-east-1'
            ? $this->bucket . '.s3.amazonaws.com'
            : $this->bucket . '.s3.' . $this->region . '.amazonaws.com';
    }

    private function scheme(): string
    {
        if ($this->endpoint !== '') {
            $s = parse_url($this->endpoint, PHP_URL_SCHEME);
            return is_string($s) && $s !== '' ? $s : 'https';
        }

        return 'https';
    }

    private function signingKey(string $dateStamp): string
    {
        $kDate    = hash_hmac('sha256', $dateStamp, 'AWS4' . $this->secretKey, true);
        $kRegion  = hash_hmac('sha256', $this->region, $kDate, true);
        $kService = hash_hmac('sha256', 's3', $kRegion, true);

        return hash_hmac('sha256', 'aws4_request', $kService, true);
    }

    /** RFC 3986 encoding (rawurlencode already leaves -_.~ unencoded). */
    private function enc(string $value): string
    {
        return rawurlencode($value);
    }
}
