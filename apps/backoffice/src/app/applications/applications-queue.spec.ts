import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StaffAuthService } from '@supadoc/auth';
import { AdminDoctorApplicationsApi } from '@supadoc/data-access';
import type { DoctorApplicationQueueDto } from '@supadoc/models';
import { Subject } from 'rxjs';
import { ApplicationsQueue } from './applications-queue';

function setup(canReview = true) {
  const reads: Subject<{ data: DoctorApplicationQueueDto }>[] = [];
  const authed = signal(true);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AdminDoctorApplicationsApi,
        useValue: {
          queue: () => {
            const s = new Subject<{ data: DoctorApplicationQueueDto }>();
            reads.push(s);
            return s;
          },
        },
      },
      {
        provide: StaffAuthService,
        useValue: {
          isAuthenticated: authed.asReadonly(),
          hasPermission: (p: string) => canReview && p === 'specialists.manage',
        },
      },
    ],
  });
  return { queue: TestBed.inject(ApplicationsQueue), reads, authed };
}

const counts = (needs_action: number): DoctorApplicationQueueDto => ({
  needs_action,
  submitted: 1,
  under_review: 2,
  more_info_needed: 0,
  interview_scheduled: 1,
  interviews_today: 0,
});

describe('ApplicationsQueue', () => {
  it('counts what needs action for the badge', () => {
    const { queue, reads } = setup();
    queue.refresh();
    reads[0].next({ data: counts(3) });
    expect(queue.count()).toBe(3);
    expect(queue.counts()?.under_review).toBe(2);
  });

  it('reads again once when a decision lands while a read is out', () => {
    const { queue, reads } = setup();
    queue.refresh();
    queue.refresh();
    queue.refresh();
    expect(reads.length).toBe(1);
    reads[0].next({ data: counts(2) });
    expect(reads.length).toBe(2);
    reads[1].next({ data: counts(1) });
    expect(queue.count()).toBe(1);
    expect(reads.length).toBe(2);
  });

  it('forgets the counts when the session ends, and drops a read still out', () => {
    const { queue, reads, authed } = setup();
    queue.refresh();
    authed.set(false);
    TestBed.tick();
    reads[0].next({ data: counts(9) });
    expect(queue.counts()).toBeNull();
    expect(queue.count()).toBe(0);
    queue.refresh();
    expect(reads.length).toBe(1);
  });

  it('never reads for staff without specialists.manage', () => {
    const { queue, reads } = setup(false);
    queue.refresh();
    expect(reads.length).toBe(0);
  });
});
