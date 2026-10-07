import { TestBed } from '@angular/core/testing';
import { DoctorApi } from '@supadoc/data-access';
import type { DrugDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { Subject } from 'rxjs';
import { RxDrugSearch } from './rx-drug-search';

/** Just over the component's 250 ms search debounce. */
const DEBOUNCE = () => new Promise((resolve) => setTimeout(resolve, 300));

function drug(rxcui: string, name: string): DrugDto {
  return { rxcui, name, generic_name: name, branded: false, dose_form: null, route: null } as DrugDto;
}

/** The component's protected handlers, for driving it like the template does. */
interface Driver {
  onInput(value: string): void;
  onKeydown(e: KeyboardEvent): void;
}

describe('RxDrugSearch', () => {
  let requests: { q: string; res: Subject<{ data: DrugDto[] }> }[];

  beforeEach(() => {
    requests = [];
    TestBed.configureTestingModule({
      imports: [RxDrugSearch],
      providers: [
        provideSupadocIcons(),
        {
          provide: DoctorApi,
          useValue: {
            searchDrugs: (q: string) => {
              const res = new Subject<{ data: DrugDto[] }>();
              requests.push({ q, res });
              return res;
            },
          },
        },
      ],
    });
  });

  function setup() {
    const fixture = TestBed.createComponent(RxDrugSearch);
    fixture.componentRef.setInput('inputId', 'drug');
    fixture.detectChanges();
    const picked: DrugDto[] = [];
    fixture.componentInstance.picked.subscribe((d) => picked.push(d));
    return { cmp: fixture.componentInstance as unknown as Driver, picked };
  }

  function enter(): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  }

  it('never picks the previous search’s result while a newer search is pending', async () => {
    const { cmp, picked } = setup();

    cmp.onInput('amox');
    await DEBOUNCE();
    requests[0].res.next({ data: [drug('1', 'amoxicillin 125 MG/5ML Oral Suspension')] });

    // The doctor keeps typing and presses Enter before the new results arrive.
    cmp.onInput('amoxicillin 500');
    const early = enter();
    cmp.onKeydown(early);
    expect(early.defaultPrevented).toBe(true);
    expect(picked).toEqual([]);

    await DEBOUNCE();
    expect(requests[1].q).toBe('amoxicillin 500');
    requests[1].res.next({ data: [drug('2', 'amoxicillin 500 MG Oral Capsule')] });
    cmp.onKeydown(enter());
    expect(picked.map((d) => d.rxcui)).toEqual(['2']);
  });

  it('ignores a late response for an older search', async () => {
    const { cmp, picked } = setup();

    cmp.onInput('amox');
    await DEBOUNCE();
    cmp.onInput('amoxicillin 500');
    // The older request answers after the text has moved on.
    requests[0].res.next({ data: [drug('1', 'amoxicillin 125 MG/5ML Oral Suspension')] });
    cmp.onKeydown(enter());
    expect(picked).toEqual([]);
  });
});
