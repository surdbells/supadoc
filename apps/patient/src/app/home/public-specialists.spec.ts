import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SpecialistsApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { PublicSpecialists } from './public-specialists';

/** Every SpecialistsApi call answers something empty (the toggle is all this spec looks at). */
function specialistsApi(): SpecialistsApi {
  return new Proxy({} as SpecialistsApi, {
    get: (_t, name: string) =>
      vi.fn(() =>
        of(
          name === 'publicFacets'
            ? { data: { specialties: [], locations: [], languages: [] } }
            : {
                data: [],
                meta: { page: 1, total_pages: 1, per_page: 12, total: 0 },
              },
        ),
      ),
  });
}

/*
 * The sidebar's consultation-type toggle (tailwind/pills.css): S pills in a tight
 * pill track, the look driven by aria-pressed (it exposed no state before).
 */
describe('PublicSpecialists consultation-type pills', () => {
  let fixture: ComponentFixture<PublicSpecialists>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PublicSpecialists],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: SpecialistsApi, useValue: specialistsApi() },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PublicSpecialists);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const group = () =>
    el.querySelector(
      '[role="group"][aria-label="Consultation type"]',
    ) as HTMLElement;
  const pills = () => [
    ...group().querySelectorAll<HTMLButtonElement>('button'),
  ];
  const pressed = () => pills().map((b) => b.getAttribute('aria-pressed'));

  it('is a tight pill track of S pills, "Any" pressed', () => {
    expect([...group().classList]).toEqual(
      expect.arrayContaining(['sd-track', 'sd-track-tight']),
    );
    for (const b of pills())
      expect([...b.classList]).toEqual(
        expect.arrayContaining(['sd-pill', 'sd-pill-s', 'sd-seg']),
      );
    expect(pressed()).toEqual(['true', 'false', 'false']);
  });

  it('moves aria-pressed to the clicked pill', async () => {
    pills()[2].click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(pressed()).toEqual(['false', 'false', 'true']);
  });
});
