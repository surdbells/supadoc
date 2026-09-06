import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MonitoringApi } from '@supadoc/data-access';
import type {
  MonitoringConsultationRow,
  MonitoringQualityDto,
  RecordingDto,
  RecordingFileDto,
} from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

type TabKey = 'consultations' | 'quality' | 'recordings';

/** Consultation monitoring (route `/monitoring`) — activity, call quality, recordings. */
@Component({
  selector: 'bo-monitoring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Consultation monitoring</h1>
        <p class="font-sans text-body text-slate">Activity, call quality and recordings.</p>
      </header>

      <div class="flex gap-1 border-b border-cloud">
        @for (t of tabs; track t.key) {
          <button
            type="button"
            class="relative px-4 py-2.5 font-sans text-body-sm transition-colors"
            [class]="tab() === t.key ? 'text-cerulean' : 'text-slate hover:text-ink'"
            (click)="select(t.key)"
          >
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
                  <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No consultations.' }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
        @case ('quality') {
          <div class="flex flex-col gap-3">
            @if (quality()?.average_rtt != null) {
              <p class="font-sans text-body-sm text-slate">
                Average round-trip time: <span class="font-semibold text-ink">{{ quality()?.average_rtt }} ms</span>
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
                      <td class="px-4 py-3 font-medium" [class]="qualityLabel(c.patient?.worst).cls">{{ qualityLabel(c.patient?.worst).text }}</td>
                      <td class="px-4 py-3 text-slate">{{ c.patient?.rtt ? c.patient?.rtt + ' ms' : '—' }}</td>
                      <td class="px-4 py-3 font-medium" [class]="qualityLabel(c.doctor?.worst).cls">{{ qualityLabel(c.doctor?.worst).text }}</td>
                      <td class="px-4 py-3 text-slate">{{ c.doctor?.rtt ? c.doctor?.rtt + ' ms' : '—' }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">No quality samples yet — they appear once calls are in progress.</td></tr>
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
                  <th class="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                @for (r of recordings(); track r.id) {
                  <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                    <td class="px-4 py-3"><span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="recStatusClass(r.status)">{{ r.status }}</span></td>
                    <td class="px-4 py-3 text-slate">{{ r.started_by || '—' }}</td>
                    <td class="px-4 py-3 text-slate">{{ when(r.started_at) }}</td>
                    <td class="px-4 py-3 text-slate">{{ r.files.length }}</td>
                    <td class="px-4 py-3 text-right">
                      @if (r.files.length > 0) {
                        <button type="button" class="font-sans text-caption font-semibold text-cerulean hover:underline" (click)="openFiles(r)">View files</button>
                      } @else { <span class="text-ash">—</span> }
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">{{ loading() ? 'Loading…' : 'No recordings.' }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </div>

    @if (filesOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="filesOpen.set(false)"></button>
        <div class="relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)]">
          <div class="flex items-center justify-between">
            <h2 class="font-heading text-h5 text-ink">Recording files</h2>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="filesOpen.set(false)"><sd-icon name="x" [size]="24" /></button>
          </div>
          @if (filesLoading()) {
            <div class="sd-shimmer h-16 rounded-field"></div>
          } @else {
            @for (f of files(); track f.key) {
              <div class="flex items-center justify-between gap-3 rounded-field border border-cloud px-4 py-2.5">
                <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink">
                  <sd-icon name="file-text" [size]="18" class="shrink-0 text-slate" />
                  <span class="truncate">{{ f.name }}</span>
                </span>
                @if (f.url) {
                  <a [href]="f.url" target="_blank" rel="noopener" class="flex shrink-0 items-center gap-1.5 font-sans text-caption font-semibold text-cerulean hover:underline">
                    <sd-icon name="download" [size]="16" />Download
                  </a>
                } @else {
                  <span class="shrink-0 font-sans text-caption text-slate">Storage not configured</span>
                }
              </div>
            } @empty {
              <p class="font-sans text-body-sm text-slate">No files.</p>
            }
          }
        </div>
      </div>
    }
  `,
})
export class AdminMonitoring implements OnInit {
  private readonly api = inject(MonitoringApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tabs = [
    { key: 'consultations' as const, label: 'Consultations' },
    { key: 'quality' as const, label: 'Quality' },
    { key: 'recordings' as const, label: 'Recordings' },
  ];
  protected readonly tab = signal<TabKey>('consultations');
  protected readonly loading = signal(false);
  private readonly loaded = new Set<TabKey>();

  protected readonly consultations = signal<MonitoringConsultationRow[]>([]);
  protected readonly quality = signal<MonitoringQualityDto | null>(null);
  protected readonly recordings = signal<RecordingDto[]>([]);

  // Files modal
  protected readonly filesOpen = signal(false);
  protected readonly filesLoading = signal(false);
  protected readonly files = signal<RecordingFileDto[]>([]);

  ngOnInit(): void {
    this.select('consultations');
  }

  protected openFiles(r: RecordingDto): void {
    this.filesOpen.set(true);
    this.filesLoading.set(true);
    this.files.set([]);
    this.api
      .recordingFiles(r.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.files.set(res.data.files);
          this.filesLoading.set(false);
        },
        error: () => this.filesLoading.set(false),
      });
  }

  protected select(tab: TabKey): void {
    this.tab.set(tab);
    if (this.loaded.has(tab)) return;
    this.loaded.add(tab);
    this.loading.set(true);
    const done = () => this.loading.set(false);
    if (tab === 'consultations') {
      this.api.consultations({ per_page: 25 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.consultations.set(r.data); done(); }, error: done });
    } else if (tab === 'quality') {
      this.api.quality().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.quality.set(r.data); done(); }, error: done });
    } else {
      this.api.recordings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.recordings.set(r.data); done(); }, error: done });
    }
  }

  protected qualityLabel(q: number | undefined): { text: string; cls: string } {
    switch (q) {
      case 1: return { text: 'Excellent', cls: 'text-sage' };
      case 2: return { text: 'Good', cls: 'text-sage' };
      case 3: return { text: 'Poor', cls: 'text-warning' };
      case 4: return { text: 'Bad', cls: 'text-warning' };
      case 5:
      case 6: return { text: 'Very bad', cls: 'text-alert' };
      default: return { text: '—', cls: 'text-ash' };
    }
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
  }
  protected statusClass(status: string): string {
    const map: Record<string, string> = { pending: 'bg-warning/15 text-warning', confirmed: 'bg-sage/15 text-sage', rescheduled: 'bg-cloud text-slate', completed: 'bg-frost text-cerulean', cancelled: 'bg-alert/10 text-alert' };
    return map[status] ?? 'bg-cloud text-slate';
  }
  protected recStatusClass(status: string): string {
    const map: Record<string, string> = { recording: 'bg-alert/10 text-alert', stopped: 'bg-frost text-cerulean', failed: 'bg-cloud text-slate' };
    return map[status] ?? 'bg-cloud text-slate';
  }
}
