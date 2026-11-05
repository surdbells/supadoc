import { Component, input, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AdminDoctorApplicationsApi } from '@supadoc/data-access';
import type { DoctorApplicationDetailDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import type { ViewerSource } from '@supadoc/viewer';
import { of } from 'rxjs';
import { EMBEDDED_VIEWER } from '../../shared/viewer-sources';
import { applicationDetail, applicationDocument } from '../testing';
import { ApplicationDocumentsTab } from './documents-tab';

@Component({ selector: 'bo-stub-viewer', template: '' })
class StubViewer {
  /** The bodies created so far (the dialog creates them with a ViewContainerRef). */
  static created: StubViewer[] = [];
  constructor() {
    StubViewer.created.push(this);
  }
  readonly source = input.required<ViewerSource>();
  readonly mode = input('modal');
  readonly tone = input('auto');
}

@Component({
  imports: [ApplicationDocumentsTab],
  template: `<bo-application-documents [detail]="d()" />`,
})
class Host {
  readonly d = signal<DoctorApplicationDetailDto>(
    applicationDetail({
      documents: [
        applicationDocument(),
        applicationDocument({ id: 'doc-old', state: 'replaced', original_name: 'old.pdf' }),
      ],
    }),
  );
}

describe('ApplicationDocumentsTab', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let open: ReturnType<typeof vi.spyOn>;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    open = vi.spyOn(window, 'open').mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideSupadocIcons(),
        { provide: AdminDoctorApplicationsApi, useValue: { documentFile: vi.fn(() => of(new Blob())) } },
        { provide: EMBEDDED_VIEWER, useValue: () => Promise.resolve(StubViewer) },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    document.body.appendChild(el);
    await render();
  });

  afterEach(() => {
    el.remove();
    open.mockRestore();
  });

  it('has no "Open in new tab": View opens the document in the dialog', async () => {
    const buttons = Array.from(el.querySelectorAll('button'));
    expect(buttons.some((b) => /new tab/i.test(`${b.textContent} ${b.getAttribute('aria-label')}`))).toBe(false);
    expect(el.querySelector('a[target="_blank"]')).toBeNull();

    const view = el.querySelector('#bo-app-doc-view-doc-1') as HTMLButtonElement;
    expect(view.getAttribute('aria-label')).toBe('View Current MDCN practising licence');
    view.click();
    await render();
    expect(el.querySelector('dialog[open]')).not.toBeNull();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('bo-stub-viewer')).not.toBeNull();
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('replaced documents still open in the dialog', async () => {
    (el.querySelector('#bo-app-doc-view-doc-old') as HTMLButtonElement).click();
    await render();
    expect(el.querySelector('dialog[open]')?.textContent).toContain('Replaced by a newer upload');
    expect(open).not.toHaveBeenCalled();
  });
});
