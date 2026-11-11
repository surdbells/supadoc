import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { WalletApi } from '@supadoc/data-access';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { WalletTransactions } from './wallet-transactions';

/*
 * The filter bar's pills (tailwind/pills.css): their look follows aria-pressed,
 * which moves with the selection; no colour class decides it.
 */
describe('WalletTransactions filter pills', () => {
  let fixture: ComponentFixture<WalletTransactions>;
  let el: HTMLElement;
  let transactions: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    transactions = vi.fn(() =>
      of({ data: [], meta: { page: 1, total_pages: 1 } }),
    );
    await TestBed.configureTestingModule({
      imports: [WalletTransactions],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: WalletApi, useValue: { transactions } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WalletTransactions);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const pills = () => [
    ...el.querySelectorAll<HTMLButtonElement>(
      '[role="group"][aria-label="Filter transactions"] button',
    ),
  ];
  const pressed = () => pills().map((b) => b.getAttribute('aria-pressed'));

  it('renders the filters as L pills in a pill track, the first one pressed', () => {
    expect(pills().map((b) => b.textContent?.trim())).toEqual([
      'All',
      'Top up',
      'Paid out',
      'Refund',
    ]);
    for (const b of pills()) {
      expect([...b.classList]).toEqual(
        expect.arrayContaining(['sd-pill', 'sd-pill-l', 'sd-seg']),
      );
      expect(b.className).not.toMatch(/\b(bg|text)-cerulean/);
    }
    expect(el.querySelector('.sd-track.sd-track-l')).not.toBeNull();
    expect(pressed()).toEqual(['true', 'false', 'false', 'false']);
  });

  it('scrolls the newly selected pill into view in its track ("Clear all" → "All")', async () => {
    const scroll = vi.fn();
    const proto = HTMLElement.prototype as unknown as {
      scrollIntoView?: unknown;
    };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    try {
      pills()[3].click();
      fixture.detectChanges();
      await fixture.whenStable();
      const clear = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Clear all',
      ) as HTMLButtonElement;
      clear.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(scroll.mock.contexts[1]).toBe(pills()[0]);
      expect(scroll.mock.calls[1][0]).toEqual(
        expect.objectContaining({ block: 'nearest', inline: 'nearest' }),
      );
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it('moves aria-pressed to the clicked pill and filters by its type', async () => {
    pills()[1].click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(pressed()).toEqual(['false', 'true', 'false', 'false']);
    expect(transactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'topup', page: 1 }),
    );
  });
});
