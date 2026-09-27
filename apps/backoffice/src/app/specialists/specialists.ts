import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, SpecialistsApi } from '@supadoc/data-access';
import type { CreateSpecialistParams, SpecialistAdminDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

interface Draft {
  name: string;
  specialty: string;
  email: string;
  consultation_fee: string;
  location: string;
  years_experience: string;
  bio: string;
  available: boolean;
  verified: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  specialty: '',
  email: '',
  consultation_fee: '',
  location: '',
  years_experience: '',
  bio: '',
  available: true,
  verified: false,
};

interface Row {
  id: string;
  name: string;
  specialty: string;
  email: string;
  consultation_fee: string;
  photo_url: string;
  available: boolean;
  verified: boolean;
  saving: boolean;
  saved: boolean;
  error: string;
}

/** Specialists management (route `/specialists`) — edit email, fee, availability. */
@Component({
  selector: 'bo-specialists',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Specialists</h1>
          <p class="font-sans text-body text-slate">Onboard new specialists, and edit contact email, fee and availability.</p>
        </div>
        <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-4 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="openCreate()">
          <sd-icon name="plus" [size]="18" />New specialist
        </button>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card"></div>
      } @else if (listError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ listError() }}</p>
        </div>
      } @else {
        <ul class="flex flex-col gap-3">
          @for (s of specialists(); track s.id) {
            <li class="flex flex-col gap-4 rounded-card border border-cloud bg-white p-5">
              <div class="flex items-center justify-between gap-3">
                <div class="flex flex-col">
                  <span class="font-heading text-body font-semibold text-ink">{{ s.name }}</span>
                  <span class="font-sans text-caption text-cerulean">{{ s.specialty }}</span>
                </div>
                <div class="flex items-center gap-3">
                  @if (s.saved) {
                    <span class="flex items-center gap-1 font-sans text-caption text-sage"><sd-icon name="circle-check" [size]="16" />Saved</span>
                  }
                  <button type="button" class="flex items-center gap-2 rounded-field bg-cerulean px-4 py-2 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="s.saving" (click)="save(s.id)">
                    {{ s.saving ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <label class="flex flex-col gap-1.5">
                  <span class="font-sans text-caption font-semibold text-slate">Contact email</span>
                  <input type="email" [value]="s.email" (input)="setField(s.id, 'email', $any($event.target).value)" placeholder="doctor@example.com" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
                </label>
                <label class="flex flex-col gap-1.5">
                  <span class="font-sans text-caption font-semibold text-slate">Consultation fee (₦)</span>
                  <input type="number" min="0" step="500" [value]="s.consultation_fee" (input)="setField(s.id, 'consultation_fee', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
                </label>
              </div>

              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Photo URL</span>
                <div class="flex items-center gap-3">
                  @if (photoSrc(s.photo_url); as src) {
                    <img [src]="src" [alt]="s.name" class="size-10 shrink-0 rounded-full border border-cloud object-cover" />
                  } @else {
                    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-cerulean/15 font-sans text-caption font-semibold text-cerulean">{{ initials(s.name) }}</span>
                  }
                  <input type="url" [value]="s.photo_url" (input)="setField(s.id, 'photo_url', $any($event.target).value)" placeholder="https://… or /uploads/…" class="w-full rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
                </div>
              </label>

              <div class="flex flex-wrap items-center gap-6">
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="size-4 accent-cerulean" [checked]="s.available" (change)="setField(s.id, 'available', $any($event.target).checked)" />
                  <span class="font-sans text-body-sm text-ink">Available for booking</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="size-4 accent-cerulean" [checked]="s.verified" (change)="setField(s.id, 'verified', $any($event.target).checked)" />
                  <span class="font-sans text-body-sm text-ink">Verified</span>
                </label>
              </div>

              @if (s.error) {
                <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ s.error }}</p>
              }
            </li>
          }
        </ul>
      }
    </div>

    @if (createOpen()) {
      <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="createOpen.set(false)"></button>
        <div class="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-[16px] bg-white p-6 shadow-[0_8px_40px_rgba(10,22,40,0.2)]">
          <div class="flex items-center justify-between">
            <h3 class="font-heading text-h5 text-ink">New specialist</h3>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="createOpen.set(false)"><sd-icon name="x" [size]="22" /></button>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Full name *</span>
              <input type="text" [value]="draft().name" (input)="setDraft('name', $any($event.target).value)" placeholder="Dr Jane Doe" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Speciality *</span>
              <input type="text" [value]="draft().specialty" (input)="setDraft('specialty', $any($event.target).value)" placeholder="Cardiology" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Contact email</span>
              <input type="email" [value]="draft().email" (input)="setDraft('email', $any($event.target).value)" placeholder="doctor@example.com" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Consultation fee (₦)</span>
              <input type="number" min="0" step="500" [value]="draft().consultation_fee" (input)="setDraft('consultation_fee', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Location</span>
              <input type="text" [value]="draft().location" (input)="setDraft('location', $any($event.target).value)" placeholder="Lagos, Nigeria" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Years of experience</span>
              <input type="number" min="0" [value]="draft().years_experience" (input)="setDraft('years_experience', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
            </label>
          </div>

          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Short bio</span>
            <textarea rows="3" [value]="draft().bio" (input)="setDraft('bio', $any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink placeholder:text-slate/60 focus:border-cerulean focus:outline-none"></textarea>
          </label>

          <div class="flex flex-wrap items-center gap-6">
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="draft().available" (change)="setDraft('available', $any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Available for booking</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="draft().verified" (change)="setDraft('verified', $any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Verified</span>
            </label>
          </div>

          @if (createError()) {
            <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ createError() }}</p>
          }

          <div class="flex justify-end gap-3">
            <button type="button" class="rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:bg-glacier" (click)="createOpen.set(false)">Cancel</button>
            <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="creating()" (click)="submitCreate()">{{ creating() ? 'Creating…' : 'Create specialist' }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class AdminSpecialists implements OnInit {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  protected readonly specialists = signal<Row[]>([]);

  // Onboarding modal
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createError = signal('');
  protected readonly draft = signal<Draft>({ ...EMPTY_DRAFT });

  ngOnInit(): void {
    this.api
      .listAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialists.set(res.data.map((s) => this.toRow(s)));
          this.loading.set(false);
        },
        error: () => {
          this.listError.set('Could not load specialists.');
          this.loading.set(false);
        },
      });
  }

  private toRow(s: SpecialistAdminDto): Row {
    return {
      id: s.id,
      name: s.name,
      specialty: s.specialty,
      email: s.email ?? '',
      consultation_fee: String(s.consultation_fee ?? ''),
      photo_url: s.photo_url ?? '',
      available: !!s.available,
      verified: !!s.verified,
      saving: false,
      saved: false,
      error: '',
    };
  }

  protected setField(id: string, key: 'email' | 'consultation_fee' | 'photo_url' | 'available' | 'verified', value: string | boolean): void {
    this.specialists.update((list) => list.map((s) => (s.id === id ? { ...s, [key]: value, saved: false, error: '' } : s)));
  }

  private patch(id: string, patch: Partial<Row>): void {
    this.specialists.update((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  protected save(id: string): void {
    const row = this.specialists().find((s) => s.id === id);
    if (!row) return;
    this.patch(id, { saving: true, error: '', saved: false });
    this.api
      .update(id, {
        email: row.email.trim(),
        consultation_fee: row.consultation_fee,
        photo_url: row.photo_url.trim(),
        available: row.available,
        verified: row.verified,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const d = res.data;
          this.patch(id, {
            saving: false,
            saved: true,
            email: d.email ?? row.email,
            consultation_fee: String(d.consultation_fee ?? row.consultation_fee),
            photo_url: d.photo_url ?? row.photo_url,
          });
        },
        error: (err) => this.patch(id, { saving: false, error: apiErrorMessage(err, 'Could not save.') }),
      });
  }

  protected openCreate(): void {
    this.draft.set({ ...EMPTY_DRAFT });
    this.createError.set('');
    this.createOpen.set(true);
  }

  protected setDraft(key: keyof Draft, value: string | boolean): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  protected submitCreate(): void {
    const d = this.draft();
    if (d.name.trim() === '' || d.specialty.trim() === '') {
      this.createError.set('Name and speciality are required.');
      return;
    }
    this.creating.set(true);
    this.createError.set('');
    const params: CreateSpecialistParams = {
      name: d.name.trim(),
      specialty: d.specialty.trim(),
      email: d.email.trim() || undefined,
      consultation_fee: d.consultation_fee.trim() || undefined,
      location: d.location.trim() || undefined,
      years_experience: d.years_experience.trim() || undefined,
      bio: d.bio.trim() || undefined,
      available: d.available,
      verified: d.verified,
    };
    this.api
      .createAdmin(params)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.specialists.update((list) => [this.toRow(res.data), ...list]);
          this.creating.set(false);
          this.createOpen.set(false);
        },
        error: (err) => {
          this.creating.set(false);
          this.createError.set(apiErrorMessage(err, 'Could not create the specialist.'));
        },
      });
  }

  protected photoSrc(url: string): string | null {
    return this.api.assetUrl(url.trim() || null);
  }
  protected initials(name: string): string {
    return name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
}
