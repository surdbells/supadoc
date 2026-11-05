import {
  NavigationEnd,
  NavigationStart,
  type Event as RouterEvent,
  type Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import {
  LAB_SECTION_ID,
  notificationIcon,
  notificationTarget,
  revealOnArrival,
} from './notification-target';

const can =
  (...held: string[]) =>
  (p: string) =>
    held.includes(p);

describe('notificationTarget', () => {
  it('takes a lab escalation to the patient page, Lab requests section', () => {
    expect(
      notificationTarget(
        { type: 'lab', link: '/patients/p-1' },
        can('monitoring.view'),
      ),
    ).toEqual({
      path: '/patients/p-1',
      fragment: LAB_SECTION_ID,
    });
  });

  it('links application and doctor notices for reviewers', () => {
    const reviewer = can('specialists.manage');
    expect(
      notificationTarget(
        { type: 'application', link: '/applications/a-1' },
        reviewer,
      ),
    ).toEqual({ path: '/applications/a-1' });
    expect(
      notificationTarget(
        { type: 'onboarding', link: '/specialists/s-1' },
        reviewer,
      ),
    ).toEqual({ path: '/specialists/s-1' });
    expect(
      notificationTarget(
        { type: 'doctor_noshow', link: '/specialists/s-1' },
        reviewer,
      ),
    ).toEqual({ path: '/specialists/s-1' });
  });

  it('shows no link the user cannot open, or that is not a console page for that type', () => {
    // labs.manage alone does not open the patient page.
    expect(
      notificationTarget(
        { type: 'lab', link: '/patients/p-1' },
        can('labs.manage'),
      ),
    ).toBeNull();
    // A doctor-portal path (the doctor's own lab notice, a payout).
    expect(
      notificationTarget(
        { type: 'lab', link: '/prescriptions/labs/l-1' },
        can('monitoring.view'),
      ),
    ).toBeNull();
    expect(
      notificationTarget(
        { type: 'payout', link: '/payouts' },
        can('payouts.manage'),
      ),
    ).toBeNull();
    // A type that doesn't belong to that route, an unknown type, no link, odd paths.
    expect(
      notificationTarget(
        { type: 'application', link: '/patients/p-1' },
        can('monitoring.view', 'specialists.manage'),
      ),
    ).toBeNull();
    expect(
      notificationTarget(
        { type: 'message', link: '/appointments/x' },
        can('appointments.view'),
      ),
    ).toBeNull();
    expect(
      notificationTarget({ type: 'lab', link: null }, can('monitoring.view')),
    ).toBeNull();
    expect(
      notificationTarget(
        { type: 'lab', link: '//evil.test/patients/p-1' },
        can('monitoring.view'),
      ),
    ).toBeNull();
    expect(
      notificationTarget(
        { type: 'lab', link: '/patients/p-1/../../x' },
        can('monitoring.view'),
      ),
    ).toBeNull();
  });

  it('picks an icon per type, a bell otherwise', () => {
    expect(notificationIcon('lab')).toBe('flask-conical');
    expect(notificationIcon('application')).toBe('clipboard-list');
    expect(notificationIcon('something_new')).toBe('bell');
  });
});

describe('revealOnArrival', () => {
  afterEach(() => {
    document.getElementById('bo-test-section')?.remove();
    document.getElementById('bo-test-loading')?.remove();
  });

  const tick = () => new Promise((r) => setTimeout(r));

  /** A section above the target that is still loading (as the patient page's prescriptions are). */
  function loader(): HTMLElement {
    const busy = document.createElement('div');
    busy.id = 'bo-test-loading';
    busy.setAttribute('aria-busy', 'true');
    document.body.appendChild(busy);
    return busy;
  }

  function section(): ReturnType<typeof vi.fn> {
    const h = document.createElement('h2');
    h.id = 'bo-test-section';
    const scroll = vi.fn();
    h.scrollIntoView = scroll;
    document.body.appendChild(h);
    return scroll;
  }

  it('keeps the section in view while the page around it is still loading, then lets go', async () => {
    const events = new Subject<RouterEvent>();
    const busy = loader();
    revealOnArrival(
      { events } as unknown as Router,
      document,
      'bo-test-section',
    );
    events.next(new NavigationEnd(1, '/patients/p-1', '/patients/p-1'));
    const scroll = section();
    await tick();
    expect(scroll).toHaveBeenCalledTimes(1);
    // Still loading: a late list above would push the heading down, so keep watching.
    expect(events.observed).toBe(true);
    busy.replaceChildren(document.createElement('p'));
    await tick();
    expect(scroll).toHaveBeenCalledTimes(2);
    busy.remove(); // the late list has rendered
    await tick();
    expect(scroll).toHaveBeenCalledTimes(3);
    expect(events.observed).toBe(false);
    document.body.appendChild(document.createElement('span')).remove();
    await tick();
    expect(scroll).toHaveBeenCalledTimes(3);
  });

  it('also lets go when a loader drops aria-busy in place', async () => {
    const events = new Subject<RouterEvent>();
    const busy = loader();
    const scroll = section();
    revealOnArrival(
      { events } as unknown as Router,
      document,
      'bo-test-section',
    );
    events.next(new NavigationEnd(1, '/patients/p-1', '/patients/p-1'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(events.observed).toBe(true);
    busy.setAttribute('aria-busy', 'false');
    await tick();
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(events.observed).toBe(false);
  });

  it('never fights the user: stops once they scroll', async () => {
    const events = new Subject<RouterEvent>();
    loader();
    revealOnArrival(
      { events } as unknown as Router,
      document,
      'bo-test-section',
    );
    events.next(new NavigationEnd(1, '/patients/p-1', '/patients/p-1'));
    const scroll = section();
    await tick();
    expect(scroll).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('wheel'));
    expect(events.observed).toBe(false);
    document.getElementById('bo-test-loading')?.remove();
    await tick();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('scrolls the section into view once the arrived page renders it', async () => {
    const events = new Subject<RouterEvent>();
    revealOnArrival(
      { events } as unknown as Router,
      document,
      'bo-test-section',
    );
    events.next(new NavigationStart(1, '/patients/p-1#x'));
    events.next(new NavigationEnd(1, '/patients/p-1#x', '/patients/p-1#x'));
    const section = document.createElement('h2');
    section.id = 'bo-test-section';
    const scroll = vi.fn();
    section.scrollIntoView = scroll;
    document.body.appendChild(section);
    await new Promise((r) => setTimeout(r));
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(events.observed).toBe(false);
  });

  it('gives up when another navigation starts first', async () => {
    const events = new Subject<RouterEvent>();
    revealOnArrival(
      { events } as unknown as Router,
      document,
      'bo-test-section',
    );
    events.next(new NavigationEnd(1, '/patients/p-1', '/patients/p-1'));
    events.next(new NavigationStart(2, '/patients'));
    expect(events.observed).toBe(false);
    const section = document.createElement('h2');
    section.id = 'bo-test-section';
    const scroll = vi.fn();
    section.scrollIntoView = scroll;
    document.body.appendChild(section);
    await new Promise((r) => setTimeout(r));
    expect(scroll).not.toHaveBeenCalled();
  });
});
