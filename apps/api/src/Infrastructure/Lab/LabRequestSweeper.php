<?php

declare(strict_types=1);

namespace App\Infrastructure\Lab;

use App\Domain\Entity\LabRequest;
use App\Domain\Entity\LabRequestResult;
use App\Domain\Lab\LabRequestRules;
use App\Domain\Repository\LabRequestRepository;
use DateTimeImmutable;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The lab request cron jobs (spec §2.6), run by bin/send-reminders.php:
 *
 *  - T10 the patient's reminder of an unanswered request (2 h STAT / 12 h
 *    urgent / 48 h routine after sending);
 *  - T11 the doctor's "not accepted yet" (4 h STAT / 24 h urgent);
 *  - T12 the doctor's review reminder of a REVIEWABLE result (4 h STAT /
 *    urgent, 48 h routine; in-app + email) and the escalation to
 *    `labs.manage` staff after 7 days — also when the doctor can't review
 *    (suspended, not practising): someone has to contact the patient;
 *  - T13 the patient's "waiting for your result?" nudge (2 / 7 days in the lab);
 *  - T9 storing expiries (the status is computed on read anyway), with
 *    notices only for ones that expired within the last 3 days.
 *
 * Each job works in batches of 200; each row is re-checked under its row
 * lock and marked through its own `…_at` column BEFORE its notice goes, so a
 * re-run never sends twice. A row that fails is logged (ids, class) and left.
 */
final class LabRequestSweeper
{
    private const BATCH = 200;

    /** Pages of review candidates one run walks at most (not-reviewable ones stay candidates). */
    private const MAX_PAGES = 10;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LabRequestRepository $requests,
        private readonly LabRequestService $service,
        private readonly LabRequestNotifier $notifier,
    ) {
    }

    /** @return array{reminded:int, expired:int, doctor_nudged:int, review_reminded:int, escalated:int, result_nudged:int, errors:int} */
    public function run(?DateTimeImmutable $now = null): array
    {
        $now ??= LabRequestRules::now();
        $out = ['reminded' => 0, 'expired' => 0, 'doctor_nudged' => 0, 'review_reminded' => 0, 'escalated' => 0, 'result_nudged' => 0, 'errors' => 0];

        // T9 first: an expired request is never reminded.
        foreach ($this->requests->dueExpiryIds($now, self::BATCH) as $id) {
            $this->row($out, function () use ($id, $now, &$out): void {
                // transition() stores the expiry (T9, actor system) when it is due by the run's clock.
                $r = $this->service->transition($id, fn (LabRequest $r, DateTimeImmutable $at, bool $settled): ?LabRequest => $settled ? $r : null, $now);
                if ($r !== null) {
                    ++$out['expired'];
                    $this->notifier->expired($r, $r->getExpiresAt() < $now->modify('-' . LabRequestRules::QUIET_AFTER_DAYS . ' days'));
                }
            });
        }

        foreach ($this->requests->dueReminderIds($now, self::BATCH) as $id) {
            $this->row($out, function () use ($id, $now, &$out): void {
                $r = $this->service->transition($id, function (LabRequest $r, DateTimeImmutable $at) use ($now): ?LabRequest {
                    if ($r->getStatus() !== LabRequest::STATUS_AWAITING_CONSENT || $r->getRemindedAt() !== null || $r->getExpiresAt() <= $at) {
                        return null;
                    }
                    $hours = LabRequestRules::REMINDER_HOURS[$r->getPriority()] ?? LabRequestRules::REMINDER_HOURS['routine'];
                    if ($r->getSentAt() > $now->modify('-' . $hours . ' hours')) {
                        return null;
                    }
                    $r->markReminded($at);
                    $this->service->event($r, 'reminded', $r->getStatus(), $r->getStatus(), 'system', null, null, null, $at);

                    return $r;
                }, $now);
                if ($r !== null) {
                    ++$out['reminded'];
                    $this->notifier->reminder($r);
                }
            });
        }

        foreach ($this->requests->dueDoctorNudgeIds($now, self::BATCH) as $id) {
            $this->row($out, function () use ($id, $now, &$out): void {
                $r = $this->service->transition($id, function (LabRequest $r, DateTimeImmutable $at) use ($now): ?LabRequest {
                    $hours = LabRequestRules::DOCTOR_NUDGE_HOURS[$r->getPriority()] ?? null;
                    if ($hours === null || $r->getStatus() !== LabRequest::STATUS_AWAITING_CONSENT || $r->getDoctorNudgedAt() !== null
                        || $r->getExpiresAt() <= $at || $r->getSentAt() > $now->modify('-' . $hours . ' hours')) {
                        return null;
                    }
                    $r->markDoctorNudged($at);

                    return $r;
                }, $now);
                if ($r !== null) {
                    ++$out['doctor_nudged'];
                    $this->notifier->doctorNotAccepted($r);
                }
            });
        }

        // T12 reminder: only while the doctor can actually open the result.
        [$afterAt, $afterId] = [null, null];
        for ($page = 0; $page < self::MAX_PAGES; ++$page) {
            $batch = $this->requests->dueReviewReminders($now, $afterAt, $afterId, self::BATCH);
            foreach ($batch as $row) {
                $this->row($out, function () use ($row, $now, &$out): void {
                    $request = $this->lockedResult($row['id'], $now, function (LabRequestResult $res) use ($now): ?LabRequest {
                        if ($res->getReviewedAt() !== null || $res->getReviewRemindedAt() !== null || !$this->service->isReviewable($res, $now)) {
                            return null;
                        }
                        $res->markReviewReminded($now);

                        return $res->getRequest();
                    });
                    if ($request !== null) {
                        ++$out['review_reminded'];
                        $this->notifier->doctorReviewReminder($request);
                    }
                });
            }
            if (count($batch) < self::BATCH) {
                break;
            }
            $last    = end($batch);
            $afterAt = $last['uploaded_at'];
            $afterId = $last['id'];
        }

        // T12 escalation: after 7 days, whoever the doctor is.
        foreach ($this->requests->dueReviewEscalations($now, null, null, self::BATCH) as $row) {
            $this->row($out, function () use ($row, $now, &$out): void {
                $request = $this->lockedResult($row['id'], $now, function (LabRequestResult $res) use ($now): ?LabRequest {
                    if ($res->getReviewedAt() !== null || $res->getReviewEscalatedAt() !== null) {
                        return null;
                    }
                    $res->markReviewEscalated($now);
                    $this->service->auditLab('System', 'system', 'lab_result.review_escalated', $res->getRequest(), ['result_id' => $res->getId()], null, 'lab_result', $res->getId());

                    return $res->getRequest();
                });
                if ($request !== null) {
                    ++$out['escalated'];
                    $this->notifier->staffReviewEscalation($request);
                }
            });
        }

        foreach ($this->requests->dueResultNudgeIds($now, self::BATCH) as $id) {
            $this->row($out, function () use ($id, $now, &$out): void {
                $r = $this->service->transition($id, function (LabRequest $r, DateTimeImmutable $at) use ($now): ?LabRequest {
                    $days = LabRequestRules::RESULT_NUDGE_DAYS[$r->getPriority()] ?? LabRequestRules::RESULT_NUDGE_DAYS['routine'];
                    if ($r->getStatus() !== LabRequest::STATUS_IN_LAB || $r->getResultRemindedAt() !== null || $r->getSampleAt() === null
                        || $r->getSampleAt() > $now->modify('-' . $days . ' days')) {
                        return null;
                    }
                    $r->markResultReminded($at);

                    return $r;
                }, $now);
                if ($r !== null) {
                    ++$out['result_nudged'];
                    $this->notifier->resultNudge($r);
                }
            });
        }

        return $out;
    }

    /**
     * `$work($result)` in one transaction under the result's REQUEST row lock
     * (the one lock order), the result re-read.
     *
     * @template T
     * @param callable(LabRequestResult): T $work
     * @return T|null
     */
    private function lockedResult(string $resultId, DateTimeImmutable $now, callable $work): mixed
    {
        $requestId = $this->em->getConnection()->fetchOne('SELECT lab_request_id FROM lab_request_results WHERE id = :id', ['id' => $resultId]);
        if ($requestId === false) {
            return null;
        }

        return $this->service->transition((string) $requestId, function (LabRequest $r) use ($resultId, $work): mixed {
            $res = $this->em->find(LabRequestResult::class, $resultId);
            if (!$res instanceof LabRequestResult) {
                return null;
            }
            $this->em->refresh($res, LockMode::PESSIMISTIC_WRITE);

            return $work($res);
        }, $now);
    }

    /** One row: a failure is logged (ids and the class only) and the run goes on. @param array<string,int> $out */
    private function row(array &$out, callable $job): void
    {
        try {
            $job();
        } catch (\Throwable $e) {
            ++$out['errors'];
            error_log('[lab] sweeper row failed: ' . $e::class);
            if (!$this->em->isOpen()) {
                throw $e; // the caller starts again on a fresh container
            }
        }
    }
}
