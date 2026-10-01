<?php

declare(strict_types=1);

/**
 * Dev seed. Idempotent — safe to re-run. Prints the IDs/credentials you need to
 * exercise the API. Refuses to run when APP_ENV=production.
 *
 *   php bin/seed.php
 */

use App\Domain\Entity\Appointment;
use App\Domain\Entity\AvailabilitySlot;
use App\Domain\Entity\Notification;
use App\Domain\Entity\Patient;
use App\Domain\Entity\Review;
use App\Domain\Entity\Specialist;
use App\Domain\Entity\User;
use App\Domain\Enum\AppointmentStatus;
use App\Domain\Enum\ConsultationType;
use App\Domain\Enum\NotificationType;
use App\Domain\Enum\SlotKind;
use App\Infrastructure\Persistence\DoctrineEntityManagerFactory;

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

if (($_ENV['APP_ENV'] ?? 'development') === 'production') {
    fwrite(STDERR, "Refusing to seed in production.\n");
    exit(1);
}

$em       = DoctrineEntityManagerFactory::create();
$password = 'password123';

/**
 * Split a specialist display name ("Dr. Grace Bell") into [first, last] for the
 * doctor's User row. Always returns exactly two parts.
 *
 * @return array{0:string,1:string}
 */
function explodeName(string $name): array
{
    $clean = trim(preg_replace('/^(dr|prof|mr|mrs|ms)\.?\s+/i', '', $name) ?? $name);
    $parts = preg_split('/\s+/', $clean) ?: [$clean];
    $first = $parts[0] ?? $clean;
    $last  = count($parts) > 1 ? implode(' ', array_slice($parts, 1)) : 'Doctor';

    return [$first, $last];
}

// Full-access staff. Explicit permissions (NOT super_admin) so RBAC actually
// matches the token's permissions rather than short-circuiting.
$adminEmail = 'admin@videomed.test';
$admin      = $em->getRepository(User::class)->findOneBy(['email' => $adminEmail]);
if ($admin === null) {
    $admin = new User($adminEmail, 'Ada', 'Admin');
    $admin->setPassword($password);
}
// Refresh roles/permissions on every run so an existing admin picks up newly
// added back-office permissions without a manual grant.
$admin->setRoles(['admin']);
$admin->setPermissions(['appointments.view', 'appointments.create', 'appointments.book', 'appointments.update', 'settings.manage', 'specialists.manage', 'monitoring.view', 'staff.manage', 'payouts.manage', 'support.manage']);
$em->persist($admin);

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
// Recurring weekly availability templates (weekday "1"=Mon … "6"=Sat → windows).
$schedWeekday = ['1' => [['09:00', '17:00']], '2' => [['09:00', '17:00']], '3' => [['09:00', '17:00']], '4' => [['09:00', '17:00']], '5' => [['09:00', '17:00']]];
$schedSplit   = ['1' => [['08:00', '12:00'], ['13:00', '18:00']], '2' => [['08:00', '12:00'], ['13:00', '18:00']], '3' => [['08:00', '12:00'], ['13:00', '18:00']], '4' => [['08:00', '12:00'], ['13:00', '18:00']], '5' => [['08:00', '12:00'], ['13:00', '18:00']]];
$schedMorning = ['1' => [['08:00', '12:00']], '2' => [['08:00', '12:00']], '3' => [['08:00', '12:00']], '4' => [['08:00', '12:00']], '5' => [['08:00', '12:00']], '6' => [['09:00', '13:00']]];
$schedEvening = ['1' => [['14:00', '20:00']], '3' => [['14:00', '20:00']], '5' => [['14:00', '20:00']]];

// Fees are Naira (money-as-string). Doctor emails are used server-side only
// (confirmations + preauth join links) and never leave the backend in toArray.
// Set DEMO_DOCTOR_EMAIL to route the first doctor's invite to a real inbox.
// [name, specialty, fee, location, rating, reviews, available, years, languages, verified, weeklyHours, gender, inPerson, email]
$specialistSeeds = [
    ['Dr. Grace Bell', 'Cardiology', '15000.00', 'Lagos, NG', '4.80', 128, true, 14, 'English, French', true, $schedSplit, 'female', true, $_ENV['DEMO_DOCTOR_EMAIL'] ?? 'grace.bell@videomed.test'],
    ['Dr. Ada Obi', 'Dermatology', '9000.00', 'Abuja, NG', '4.60', 84, true, 9, 'English', true, $schedWeekday, 'female', false, 'ada.obi@videomed.test'],
    ['Dr. Chidi Eze', 'Pediatrics', '11000.00', 'Port Harcourt, NG', '4.90', 210, true, 18, 'English, Igbo', true, $schedMorning, 'male', true, 'chidi.eze@videomed.test'],
    ['Dr. Ngozi Kama', 'Neurology', '18000.00', 'Lagos, NG', '4.70', 65, false, 11, 'English, French', false, $schedWeekday, 'female', false, 'ngozi.kama@videomed.test'],
    ['Dr. Tunde Bello', 'General Practice', '7000.00', 'Ibadan, NG', '4.50', 42, true, 7, 'English, Yoruba', true, $schedSplit, 'male', true, 'tunde.bello@videomed.test'],
    ['Dr. Amaka Nwosu', 'Psychiatry', '13000.00', 'Abuja, NG', '4.70', 96, true, 12, 'English', true, $schedEvening, 'female', false, 'amaka.nwosu@videomed.test'],
    ['Dr. Emeka Okonkwo', 'Orthopedics', '16000.00', 'Lagos, NG', '4.80', 154, true, 20, 'English, Igbo', true, $schedWeekday, 'male', true, 'emeka.okonkwo@videomed.test'],
    ['Dr. Fatima Bello', 'Gynecology', '12000.00', 'Kano, NG', '4.90', 178, true, 15, 'English, Hausa', true, $schedMorning, 'female', true, 'fatima.bello@videomed.test'],
    ['Dr. Ibrahim Sani', 'Dentistry', '8000.00', 'Kaduna, NG', '4.40', 51, false, 6, 'English, Hausa', false, $schedWeekday, 'male', false, 'ibrahim.sani@videomed.test'],
    ['Dr. Zainab Yusuf', 'Ophthalmology', '10000.00', 'Lagos, NG', '4.60', 73, true, 10, 'English', true, $schedSplit, 'female', false, 'zainab.yusuf@videomed.test'],
];
// Per-specialty profile content so each doctor's My Profile screen (bio,
// expertise chips, qualifications + certifications) is fully populated, not blank.
$specialtyMeta = [
    'Cardiology'       => ['exp' => ['Hypertension', 'Heart failure', 'Arrhythmia', 'Echocardiography', 'Preventive cardiology'], 'degree' => 'MBBS, FWACP (Cardiology)', 'college' => 'West African College of Physicians'],
    'Dermatology'      => ['exp' => ['Acne & rosacea', 'Eczema', 'Skin-cancer screening', 'Cosmetic dermatology', 'Paediatric skin care'], 'degree' => 'MBBS, FMCP (Dermatology)', 'college' => 'National Postgraduate Medical College of Nigeria'],
    'Pediatrics'       => ['exp' => ['Newborn care', 'Childhood immunisation', 'Growth & nutrition', 'Childhood asthma', 'Developmental assessment'], 'degree' => 'MBBS, FWACP (Paediatrics)', 'college' => 'West African College of Physicians'],
    'Neurology'        => ['exp' => ['Epilepsy', 'Migraine', 'Stroke care', 'Movement disorders', 'Neuropathy'], 'degree' => 'MBBS, FMCP (Neurology)', 'college' => 'National Postgraduate Medical College of Nigeria'],
    'General Practice' => ['exp' => ['Preventive care', 'Chronic-disease management', 'Minor procedures', 'Travel medicine', 'Health screening'], 'degree' => 'MBBS, MWACP (Family Medicine)', 'college' => 'West African College of Physicians'],
    'Psychiatry'       => ['exp' => ['Anxiety & depression', 'Bipolar disorder', 'Addiction medicine', 'CBT', 'Sleep disorders'], 'degree' => 'MBBS, FWACP (Psychiatry)', 'college' => 'West African College of Physicians'],
    'Orthopedics'      => ['exp' => ['Sports injuries', 'Joint replacement', 'Fracture care', 'Arthroscopy', 'Spine disorders'], 'degree' => 'MBBS, FMCS (Orthopaedics)', 'college' => 'National Postgraduate Medical College of Nigeria'],
    'Gynecology'       => ['exp' => ['Prenatal care', 'Fertility', 'Menstrual disorders', 'Minimally-invasive surgery', 'Menopause care'], 'degree' => 'MBBS, FWACS (Obstetrics & Gynaecology)', 'college' => 'West African College of Surgeons'],
    'Dentistry'        => ['exp' => ['Restorative dentistry', 'Root-canal therapy', 'Teeth whitening', 'Orthodontics', 'Oral surgery'], 'degree' => 'BDS, FWACS (Dental Surgery)', 'college' => 'West African College of Surgeons'],
    'Ophthalmology'    => ['exp' => ['Cataract surgery', 'Glaucoma', 'Refractive errors', 'Diabetic retinopathy', 'Paediatric eye care'], 'degree' => 'MBBS, FWACS (Ophthalmology)', 'college' => 'West African College of Surgeons'],
];

$specialist = null; // first one, referenced by the appointments below
// Upsert so re-running the seed also backfills the newer columns.
$docIndex = 0;
foreach ($specialistSeeds as [$name, $specialty, $fee, $location, $rating, $reviews, $available, $years, $langs, $verified, $hours, $gender, $inPerson, $email]) {
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
    $s->setWeeklyHours($hours);
    $s->setGender($gender);
    $s->setOffersInPerson($inPerson);
    $s->setEmail($email);

    // ----- Rich profile content (bio, contact, expertise, qualifications, certs) -----
    $meta    = $specialtyMeta[$specialty] ?? ['exp' => ['General consultation'], 'degree' => 'MBBS', 'college' => 'National Postgraduate Medical College of Nigeria'];
    $pronoun = $gender === 'male' ? 'He' : 'She';
    $gradYear   = (int) date('Y') - $years;      // finished training ~ years ago
    $boardYear  = $gradYear + 4;
    $s->setCountry('Nigeria');
    $s->setPhone(sprintf('+234 80%d 000 %04d', ($docIndex % 9) + 1, 1000 + $docIndex));
    $s->setDateOfBirth(new DateTimeImmutable(sprintf('%d-0%d-1%d', 1960 + ($docIndex % 25), ($docIndex % 9) + 1, $docIndex % 9)));
    $s->setSlotMinutes(30);
    $s->setBio(sprintf(
        "%s is a %s specialist with %d years' experience caring for patients across %s. %s focuses on %s, and is committed to clear, compassionate, evidence-based care over secure video consultations.",
        $name,
        strtolower($specialty),
        $years,
        $location,
        $pronoun,
        implode(', ', array_slice($meta['exp'], 0, 3)),
    ));
    $s->setQualifications($meta['degree']);
    $s->setExpertise($meta['exp']);
    $s->setQualificationEntries([
        ['title' => $meta['degree'], 'institution' => 'College of Medicine, University of Lagos', 'year' => (string) ($gradYear - 2)],
        ['title' => 'Residency, ' . $specialty, 'institution' => 'Lagos University Teaching Hospital (LUTH)', 'year' => (string) $gradYear],
    ]);
    $s->setCertifications([
        ['name' => 'Fellowship — ' . $specialty, 'body' => $meta['college'], 'year' => (string) $boardYear],
        ['name' => 'Basic & Advanced Life Support (BLS/ACLS)', 'body' => 'Resuscitation Council', 'year' => (string) ((int) date('Y') - 1)],
    ]);

    $em->persist($s);
    $specialist ??= $s;
    $docIndex++;

    // A doctor login per specialist (their chosen option 1). They can also join
    // via the emailed preauth link without logging in.
    $doctorUser = $em->getRepository(User::class)->findOneBy(['email' => strtolower($email)]);
    if ($doctorUser === null) {
        $doctorUser = new User($email, ...explodeName($name));
        $doctorUser->setPassword($password);
    }
    $doctorUser->setRoles(['doctor']);
    $doctorUser->setPermissions(['appointments.view']);
    $doctorUser->setSpecialistId($s->getId());
    $em->persist($doctorUser);
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
    $notify(NotificationType::PAYMENT, 'Payment received', 'We received your ₦15,000.00 payment for a video consultation.', true);
    $notify(NotificationType::SYSTEM, 'Welcome to VideoMed', 'Complete your profile to get the most out of VideoMed.', true);
}

// ---------------------------------------------------------------------------
// Doctor-facing content: a patient roster + a realistic, RELATIVE-date
// appointment spread so the demo doctor's dashboard (today's agenda, upcoming,
// pending, completed-this-month, earnings, distinct patients + week/month
// deltas), Patients roster, Reviews and Availability screens all render with
// real data no matter when the seed runs. ($specialist is the first doctor.)
// ---------------------------------------------------------------------------
$roster = [
    ['grace.patient1@videomed.test', 'Amara',  'Johnson',  'female', '+2348030000101'],
    ['grace.patient2@videomed.test', 'David',  'Okafor',   'male',   '+2348030000102'],
    ['grace.patient3@videomed.test', 'Zainab', 'Abubakar', 'female', '+2348030000103'],
    ['grace.patient4@videomed.test', 'Samuel', 'Adeyemi',  'male',   '+2348030000104'],
    ['grace.patient5@videomed.test', 'Ngozi',  'Umeh',     'female', '+2348030000105'],
    ['grace.patient6@videomed.test', 'Daniel', 'Musa',     'male',   '+2348030000106'],
];
$rosterPatients    = [];
$seedDoctorContent = false;
foreach ($roster as $r => [$pemail, $pfirst, $plast, $pgender, $pphone]) {
    $p = $em->getRepository(Patient::class)->findOneBy(['email' => $pemail]);
    if ($p === null) {
        $p = new Patient($pemail, $pfirst, $plast);
        $p->setPassword($password);
        $p->setPhone($pphone);
        $p->setGender(ucfirst($pgender));
        $em->persist($p);
        if ($r === 0) {
            $seedDoctorContent = true; // first run → populate the doctor's content once
        }
    }
    $rosterPatients[] = $p;
}

if ($seedDoctorContent) {
    $fee = $specialist->getConsultationFee();
    $now = new DateTimeImmutable('now');
    /** @var array<int,array{0:Appointment,1:Patient,2:int,3:string}> $reviewSeeds */
    $reviewSeeds = [];

    $bookDoc = static function (Patient $p, string $when, ConsultationType $type, array $advance, bool $paid)
    use ($specialist, $fee, $now, $em): Appointment {
        $appt = new Appointment($p, $specialist, $now->modify($when), $type);
        $appt->setAmount($fee);
        foreach ($advance as $st) {
            $appt->transitionTo($st);
        }
        if ($paid) {
            $appt->setPaymentStatus('paid');
        }
        $em->persist($appt);

        return $appt;
    };

    [$P0, $P1, $P2, $P3, $P4, $P5] = $rosterPatients;
    $C = AppointmentStatus::CONFIRMED;
    $K = AppointmentStatus::COMPLETED;
    $X = AppointmentStatus::CANCELLED;

    // Today's agenda (completed earlier + upcoming today + a pending request)
    $a = $bookDoc($P0, 'today 09:30', ConsultationType::VIDEO, [$C, $K], true);
    $reviewSeeds[] = [$a, $P0, 5, 'Very thorough and reassuring — explained everything clearly.'];
    $bookDoc($P1, 'today 14:00', ConsultationType::VIDEO, [$C], true);
    $bookDoc($P2, 'today 16:30', ConsultationType::FOLLOW_UP, [], false); // pending

    // Upcoming
    $bookDoc($P3, '+2 days 10:00', ConsultationType::VIDEO, [$C], true);
    $bookDoc($P4, '+3 days 11:00', ConsultationType::ROUTINE, [], false); // pending
    $bookDoc($P0, '+6 days 15:00', ConsultationType::VIDEO, [$C], true);

    // Completed earlier this month → earnings + this-period patients + reviews
    $a = $bookDoc($P1, '-3 days 10:00', ConsultationType::VIDEO, [$C, $K], true);
    $reviewSeeds[] = [$a, $P1, 4, 'Helpful consultation, would book again.'];
    $a = $bookDoc($P2, '-9 days 13:00', ConsultationType::ROUTINE, [$C, $K], true);
    $reviewSeeds[] = [$a, $P2, 5, 'Excellent care and clear follow-up advice.'];
    $a = $bookDoc($P3, '-14 days 09:00', ConsultationType::URGENT, [$C, $K], true);
    $reviewSeeds[] = [$a, $P3, 5, 'Seen quickly and treated with great professionalism.'];

    // Cancelled
    $bookDoc($P4, '-22 days 16:00', ConsultationType::VIDEO, [$X], false);

    // Completed last month → the month/week delta baseline
    $a = $bookDoc($P5, '-34 days 10:00', ConsultationType::VIDEO, [$C, $K], true);
    $reviewSeeds[] = [$a, $P5, 4, 'Good experience overall.'];
    $a = $bookDoc($P0, '-41 days 14:00', ConsultationType::FOLLOW_UP, [$C, $K], true);
    $reviewSeeds[] = [$a, $P0, 5, 'Kind, attentive and knowledgeable.'];

    // Reviews for the completed consultations (populate the doctor Reviews screen).
    foreach ($reviewSeeds as [$appt, $p, $rating, $comment]) {
        $pa = $p->toArray();
        $em->persist(new Review(
            $specialist->getId(),
            $p->getId(),
            trim(((string) ($pa['first_name'] ?? '')) . ' ' . ((string) ($pa['last_name'] ?? ''))),
            $rating,
            $comment,
            $appt->getId(),
        ));
    }

    // Published open slots for the next few weekdays so the Availability calendar
    // shows real green slots on top of the recurring weekly hours.
    $midnight = $now->setTime(0, 0);
    $daysMade = 0;
    for ($d = 1; $d <= 9 && $daysMade < 4; $d++) {
        $day = $midnight->modify("+{$d} days");
        if ((int) $day->format('N') >= 6) {
            continue; // weekdays only
        }
        foreach (['09:00', '09:30', '10:00', '11:00'] as $t) {
            [$h, $m] = array_map('intval', explode(':', $t));
            $start   = $day->setTime($h, $m);
            $em->persist(new AvailabilitySlot($specialist, $start, $start->modify('+30 minutes'), SlotKind::OPEN));
        }
        $daysMade++;
    }
}

$em->flush();

fwrite(STDOUT, json_encode([
    'admin_email'   => $adminEmail,
    'viewer_email'  => $viewerEmail,
    'patient_email' => $patientEmail,
    'doctor_email'  => $specialist->getEmail(),
    'password'      => $password,
    'patient_id'    => $patient->getId(),
    'specialist_id' => $specialist->getId(),
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
