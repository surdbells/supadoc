import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { API_CONFIG } from '@supadoc/data-access';
import type { ApproveApplicationResultDto, DoctorApplicationDetailDto, ReferenceItemDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { applicationDetail, applicationDocument, approval, prefill } from '../testing';
import { ApproveDialog, feeValue, minusMonthsYmd } from './approve-dialog';

const BASE = 'http://api.test';
const APPROVE = `${BASE}/api/doctor-applications/app-1/approve`;

function ref(label: string): ReferenceItemDto {
  return { id: label, category: 'specialty', code: label.toLowerCase(), label, sort_order: 10, active: true, usage_count: 0, created_at: null, updated_at: null };
}

function ready(over: Partial<DoctorApplicationDetailDto> = {}): DoctorApplicationDetailDto {
  return applicationDetail({
    status: 'under_review',
    actions: ['approve', 'schedule_interview', 'request_info', 'reject'],
    documents: [applicationDocument(), applicationDocument({ id: 'doc-2', slot: 'government_id', slot_label: 'Government-issued ID', original_name: 'id.png', mime: 'image/png' })],
    approval: approval({
      documents: [
        prefill(),
        prefill({
          document_id: 'doc-2',
          slot: 'government_id',
          slot_label: 'Government-issued ID',
          original_name: 'id.png',
          credential_type: 'government_id',
          needs_number: false,
          needs_expiry: false,
          prefill: { number: null, issued_on: null, expires_on: null, register_reference: 'Checked with application GVM-DR-2026-48213' },
          reference_hint: 'ID matched to applicant',
        }),
      ],
    }),
    ...over,
  });
}

@Component({
  imports: [ApproveDialog],
  template: `<bo-approve-dialog [open]="open()" [detail]="d()" (approved)="results.push($event)" (closed)="open.set(false)" />`,
})
class Host {
  readonly open = signal(false);
  readonly d = signal<DoctorApplicationDetailDto>(ready());
  readonly results: ApproveApplicationResultDto[] = [];
}

describe('ApproveDialog', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let http: HttpTestingController;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const ok = <T>(data: T) => ({ status: 'success', message: 'OK', data });
  const one = <T extends HTMLElement>(selector: string): T => {
    const found = el.querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector}`);
    return found;
  };
  const type = async (selector: string, value: string) => {
    const input = one<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const tick = async (selector: string) => {
    one<HTMLInputElement>(selector).click();
    await render();
  };
  const submit = async () => {
    one<HTMLFormElement>('#bo-approve-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };
  const button = (text: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);

  async function openWith(d: DoctorApplicationDetailDto) {
    host.d.set(d);
    host.open.set(true);
    await render();
    http.expectOne(`${BASE}/api/reference/specialty`).flush(ok([ref('Cardiology'), ref('Dermatology')]));
    await render();
  }

  async function fillValid() {
    await type('#bo-ap-fee', '15000');
    await type('#bo-ap-doc-doc-1-register_reference', 'MDCN online register, 23 Oct 2026');
    await tick('#bo-ap-doc-doc-1-checked');
    await tick('#bo-ap-doc-doc-2-checked');
    await tick('#bo-ap-attest');
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSupadocIcons(),
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    document.body.appendChild(el);
    http = TestBed.inject(HttpTestingController);
    await render();
  });

  afterEach(() => {
    http.verify();
    el.remove();
  });

  it('works out the fee and the 6-month floor for a Certificate of Good Standing', () => {
    expect(feeValue('15000')).toBe('15000.00');
    expect(feeValue('15,000.5')).toBe('15000.50');
    expect(feeValue('0')).toBeNull();
    expect(feeValue('12.345')).toBeNull();
    expect(feeValue('10000001')).toBeNull();
    expect(minusMonthsYmd('2026-08-31', 6)).toBe('2026-02-28');
    expect(minusMonthsYmd('2028-08-31', 6)).toBe('2028-02-29');
    expect(minusMonthsYmd('2026-03-15', 6)).toBe('2025-09-15');
  });

  it('says what approval does and prefills each document', async () => {
    await openWith(ready());
    expect(el.textContent).toContain('A doctor login is created for ada@example.test.');
    expect(el.textContent).toContain("They can't be booked until they finish setup and go live.");
    expect(el.textContent).toContain('2 documents are added to their record as verified.');
    expect(el.textContent).toContain('link valid 7 days');
    expect(one<HTMLInputElement>('#bo-ap-doc-doc-1-number').value).toBe('MDCN/R/12345');
    expect(one<HTMLInputElement>('#bo-ap-doc-doc-1-expires_on').value).toBe('2099-03-31');
    expect(one<HTMLInputElement>('#bo-ap-doc-doc-2-register_reference').value).toBe('Checked with application GVM-DR-2026-48213');
    expect(el.querySelector('#bo-ap-doc-doc-2-number')).toBeNull();
    expect(el.textContent).toContain('ID matched to applicant');
    expect(el.textContent).toContain("I confirm I checked these documents and this applicant's identity against the MDCN register.");
    expect(one('sd-search-select button').textContent).toContain('Cardiology');
  });

  it('asks for every attestation before sending anything', async () => {
    await openWith(ready());
    await submit();
    http.expectNone(APPROVE);
    expect(el.textContent).toContain('Please complete the highlighted fields.');
    expect(el.textContent).toContain('Enter the consultation fee.');
    expect(el.textContent).toContain('Say what you checked, e.g. the register entry.');
    expect(el.querySelectorAll('[id$="-checked-err"]')).toHaveLength(2);
    expect(one('#bo-ap-doc-doc-1-checked').getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain("Confirm that you checked this applicant's documents and identity against the MDCN register.");
  });

  it('sends the attestation per document, and shows the invite outcome', async () => {
    await openWith(ready());
    await fillValid();
    await submit();
    const req = http.expectOne(APPROVE);
    expect(req.request.body).toEqual({
      expected_status: 'under_review',
      attest: true,
      consultation_fee: '15000.00',
      specialty: 'Cardiology',
      documents: {
        'doc-1': { checked: true, register_reference: 'MDCN online register, 23 Oct 2026', number: 'MDCN/R/12345', issued_on: null, expires_on: '2099-03-31' },
        'doc-2': { checked: true, register_reference: 'Checked with application GVM-DR-2026-48213', number: null, issued_on: null, expires_on: null },
      },
    });
    req.flush(
      ok({
        application: ready({ status: 'approved', approval: null, actions: [] }),
        specialist_id: 'sp-9',
        invite: { email_sent: false, expires_at: '2026-10-30T10:00:00Z', dev_link: 'http://localhost:4204/auth/set-password?token=t' },
      }),
    );
    await render();
    expect(host.results).toHaveLength(1);
    expect(el.textContent).toContain("Approved. Ada Obi's doctor profile was created.");
    expect(el.textContent).toContain('Email not sent — use Resend invite');
    expect(el.textContent).toContain('Testing only — set-password link');
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.trim() === 'Open doctor page');
    expect(link?.getAttribute('href')).toBe('/specialists/sp-9');
    button('Done')?.click();
    await render();
    expect(host.open()).toBe(false);
  });

  it('puts the server’s per-document errors under their fields', async () => {
    await openWith(ready());
    await fillValid();
    await submit();
    http.expectOne(APPROVE).flush(
      { status: 'error', message: 'Validation failed', errors: { 'documents.doc-1.expires_on': 'This date has passed.', email: 'This email belongs to a deleted login.' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await render();
    expect(one('#bo-ap-doc-doc-1-expires_on-err').textContent).toContain('This date has passed.');
    expect(one('#bo-ap-doc-doc-1-expires_on').getAttribute('aria-invalid')).toBe('true');
    expect(el.textContent).toContain('This email belongs to a deleted login.');
  });

  it('refuses a login that would be taken over, without a button to press', async () => {
    await openWith(
      ready({
        approval: approval({
          ready: false,
          login: { state: 'blocked', problem: 'A doctor profile with this email already exists (Dr. Ada Obi). Open it instead.' },
          problems: { email: 'A doctor profile with this email already exists (Dr. Ada Obi). Open it instead.' },
        }),
      }),
    );
    expect(el.textContent).toContain("This application can't be approved yet.");
    expect(el.textContent).toContain('A doctor profile with this email already exists (Dr. Ada Obi). Open it instead.');
    expect(el.textContent).not.toContain('Before you can approve:');
    expect(button('Approve and create doctor')?.disabled).toBe(true);
    await submit();
    http.expectNone(APPROVE);
  });

  it('asks for another specialty when the application’s has left the list, then approves with the one chosen', async () => {
    // What the API really sends: the off-list specialty makes `ready` false, with a `specialty` problem.
    const d = ready({ specialty: 'Homeopathy' });
    await openWith({
      ...d,
      approval: d.approval
        ? { ...d.approval, ready: false, specialty_on_list: false, problems: { specialty: 'Homeopathy is no longer on the specialty list. Choose one.' } }
        : null,
    });
    expect(el.textContent).toContain('Homeopathy is no longer on the specialty list. Choose one.');
    // The reviewer fixes it here: not a blocker, so no "Before you can approve" and the button works.
    expect(el.textContent).not.toContain('Before you can approve:');
    expect(button('Approve and create doctor')?.disabled).toBe(false);

    // Keeping Homeopathy is refused before anything is sent.
    await fillValid();
    await submit();
    http.expectNone(APPROVE);
    expect(el.querySelector('#bo-ap-spec-err')?.textContent).toContain('Homeopathy is no longer on the specialty list.');

    // Choosing one on the list sends the approval with it.
    one<HTMLButtonElement>('sd-search-select button').click();
    await render();
    const cardiology = button('Cardiology');
    expect(cardiology).toBeTruthy();
    cardiology?.click();
    await render();
    expect(el.querySelector('#bo-ap-spec-err')).toBeNull();
    expect(el.textContent).not.toContain('Homeopathy is no longer on the specialty list.');
    await submit();
    const req = http.expectOne(APPROVE);
    expect(req.request.body.specialty).toBe('Cardiology');
    req.flush(
      ok({
        application: ready({ status: 'approved', approval: null, actions: [] }),
        specialist_id: 'sp-9',
        invite: { email_sent: true, expires_at: '2026-10-30T10:00:00Z', dev_link: null },
      }),
    );
    await render();
    expect(host.results).toHaveLength(1);
  });

  it('still blocks approval on a problem the reviewer can’t fix here (a missing document)', async () => {
    await openWith(
      ready({
        approval: approval({
          ready: false,
          problems: { documents: 'The application has no Government-issued ID. Request it from the applicant first.' },
        }),
      }),
    );
    expect(el.textContent).toContain('Before you can approve:');
    expect(el.textContent).toContain('The application has no Government-issued ID. Request it from the applicant first.');
    expect(button('Approve and create doctor')?.disabled).toBe(true);
    await submit();
    http.expectNone(APPROVE);
  });

  it('names each document card, so its fields are announced with the document they belong to', async () => {
    await openWith(ready());
    const groups = Array.from(el.querySelectorAll<HTMLElement>('#bo-approve-form [role="group"]'));
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      const title = document.getElementById(g.getAttribute('aria-labelledby') ?? '');
      expect(title?.textContent?.trim()).toBeTruthy();
      expect(g.closest('li')).toBeTruthy();
    }
    expect(document.getElementById(groups[1].getAttribute('aria-labelledby') ?? '')?.textContent?.trim()).toBe('Government-issued ID');
    expect(groups[1].querySelector('#bo-ap-doc-doc-2-register_reference')).toBeTruthy();
  });

  it('checks the Certificate of Good Standing date for an abroad applicant', async () => {
    const gcs = prefill({
      document_id: 'doc-1',
      slot: 'good_standing_certificate',
      slot_label: 'Certificate of Good Standing',
      credential_type: 'good_standing_certificate',
      needs_issue_date: true,
      needs_expiry: false,
      prefill: { number: 'GMC-7001', issued_on: '2001-01-01', expires_on: null, register_reference: '' },
    });
    await openWith(ready({ licence_route: 'abroad', approval: approval({ documents: [gcs], register_name: 'the General Medical Council register' }) }));
    expect(el.textContent).toContain('against the General Medical Council register.');
    await type('#bo-ap-fee', '20000');
    await type('#bo-ap-doc-doc-1-register_reference', 'GMC online register');
    await tick('#bo-ap-doc-doc-1-checked');
    await tick('#bo-ap-attest');
    await submit();
    http.expectNone(APPROVE);
    expect(one('#bo-ap-doc-doc-1-issued_on-err').textContent).toContain('more than 6 months old');
  });
});
