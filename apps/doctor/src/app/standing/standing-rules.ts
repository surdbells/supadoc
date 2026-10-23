import type {
  CredentialType,
  DoctorOnboardingDto,
  DoctorStandingCode,
  LicenceStateDto,
  SpecialistCredentialDto,
} from '@supadoc/models';

/**
 * The doctor portal's standing rules, pure (the guard, the interceptor, the
 * dashboard and the onboarding pages share them). They mirror the API's
 * `DoctorStanding`: a suspended doctor, or one not approved yet, is kept out of
 * clinical pages; one who owes the practitioner terms may read everything but
 * starts no clinical work (the API refuses those writes).
 */

/** Pages every doctor may open whatever their standing: their account, setup, money and the status page. */
const ALWAYS_PAGES = [
  '/dashboard',
  '/onboarding',
  '/account-status',
  '/profile',
  '/earnings',
  '/payouts',
  '/notifications',
  '/settings',
  '/auth',
];

/** What a doctor still setting up also needs (the API's SETUP routes). */
const SETUP_PAGES = ['/availability'];

/** The path of a router URL, without query or fragment ('/schedule?x=1' → '/schedule'). */
function pathOf(url: string): string {
  const path = url.split(/[?#]/)[0] ?? '';
  return '/' + path.replace(/^\/+/, '');
}

function under(path: string, pages: readonly string[]): boolean {
  return pages.some((p) => path === p || path.startsWith(p + '/'));
}

/** Kept out of clinical pages altogether (terms_required only blocks clinical writes). */
export function isBlockingStanding(code: DoctorStandingCode | null | undefined): boolean {
  return code === 'doctor_suspended' || code === 'doctor_not_approved';
}

/** May a doctor whose standing is `code` (null: good standing) open the page at `url`? */
export function pageAllowed(code: DoctorStandingCode | null | undefined, url: string): boolean {
  if (!isBlockingStanding(code)) return true;
  const path = pathOf(url);
  if (path === '/' || under(path, ALWAYS_PAGES)) return true;
  return code === 'doctor_not_approved' && under(path, SETUP_PAGES);
}

/** The portal section a URL belongs to ('/appointments/12' → 'appointments'), for the status page's "you tried to open …". */
export function sectionOf(url: string): string {
  return pathOf(url).split('/')[1] ?? '';
}

/** What a blocked section is called on the status page, mid-sentence ("You tried to open …"). */
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  schedule: 'your schedule',
  appointments: 'consultations',
  patients: 'patient records',
  prescriptions: 'prescriptions',
  availability: 'your availability',
  reviews: 'reviews',
  call: 'a video consultation',
};

/** Whole days from `todayYmd` to `ymd` (both 'YYYY-MM-DD'; negative once it has passed). */
export function daysUntil(ymd: string, todayYmd: string): number {
  const at = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((at(ymd) - at(todayYmd)) / 86_400_000);
}

/** "today" / "tomorrow" / "in 12 days" — how soon a licence runs out. */
export function inDaysLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** A 'YYYY-MM-DD' as "16 Oct 2026" (the calendar date as written, never shifted by a time zone). */
export function ymdLabel(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return '';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/**
 * How the doctor's licensing reads. A doctor licensed in Nigeria holds an MDCN
 * number, the MDCN full-registration certificate and an annual practising
 * licence; one licensed abroad (approved from an application) holds a
 * registration with their own regulator, a Certificate of Good Standing and
 * that regulator's practising licence. Older payloads without a route read
 * as Nigeria.
 */
export interface LicenceWording {
  readonly abroad: boolean;
  /** "MDCN", or the regulator's name ("General Medical Council"); "your regulator" when unknown. */
  readonly regulator: string;
  /** "MDCN number" / "General Medical Council number" (the API's `registration_label`). */
  readonly numberLabel: string;
  /** "the MDCN register" / "the General Medical Council register". */
  readonly registerName: string;
  /** The document in place of the MDCN full-registration certificate. */
  readonly registrationDoc: string;
  readonly registrationType: CredentialType;
  /** The practising licence. */
  readonly licenceDoc: string;
  readonly licenceType: CredentialType;
}

export function licenceWording(
  o: Pick<DoctorOnboardingDto, 'licence_route' | 'registration'> | null | undefined,
): LicenceWording {
  if (o?.licence_route !== 'abroad') {
    return {
      abroad: false,
      regulator: 'MDCN',
      numberLabel: 'MDCN number',
      registerName: 'the MDCN register',
      registrationDoc: 'MDCN full-registration certificate',
      registrationType: 'mdcn_full_registration',
      licenceDoc: 'Annual practising licence',
      licenceType: 'annual_practising_licence',
    };
  }
  const name = (o.registration?.regulator_name ?? '').trim();
  return {
    abroad: true,
    regulator: name || 'your regulator',
    numberLabel: name ? `${name} number` : 'Registration number',
    registerName: name ? `the ${name} register` : "your regulator's register",
    registrationDoc: 'Certificate of Good Standing',
    registrationType: 'good_standing_certificate',
    licenceDoc: 'Practising licence',
    licenceType: 'foreign_practising_licence',
  };
}

/** Documents only an application carries (verified with it; shown, never uploaded or deleted here). */
export const APPLICATION_ONLY_TYPES: readonly CredentialType[] = ['government_id', 'medical_degree', 'curriculum_vitae'];

/**
 * The document of `type` the doctor sees now — the newest one that hasn't been
 * replaced (the API lists newest first and leaves replaced ones out).
 */
export function latestCredential(
  credentials: readonly SpecialistCredentialDto[] | null | undefined,
  type: CredentialType,
): SpecialistCredentialDto | null {
  return (credentials ?? []).find((c) => c.type === type && c.status !== 'superseded') ?? null;
}

/**
 * The practising licence to show, and a renewal beside it. While the licence
 * is in force (`licence.status` valid / expiring) a newer upload still waiting
 * for verification, or turned down, doesn't replace it: `current` stays the
 * verified licence it rests on and the upload is the `renewal`. Otherwise the
 * newest upload is the licence and there is no renewal. `type` is the route's
 * licence (the annual practising licence, or the foreign one abroad).
 */
export function licenceDocuments(
  credentials: readonly SpecialistCredentialDto[] | null | undefined,
  licence: LicenceStateDto | null | undefined,
  type: CredentialType = 'annual_practising_licence',
): { current: SpecialistCredentialDto | null; renewal: SpecialistCredentialDto | null } {
  const latest = latestCredential(credentials, type);
  const inForce = licence?.status === 'valid' || licence?.status === 'expiring';
  if (!inForce || !latest || (latest.status !== 'pending' && latest.status !== 'rejected')) {
    return { current: latest, renewal: null };
  }
  const current = (credentials ?? []).find((c) => c.type === type && c.status === 'verified') ?? null;
  return { current, renewal: latest };
}

/** A renewal's line beside the licence in force: "Renewal … waiting for verification" / "Renewal not accepted: …". */
export function renewalText(renewal: SpecialistCredentialDto): string {
  if (renewal.status === 'rejected') {
    return `Renewal not accepted${renewal.rejection_reason ? `: ${renewal.rejection_reason}` : ' — upload a clearer or current copy.'}`;
  }
  return `Renewal${renewal.expires_at ? ` (to ${ymdLabel(renewal.expires_at)})` : ''} waiting for verification.`;
}

/** A banner on the dashboard: what needs the doctor's attention about their account. */
export interface StandingNotice {
  readonly key: string;
  readonly tone: 'alert' | 'warning' | 'info';
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  readonly cta: string;
  readonly link: string;
}

/** Labels for the change-request fields, in the order the profile shows them. */
export const CHANGE_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  specialty: 'Speciality',
  mdcn_number: 'MDCN number',
  qualifications: 'Qualifications',
  qualification_entries: 'Qualifications',
  certifications: 'Certifications',
};

/**
 * "Name, MDCN number and Qualifications" — what a change request asks to
 * change. `numberLabel` names the registration number ("MDCN number", or the
 * regulator's abroad).
 */
export function changedFieldsLabel(fields: readonly string[], numberLabel = 'MDCN number'): string {
  const label = (f: string): string => (f === 'mdcn_number' ? numberLabel : (CHANGE_FIELD_LABELS[f] ?? f));
  const names = [...new Set(fields.map(label))];
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What the dashboard says about the doctor's account, most urgent first: a
 * suspension (alone — nothing else matters until it is lifted), the onboarding
 * stage until approval, then for an approved doctor the terms to accept, the
 * licence running out (or gone), documents still owed or turned down, and a
 * change request waiting for a reviewer (a refused one is explained on the
 * profile, not here — the note stays until the next request).
 */
export function standingNotices(o: DoctorOnboardingDto, todayYmd: string): StandingNotice[] {
  if (o.status === 'suspended') {
    const why = [o.suspension?.code_label, o.suspension?.reason].filter(Boolean).join(': ');
    return [
      {
        key: 'suspended',
        tone: 'alert',
        icon: 'ban',
        title: 'Your account is suspended',
        text: why
          ? `${why}. Patients can't book you and clinical tools are closed.`
          : "Patients can't book you and clinical tools are closed.",
        cta: 'See details',
        link: '/account-status',
      },
    ];
  }

  const w = licenceWording(o);
  // A doctor approved from an application: vetted already, they go live themselves.
  const fromApplication = !!o.application;

  switch (o.status) {
    case 'pending_review':
      return [
        {
          key: 'review',
          tone: 'info',
          icon: 'hourglass',
          title: fromApplication ? 'Your profile is having a quick final check' : 'Your profile is being reviewed',
          text: fromApplication
            ? "We'll email you when you're live. Until then patients can't find or book you."
            : "We'll email you once it's approved. Until then patients can't find or book you.",
          cta: 'View status',
          link: '/onboarding',
        },
      ];
    case 'rejected':
      return [
        {
          key: 'rejected',
          tone: 'warning',
          icon: 'circle-alert',
          title: 'Your profile needs a few changes',
          text: 'See what to update, then submit your profile for review again.',
          cta: 'See changes',
          link: '/onboarding',
        },
      ];
    case 'invited':
      return [
        fromApplication
          ? {
              key: 'setup',
              tone: 'info',
              icon: 'list-checks',
              title: 'Finish setting up your profile to go live',
              text: `${o.completed} of ${o.total} steps done — your documents were verified with your application.`,
              cta: 'Continue setup',
              link: '/onboarding',
            }
          : {
              key: 'setup',
              tone: 'info',
              icon: 'list-checks',
              title: 'Finish setting up your profile',
              text: `${o.completed} of ${o.total} steps done — patients can book you once your profile is approved.`,
              cta: 'Continue setup',
              link: '/onboarding',
            },
      ];
  }

  const notices: StandingNotice[] = [];

  if (o.terms && !o.terms.accepted) {
    notices.push({
      key: 'terms',
      tone: 'warning',
      icon: 'scroll-text',
      title: o.terms.accepted_version
        ? `The practitioner terms were updated to version ${o.terms.current_version}`
        : 'Accept the VideoMed practitioner terms',
      text: "Read and accept them to keep consulting — until then you can't join calls or write clinical records.",
      cta: 'Read and accept',
      link: '/onboarding/terms',
    });
  }

  const licence = o.licence;
  if (licence?.status === 'expired' && licence.expires_at) {
    notices.push({
      key: 'licence-expired',
      tone: 'alert',
      icon: 'badge-alert',
      title: 'Your practising licence has expired',
      text: `It expired on ${ymdLabel(licence.expires_at)}. Upload your renewed licence now — without a current, verified licence your account will be suspended.`,
      cta: 'Upload renewal',
      link: '/onboarding/credentials',
    });
  } else if (licence?.status === 'expiring' && licence.expires_at) {
    const days = daysUntil(licence.expires_at, todayYmd);
    const { renewal } = licenceDocuments(o.credentials, licence, w.licenceType);
    const waiting = renewal?.status === 'pending' && (renewal.expires_at ?? '') > licence.expires_at;
    notices.push({
      key: 'licence-expiring',
      tone: waiting ? 'info' : 'warning',
      icon: 'badge-alert',
      title: `Your practising licence expires ${inDaysLabel(days)}`,
      text: waiting
        ? `Your renewed licence is waiting for verification. The current one is valid until ${ymdLabel(licence.expires_at)}.`
        : `It's valid until ${ymdLabel(licence.expires_at)}. Upload your renewed licence so a reviewer can verify it in time.`,
      cta: waiting ? 'View documents' : 'Upload renewal',
      link: '/onboarding/credentials',
    });
  }

  if (o.credentials_due_at) {
    const uploaded = o.checklist?.mdcn_certificate && o.checklist?.practising_licence;
    notices.push({
      key: 'credentials-missing',
      tone: uploaded ? 'info' : 'warning',
      icon: 'file-check',
      title: uploaded ? 'Your documents are being verified' : 'Upload your licensing documents',
      text: uploaded
        ? `A reviewer is checking your ${w.abroad ? 'Certificate of Good Standing' : 'MDCN certificate'} and practising licence against ${w.registerName}.`
        : w.abroad
          ? `Add your Certificate of Good Standing and current practising licence by ${ymdLabel(o.credentials_due_at)}.`
          : `Add your MDCN full-registration certificate and current annual practising licence by ${ymdLabel(o.credentials_due_at)}.`,
      cta: uploaded ? 'View documents' : 'Upload documents',
      link: '/onboarding/credentials',
    });
  }

  for (const type of [w.registrationType, w.licenceType]) {
    const doc = latestCredential(o.credentials, type);
    if (doc?.status === 'rejected') {
      // A refused renewal beside a licence still in force: the licence itself stands.
      const renewal = type === w.licenceType && licenceDocuments(o.credentials, licence, w.licenceType).renewal === doc;
      notices.push({
        key: `rejected-${type}`,
        tone: 'warning',
        icon: 'circle-x',
        title: renewal ? "Your licence renewal wasn't accepted" : `Your ${doc.type_label.toLowerCase()} wasn't accepted`,
        text: doc.rejection_reason ? `Reviewer's note: ${doc.rejection_reason}` : 'Upload a clearer or current copy.',
        cta: 'Replace it',
        link: '/onboarding/credentials',
      });
    }
  }

  if (o.pending_changes && Object.keys(o.pending_changes).length > 0) {
    notices.push({
      key: 'changes-pending',
      tone: 'info',
      icon: 'hourglass',
      title: 'Your profile changes are waiting for review',
      text: `${changedFieldsLabel(Object.keys(o.pending_changes), w.numberLabel)}: patients see your current details until a reviewer approves the change.`,
      cta: 'View request',
      link: '/profile',
    });
  }

  return notices;
}
