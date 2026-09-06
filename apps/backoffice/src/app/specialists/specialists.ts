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
import type { SpecialistAdminDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

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
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Specialists</h1>
        <p class="font-sans text-body text-slate">Edit contact email, fee and availability.</p>
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
  `,
})
export class AdminSpecialists implements OnInit {
  private readonly api = inject(SpecialistsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  protected readonly specialists = signal<Row[]>([]);

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

  protected photoSrc(url: string): string | null {
    return this.api.assetUrl(url.trim() || null);
  }
  protected initials(name: string): string {
    return name.replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
}
