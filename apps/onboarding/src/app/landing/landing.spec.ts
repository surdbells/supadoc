import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { DEFAULT_CONFIG } from '../core/onboarding-config.store';
import { HttpTestingController, ok, P, settle, stubDialogs, testProviders, textOf } from '../../testing/onb-testing';
import { NOTICE, Notices } from '../core/notices';
import { CHECKLIST } from './landing-checklist';
import { OnbLanding } from './landing';

describe('OnbLanding', () => {
  let http: HttpTestingController;

  beforeAll(() => stubDialogs());

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: testProviders([
        { path: '', component: OnbLanding },
        { path: 'apply', children: [] },
      ]),
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(url = '/') {
    const harness = await RouterTestingHarness.create(url);
    http
      .expectOne(`${P}/config`)
      .flush(ok({ ...DEFAULT_CONFIG, doctor_portal_url: 'https://doctor.example.test', legal_terms_url: null }));
    await settle(harness.fixture);
    return harness;
  }

  it('shows the hero, the corrected copy and the CTAs', async () => {
    const h = await open();
    const el = h.routeNativeElement as HTMLElement;
    const text = textOf(el);
    expect(text).toContain('Trusted by thousands of patients');
    expect(text).toContain('Ready to make a difference?');
    expect(text).toContain('Join thousands of specialists who trust VideoMed to deliver quality care.');
    expect(text).toContain('Consult, earn, and impact more lives — on your own schedule.');
    expect(text).toContain('Secure • Private • Patient First');
    expect(text).toContain(`© ${new Date().getFullYear()} VideoMed. All rights reserved`);
    const apply = Array.from(el.querySelectorAll('a')).filter((a) => a.textContent?.includes('Apply Now'));
    expect(apply.length).toBe(2);
    expect(apply[0].getAttribute('href')).toBe('/apply');
  });

  it('links Log In to the doctor portal sign-in from config', async () => {
    const h = await open();
    const login = Array.from((h.routeNativeElement as HTMLElement).querySelectorAll('a')).find(
      (a) => a.textContent?.trim() === 'Log In',
    );
    expect(login?.getAttribute('href')).toBe('https://doctor.example.test/auth/login');
  });

  it('lists the five checklist items with readable descriptions', async () => {
    const h = await open();
    const el = h.routeNativeElement as HTMLElement;
    expect(CHECKLIST).toHaveLength(5);
    for (const item of CHECKLIST) expect(textOf(el)).toContain(item.title);
    expect(textOf(el)).toContain('Professional Indemnity');
    expect(el.querySelector('.text-ink\\/80')).toBeTruthy();
  });

  it('hides the legal links while their URLs are unset', async () => {
    const h = await open();
    const text = textOf(h.routeNativeElement as HTMLElement);
    expect(text).not.toContain('Privacy Policy');
    expect(text).not.toContain('Terms of Service');
  });

  it('opens the Track modal from ?dialog=track and the Resume modal from ?dialog=resume', async () => {
    const h = await open('/?dialog=track');
    expect(textOf(document.body)).toContain('Check your application status');
    await h.navigateByUrl('/?dialog=resume');
    await settle(h.fixture);
    expect(textOf(document.body)).toContain('Resume your application');
  });

  it('shows the cancellation notice once', async () => {
    TestBed.inject(Notices).set('landing', NOTICE.cancelled);
    const h = await open();
    expect(textOf(h.routeNativeElement as HTMLElement)).toContain(NOTICE.cancelled);
    expect(TestBed.inject(Notices).peek('landing')).toBeNull();
  });
});
