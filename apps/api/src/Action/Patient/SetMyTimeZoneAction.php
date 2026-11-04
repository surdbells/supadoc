<?php

declare(strict_types=1);

namespace App\Action\Patient;

use App\Domain\Entity\Patient;
use App\Domain\Repository\PatientRepository;
use App\Domain\Settings\TimeZones;
use App\Infrastructure\Service\ApiResponse;
use Doctrine\DBAL\LockMode;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * PUT /api/portal/me/timezone — the zone the patient's emails, texts and
 * in-app notices are written in (the apps always show times in the device's
 * zone). `source: "auto"` (detected after sign-in) writes only while no zone
 * was ever set, and only a detectable zone (never UTC, GMT, Etc/*,
 * Reykjavik…), else it is a no-op answered with the current state;
 * `source: "manual"` (Settings) always writes a valid zone.
 *
 * The write re-reads the patient under a row lock, so a detection from one
 * device can never overwrite a zone chosen in Settings a moment earlier on
 * another (they run one after the other, and the detection then sees it).
 *
 * Body: { timezone: IANA, source: "auto"|"manual" }
 * 200: { timezone, timezone_source, changed }
 */
final class SetMyTimeZoneAction
{
    use ApiResponse;

    public function __construct(
        private readonly PatientRepository $patients,
        private readonly EntityManagerInterface $em,
    ) {
    }

    public function __invoke(
        ServerRequestInterface $request,
        ResponseInterface $response,
    ): ResponseInterface {
        /** @var Patient $patient */
        $patient = $this->patients->findOrFail((string) $request->getAttribute('customer_id'));

        $body   = (array) $request->getParsedBody();
        $source = $body['source'] ?? null;
        if (!in_array($source, ['auto', 'manual'], true)) {
            return $this->error($response, 'Validation failed', 422, ['source' => 'Unknown source']);
        }
        $tz = $body['timezone'] ?? null;
        if (!TimeZones::isValid($tz)) {
            return $this->error($response, 'Validation failed', 422, ['timezone' => 'Choose a time zone from the list']);
        }
        $tz = trim((string) $tz);

        // A quick no-op answer; checked again under the lock below.
        if ($source === 'auto' && ($patient->getTimezoneSource() !== null || !TimeZones::isDetectable($tz))) {
            return $this->state($response, $patient, false);
        }

        $changed = $this->em->wrapInTransaction(function () use ($patient, $tz, $source): bool {
            // Lock the row and re-read it: a zone saved meanwhile is what we start from.
            $this->em->refresh($patient, LockMode::PESSIMISTIC_WRITE);
            if ($source === 'auto' && $patient->getTimezoneSource() !== null) {
                return false;
            }
            $from = $patient->timeZone()->getName();
            $patient->setTimezone($tz, $source);
            $this->em->flush();

            return $patient->timeZone()->getName() !== $from;
        });

        return $this->state($response, $patient, $changed);
    }

    private function state(ResponseInterface $response, Patient $p, bool $changed): ResponseInterface
    {
        return $this->success($response, [
            'timezone'        => $p->timeZone()->getName(),
            'timezone_source' => $p->getTimezoneSource(),
            'changed'         => $changed,
        ], 'Time zone saved');
    }
}
