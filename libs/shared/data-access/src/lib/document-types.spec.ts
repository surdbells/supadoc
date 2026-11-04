import { DOCTOR_VIEWABLE_ACCEPT, DOCTOR_VIEWABLE_EXTENSIONS, fileExtension, isDoctorViewableName } from './document-types';

describe('doctor-viewable documents', () => {
  it('mirrors the API list: PDF, photos and MP4/WEBM videos', () => {
    expect([...DOCTOR_VIEWABLE_EXTENSIONS]).toEqual(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm']);
  });

  it.each(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm'])('a .%s file is viewable (any case)', (ext) => {
    expect(isDoctorViewableName(`Lab report.${ext}`)).toBe(true);
    expect(isDoctorViewableName(`SCAN.${ext.toUpperCase()}`)).toBe(true);
  });

  it.each(['docx', 'doc', 'dcm', 'mov', 'heic', 'txt', 'zip'])('a .%s file is not', (ext) => {
    expect(isDoctorViewableName(`notes.${ext}`)).toBe(false);
  });

  it('judges the last extension only, and needs one', () => {
    expect(isDoctorViewableName('report.pdf.docx')).toBe(false);
    expect(isDoctorViewableName('report.docx.pdf')).toBe(true);
    expect(isDoctorViewableName('README')).toBe(false);
    expect(isDoctorViewableName('.pdf')).toBe(false);
    expect(isDoctorViewableName('trailing.')).toBe(false);
    expect(isDoctorViewableName('')).toBe(false);
    expect(fileExtension('C:\\scans\\X-ray.PNG')).toBe('png');
    expect(fileExtension('folder.v2/notes')).toBe('');
  });

  it('offers an accept list of exactly those types', () => {
    const parts = DOCTOR_VIEWABLE_ACCEPT.split(',');
    for (const ext of DOCTOR_VIEWABLE_EXTENSIONS) expect(parts).toContain(`.${ext}`);
    expect(parts).toEqual(expect.arrayContaining(['application/pdf', 'image/webp', 'video/mp4', 'video/webm']));
  });
});
