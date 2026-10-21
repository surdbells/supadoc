<?php

declare(strict_types=1);

namespace App\Infrastructure\Document;

use App\Domain\Entity\MedicalDocument;
use DateTimeImmutable;

/**
 * One document a doctor may see now, as {@see DocumentAccessPolicy} decided it:
 * until when (`until` NULL = no end), what to format (`untilLabelAt`), whether
 * through the whole folder or individually (`via`), the covering grant with
 * the latest end (`grantId`), every covering grant (`grantIds`) and when it
 * was first shared (`sharedAt`).
 */
final class VisibleDocument
{
    /** @param list<string> $grantIds */
    public function __construct(
        public readonly string $documentId,
        public readonly MedicalDocument $document,
        public readonly ?DateTimeImmutable $until,
        public readonly ?DateTimeImmutable $untilLabelAt,
        public readonly bool $indefinite,
        public readonly string $via,
        public readonly string $grantId,
        public readonly DateTimeImmutable $sharedAt,
        public readonly array $grantIds = [],
    ) {
    }
}
