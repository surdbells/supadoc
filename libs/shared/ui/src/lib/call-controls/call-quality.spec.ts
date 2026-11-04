import { TestBed } from '@angular/core/testing';
import { callQualityInfo, CallQualityComponent } from './call-quality';

describe('callQualityInfo', () => {
  it('maps Agora quality 0–6 to bars and a word', () => {
    expect(callQualityInfo(1)).toEqual({ bars: 3, word: 'Good', tone: 'bg-success' });
    expect(callQualityInfo(2)).toEqual({ bars: 3, word: 'Good', tone: 'bg-success' });
    expect(callQualityInfo(3)).toEqual({ bars: 2, word: 'Fair', tone: 'bg-warning' });
    expect(callQualityInfo(4)).toEqual({ bars: 1, word: 'Poor', tone: 'bg-alert' });
    expect(callQualityInfo(5)).toEqual({ bars: 1, word: 'Poor', tone: 'bg-alert' });
    expect(callQualityInfo(6)).toEqual({ bars: 0, word: 'Offline', tone: 'bg-alert' });
    for (const q of [0, null, undefined, 7, -1, Number.NaN]) {
      expect(callQualityInfo(q)).toEqual({ bars: null, word: 'Checking…', tone: null });
    }
  });
});

describe('CallQualityComponent', () => {
  it('is one image named by the word, with that many bars lit', async () => {
    await TestBed.configureTestingModule({ imports: [CallQualityComponent] }).compileComponents();
    const fixture = TestBed.createComponent(CallQualityComponent);
    const root: HTMLElement = fixture.nativeElement;
    const lit = (tone: string) => root.querySelectorAll(`.${tone}`).length;

    fixture.detectChanges();
    const img = root.querySelector('[role="img"]') as HTMLElement;
    expect(img.getAttribute('aria-label')).toBe('Connection: Checking…');
    expect(root.querySelectorAll('.bg-white\\/25').length).toBe(3);

    fixture.componentRef.setInput('quality', 3);
    fixture.detectChanges();
    expect(img.getAttribute('aria-label')).toBe('Connection: Fair');
    expect(lit('bg-warning')).toBe(2);
    expect(root.textContent).toContain('Fair');
    // The word is visible from sm up only.
    expect(root.querySelector('.sm\\:inline')?.classList.contains('hidden')).toBe(true);

    fixture.componentRef.setInput('quality', 1);
    fixture.detectChanges();
    expect(lit('bg-success')).toBe(3);

    fixture.componentRef.setInput('quality', 6);
    fixture.detectChanges();
    expect(img.getAttribute('aria-label')).toBe('Connection: Offline');
    expect(lit('bg-alert')).toBe(0);
  });
});
