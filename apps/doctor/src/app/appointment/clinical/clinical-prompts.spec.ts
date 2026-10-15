import { carePlanPrompt, certificatePrompt, finalizeNotePrompt, labOrderPrompt, referralPrompt } from './clinical-prompts';

describe('clinical confirmation prompts', () => {
  it('name the patient and say what reaches them', () => {
    expect(finalizeNotePrompt('Ada Obi')).toMatchObject({ tone: 'warning', title: 'Finalize and sign this note?' });
    expect(finalizeNotePrompt('Ada Obi').message).toContain('shared with Ada Obi');
    expect(labOrderPrompt('Ada Obi', 3, 'urgent')).toMatchObject({
      title: 'Send this lab order to Ada Obi?',
      details: [{ label: 'Tests', value: '3' }, { label: 'Priority', value: 'Urgent' }],
    });
    expect(referralPrompt('Ada Obi', 'LUTH Cardiology', 'routine').details).toContainEqual({ label: 'Refer to', value: 'LUTH Cardiology' });
    expect(carePlanPrompt('Ada Obi', 4, false).confirmLabel).toBe('Publish to patient');
    expect(carePlanPrompt('Ada Obi', 4, true).title).toBe("Update Ada Obi's care plan?");
  });

  it('show a certificate type and, for sick leave, the period — never a diagnosis', () => {
    const sick = certificatePrompt('Ada Obi', 'sick_leave', 'Tue 14 Oct – Fri 17 Oct');
    expect(sick.title).toBe('Issue this sick-leave certificate?');
    expect(sick.details).toEqual([
      { label: 'Type', value: 'Sick leave' },
      { label: 'Leave', value: 'Tue 14 Oct – Fri 17 Oct' },
    ]);
    expect(certificatePrompt('Ada Obi', 'general', null).details).toEqual([{ label: 'Type', value: 'General' }]);
  });
});
