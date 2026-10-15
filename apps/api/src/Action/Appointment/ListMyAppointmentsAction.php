<?php

declare(strict_types=1);

namespace App\Action\Appointment;

use App\Domain\Appointment\AppointmentLifecycle;
use App\Domain\Entity\Appointment;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Settings\BookingSettings;
use App\Infrastructure\Service\ApiResponse;
use App\Infrastructure\Service\CallPresence;
use DateTimeImmutable;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * GET /api/portal/appointments — the signed-in customer's own appointments.
 * `customer_id` comes from CustomerAuthMiddleware, so a customer can only ever
 * read their own records. `?status=` (comma-separated, e.g. `proposed`)
 * narrows the list; unknown values are ignored.
 *
 * `?when=` splits it by TIME (not status): `upcoming` — still to come or live
 * (started and not yet 30 minutes past its end, or someone in the call),
 * soonest first: the Appointments page and the dashboard's next appointment;
 * `past` — over (completed, cancelled, missed, or ended), newest first: the
 * History page. With `when` the order is fixed (sort_by / sort_dir ignored).
 * Any other non-empty `when` is refused (422 errors.when) — never silently
 * answered with the whole list. `can_reschedule` is false inside the
 * late-cancellation window (the reschedule would be refused).
 */
final class ListMyAppointmentsAction
{
    use ApiResponse;

    /** The `?when=` values a patient may ask for. */
    private const WHEN = ['upcoming', 'past'];

    public function __construct(
        private readonly AppointmentRepository $repo,
        private readonly CallPresence $presence,
        private readonly BookingSettings $settings,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        $customerId = (string) $request->getAttribute('customer_id');
        $query      = $request->getQueryParams();
        $p          = $this->getPaginationParams($query);
        $rawWhen    = $query['when'] ?? null;
        $when       = AppointmentRepository::parseWhen($rawWhen, self::WHEN);
        if ($when === null && (is_array($rawWhen) || trim((string) $rawWhen) !== '')) {
            return $this->error($response, 'Validation failed', 422, ['when' => 'Use upcoming or past']);
        }
        $now        = new DateTimeImmutable();
        $live       = $when !== null ? CallPresence::liveIds($this->presence->forPatient($customerId)) : [];
        $lateHours  = $this->settings->get('late_cancel_hours');

        $result = $this->repo->paginated(
            $p['offset'],
            $p['per_page'],
            $p['sort_by'],
            $p['sort_dir'],
            $customerId,
            $this->parseStatuses($query['status'] ?? null),
            $when,
            $now,
            $live,
        );

        return $this->paginated(
            $response,
            array_map(static function (Appointment $a) use ($now, $live, $lateHours): array {
                $row = array_merge(
                    $a->toArray('patient', $now),
                    // Someone in the call: it is live, whatever the clock says.
                    in_array($a->getId(), $live, true) ? $a->lifecycleFields($now, 'patient', true) : [],
                );
                // Moving it inside the late-cancellation window is refused (422).
                if ($row['can_reschedule'] && AppointmentLifecycle::inLateWindow($a, $now, $lateHours)) {
                    $row['can_reschedule'] = false;
                }

                return $row;
            }, $result['items']),
            $result['total'],
            $p['page'],
            $p['per_page'],
        );
    }

    /**
     * Normalise case and validate against the enum so junk never reaches SQL
     * (Postgres `=` is case-sensitive — see ARCHITECTURE §11).
     *
     * @return list<AppointmentStatus>|null
     */
    private function parseStatuses(mixed $raw): ?array
    {
        if (!is_string($raw) || $raw === '') {
            return null;
        }

        $valid = array_values(array_filter(array_map(
            static fn (string $s): ?AppointmentStatus =>
                AppointmentStatus::tryFrom(strtolower(trim($s))),
            explode(',', $raw),
        )));

        return $valid === [] ? null : $valid;
    }
}
