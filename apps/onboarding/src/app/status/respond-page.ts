import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ApplicationDocumentSlot, ApplicationInfoRequestItem, ApplicationSectionKey } from '@supadoc/models';
import { AlertComponent, IconComponent } from '@supadoc/ui';
import { OnbIndemnityStep } from '../apply/indemnity-step';
import { OnbLicenceStep } from '../apply/licence-step';
import { OnbPersonalStep } from '../apply/personal-step';
import { OnbProfessionalStep } from '../apply/professional-step';
import { OnbQualificationsStep } from '../apply/qualifications-step';
import { Announcer } from '../core/announcer';
import { slotCopy } from '../core/documents';
import { bannerMessage, errorStatus } from '../core/errors';
import { InfoResponseStore } from '../core/info-response.store';
import { NOTICE, Notices } from '../core/notices';
import { documentInSlot } from '../core/step-source';
import { TrackStore } from '../core/track.store';
import { stepTitle } from '../core/wizard-steps';
import { FileFieldComponent } from '../shared/file-field';
import { SlotUploads, UPLOAD_REQUIRED } from '../shared/form-state';
import { ReviewSectionComponent } from '../shared/review-section';
import { StepShellComponent } from '../shared/step-shell';
import { ONB_WIDTH, onbButton, onbTextarea } from '../shared/ui-classes';

export const RESPOND_SUBTITLE = 'Our team asked for the items below. Your review resumes as soon as you send them.';
const NOTE_MAX = 1000;

/**
 * /status/respond (spec §6.5.14, built from Figma parts): the requested
 * sections open as the same step forms in info mode, the requested documents
 * as upload fields; "Send to VideoMed" sends the reply.
 */
@Component({
  selector: 'onb-respond-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [InfoResponseStore],
  imports: [
    AlertComponent,
    FileFieldComponent,
    IconComponent,
    OnbIndemnityStep,
    OnbLicenceStep,
    OnbPersonalStep,
    OnbProfessionalStep,
    OnbQualificationsStep,
    ReviewSectionComponent,
    StepShellComponent,
  ],
  template: `
    <onb-step-shell heading="Send requested items" [subtitle]="subtitle" (back)="back()">
      @if (loading()) {
        <div class="mt-10 flex flex-col gap-4" aria-busy="true" aria-label="Loading the request">
          @for (i of [1, 2, 3]; track i) {
            <div class="sd-shimmer h-16 rounded-card"></div>
          }
        </div>
      } @else if (loadError()) {
        <sd-alert tone="error" class="mt-8">
          {{ loadError() }}
          <button type="button" class="ml-1 font-medium underline underline-offset-2" (click)="load()">Try again</button>
        </sd-alert>
      } @else if (!request()) {
        <sd-alert tone="info" class="mt-8">There's nothing to send right now. Your status page shows where your application is.</sd-alert>
      } @else {
        <div class="mt-8 whitespace-pre-line rounded-field bg-snow p-4 font-sans text-body-sm text-ink min-[900px]:mt-10">{{ request()?.message }}</div>

        <div class="mt-6 flex flex-col gap-6">
          @for (key of info.requestedSections(); track key) {
            <onb-review-section
              [sectionId]="'respond-' + key"
              [title]="title(key)"
              [editText]="open() === key ? 'Close' : 'Edit'"
              [editLabel]="(open() === key ? 'Close ' : 'Edit ') + title(key)"
              [expanded]="open() === key"
              [icon]="info.sectionUpdated(key) ? 'circle-check-big' : 'circle'"
              [iconClass]="info.sectionUpdated(key) ? 'text-sage' : 'text-slate'"
              (edit)="toggle(key)"
            >
              @if (info.sectionUpdated(key)) {
                <span sectionTag class="inline-flex h-6 items-center rounded-pill bg-sage/10 px-2.5 font-sans text-caption text-sage-ink">Updated</span>
              }
              @if (open() === key) {
                <div class="border-t-[0.5px] border-ash pb-4 pt-2" [id]="'onb-respond-' + key">
                  @switch (key) {
                    @case ('personal') {
                      <onb-personal-step mode="info" (saved)="onSaved(key)" />
                    }
                    @case ('professional') {
                      <onb-professional-step mode="info" (saved)="onSaved(key)" />
                    }
                    @case ('licence') {
                      <onb-licence-step mode="info" (saved)="onSaved(key)" />
                    }
                    @case ('qualifications') {
                      <onb-qualifications-step mode="info" (saved)="onSaved(key)" />
                    }
                    @case ('indemnity') {
                      <onb-indemnity-step mode="info" (saved)="onSaved(key)" />
                    }
                  }
                </div>
              }
            </onb-review-section>
          }

          @for (item of info.requestedSlots(); track item.key + item.label) {
            <onb-file-field
              [inputId]="slotId(item)"
              [label]="slotLabel(item)"
              [hint]="slotHint(item)"
              [required]="true"
              [document]="docFor(item)"
              [progress]="uploads.progressOf(slotKey(item))"
              [error]="uploads.errorOf(slotKey(item))"
              [removable]="removable(item)"
              (pick)="uploads.pick($any(item.key), $event, item.key === 'additional' ? item.label : null)"
              (remove)="remove(item)"
              (view)="view(item)"
            />
          }

          <div class="flex flex-col">
            <label for="onb-response-note" class="font-sans text-body-sm text-ink">Anything you'd like to tell us? <span class="text-slate">(Optional)</span></label>
            <textarea
              id="onb-response-note"
              rows="3"
              class="mt-1"
              [class]="noteClass"
              [attr.maxlength]="noteMax"
              aria-describedby="onb-response-note-hint"
              [value]="note()"
              (input)="note.set($any($event.target).value)"
            ></textarea>
            <p id="onb-response-note-hint" class="mt-1 font-label text-caption text-slate">{{ note().length }}/{{ noteMax }}</p>
          </div>
        </div>

        @if (banner()) {
          <sd-alert tone="error" class="mt-6">{{ banner() }}</sd-alert>
        }
        @if (missingText()) {
          <p role="alert" class="mt-4 font-label text-caption text-alert">{{ missingText() }}</p>
        }

        <div class="mt-10 flex justify-center min-[900px]:mt-14">
          <button
            type="button"
            [class]="sendClass()"
            [attr.aria-disabled]="!allUpdated() || null"
            [attr.aria-busy]="busy() || null"
            (click)="send()"
          >
            @if (busy()) {
              <sd-icon name="loader-circle" [size]="20" class="animate-spin" />
            }
            Send to VideoMed
            <sd-icon name="send" [size]="20" [strokeWidth]="1.5" />
          </button>
        </div>
      }
    </onb-step-shell>
  `,
})
export class OnbRespondPage {
  protected readonly info = inject(InfoResponseStore);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);
  private readonly announcer = inject(Announcer);
  private readonly track = inject(TrackStore);

  protected readonly subtitle = RESPOND_SUBTITLE;
  protected readonly noteMax = NOTE_MAX;
  protected readonly noteClass = onbTextarea(false);
  protected readonly uploads = new SlotUploads(() => this.info);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly banner = signal<string | null>(null);
  protected readonly missingText = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly open = signal<ApplicationSectionKey | null>(null);
  protected readonly note = signal('');
  protected readonly request = computed(() =>
    this.info.application()?.status === 'more_info_needed' ? this.info.request() : null,
  );

  /** Every requested section saved and every requested document uploaded since the request. */
  protected readonly pending = computed(() => {
    const sections = this.info.requestedSections().filter((k) => !this.info.sectionUpdated(k));
    const slots = this.info.requestedSlots().filter((item) => {
      const doc = this.docFor(item);
      return !doc || !this.info.uploadedForRequest(doc);
    });
    return { sections, slots };
  });
  protected readonly allUpdated = computed(() => {
    const p = this.pending();
    return p.sections.length === 0 && p.slots.length === 0;
  });
  protected readonly sendClass = computed(() => `${onbButton('primary', !this.allUpdated())} ${ONB_WIDTH[250]}`);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      await this.info.load();
    } catch (err) {
      if (errorStatus(err) === 401) return this.toTrack();
      this.loadError.set(bannerMessage(err, "We couldn't load what our team asked for."));
    } finally {
      this.loading.set(false);
    }
  }

  protected title(key: ApplicationSectionKey): string {
    if (key === 'personal') return 'Personal Details';
    if (key === 'professional') return 'Professional Details';
    return stepTitle(key, this.info.route());
  }

  protected toggle(key: ApplicationSectionKey): void {
    this.open.update((k) => (k === key ? null : key));
  }

  protected onSaved(key: ApplicationSectionKey): void {
    this.open.set(null);
    this.missingText.set(null);
    this.announcer.announce(`${this.title(key)} updated.`);
    setTimeout(() => document.querySelector<HTMLElement>(`#respond-${key}-heading`)?.parentElement?.querySelector('button')?.focus());
  }

  protected slotKey(item: ApplicationInfoRequestItem): string {
    return this.uploads.key(item.key as ApplicationDocumentSlot, item.label);
  }

  protected slotId(item: ApplicationInfoRequestItem): string {
    return `onb-slot-${this.slotKey(item).replace(/[^a-z0-9_-]/gi, '-')}`;
  }

  protected slotLabel(item: ApplicationInfoRequestItem): string {
    return item.key === 'additional' ? item.label : slotCopy(item.key as ApplicationDocumentSlot, this.info.route()).label;
  }

  protected slotHint(item: ApplicationInfoRequestItem): string | null {
    if (item.key === 'additional') return 'Requested by our team';
    const licence = this.info.sections()?.licence;
    return slotCopy(item.key as ApplicationDocumentSlot, this.info.route(), licence?.regulator_name ?? null).hint;
  }

  protected docFor(item: ApplicationInfoRequestItem) {
    return documentInSlot(this.info.documents(), item.key as ApplicationDocumentSlot, item.key === 'additional' ? item.label : null);
  }

  protected removable(item: ApplicationInfoRequestItem): boolean {
    const doc = this.docFor(item);
    return doc ? this.info.documentRemovable(doc) : false;
  }

  protected remove(item: ApplicationInfoRequestItem): void {
    const doc = this.docFor(item);
    if (doc) void this.uploads.remove(doc);
  }

  protected view(item: ApplicationInfoRequestItem): void {
    const doc = this.docFor(item);
    if (doc) this.info.viewDocument(doc);
  }

  protected back(): void {
    void this.router.navigateByUrl('/status');
  }

  protected async send(): Promise<void> {
    if (this.busy()) return;
    this.banner.set(null);
    if (!this.allUpdated()) {
      const p = this.pending();
      const names = [...p.sections.map((k) => this.title(k)), ...p.slots.map((s) => this.slotLabel(s))];
      this.missingText.set(`Update every item first: ${names.join(', ')}.`);
      for (const s of p.slots) this.uploads.setError(this.slotKey(s), UPLOAD_REQUIRED);
      const first = p.sections[0];
      const target = first ? document.querySelector<HTMLElement>(`#respond-${first}-heading`) : document.getElementById(this.slotId(p.slots[0]));
      target?.scrollIntoView?.({ block: 'center' });
      (first ? target?.parentElement?.querySelector<HTMLElement>('button') : target)?.focus();
      this.announcer.announce(`Update ${names.length} ${names.length === 1 ? 'item' : 'items'} to continue.`);
      return;
    }
    this.busy.set(true);
    try {
      await this.info.submit(this.note().trim() || null);
      this.notices.set('status', NOTICE.reviewResumed);
      await this.router.navigateByUrl('/status');
    } catch (err) {
      if (errorStatus(err) === 401) return this.toTrack();
      if (errorStatus(err) === 409) {
        // No longer waiting on the applicant (staff resumed the review, or it was decided): show where it stands.
        this.notices.set('status-info', bannerMessage(err, "This application isn't waiting for more information."));
        await this.router.navigateByUrl('/status');
        return;
      }
      this.banner.set(bannerMessage(err, "We couldn't send your reply. Please try again."));
    } finally {
      this.busy.set(false);
    }
  }

  private toTrack(): void {
    this.track.signOut();
    this.notices.set('track', NOTICE.trackSessionEnded);
    void this.router.navigateByUrl('/?dialog=track');
  }
}
