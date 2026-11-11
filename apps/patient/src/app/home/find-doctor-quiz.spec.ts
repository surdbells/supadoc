import type { WritableSignal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SpecialistsApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { FindDoctorQuiz } from './find-doctor-quiz';

/*
 * The quiz's option pills (tailwind/pills.css): F pills, solid when chosen; the
 * look follows aria-pressed, which the options did not expose before.
 */
describe('FindDoctorQuiz option pills', () => {
  let fixture: ComponentFixture<FindDoctorQuiz>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FindDoctorQuiz],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        {
          provide: SpecialistsApi,
          useValue: new Proxy(
            {},
            {
              get: () =>
                vi.fn(() =>
                  of({
                    data: [],
                    meta: { page: 1, total_pages: 1, per_page: 12, total: 0 },
                  }),
                ),
            },
          ),
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(FindDoctorQuiz);
    el = fixture.nativeElement;
    fixture.componentRef.setInput('open', true);
    (
      fixture.componentInstance as unknown as { phase: WritableSignal<string> }
    ).phase.set('quiz');
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const options = () => [
    ...el.querySelectorAll<HTMLButtonElement>('.grid button.sd-pill'),
  ];

  it('step 1: every body area is a full-width F pill, none pressed yet', () => {
    expect(options().length).toBeGreaterThan(1);
    for (const b of options()) {
      expect([...b.classList]).toEqual(
        expect.arrayContaining([
          'sd-pill',
          'sd-pill-f',
          'sd-filter-solid',
          'w-full',
        ]),
      );
      expect(b.className).not.toMatch(/\bbg-cerulean\b|\btext-white\b/);
      expect(b.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('pressing an option sets aria-pressed (multi-select), pressing it again clears it', async () => {
    const [first, second] = options();
    first.click();
    fixture.detectChanges();
    second.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect([
      options()[0].getAttribute('aria-pressed'),
      options()[1].getAttribute('aria-pressed'),
    ]).toEqual(['true', 'true']);
    options()[0].click();
    fixture.detectChanges();
    expect(options()[0].getAttribute('aria-pressed')).toBe('false');
  });
});
