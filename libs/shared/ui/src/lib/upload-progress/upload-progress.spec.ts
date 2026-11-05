import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { UploadProgress } from '@supadoc/data-access';
import { UploadProgressComponent } from './upload-progress';

@Component({
  imports: [UploadProgressComponent],
  template: `<sd-upload-progress [progress]="progress()" label="Uploading scan.pdf" subject="scan.pdf" [announce]="announce()" />`,
})
class Host {
  readonly progress = signal<UploadProgress>({ percent: 0, finishing: false });
  readonly announce = signal(true);
}

describe('UploadProgressComponent', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  const bar = () => el.querySelector('[role="progressbar"]') as HTMLElement;
  const fill = () => bar().firstElementChild as HTMLElement;
  const live = () => el.querySelector('[aria-live="polite"]');
  const set = (p: UploadProgress) => {
    fixture.componentInstance.progress.set(p);
    fixture.detectChanges();
  };

  beforeEach(() => {
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  it('fills with the share sent, named for screen readers', () => {
    set({ percent: 25, finishing: false });
    expect(bar().getAttribute('aria-label')).toBe('Uploading scan.pdf');
    expect(bar().getAttribute('aria-valuenow')).toBe('25');
    expect(bar().getAttribute('aria-valuetext')).toBe('25%');
    expect(bar().dataset['state']).toBe('uploading');
    expect(fill().style.width).toBe('25%');
    expect(live()?.textContent?.trim()).toBe('');
  });

  it('once every byte is sent: an indeterminate "Finishing…" bar, announced politely', () => {
    set({ percent: 100, finishing: true });
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(bar().getAttribute('aria-valuetext')).toBe('Finishing…');
    expect(bar().dataset['state']).toBe('finishing');
    expect(fill().classList).toContain('sd-upload-sweep');
    expect(fill().style.width).toBe('');
    expect(live()?.getAttribute('aria-atomic')).toBe('true');
    expect(live()?.textContent?.trim()).toBe('scan.pdf is sent. Finishing up…');
  });

  it('an unknown size sweeps ("Uploading…") instead of sitting at 0%', () => {
    set({ percent: null, finishing: false });
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(bar().getAttribute('aria-valuetext')).toBe('Uploading…');
    expect(bar().dataset['state']).toBe('unknown');
    expect(fill().classList).toContain('sd-upload-sweep');
    expect(live()?.textContent?.trim()).toBe('');
  });

  it('leaves the announcement to the page when asked', () => {
    fixture.componentInstance.announce.set(false);
    set({ percent: 100, finishing: true });
    expect(live()).toBeNull();
    expect(bar().getAttribute('aria-valuetext')).toBe('Finishing…');
  });
});
