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
import { StaffAuthService } from '@supadoc/auth';
import { apiErrorMessage, SpecialistsApi, StaffApi } from '@supadoc/data-access';
import type { SpecialistAdminDto, StaffUserDto } from '@supadoc/models';
import { IconComponent } from '@supadoc/ui';

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

/** Staff & role management (route `/staff`, needs staff.manage). */
@Component({
  selector: 'bo-staff',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
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
                    <span class="rounded-pill px-2.5 py-0.5 text-caption" [class]="u.active ? 'bg-sage/15 text-sage' : 'bg-cloud text-slate'">{{ u.active ? 'Active' : 'Inactive' }}</span>
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

    @if (editorOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button type="button" class="absolute inset-0 cursor-default bg-abyss/40" aria-label="Close" (click)="close()"></button>
        <div class="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col gap-5 overflow-y-auto rounded-[16px] border border-cloud bg-white p-6 shadow-[0_4px_24px_rgba(10,22,40,0.12)]">
          <div class="flex items-center justify-between">
            <h2 class="font-heading text-h5 text-ink">{{ editing() ? 'Edit staff' : 'New staff' }}</h2>
            <button type="button" class="text-slate transition-colors hover:text-ink" aria-label="Close" (click)="close()"><sd-icon name="x" [size]="24" /></button>
          </div>

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
            <label class="flex flex-col gap-1.5">
              <span class="font-sans text-caption font-semibold text-slate">Temporary password</span>
              <input type="password" autocomplete="new-password" class="${FIELD}" [value]="password()" (input)="password.set($any($event.target).value)" placeholder="At least 8 characters" />
            </label>
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
                @for (s of specialists(); track s.id) { <option [value]="s.id">{{ s.name }} · {{ s.specialty }}</option> }
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
            <p class="rounded-field bg-alert/10 px-4 py-2 font-label text-caption text-alert">{{ formError() }}</p>
          }
          <div class="flex items-center gap-3">
            <button type="button" class="rounded-field bg-cerulean px-5 py-2.5 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Saving…' : (editing() ? 'Save changes' : 'Create account') }}
            </button>
            <button type="button" class="font-sans text-body-sm font-semibold text-slate transition-colors hover:text-ink" (click)="close()">Cancel</button>
          </div>

          @if (editing()) {
            <div class="flex flex-col gap-2 border-t border-cloud pt-4">
              <span class="font-sans text-caption font-semibold text-slate">Reset password</span>
              <div class="flex flex-wrap items-center gap-2">
                <input type="password" autocomplete="new-password" class="${FIELD} sm:max-w-xs" [value]="resetPw()" (input)="resetPw.set($any($event.target).value)" placeholder="New password (8+ chars)" />
                <button type="button" class="rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-cerulean transition-colors hover:border-cerulean disabled:opacity-60" [disabled]="resetting()" (click)="doResetPassword()">
                  {{ resetting() ? 'Resetting…' : 'Reset' }}
                </button>
              </div>
              @if (resetNotice()) { <p class="font-sans text-caption" [class]="resetOk() ? 'text-sage' : 'text-alert'">{{ resetNotice() }}</p> }
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class AdminStaff implements OnInit {
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

  // Reset password
  protected readonly resetPw = signal('');
  protected readonly resetting = signal(false);
  protected readonly resetNotice = signal('');
  protected readonly resetOk = signal(false);

  /** Only a super admin can grant super_admin. */
  private readonly isSuper = computed(() => this.auth.hasRole('super_admin'));
  protected readonly roleOptions = computed(() =>
    ROLES.filter((r) => r.value !== 'super_admin' || this.isSuper()),
  );

  ngOnInit(): void {
    this.load();
    this.specialistsApi
      .listAdmin()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (res) => this.specialists.set(res.data), error: () => undefined });
  }

  private load(): void {
    this.loading.set(true);
    this.api
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.users.set(res.data);
          this.loading.set(false);
        },
        error: () => {
          this.listError.set('Could not load staff accounts.');
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
    this.formError.set('');
    this.resetNotice.set('');
    this.resetPw.set('');
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
    this.editorOpen.set(true);
  }

  protected close(): void {
    this.editorOpen.set(false);
  }

  protected save(): void {
    this.saving.set(true);
    this.formError.set('');
    const specialistId = this.hasRole('doctor') ? this.specialistId() || null : null;
    const editing = this.editing();
    if (editing) {
      this.api
        .update(editing.id, {
          email: this.email().trim(),
          first_name: this.firstName().trim(),
          last_name: this.lastName().trim(),
          roles: this.roles(),
          permissions: this.permissions(),
          active: this.active(),
          specialist_id: specialistId,
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: () => this.afterSave(), error: (err) => this.onError(err) });
    } else {
      this.api
        .create({
          email: this.email().trim(),
          first_name: this.firstName().trim(),
          last_name: this.lastName().trim(),
          password: this.password(),
          roles: this.roles(),
          permissions: this.permissions(),
          specialist_id: specialistId,
        })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: () => this.afterSave(), error: (err) => this.onError(err) });
    }
  }

  private afterSave(): void {
    this.saving.set(false);
    this.editorOpen.set(false);
    this.load();
  }
  private onError(err: unknown): void {
    this.saving.set(false);
    this.formError.set(apiErrorMessage(err, 'Could not save the account.'));
  }

  protected doResetPassword(): void {
    const editing = this.editing();
    if (!editing) return;
    if (this.resetPw().length < 8) {
      this.resetOk.set(false);
      this.resetNotice.set('Password must be at least 8 characters.');
      return;
    }
    this.resetting.set(true);
    this.resetNotice.set('');
    this.api
      .resetPassword(editing.id, this.resetPw())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.resetOk.set(true);
          this.resetNotice.set('Password reset.');
          this.resetPw.set('');
          this.resetting.set(false);
        },
        error: (err) => {
          this.resetOk.set(false);
          this.resetNotice.set(apiErrorMessage(err, 'Could not reset the password.'));
          this.resetting.set(false);
        },
      });
  }
}
