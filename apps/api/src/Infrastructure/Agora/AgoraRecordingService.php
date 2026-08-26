<?php

declare(strict_types=1);

namespace App\Infrastructure\Agora;

/**
 * Agora Cloud Recording (mixed mode) via the RESTful API. Authenticates with the
 * project's Customer ID / Secret (separate from the App Certificate) using HTTP
 * Basic auth, and uploads finished recordings to the configured cloud storage.
 *
 * Unconfigured (no customer key/secret or storage bucket) => isConfigured() is
 * false and callers return 503, exactly like {@see AgoraTokenService}. The
 * recording bot joins the channel as a fixed reserved uid.
 *
 * @see https://docs.agora.io/en/cloud-recording/reference/rest-api
 */
final class AgoraRecordingService
{
    private const BASE = 'https://api.agora.io/v1/apps';

    /** Reserved uid the recorder joins as — must not collide with participants. */
    public const RECORDER_UID = '525252';

    /**
     * @param array{vendor:int,region:int,bucket:string,accessKey:string,secretKey:string} $storage
     */
    public function __construct(
        private readonly string $appId,
        private readonly string $customerId,
        private readonly string $customerSecret,
        private readonly array $storage,
    ) {
    }

    public function isConfigured(): bool
    {
        return $this->appId !== ''
            && $this->customerId !== ''
            && $this->customerSecret !== ''
            && $this->storage['bucket'] !== '';
    }

    /** Reserve a recording resource for a channel; returns the resourceId. */
    public function acquire(string $channel, string $uid): string
    {
        $res = $this->request('POST', "/{$this->appId}/cloud_recording/acquire", [
            'cname'         => $channel,
            'uid'           => $uid,
            'clientRequest' => ['resourceExpiredHour' => 24, 'scene' => 0],
        ]);

        $resourceId = $res['resourceId'] ?? null;
        if (!is_string($resourceId) || $resourceId === '') {
            throw new \RuntimeException('Could not acquire a recording resource');
        }

        return $resourceId;
    }

    /**
     * Start a mixed recording; returns the recording sid.
     *
     * @return array{sid:string,resourceId:string}
     */
    public function start(string $channel, string $uid, string $resourceId, ?string $token, string $prefix): array
    {
        $clientRequest = [
            'recordingConfig' => [
                'maxIdleTime'        => 120,
                'streamTypes'        => 2, // audio + video
                'channelType'        => 0, // communication (rtc)
                'videoStreamType'    => 0,
                'subscribeVideoUids' => ['#allstream#'],
                'subscribeAudioUids' => ['#allstream#'],
                'transcodingConfig'  => [
                    'width'            => 640,
                    'height'           => 480,
                    'fps'              => 15,
                    'bitrate'          => 500,
                    'mixedVideoLayout' => 1,
                    'backgroundColor'  => '#000000',
                ],
            ],
            'storageConfig' => [
                'vendor'         => $this->storage['vendor'],
                'region'         => $this->storage['region'],
                'bucket'         => $this->storage['bucket'],
                'accessKey'      => $this->storage['accessKey'],
                'secretKey'      => $this->storage['secretKey'],
                'fileNamePrefix' => ['videomed', $prefix],
            ],
        ];
        if ($token !== null && $token !== '') {
            $clientRequest['token'] = $token;
        }

        $res = $this->request(
            'POST',
            "/{$this->appId}/cloud_recording/resourceid/{$resourceId}/mode/mix/start",
            ['cname' => $channel, 'uid' => $uid, 'clientRequest' => $clientRequest],
        );

        $sid = $res['sid'] ?? null;
        if (!is_string($sid) || $sid === '') {
            throw new \RuntimeException('Could not start recording');
        }

        return ['sid' => $sid, 'resourceId' => (string) ($res['resourceId'] ?? $resourceId)];
    }

    /**
     * Stop a recording; returns the server response (incl. fileList) if present.
     *
     * @return array<string,mixed>
     */
    public function stop(string $channel, string $uid, string $resourceId, string $sid): array
    {
        $res = $this->request(
            'POST',
            "/{$this->appId}/cloud_recording/resourceid/{$resourceId}/sid/{$sid}/mode/mix/stop",
            ['cname' => $channel, 'uid' => $uid, 'clientRequest' => ['async_stop' => false]],
        );

        $server = $res['serverResponse'] ?? [];

        return is_array($server) ? $server : [];
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    private function request(string $method, string $path, array $body): array
    {
        if (!$this->isConfigured()) {
            throw new \RuntimeException('Cloud recording is not configured');
        }

        $ch = curl_init(self::BASE . $path);
        if ($ch === false) {
            throw new \RuntimeException('Recording service unreachable');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Authorization: Basic ' . base64_encode($this->customerId . ':' . $this->customerSecret),
            ],
            CURLOPT_POSTFIELDS     => json_encode($body),
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if (!is_string($raw)) {
            throw new \RuntimeException('Recording service unreachable');
        }
        $json = json_decode($raw, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Unexpected recording service response');
        }
        if ($status >= 400) {
            $reason = is_string($json['reason'] ?? null) ? $json['reason'] : 'request failed';
            throw new \RuntimeException('Recording service error: ' . $reason);
        }

        return $json;
    }
}
