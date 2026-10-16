import { HttpEventType, HttpResponse } from '@angular/common/http';
import type { SpecialistPhotoResultDto, SuccessResponse } from '@supadoc/models';
import { photoUploadStep } from './photo-picker';
import { isActiveSpecialty, specialtyField } from './specialty-choices';

const items = [
  { label: 'Cardiology', active: true },
  { label: 'Dermatology', active: true },
  { label: 'Homeopathy', active: false },
];

describe('specialtyField', () => {
  it('offers only the active items, in list order', () => {
    const f = specialtyField(items, '');
    expect(f.options.map((o) => o.value)).toEqual(['Cardiology', 'Dermatology']);
    expect(f.value).toBe('');
    expect(f.currentInactive || f.currentUnlisted).toBe(false);
  });

  it("selects the list's own spelling when the value matches in another case", () => {
    const f = specialtyField(items, '  cardiology ');
    expect(f.value).toBe('Cardiology');
    expect(f.options).toHaveLength(2);
  });

  it('keeps a switched-off current value, marked as such', () => {
    const f = specialtyField(items, 'Homeopathy');
    expect(f.currentInactive).toBe(true);
    expect(f.value).toBe('Homeopathy');
    expect(f.options[0]).toEqual({ value: 'Homeopathy', label: 'Homeopathy (switched off)' });
  });

  it('keeps an older free-text value that is not on the list', () => {
    const f = specialtyField(items, 'Sports medicine');
    expect(f.currentUnlisted).toBe(true);
    expect(f.options[0].label).toBe('Sports medicine (not on the list)');
  });

  it('accepts only an active label, in any case', () => {
    expect(isActiveSpecialty(items, 'DERMATOLOGY')).toBe(true);
    expect(isActiveSpecialty(items, 'Homeopathy')).toBe(false);
    expect(isActiveSpecialty(items, 'Sports medicine')).toBe(false);
    expect(isActiveSpecialty(items, '')).toBe(false);
  });
});

describe('photoUploadStep', () => {
  it('turns upload events into progress, and the response into the result', () => {
    expect(photoUploadStep({ type: HttpEventType.UploadProgress, loaded: 50, total: 200 })).toEqual({ progress: 25 });
    expect(photoUploadStep({ type: HttpEventType.UploadProgress, loaded: 50 })).toEqual({});
    expect(photoUploadStep({ type: HttpEventType.Sent })).toEqual({});
    const data = { id: 's1', photo_url: '/uploads/avatars/dr-s1-abcd1234.jpg' } as SpecialistPhotoResultDto;
    const body: SuccessResponse<SpecialistPhotoResultDto> = { status: 'success', message: 'OK', data };
    expect(photoUploadStep(new HttpResponse({ body, status: 200 }))).toEqual({ progress: 100, result: data });
  });
});
