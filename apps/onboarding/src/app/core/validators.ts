import { APPLICATION_LANGUAGES, type ApplicationSectionKey, type LicenceRoute } from '@supadoc/models';
import { WORLD_COUNTRIES } from '@supadoc/ui';
import { formatDayMonthYear, goodStandingMinDate, parseYmd } from './format';

/**
 * The application's field rules, identical to the API's `ApplicationSections`
 * (spec §2.11): same rules, same messages, same error keys. Both sides run
 * fixtures/doctor-applications/validation-cases.json.
 */

export const MESSAGES = {
  first_name: 'Enter your first name.',
  last_name: 'Enter your last name.',
  email: 'Enter a valid email address.',
  phone: 'Enter a valid phone number.',
  date_of_birth: 'Enter a valid date of birth. You must be at least 21.',
  gender: 'Select an option.',
  country_of_residence: 'Select your country of residence.',
  city: 'Enter your city.',
  specialty: 'Choose a speciality from the list.',
  years_experience: 'Enter a number from 0 to 60.',
  workplace: 'Keep this under 150 characters.',
  languages: 'Select at least one language.',
  bio_short: 'Write at least 30 characters.',
  bio_long: 'Keep your bio to 280 characters.',
  mdcn_number: 'Enter your MDCN registration number (letters, numbers, / or -).',
  full_registration_year: 'Enter a 4-digit year, no later than this year.',
  licence_expires_on: 'Expiry date must be in the future.',
  regulator_country: 'Select the country of your regulator.',
  regulator_country_ng: 'For a Nigerian licence, go back and choose Nigeria.',
  regulator_name: "Enter your regulator's name.",
  registration_number: 'Enter your licence or registration number.',
  degree: 'Enter the degree.',
  institution: 'Enter the institution.',
  year_awarded: 'Enter a 4-digit year.',
  entries_none: 'Add your primary medical degree.',
  entries_many: 'You can add up to 10 qualifications.',
  provider: 'Enter your indemnity provider.',
  policy_number: 'Enter the policy number.',
  cover_expires_on: 'Cover expiry date must be in the future.',
  tick: 'Tick each statement to continue.',
  signature_name: 'Type your full name as it appears on your application.',
} as const;

export function goodStandingMessage(today: string): string {
  return `Must be issued on or after ${formatDayMonthYear(goodStandingMinDate(today))} (within the last 6 months).`;
}

/** Field → message. Qualification keys are `entries.{i}.{field}`. */
export type SectionErrors = Record<string, string>;

export interface ValidationContext {
  /** The specialty list's labels; without it any non-blank specialty passes here (the API still checks). */
  specialties?: readonly string[] | null;
  /** The applicant's names, for the consent signature. */
  personal?: { first_name?: unknown; last_name?: unknown } | null;
}

/** Qualifications: 1 to 10 entries (PHP `ApplicationSections::MAX_QUALIFICATIONS`). */
export const MAX_QUALIFICATIONS = 10;

const COUNTRY_CODES = new Set(WORLD_COUNTRIES.map((c) => c.iso));
const GENDERS = ['male', 'female', 'prefer_not_to_say'];
const NAME = /^[\p{L}][\p{L} .'-]*$/u;

/** Strings lose control characters and surrounding space; other values pass through. */
export function clean(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').trim() : value;
}

export function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && clean(value) === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Length in characters (code points), as PHP's mb_strlen. */
function len(s: string): number {
  return [...s].length;
}

const str = (value: unknown): string => String(clean(value) ?? '');

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

const cmp = (a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): number =>
  a.y - b.y || a.m - b.m || a.d - b.d;

/** Completed years on `today`. */
function ageOn(dob: { y: number; m: number; d: number }, today: { y: number; m: number; d: number }): number {
  let age = today.y - dob.y;
  if (today.m < dob.m || (today.m === dob.m && today.d < dob.d)) age--;
  return age;
}

/**
 * The API's `PhoneNumber::toE164` (default country Nigeria): `+`/`00` and 8–15
 * digits, `0` + 10 digits, or 10 digits starting 7/8/9. A Nigerian number
 * needs exactly 10 national digits (`+2340…` drops the trunk 0). Null if invalid.
 */
export function toE164(raw: string): string | null {
  const s = raw.replace(/[\s\-.()]/g, '');
  const intl = /^(?:\+|00)(\d{8,15})$/.exec(s);
  if (intl) {
    let digits = intl[1];
    if (digits.startsWith('2340')) digits = '234' + digits.slice(4);
    if (digits.startsWith('234') && digits.length - 3 !== 10) return null;
    return '+' + digits;
  }
  const trunk = /^0(\d{10})$/.exec(s);
  if (trunk) return '+234' + trunk[1];
  if (/^[789]\d{9}$/.test(s)) return '+234' + s;
  return null;
}

/** PHP FILTER_VALIDATE_EMAIL for the addresses applicants type (ASCII, dotted domain). */
export function isValidEmail(email: string): boolean {
  if (len(email) > 254) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** Lower case, accents dropped, spaces collapsed: for the signature check. */
export function foldName(value: unknown): string {
  return str(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Validates one section. `partial` (Save & continue later) skips only the
 * "required" checks: a value that is there must still be valid.
 */
export function validateSection(
  section: ApplicationSectionKey,
  values: Record<string, unknown>,
  route: LicenceRoute,
  todayYmd: string,
  partial: boolean,
  ctx: ValidationContext = {},
): SectionErrors {
  const today = parseYmd(todayYmd);
  if (!today) throw new Error(`Bad clinic date ${todayYmd}`);
  const e: SectionErrors = {};
  const required = (k: string) => !partial && isBlank(values[k]);
  const present = (k: string) => !isBlank(values[k]);
  const s = (k: string) => str(values[k]);

  switch (section) {
    case 'personal': {
      for (const k of ['first_name', 'last_name'] as const) {
        if (required(k)) e[k] = MESSAGES[k];
        else if (present(k) && (len(s(k)) > 100 || !NAME.test(s(k)))) e[k] = MESSAGES[k];
      }
      if (required('email')) e['email'] = MESSAGES.email;
      else if (present('email') && !isValidEmail(s('email').toLowerCase())) e['email'] = MESSAGES.email;
      if (required('phone')) e['phone'] = MESSAGES.phone;
      else if (present('phone') && toE164(s('phone')) === null) e['phone'] = MESSAGES.phone;
      if (required('date_of_birth')) e['date_of_birth'] = MESSAGES.date_of_birth;
      else if (present('date_of_birth')) {
        const dob = parseYmd(s('date_of_birth'));
        const age = dob ? ageOn(dob, today) : -1;
        if (!dob || age < 21 || age > 100) e['date_of_birth'] = MESSAGES.date_of_birth;
      }
      if (required('gender')) e['gender'] = MESSAGES.gender;
      else if (present('gender') && !GENDERS.includes(s('gender'))) e['gender'] = MESSAGES.gender;
      if (required('country_of_residence')) e['country_of_residence'] = MESSAGES.country_of_residence;
      else if (present('country_of_residence') && !COUNTRY_CODES.has(s('country_of_residence'))) {
        e['country_of_residence'] = MESSAGES.country_of_residence;
      }
      if (required('city')) e['city'] = MESSAGES.city;
      else if (present('city') && len(s('city')) > 100) e['city'] = MESSAGES.city;
      break;
    }
    case 'professional': {
      const list = ctx.specialties ? new Set(ctx.specialties.map(squash)) : null;
      if (required('specialty')) e['specialty'] = MESSAGES.specialty;
      else if (present('specialty') && list && !list.has(squash(s('specialty')))) e['specialty'] = MESSAGES.specialty;
      const years = values['years_experience'];
      if (!partial && (years === undefined || years === null)) e['years_experience'] = MESSAGES.years_experience;
      else if (years !== undefined && years !== null && (!isInt(years) || years < 0 || years > 60)) {
        e['years_experience'] = MESSAGES.years_experience;
      }
      if (present('workplace') && len(s('workplace')) > 150) e['workplace'] = MESSAGES.workplace;
      const langs = values['languages'];
      if (required('languages')) e['languages'] = MESSAGES.languages;
      else if (
        present('languages') &&
        (!Array.isArray(langs) ||
          langs.length < 1 ||
          langs.length > 5 ||
          !langs.every((l) => APPLICATION_LANGUAGES.includes(l as string)))
      ) {
        e['languages'] = MESSAGES.languages;
      }
      if (required('bio')) e['bio'] = MESSAGES.bio_short;
      else if (present('bio')) {
        const n = len(s('bio'));
        if (n < 30) e['bio'] = MESSAGES.bio_short;
        else if (n > 280) e['bio'] = MESSAGES.bio_long;
      }
      break;
    }
    case 'licence': {
      if (route === 'ng') {
        if (required('mdcn_number')) e['mdcn_number'] = MESSAGES.mdcn_number;
        else if (present('mdcn_number') && !/^[A-Z0-9/\- ]{3,40}$/.test(s('mdcn_number').toUpperCase())) {
          e['mdcn_number'] = MESSAGES.mdcn_number;
        }
        const year = values['full_registration_year'];
        if (!partial && (year === undefined || year === null)) e['full_registration_year'] = MESSAGES.full_registration_year;
        else if (year !== undefined && year !== null && (!isInt(year) || year < 1960 || year > today.y)) {
          e['full_registration_year'] = MESSAGES.full_registration_year;
        }
        if (required('licence_expires_on')) e['licence_expires_on'] = MESSAGES.licence_expires_on;
        else if (present('licence_expires_on')) {
          const d = parseYmd(s('licence_expires_on'));
          if (!d || cmp(d, today) <= 0) e['licence_expires_on'] = MESSAGES.licence_expires_on;
        }
      } else {
        if (required('regulator_country')) e['regulator_country'] = MESSAGES.regulator_country;
        else if (present('regulator_country')) {
          const c = s('regulator_country');
          if (c === 'NG') e['regulator_country'] = MESSAGES.regulator_country_ng;
          else if (!COUNTRY_CODES.has(c)) e['regulator_country'] = MESSAGES.regulator_country;
        }
        if (required('regulator_name')) e['regulator_name'] = MESSAGES.regulator_name;
        else if (present('regulator_name')) {
          const n = len(s('regulator_name'));
          if (n < 2 || n > 150) e['regulator_name'] = MESSAGES.regulator_name;
        }
        if (required('registration_number')) e['registration_number'] = MESSAGES.registration_number;
        else if (present('registration_number') && !/^[A-Za-z0-9/\- .]{3,40}$/.test(s('registration_number'))) {
          e['registration_number'] = MESSAGES.registration_number;
        }
        const min = parseYmd(goodStandingMinDate(todayYmd));
        const message = goodStandingMessage(todayYmd);
        if (required('good_standing_issued_on')) e['good_standing_issued_on'] = message;
        else if (present('good_standing_issued_on')) {
          const d = parseYmd(s('good_standing_issued_on'));
          if (!d || !min || cmp(d, min) < 0 || cmp(d, today) > 0) e['good_standing_issued_on'] = message;
        }
      }
      break;
    }
    case 'qualifications': {
      const entries = Array.isArray(values['entries']) ? (values['entries'] as Record<string, unknown>[]) : [];
      // 1–10 entries: none is a missing (required) value; more than 10 is always wrong.
      if (!partial && entries.length === 0) e['entries'] = MESSAGES.entries_none;
      if (entries.length > MAX_QUALIFICATIONS) e['entries'] = MESSAGES.entries_many;
      entries.forEach((entry, i) => {
        const en = entry ?? {};
        for (const [k, max] of [
          ['degree', 100],
          ['institution', 150],
        ] as const) {
          const key = `entries.${i}.${k}`;
          if (!partial && isBlank(en[k])) e[key] = MESSAGES[k];
          else if (!isBlank(en[k])) {
            const n = len(str(en[k]));
            if (n < 2 || n > max) e[key] = MESSAGES[k];
          }
        }
        const year = en['year_awarded'];
        const key = `entries.${i}.year_awarded`;
        if (!partial && (year === undefined || year === null)) e[key] = MESSAGES.year_awarded;
        else if (year !== undefined && year !== null && (!isInt(year) || year < 1950 || year > today.y)) {
          e[key] = MESSAGES.year_awarded;
        }
      });
      break;
    }
    case 'indemnity': {
      if (required('provider')) e['provider'] = MESSAGES.provider;
      else if (present('provider')) {
        const n = len(s('provider'));
        if (n < 2 || n > 150) e['provider'] = MESSAGES.provider;
      }
      if (required('policy_number')) e['policy_number'] = MESSAGES.policy_number;
      else if (present('policy_number') && !/^[A-Za-z0-9/\- .]{3,60}$/.test(s('policy_number'))) {
        e['policy_number'] = MESSAGES.policy_number;
      }
      if (required('cover_expires_on')) e['cover_expires_on'] = MESSAGES.cover_expires_on;
      else if (present('cover_expires_on')) {
        const d = parseYmd(s('cover_expires_on'));
        if (!d || cmp(d, today) <= 0) e['cover_expires_on'] = MESSAGES.cover_expires_on;
      }
      break;
    }
    case 'consent': {
      // A partial save skips the "required" part: an unticked (false or missing)
      // box and a blank signature. A non-boolean tick and a wrong signature still count.
      for (const k of ['accept_terms', 'authorise_verification', 'confirm_accurate']) {
        const v = values[k];
        if (v !== true && !(partial && (v === undefined || v === null || v === false))) e[k] = MESSAGES.tick;
      }
      const sig = values['signature_name'];
      if (isBlank(sig)) {
        if (!partial) e['signature_name'] = MESSAGES.signature_name;
      } else {
        const signed = str(sig);
        const folded = foldName(signed);
        const first = foldName(ctx.personal?.first_name);
        const last = foldName(ctx.personal?.last_name);
        // Without both saved names there is nothing to sign against (as the API).
        if (len(signed) < 3 || len(signed) > 200 || !first || !last || !folded.includes(first) || !folded.includes(last)) {
          e['signature_name'] = MESSAGES.signature_name;
        }
      }
      break;
    }
  }
  return e;
}
