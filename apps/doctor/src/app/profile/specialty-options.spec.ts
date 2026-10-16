import type { PublicReferenceItemDto } from '@supadoc/models';
import {
  isRetiredSpecialty,
  specialtyKey,
  specialtyOptions,
} from './specialty-options';

function item(label: string, sort = 10): PublicReferenceItemDto {
  return {
    id: label.toLowerCase().replace(/\W+/g, '-'),
    code: label.toLowerCase().replace(/\W+/g, '-'),
    label,
    sort_order: sort,
  };
}

const LIST = [
  item('General Practice', 10),
  item('Cardiology', 20),
  item('ENT (Otolaryngology)', 30),
];

describe('specialtyKey', () => {
  it('compares as the API does: trimmed, spaces collapsed, any case', () => {
    expect(specialtyKey('  Internal   Medicine ')).toBe('internal medicine');
    expect(specialtyKey(null)).toBe('');
  });
});

describe('specialtyOptions', () => {
  it('offers the active items in list order', () => {
    expect(specialtyOptions(LIST, ['Cardiology'])).toEqual([
      { value: 'General Practice', label: 'General Practice' },
      { value: 'Cardiology', label: 'Cardiology' },
      { value: 'ENT (Otolaryngology)', label: 'ENT (Otolaryngology)' },
    ]);
  });

  it('puts a speciality the list no longer offers first, marked as such, so it can be kept', () => {
    const opts = specialtyOptions(LIST, ['Tropical Medicine', null]);
    expect(opts[0]).toEqual({
      value: 'Tropical Medicine',
      label: 'Tropical Medicine (no longer offered)',
    });
    expect(opts).toHaveLength(4);
  });

  it('keeps both the current speciality and the one asked for when neither is offered any more', () => {
    const opts = specialtyOptions(LIST, [
      'Tropical Medicine',
      'Sports Medicine',
    ]);
    expect(opts.slice(0, 2).map((o) => o.value)).toEqual([
      'Tropical Medicine',
      'Sports Medicine',
    ]);
  });

  it('sends back the stored spelling when it matches an item in another case', () => {
    const opts = specialtyOptions(LIST, ['cardiology ']);
    expect(opts.find((o) => o.label === 'Cardiology')).toEqual({
      value: 'cardiology',
      label: 'Cardiology',
    });
    expect(opts.some((o) => o.label.includes('no longer offered'))).toBe(false);
  });

  it('lists a kept value once, whatever its spelling', () => {
    const opts = specialtyOptions(LIST, [
      'Tropical Medicine',
      'tropical  medicine',
    ]);
    expect(
      opts.filter((o) => specialtyKey(o.value) === 'tropical medicine'),
    ).toHaveLength(1);
  });

  it('offers only the doctor’s own value without a list (the page shows free text then)', () => {
    expect(specialtyOptions([], ['Cardiology'])).toEqual([
      { value: 'Cardiology', label: 'Cardiology (no longer offered)' },
    ]);
  });
});

describe('isRetiredSpecialty', () => {
  it('is true only for a value the list does not offer', () => {
    expect(isRetiredSpecialty('Tropical Medicine', LIST)).toBe(true);
    expect(isRetiredSpecialty('CARDIOLOGY', LIST)).toBe(false);
    expect(isRetiredSpecialty('', LIST)).toBe(false);
  });

  it('is never true while there is no list to compare with', () => {
    expect(isRetiredSpecialty('Tropical Medicine', [])).toBe(false);
  });
});
