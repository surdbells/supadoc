<?php

declare(strict_types=1);

namespace App\Infrastructure\Application;

use App\Domain\Application\ApplicationDocuments;
use App\Domain\Application\ApplicationStateMachine as SM;
use App\Domain\Entity\DoctorApplication;
use App\Domain\Entity\DoctorApplicationDocument;
use App\Domain\Entity\DoctorApplicationEvent;
use App\Domain\Entity\DoctorApplicationInfoRequest;
use App\Domain\Entity\DoctorApplicationNote;
use App\Domain\Entity\SpecialistCredential;
use App\Domain\Enum\DoctorApplicationStatus as S;
use App\Domain\Exception\ApplicationProblem;
use App\Domain\Exception\EntityNotFoundException;
use App\Domain\Exception\ValidationException;
use App\Domain\Repository\DoctorApplicationDocumentRepository;
use App\Domain\Repository\DoctorApplicationInfoRequestRepository;
use App\Domain\Repository\DoctorApplicationNoteRepository;
use App\Domain\Repository\DoctorApplicationRepository;
use App\Domain\Repository\SpecialistCredentialRepository;
use App\Domain\Settings\ClinicTime;
use App\Infrastructure\Service\AuditLogger;
use App\Infrastructure\Storage\ApplicationDocumentStore;
use App\Infrastructure\Storage\CredentialStore;
use DateTimeImmutable;
use Doctrine\DBAL\Exception\UniqueConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * The back office's side of doctor applications (spec §3.3), all under
 * `specialists.manage`: the list, the queue counts, the detail, the audited
 * document view, the staff transitions (start / resume review, request more
 * info, schedule / resend the interview, reject) and the internal notes.
 * Approval is {@see ApplicationApprovalService}. Drafts are never visible
 * here (404).
 *
 * Every transition: one transaction, the application advisory lock, a
 * re-read row lock, the optional `expected_status` (409 `status_changed`),
 * then the state machine; one event and one audit row; the applicant's
 * email + SMS after the commit.
 */
final class ApplicationReviewService
{
    public const MAX_MESSAGE = 2000;
    public const MAX_ITEMS   = 10;
    public const RESEND_COOLDOWN = 300;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DoctorApplicationRepository $applications,
        private readonly DoctorApplicationDocumentRepository $documents,
        private readonly DoctorApplicationInfoRequestRepository $requests,
        private readonly DoctorApplicationNoteRepository $notes,
        private readonly SpecialistCredentialRepository $credentials,
        private readonly ApplicationDocumentStore $store,
        private readonly CredentialStore $credentialStore,
        private readonly ApplicationNotifier $notifier,
        private readonly ApplicationViews $views,
        private readonly AuditLogger $audit,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @param array<string,mixed> $query q, filter, route, sort, page, per_page (≤ 50)
     * @return array{items: list<array<string,mixed>>, total:int, page:int, per_page:int}
     */
    public function list(array $query): array
    {
        $filter  = in_array($query['filter'] ?? null, DoctorApplicationRepository::FILTERS, true) ? (string) $query['filter'] : 'all';
        $route   = in_array($query['route'] ?? null, ['ng', 'abroad'], true) ? (string) $query['route'] : null;
        $sort    = in_array($query['sort'] ?? null, DoctorApplicationRepository::SORTS, true)
            ? (string) $query['sort']
            : ($filter === 'needs_action' ? 'waiting' : 'newest');
        $page    = max(1, (int) ($query['page'] ?? 1));
        $perPage = max(1, min(50, (int) ($query['per_page'] ?? 20)));
        $q       = is_string($query['q'] ?? null) ? mb_substr(trim($query['q']), 0, 100) : null;

        $result = $this->applications->adminPage($q, $filter, $route, $sort, ClinicTime::now()->getTimestamp(), ($page - 1) * $perPage, $perPage);

        return [
            'items'    => array_map(static fn (DoctorApplication $a): array => ApplicationViews::row($a), $result['items']),
            'total'    => $result['total'],
            'page'     => $page,
            'per_page' => $perPage,
        ];
    }

    /** DoctorApplicationQueueDto: the nav badge and filter counts, never cached. @return array<string,int> */
    public function queue(): array
    {
        $now   = ClinicTime::now();
        $start = $now->setTime(0, 0);

        return $this->applications->queueCounts($now->getTimestamp(), $start->getTimestamp(), $start->modify('+1 day')->getTimestamp());
    }

    /** @return array<string,mixed> DoctorApplicationDetailDto */
    public function detail(string $id): array
    {
        return $this->views->detail($this->submittedOrFail($id));
    }

    /**
     * A document's bytes for a reviewer (audited): the application's copy, or
     * — once carried over at approval — the credential's.
     *
     * @return array{0: DoctorApplicationDocument, 1: string}
     */
    public function documentFile(string $id, string $docId, ?string $actorId, string $actorName): array
    {
        $app = $this->submittedOrFail($id);
        $doc = $this->documents->findForApplication($docId, $app->getId()) ?? throw new EntityNotFoundException('Document not found');
        $bytes = null;
        if ($doc->getFilePurgedAt() !== null && $doc->getCredentialId() !== null) {
            $credential = $this->credentials->find($doc->getCredentialId());
            $bytes      = $credential instanceof SpecialistCredential ? $this->credentialStore->bytes($credential->getVaultKey()) : null;
        } elseif ($doc->getFilePurgedAt() === null) {
            $bytes = $this->store->bytes($doc->getVaultKey());
        }
        if ($bytes === null) {
            throw new ApplicationProblem(404, 'file_missing', 'This document could not be read.');
        }
        $this->record($actorName, 'doctor_application.document_viewed', $app, ['slot' => $doc->getSlot(), 'document_id' => $doc->getId()], $actorId);

        return [$doc, $bytes];
    }

    /**
     * Start (or resume) the review. The applicant hears only the first time.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> DoctorApplicationDetailDto
     */
    public function startReview(string $id, array $body, ?string $actorId, string $actorName): array
    {
        $app = $this->transition($id, $body, SM::START_REVIEW, function (DoctorApplication $app, S $from, ?S $to, DateTimeImmutable $now) use ($actorId, $actorName): void {
            $first = $app->markReviewStarted($now, $actorName);
            $app->setStatus($to ?? S::UNDER_REVIEW);
            $app->setAwaitingStaff(false);
            $this->requests->openFor($app->getId())?->close(DoctorApplicationInfoRequest::CLOSE_STAFF_RESUMED, $now);
            $this->em->persist(new DoctorApplicationEvent($app->getId(), 'review_started', 'staff', $from->value, S::UNDER_REVIEW->value, $actorId, $actorName, true, at: $now));
            $this->record($actorName, 'doctor_application.review_started', $app, ['resumed' => !$first], $actorId);
            if ($first) {
                $this->notifier->underReview($app);
            }
        });

        return $this->views->detail($app);
    }

    /**
     * Ask the applicant for more: a message and 1–10 items (sections; document
     * slots of their route, or `additional` with a label). From the interview
     * stage this cancels the interview.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function requestInfo(string $id, array $body, ?string $actorId, string $actorName): array
    {
        $message = is_string($body['message'] ?? null) ? trim($body['message']) : '';
        $errors  = [];
        if ($message === '' || mb_strlen($message) > self::MAX_MESSAGE) {
            $errors['message'] = $message === '' ? 'Write a message to the applicant.' : 'Keep the message under ' . self::MAX_MESSAGE . ' characters.';
        }
        $current = $this->submittedOrFail($id);
        $items   = $this->items($body['items'] ?? null, $current->getLicenceRoute(), $errors);
        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        $app = $this->transition($id, $body, SM::REQUEST_INFO, function (DoctorApplication $app, S $from, ?S $to, DateTimeImmutable $now) use ($actorId, $actorName, $message, $items): void {
            $cancelled = null;
            if (SM::cancelsInterview($from, SM::REQUEST_INFO) && $app->hasInterview()) {
                $cancelled = ApplicationViews::interview($app)['starts_at_label'] ?? null;
                $this->em->persist(new DoctorApplicationEvent($app->getId(), 'interview_cancelled', 'staff', $from->value, null, $actorId, $actorName, false, metadata: [
                    'starts_epoch'     => $app->getInterviewEpoch(),
                    'duration_minutes' => $app->getInterviewDurationMinutes(),
                ], at: $now));
                $app->clearInterview();
            }
            $request = new DoctorApplicationInfoRequest($app->getId(), $actorId, $actorName, $message, $items, $now);
            $this->em->persist($request);
            $app->setStatus($to ?? S::MORE_INFO_NEEDED);
            $app->setAwaitingStaff(false);
            $this->em->persist(new DoctorApplicationEvent($app->getId(), 'info_requested', 'staff', $from->value, S::MORE_INFO_NEEDED->value, $actorId, $actorName, true, $message, ['items' => count($items), 'info_request_id' => $request->getId()], $now));
            $this->record($actorName, 'doctor_application.info_requested', $app, ['items' => array_map(static fn (array $i): string => $i['kind'] . ':' . $i['key'], $items), 'interview_cancelled' => $cancelled !== null], $actorId);
            $this->notifier->infoRequested($app, $request, $cancelled);
        });

        return $this->views->detail($app);
    }

    /**
     * Schedule (or move) the interview: an instant WITH its offset (a bare
     * "…T10:00" would be read on the server's clock), 15 minutes to 90 days
     * ahead; an https meeting link.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function scheduleInterview(string $id, array $body, ?string $actorId, string $actorName): array
    {
        [$startsAt, $minutes, $url, $note] = self::interviewInput($body, ClinicTime::now());

        $app = $this->transition($id, $body, SM::SCHEDULE_INTERVIEW, function (DoctorApplication $app, S $from, ?S $to, DateTimeImmutable $now) use ($actorId, $actorName, $startsAt, $minutes, $url, $note): void {
            $rescheduled = $from === S::INTERVIEW_SCHEDULED;
            $app->scheduleInterview($startsAt, $minutes, $url, $note);
            $app->markInterviewNotified($now);
            $app->setStatus($to ?? S::INTERVIEW_SCHEDULED);
            $app->setAwaitingStaff(false);
            $kind = $rescheduled ? 'interview_rescheduled' : 'interview_scheduled';
            $this->em->persist(new DoctorApplicationEvent($app->getId(), $kind, 'staff', $from->value, S::INTERVIEW_SCHEDULED->value, $actorId, $actorName, true, $note, [
                'starts_epoch'     => $startsAt->getTimestamp(),
                'duration_minutes' => $minutes,
            ], $now));
            $this->record($actorName, 'doctor_application.' . $kind, $app, ['starts_epoch' => $startsAt->getTimestamp(), 'duration_minutes' => $minutes], $actorId);
            $this->notifier->interview($app, $rescheduled);
        });

        return $this->views->detail($app);
    }

    /**
     * Send the interview details again (5-minute cooldown).
     *
     * @return array<string,mixed>
     */
    public function resendInterview(string $id, ?string $actorId, string $actorName): array
    {
        $app = $this->transition($id, [], SM::RESEND_INTERVIEW, function (DoctorApplication $app, S $from, ?S $to, DateTimeImmutable $now) use ($actorId, $actorName): void {
            $last = $app->getInterviewNotifiedAt();
            if ($last !== null && $now->getTimestamp() - $last->getTimestamp() < self::RESEND_COOLDOWN) {
                throw new ApplicationProblem(429, 'resend_cooldown', 'The interview details were sent a moment ago. Try again in a few minutes.', [
                    'retry_after' => self::RESEND_COOLDOWN - ($now->getTimestamp() - $last->getTimestamp()),
                ]);
            }
            $app->markInterviewNotified($now);
            $this->em->persist(new DoctorApplicationEvent($app->getId(), 'interview_resent', 'staff', null, null, $actorId, $actorName, false, at: $now));
            $this->record($actorName, 'doctor_application.interview_resent', $app, [], $actorId);
            $this->notifier->interview($app, false);
        });

        return $this->views->detail($app);
    }

    /**
     * Reject, with a reason the applicant sees.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function reject(string $id, array $body, ?string $actorId, string $actorName): array
    {
        $reason = is_string($body['reason'] ?? null) ? trim($body['reason']) : '';
        if ($reason === '' || mb_strlen($reason) > self::MAX_MESSAGE) {
            throw new ValidationException(['reason' => $reason === '' ? 'Tell the applicant why.' : 'Keep the reason under ' . self::MAX_MESSAGE . ' characters.']);
        }
        $app = $this->transition($id, $body, SM::REJECT, function (DoctorApplication $app, S $from, ?S $to, DateTimeImmutable $now) use ($actorId, $actorName, $reason): void {
            $app->setStatus($to ?? S::REJECTED);
            $app->setRejectReason($reason);
            $app->setAwaitingStaff(false);
            $app->markDecided($now, $actorId, $actorName);
            $this->requests->openFor($app->getId())?->close(DoctorApplicationInfoRequest::CLOSE_REJECTED, $now);
            $this->em->persist(new DoctorApplicationEvent($app->getId(), 'rejected', 'staff', $from->value, S::REJECTED->value, $actorId, $actorName, true, $reason, at: $now));
            $this->record($actorName, 'doctor_application.rejected', $app, [], $actorId);
            $this->notifier->rejected($app);
        });

        return $this->views->detail($app);
    }

    /** @return list<array<string,string>> DoctorApplicationNoteDto[], newest first */
    public function notes(string $id): array
    {
        $app = $this->submittedOrFail($id);

        return array_map(static fn (DoctorApplicationNote $n): array => $n->toArray(), $this->notes->forApplication($app->getId()));
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,string> DoctorApplicationNoteDto
     */
    public function addNote(string $id, array $body, ?string $actorId, string $actorName): array
    {
        $app  = $this->submittedOrFail($id);
        $text = is_string($body['body'] ?? null) ? trim($body['body']) : '';
        if ($text === '' || mb_strlen($text) > DoctorApplicationNote::MAX_BODY) {
            throw new ValidationException(['body' => $text === '' ? 'Write the note first.' : 'Keep the note under ' . DoctorApplicationNote::MAX_BODY . ' characters.']);
        }
        $note = new DoctorApplicationNote($app->getId(), $actorId, $actorName, $text);
        $this->em->persist($note);
        $this->em->flush();
        $this->record($actorName, 'doctor_application.note_added', $app, ['note_id' => $note->getId()], $actorId);

        return $note->toArray();
    }

    // ----- Helpers -----

    /** The application unless it is a draft (drafts are never shown to staff). */
    public function submittedOrFail(string $id): DoctorApplication
    {
        $app = $this->applications->findApplication($id);
        if ($app === null || $app->isDraft()) {
            throw new EntityNotFoundException('Application not found');
        }

        return $app;
    }

    /**
     * The interview form, checked (spec §3.3.7).
     *
     * @param array<string,mixed> $body
     * @return array{0: DateTimeImmutable, 1: int, 2: string, 3: ?string}
     */
    public static function interviewInput(array $body, DateTimeImmutable $now): array
    {
        $errors = [];
        $raw    = is_string($body['starts_at'] ?? null) ? trim($body['starts_at']) : '';
        $starts = null;
        if (preg_match('/(Z|[+-]\d{2}:\d{2})$/', $raw) !== 1) {
            $errors['starts_at'] = 'Enter the date and time with its time zone.';
        } else {
            try {
                $starts = new DateTimeImmutable($raw);
            } catch (\Throwable) {
                $errors['starts_at'] = 'Enter the date and time with its time zone.';
            }
        }
        if ($starts !== null) {
            $t = $starts->getTimestamp();
            if ($t < $now->getTimestamp() + 15 * 60 || $t > $now->getTimestamp() + 90 * 86400) {
                $errors['starts_at'] = 'Choose a time from 15 minutes to 90 days from now.';
            }
        }
        $minutes = $body['duration_minutes'] ?? null;
        if (!in_array($minutes, [15, 30, 45, 60], true)) {
            $errors['duration_minutes'] = 'Choose 15, 30, 45 or 60 minutes.';
        }
        $url = is_string($body['meeting_url'] ?? null) ? trim($body['meeting_url']) : '';
        if (!self::meetingUrlOk($url)) {
            $errors['meeting_url'] = 'Paste the full https:// meeting link.';
        }
        $note = $body['note'] ?? null;
        if ($note !== null && (!is_string($note) || mb_strlen(trim($note)) > 500)) {
            $errors['note'] = 'Keep the note under 500 characters.';
        }
        if ($errors !== []) {
            throw new ValidationException($errors, (string) reset($errors));
        }

        return [$starts, (int) $minutes, $url, is_string($note) && trim($note) !== '' ? trim($note) : null];
    }

    /** https only, a host with a dot, no user or password, ≤ 500 characters. */
    public static function meetingUrlOk(string $url): bool
    {
        if ($url === '' || strlen($url) > 500 || preg_match('/\s/', $url) === 1) {
            return false;
        }
        $parts = parse_url($url);

        return is_array($parts)
            && strtolower((string) ($parts['scheme'] ?? '')) === 'https'
            && str_contains((string) ($parts['host'] ?? ''), '.')
            && !isset($parts['user'])
            && !isset($parts['pass']);
    }

    /**
     * The request's items, checked: unique, 1–10, sections (not consent) and
     * document slots of this route, `additional` with a 2–120 character label.
     *
     * @param array<string,string> $errors
     * @return list<array{kind:string, key:string, label:string}>
     */
    private function items(mixed $raw, string $route, array &$errors): array
    {
        if (!is_array($raw) || $raw === [] || count($raw) > self::MAX_ITEMS) {
            $errors['items'] = 'Choose 1 to ' . self::MAX_ITEMS . ' items to ask for.';

            return [];
        }
        $items = [];
        foreach ($raw as $item) {
            $kind = is_array($item) ? ($item['kind'] ?? null) : null;
            $key  = is_array($item) ? ($item['key'] ?? null) : null;
            if ($kind === 'section' && is_string($key) && isset(ApplicationViews::SECTION_LABELS[$key])) {
                $items[$kind . ':' . $key] = ['kind' => 'section', 'key' => $key, 'label' => ApplicationViews::SECTION_LABELS[$key]];
                continue;
            }
            if ($kind === 'document' && is_string($key) && ApplicationDocuments::requestable($key, $route)) {
                $label = ApplicationDocuments::label($key, $route);
                if ($key === ApplicationDocuments::ADDITIONAL) {
                    $label = is_string($item['label'] ?? null) ? trim($item['label']) : '';
                    if (mb_strlen($label) < 2 || mb_strlen($label) > 120) {
                        $errors['items'] = 'Say which other document you need (2 to 120 characters).';
                        continue;
                    }
                }
                if (isset($items[$kind . ':' . $key])) {
                    $errors['items'] = 'Ask for each item once.';
                    continue;
                }
                $items[$kind . ':' . $key] = ['kind' => 'document', 'key' => $key, 'label' => $label];
                continue;
            }
            $errors['items'] = "One of the items can't be requested for this application.";
        }

        return array_values($items);
    }

    /**
     * One staff transition: lock, re-read, `expected_status`, the state
     * machine, then `$work(app, from, to, now)`; the notices go after commit.
     *
     * @param array<string,mixed> $body
     * @param callable(DoctorApplication, S, ?S, DateTimeImmutable): void $work
     */
    private function transition(string $id, array $body, string $action, callable $work): DoctorApplication
    {
        $this->submittedOrFail($id);
        $conn = $this->em->getConnection();
        $conn->beginTransaction();
        try {
            $conn->executeStatement('SELECT pg_advisory_xact_lock(' . DoctorApplicationService::LOCK_APPLICATION . ', hashtext(?))', [$id]);
            $app = $this->applications->findForUpdate($id) ?? throw new EntityNotFoundException('Application not found');
            self::assertExpected($app, $body);
            $from = $app->getStatus();
            $to   = SM::assertCan($from, $action);
            $work($app, $from, $to, ClinicTime::now());
            $this->em->flush();
            $conn->commit();
        } catch (\Throwable $e) {
            if ($conn->isTransactionActive()) {
                $conn->rollBack();
            }
            $this->notifier->discard();
            if ($e instanceof UniqueConstraintViolationException) {
                $this->logger?->warning('Doctor application unique constraint', ['application_id' => $id, 'error' => $e::class]);

                throw new ApplicationProblem(409, 'status_changed', 'This application changed while you were working on it. Reload and try again.');
            }

            throw $e;
        }
        $this->notifier->dispatch();

        return $app;
    }

    /** @param array<string,mixed> $body */
    public static function assertExpected(DoctorApplication $app, array $body): void
    {
        $expected = $body['expected_status'] ?? null;
        if (is_string($expected) && $expected !== '' && $expected !== $app->getStatus()->value) {
            throw new ApplicationProblem(409, 'status_changed', 'This application changed while you were looking at it. Reload and try again.', ['status' => $app->getStatus()->value]);
        }
    }

    /** @param array<string,mixed> $metadata */
    private function record(string $actorName, string $action, DoctorApplication $app, array $metadata, ?string $actorId): void
    {
        try {
            $this->audit->record($actorName, 'admin', $action, null, 'doctor_application', $app->getId(), ['reference' => $app->getReference()] + $metadata, $actorId);
        } catch (\Throwable $e) {
            $this->logger?->warning('Doctor application audit not recorded', ['application_id' => $app->getId(), 'error' => $e::class]);
        }
    }
}
