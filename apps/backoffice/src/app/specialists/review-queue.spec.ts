import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StaffAuthService } from '@supadoc/auth';
import { SpecialistsApi } from '@supadoc/data-access';
import type { SpecialistReviewQueueDto } from '@supadoc/models';
import { Subject } from 'rxjs';
import { ReviewQueue } from './review-queue';

function setup() {
  const reads: Subject<{ data: SpecialistReviewQueueDto }>[] = [];
  const authed = signal(true);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: SpecialistsApi,
        useValue: {
          reviewQueue: () => {
            const s = new Subject<{ data: SpecialistReviewQueueDto }>();
            reads.push(s);
            return s;
          },
        },
      },
      {
        provide: StaffAuthService,
        useValue: {
          isAuthenticated: authed.asReadonly(),
          hasPermission: () => true,
        },
      },
    ],
  });
  return { queue: TestBed.inject(ReviewQueue), reads, authed };
}

const counts = (total: number) =>
  ({ total }) as unknown as SpecialistReviewQueueDto;

describe('ReviewQueue', () => {
  it('forgets the counts when the session ends', () => {
    const { queue, reads, authed } = setup();
    queue.refresh();
    reads[0].next({ data: counts(4) });
    expect(queue.count()).toBe(4);
    authed.set(false);
    TestBed.tick();
    expect(queue.count()).toBe(0);
    expect(queue.counts()).toBeNull();
  });

  it('drops a read still out when the session ends, and reads nothing while signed out', () => {
    const { queue, reads, authed } = setup();
    queue.refresh();
    authed.set(false);
    TestBed.tick();
    reads[0].next({ data: counts(9) });
    expect(queue.counts()).toBeNull();
    queue.refresh();
    expect(reads.length).toBe(1);
  });
});
