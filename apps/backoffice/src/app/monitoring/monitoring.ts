import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, MonitoringApi } from '@supadoc/data-access';
import type {
  MonitoringConsultationRow,
  MonitoringQualityDto,
  RecordingDto,
  RecordingFileDto,
} from '@supadoc/models';
import { AlertComponent, DialogComponent, IconComponent } from '@supadoc/ui';
import {
  BTN_SECONDARY,
  CELL_STATE,
  INLINE_ERROR,
  LOAD_MORE,
  PAGE,
  PAGE_HEADER_TEXT,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  PILL,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED_WRAP,
  SEGMENT_FILL,
  TABLE,
  TABLE_LINK,
  TABLE_WRAP,
  TBODY,
  TD,
  TD_ACTION,
  TD_EMPTY,
  TD_PRIMARY,
  TD_SUB,
  TH,
  THEAD,
  TR,
} from '../shared/layout';
import { appointmentStatusClass } from '../shared/appointment-status';

type TabKey = 'consultations' | 'quality' | 'recordings';

/** Consultation monitoring (route `/monitoring`) — activity, call quality, recordings. */
@Component({
  selector: 'bo-monitoring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, AlertComponent, DialogComponent],
  host: { class: 'block' },
  template: `
    <div class="${PAGE}">
      <header class="${PAGE_HEADER_TEXT}">
        <h1 class="${PAGE_TITLE}">Consultation monitoring</h1>
        <p class="${PAGE_SUBTITLE}">Activity, call quality and recordings.</p>
      </header>

      <div class="${SEGMENTED_WRAP}" role="group" aria-label="Monitoring view">
        @for (t of tabs; track t.key) {
          <button
            type="button"
            class="${SEGMENT} ${SEGMENT_FILL}"
            [class]="tab() === t.key ? '${SEGMENT_ON}' : '${SEGMENT_OFF}'"
            [attr.aria-pressed]="tab() === t.key"
            (click)="select(t.key)"
          >
            {{ t.label }}
          </button>
        }
      </div>

      @switch (tab()) {
        @case ('consultations') {
          <div class="flex flex-col gap-4">
            <div class="${TABLE_WRAP}">
              <table class="${TABLE} min-w-[640px]">
                <thead class="${THEAD}">
                  <tr>
                    <th class="${TH}">Patient</th>
                    <th class="${TH}">Specialist</th>
                    <th class="${TH}">Scheduled</th>
                    <th class="${TH}">Status</th>
                    <th class="${TH}">Recording</th>
                  </tr>
                </thead>
                <tbody class="${TBODY}">
                  @for (c of consultations(); track c.id) {
                    <tr class="${TR}">
                      <td class="${TD} ${TD_PRIMARY}">{{ c.patient_name }}</td>
                      <td class="${TD} text-slate">{{ c.specialist }}</td>
                      <td class="${TD} text-slate">{{ when(c.scheduled_at) }}</td>
                      <td class="${TD}"><span class="${PILL}" [class]="statusClass(c.status)">{{ c.status_label }}</span></td>
                      <td class="${TD}">
                        @if (c.recording_active) {
                          <span class="flex items-center gap-1.5 font-semibold text-alert"><span class="size-2 animate-pulse rounded-full bg-alert"></span> Live</span>
                        } @else { <span class="text-ash">—</span> }
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="${TD_EMPTY}">
                        @if (loading()) {
                          <div class="${CELL_STATE}" aria-busy="true"><sd-icon name="loader-circle" [size]="28" class="animate-spin text-cerulean" /><p>Loading consultations…</p></div>
                        } @else if (tabErrors().consultations; as err) {
                          <div class="${CELL_STATE}" role="alert">
                            <sd-icon name="wifi-off" [size]="28" class="text-alert" />
                            <p>{{ err }}</p>
                            <button type="button" class="${BTN_SECONDARY}" (click)="select('consultations')"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
                          </div>
                        } @else {
                          <div class="${CELL_STATE}"><sd-icon name="activity" [size]="28" class="text-slate" /><p>No consultations.</p></div>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (moreError() || consultationsHasMore()) {
              <div class="${LOAD_MORE}">
                @if (moreError()) {
                  <p class="${INLINE_ERROR}" role="alert"><sd-icon name="circle-alert" [size]="16" class="shrink-0" />{{ moreError() }}</p>
                }
                @if (consultationsHasMore()) {
                  <button type="button" class="${BTN_SECONDARY}" [disabled]="loadingMore()" (click)="loadMoreConsultations()">
                    @if (loadingMore()) {
                      <sd-icon name="loader-circle" [size]="16" class="animate-spin" />Loading…
                    } @else {
                      <sd-icon name="chevron-down" [size]="16" />Load more
                    }
                  </button>
                }
              </div>
            }
          </div>
        }
        @case ('quality') {
          <div class="flex flex-col gap-4">
            @if (quality()?.average_rtt; as avgRtt) {
              <p class="font-sans text-body-sm text-slate">
                Average round-trip time: <span class="font-semibold text-ink">{{ avgRtt }} ms</span>
              </p>
            }
            <div class="${TABLE_WRAP}">
              <table class="${TABLE} min-w-[680px]">
                <thead class="${THEAD}">
                  <tr>
                    <th class="${TH}">Consultation</th>
                    <th class="${TH}">Patient link</th>
                    <th class="${TH}">Patient RTT</th>
                    <th class="${TH}">Doctor link</th>
                    <th class="${TH}">Doctor RTT</th>
                  </tr>
                </thead>
                <tbody class="${TBODY}">
                  @for (c of quality()?.consultations ?? []; track c.appointment_id) {
                    <tr class="${TR}">
                      <td class="${TD}">
                        <span class="${TD_PRIMARY}">{{ c.patient_name }}</span>
                        <span class="${TD_SUB}">{{ c.specialist }}</span>
                      </td>
                      <td class="${TD} font-semibold" [class]="qualityLabel(c.patient?.worst).cls">{{ qualityLabel(c.patient?.worst).text }}</td>
                      <td class="${TD} text-slate">{{ c.patient?.rtt ? c.patient?.rtt + ' ms' : '—' }}</td>
                      <td class="${TD} font-semibold" [class]="qualityLabel(c.doctor?.worst).cls">{{ qualityLabel(c.doctor?.worst).text }}</td>
                      <td class="${TD} text-slate">{{ c.doctor?.rtt ? c.doctor?.rtt + ' ms' : '—' }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="${TD_EMPTY}">
                        @if (tabErrors().quality && !loading()) {
                          <div class="${CELL_STATE}" role="alert">
                            <sd-icon name="wifi-off" [size]="28" class="text-alert" />
                            <p>{{ tabErrors().quality }}</p>
                            <button type="button" class="${BTN_SECONDARY}" (click)="select('quality')"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
                          </div>
                        } @else {
                          <div class="${CELL_STATE}"><sd-icon name="activity" [size]="28" class="text-slate" /><p>No quality samples yet — they appear once calls are in progress.</p></div>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
        @case ('recordings') {
          <div class="${TABLE_WRAP}">
            <table class="${TABLE} min-w-[560px]">
              <thead class="${THEAD}">
                <tr>
                  <th class="${TH}">Status</th>
                  <th class="${TH}">Started by</th>
                  <th class="${TH}">Started</th>
                  <th class="${TH}">Files</th>
                  <th class="${TH}"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody class="${TBODY}">
                @for (r of recordings(); track r.id) {
                  <tr class="${TR}">
                    <td class="${TD}"><span class="${PILL} capitalize" [class]="recStatusClass(r.status)">{{ r.status }}</span></td>
                    <td class="${TD} text-slate">{{ r.started_by || '—' }}</td>
                    <td class="${TD} text-slate">{{ when(r.started_at) }}</td>
                    <td class="${TD} text-slate">{{ r.files.length }}</td>
                    <td class="${TD_ACTION}">
                      @if (r.files.length > 0) {
                        <button type="button" class="${TABLE_LINK}" (click)="openFiles(r)">View files<sd-icon name="chevron-right" [size]="16" /></button>
                      } @else { <span class="text-ash">—</span> }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="${TD_EMPTY}">
                      @if (loading()) {
                        <div class="${CELL_STATE}" aria-busy="true"><sd-icon name="loader-circle" [size]="28" class="animate-spin text-cerulean" /><p>Loading recordings…</p></div>
                      } @else if (tabErrors().recordings; as err) {
                        <div class="${CELL_STATE}" role="alert">
                          <sd-icon name="wifi-off" [size]="28" class="text-alert" />
                          <p>{{ err }}</p>
                          <button type="button" class="${BTN_SECONDARY}" (click)="select('recordings')"><sd-icon name="refresh-cw" [size]="16" />Try again</button>
                        </div>
                      } @else {
                        <div class="${CELL_STATE}"><sd-icon name="file-text" [size]="28" class="text-slate" /><p>No recordings.</p></div>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </div>

    <sd-dialog [open]="filesOpen()" title="Recording files" size="md" (closed)="filesOpen.set(false)">
      <div class="flex flex-col gap-3" [attr.aria-busy]="filesLoading() || null">
        @if (filesLoading()) {
          <div class="sd-shimmer h-16 rounded-field" aria-hidden="true"></div>
          <p class="sr-only">Loading the recording files…</p>
        } @else {
          @for (f of files(); track f.key) {
            <div class="flex items-center justify-between gap-3 rounded-field border border-cloud px-4 py-2.5">
              <span class="flex min-w-0 items-center gap-2 font-sans text-body-sm text-ink">
                <sd-icon name="file-text" [size]="18" class="shrink-0 text-slate" />
                <span class="truncate">{{ f.name }}</span>
              </span>
              @if (f.url) {
                <a [href]="f.url" target="_blank" rel="noopener" class="flex min-h-11 shrink-0 items-center gap-1.5 font-sans text-caption font-semibold text-cerulean hover:underline" [attr.aria-label]="'Download ' + f.name">
                  <sd-icon name="download" [size]="16" />Download
                </a>
              } @else {
                <span class="shrink-0 font-sans text-caption text-slate">Storage not configured</span>
              }
            </div>
          } @empty {
            @if (filesError()) {
              <sd-alert tone="error">{{ filesError() }}</sd-alert>
            } @else {
              <p class="font-sans text-body-sm text-slate">No files.</p>
            }
          }
        }
      </div>
    </sd-dialog>
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
  /** Per-tab load failure, shown in place of that tab's empty state. */
  protected readonly tabErrors = signal<Partial<Record<TabKey, string>>>({});

  protected readonly consultations = signal<MonitoringConsultationRow[]>([]);
  protected readonly consultationsPage = signal(1);
  protected readonly consultationsHasMore = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly moreError = signal('');
  protected readonly quality = signal<MonitoringQualityDto | null>(null);
  protected readonly recordings = signal<RecordingDto[]>([]);

  // Files modal
  protected readonly filesOpen = signal(false);
  protected readonly filesLoading = signal(false);
  protected readonly filesError = signal('');
  protected readonly files = signal<RecordingFileDto[]>([]);

  ngOnInit(): void {
    this.select('consultations');
  }

  protected openFiles(r: RecordingDto): void {
    this.filesOpen.set(true);
    this.filesLoading.set(true);
    this.filesError.set('');
    this.files.set([]);
    this.api
      .recordingFiles(r.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.files.set(res.data.files);
          this.filesLoading.set(false);
        },
        error: (err: unknown) => {
          this.filesError.set(apiErrorMessage(err, 'Could not load the recording files.'));
          this.filesLoading.set(false);
        },
      });
  }

  protected select(tab: TabKey): void {
    this.tab.set(tab);
    if (this.loaded.has(tab)) return;
    this.loaded.add(tab);
    this.loading.set(true);
    this.setTabError(tab, '');
    const done = () => this.loading.set(false);
    const fail = (fallback: string) => (err: unknown) => {
      // Forget the tab so re-selecting it (or Retry) fetches again.
      this.loaded.delete(tab);
      this.setTabError(tab, apiErrorMessage(err, fallback));
      done();
    };
    if (tab === 'consultations') {
      this.consultationsPage.set(1);
      this.moreError.set('');
      this.api.consultations({ page: 1, per_page: 25 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.consultations.set(r.data); this.consultationsHasMore.set(r.meta.page < r.meta.total_pages); done(); },
        error: fail('Could not load consultations.'),
      });
    } else if (tab === 'quality') {
      this.api.quality().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.quality.set(r.data); done(); }, error: fail('Could not load call-quality data.') });
    } else {
      this.api.recordings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.recordings.set(r.data); done(); }, error: fail('Could not load recordings.') });
    }
  }

  private setTabError(tab: TabKey, message: string): void {
    this.tabErrors.update((errs) => ({ ...errs, [tab]: message }));
  }

  protected loadMoreConsultations(): void {
    if (this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreError.set('');
    const next = this.consultationsPage() + 1;
    this.api.consultations({ page: next, per_page: 25 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.consultations.update((list) => [...list, ...r.data]);
        this.consultationsPage.set(r.meta.page);
        this.consultationsHasMore.set(r.meta.page < r.meta.total_pages);
        this.loadingMore.set(false);
      },
      error: (err: unknown) => {
        this.moreError.set(apiErrorMessage(err, 'Could not load more consultations.'));
        this.loadingMore.set(false);
      },
    });
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
    return appointmentStatusClass(status);
  }
  protected recStatusClass(status: string): string {
    const map: Record<string, string> = { recording: 'bg-alert/10 text-alert-ink', stopped: 'bg-frost text-cerulean-dark', failed: 'bg-cloud text-slate' };
    return map[status] ?? 'bg-cloud text-slate';
  }
}
