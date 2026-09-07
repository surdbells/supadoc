import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IconComponent } from '../icon/icon';

/**
 * Structural shape of a thread message — matches `MessageDto` from
 * `@supadoc/models` so callers pass their DTOs directly, without this leaf UI
 * lib taking a dependency on the models package.
 */
export interface ThreadMessage {
  readonly id: string;
  readonly sender_role: 'patient' | 'doctor';
  readonly sender_name: string;
  readonly body: string;
  readonly created_at: string;
}

/**
 * A secure two-party chat thread (patient ↔ doctor), reused by both portals.
 * The viewer's own messages sit on the right; the counterpart's on the left.
 * Emits `send` with the trimmed body; the host clears state by updating the
 * `messages` / `sending` inputs.
 */
@Component({
  selector: 'sd-message-thread',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex h-full flex-col">
      <div #scroll class="flex-1 space-y-3 overflow-y-auto px-1 py-2">
        @for (m of messages(); track m.id) {
          @if (mine(m)) {
            <div class="flex justify-end">
              <div class="max-w-[80%] rounded-2xl rounded-br-sm bg-cerulean px-4 py-2.5 text-white">
                <p class="whitespace-pre-wrap break-words font-sans text-body-sm">{{ m.body }}</p>
                <p class="mt-1 text-right font-sans text-[11px] text-white/70">{{ when(m.created_at) }}</p>
              </div>
            </div>
          } @else {
            <div class="flex justify-start">
              <div class="max-w-[80%] rounded-2xl rounded-bl-sm border border-cloud bg-white px-4 py-2.5">
                <p class="font-sans text-[11px] font-semibold text-cerulean">{{ m.sender_name }}</p>
                <p class="mt-0.5 whitespace-pre-wrap break-words font-sans text-body-sm text-ink">{{ m.body }}</p>
                <p class="mt-1 font-sans text-[11px] text-slate">{{ when(m.created_at) }}</p>
              </div>
            </div>
          }
        } @empty {
          @if (!loading()) {
            <div class="flex flex-col items-center gap-3 py-16 text-center">
              <span class="flex size-14 items-center justify-center rounded-full bg-frost/60 text-cerulean ring-8 ring-frost/30">
                <sd-icon name="message-square" [size]="24" />
              </span>
              <p class="max-w-xs font-sans text-body-sm text-slate">{{ emptyText() }}</p>
            </div>
          }
        }
        @if (loading()) {
          <p class="py-8 text-center font-sans text-body-sm text-slate">Loading messages…</p>
        }
      </div>

      @if (!readOnly()) {
        <form class="mt-3 flex items-end gap-2 border-t border-cloud pt-3" (submit)="submit($event)">
          <textarea
            [value]="draft()"
            (input)="draft.set($any($event.target).value)"
            (keydown)="onKeydown($event)"
            rows="1"
            [attr.maxlength]="5000"
            [placeholder]="placeholder()"
            class="max-h-32 min-h-11 flex-1 resize-y rounded-field border border-cloud bg-white px-4 py-2.5 font-sans text-body-sm text-ink outline-none transition-colors placeholder:text-slate focus:border-cerulean"
          ></textarea>
          <button
            type="submit"
            class="flex size-11 shrink-0 items-center justify-center rounded-field bg-cerulean text-white transition-colors hover:bg-ocean disabled:opacity-50"
            [disabled]="sending() || draft().trim().length === 0"
            aria-label="Send message"
          >
            <sd-icon [name]="sending() ? 'loader-circle' : 'send'" [size]="18" [class.animate-spin]="sending()" />
          </button>
        </form>
      }
    </div>
  `,
})
export class MessageThreadComponent {
  readonly messages = input<readonly ThreadMessage[]>([]);
  /** Which side the viewer is — their own messages align right. */
  readonly viewerRole = input<'patient' | 'doctor'>('patient');
  readonly loading = input(false);
  readonly sending = input(false);
  readonly readOnly = input(false);
  readonly placeholder = input('Write a message…');
  readonly emptyText = input('No messages yet. Start the conversation.');

  readonly send = output<string>();

  protected readonly draft = signal('');
  private readonly scroll = viewChild<ElementRef<HTMLElement>>('scroll');

  constructor() {
    // Keep the viewport pinned to the newest message as the thread grows.
    effect(() => {
      this.messages();
      const el = this.scroll()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected mine(m: ThreadMessage): boolean {
    return m.sender_role === this.viewerRole();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const body = this.draft().trim();
    if (body.length === 0 || this.sending()) return;
    this.send.emit(body);
    this.draft.set('');
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submit(event);
    }
  }

  protected when(iso: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }
}
