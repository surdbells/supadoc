<?php

declare(strict_types=1);

namespace App\Domain\Entity;

use Doctrine\ORM\Mapping as ORM;

/**
 * A durable, back-office-editable key/value setting (e.g. pricing). Distinct
 * from SettingsCacheService, which is a short-TTL cache — these persist.
 */
#[ORM\Entity]
#[ORM\Table(name: 'app_settings')]
class AppSetting
{
    #[ORM\Id]
    #[ORM\Column(name: 'setting_key', type: 'string', length: 100)]
    private string $key;

    #[ORM\Column(type: 'text')]
    private string $value;

    public function __construct(string $key, string $value)
    {
        $this->key   = $key;
        $this->value = $value;
    }

    public function getKey(): string
    {
        return $this->key;
    }

    public function getValue(): string
    {
        return $this->value;
    }

    public function setValue(string $value): void
    {
        $this->value = $value;
    }
}
