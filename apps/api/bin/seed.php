<?php

declare(strict_types=1);

/**
 * Dev seed. Idempotent — safe to re-run. Prints the IDs/credentials you need to
 * exercise the API. Refuses to run when APP_ENV=production.
 *
 *   php bin/seed.php
 */

use App\Domain\Entity\Appointment;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\NotificationType;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

if (($_ENV['APP_ENV'] ?? 'development') === 'production') {
    fwrite(STDERR, "Refusing to seed in production.\n");
    exit(1);
}

$em       = DoctrineEntityManagerFactory::create();
$password = 'password123';

// Full-access staff. Explicit permissions (NOT super_admin) so RBAC actually
// matches the token's permissions rather than short-circuiting.
$adminEmail = 'admin@videomed.test';
if ($em->getRepository(User::class)->findOneBy(['email' => $adminEmail]) === null) {
    $admin = new User($adminEmail, 'Ada', 'Admin');
    $admin->setPassword($password);
    $admin->setRoles(['admin']);
    $admin->setPermissions(['appointments.view', 'appointments.create', 'appointments.book', 'appointments.update']);
    $em->persist($admin);
}

// Read-only staff: has view but not create/book — proves RBAC denies (403).
$viewerEmail = 'viewer@videomed.test';
if ($em->getRepository(User::class)->findOneBy(['email' => $viewerEmail]) === null) {
    $viewer = new User($viewerEmail, 'Vic', 'Viewer');
    $viewer->setPassword($password);
    $viewer->setRoles(['staff']);
    $viewer->setPermissions(['appointments.view']);
    $em->persist($viewer);
}

// Customer/patient for the portal (customer-scoped token).
$patientEmail = 'patient@videomed.test';
$patient      = $em->getRepository(Patient::class)->findOneBy(['email' => $patientEmail]);
if ($patient === null) {
    $patient = new Patient($patientEmail, 'Pat', 'Patient');
    $patient->setPassword($password);
    $patient->setPhone('+15551230000');
    $patient->setDateOfBirth(new DateTimeImmutable('1990-05-12'));
    $patient->setGender('Female');
    $patient->setAddress('14 Freedom Way, Lekki Phase 1, Lagos, Nigeria');
    $patient->setEmergencyContact([
        'full_name'    => 'Michael Patient',
        'relationship' => 'Spouse',
        'phone'        => '+15551230011',
        'email'        => 'michael@videomed.test',
    ]);
    $patient->setInsurance([
        'provider'        => 'BlueShield Health Partners',
        'plan'            => 'PPO Silver 250',
        'policy_number'   => 'BH-2291-8834',
        'coverage_status' => 'Active',
        'expiry_date'     => '2027-04-11',
    ]);
    $patient->setMedical([
        'history'     => [['condition' => 'Appendectomy', 'year' => '2016', 'note' => 'Keyhole surgery']],
        'allergies'   => [['allergen' => 'Penicillin', 'severity' => 'High', 'reaction' => 'Hives']],
        'medications' => [['name' => 'Metformin', 'dosage' => '500mg', 'frequency' => 'Twice daily']],
        'conditions'  => [['condition' => 'Type 2 Diabetes', 'status' => 'Managed', 'since' => '2018']],
    ]);
    $em->persist($patient);
}

// Bookable specialists. Fees are money-as-string. The first (Grace Bell) is the
// one the seeded appointments reference.
// [name, specialty, fee, location, rating, reviews, available, years, languages, verified]
$specialistSeeds = [
    ['Dr. Grace Bell', 'Cardiology', '150.00', 'Lagos, NG', '4.80', 128, true, 14, 'English, French', true],
    ['Dr. Ada Obi', 'Dermatology', '90.00', 'Abuja, NG', '4.60', 84, true, 9, 'English', true],
    ['Dr. Chidi Eze', 'Pediatrics', '110.00', 'Port Harcourt, NG', '4.90', 210, true, 18, 'English, Igbo', true],
    ['Dr. Ngozi Kama', 'Neurology', '180.00', 'Lagos, NG', '4.70', 65, false, 11, 'English, French', false],
    ['Dr. Tunde Bello', 'General Practice', '70.00', 'Ibadan, NG', '4.50', 42, true, 7, 'English, Yoruba', true],
    ['Dr. Amaka Nwosu', 'Psychiatry', '130.00', 'Abuja, NG', '4.70', 96, true, 12, 'English', true],
    ['Dr. Emeka Okonkwo', 'Orthopedics', '160.00', 'Lagos, NG', '4.80', 154, true, 20, 'English, Igbo', true],
    ['Dr. Fatima Bello', 'Gynecology', '120.00', 'Kano, NG', '4.90', 178, true, 15, 'English, Hausa', true],
    ['Dr. Ibrahim Sani', 'Dentistry', '80.00', 'Kaduna, NG', '4.40', 51, false, 6, 'English, Hausa', false],
    ['Dr. Zainab Yusuf', 'Ophthalmology', '100.00', 'Lagos, NG', '4.60', 73, true, 10, 'English', true],
];
$specialist = null; // first one, referenced by the appointments below
// Upsert so re-running the seed also backfills the newer columns.
foreach ($specialistSeeds as [$name, $specialty, $fee, $location, $rating, $reviews, $available, $years, $langs, $verified]) {
    $s = $em->getRepository(Specialist::class)->findOneBy(['name' => $name])
        ?? new Specialist($name, $specialty);
    $s->setConsultationFee($fee);
    $s->setLocation($location);
    $s->setRating($rating);
    $s->setReviewsCount($reviews);
    $s->setAvailable($available);
    $s->setYearsExperience($years);
    $s->setLanguages($langs);
    $s->setVerified($verified);
    $em->persist($s);
    $specialist ??= $s;
}

// A spread of appointments for the patient so the wired portal UI has real
// content across the Upcoming / Completed / Cancelled tabs.
if (count($em->getRepository(Appointment::class)->findBy(['patient' => $patient])) === 0) {
    $book = static function (string $when, ConsultationType $type, array $advance)
    use ($patient, $specialist, $em): void {
        $appt = new Appointment($patient, $specialist, new DateTimeImmutable($when), $type);
        foreach ($advance as $status) {
            $appt->transitionTo($status);
        }
        $em->persist($appt);
    };

    // Upcoming
    $book('2026-09-01 10:00', ConsultationType::VIDEO, [AppointmentStatus::CONFIRMED]);
    $book('2026-09-05 14:30', ConsultationType::FOLLOW_UP, []); // pending
    $book('2026-09-10 13:00', ConsultationType::VIDEO, [AppointmentStatus::CONFIRMED, AppointmentStatus::RESCHEDULED]);
    // Past (history)
    $book('2026-07-15 09:00', ConsultationType::ROUTINE, [AppointmentStatus::CONFIRMED, AppointmentStatus::COMPLETED]);
    $book('2026-07-20 16:00', ConsultationType::URGENT, [AppointmentStatus::CANCELLED]);
    $book('2026-06-28 11:00', ConsultationType::VIDEO, [AppointmentStatus::CONFIRMED, AppointmentStatus::COMPLETED]);
}

// Notifications for the patient (a mix of unread/read across types).
if (count($em->getRepository(Notification::class)->findBy(['patient' => $patient])) === 0) {
    $notify = static function (NotificationType $type, string $title, string $body, bool $read)
    use ($patient, $em): void {
        $n = new Notification($patient, $type, $title, $body);
        if ($read) {
            $n->markRead();
        }
        $em->persist($n);
    };

    $notify(NotificationType::APPOINTMENT, 'Appointment confirmed', 'Your consultation with Dr. Grace Bell is confirmed for 1 Sep, 11:00 AM.', false);
    $notify(NotificationType::PRESCRIPTION, 'Prescription ready', 'Your prescription from Dr. Grace Bell is ready for pickup.', false);
    $notify(NotificationType::PAYMENT, 'Payment received', 'We received your $150.00 payment for a video consultation.', true);
    $notify(NotificationType::SYSTEM, 'Welcome to VideoMed', 'Complete your profile to get the most out of VideoMed.', true);
}

$em->flush();

fwrite(STDOUT, json_encode([
    'admin_email'   => $adminEmail,
    'viewer_email'  => $viewerEmail,
    'patient_email' => $patientEmail,
    'password'      => $password,
    'patient_id'    => $patient->getId(),
    'specialist_id' => $specialist->getId(),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
