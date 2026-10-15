import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { tap } from 'rxjs';
import type { HasUnsavedChanges } from '@supadoc/auth';
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, SpecialistsApi, StaffApi } from '@supadoc/data-access';
import type { SpecialistAdminDto, StaffUserDto } from '@supadoc/models';
import type { LeaveCopy } from '@supadoc/ui';
import { DialogComponent, DialogService, IconComponent } from '@supadoc/ui';
import { BTN_GHOST, BTN_PRIMARY } from '../specialists/specialist-ui';

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'staff', label: 'Staff' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'super_admin', label: 'Super admin' },
];

const PERMISSIONS = [
  { value: 'appointments.view', label: 'View appointments' },
  { value: 'appointments.create', label: 'Create appointments' },
  { value: 'appointments.book', label: 'Book appointments' },
  { value: 'appointments.update', label: 'Update appointments' },
  { value: 'specialists.manage', label: 'Manage specialists' },
  { value: 'settings.manage', label: 'Manage pricing/settings' },
  { value: 'monitoring.view', label: 'View monitoring' },
  { value: 'staff.manage', label: 'Manage staff' },
];

const FIELD =
  'w-full rounded-field border border-cloud bg-white px-4 py-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none focus:ring-2 focus:ring-cerulean/20';

/**
 * Staff & role management (route `/staff`, needs staff.manage). Closing the
 * editor (or leaving the page) with unsaved edits asks first; deactivating an
 * account and resetting a password confirm their consequences.
 */
@Component({
  selector: 'bo-staff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, DialogComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-heading text-h3 text-ink">Staff &amp; roles</h1>
          <p class="font-sans text-body text-slate">Manage staff accounts, roles and permissions.</p>
        </div>
        <button type="button" class="flex shrink-0 items-center gap-2 rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean" (click)="openCreate()">
          <sd-icon name="plus" [size]="18" />New staff
        </button>
      </header>

      @if (pageNotice()) {
        <div class="flex items-start gap-3 rounded-field bg-sage/10 px-4 py-3 font-sans text-body-sm text-sage">
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span>{{ pageNotice() }}</span>
            @if (devLink()) {
              <span class="break-all text-caption text-slate">Testing only — set-password link: <span class="select-all font-mono text-ink">{{ devLink() }}</span></span>
            }
          </span>
          <button type="button" class="shrink-0 text-sage/70 transition-colors hover:text-sage" aria-label="Dismiss" (click)="pageNotice.set(''); devLink.set('')"><sd-icon name="x" [size]="18" /></button>
        </div>
      }

      @if (loading()) {
        <div class="sd-shimmer h-40 rounded-card"></div>
      } @else if (listError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="wifi-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ listError() }}</p>
        </div>
      } @else {
        <div class="overflow-x-auto rounded-card border border-cloud bg-white">
          <table class="w-full min-w-[640px] text-left">
            <thead class="border-b border-cloud font-sans text-caption text-slate">
              <tr>
                <th class="px-4 py-3">Name</th>
                <th class="px-4 py-3">Email</th>
                <th class="px-4 py-3">Roles</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              @for (u of users(); track u.id) {
                <tr class="border-b border-cloud/60 font-sans text-body-sm text-ink">
                  <td class="px-4 py-3 font-medium">{{ u.first_name }} {{ u.last_name }}</td>
                  <td class="px-4 py-3 text-slate">{{ u.email }}</td>
                  <td class="px-4 py-3">
                    <span class="flex flex-wrap gap-1">
                      @for (r of u.roles; track r) {
                        <span class="rounded-pill bg-frost px-2 py-0.5 text-caption text-cerulean">{{ r }}</span>
                      } @empty { <span class="text-ash">—</span> }
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    <span class="flex flex-wrap gap-1">
                      <span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="u.active ? 'bg-sage/15 text-sage' : 'bg-cloud text-slate'">{{ u.active ? 'Active' : 'Inactive' }}</span>
                      @if (u.password_set === false) {
                        <span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="u.invite_pending ? 'bg-frost text-cerulean' : 'bg-warning/15 text-ink'">{{ u.invite_pending ? 'Invite sent' : 'Invite expired' }}</span>
                      }
                    </span>
                  </td>
                  <td class="px-4 py-3 text-right">
                    <button type="button" class="font-sans text-caption font-semibold text-cerulean hover:underline" (click)="openEdit(u)">Edit</button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="px-4 py-10 text-center font-sans text-body-sm text-slate">No staff accounts.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <sd-dialog
      [open]="editorOpen()"
      [title]="editing() ? 'Edit staff' : 'New staff'"
      [subtitle]="editorSubtitle()"
      size="md"
      [busy]="saving()"
      (closed)="close()"
    >
        <form id="bo-staff-form" class="flex flex-col gap-5" novalidate (submit)="$event.preventDefault(); save()">

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">First name</span>
              <input class="${FIELD}" [value]="firstName()" (input)="firstName.set($any($event.target).value)" />
            </label>
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Last name</span>
              <input class="${FIELD}" [value]="lastName()" (input)="lastName.set($any($event.target).value)" />
            </label>
          </div>
          <label class="flex flex-col gap-1.5">
            <span class="font-sans text-caption font-semibold text-slate">Email</span>
            <input type="email" class="${FIELD}" [value]="email()" (input)="email.set($any($event.target).value)" />
          </label>
          @if (!editing()) {
            @if (hasRole('doctor')) {
              <!-- Doctors choose their own password from an emailed link (preferred). -->
              <label class="flex cursor-pointer items-start gap-2">
                <input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-cerulean" [checked]="sendInvite()" (change)="sendInvite.set($any($event.target).checked)" />
                <span class="flex flex-col">
                  <span class="font-sans text-body-sm text-ink">Email an invite to set their own password</span>
                  <span class="font-sans text-caption text-slate">Recommended — no password changes hands. The link expires in 7 days.</span>
                </span>
              </label>
            }
            @if (!invitingDoctor()) {
              <label class="flex flex-col gap-1.5">
                <span class="font-sans text-caption font-semibold text-slate">Temporary password</span>
                <input type="password" autocomplete="new-password" class="${FIELD}" [value]="password()" (input)="password.set($any($event.target).value)" placeholder="At least 8 characters" />
              </label>
            }
          }

          <div class="flex flex-col gap-2">
            <span class="font-sans text-caption font-semibold text-slate">Roles</span>
            <div class="flex flex-wrap gap-2">
              @for (r of roleOptions(); track r.value) {
                <button type="button" class="rounded-field px-3 py-1.5 font-sans text-body-sm transition-colors" [class]="hasRole(r.value) ? 'bg-cerulean/10 text-cerulean' : 'bg-glacier text-slate hover:text-ink'" (click)="toggleRole(r.value)">
                  {{ r.label }}
                </button>
              }
            </div>
          </div>

          @if (hasRole('doctor')) {
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Linked specialist (for doctor login)</span>
              <select class="${FIELD}" [value]="specialistId()" (change)="specialistId.set($any($event.target).value)">
                <option value="">— None —</option>
                <!-- A specialist can belong to only one login. -->
                @for (s of specialists(); track s.id) {
                  <option [value]="s.id" [disabled]="!!s.login && s.login.id !== editing()?.id">{{ s.name }} · {{ s.specialty }}{{ s.login && s.login.id !== editing()?.id ? ' · already linked' : '' }}</option>
                }
              </select>
            </label>
          }

          <div class="flex flex-col gap-2">
            <span class="font-sans text-caption font-semibold text-slate">Permissions</span>
            <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              @for (p of permissionOptions; track p.value) {
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="size-4 accent-cerulean" [checked]="hasPerm(p.value)" (change)="togglePerm(p.value)" />
                  <span class="font-sans text-body-sm text-ink">{{ p.label }}</span>
                </label>
              }
            </div>
          </div>

          @if (editing()) {
            <label class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="size-4 accent-cerulean" [checked]="active()" (change)="active.set($any($event.target).checked)" />
              <span class="font-sans text-body-sm text-ink">Active</span>
            </label>
          }

          @if (formError()) {
            <p role="alert" class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ formError() }}</p>
          }
        </form>

        @if (editing()) {
          <div class="mt-5 flex flex-col gap-2 border-t border-cloud pt-4">
            <label for="bo-staff-reset" class="font-sans text-caption font-semibold text-slate">Reset password</label>
            <div class="flex flex-wrap items-center gap-2">
              <input id="bo-staff-reset" type="password" autocomplete="new-password" class="${FIELD} sm:max-w-xs" [value]="resetPw()" (input)="resetPw.set($any($event.target).value)" placeholder="New password (8+ chars)" />
              <button type="button" class="min-h-11 rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="saving()" (click)="doResetPassword()">
                Reset
              </button>
            </div>
            <div aria-live="polite">
              @if (resetNotice()) { <p class="font-sans text-caption" [class]="resetOk() ? 'text-sage' : 'text-alert'">{{ resetNotice() }}</p> }
            </div>
          </div>
        }

      <div dialogFooter class="flex flex-col-reverse gap-2 border-t border-cloud px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
        <button type="button" class="${BTN_GHOST}" [disabled]="saving()" (click)="close()">Cancel</button>
        <button type="submit" form="bo-staff-form" class="${BTN_PRIMARY}" [disabled]="saving()">
          @if (saving()) {
            <sd-icon name="loader-circle" [size]="18" class="animate-spin" />Saving…
          } @else {
            <sd-icon name="save" [size]="18" />{{ editing() ? 'Save changes' : 'Create account' }}
          }
        </button>
      </div>
    </sd-dialog>
  `,
})
export class AdminStaff implements OnInit, HasUnsavedChanges {
  private readonly api = inject(StaffApi);
  private readonly specialistsApi = inject(SpecialistsApi);
  private readonly auth = inject(StaffAuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly permissionOptions = PERMISSIONS;
  protected readonly users = signal<StaffUserDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly listError = signal('');
  protected readonly specialists = signal<SpecialistAdminDto[]>([]);

  // Editor
  protected readonly editorOpen = signal(false);
  protected readonly editing = signal<StaffUserDto | null>(null);
  protected readonly firstName = signal('');
  protected readonly lastName = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly active = signal(true);
  protected readonly roles = signal<string[]>([]);
  protected readonly permissions = signal<string[]>([]);
  protected readonly specialistId = signal('');
  protected readonly saving = signal(false);
  protected readonly formError = signal('');
  /** New doctor logins: email a set-password link instead of a temporary password. */
  protected readonly sendInvite = signal(true);
  protected readonly invitingDoctor = computed(() => this.hasRole('doctor') && this.sendInvite());
  /** Shown above the list after an invite goes out. */
  protected readonly pageNotice = signal('');
  protected readonly devLink = signal('');

  // Reset password
  protected readonly resetPw = signal('');
  protected readonly resetNotice = signal('');
  protected readonly resetOk = signal(false);

  private readonly dialogs = inject(DialogService);
  /** The editor's fields as they were when it opened. */
  private readonly baseline = signal('');
  private readonly formState = computed(() =>
    JSON.stringify([
      this.firstName().trim(),
      this.lastName().trim(),
      this.email().trim(),
      this.password(),
      this.active(),
      [...this.roles()].sort(),
      [...this.permissions()].sort(),
      this.specialistId(),
      this.sendInvite(),
      this.resetPw(),
    ]),
  );
  /** The editor is open with edits that aren't saved. */
  protected readonly dirty = computed(() => this.editorOpen() && this.formState() !== this.baseline());
  protected readonly editorSubtitle = computed(() => {
    const u = this.editing();
    return u ? u.email : 'A login for the console or the doctor portal.';
  });

  /** Only a super admin can grant super_admin. */
  private readonly isSuper = computed(() => this.auth.hasRole('super_admin'));
  protected readonly roleOptions = computed(() =>
    ROLES.filter((r) => r.value !== 'super_admin' || this.isSuper()),
  );

  ngOnInit(): void {
    this.load();
    this.loadSpecialists();
  }

  private loadSpecialists(): void {
    this.specialistsApi
      .listAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.specialists.set(res.data), error: () => undefined });
  }

  private load(): void {
    this.loading.set(true);
    this.listError.set('');
    this.api
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.users.set(res.data);
          this.loading.set(false);
        },
        error: (err: unknown) => {
          this.listError.set(apiErrorMessage(err, 'Could not load staff accounts.'));
          this.loading.set(false);
        },
      });
  }

  protected hasRole(r: string): boolean {
    return this.roles().includes(r);
  }
  protected toggleRole(r: string): void {
    this.roles.update((list) => (list.includes(r) ? list.filter((x) => x !== r) : [...list, r]));
  }
  protected hasPerm(p: string): boolean {
    return this.permissions().includes(p);
  }
  protected togglePerm(p: string): void {
    this.permissions.update((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
  }

  protected openCreate(): void {
    this.editing.set(null);
    this.firstName.set('');
    this.lastName.set('');
    this.email.set('');
    this.password.set('');
    this.active.set(true);
    this.roles.set([]);
    this.permissions.set([]);
    this.specialistId.set('');
    this.sendInvite.set(true);
    this.formError.set('');
    this.resetNotice.set('');
    this.resetPw.set('');
    this.baseline.set(this.formState());
    this.editorOpen.set(true);
  }

  protected openEdit(u: StaffUserDto): void {
    this.editing.set(u);
    this.firstName.set(u.first_name);
    this.lastName.set(u.last_name);
    this.email.set(u.email);
    this.password.set('');
    this.active.set(u.active);
    this.roles.set([...u.roles]);
    this.permissions.set([...u.permissions]);
    this.specialistId.set(u.specialist_id ?? '');
    this.formError.set('');
    this.resetNotice.set('');
    this.resetPw.set('');
    this.baseline.set(this.formState());
    this.editorOpen.set(true);
  }

  /** Close the editor — asking first when it holds unsaved edits. */
  protected async close(): Promise<void> {
    if (this.saving()) return;
    if (this.dirty() && !(await this.dialogs.confirmLeave(this.discardCopy()))) return;
    this.editorOpen.set(false);
  }

  /** For the route's unsavedChangesGuard: the editor is open with unsaved edits. */
  hasUnsavedChanges(): boolean {
    return this.dirty();
  }
  readonly leaveCopy = (): LeaveCopy => this.discardCopy();

  private discardCopy(): LeaveCopy {
    const editing = this.editing();
    return {
      title: 'Discard changes?',
      message: editing
        ? `Your edits to ${this.nameOf(editing)}'s account won't be saved.`
        : "The new account won't be created.",
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    };
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.formError.set('');
    const specialistId = this.hasRole('doctor') ? this.specialistId() || null : null;
    const editing = this.editing();
    if (editing) {
      const request = this.api.update(editing.id, {
        email: this.email().trim(),
        first_name: this.firstName().trim(),
        last_name: this.lastName().trim(),
        roles: this.roles(),
        permissions: this.permissions(),
        active: this.active(),
        specialist_id: specialistId,
      });
      if (editing.active && !this.active()) {
        // Deactivating signs them out everywhere at once (the API revokes their sessions).
        const { confirmed } = await this.dialogs.confirm({
          tone: 'danger',
          icon: 'user-x',
          title: `Deactivate ${this.nameOf(editing)}?`,
          message: "They're signed out everywhere straight away and can't sign in until you reactivate them.",
          details: [{ label: 'Account', value: editing.email }],
          confirmLabel: 'Deactivate and save',
          cancelLabel: 'Keep active',
          busyLabel: 'Saving…',
          action: () => request,
        });
        if (confirmed) this.afterSave();
        return;
      }
      this.saving.set(true);
      request
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: () => this.afterSave(), error: (err) => this.onError(err) });
    } else {
      this.saving.set(true);
      const invite = this.invitingDoctor();
      this.api
        .create({
          email: this.email().trim(),
          first_name: this.firstName().trim(),
          last_name: this.lastName().trim(),
          // An invited doctor chooses their own password from the emailed link.
          ...(invite ? { send_invite: true } : { password: this.password() }),
          roles: this.roles(),
          permissions: this.permissions(),
          specialist_id: specialistId,
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (res) => {
            const sent = res.data.invite;
            if (sent) {
              this.pageNotice.set(
                sent.email_sent
                  ? `Invite sent to ${res.data.email}. The link expires in 7 days.`
                  : `The login was created, but the invite email to ${res.data.email} could not be sent. Resend it from Specialists.`,
              );
              this.devLink.set(sent.dev_link ?? '');
            }
            this.afterSave();
          },
          error: (err) => this.onError(err),
        });
    }
  }

  private afterSave(): void {
    this.saving.set(false);
    this.editorOpen.set(false);
    this.load();
    // Refresh which specialists are already linked to a login.
    this.loadSpecialists();
  }
  private onError(err: unknown): void {
    this.saving.set(false);
    this.formError.set(apiErrorMessage(err, 'Could not save the account.'));
  }

  protected async doResetPassword(): Promise<void> {
    const editing = this.editing();
    if (!editing) return;
    if (this.resetPw().length < 8) {
      this.resetOk.set(false);
      this.resetNotice.set('Password must be at least 8 characters.');
      return;
    }
    this.resetNotice.set('');
    const password = this.resetPw();
    const { confirmed } = await this.dialogs.confirm({
      tone: 'warning',
      icon: 'key-round',
      title: `Set a new password for ${this.nameOf(editing)}?`,
      message: 'Their current password stops working straight away. Tell them the new one securely — never by email or chat.',
      details: [{ label: 'Account', value: editing.email }],
      confirmLabel: 'Set new password',
      cancelLabel: 'Cancel',
      busyLabel: 'Resetting…',
      errorMessage: (err) => apiErrorMessage(err, 'Could not reset the password.'),
      action: () => this.api.resetPassword(editing.id, password).pipe(tap(() => this.resetPw.set(''))),
    });
    if (confirmed) {
      this.resetOk.set(true);
      this.resetNotice.set('Password reset. Tell them the new one securely.');
    }
  }

  private nameOf(u: StaffUserDto): string {
    return `${u.first_name} ${u.last_name}`.trim() || u.email;
  }
}
