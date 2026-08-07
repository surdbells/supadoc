<?php

declare(strict_types=1);

namespace App\Infrastructure\Agora;

/**
 * Agora AccessToken2 (version "007") RTC token builder, vendored from Agora's
 * official PHP DynamicKey tools (MIT). Kept dependency-free — the algorithm is
 * fixed, so there's no package to install. Only RtcTokenBuilder2 is referenced
 * externally; the helper classes load with this file.
 *
 * @see https://github.com/AgoraIO/Tools (DynamicKey/AgoraDynamicKey/php/src)
 */

final class AgoraPacker
{
    public static function packUint16(int $x): string
    {
        return pack('v', $x);
    }

    public static function packUint32(int $x): string
    {
        return pack('V', $x);
    }

    public static function packString(string $str): string
    {
        return self::packUint16(strlen($str)) . $str;
    }

    /** @param array<int, int> $map privilege => expireTs */
    public static function packMapUint32(array $map): string
    {
        ksort($map);
        $result = self::packUint16(count($map));
        foreach ($map as $key => $value) {
            $result .= self::packUint16($key) . self::packUint32($value);
        }

        return $result;
    }

    public static function isHex32(string $value): bool
    {
        return strlen($value) === 32 && ctype_xdigit($value);
    }
}

class AgoraService
{
    /** @var array<int, int> */
    protected array $privileges = [];
    protected int $type;

    public function __construct(int $serviceType)
    {
        $this->type = $serviceType;
    }

    public function addPrivilege(int $privilege, int $expire): void
    {
        $this->privileges[$privilege] = $expire;
    }

    public function getServiceType(): int
    {
        return $this->type;
    }

    public function pack(): string
    {
        return AgoraPacker::packUint16($this->type) . AgoraPacker::packMapUint32($this->privileges);
    }
}

final class AgoraServiceRtc extends AgoraService
{
    public const SERVICE_TYPE = 1;

    public const PRIVILEGE_JOIN_CHANNEL         = 1;
    public const PRIVILEGE_PUBLISH_AUDIO_STREAM = 2;
    public const PRIVILEGE_PUBLISH_VIDEO_STREAM = 3;
    public const PRIVILEGE_PUBLISH_DATA_STREAM  = 4;

    private string $channelName;
    private string $uid;

    public function __construct(string $channelName, string $uid)
    {
        parent::__construct(self::SERVICE_TYPE);
        $this->channelName = $channelName;
        $this->uid         = $uid === '0' ? '' : $uid;
    }

    public function pack(): string
    {
        return parent::pack()
            . AgoraPacker::packString($this->channelName)
            . AgoraPacker::packString($this->uid);
    }
}

final class AccessToken2
{
    public const VERSION = '007';

    private string $appId;
    private string $appCertificate;
    private int $expire;
    private int $issueTs;
    private int $salt;

    /** @var array<int, AgoraService> */
    private array $services = [];

    public function __construct(string $appId, string $appCertificate, int $expire)
    {
        $this->appId          = $appId;
        $this->appCertificate = $appCertificate;
        $this->expire         = $expire;
        $this->issueTs        = time();
        $this->salt           = random_int(1, 99999999);
    }

    public function addService(AgoraService $service): void
    {
        $this->services[$service->getServiceType()] = $service;
    }

    public function build(): string
    {
        if (!AgoraPacker::isHex32($this->appId) || !AgoraPacker::isHex32($this->appCertificate)) {
            return '';
        }

        $signing     = $this->sign();
        $signingInfo = AgoraPacker::packString($this->appId)
            . AgoraPacker::packUint32($this->issueTs)
            . AgoraPacker::packUint32($this->expire)
            . AgoraPacker::packUint32($this->salt)
            . AgoraPacker::packUint16(count($this->services));

        ksort($this->services);
        foreach ($this->services as $service) {
            $signingInfo .= $service->pack();
        }

        $signature = hash_hmac('sha256', $signingInfo, $signing, true);
        $content   = AgoraPacker::packString($signature) . $signingInfo;
        $encoded   = zlib_encode($content, ZLIB_ENCODING_DEFLATE);

        return self::VERSION . base64_encode((string) $encoded);
    }

    private function sign(): string
    {
        $sign = hash_hmac('sha256', AgoraPacker::packUint32($this->issueTs), $this->appCertificate, true);

        return hash_hmac('sha256', AgoraPacker::packUint32($this->salt), $sign, true);
    }
}

final class RtcTokenBuilder2
{
    public const ROLE_PUBLISHER  = 1;
    public const ROLE_SUBSCRIBER = 2;

    public static function buildTokenWithUid(
        string $appId,
        string $appCertificate,
        string $channelName,
        int $uid,
        int $role,
        int $tokenExpire,
        int $privilegeExpire,
    ): string {
        $token   = new AccessToken2($appId, $appCertificate, $tokenExpire);
        $service = new AgoraServiceRtc($channelName, (string) $uid);

        $service->addPrivilege(AgoraServiceRtc::PRIVILEGE_JOIN_CHANNEL, $privilegeExpire);
        if ($role === self::ROLE_PUBLISHER) {
            $service->addPrivilege(AgoraServiceRtc::PRIVILEGE_PUBLISH_AUDIO_STREAM, $privilegeExpire);
            $service->addPrivilege(AgoraServiceRtc::PRIVILEGE_PUBLISH_VIDEO_STREAM, $privilegeExpire);
            $service->addPrivilege(AgoraServiceRtc::PRIVILEGE_PUBLISH_DATA_STREAM, $privilegeExpire);
        }

        $token->addService($service);

        return $token->build();
    }
}
