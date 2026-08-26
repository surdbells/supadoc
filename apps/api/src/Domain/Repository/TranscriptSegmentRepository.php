<?php

declare(strict_types=1);

namespace App\Domain\Repository;

use App\Domain\Entity\TranscriptSegment;

final class TranscriptSegmentRepository extends BaseRepository
{
    protected function getEntityClass(): string
    {
        return TranscriptSegment::class;
    }

    /**
     * A consultation's transcript in spoken order (oldest first). $limit caps how
     * far back — the full transcript for the doctor, a short tail for captions.
     *
     * @return list<TranscriptSegment>
     */
    public function forAppointment(string $appointmentId, int $limit = 500): array
    {
        $rows = $this->qb()
            ->andWhere('e.appointmentId = :appointment')
            ->setParameter('appointment', $appointmentId)
            ->orderBy('e.createdAt', 'DESC')
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();

        // Fetched newest-first for the limit, returned oldest-first for reading.
        return array_reverse($rows);
    }

    /** The transcript as one plain-text conversation for the AI copilot. */
    public function transcriptText(string $appointmentId, int $limit = 500): string
    {
        $lines = [];
        foreach ($this->forAppointment($appointmentId, $limit) as $seg) {
            $lines[] = ucfirst($seg->getRole()) . ': ' . $seg->getText();
        }

        return implode("\n", $lines);
    }
}
