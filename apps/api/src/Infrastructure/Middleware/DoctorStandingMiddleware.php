<?php

declare(strict_types=1);

namespace App\Infrastructure\Middleware;

use App\Domain\Call\CallAccess;
use App\Domain\Doctor\DoctorStanding;
use App\Domain\Entity\Appointment;
use App\Domain\Entity\Prescription;
use App\Domain\Entity\Specialist;
use App\Domain\Repository\AppointmentRepository;
use App\Domain\Repository\PrescriptionRepository;
use App\Domain\Repository\SpecialistRepository;
use App\Domain\Repository\UserRepository;
use DateTimeImmutable;
use App\Infrastructure\Service\ApiResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;
use Slim\Routing\RouteContext;

/**
 * Keeps doctor logins to the doctor portal, and a doctor who may not practise
 * out of clinical work, on every staff route (runs after AuthMiddleware):
 *
 *  - a doctor-only login may use the doctor portal (/doctor/…) and their own
 *    account (/me…) — any other staff route is refused whatever their
 *    standing (403, `errors.code` doctor_portal_only), e.g. the appointment
 *    list a doctor login's `appointments.view` would otherwise open;
 *  - in the portal, a suspended doctor, or one not approved yet, may only use
 *    the routes {@see DoctorStanding::allows()} lets them, and one who hasn't
 *    accepted the practitioner terms in force may read but start no clinical
 *    work (403, `errors.code` doctor_suspended | doctor_not_approved |
 *    terms_required).
 *
 * Only tokens carrying the `doctor` role cost a lookup; a login that is also
 * back-office staff keeps its staff routes (only the portal is gated).
 */
final class DoctorStandingMiddleware implements MiddlewareInterface
{
    use ApiResponse;

    private const PORTAL_ONLY = 'A doctor login can only use the doctor portal.';

    public function __construct(
        private readonly UserRepository $users,
        private readonly SpecialistRepository $specialists,
        private readonly AppointmentRepository $appointments,
        private readonly PrescriptionRepository $prescriptions,
    ) {
    }

    public function process(
        ServerRequestInterface $request,
        RequestHandlerInterface $handler,
    ): ResponseInterface {
        $roles = (array) $request->getAttribute('user_roles', []);
        if (!in_array('doctor', $roles, true)) {
            return $handler->handle($request);
        }

        $path     = self::routePath($request);
        $inPortal = $path === '/doctor' || str_starts_with($path, '/doctor/');
        // Their own account (password, notifications) stays open to every doctor.
        if (!$inPortal && ($path === '/me' || str_starts_with($path, '/me/'))) {
            return $handler->handle($request);
        }

        $user = $this->users->find((string) $request->getAttribute('user_id'));
        if ($user === null || !in_array('doctor', $user->getRoles(), true)) {
            return $handler->handle($request); // no longer a doctor: RBAC / the action decide
        }
        if (!$inPortal) {
            // A login that is also back-office staff keeps its staff routes. A
            // doctor-only login has no business on them, whatever its standing
            // — e.g. GET /appointments, which its `appointments.view` would
            // otherwise open with every patient's contact details.
            return self::alsoStaff($user->getRoles())
                ? $handler->handle($request)
                : $this->error(new Response(), self::PORTAL_ONLY, 403, ['code' => 'doctor_portal_only']);
        }
        if ($user->getSpecialistId() === null) {
            return $handler->handle($request); // the action itself refuses an unlinked login
        }

        $doctor = $this->specialists->find($user->getSpecialistId());
        if (!$doctor instanceof Specialist) {
            return $handler->handle($request);
        }
        $problem = DoctorStanding::problem($doctor);
        if ($problem === null || DoctorStanding::allows($problem[0], $request->getMethod(), $path)) {
            return $handler->handle($request);
        }
        // Owing only the terms (a new version published mid-consultation): the
        // doctor may still finish a consultation of theirs that has started —
        // notes, prescriptions, completion — exactly as the call itself allows
        // ({@see CallAccess::doctorProblem()}). Anything else stays refused.
        if ($problem[0] === DoctorStanding::TERMS && $this->underWayFor($request, $path, $doctor)) {
            return $handler->handle($request);
        }
        [$code, $message] = $problem;

        return $this->error(new Response(), $message, 403, ['standing' => $message, 'code' => $code]);
    }

    /**
     * Whether this request works on one of the doctor's own consultations that
     * has already started: /doctor/appointments/{id}/…, or a prescription for
     * one (POST /doctor/prescriptions with `appointment_id`, or
     * /doctor/prescriptions/{rxId}/…).
     */
    private function underWayFor(ServerRequestInterface $request, string $path, Specialist $doctor): bool
    {
        $appointmentId = null;
        if (str_starts_with($path, '/doctor/appointments/{id}')) {
            $appointmentId = self::routeArgument($request, 'id');
        } elseif ($path === '/doctor/prescriptions') {
            $body          = $request->getParsedBody();
            $appointmentId = is_array($body) && is_string($body['appointment_id'] ?? null) ? $body['appointment_id'] : null;
        } elseif (str_starts_with($path, '/doctor/prescriptions/{rxId}')) {
            $rxId = self::routeArgument($request, 'rxId');
            $rx   = $rxId !== null ? $this->prescriptions->find($rxId) : null;
            $appointmentId = $rx instanceof Prescription ? $rx->getAppointmentId() : null;
        }
        if ($appointmentId === null || $appointmentId === '') {
            return false;
        }
        $appointment = $this->appointments->find($appointmentId);

        return $appointment instanceof Appointment
            && $appointment->getSpecialist()->getId() === $doctor->getId()
            && CallAccess::doctorProblem($appointment, new DateTimeImmutable()) === null;
    }

    /** A matched route's argument, or null (not routed yet / absent). */
    private static function routeArgument(ServerRequestInterface $request, string $name): ?string
    {
        try {
            $value = RouteContext::fromRequest($request)->getRoute()?->getArgument($name);
        } catch (\Throwable) {
            return null;
        }

        return is_string($value) && $value !== '' ? $value : null;
    }

    /** Whether a login with these roles is back-office staff as well as a doctor. */
    public static function alsoStaff(array $roles): bool
    {
        return array_diff($roles, ['doctor']) !== [];
    }

    /** The matched route's pattern after `/api` (e.g. "/doctor/appointments/{id}"), else the request path. */
    private static function routePath(ServerRequestInterface $request): string
    {
        $path = $request->getUri()->getPath();
        try {
            $route = RouteContext::fromRequest($request)->getRoute();
            if ($route !== null) {
                $path = $route->getPattern();
            }
        } catch (\Throwable) {
            // not routed yet (tests) — the raw path is fine
        }
        $at = strpos($path, '/api/');

        return $at !== false ? substr($path, $at + 4) : $path;
    }
}
