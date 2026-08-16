<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\AppSetting;

final class AppSettingRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return AppSetting::class;
    }

    public function get(string $key, ?string $default = null): ?string
    {
        /** @var AppSetting|null $row */
        $row = $this->find($key);

        return $row?->getValue() ?? $default;
    }

    public function set(string $key, string $value): void
    {
        /** @var AppSetting|null $row */
        $row = $this->find($key);
        if ($row === null) {
            $this->save(new AppSetting($key, $value));

            return;
        }
        $row->setValue($value);
        $this->save($row);
    }
}
