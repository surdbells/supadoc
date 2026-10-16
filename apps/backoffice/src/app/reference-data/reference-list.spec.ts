import { countOf, duplicateOf, filterItems, labelKey, moveItem, tidyLabel } from './reference-list';

const items = [
  { id: 'a', label: 'Cardiology', code: 'cardiology', active: true },
  { id: 'b', label: 'ENT (Otolaryngology)', code: 'ent-otolaryngology', active: true },
  { id: 'c', label: 'Family  Medicine', code: 'family-medicine', active: false },
];

describe('reference-list', () => {
  it('compares labels the way the API does: case and spacing aside', () => {
    expect(labelKey('  Family   MEDICINE ')).toBe('family medicine');
    expect(labelKey(null)).toBe('');
    expect(tidyLabel('  Family   Medicine ')).toBe('Family Medicine');
  });

  it('finds a duplicate in any case, but not the item being renamed', () => {
    expect(duplicateOf(items, 'cardiology')?.id).toBe('a');
    expect(duplicateOf(items, 'family medicine')?.id).toBe('c');
    expect(duplicateOf(items, 'CARDIOLOGY', 'a')).toBeNull();
    expect(duplicateOf(items, '   ')).toBeNull();
  });

  it('filters by label or code and by active / switched off', () => {
    expect(filterItems(items, '', 'all').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(filterItems(items, 'oto', 'all').map((i) => i.id)).toEqual(['b']);
    expect(filterItems(items, 'family medicine', 'all').map((i) => i.id)).toEqual(['c']);
    expect(filterItems(items, '', 'active').map((i) => i.id)).toEqual(['a', 'b']);
    expect(filterItems(items, '', 'inactive').map((i) => i.id)).toEqual(['c']);
  });

  it('moves one place and ignores moves off either end', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('counts in words', () => {
    expect(countOf(1, 'doctor')).toBe('1 doctor');
    expect(countOf(1200, 'doctor')).toBe('1,200 doctors');
    expect(countOf(2, 'specialty', 'specialties')).toBe('2 specialties');
  });
});
