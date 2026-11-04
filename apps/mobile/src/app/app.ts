import { Component, DestroyRef, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { IonApp } from '@ionic/angular/standalone';
import { catchError, of, switchMap, type Subscription } from 'rxjs';
import { AuthService } from '@supadoc/auth';
import { PatientApi, syncDetectedTimeZone } from '@supadoc/data-access';

@Component({
  imports: [IonApp, RouterOutlet],
  selector: 'mob-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected title = 'mobile';

  private readonly auth = inject(AuthService);
  private readonly patientApi = inject(PatientApi);
  private readonly destroyRef = inject(DestroyRef);
  /** The patient whose zone this app run has already offered to save (once per subject). */
  private syncedFor: string | null = null;
  private sync?: Subscription;

  constructor() {
    // Once a patient is signed in: save this device's zone for their emails,
    // texts and notices — only while they never had one (`auto`, D8). The app
    // itself always shows times in the device's zone.
    effect(() => {
      const subject = this.auth.isAuthenticated() ? this.auth.subject() : null;
      untracked(() => this.syncTimeZone(subject));
    });
  }

  private syncTimeZone(subject: string | null): void {
    if (!subject || subject === this.syncedFor) return;
    this.syncedFor = subject;
    this.sync?.unsubscribe();
    this.sync = this.patientApi
      .me()
      .pipe(
        switchMap((res) => syncDetectedTimeZone(res.data, (body) => this.patientApi.setTimeZone(body))),
        // A failed profile read just skips it (nothing to show); signing in again retries.
        catchError(() => {
          if (this.syncedFor === subject) this.syncedFor = null;
          return of('skipped' as const);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }
}
