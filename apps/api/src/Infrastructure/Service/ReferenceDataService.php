<?php

declare(strict_types=1);

namespace App\Infrastructure\Service;

use App\Domain\Entity\ReferenceItem;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Reference\ReferenceCategory;
use App\Domain\Repository\ReferenceItemRepository;
use App\Domain\Repository\SpecialistRepository;
use Doctrine\DBAL\Exception\TableNotFoundException;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The back office's reference data (pick lists such as doctors' specialties;
 * {@see ReferenceItem}, {@see ReferenceCategory}): the public list a form
 * offers, the staff list with each item's usage count, and the changes —
 * add, rename / reorder / switch on or off, delete only while unused. Every
 * change is audited with the acting staff member, in the same transaction.
 *
 * Records keep an item's LABEL (a specialist's `specialty`), so a rename
 * re-labels every record using the old label in the same transaction, and
 * {@see resolveChoice()} is how a form's value is checked against the list.
 */
final class ReferenceDataService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly ReferenceItemRepository $items,
        private readonly SpecialistRepository $specialists,
        private readonly AuditLogger $audit,
    ) {
    }

    /** A known list, or a 404. */
    public function assertCategory(string $category): void
    {
        if (!ReferenceCategory::exists($category)) {
            throw new EntityNotFoundException(sprintf('Reference list "%s" not found', $category));
        }
    }

    /**
     * The items a form offers: active ones in list order.
     *
     * @return list<array{id:string, code:string, label:string, sort_order:int}>
     */
    public function publicItems(string $category): array
    {
        $this->assertCategory($category);
        try {
            $items = $this->items->listFor($category, true);
        } catch (TableNotFoundException) {
            // Before this release's schema update: no list yet, so the forms
            // fall back to free text (which resolveChoice() still accepts).
            return [];
        }

        return array_map(
            static fn (ReferenceItem $item): array => $item->toPublicArray(),
            $items,
        );
    }

    /**
     * Every item, active or not, in list order, each with its usage count.
     *
     * @return list<array<string,mixed>>
     */
    public function staffItems(string $category): array
    {
        $this->assertCategory($category);
        try {
            $items = $this->items->listFor($category);
        } catch (TableNotFoundException) {
            return []; // before this release's schema update (see publicItems())
        }
        $usage = $this->usageByKey($category);

        return array_map(
            static fn (ReferenceItem $item): array => $item->toArray($usage[$item->getLabelKey()] ?? 0),
            $items,
        );
    }

    /**
     * How many records use each label of a list, keyed by
     * {@see ReferenceItem::keyOf()} (stored spellings that differ only in case
     * or spacing count together).
     *
     * @return array<string,int>
     */
    public function usageByKey(string $category): array
    {
        $raw = match ($category) {
            ReferenceCategory::SPECIALTY => $this->specialists->specialtyUsage(),
            default                      => [],
        };
        $out = [];
        foreach ($raw as $value => $count) {
            $key       = ReferenceItem::keyOf((string) $value);
            $out[$key] = ($out[$key] ?? 0) + $count;
        }

        return $out;
    }

    /**
     * The label a record may store for a submitted value: the matching ACTIVE
     * item's label (case and spacing aside — its own spelling is kept), or
     * null when the value is not on the list or its item is switched off.
     * While a list has no items at all (before bin/prod-migrate.php seeds it,
     * or before this release's schema update) any non-blank value is taken
     * as typed, as before the list existed.
     */
    public function resolveChoice(string $category, string $value): ?string
    {
        $value = ReferenceItem::normaliseLabel($value);
        if ($value === '') {
            return null;
        }
        try {
            $item = $this->items->findByLabel($category, $value);
            if ($item !== null) {
                return $item->isActive() ? $item->getLabel() : null;
            }

            return $this->items->countFor($category) === 0 ? $value : null;
        } catch (TableNotFoundException) {
            return $value; // the schema update that adds the lists has not run yet
        }
    }

    /**
     * Add an item: `label` (required, unique in the list regardless of case),
     * optional `code` (a slug; made from the label when absent), `sort_order`
     * (default: after the last) and `active` (default true).
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> the item, staff shape
     */
    public function create(string $category, array $body, ?string $actorId, string $actorName): array
    {
        $this->assertCategory($category);
        $errors = [];

        $label = $this->validLabel($category, $body['label'] ?? null, null, $errors);

        $code = null;
        if (array_key_exists('code', $body) && trim((string) $body['code']) !== '') {
            $code = strtolower(trim((string) $body['code']));
            if (!ReferenceItem::isValidCode($code)) {
                $errors['code'] = 'Use lower-case letters, numbers and single hyphens (up to ' . ReferenceItem::CODE_MAX . ' characters)';
            } elseif ($this->items->findByCode($category, $code) !== null) {
                $errors['code'] = 'That code is already used in this list';
            }
        }

        $sortOrder = array_key_exists('sort_order', $body) ? $this->validSortOrder($body['sort_order'], $errors) : null;
        $active    = array_key_exists('active', $body) ? $this->validBool($body['active'], 'active', $errors) : true;

        if ($errors !== [] || $label === null) {
            throw new ValidationException($errors);
        }
        if ($active === false && $this->items->countFor($category, true) === 0) {
            throw new ValidationException(['active' => $this->lastActiveMessage($category)], $this->lastActiveMessage($category));
        }

        $item = new ReferenceItem(
            $category,
            $code ?? $this->items->uniqueCode($category, ReferenceItem::slugOf($label)),
            $label,
            $sortOrder ?? $this->items->maxSortOrder($category) + 10,
            $active ?? true,
        );

        try {
            $this->em->wrapInTransaction(function () use ($item, $actorId, $actorName): void {
                $this->items->save($item);
                $this->record($actorId, $actorName, 'reference.created', $item, [
                    'label'      => $item->getLabel(),
                    'code'       => $item->getCode(),
                    'sort_order' => $item->getSortOrder(),
                    'active'     => $item->isActive(),
                ]);
            });
        } catch (UniqueConstraintViolationException) {
            // Another request added the same label or code a moment ago.
            throw new ValidationException(['label' => $this->duplicateMessage($category, false)]);
        }

        return $item->toArray(0);
    }

    /**
     * Change an item's `label`, `sort_order` and/or `active` (only the keys
     * sent). A new label is given, in the same transaction, to every record
     * that stored the old one (each audited against that record). The result
     * is the item (staff shape) plus `specialists_updated`: how many
     * specialists were re-labelled.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function update(string $category, string $id, array $body, ?string $actorId, string $actorName): array
    {
        $item   = $this->itemOrFail($category, $id);
        $errors = [];

        $label     = array_key_exists('label', $body) ? $this->validLabel($category, $body['label'], $item, $errors) : null;
        $sortOrder = array_key_exists('sort_order', $body) ? $this->validSortOrder($body['sort_order'], $errors) : null;
        $active    = array_key_exists('active', $body) ? $this->validBool($body['active'], 'active', $errors) : null;
        if ($errors !== []) {
            throw new ValidationException($errors);
        }
        $before  = ['label' => $item->getLabel(), 'sort_order' => $item->getSortOrder(), 'active' => $item->isActive()];
        $oldName = $item->getLabel();
        $renamed = $label !== null && $label !== $oldName;

        $changes = [];
        try {
            $changes = $this->em->wrapInTransaction(function () use ($item, $category, $label, $sortOrder, $active, $renamed, $oldName, $before, $actorId, $actorName): array {
                if ($active === false && $item->isActive()) {
                    $this->assertNotLastActive($category);
                }
                if ($label !== null) {
                    $item->rename($label);
                }
                if ($sortOrder !== null) {
                    $item->setSortOrder($sortOrder);
                }
                if ($active !== null) {
                    $item->setActive($active);
                }
                $this->items->save($item);

                $relabelled = $renamed ? $this->relabel($category, $oldName, $item->getLabel(), $actorId, $actorName) : [];

                $after   = ['label' => $item->getLabel(), 'sort_order' => $item->getSortOrder(), 'active' => $item->isActive()];
                $changed = array_keys(array_filter($after, static fn (mixed $v, string $k): bool => $v !== $before[$k], ARRAY_FILTER_USE_BOTH));
                if ($changed !== []) {
                    $this->record($actorId, $actorName, 'reference.updated', $item, [
                        'label'               => $item->getLabel(),
                        'before'              => array_intersect_key($before, array_flip($changed)),
                        'after'               => array_intersect_key($after, array_flip($changed)),
                        'specialists_updated' => count(array_filter($relabelled, static fn (array $c): bool => !$c['pending'])),
                        'requests_updated'    => count(array_filter($relabelled, static fn (array $c): bool => $c['pending'])),
                    ]);
                }

                return $relabelled;
            });
        } catch (UniqueConstraintViolationException) {
            throw new ValidationException(['label' => $this->duplicateMessage($category, false)]);
        }

        $usage = $this->usageByKey($category);

        return $item->toArray($usage[$item->getLabelKey()] ?? 0) + [
            'specialists_updated' => count(array_filter($changes, static fn (array $c): bool => !$c['pending'])),
        ];
    }

    /**
     * Put a list in a new order: `ids` names items of the list in the order
     * wanted (any it leaves out follow, in their current order). Sort orders
     * become 10, 20, 30… Returns the whole list (staff shape).
     *
     * @return list<array<string,mixed>>
     */
    public function reorder(string $category, mixed $ids, ?string $actorId, string $actorName): array
    {
        $this->assertCategory($category);
        if (!is_array($ids) || $ids === [] || array_filter($ids, static fn (mixed $id): bool => !is_string($id)) !== []) {
            throw new ValidationException(['ids' => 'Send the ids of the list\'s items in the order you want']);
        }
        $ids = array_values($ids);
        if (count(array_unique($ids)) !== count($ids)) {
            throw new ValidationException(['ids' => 'Each item may appear only once']);
        }

        $current = $this->items->listFor($category);
        $byId    = [];
        foreach ($current as $item) {
            $byId[$item->getId()] = $item;
        }
        $unknown = array_diff($ids, array_keys($byId));
        if ($unknown !== []) {
            throw new ValidationException(['ids' => 'Some of these items are not in this list — reload it and try again']);
        }

        $ordered = array_map(static fn (string $id): ReferenceItem => $byId[$id], $ids);
        foreach ($current as $item) {
            if (!in_array($item->getId(), $ids, true)) {
                $ordered[] = $item;
            }
        }

        $beforeLabels = array_map(static fn (ReferenceItem $i): string => $i->getLabel(), $current);
        $afterLabels  = array_map(static fn (ReferenceItem $i): string => $i->getLabel(), $ordered);
        $moved        = false;
        foreach ($ordered as $n => $item) {
            $moved = $moved || $item->getSortOrder() !== ($n + 1) * 10;
        }

        if ($moved) {
            $this->em->wrapInTransaction(function () use ($ordered, $category, $beforeLabels, $afterLabels, $actorId, $actorName): void {
                foreach ($ordered as $n => $item) {
                    $item->setSortOrder(($n + 1) * 10);
                    $this->items->persist($item);
                }
                $this->items->flush();
                $this->audit->record($actorName, 'admin', 'reference.reordered', null, 'reference_list', $category, [
                    'category' => $category,
                    'before'   => $beforeLabels,
                    'after'    => $afterLabels,
                ], $actorId);
            });
        }

        return $this->staffItems($category);
    }

    /**
     * How many change requests waiting for review ask for each label of a
     * list, keyed like {@see usageByKey()}.
     *
     * @return array<string,int>
     */
    public function requestedByKey(string $category): array
    {
        $raw = match ($category) {
            ReferenceCategory::SPECIALTY => $this->specialists->requestedSpecialtyUsage(),
            default                      => [],
        };
        $out = [];
        foreach ($raw as $value => $count) {
            $key       = ReferenceItem::keyOf((string) $value);
            $out[$key] = ($out[$key] ?? 0) + $count;
        }

        return $out;
    }

    /**
     * Delete an item nobody uses; one in use is refused (422) — switch it off
     * instead, which keeps it on the records that have it. "In use" counts
     * change requests waiting for review that ask for it, too: approved, they
     * would leave the doctor with a label that is no longer on the list.
     */
    public function delete(string $category, string $id, ?string $actorId, string $actorName): void
    {
        $item  = $this->itemOrFail($category, $id);
        $usage = $this->usageByKey($category)[$item->getLabelKey()] ?? 0;
        if ($usage > 0) {
            $message = 'In use by ' . ReferenceCategory::usedBy($category, $usage) . ' — deactivate it instead';
            throw new ValidationException(['item' => $message], $message);
        }
        $requested = $this->requestedByKey($category)[$item->getLabelKey()] ?? 0;
        if ($requested > 0) {
            $message = 'Requested by ' . ReferenceCategory::usedBy($category, $requested) . ' — deactivate it instead';
            throw new ValidationException(['item' => $message], $message);
        }
        $this->em->wrapInTransaction(function () use ($item, $category, $actorId, $actorName): void {
            if ($item->isActive()) {
                $this->assertNotLastActive($category, 'item');
            }
            $this->record($actorId, $actorName, 'reference.deleted', $item, [
                'label'  => $item->getLabel(),
                'code'   => $item->getCode(),
                'active' => $item->isActive(),
            ]);
            $this->items->remove($item);
            $this->items->flush();
        });
    }

    /**
     * A list keeps at least one active item: with none, every form that offers
     * it would have nothing to choose and the API would refuse every value.
     * Runs inside the change's transaction with the active rows locked, so two
     * admins switching off the last two items at once can't both pass.
     */
    private function assertNotLastActive(string $category, string $field = 'active'): void
    {
        if ($this->items->lockedActiveCount($category) > 1) {
            return;
        }
        $message = $this->lastActiveMessage($category);
        throw new ValidationException([$field => $message], $message);
    }

    private function lastActiveMessage(string $category): string
    {
        return 'Keep at least one ' . strtolower(ReferenceCategory::label($category))
            . ' switched on — the forms need something to offer';
    }

    private function itemOrFail(string $category, string $id): ReferenceItem
    {
        $this->assertCategory($category);
        $item = $this->items->findInCategory($category, $id);
        if ($item === null) {
            throw EntityNotFoundException::for('Reference item', $id);
        }

        return $item;
    }

    /**
     * Re-label the records that store `$from` and audit each against its record.
     *
     * @return list<array{id:string, name:string, from:string, pending:bool}>
     */
    private function relabel(string $category, string $from, string $to, ?string $actorId, string $actorName): array
    {
        if ($category !== ReferenceCategory::SPECIALTY) {
            return [];
        }
        $changes = $this->specialists->renameSpecialty($from, $to);
        foreach ($changes as $change) {
            $field = $change['pending'] ? 'requested_specialty' : 'specialty';
            $this->audit->record($actorName, 'admin', 'specialist.updated', null, 'specialist', $change['id'], [
                'before' => [$field => $change['from']],
                'after'  => [$field => $to],
                'doctor' => $change['name'],
                'reason' => 'Specialty renamed in the reference list',
            ], $actorId);
        }

        return $changes;
    }

    /**
     * A submitted label, normalised, if it is valid for `$category` (and not
     * another item's label); else null with the reason in `$errors['label']`.
     *
     * @param array<string,string> $errors
     */
    private function validLabel(string $category, mixed $raw, ?ReferenceItem $self, array &$errors): ?string
    {
        $label = is_scalar($raw) ? ReferenceItem::normaliseLabel((string) $raw) : '';
        if ($label === '') {
            $errors['label'] = 'Enter a name';

            return null;
        }
        if (mb_strlen($label) > ReferenceItem::LABEL_MAX) {
            $errors['label'] = 'Keep it under ' . ReferenceItem::LABEL_MAX . ' characters';

            return null;
        }
        $other = $this->items->findByLabel($category, $label);
        if ($other !== null && ($self === null || $other->getId() !== $self->getId())) {
            $errors['label'] = $this->duplicateMessage($category, !$other->isActive());

            return null;
        }

        return $label;
    }

    private function duplicateMessage(string $category, bool $inactive): string
    {
        $what = mb_strtolower(ReferenceCategory::label($category));

        return $inactive
            ? "That {$what} is already in the list but switched off — turn it back on instead"
            : "That {$what} is already in the list";
    }

    /** @param array<string,string> $errors */
    private function validSortOrder(mixed $raw, array &$errors): ?int
    {
        $ok = is_int($raw) || (is_string($raw) && preg_match('/^\d{1,6}$/', trim($raw)) === 1);
        if (!$ok || (int) $raw < 0 || (int) $raw > 999999) {
            $errors['sort_order'] = 'Enter a whole number from 0';

            return null;
        }

        return (int) $raw;
    }

    /** @param array<string,string> $errors */
    private function validBool(mixed $raw, string $field, array &$errors): ?bool
    {
        $value = is_bool($raw) ? $raw : filter_var($raw, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
        if ($value === null) {
            $errors[$field] = 'Choose yes or no';
        }

        return $value;
    }

    /** @param array<string,mixed> $metadata */
    private function record(?string $actorId, string $actorName, string $action, ReferenceItem $item, array $metadata): void
    {
        $this->audit->record(
            $actorName,
            'admin',
            $action,
            null,
            'reference_item',
            $item->getId(),
            ['category' => $item->getCategory()] + $metadata,
            $actorId,
        );
    }
}
