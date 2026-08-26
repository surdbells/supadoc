import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '@supadoc/ui';
import { environment } from '../environments/environment';

interface Overview {
  appointments: { total: number; by_status: Record<string, number> };
  clinical_notes: number;
  prescriptions: number;
  lab_orders: number;
  referrals: number;
  recordings: { total: number; active: number };
  audit_events: number;
}

interface ConsultationRow {
  id: string;
  patient_name: string;
  specialist: string;
  scheduled_at: string;
  status: string;
  status_label: string;
  recording_active: boolean;
}

interface RecordingRow {
  id: string;
  status: string;
  started_by: string | null;
  started_at: string;
  stopped_at: string | null;
  files: string[];
}

interface AuditRow {
  id: string;
  actor_name: string;
  actor_role: string;
  action: string;
  created_at: string;
}

interface QualitySample {
  uplink: number;
  downlink: number;
  rtt: number | null;
  worst: number;
  at: string;
}

interface QualityRow {
  appointment_id: string;
  patient_name: string;
  specialist: string;
  patient: QualitySample | null;
  doctor: QualitySample | null;
  worst: number;
}

interface QualityData {
  average_rtt: number | null;
  consultations: QualityRow[];
}

const ADMIN_TOKEN_KEY = 'videomed.admin.token';

/**
 * Back-office consultation monitoring (route `/monitoring`). Read-only dashboard
 * over real platform data — consultation activity, live recordings and the audit
 * trail. Requires a staff account with `monitoring.view`; shares the admin token
 * with the Specialists page.
 */
@Component({
  selector: 'bo-monitoring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RouterLink],
  host: { class: 'block min-h-screen bg-glacier' },
  template: `
    <div class="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <span class="font-heading text-h4 tracking-tight">
            <span class="text-cerulean">Video</span><span class="text-sage">Med</span>
            <span class="ml-2 rounded-pill bg-ink/10 px-2.5 py-1 align-middle font-sans text-caption font-semibold text-ink">Admin</span>
          </span>
          <nav class="flex items-center gap-1">
            <a routerLink="/" class="rounded-field px-3 py-1.5 font-sans text-body-sm text-slate transition-colors hover:bg-cloud">Specialists</a>
            <a routerLink="/monitoring" class="rounded-field bg-frost px-3 py-1.5 font-sans text-body-sm font-semibold text-cerulean">Monitoring</a>
          </nav>
        </div>
        @if (token()) {
          <button type="button" class="flex items-center gap-1.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:text-alert" (click)="logout()">
            <sd-icon name="log-out" [size]="18" />Sign out
          </button>
        }
      </header>

      @if (!token()) {
        <div class="mx-auto mt-10 w-full max-w-md rounded-card border border-cloud bg-white p-8 text-center shadow-[0_4px_24px_rgba(10,22,40,0.06)]">
          <sd-icon name="lock" [size]="28" class="mx-auto text-slate" />
          <h1 class="mt-3 font-heading text-h5 text-ink">Sign in required</h1>
          <p class="mt-1 font-sans text-body-sm text-slate">
            Sign in on the <a routerLink="/" class="text-cerulean hover:underline">Specialists page</a>, then return here.
          </p>
        </div>
      } @else {
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Consultation monitoring</h1>
          <p class="font-sans text-body text-slate">Live platform activity, recordings and audit trail.</p>
        </div>

        @if (accessError()) {
          <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
            <sd-icon name="wifi-off" [size]="32" class="text-alert" />
            <p class="font-sans text-body-sm text-slate">{{ accessError() }}</p>
          </div>
        } @else {
          <!-- Overview -->
          @if (overview(); as o) {
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              @for (s of stats(o); track s.label) {
                <div class="rounded-card border border-cloud bg-white p-4">
                  <div class="flex items-center gap-2 text-slate">
                    <sd-icon [name]="s.icon" [size]="16" />
                    <span class="font-sans text-caption">{{ s.label }}</span>
                  </div>
                  <p class="mt-1 font-heading text-h4 text-ink">{{ s.value }}</p>
                  @if (s.hint) {
                    <p class="font-sans text-caption" [class]="s.hintClass ?? 'text-slate'">{{ s.hint }}</p>
                  }
                </div>
              }
            </div>
          }

          <!-- Tabs -->
          <div class="flex gap-1 border-b border-cloud">
            @for (t of tabs; track t.key) {
              <button type="button"
                class="relative px-4 py-2.5 font-sans text-body-sm transition-colors"
                [class]="tab() === t.key ? 'text-cerulean' : 'text-slate hover:text-ink'"
                (click)="tab.set(t.key)">
                {{ t.label }}
                @if (tab() === t.key) { <span class="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-cerulean"></span> }
              </button>
            }
          </div>

          @switch (tab()) {
            @case ('consultations') {
              <div class="overflow-x-auto rounded-card border border-cloud bg-white">
                <table class="w-full min-w-[640px] text-left">
                  <thead class="border-b border-cloud font-sans text-caption text-slate">
                    <tr>
                      <th class="px-4 py-3">Patient</th>
                      <th class="px-4 py-3">Specialist</th>
                      <th class="px-4 py-3">Scheduled</th>
                      <th class="px-4 py-3">Status</th>
                      <th class="px-4 py-3">Recording</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of consultations(); track c.id) {
                      <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                        <td class="px-4 py-3 font-medium">{{ c.patient_name }}</td>
                        <td class="px-4 py-3 text-slate">{{ c.specialist }}</td>
                        <td class="px-4 py-3 text-slate">{{ when(c.scheduled_at) }}</td>
                        <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="statusClass(c.status)">{{ c.status_label }}</span></td>
                        <td class="px-4 py-3">
                          @if (c.recording_active) {
                            <span class="flex items-center gap-1.5 text-alert"><span class="size-2 animate-pulse rounded-full bg-alert"></span> Live</span>
                          } @else { <span class="text-ash">—</span> }
                        </td>
                      </tr>
                    } @empty {
                      <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">No consultations.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @case ('quality') {
              <div class="flex flex-col gap-3">
                @if (quality()?.average_rtt !== null && quality()?.average_rtt !== undefined) {
                  <p class="font-sans text-body-sm text-slate">
                    Average round-trip time:
                    <span class="font-semibold text-ink">{{ quality()?.average_rtt }} ms</span>
                    <span class="ml-1 text-caption text-ash">(across recent samples)</span>
                  </p>
                }
                <div class="overflow-x-auto rounded-card border border-cloud bg-white">
                  <table class="w-full min-w-[680px] text-left">
                    <thead class="border-b border-cloud font-sans text-caption text-slate">
                      <tr>
                        <th class="px-4 py-3">Consultation</th>
                        <th class="px-4 py-3">Patient link</th>
                        <th class="px-4 py-3">Patient RTT</th>
                        <th class="px-4 py-3">Doctor link</th>
                        <th class="px-4 py-3">Doctor RTT</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (c of quality()?.consultations ?? []; track c.appointment_id) {
                        <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                          <td class="px-4 py-3">
                            <span class="font-medium">{{ c.patient_name }}</span>
                            <span class="block text-caption text-slate">{{ c.specialist }}</span>
                          </td>
                          <td class="px-4 py-3 font-medium" [class]="qualityLabel(c.patient?.worst).cls">
                            {{ qualityLabel(c.patient?.worst).text }}
                          </td>
                          <td class="px-4 py-3 text-slate">{{ c.patient?.rtt ? c.patient?.rtt + ' ms' : '—' }}</td>
                          <td class="px-4 py-3 font-medium" [class]="qualityLabel(c.doctor?.worst).cls">
                            {{ qualityLabel(c.doctor?.worst).text }}
                          </td>
                          <td class="px-4 py-3 text-slate">{{ c.doctor?.rtt ? c.doctor?.rtt + ' ms' : '—' }}</td>
                        </tr>
                      } @empty {
                        <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">
                          No quality samples yet — they appear once calls are in progress.
                        </td></tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            }
            @case ('recordings') {
              <div class="overflow-x-auto rounded-card border border-cloud bg-white">
                <table class="w-full min-w-[560px] text-left">
                  <thead class="border-b border-cloud font-sans text-caption text-slate">
                    <tr>
                      <th class="px-4 py-3">Status</th>
                      <th class="px-4 py-3">Started by</th>
                      <th class="px-4 py-3">Started</th>
                      <th class="px-4 py-3">Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of recordings(); track r.id) {
                      <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                        <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="recStatusClass(r.status)">{{ r.status }}</span></td>
                        <td class="px-4 py-3 text-slate">{{ r.started_by || '—' }}</td>
                        <td class="px-4 py-3 text-slate">{{ when(r.started_at) }}</td>
                        <td class="px-4 py-3 text-slate">{{ r.files.length }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="px-4 py-10 text-center font-sans text-body-sm text-slate">No recordings.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            }
            @case ('audit') {
              <div class="overflow-x-auto rounded-card border border-cloud bg-white">
                <table class="w-full min-w-[560px] text-left">
                  <thead class="border-b border-cloud font-sans text-caption text-slate">
                    <tr>
                      <th class="px-4 py-3">Action</th>
                      <th class="px-4 py-3">Actor</th>
                      <th class="px-4 py-3">Role</th>
                      <th class="px-4 py-3">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (a of audit(); track a.id) {
                      <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                        <td class="px-4 py-3 font-mono text-caption">{{ a.action }}</td>
                        <td class="px-4 py-3">{{ a.actor_name }}</td>
                        <td class="px-4 py-3 text-slate capitalize">{{ a.actor_role }}</td>
                        <td class="px-4 py-3 text-slate">{{ when(a.created_at) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="px-4 py-10 text-center font-sans text-body-sm text-slate">No audit events yet.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        }
      }
    </div>
  `,
})
export class AdminMonitoring implements OnInit {
  protected readonly token = signal<string | null>(this.readToken());
  protected readonly accessError = signal('');
  protected readonly tab = signal<'consultations' | 'quality' | 'recordings' | 'audit'>('consultations');

  protected readonly overview = signal<Overview | null>(null);
  protected readonly consultations = signal<ConsultationRow[]>([]);
  protected readonly recordings = signal<RecordingRow[]>([]);
  protected readonly audit = signal<AuditRow[]>([]);
  protected readonly quality = signal<QualityData | null>(null);

  protected readonly tabs = [
    { key: 'consultations' as const, label: 'Consultations' },
    { key: 'quality' as const, label: 'Quality' },
    { key: 'recordings' as const, label: 'Recordings' },
    { key: 'audit' as const, label: 'Audit log' },
  ];

  private readonly base = environment.apiBaseUrl.replace(/\/+$/, '');

  ngOnInit(): void {
    if (this.token()) void this.loadAll();
  }

  protected stats(o: Overview): Array<{ label: string; value: number | string; icon: string; hint?: string; hintClass?: string }> {
    return [
      { label: 'Appointments', value: o.appointments.total, icon: 'calendar-days' },
      {
        label: 'Recordings',
        value: o.recordings.total,
        icon: 'video',
        hint: o.recordings.active > 0 ? o.recordings.active + ' live now' : 'none live',
        hintClass: o.recordings.active > 0 ? 'text-alert' : 'text-slate',
      },
      { label: 'Clinical notes', value: o.clinical_notes, icon: 'clipboard-list' },
      { label: 'Prescriptions', value: o.prescriptions, icon: 'pill' },
      { label: 'Lab orders', value: o.lab_orders, icon: 'clipboard-list' },
      { label: 'Audit events', value: o.audit_events, icon: 'shield-check' },
    ];
  }

  private async loadAll(): Promise<void> {
    await Promise.all([
      this.fetchInto('/api/admin/monitoring/overview', (d) => this.overview.set(d as Overview)),
      this.fetchInto('/api/admin/monitoring/consultations?per_page=25', (d) => this.consultations.set((d ?? []) as ConsultationRow[])),
      this.fetchInto('/api/admin/monitoring/recordings', (d) => this.recordings.set((d ?? []) as RecordingRow[])),
      this.fetchInto('/api/admin/monitoring/audit?per_page=40', (d) => this.audit.set((d ?? []) as AuditRow[])),
      this.fetchInto('/api/admin/monitoring/quality', (d) => this.quality.set(d as QualityData)),
    ]);
  }

  protected qualityLabel(q: number | undefined): { text: string; cls: string } {
    switch (q) {
      case 1:
        return { text: 'Excellent', cls: 'text-sage' };
      case 2:
        return { text: 'Good', cls: 'text-sage' };
      case 3:
        return { text: 'Poor', cls: 'text-warning' };
      case 4:
        return { text: 'Bad', cls: 'text-warning' };
      case 5:
      case 6:
        return { text: 'Very bad', cls: 'text-alert' };
      default:
        return { text: '—', cls: 'text-ash' };
    }
  }

  private async fetchInto(path: string, set: (data: unknown) => void): Promise<void> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${this.token()}` },
      });
      if (res.status === 401) {
        this.logout();
        return;
      }
      if (res.status === 403) {
        this.accessError.set('This account lacks monitoring access (monitoring.view).');
        return;
      }
      const body = await res.json().catch(() => null);
      if (res.ok) set(body?.data);
    } catch {
      this.accessError.set('Could not reach the server.');
    }
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? '—'
      : new Intl.DateTimeFormat('en-GB', {
          day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
        }).format(d);
  }

  protected statusClass(status: string): string {
    const map: Record<string, string> = {
      pending: 'bg-warning/15 text-warning',
      confirmed: 'bg-sage/15 text-sage',
      rescheduled: 'bg-cloud text-slate',
      completed: 'bg-frost text-cerulean',
      cancelled: 'bg-alert/10 text-alert',
    };
    return map[status] ?? 'bg-cloud text-slate';
  }

  protected recStatusClass(status: string): string {
    const map: Record<string, string> = {
      recording: 'bg-alert/10 text-alert',
      stopped: 'bg-frost text-cerulean',
      failed: 'bg-cloud text-slate',
    };
    return map[status] ?? 'bg-cloud text-slate';
  }

  protected logout(): void {
    try {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch {
      /* no-op */
    }
    this.token.set(null);
  }

  private readToken(): string | null {
    try {
      return localStorage.getItem(ADMIN_TOKEN_KEY);
    } catch {
      return null;
    }
  }
}
