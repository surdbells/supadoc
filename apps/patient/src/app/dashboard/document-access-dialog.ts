import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage, DocumentsApi } from '@supadoc/data-access';
import type {
  DocumentAccessDetailDto,
  DocumentGrantDto,
  DocumentShareResultDto,
  MedicalDocumentDto,
} from '@supadoc/models';
import { DialogComponent, DialogService, IconComponent } from '@supadoc/ui';
import {
  dateTimeLabel,
  drName,
  historyRows,
  initials,
  isSharingUnavailable,
  lastOpenedLabel,
  possessive,
  shareResultLine,
  SHARING_UNAVAILABLE,
  untilLabel,
} from './document-sharing';
import { ShareDialog } from './share-dialog';

type AccessDoctor = DocumentAccessDetailDto['doctors'][number];

/**
 * "Who can see this document": every doctor who can open it now (paused ones
 * too) with how and until when, Remove access per doctor, the folder-share
 * holders it is hidden from (Show again), Share with another doctor, and its
 * recent sharing activity. Opened from a row's access button on Medical
 * Documents.
 */
@Component({
  selector: 'pat-document-access-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogComponent, IconComponent, ShareDialog],
  template: `
    <sd-dialog
      [open]="open()"
      layout="plain"
      size="md"
      labelledBy="doc-access-title"
      describedBy="doc-access-sub"
      [busy]="busy()"
      (closed)="close()"
      (afterClose)="closed.emit()"
    >
      <div class="flex flex-col gap-5 p-5 sm:p-6" [attr.aria-busy]="busy() || loading() || null">
        <p class="sr-only" aria-live="polite" aria-atomic="true">{{ live() }}</p>
        <div class="flex items-start justify-between gap-3 border-b border-cloud pb-4">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 id="doc-access-title" tabindex="-1" data-autofocus class="font-heading text-h5 text-ink outline-none">Who can see this document</h2>
            <p id="doc-access-sub" class="truncate font-sans text-body-sm text-slate" [title]="document().title">{{ document().title }}</p>
          </div>
          <button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-slate transition-colors hover:text-ink" aria-label="Close" [disabled]="busy()" (click)="close()">
            <sd-icon name="x" [size]="22" />
          </button>
        </div>

        @if (loading() && !detail()) {
          @for (i of [1, 2]; track i) { <div class="sd-shimmer h-16 rounded-card"></div> }
        } @else if (unavailable()) {
          <p class="flex items-start gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate" role="status">
            <sd-icon name="lock" [size]="18" class="mt-0.5 shrink-0" />{{ unavailableText }}
          </p>
        } @else if (loadError() && !detail()) {
          <p class="flex items-start gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink" role="alert">
            <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ loadError() }}
          </p>
          <button type="button" class="min-h-11 w-fit rounded-field border border-haze bg-white px-5 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean" (click)="load()">Try again</button>
        } @else if (detail(); as d) {
          @if (notice()) {
            <!-- Announced once, by the dialog's live region above (no second role="status" here). -->
            <p class="flex items-start gap-2 rounded-field bg-sage/15 px-4 py-3 font-sans text-body-sm text-sage-ink">
              <sd-icon name="circle-check" [size]="18" class="mt-0.5 shrink-0" />{{ notice() }}
            </p>
          }
          @if (actionError()) {
            <p class="flex items-start gap-2 rounded-field bg-alert/10 px-4 py-3 font-sans text-body-sm text-alert-ink" role="alert">
              <sd-icon name="triangle-alert" [size]="18" class="mt-0.5 shrink-0" />{{ actionError() }}
            </p>
          }

          @if (d.doctors.length > 0) {
            <ul class="flex flex-col gap-3" aria-label="Doctors who can see this document">
              @for (doc of d.doctors; track doc.specialist_id) {
                <li class="flex flex-col gap-3 rounded-card border border-cloud p-4 sm:flex-row sm:items-start">
                  <div class="flex min-w-0 flex-1 items-start gap-3">
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-frost font-sans text-caption font-semibold text-cerulean-dark" aria-hidden="true">{{ initialsOf(doc.specialist.name) }}</span>
                    <span class="flex min-w-0 flex-col gap-0.5">
                      <span class="font-sans text-body-sm font-semibold text-ink">{{ dr(doc.specialist.name) }}</span>
                      @if (doc.specialist.specialty) {
                        <span class="font-sans text-caption text-slate">{{ doc.specialist.specialty }}</span>
                      }
                      <span class="font-sans text-caption text-ink">{{ accessLine(doc) }}</span>
                      <span class="font-sans text-caption text-slate">{{ opened(doc.last_viewed_at) }}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    class="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-field border border-alert px-4 font-sans text-body-sm font-semibold text-alert-ink transition-colors hover:bg-alert/5 disabled:opacity-60"
                    [attr.aria-label]="'Remove ' + possessiveOf(doc.specialist.name) + ' access to ' + document().title"
                    [disabled]="busy()"
                    (click)="remove(doc)"
                  >
                    <sd-icon name="user-x" [size]="16" />Remove
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="flex items-center gap-2 rounded-field bg-glacier px-4 py-3 font-sans text-body-sm text-slate">
              <sd-icon name="lock" [size]="18" class="shrink-0" />Only you can see this document.
            </p>
          }

          @if (d.hidden_from.length > 0) {
            <ul class="flex flex-col gap-2" aria-label="Hidden from whole-folder access">
              @for (h of d.hidden_from; track h.specialist.id) {
                <li class="flex flex-col gap-2 rounded-card border border-cloud p-4 sm:flex-row sm:items-center sm:justify-between">
                  <span class="flex items-start gap-2 font-sans text-body-sm text-slate">
                    <sd-icon name="eye-off" [size]="18" class="mt-0.5 shrink-0" />Hidden from {{ possessiveOf(h.specialist.name) }} whole-folder access
                  </span>
                  <button type="button" class="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-field border border-haze bg-white px-4 font-sans text-body-sm font-semibold text-cerulean shadow-control transition hover:border-cerulean disabled:opacity-60" [disabled]="busy()" (click)="showAgain(h.specialist.id, h.specialist.name)">
                    <sd-icon name="eye" [size]="16" />Show again
                  </button>
                </li>
              }
            </ul>
          }

          <div class="flex flex-col gap-1.5">
            <button
              type="button"
              class="inline-flex min-h-11 w-fit items-center gap-2 rounded-field bg-cerulean px-5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60"
              [disabled]="d.eligible_doctors.length === 0 || busy()"
              [attr.aria-describedby]="d.eligible_doctors.length === 0 ? 'doc-access-none' : null"
              (click)="sharing.set(true)"
            >
              <sd-icon name="user-plus" [size]="18" />Share with another doctor
            </button>
            @if (d.eligible_doctors.length === 0) {
              <p id="doc-access-none" class="font-sans text-caption text-slate">You can share with doctors you've booked.</p>
            }
          </div>

          @if (rows().length > 0) {
            <div class="flex flex-col gap-2 border-t border-cloud pt-4">
              <button type="button" class="inline-flex min-h-11 w-fit items-center gap-1.5 font-sans text-body-sm font-semibold text-ink" aria-controls="doc-access-activity" [attr.aria-expanded]="activityOpen()" (click)="activityOpen.set(!activityOpen())">
                <sd-icon name="history" [size]="16" class="text-slate" />Recent activity
                <sd-icon name="chevron-down" [size]="16" class="text-slate" [class.rotate-180]="activityOpen()" />
              </button>
              @if (activityOpen()) {
                <ul id="doc-access-activity" class="flex flex-col gap-2">
                  @for (r of rows(); track r.key) {
                    <li class="flex items-start gap-2 font-sans text-caption">
                      <sd-icon [name]="r.icon" [size]="14" class="mt-0.5 shrink-0 text-slate" />
                      <span class="flex min-w-0 flex-col">
                        <span class="text-ink">{{ r.text }}</span>
                        <span class="text-slate">{{ when(r.at) }}</span>
                      </span>
                    </li>
                  }
                </ul>
              }
            </div>
          }
        }
      </div>
    </sd-dialog>

    @if (sharing()) {
      <pat-share-dialog
        [preselectDocumentIds]="[document().id]"
        initialScope="selected"
        surface="document_access"
        (done)="shared($event)"
        (closed)="sharing.set(false)"
      />
    }
  `,
})
export class DocumentAccessDialog implements OnInit {
  private readonly documentsApi = inject(DocumentsApi);
  private readonly dialogs = inject(DialogService);
  private readonly destroyRef = inject(DestroyRef);

  readonly document = input.required<MedicalDocumentDto>();
  /** Who can see it changed: the host refreshes its chips. */
  readonly changed = output<void>();
  readonly closed = output<void>();

  protected readonly unavailableText = SHARING_UNAVAILABLE;
  protected readonly open = signal(true);
  protected readonly busy = signal(false);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly unavailable = signal(false);
  protected readonly actionError = signal('');
  protected readonly notice = signal('');
  protected readonly live = signal('');
  protected readonly detail = signal<DocumentAccessDetailDto | null>(null);
  protected readonly sharing = signal(false);
  protected readonly activityOpen = signal(false);
  protected readonly rows = computed(() => historyRows(this.detail()?.history ?? []));

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    this.documentsApi
      .access(this.document().id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.detail.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.loading.set(false);
          if (isSharingUnavailable(err)) this.unavailable.set(true);
          else this.loadError.set(apiErrorMessage(err, 'Could not load who can see this document.'));
        },
      });
  }

  protected close(): void {
    if (!this.busy()) this.open.set(false);
  }

  protected async remove(d: AccessDoctor): Promise<void> {
    const doctor = drName(d.specialist.name);
    const title = this.document().title;
    this.actionError.set('');
    this.notice.set('');
    const { confirmed } = await this.dialogs.confirm({
      tone: 'danger',
      icon: 'user-x',
      title: `Remove ${possessive(doctor)} access to this document?`,
      message: `They won't be able to open "${title}" any more, even through your whole-folder share. Everything else you share with them stays as it is. Copies they've already downloaded aren't affected.`,
      confirmLabel: 'Remove access',
      cancelLabel: 'Keep access',
      action: async () => {
        const res = await firstValueFrom(this.documentsApi.removeDoctorAccess(this.document().id, d.specialist_id));
        this.detail.set(res.data);
      },
      errorMessage: (err) =>
        isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not remove access. Please try again.'),
    });
    if (!confirmed) return;
    this.say('Access removed.');
    this.changed.emit();
  }

  protected showAgain(specialistId: string, name: string): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    this.notice.set('');
    this.documentsApi
      .unhideForDoctor(this.document().id, specialistId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          this.detail.set(res.data);
          this.say(`${drName(name)} can see this document again.`);
          this.changed.emit();
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.actionError.set(
            isSharingUnavailable(err) ? SHARING_UNAVAILABLE : apiErrorMessage(err, 'Could not show it again. Please try again.'),
          );
        },
      });
  }

  protected shared(result: DocumentShareResultDto | DocumentGrantDto): void {
    this.say('outcomes' in result ? shareResultLine(result) : 'Changes saved.');
    this.changed.emit();
    this.load();
  }

  /** Shown in the success line and announced once (the live region; the line has no role). */
  private say(text: string): void {
    this.notice.set(text);
    // The same words twice in a row would not be read again: clear first.
    this.live.set('');
    setTimeout(() => this.live.set(text));
  }

  protected accessLine(d: AccessDoctor): string {
    const how = d.via === 'folder' ? 'Can see your whole folder' : 'Shared individually';
    const until = untilLabel(d.until_label_at, d.indefinite);
    const parts = [how, until ? (d.indefinite ? 'No end date' : until) : ''];
    if (d.paused) parts.push('Paused — not practising on VideoMed right now');
    return parts.filter(Boolean).join(' · ');
  }

  protected opened(iso: string | null): string {
    return lastOpenedLabel(iso, true);
  }
  protected when(iso: string): string {
    return dateTimeLabel(iso);
  }
  protected dr(name: string): string {
    return drName(name);
  }
  protected possessiveOf(name: string): string {
    return possessive(drName(name));
  }
  protected initialsOf(name: string): string {
    return initials(name);
  }
}
