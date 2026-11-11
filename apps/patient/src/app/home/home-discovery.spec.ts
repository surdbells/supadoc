import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SpecialistsApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { HomeDiscovery } from './home-discovery';

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
 * The consultation-type toggle (tailwind/pills.css): L pills in a white pill track,
 * the look driven by aria-pressed (it exposed no state before).
 */
describe('HomeDiscovery consultation-type pills', () => {
  let fixture: ComponentFixture<HomeDiscovery>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HomeDiscovery],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: SpecialistsApi, useValue: specialistsApi() },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HomeDiscovery);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
  });

  const group = () =>
    el.querySelector(
      '[role="group"][aria-label="Consultation type"]',
    ) as HTMLElement;
  const pills = () => [
    ...group().querySelectorAll<HTMLButtonElement>('button'),
  ];
  const pressed = () => pills().map((b) => b.getAttribute('aria-pressed'));

  it('is a pill track of L pills; exactly one is pressed', () => {
    expect(group().classList).toContain('sd-track');
    expect(pills().map((b) => b.textContent?.trim())).toEqual([
      'Any',
      'Online',
      'In-person',
    ]);
    for (const b of pills())
      expect([...b.classList]).toEqual(
        expect.arrayContaining(['sd-pill', 'sd-pill-l', 'sd-seg']),
      );
    expect(pressed().filter((p) => p === 'true')).toHaveLength(1);
  });

  it('moves aria-pressed to the clicked pill', async () => {
    pills()[1].click();
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'true', 'false']);
    pills()[2].click();
    fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'false', 'true']);
  });
});
