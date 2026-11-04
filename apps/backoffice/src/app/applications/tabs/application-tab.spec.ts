import { TestBed } from '@angular/core/testing';
import type { ApplicationInterviewDto, DoctorApplicationDetailDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { applicationDetail } from '../testing';
import { applicantInterviewTime, applicantZoneLabel, ApplicationTab } from './application-tab';

/** 15 Jan / 15 Jul 2026: Chicago on standard and on daylight time. */
const JAN = new Date('2026-01-15T12:00:00Z');
const JUL = new Date('2026-07-15T12:00:00Z');
/** Wednesday 14 October 2026, 10:00 WAT (4:00 AM CDT, 10:00 BST in London). */
const OCT = '2026-10-14T10:00:00+01:00';

function interview(over: Partial<ApplicationInterviewDto> = {}): ApplicationInterviewDto {
  return {
    starts_at: OCT,
    starts_at_label: 'Wednesday 14 October, 10:00 WAT',
    duration_minutes: 30,
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    meeting_host: 'meet.google.com',
    note: null,
    applicant_time_zone: null,
    applicant_label: null,
    ...over,
  };
}

/** The test application with its personal step's `time_zone` (left out when undefined). */
function withZone(tz: string | null | undefined, over: Partial<DoctorApplicationDetailDto> = {}): DoctorApplicationDetailDto {
  const d = applicationDetail(over);
  return {
    ...d,
    sections: { ...d.sections, personal: { ...d.sections.personal, ...(tz === undefined ? {} : { time_zone: tz }) } },
  };
}

describe('applicantZoneLabel', () => {
  it('names the zone as the onboarding review does, with the abbreviation at that date', () => {
    expect(applicantZoneLabel('America/Chicago', JAN)).toBe('Central Time (CST) · America/Chicago');
    expect(applicantZoneLabel('America/Chicago', JUL)).toBe('Central Time (CDT) · America/Chicago');
    expect(applicantZoneLabel('Asia/Dubai', JAN)).toMatch(/ \(GMT\+4\) · Asia\/Dubai$/);
  });

  it('is null when none was given, or one this browser cannot read', () => {
    for (const tz of [undefined, null, '', 'Not/AZone', '+01:00']) expect(applicantZoneLabel(tz)).toBeNull();
  });
});

describe('applicantInterviewTime', () => {
  const CHICAGO_LABEL = 'Wed 14 Oct, 4:00 AM CDT (10:00 AM WAT, VideoMed time)';

  it("is the API's label when the applicant's clock differs from WAT", () => {
    expect(applicantInterviewTime(interview({ applicant_time_zone: 'America/Chicago', applicant_label: CHICAGO_LABEL }))).toBe(
      CHICAGO_LABEL,
    );
  });

  it('is null when no zone was given, or theirs reads the same as WAT then', () => {
    expect(applicantInterviewTime(interview())).toBeNull();
    expect(applicantInterviewTime(interview({ applicant_time_zone: 'Africa/Lagos', applicant_label: 'Wed 14 Oct, 10:00 AM WAT' }))).toBeNull();
    // London keeps WAT's offset in October (BST).
    expect(applicantInterviewTime(interview({ applicant_time_zone: 'Europe/London', applicant_label: 'Wed 14 Oct, 10:00 AM BST' }))).toBeNull();
    expect(applicantInterviewTime(interview({ applicant_time_zone: 'America/Chicago', applicant_label: '  ' }))).toBeNull();
  });

  it("keeps the API's label when this browser cannot compare the zone", () => {
    expect(applicantInterviewTime(interview({ applicant_time_zone: 'Not/AZone', applicant_label: CHICAGO_LABEL }))).toBe(CHICAGO_LABEL);
  });
});

describe('ApplicationTab', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideSupadocIcons()] }));

  function render(detail: DoctorApplicationDetailDto): HTMLElement {
    const fixture = TestBed.createComponent(ApplicationTab);
    fixture.componentRef.setInput('detail', detail);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  /** A personal-details row (dt + dd) by its label. */
  const personalRow = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLElement>('[aria-labelledby="bo-app-personal-title"] dl > div')).find(
      (r) => r.querySelector('dt')?.textContent?.trim() === label,
    ) as HTMLElement;
  const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it("lists the applicant's time zone after City, in the same row style", () => {
    const el = render(withZone('America/Chicago'));
    const zone = personalRow(el, 'Time zone');
    const city = personalRow(el, 'City');
    expect(text(zone.querySelector('dd'))).toMatch(/^Central Time \(C[DS]T\) · America\/Chicago$/);
    expect(zone.className).toBe(city.className);
    expect(zone.querySelector('dt')?.className).toBe(city.querySelector('dt')?.className);
    expect(zone.querySelector('dd')?.className).toBe(city.querySelector('dd')?.className);
    expect(zone.previousElementSibling).toBe(city);
  });

  it('says "Not set", muted, when the applicant gave no zone', () => {
    for (const tz of [undefined, null, '']) {
      const zone = personalRow(render(withZone(tz)), 'Time zone');
      const dd = zone.querySelector('dd') as HTMLElement;
      expect(text(dd)).toBe('Not set');
      expect(dd.classList).toContain('text-slate');
      expect(dd.classList).not.toContain('text-ink');
    }
  });

  it("shows the applicant's time under the WAT time when it differs", () => {
    const el = render(
      withZone('America/Chicago', {
        status: 'interview_scheduled',
        interview: interview({
          applicant_time_zone: 'America/Chicago',
          applicant_label: 'Wed 14 Oct, 4:00 AM CDT (10:00 AM WAT, VideoMed time)',
        }),
      }),
    );
    const when = Array.from(el.querySelectorAll('[aria-labelledby="bo-app-interview-title"] dl > div')).find(
      (r) => text(r.querySelector('dt')) === 'When (Lagos time)',
    );
    const lines = Array.from(when?.querySelectorAll('dd') ?? []).map((dd) => text(dd));
    expect(lines[0]).toBe('Wednesday 14 October, 10:00 WAT');
    expect(lines[1]).toBe("Applicant's time: Wed 14 Oct, 4:00 AM CDT (10:00 AM WAT, VideoMed time)");
    expect(when?.querySelectorAll('dd')[1].className).toBe('font-sans text-caption text-slate');
  });

  it("has no applicant's-time line without a zone, or when theirs reads as WAT", () => {
    for (const iv of [
      interview(),
      interview({ applicant_time_zone: 'Africa/Lagos', applicant_label: 'Wed 14 Oct, 10:00 AM WAT' }),
    ]) {
      const el = render(withZone(iv.applicant_time_zone, { status: 'interview_scheduled', interview: iv }));
      expect(text(el)).toContain('Wednesday 14 October, 10:00 WAT');
      expect(text(el)).not.toContain("Applicant's time");
    }
  });
});
