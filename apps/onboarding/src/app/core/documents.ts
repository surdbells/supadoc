import type { ApplicationDocumentSlot, LicenceRoute } from '@supadoc/models';

export interface SlotCopy {
  readonly slot: ApplicationDocumentSlot;
  readonly label: string;
  readonly hint: string;
}

/** The certificate uploaded on the Licence step (D3 for Nigeria). */
export function licenceSlot(route: LicenceRoute): 'mdcn_certificate' | 'good_standing_certificate' {
  return route === 'abroad' ? 'good_standing_certificate' : 'mdcn_certificate';
}

/** The Documents step's four slots, in grid order. */
export const DOCUMENT_STEP_SLOTS: readonly ApplicationDocumentSlot[] = [
  'government_id',
  'medical_degree',
  'practising_licence',
  'curriculum_vitae',
];

/** Label and helper per slot and route (spec §2.12). */
export function slotCopy(slot: ApplicationDocumentSlot, route: LicenceRoute, regulatorName?: string | null): SlotCopy {
  switch (slot) {
    case 'mdcn_certificate':
      return { slot, label: 'MDCN full registration certificate', hint: 'The certificate MDCN issued when you were fully registered' };
    case 'good_standing_certificate':
      return { slot, label: 'Certificate of Good Standing', hint: 'Issued within the last 6 months' };
    case 'government_id':
      return { slot, label: 'Government-issued ID', hint: "Passport, driver's licence or national ID" };
    case 'medical_degree':
      return { slot, label: 'Medical degree certificate', hint: 'MBBS / MBChB or equivalent' };
    case 'practising_licence':
      return route === 'abroad'
        ? {
            slot,
            label: 'Current practising licence',
            hint: regulatorName?.trim() ? `Issued by ${regulatorName.trim()}` : 'Issued by your medical regulator',
          }
        : { slot, label: 'Current MDCN practising licence', hint: 'Valid for the current year' };
    case 'curriculum_vitae':
      return { slot, label: 'Curriculum vitae', hint: 'Your current CV' };
    case 'indemnity_certificate':
      return { slot, label: 'Indemnity certificate', hint: 'Proof of current professional indemnity cover' };
    case 'additional':
      return { slot, label: 'Additional document', hint: '' };
  }
}
