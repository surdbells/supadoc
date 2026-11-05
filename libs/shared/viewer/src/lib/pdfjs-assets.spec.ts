import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDF_CMAP_URL, PDF_STANDARD_FONTS_URL, PDF_WASM_URL, PDF_WORKER_SRC, pdfOptions } from './pdf-loader';

/**
 * The asset and pin guard (§4.1). It reads other projects' files, which are
 * declared as inputs of this project's `test` target (project.json), so a
 * change to an app's assets re-runs it.
 */
const ROOT = resolve(__dirname, '../../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const APPS = ['doctor', 'patient', 'backoffice', 'onboarding'] as const;

interface AssetEntry {
  glob: string;
  input: string;
  output?: string;
  ignore?: string[];
}

const EXPECTED: AssetEntry[] = [
  { glob: 'pdf.worker.min.mjs', input: 'node_modules/pdfjs-dist/legacy/build', output: 'pdfjs' },
  { glob: '**/*', input: 'node_modules/pdfjs-dist/cmaps', output: 'pdfjs/cmaps' },
  { glob: '**/*', input: 'node_modules/pdfjs-dist/standard_fonts', output: 'pdfjs/standard_fonts' },
  { glob: '**/*', input: 'node_modules/pdfjs-dist/wasm', output: 'pdfjs/wasm', ignore: ['quickjs-eval.*'] },
];

describe('pdf.js assets and pin (§4.1)', () => {
  it.each(APPS)('%s copies the worker, CMaps, standard fonts and decoders to /pdfjs (without quickjs-eval)', (app) => {
    const project = JSON.parse(read(`apps/${app}/project.json`)) as { targets: { build: { options: { assets: (AssetEntry | string)[] } } } };
    const assets = project.targets.build.options.assets.filter((a): a is AssetEntry => typeof a === 'object');
    for (const want of EXPECTED) {
      const got = assets.find((a) => a.input === want.input);
      expect(got, `${app}: ${want.input}`).toEqual(want);
    }
  });

  it('pins pdfjs-dist to an exact version', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const version = pkg.dependencies?.['pdfjs-dist'] ?? pkg.devDependencies?.['pdfjs-dist'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const installed = JSON.parse(read('node_modules/pdfjs-dist/package.json')) as { version: string };
    expect(installed.version).toBe(version);
  });

  it("the loader's paths match the copied folders (same-origin, absolute)", () => {
    expect(PDF_WORKER_SRC).toBe(`/${EXPECTED[0].output}/${EXPECTED[0].glob}`);
    expect(PDF_CMAP_URL).toBe(`/${EXPECTED[1].output}/`);
    expect(PDF_STANDARD_FONTS_URL).toBe(`/${EXPECTED[2].output}/`);
    expect(PDF_WASM_URL).toBe(`/${EXPECTED[3].output}/`);
  });

  it.each(APPS)("%s's index.html has <base href=\"/\">", (app) => {
    expect(read(`apps/${app}/src/index.html`)).toMatch(/<base href="\/"\s*\/?>/);
  });

  it('the shipped pdf.js has no eval path, and pdfOptions passes no isEvalSupported', () => {
    for (const file of ['node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs']) {
      expect(existsSync(resolve(ROOT, file))).toBe(true);
      const src = read(file);
      expect(src.includes('new Function('), file).toBe(false);
      expect(/(^|[^.\w])eval\(/.test(src), file).toBe(false);
    }
    const opts = pdfOptions(new Uint8Array([1]));
    expect('isEvalSupported' in opts).toBe(false);
    expect(opts).toMatchObject({ enableXfa: false, disableAutoFetch: true, disableStream: true });
  });
});
