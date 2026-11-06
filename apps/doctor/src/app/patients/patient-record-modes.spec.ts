import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DoctorApi } from '@supadoc/data-access';
import type { AppointmentDto, MedicalDto } from '@supadoc/models';
import { provideSupadocIcons } from '@supadoc/ui';
import { of } from 'rxjs';
import { PatientOverview } from './patient-overview';
import { PatientVisits } from './patient-visits';

const MEDICAL = { allergies: [], conditions: [], medications: [], history: [] } as unknown as MedicalDto;

function visit(id: string, over: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id,
    patient_id: 'p1',
    specialist: { id: 'd1', name: 'Dr Ada Obi' },
    scheduled_at: '2026-10-01T10:00:00Z',
    type: 'video',
    type_label: 'Video consultation',
    status: 'completed',
    status_label: 'Completed',
    amount: '0',
    created_at: '2026-09-01T10:00:00Z',
    ...over,
  } as unknown as AppointmentDto;
}

function providers() {
  return [
    provideRouter([]),
    provideSupadocIcons(),
    { provide: DoctorApi, useValue: { getProfile: () => of({ data: { id: 'd', name: 'Dr', timezone: 'Africa/Lagos', timezone_source: 'manual' } }) } },
  ];
}

describe('the record components in their two modes', () => {
  describe('PatientOverview', () => {
    let fixture: ComponentFixture<PatientOverview>;
    let el: HTMLElement;

    function setup(mode?: 'link' | 'drill') {
      TestBed.configureTestingModule({ imports: [PatientOverview], providers: providers() });
      fixture = TestBed.createComponent(PatientOverview);
      fixture.componentRef.setInput('medical', MEDICAL);
      fixture.componentRef.setInput('visits', [visit('v1')]);
      fixture.componentRef.setInput('visitCount', 1);
      if (mode) fixture.componentRef.setInput('chartMode', mode);
      fixture.detectChanges();
      el = fixture.nativeElement;
    }

    it('default: "Open chart" links to the appointment (the page’s behaviour, unchanged)', () => {
      setup();
      const link = el.querySelector<HTMLAnchorElement>('a[href^="/appointments/"]');
      expect(link?.getAttribute('href')).toBe('/appointments/v1');
      expect(link?.textContent).toContain('Open chart');
      expect(el.querySelector('[data-visit-id]')).toBeNull();
    });

    it('drill: no anchors; a "View visit" button with data-visit-id and a name; pressing emits the visit', () => {
      setup('drill');
      expect(el.querySelector('a')).toBeNull();
      const b = el.querySelector<HTMLButtonElement>('button[data-visit-id="v1"]');
      expect(b?.textContent).toContain('View visit');
      expect(b?.getAttribute('aria-label')).toContain('View visit: Video consultation on');
      const seen: AppointmentDto[] = [];
      fixture.componentInstance.openVisit.subscribe((v) => seen.push(v));
      b?.click();
      expect(seen.map((v) => v.id)).toEqual(['v1']);
    });
  });

  describe('PatientVisits', () => {
    let fixture: ComponentFixture<PatientVisits>;
    let el: HTMLElement;

    function setup(inputs: Record<string, unknown> = {}) {
      TestBed.configureTestingModule({ imports: [PatientVisits], providers: providers() });
      fixture = TestBed.createComponent(PatientVisits);
      fixture.componentRef.setInput('visits', [visit('v1'), visit('v2')]);
      for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
      fixture.detectChanges();
      el = fixture.nativeElement;
    }

    it('default: "Open chart" links; currentId changes nothing', () => {
      setup({ currentId: 'v1' });
      expect(Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['/appointments/v1', '/appointments/v2']);
      expect(el.textContent).not.toContain('This consultation');
    });

    it('drill: no anchors; "View visit" buttons; pressing emits; the current one says so', () => {
      setup({ chartMode: 'drill', currentId: 'v2' });
      expect(el.querySelector('a')).toBeNull();
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('button[data-visit-id]'));
      expect(buttons.map((b) => b.getAttribute('data-visit-id'))).toEqual(['v1', 'v2']);
      expect(buttons[0]?.getAttribute('aria-label')).toContain('View visit: Video consultation on');
      expect(el.textContent?.match(/This consultation/g)?.length).toBe(1);
      expect(buttons[1]?.closest('li')?.textContent).toContain('This consultation');
      const seen: AppointmentDto[] = [];
      fixture.componentInstance.openVisit.subscribe((v) => seen.push(v));
      buttons[1]?.click();
      expect(seen.map((v) => v.id)).toEqual(['v2']);
    });
  });
});
