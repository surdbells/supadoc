/// <reference types="node" />
// Node types for this spec only: its first part reads the sharing components' sources from disk.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Location } from '@angular/common';
import { Component, signal, type Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { API_CONFIG, DocumentsApi, DocumentSharingApi, PatientApi } from '@supadoc/data-access';
import type { DocumentAccessRequestDto, DocumentGrantDto, SharingDoctorDto } from '@supadoc/models';
import { type ConfirmResult, DialogService, provideSupadocIcons } from '@supadoc/ui';
import { ApproveRequestDialog } from './approve-request-dialog';
import { CALL_IN_PLACE } from './call-in-place';
import { CallRecordZone } from './call-record-zone';
import { ManageSharing } from './manage-sharing';
import { ShareDialog } from './share-dialog';
import { SharingDoctorsPanel } from './sharing-doctors-panel';

/*
 * During the call nothing in the patient's own record and sharing (the record's
 * two tabs, and the cockpit's request and share dialogs) may leave the page: a
 * link would bring up "Leave the consultation?", a new tab would leave the
 * call behind. These specs walk that tree twice: its sources and component
 * graph (every way out is known and guarded), and the rendered page in every
 * state the clicks reach (no link, no navigation, no window).
 */

// ----- 1. The tree, statically -----

const DASHBOARD = 'apps/patient/src/app/dashboard';
/** What the call shows of the portal's sharing: the record's zone, and the cockpit's two sharing dialogs. */
const ROOTS = ['call-record-zone.ts', 'share-dialog.ts', 'approve-request-dialog.ts'];
/** Every way a component can leave the page. */
const WAY_OUT = /routerLink|\[href\]|\bhref=|\.navigate(ByUrl)?\(|window\.open|\.open\(\s*['"`]|target="_blank"|location\.(href|assign|replace)/g;
/**
 * The ways out the tree has, all audited: each is shown or run only outside the
 * call (the `embedded` input from the zone, or the CALL_IN_PLACE host) and the
 * rendered walk below proves it. A new one fails here until it is guarded too.
 */
const KNOWN: Record<string, number> = {
  // The back link and the two section links (@if !embedded; buttons instead in the call).
  'manage-sharing.ts': 3,
  // "Find a specialist" under "No doctors yet" (@if !embedded).
  'sharing-doctors-panel.ts': 1,
  // "Find a specialist" when no doctor is booked (@if !inCall).
  'share-dialog.ts': 1,
  // A closed request's "Manage sharing" (@else of @if inCall: a button that shows the call's tab).
  'approve-request-dialog.ts': 1,
  // The ?section= deep link's clean-up, in ngOnInit after `if (this.embedded()) return`.
  'my-profile.ts': 1,
};

function dashboardDir(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, DASHBOARD);
    if (existsSync(join(candidate, 'call-record-zone.ts'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`${DASHBOARD} not found above ${process.cwd()}`);
  }
}

/** The dashboard files the roots import, directly or not (relative imports in this folder). */
function closure(dir: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/from '\.\/([\w-]+)'/g)) visit(`${m[1]}.ts`);
    for (const m of src.matchAll(/import\('\.\/([\w-]+)'\)/g)) visit(`${m[1]}.ts`);
  };
  ROOTS.forEach(visit);
  return [...seen].sort();
}

/** Every component a root renders, through the compiled component graph. */
function componentTree(roots: readonly Type<unknown>[]): Set<Type<unknown>> {
  const seen = new Set<Type<unknown>>();
  const visit = (t: Type<unknown>) => {
    const def = (t as unknown as { ɵcmp?: { dependencies?: unknown } }).ɵcmp;
    if (!def || seen.has(t)) return;
    seen.add(t);
    const deps = typeof def.dependencies === 'function' ? (def.dependencies as () => unknown[])() : def.dependencies;
    for (const d of (deps as Type<unknown>[] | undefined) ?? []) visit(d);
  };
  roots.forEach(visit);
  return seen;
}

describe('in the call, the record and sharing never leave the page (the tree)', () => {
  it('every way out in the sources the call reaches is a known, guarded one', () => {
    const dir = dashboardDir();
    const files = closure(dir);
    // The walk reaches the record and sharing pieces and the dialogs they open.
    for (const f of ['my-profile.ts', 'manage-sharing.ts', 'sharing-doctors-panel.ts', 'access-requests-banner.ts', 'access-history.ts', 'extend-share-dialog.ts', 'call-in-place.ts']) {
      expect(files).toContain(f);
    }
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = [...readFileSync(join(dir, f), 'utf8').matchAll(WAY_OUT)].length;
      if (n > 0) found[f] = n;
    }
    expect(found).toEqual(KNOWN);
  });

  it('would catch one (self-test)', () => {
    const hits = (s: string) => [...s.matchAll(WAY_OUT)].length;
    expect(hits('<a routerLink="/x">')).toBe(1);
    expect(hits('<a [href]="u" target="_blank">')).toBe(2);
    expect(hits('<a href="/x">')).toBe(1);
    expect(hits('void this.router.navigate([])')).toBe(1);
    expect(hits('this.router.navigateByUrl(u)')).toBe(1);
    expect(hits("window.open(u, '_blank')")).toBe(1);
    expect(hits('this.doc.location.assign(u)')).toBe(1);
    expect(hits('<button (click)="openWorkspace(\'sharing\')">')).toBe(0);
  });

  it('the components with a router link are exactly the audited ones', () => {
    const tree = componentTree([CallRecordZone, ShareDialog, ApproveRequestDialog]);
    const withLinks = [...tree].filter((t) => {
      const def = (t as unknown as { ɵcmp: { dependencies?: unknown } }).ɵcmp;
      const deps = typeof def.dependencies === 'function' ? (def.dependencies as () => unknown[])() : def.dependencies;
      return ((deps as unknown[] | undefined) ?? []).includes(RouterLink);
    });
    expect(withLinks.map((t) => t.name).sort()).toEqual(
      [ApproveRequestDialog, ManageSharing, ShareDialog, SharingDoctorsPanel].map((t) => t.name).sort(),
    );
  });
});

// ----- 2. The rendered page, in every state the clicks reach -----

const ok = <T,>(data: T) => of({ status: 'success', message: 'OK', data });
const page = <T,>(data: T[]) => of({ status: 'success', message: 'OK', data, meta: { page: 1, per_page: 20, total: data.length, total_pages: 1 } });
/** Every change the patient could make fails (a server error): its error state is one more state to walk. */
const refuse = (): Observable<never> => throwError(() => ({ statusCode: 500, message: 'Something went wrong.' }));

/** An API service: the given reads, every other method refused. */
function apiStub(reads: Record<string, unknown>): unknown {
  return new Proxy(reads, { get: (target, prop: string) => (prop in target ? target[prop] : refuse) });
}

const closedMeanwhile = (): Observable<never> =>
  throwError(() => ({ statusCode: 409, message: 'This request has closed.', errors: { code: 'request_not_pending', status: 'expired' } }));

const doctorRef = { id: 'sp-1', name: 'Bayo Ade', specialty: 'Cardiology', photo_url: null };
const appointmentRef = {
  id: 'ap-1',
  scheduled_at: '2030-10-28T15:00:00Z',
  ends_at: '2030-10-28T15:30:00Z',
  after_options: { after_24h: '2030-10-29T15:30:00Z', after_7d: '2030-11-04T15:30:00Z', after_30d: '2030-11-27T15:30:00Z' },
};

function request(id: string, status: DocumentAccessRequestDto['status']): DocumentAccessRequestDto {
  return {
    id,
    specialist: doctorRef,
    appointment: appointmentRef,
    kind: 'access',
    status,
    message: 'Please share your recent results.',
    created_at: '2030-10-20T10:00:00Z',
    expires_at: '2030-10-27T10:00:00Z',
    decided_at: null,
    grant_id: null,
    suggestion: { scope: 'selected', document_ids: ['d-1'], duration: 'after_7d', appointment_id: 'ap-1' },
  } as DocumentAccessRequestDto;
}

const grant = {
  id: 'g-1',
  specialist: doctorRef,
  scope: 'all',
  status: 'active',
  source: 'share',
  surface: 'manage_sharing',
  duration: 'until',
  starts_at: '2030-10-20T10:00:00Z',
  expires_at: '2030-12-27T10:00:00Z',
  until_label_at: '2030-12-27T10:00:00Z',
  ended_at: null,
  end_reason: null,
  ended_by: null,
  document_ids: [],
  document_count: 0,
  appointment: null,
  request_id: null,
  revoke_batch_id: null,
  restorable_until: null,
  last_accessed_at: null,
  access_count: 0,
  created_at: '2030-10-20T10:00:00Z',
} as unknown as DocumentGrantDto;

function doctor(id: string, name: string, state: 'all' | 'none'): SharingDoctorDto {
  return {
    specialist: { ...doctorRef, id, name },
    can_share: true,
    unavailable_reason: null,
    last_appointment_at: '2030-10-01T10:00:00Z',
    next_appointment: null,
    access: {
      state,
      scope: state === 'none' ? null : 'all',
      document_count: state === 'none' ? 0 : 2,
      until: state === 'none' ? null : '2030-12-27T10:00:00Z',
      until_label_at: state === 'none' ? null : '2030-12-27T10:00:00Z',
      indefinite: false,
      folder_until_label_at: null,
      folder_indefinite: false,
      next_change_at: null,
      last_viewed_at: null,
      active_grant_ids: state === 'none' ? [] : ['g-1'],
      hidden_count: 0,
      hidden_document_ids: [],
    },
    pending_request: null,
    requests_blocked: id === 'sp-2',
  } as unknown as SharingDoctorDto;
}

const libraryDoc = (id: string, title: string) => ({ id, title, file_name: `${title}.pdf`, extension: 'pdf', mime_type: 'application/pdf', size: 1000, created_at: '2030-10-01T10:00:00Z' });

/** What the call shows of sharing: the record's two tabs, and the cockpit's share and request dialogs. */
@Component({
  imports: [ApproveRequestDialog, CallRecordZone, ShareDialog],
  template: `
    @for (k of kinds(); track k) {
      <pat-call-record-zone [kind]="k" />
    }
    @if (share()) {
      <pat-share-dialog [preselectDoctorIds]="lock() ? ['sp-1'] : []" [lockDoctor]="lock()" surface="call" theme="call" (closed)="share.set(false)" />
    }
    @if (review(); as r) {
      <pat-approve-request-dialog [request]="r" theme="call" (closed)="review.set(null)" />
    }
  `,
})
class CallHost {
  readonly kinds = signal<readonly ('record' | 'sharing')[]>([]);
  readonly share = signal(false);
  /** The cockpit's share dialog is for the call's doctor; unlocked, it starts by asking who. */
  readonly lock = signal(true);
  readonly review = signal<DocumentAccessRequestDto | null>(null);
}

describe('in the call, the record and sharing never leave the page (every control, every state)', () => {
  let fixture: ComponentFixture<CallHost>;
  let host: CallHost;
  let el: HTMLElement;
  let doctors: SharingDoctorDto[] = [];
  const inPlace = { showSharing: vi.fn() };

  /** By hand: Manage sharing keeps a clock (its Undo window), so the page is never stable. */
  const render = async () => {
    fixture.detectChanges();
    // Every answer here is synchronous (of / throwError) or a resolved promise (the confirmations):
    // microtasks are enough, no timer turn.
    for (let i = 0; i < 3; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const links = () => Array.from(document.body.querySelectorAll('a, [href], [routerlink]')).map((a) => a.outerHTML.slice(0, 120));

  const CONTROLS = 'button, input, select, textarea, [role="tab"], [role="button"]';
  /** Switching Doctors / Activity hides the other section's controls: those two go last. */
  const SECTION = '[aria-label="Sharing sections"] button';
  /**
   * What closes a dialog goes after everything else in it, so the dialog is
   * walked first; Decline too, so a request is approved from its dialog and
   * declined from the banner's own Decline (each answer closes it).
   */
  const DISMISS = /^(Close|Cancel|Go back|Back|Keep sharing|Not now|Decline)$/;
  const order = (e: HTMLElement) =>
    e.matches(SECTION) ? 2 : DISMISS.test(e.textContent?.trim() || e.getAttribute('aria-label') || '') ? 1 : 0;

  /**
   * Clicks every control as a person would: in the dialog on top while one is
   * open (the page behind is inert), else on the page, always the first control
   * not pressed yet, so whatever a click brings (a dialog, its next step, an
   * error, the info view) is walked next. `within`: only the page's controls in
   * that part (its dialogs are all walked). After every click: no link anywhere,
   * the address unchanged. Returns the labels pressed.
   */
  const clickEverything = async (within = 'body'): Promise<string[]> => {
    const location = TestBed.inject(Location);
    const start = location.path();
    const clicked = new WeakSet<Element>();
    const pressed: string[] = [];
    const fresh = (scope: ParentNode) =>
      Array.from(scope.querySelectorAll<HTMLElement>(CONTROLS))
        .filter((e) => !clicked.has(e) && !(e as HTMLButtonElement).disabled)
        .sort((a, b) => order(a) - order(b));
    while (pressed.length < 400) {
      const dialogs = document.body.querySelectorAll('dialog[open]');
      const top = dialogs[dialogs.length - 1];
      const part = document.body.querySelector(within) ?? document.body;
      const next = (top ? fresh(top)[0] : undefined) ?? fresh(part).filter((e) => !e.closest('dialog'))[0];
      if (!next) return pressed;
      clicked.add(next);
      next.click();
      pressed.push((next.textContent?.trim() || next.getAttribute('aria-label') || next.tagName).replace(/\s+/g, ' ').slice(0, 40));
      await render();
      expect(links()).toEqual([]);
      expect(location.path()).toBe(start);
    }
    throw new Error('Still finding new controls after 400 clicks');
  };

  beforeEach(async () => {
    doctors = [doctor('sp-1', 'Bayo Ade', 'all'), doctor('sp-2', 'Ngozi Eze', 'none')];
    inPlace.showSharing.mockClear();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    await TestBed.configureTestingModule({
      imports: [CallHost],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        // As the call page provides it.
        { provide: CALL_IN_PLACE, useValue: inPlace },
        { provide: AuthService, useValue: {} },
        {
          provide: PatientApi,
          useValue: apiStub({
            me: () => ok({ id: 'p-1', first_name: 'Ada', last_name: 'Obi' }),
            assetUrl: () => '',
            healthProfile: () =>
              ok({
                emergency_contact: { full_name: '', relationship: '', phone: '', email: '' },
                insurance: { provider: '', plan: '', policy_number: '', coverage_status: '', expiry_date: '' },
                medical: {
                  history: [{ condition: 'Appendectomy', year: '2016', note: '' }],
                  allergies: [{ allergen: 'Penicillin', severity: 'life_threatening', reaction: 'Anaphylaxis' }],
                  medications: [{ name: 'Lisinopril', dosage: '10 mg', frequency: 'Daily' }],
                  conditions: [{ condition: 'Hypertension', status: 'Managed', since: '2020' }],
                },
              }),
            vitals: () => ok({ latest: [], fields: [], sources: {}, patient_sources: [], reminder: { due: false } }),
          }),
        },
        {
          provide: DocumentSharingApi,
          useValue: apiStub({
            doctors: () => ok(doctors),
            grants: (q?: { status?: string }) => ok(q?.status === 'ended' ? [{ ...grant, id: 'g-0', status: 'ended', ended_at: '2030-10-10T10:00:00Z', end_reason: 'expired' }] : [grant]),
            // One waiting request, and one that closed meanwhile (its dialog is the info view).
            requests: () => ok([request('rq-1', 'pending'), request('rq-2', 'expired')]),
            request: (id: string) => ok(request(id, 'pending')),
            // Answering finds the request closed meanwhile: the dialog turns into its info view.
            approveRequest: closedMeanwhile,
            declineRequest: closedMeanwhile,
            history: () => page([]),
          }),
        },
        { provide: DocumentsApi, useValue: apiStub({ list: () => page([libraryDoc('d-1', 'Blood test'), libraryDoc('d-2', 'X-ray')]) }) },
      ],
    }).compileComponents();
    // Confirmations: a stop (Stop sharing…) is answered "no", so the walk goes on with the page as it
    // was; "Discard this share?" is answered yes, so closing a share dialog closes it.
    vi.spyOn(TestBed.inject(DialogService), 'confirm').mockImplementation(async (o) => ({ confirmed: /^Discard/.test(o.title ?? '') }) as ConfirmResult);
    fixture = TestBed.createComponent(CallHost);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
  });

  afterEach(() => {
    fixture.destroy();
    el.remove();
    vi.restoreAllMocks();
  });

  const expectNothingLeft = () => {
    const router = TestBed.inject(Router);
    expect(router.navigated).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  };

  it('the record (Medical Information, read-only): every control stays on the page', async () => {
    host.kinds.set(['record']);
    await render();
    expect(el.querySelector('pat-my-profile')?.textContent).toContain('Penicillin');
    expect(links()).toEqual([]);
    await clickEverything();
    expectNothingLeft();
  });

  /** Document sharing in the call, walked one part at a time (each part with every dialog it opens). */
  const walkSharing = async (within: string): Promise<string[]> => {
    host.kinds.set(['sharing']);
    await render();
    expect(el.textContent).toContain('Bayo Ade');
    expect(links()).toEqual([]);
    const pressed = await clickEverything(within);
    expectNothingLeft();
    return pressed;
  };

  it('Document sharing, the requests: review, change, approve, decline, and a request closed meanwhile (its "Manage sharing" acts in place)', async () => {
    const pressed = await walkSharing('pat-access-requests-banner');
    for (const label of ['Review request', 'Change what or how long', 'Approve and share', 'Manage sharing', 'Decline', 'Decline request']) {
      expect(pressed).toContain(label);
    }
    // The closed request's "Manage sharing" (a button in the call) asked the call for its sharing tab.
    expect(inPlace.showSharing).toHaveBeenCalled();
  });

  it('Document sharing, the doctors: details, change, change the end date, stop, allow requests, shared before', async () => {
    const pressed = await walkSharing('pat-sharing-doctors-panel');
    for (const label of ['Change', 'Change end date', 'Stop sharing', 'Allow requests', 'Shared before', 'Save']) {
      expect(pressed).toContain(label);
    }
  });

  it('Document sharing, the header and sections: share (every step), stop sharing with everyone, Activity', async () => {
    const pressed = await walkSharing('pat-manage-sharing > div > header');
    expect(pressed).toContain('Share documents');
    expect(pressed).toContain('Continue');
    expect(pressed).toContain('Stop sharing with everyone');
    const sections = await clickEverything('[aria-label="Sharing sections"]');
    expect(sections.map((s) => s.replace(/\d+$/, '').trim())).toEqual(['Doctors', 'Activity']);
    expect(el.querySelector('pat-access-history')).not.toBeNull();
    await clickEverything('pat-access-history');
    expectNothingLeft();
  });

  it('with no doctor booked yet: the empty states say so with no "Find a specialist" link', async () => {
    doctors = [];
    host.kinds.set(['sharing']);
    host.lock.set(false);
    host.share.set(true);
    await render();
    expect(el.textContent).toContain('No doctors yet');
    expect(el.querySelector('pat-share-dialog')?.textContent).toContain('Book a consultation first.');
    expect(links()).toEqual([]);
    await clickEverything();
    expectNothingLeft();
  });

  it('the cockpit’s share dialog and request dialogs (waiting, and closed meanwhile): every control stays on the page', async () => {
    host.share.set(true);
    await render();
    await clickEverything();
    host.review.set(request('rq-1', 'pending'));
    await render();
    const answered = await clickEverything();
    expect(answered).toContain('Approve and share');
    expect(answered).toContain('Manage sharing');
    host.review.set(request('rq-2', 'declined'));
    await render();
    expect(el.querySelector('pat-approve-request-dialog')?.textContent).toContain('You declined this request.');
    await clickEverything();
    expectNothingLeft();
  });

  it('a closed request’s "Manage sharing" closes the dialog, then asks the call for its sharing tab', async () => {
    host.review.set(request('rq-2', 'cancelled'));
    await render();
    const manage = Array.from(el.querySelectorAll('pat-approve-request-dialog button')).find((b) => b.textContent?.trim() === 'Manage sharing') as HTMLButtonElement;
    expect(manage.tagName).toBe('BUTTON');
    manage.click();
    await render();
    expect(el.querySelector('pat-approve-request-dialog')).toBeNull();
    expect(inPlace.showSharing).toHaveBeenCalledTimes(1);
    expectNothingLeft();
  });
});

describe('outside the call, the standalone pages keep their links', () => {
  it('a closed request’s "Manage sharing" and the share dialog’s "Find a specialist" are links', async () => {
    @Component({
      imports: [ApproveRequestDialog, ShareDialog],
      template: `
        <pat-share-dialog surface="manage_sharing" />
        <pat-approve-request-dialog [request]="closed" />
      `,
    })
    class PortalHost {
      readonly closed = request('rq-2', 'expired');
    }
    await TestBed.configureTestingModule({
      imports: [PortalHost],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://api.test' } },
        { provide: DocumentSharingApi, useValue: apiStub({ doctors: () => ok([]), grants: () => ok([]) }) },
        { provide: DocumentsApi, useValue: apiStub({ list: () => page([]) }) },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(PortalHost);
    document.body.appendChild(fixture.nativeElement);
    for (let i = 0; i < 3; i++) {
      fixture.detectChanges();
      await new Promise((r) => setTimeout(r));
    }
    const hrefs = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a')).map((a) => [a.textContent?.trim(), a.getAttribute('href')]);
    expect(hrefs).toEqual([
      ['Find a specialist', '/dashboard/specialists'],
      ['Manage sharing', '/dashboard/documents/sharing'],
    ]);
    fixture.destroy();
    (fixture.nativeElement as HTMLElement).remove();
  });
});
