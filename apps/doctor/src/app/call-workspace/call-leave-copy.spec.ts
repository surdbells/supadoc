import { UNSAVED_LAB_LEAVE } from '../lab/lab-composer';
import { UNSAVED_RX_LEAVE } from '../prescriptions/rx-shared';
import { discardDraftsCopy, leaveCallCopy } from './call-leave-copy';

describe('the call’s one leave question', () => {
  const none = { rx: false, lab: false };
  const rx = { rx: true, lab: false };
  const lab = { rx: false, lab: true };
  const both = { rx: true, lab: true };

  describe('in the live call (Leave, the route guard)', () => {
    it('nothing at risk: today’s "Leave the call?" with the patient’s name, verbatim', () => {
      expect(leaveCallCopy(none, true, 'Ada Obi')).toEqual({
        tone: 'warning',
        icon: 'door-open',
        title: 'Leave the call?',
        message: 'The visit stays open — you can rejoin from the appointment page while Ada Obi is still there.',
        confirmLabel: 'Leave call',
        cancelLabel: 'Stay',
      });
    });

    it('a prescription: today’s unsaved-prescription copy, verbatim', () => {
      expect(leaveCallCopy(rx, true, 'Ada Obi')).toEqual({
        tone: 'danger',
        icon: 'phone-off',
        title: 'Leave the call with an unsaved prescription?',
        message:
          "Your latest changes to the prescription haven't been saved, and leaving loses them. The visit stays open — you can rejoin from the appointment page.",
        confirmLabel: 'Leave without saving',
        cancelLabel: 'Stay in the call',
      });
    });

    it('a lab request', () => {
      expect(leaveCallCopy(lab, true, 'Ada Obi')).toEqual({
        tone: 'danger',
        icon: 'phone-off',
        title: 'Leave the call with an unsent lab request?',
        message: "Your lab request hasn't been sent, and leaving loses it. The visit stays open — you can rejoin from the appointment page.",
        confirmLabel: 'Leave without sending',
        cancelLabel: 'Stay in the call',
      });
    });

    it('both: one question naming both', () => {
      expect(leaveCallCopy(both, true, 'Ada Obi')).toEqual({
        tone: 'danger',
        icon: 'phone-off',
        title: 'Leave the call with unsaved work?',
        message:
          "Your latest prescription changes haven't been saved and your lab request hasn't been sent. Leaving loses both. The visit stays open — you can rejoin from the appointment page.",
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay in the call',
      });
    });
  });

  describe('off the call (Leave after it ended) and End', () => {
    it('nothing at risk: no question', () => {
      expect(leaveCallCopy(none, false, 'Ada Obi')).toBeNull();
      expect(discardDraftsCopy(none)).toBeNull();
    });

    it('a prescription: UNSAVED_RX_LEAVE', () => {
      expect(leaveCallCopy(rx, false, 'Ada Obi')).toBe(UNSAVED_RX_LEAVE);
      expect(discardDraftsCopy(rx)).toBe(UNSAVED_RX_LEAVE);
    });

    it('a lab request: UNSAVED_LAB_LEAVE', () => {
      expect(leaveCallCopy(lab, false, 'Ada Obi')).toBe(UNSAVED_LAB_LEAVE);
      expect(discardDraftsCopy(lab)).toBe(UNSAVED_LAB_LEAVE);
    });

    it('both: one question naming both', () => {
      const copy = {
        tone: 'danger',
        title: 'Leave without saving or sending?',
        message: "Your latest prescription changes haven't been saved and your lab request hasn't been sent. Leaving now loses both.",
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Keep editing',
      };
      expect(leaveCallCopy(both, false, 'Ada Obi')).toEqual(copy);
      expect(discardDraftsCopy(both)).toEqual(copy);
    });
  });
});
