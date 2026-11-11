#!/usr/bin/env node
/*
 * Headless-Chromium runner for tools/pill-audit/audit.js (Node ≥ 22: built-in fetch +
 * WebSocket over the Chrome DevTools Protocol; no dependencies). Run from the repo root.
 *
 *   node tools/pill-audit/run.mjs [--pages tools/pill-audit/pages.json] [--out <dir>]
 *        [--only <name,name>]       only these pages.json entries
 *        [--chrome <exe>]           launch this browser (default: the installed Chrome) headless …
 *        [--profile <dir>]          … with this profile (a session the developer signed into by hand;
 *                                   this script never handles credentials or reads storage)
 *        [--cdp <port>]             … or attach to an already running browser on this CDP port instead
 *        [--serve <port>]           serve the repo root over http://127.0.0.1:<port> while running
 *                                   (the gallery and its built stylesheet)
 *        [--sizes 1440x900,375x812] [--dprs 1,2] [--pointers fine,coarse]
 *
 * pages.json: [{ "name": "doctor-schedule", "url": "http://localhost:4204/schedule",
 *                "storage": { "videomed.theme": "dark" },         // optional localStorage set before load; every
 *                                                                  // key any entry sets is removed for the others
 *                "setup": "document.querySelector('…').click()",  // optional expression run after load (open a panel)
 *                "css": "dist/apps/patient/browser/styles-*.css",  // optional stylesheet to inject (gallery)
 *                "force": ["hover", "focus-visible"]               // optional: also audit with these states forced
 *              }, …]
 * Every page runs at each size × DPR × pointer (default 1440×900 and 375×812, DPR 1 and 2, fine and
 * coarse), with reduced motion. Writes <out>/<name>.<w>x<h>@<dpr>.<pointer>[.<state>].json and .png and a
 * summary.json; exits 1 when any failure is found.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++)
  if (argv[i].startsWith('--'))
    args[argv[i].slice(2)] =
      argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = resolve(args.out ?? join(tmpdir(), 'pill-audit'));
const only = args.only ? new Set(args.only.split(',')) : null;
const allPages = JSON.parse(
  readFileSync(resolve(args.pages ?? join(here, 'pages.json')), 'utf8'),
);
const pages = allPages.filter((p) => !only || only.has(p.name));
/** Every storage key any entry sets (the whole list, not only the --only ones): reset for the others, so a
    dark entry's theme never carries over into a light one through the shared profile. */
const storageKeys = [
  ...new Set(allPages.flatMap((p) => Object.keys(p.storage ?? {}))),
];
const audit = readFileSync(join(here, 'audit.js'), 'utf8');
const sizes = (args.sizes ?? '1440x900,375x812')
  .split(',')
  .map((s) => s.split('x').map(Number));
const dprs = (args.dprs ?? '1,2').split(',').map(Number);
const pointers = (args.pointers ?? 'fine,coarse').split(',');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- optional static server (repo root; read-only; no directory listing) ----
let server = null;
if (args.serve) {
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
  };
  server = createServer((req, res) => {
    const path = resolve(
      repo,
      '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname),
    );
    if (!path.startsWith(repo + sep)) return res.writeHead(403).end();
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      res
        .writeHead(200, {
          'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        })
        .end(readFileSync(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(Number(args.serve), '127.0.0.1', r));
}

// ---- the browser ----
let proc = null;
let port = Number(args.cdp);
if (!port) {
  port = 9300 + Math.floor(Math.random() * 500);
  const profile =
    args.profile ?? mkdtempSync(join(tmpdir(), 'pill-audit-profile-'));
  const chrome =
    args.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  proc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}
async function newTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const t = await (
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
          method: 'PUT',
        })
      ).json();
      if (t.webSocketDebuggerUrl) return t;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}
const target = await newTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else listeners.forEach((l) => l(msg));
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (m) =>
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result),
    );
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const loaded = () =>
  new Promise((r) => {
    const l = (m) => {
      if (m.method === 'Page.loadEventFired') {
        listeners.splice(listeners.indexOf(l), 1);
        r();
      }
    };
    listeners.push(l);
  });
const evaluate = async (expression) =>
  (
    await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value;

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('CSS.enable');
let failed = 0;
const summary = [];
for (const p of pages) {
  for (const [w, h] of sizes) {
    for (const dpr of dprs) {
      for (const pointer of pointers) {
        await send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: dpr,
          mobile: pointer === 'coarse' && w < 768,
        });
        await send('Emulation.setTouchEmulationEnabled', {
          enabled: pointer === 'coarse',
          maxTouchPoints: pointer === 'coarse' ? 5 : 1,
        });
        await send('Emulation.setEmulatedMedia', {
          features: [
            { name: 'any-pointer', value: pointer },
            { name: 'pointer', value: pointer },
            {
              name: 'any-hover',
              value: pointer === 'coarse' ? 'none' : 'hover',
            },
            { name: 'hover', value: pointer === 'coarse' ? 'none' : 'hover' },
            { name: 'prefers-reduced-motion', value: 'reduce' },
          ],
        });
        const set = p.storage ?? {};
        const init = storageKeys.length
          ? `try{${storageKeys
              .map((k) =>
                k in set
                  ? `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(set[k])});`
                  : `localStorage.removeItem(${JSON.stringify(k)});`,
              )
              .join('')}}catch{}`
          : '';
        const { identifier } = await send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: init },
        );
        const done = loaded();
        await send('Page.navigate', { url: p.url });
        await done;
        await sleep(p.wait ?? 800); // fonts + first data
        if (p.setup) {
          await evaluate(p.setup);
          await sleep(500);
        }
        if (p.css) {
          const rel = p.css.replace(/\\/g, '/');
          const dir = resolve(repo, dirname(rel));
          const re = new RegExp(
            '^' +
              rel.split('/').pop().replace(/[.]/g, '\\.').replace('*', '.*') +
              '$',
          );
          const file = readdirSync(dir).find((f) => re.test(f));
          if (!file) throw new Error(`no stylesheet matches ${p.css}`);
          const href = new URL(dirname(rel) + '/' + file, new URL('/', p.url))
            .href;
          await evaluate(
            `new Promise((r)=>{const l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(href)};l.onload=()=>r(true);l.onerror=()=>r(false);document.head.append(l);})`,
          );
          await evaluate(
            'document.fonts.ready.then(()=>{ if (window.galleryReady) window.galleryReady(); return true; })',
          );
          await sleep(150);
        }
        const base = `${p.name}.${w}x${h}@${dpr}.${pointer}`;
        const states = [null, ...(p.force ?? [])];
        for (const state of states) {
          let forced = [];
          if (state) {
            const { root } = await send('DOM.getDocument', { depth: -1 });
            const { nodeIds } = await send('DOM.querySelectorAll', {
              nodeId: root.nodeId,
              selector: '.sd-pill',
            });
            forced = nodeIds;
            for (const nodeId of nodeIds)
              await send('CSS.forcePseudoState', {
                nodeId,
                forcedPseudoClasses: [state],
              });
          }
          const result = await evaluate(
            `${audit};(() => { const r = pillAudit({ scroll: true }); scrollTo(0, 0); return r; })()`,
          );
          const name = state ? `${base}.${state}` : base;
          writeFileSync(
            join(out, name + '.json'),
            JSON.stringify(result, null, 2),
          );
          const shot = await send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
          });
          writeFileSync(
            join(out, name + '.png'),
            Buffer.from(shot.data, 'base64'),
          );
          const n = result?.failures?.length ?? 0;
          const byCode = (list) =>
            (list ?? []).reduce(
              (a, f) => ((a[f.code] = (a[f.code] ?? 0) + 1), a),
              {},
            );
          failed += n;
          summary.push({
            name,
            checked: result?.checked ?? 0,
            failures: n,
            failureCodes: byCode(result?.failures),
            warnings: byCode(result?.warnings),
          });
          console.log(
            `${n ? 'FAIL' : 'ok  '} ${name}: ${result?.checked ?? 0} checked, ${n} failures ${n ? JSON.stringify(byCode(result.failures)) : ''}, warnings ${JSON.stringify(byCode(result?.warnings))}`,
          );
          for (const nodeId of forced)
            await send('CSS.forcePseudoState', {
              nodeId,
              forcedPseudoClasses: [],
            });
        }
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      }
    }
  }
}
writeFileSync(
  join(out, 'summary.json'),
  JSON.stringify({ failed, runs: summary }, null, 2),
);
await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(
  () => undefined,
);
await new Promise((r) => {
  ws.addEventListener('close', r, { once: true });
  ws.close();
  setTimeout(r, 1000);
});
proc?.kill();
await new Promise((r) => (server ? server.close(() => r()) : r()));
process.exitCode = failed ? 1 : 0;
// Let the sockets finish closing before Node exits (an abrupt exit trips libuv on Windows).
setTimeout(() => process.exit(process.exitCode), 200);
