import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { buttonByText, settle, testProviders, textOf, tick } from '../../testing/onb-testing';
import { ApplicationDraftStore } from '../core/application-draft.store';
import { TrackStore } from '../core/track.store';
import { OnbSubmitted } from './submitted';

describe('OnbSubmitted', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: testProviders([{ path: '**', children: [] }]) });
    TestBed.inject(ApplicationDraftStore).submission.set({
      id: 'app-1',
      reference: 'GVM-DR-2026-80782',
      status: 'submitted',
      submitted_at: '2026-10-23T10:00:00Z',
      email: 'clementolawunmi@gmail.com',
      phone: '+447700900123',
    });
  });

  async function create() {
    const fixture = TestBed.createComponent(OnbSubmitted);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle(fixture);
    return { fixture, el };
  }

  it('confirms with the reference, the contacts and what happens next', async () => {
    const { el } = await create();
    const text = textOf(el);
    expect(text).toContain('Application Submitted');
    expect(text).toContain('GVM-DR-2026-80782');
    expect(text).toContain("We've sent a confirmation to clementolawunmi@gmail.com and a text to +44 7700900123.");
    expect(text).toContain('We keep you posted.');
    expect(Array.from(el.querySelectorAll('a')).some((a) => a.textContent?.includes('Check status'))).toBe(true);
    el.remove();
  });

  it('copies the reference and confirms it for 2 seconds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { fixture, el } = await create();
    buttonByText(el, 'Copy reference').click();
    await tick();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith('GVM-DR-2026-80782');
    expect(textOf(el)).toContain('Copied');
    // whenStable waits out the 2 s confirmation.
    await settle(fixture);
    expect(textOf(el)).toContain('Copy reference');
    el.remove();
  });

  it('Track my application prefills the reference and opens the Track modal', async () => {
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { el } = await create();
    buttonByText(el, 'Track my application').click();
    expect(TestBed.inject(TrackStore).prefillReference()).toBe('GVM-DR-2026-80782');
    expect(nav).toHaveBeenCalledWith('/?dialog=track');
    el.remove();
  });
});
