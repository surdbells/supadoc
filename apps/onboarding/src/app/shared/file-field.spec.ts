import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { ApplicationDocumentDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { doc } from '../../testing/onb-testing';
import { FILE_SIZE_ERROR, FILE_TYPE_ERROR, FileFieldComponent, fileProblem } from './file-field';

@Component({
  imports: [FileFieldComponent],
  template: `
    <onb-file-field
      label="Government-issued ID"
      hint="Passport, driver's licence or national ID"
      inputId="onb-government_id"
      [required]="true"
      [document]="document()"
      [progress]="progress()"
      [readonly]="readonly()"
      (pick)="picked.push($event)"
      (remove)="removed = removed + 1"
    />
  `,
})
class Host {
  readonly document = signal<ApplicationDocumentDto | null>(null);
  readonly progress = signal<number | null>(null);
  readonly readonly = signal(false);
  readonly picked: File[] = [];
  removed = 0;
}

const file = (name: string, type: string, size = 1000) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('FileFieldComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;
  let field: FileFieldComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host], providers: [provideSupadocIcons()] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    fixture.detectChanges();
    field = fixture.debugElement.children[0].componentInstance as FileFieldComponent;
  });

  it('refuses the wrong type and oversized files before upload', () => {
    expect(fileProblem(file('cv.docx', 'application/msword'))).toBe(FILE_TYPE_ERROR);
    expect(fileProblem(file('cv.pdf', 'application/pdf', 6 * 1024 * 1024))).toBe(FILE_SIZE_ERROR);
    expect(fileProblem(file('id.jpg', 'image/jpeg'))).toBeNull();
    field.take(file('cv.docx', 'application/msword'));
    fixture.detectChanges();
    expect(host.picked).toHaveLength(0);
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('File must be PDF, PNG or JPG.');
  });

  it('hands a good file to the page', () => {
    field.take(file('id.png', 'image/png'));
    expect(host.picked.map((f) => f.name)).toEqual(['id.png']);
  });

  it('names the drop zone for screen readers', () => {
    const zone = el.querySelector<HTMLButtonElement>('#onb-government_id');
    expect(zone?.getAttribute('aria-label')).toBe('Upload Government-issued ID. PDF, PNG or JPG, up to 5MB');
    expect(el.textContent).toContain('Click to upload');
  });

  it('shows progress while uploading', () => {
    host.progress.set(42);
    fixture.detectChanges();
    const bar = el.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
  });

  it('shows the uploaded row with labelled Replace and Remove', () => {
    host.document.set(doc('government_id', { original_name: 'ID.png', size_bytes: 3072 }));
    fixture.detectChanges();
    expect(el.textContent).toContain('ID.png');
    expect(el.textContent).toContain('3 KB · Uploaded');
    expect(el.querySelector('[aria-label="Replace Government-issued ID"]')).toBeTruthy();
    const remove = el.querySelector<HTMLButtonElement>('[aria-label="Remove Government-issued ID"]');
    remove?.click();
    expect(host.removed).toBe(1);
  });

  it('is read-only when the slot cannot change', () => {
    host.readonly.set(true);
    fixture.detectChanges();
    const zone = el.querySelector<HTMLButtonElement>('#onb-government_id');
    expect(zone?.getAttribute('aria-disabled')).toBe('true');
  });
});
