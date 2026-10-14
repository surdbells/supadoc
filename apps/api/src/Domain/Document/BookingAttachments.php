<?php

declare(strict_types=1);

namespace App\Domain\Document;

/**
 * Which of the documents a patient asks to attach to a new booking they may
 * attach: only their own (an unknown id and another patient's read the same,
 * so ids can't be probed) and only one not already attached to another
 * appointment. Pure — the caller supplies what the database holds.
 */
final class BookingAttachments
{
    public const NOT_FOUND = 'One of your attachments could not be found. Remove it and try again.';
    public const TAKEN     = 'One of your attachments is already attached to another appointment. Remove it and upload it again.';

    /**
     * Field errors (`document_ids.N`, N = the id's position in the request) for
     * every id that can't be attached; empty when all of them can.
     *
     * @param array<int,string>     $ids    position in the request => document id
     * @param array<string,?string> $states the patient's own documents among
     *                                      them: id => the appointment it is attached to, or null
     * @return array<string,string>
     */
    public static function problems(array $ids, array $states): array
    {
        $errors = [];
        foreach ($ids as $i => $id) {
            if (!array_key_exists($id, $states)) {
                $errors["document_ids.$i"] = self::NOT_FOUND;
            } elseif ($states[$id] !== null) {
                $errors["document_ids.$i"] = self::TAKEN;
            }
        }

        return $errors;
    }
}
