import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { DETAIL_AVATAR } from '../shared/layout';
import { initials } from './specialist-ui';

export type AvatarSize = 'md' | 'lg' | 'xl';

const SIZE: Record<AvatarSize, string> = {
  md: 'size-12 text-body-sm',
  lg: 'size-16 text-h5',
  xl: 'size-20 text-h4 sm:size-24 sm:text-h3',
};

/** List-size initials (doctor Patients list: frost chip, semibold). */
const INITIALS = 'flex shrink-0 items-center justify-center rounded-full bg-frost font-heading font-semibold text-cerulean ';

/**
 * A doctor's photo, or their initials when there is none — or when the image
 * can't be loaded (a removed file, an old link), so a row never shows a broken
 * image. Decorative (`alt=""`): the doctor's name is always next to it.
 * `xl` (detail headers, the photo picker) uses the detail-header avatar, as the
 * patient / appointment detail headers and the doctor portal's profile photo do.
 *
 * `<bo-specialist-avatar [src]="api.assetUrl(s.photo_url)" [name]="s.name" size="md" />`
 */
@Component({
  selector: 'bo-specialist-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    @if (showImage()) {
      <img [src]="src()" alt="" [class]="'shrink-0 rounded-full border border-cloud bg-white object-cover ' + sizeClass()" (error)="failed.set(src())" />
    } @else {
      <span [class]="initialsClass()" aria-hidden="true">{{ letters() }}</span>
    }
  `,
})
export class SpecialistAvatar {
  /** Absolute image URL (see `SpecialistsApi.assetUrl`), or null. */
  readonly src = input<string | null>(null);
  readonly name = input('');
  readonly size = input<AvatarSize>('md');

  /** The URL that failed to load (a new one is tried again). */
  protected readonly failed = signal<string | null>(null);

  protected readonly showImage = computed(() => {
    const src = this.src();
    return !!src && this.failed() !== src;
  });
  protected readonly sizeClass = computed(() => SIZE[this.size()]);
  protected readonly initialsClass = computed(() =>
    this.size() === 'xl' ? DETAIL_AVATAR : INITIALS + this.sizeClass(),
  );
  protected readonly letters = computed(() => initials(this.name()) || 'DR');
}
