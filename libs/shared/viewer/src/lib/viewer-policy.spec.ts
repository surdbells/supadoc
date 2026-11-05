import { of } from 'rxjs';
import { assertPolicyTable, markViewOnly, sourceProblem, VIEWER_POLICIES, viewerPolicy, type ViewerPolicy } from './viewer-policy';
import { blobSource, viewOnlySource } from './viewer-sources';
import type { ViewerPolicyId, ViewerSource } from './viewer-types';

const WM = { viewerName: 'Dr Ada Obi', timeZone: 'America/Chicago' };

describe('VIEWER_POLICIES (§2.2)', () => {
  const row = (id: ViewerPolicyId) => VIEWER_POLICIES[id];

  it('pins the table field by field', () => {
    const pick = (p: ViewerPolicy) => [p.print, p.download, p.watermark, p.deterrents, p.textLayer, p.shareGuard, p.printDpi, p.printFooter, p.nativeVideoFullscreen];
    expect(pick(row('view_only'))).toEqual(['audited', false, true, true, false, 'cover', 150, true, false]);
    expect(pick(row('authored'))).toEqual(['open', true, false, false, true, 'warn', 200, false, true]);
    expect(pick(row('authored_print'))).toEqual(['open', false, false, false, true, 'warn', 200, false, true]);
    expect(pick(row('authored_draft'))).toEqual(['open', false, false, false, true, 'warn', 200, false, true]);
    expect(pick(row('owner'))).toEqual(['open', true, false, false, true, 'warn', 200, false, true]);
    expect(pick(row('staff_record'))).toEqual(['open', false, false, false, true, 'warn', 200, false, true]);
    expect(pick(row('staff_verification'))).toEqual(['open', true, false, false, true, 'warn', 200, false, true]);
  });

  it('pins the notices and the not-viewable copy kinds', () => {
    expect(row('view_only').notice).toBe('View only · Downloads are turned off for patient documents.');
    expect(row('authored_draft').notice).toBe("Draft preview. It isn't valid until you send it.");
    expect(row('staff_record').notice).toBe('Confidential. Opening a document is recorded in the audit log.');
    expect(row('staff_verification').notice).toBe(row('staff_record').notice);
    expect(row('owner').notice).toBeNull();
    expect(row('authored').notice).toBeNull();
    expect(row('authored_print').notice).toBeNull();
    expect(Object.fromEntries(Object.values(VIEWER_POLICIES).map((p) => [p.id, p.notViewable]))).toEqual({
      view_only: 'ask_patient',
      authored: 'download',
      authored_print: 'cant_show',
      authored_draft: 'cant_show',
      owner: 'download',
      staff_record: 'cant_show',
      staff_verification: 'download_to_check',
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(VIEWER_POLICIES)).toBe(true);
    expect(Object.isFrozen(VIEWER_POLICIES.view_only)).toBe(true);
    expect(() => ((VIEWER_POLICIES.view_only as { download: boolean }).download = true)).toThrow();
  });

  it('viewerPolicy throws for an unknown id (never a prototype key)', () => {
    expect(viewerPolicy('owner').id).toBe('owner');
    expect(() => viewerPolicy('nope' as ViewerPolicyId)).toThrow();
    expect(() => viewerPolicy('toString' as ViewerPolicyId)).toThrow();
  });

  it('assertPolicyTable refuses a protected policy that downloads, and a deterred one with a text layer', () => {
    expect(() => assertPolicyTable()).not.toThrow();
    expect(() => assertPolicyTable({ x: { ...VIEWER_POLICIES.view_only, download: true } })).toThrow();
    expect(() => assertPolicyTable({ x: { ...VIEWER_POLICIES.owner, watermark: true } })).toThrow();
    expect(() => assertPolicyTable({ x: { ...VIEWER_POLICIES.view_only, textLayer: true } })).toThrow();
  });
});

describe('sourceProblem (§1.16, every build)', () => {
  const viewOnly = () =>
    viewOnlySource({
      key: 'doc:1',
      title: 'Lab report',
      typeLabel: 'Lab report',
      view: () => of({ blob: new Blob(['%PDF']), mime: 'application/pdf', viewRef: null, viewedAt: '2026-11-04T12:00:00Z' }),
      recordPrint: () => of(null),
      notSharedText: 'gone',
    });
  const owner = (extra: Partial<ViewerSource> = {}) =>
    ({ ...blobSource({ key: 'doc:2', title: 'Mine', typeLabel: 'Report', policy: 'owner', fetch: () => of(new Blob()) }), ...extra }) as ViewerSource;

  it('does not read isDevMode: it refuses with ngDevMode false too', () => {
    const g = globalThis as { ngDevMode?: unknown };
    const saved = g.ngDevMode;
    g.ngDevMode = false;
    try {
      expect(sourceProblem(viewOnly(), {})).toMatch(/watermark/);
    } finally {
      g.ngDevMode = saved;
    }
  });

  it('view_only needs a watermark with a name and a zone', () => {
    expect(sourceProblem(viewOnly(), {})).not.toBeNull();
    expect(sourceProblem(viewOnly(), { watermark: { viewerName: ' ', timeZone: 'UTC' } })).not.toBeNull();
    expect(sourceProblem(viewOnly(), { watermark: { viewerName: 'Dr A', timeZone: '' } })).not.toBeNull();
    expect(sourceProblem(viewOnly(), { watermark: WM })).toBeNull();
  });

  it('an audited print needs recordPrint; a view_only source not built by viewOnlySource is refused', () => {
    const v = viewOnly();
    const copy = { ...v } as ViewerSource;
    expect(sourceProblem(copy, { watermark: WM })).toMatch(/viewOnlySource/);
    const noRecord = { ...v, recordPrint: undefined } as ViewerSource;
    expect(sourceProblem(noRecord, { watermark: WM })).toMatch(/viewOnlySource/);
    // The recordPrint rule on its own: a marked source (as viewOnlySource builds) without recordPrint.
    const markedNoRecord = markViewOnly({ ...v, recordPrint: undefined }) as ViewerSource;
    expect(sourceProblem(markedNoRecord, { watermark: WM })).toBe('an audited print needs recordPrint');
    expect(sourceProblem(markViewOnly({ ...v }) as ViewerSource, { watermark: WM })).toBeNull();
  });

  it('a policy without download refuses a source that brings one', () => {
    const s = { ...owner(), policy: 'staff_record', download: () => of({ blob: new Blob(), filename: 'x' }) } as ViewerSource;
    expect(sourceProblem(s, {})).toMatch(/download/);
    expect(sourceProblem(owner({ download: () => of({ blob: new Blob(), filename: 'x' }) }), {})).toBeNull();
  });

  it('an unknown policy is refused', () => {
    expect(sourceProblem({ ...owner(), policy: 'everything' as ViewerPolicyId }, {})).toBe('unknown policy');
    expect(sourceProblem(owner(), {})).toBeNull();
  });
});
