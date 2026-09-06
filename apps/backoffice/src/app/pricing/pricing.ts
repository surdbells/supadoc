import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { apiErrorMessage, SettingsApi } from '@supadoc/data-access';
import { IconComponent } from '@supadoc/ui';

/** Pricing settings (route `/pricing`) — currency + guest/platform fees. */
@Component({
  selector: 'bo-pricing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-col gap-1">
        <h1 class="font-heading text-h3 text-ink">Pricing</h1>
        <p class="font-sans text-body text-slate">Platform-wide currency and fees.</p>
      </header>

      @if (loading()) {
        <div class="sd-shimmer h-48 rounded-card"></div>
      } @else {
        <div class="flex max-w-md flex-col gap-4 rounded-card border border-cloud bg-white p-6">
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Currency</span>
            <input [value]="currency()" (input)="currency.set($any($event.target).value.toUpperCase())" maxlength="3" placeholder="NGN" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm uppercase text-ink focus:border-cerulean focus:outline-none" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Guest fee (per invited guest)</span>
            <input type="number" min="0" step="500" [value]="guestFee()" (input)="guestFee.set($any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
          </label>
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Platform fee</span>
            <input type="number" min="0" step="100" [value]="platformFee()" (input)="platformFee.set($any($event.target).value)" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" />
          </label>

          @if (notice()) {
            <p class="rounded-field px-4 py-2 font-label text-caption" [class]="noticeOk() ? 'bg-sage/10 text-sage' : 'bg-alert/10 text-alert'">{{ notice() }}</p>
          }

          <button type="button" class="flex w-fit items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="saving()" (click)="save()">
            <sd-icon name="check" [size]="18" />{{ saving() ? 'Saving…' : 'Save pricing' }}
          </button>
        </div>
      }
    </div>
  `,
})
export class AdminPricing implements OnInit {
  private readonly api = inject(SettingsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly notice = signal('');
  protected readonly noticeOk = signal(false);

  protected readonly currency = signal('NGN');
  protected readonly guestFee = signal('0');
  protected readonly platformFee = signal('0');

  ngOnInit(): void {
    this.api
      .getPricing()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.currency.set(res.data.currency ?? 'NGN');
          this.guestFee.set(String(res.data.guest_fee ?? 0));
          this.platformFee.set(String(res.data.platform_fee ?? 0));
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  protected save(): void {
    this.saving.set(true);
    this.notice.set('');
    this.api
      .updatePricing({
        currency: this.currency().trim() || 'NGN',
        guest_fee: this.guestFee(),
        platform_fee: this.platformFee(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.currency.set(res.data.currency ?? this.currency());
          this.guestFee.set(String(res.data.guest_fee ?? this.guestFee()));
          this.platformFee.set(String(res.data.platform_fee ?? this.platformFee()));
          this.noticeOk.set(true);
          this.notice.set('Pricing updated.');
          this.saving.set(false);
        },
        error: (err) => {
          this.noticeOk.set(false);
          this.notice.set(apiErrorMessage(err, 'Could not update pricing.'));
          this.saving.set(false);
        },
      });
  }
}
