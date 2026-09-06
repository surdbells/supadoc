<?php

declare(strict_types=1);

namespace App\Tests\Unit;

use App\Infrastructure\Service\RecordingStorage;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * The S3 presign is pure crypto and fully checkable offline against AWS's own
 * published Signature Version 4 example (GET examplebucket/test.txt), so we know
 * the presigned playback/download URLs are valid without a live bucket.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */
final class RecordingStorageTest extends TestCase
{
    public function testPresignMatchesAwsExampleVector(): void
    {
        $storage = new RecordingStorage(
            publicBase: '',
            bucket: 'examplebucket',
            region: 'us-east-1',
            accessKey: 'AKIAIOSFODNN7EXAMPLE',
            secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            endpoint: '',
            ttl: 86400,
        );

        $url = $storage->presignS3(
            'test.txt',
            new DateTimeImmutable('2013-05-24T00:00:00', new DateTimeZone('UTC')),
        );

        self::assertStringStartsWith('https://examplebucket.s3.amazonaws.com/test.txt?', $url);
        self::assertStringContainsString(
            'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
            $url,
        );
        self::assertStringContainsString('X-Amz-Expires=86400', $url);
        self::assertStringContainsString(
            'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
            $url,
        );
    }

    public function testPublicBaseTakesPrecedence(): void
    {
        $storage = new RecordingStorage('https://cdn.example.com/rec/', 'b', 'us-east-1', 'a', 's', '', 900);
        self::assertSame('https://cdn.example.com/rec/path/to/file.mp4', $storage->url('/path/to/file.mp4'));
    }

    public function testUnconfiguredReturnsNull(): void
    {
        $storage = new RecordingStorage('', '', '', '', '', '', 900);
        self::assertFalse($storage->isConfigured());
        self::assertNull($storage->url('path/to/file.mp4'));
    }
}
