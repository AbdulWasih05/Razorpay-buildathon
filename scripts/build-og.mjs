/**
 * Builds the social card and the favicons.
 *
 *   node scripts/build-og.mjs
 *
 * Outputs into `apps/ui/public/`, which Vite copies to `dist/` and the Fastify
 * process serves from the same origin as everything else.
 *
 * **No number on the card is written by hand.** The stats are parsed out of the
 * committed `eval/results.md`, for the same reason the landing page renders its
 * Headline table from that file rather than restating it (D-041): a figure
 * duplicated by hand is a figure that goes stale silently, and this one ends up
 * in link previews where nobody will ever diff it.
 *
 * Two numbers are deliberately NOT on the card. `eval/results.md` says plainly
 * that zero false positives "is partly a statement about the corpus, not only
 * about the gate" and instructs that ₹0 is never quoted without that sentence.
 * A social card has no room for the sentence, so it does not quote the number --
 * the honest move is to omit it rather than to strip its caveat. What is shown
 * instead is recall and the dev-to-held-out shift, which is the figure this
 * project actually stakes its credibility on.
 *
 * Rendering uses the Chrome already on the machine over CDP; there is no new
 * npm dependency, and no headless-browser package enters the lockfile for one
 * static asset.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'apps/ui/public');
const FONTS = join(ROOT, 'apps/ui/src/fonts');
const TMP = join(ROOT, '.og-tmp');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error(`no Chrome found; set CHROME_PATH. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`);

// ---------------------------------------------------------------------------
// The numbers, read from the committed report
// ---------------------------------------------------------------------------

const report = readFileSync(join(ROOT, 'eval/results.md'), 'utf8');

/** One row of the Headline table: `| metric | dev | held-out | shift |`. */
function headline(metric) {
  const row = report
    .split('\n')
    .find((line) => line.startsWith('|') && line.slice(1).trim().startsWith(metric));
  if (!row) throw new Error(`eval/results.md has no headline row for "${metric}"`);
  const cells = row.split('|').slice(1, -1).map((c) => c.trim());
  return { dev: cells[1], ood: cells[2], shift: cells[3] };
}

const disputes = headline('disputes');
const recall = headline('recall on winnable');

/** `31/38 = 81.6%` -> `81.6%`. */
const pct = (cell) => cell.split('=').pop().trim();

const STATS = [
  { value: pct(recall.dev), label: 'recall · dev' },
  { value: pct(recall.ood), label: 'recall · held-out' },
  { value: recall.shift, label: 'distribution shift' },
  { value: `${disputes.dev} + ${disputes.ood}`, label: 'disputes scored' },
];


console.log('parsed from eval/results.md:');
for (const s of STATS) console.log(`  ${s.value.padEnd(10)} ${s.label}`);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const b64 = (p) => readFileSync(p).toString('base64');
const inter = b64(join(FONTS, 'inter-latin-variable.woff2'));
const mono = b64(join(FONTS, 'jetbrains-mono-latin-variable.woff2'));

/* The landing page's dark register, verbatim from apps/ui/src/landing.css. The
   card is a crop of that page's world, not a second visual language. */
const C = {
  bg: '#0f0e0c',
  raised: '#171512',
  line: '#2a2622',
  lineStrong: '#3d3730',
  ink: '#f6f3ef',
  ink2: '#c6bfb5',
  ink3: '#8d8579',
  ink4: '#5f5850',
  accent: '#9ba1ff',
  accentDim: '#6f76e0',
};

const fontFaces = `
  @font-face { font-family: 'Inter'; src: url(data:font/woff2;base64,${inter}) format('woff2');
               font-weight: 100 900; font-display: block; }
  @font-face { font-family: 'JetBrains Mono'; src: url(data:font/woff2;base64,${mono}) format('woff2');
               font-weight: 100 800; font-display: block; }`;

const ogHtml = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
${fontFaces}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: ${C.bg}; color: ${C.ink};
    font-family: 'Inter', system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column;
    padding: 58px 66px 46px;
  }
  .mark { display: inline-flex; gap: 4px; align-items: center; }
  .mark i { border-radius: 2px; background: ${C.accent}; display: block; }
  .mark i.hollow { background: transparent; box-shadow: inset 0 0 0 2px ${C.accentDim}; }

  header { display: flex; align-items: center; gap: 14px; }
  .wordmark { font-size: 25px; font-weight: 600; letter-spacing: -0.01em; }
  .divider { width: 1px; height: 19px; background: ${C.lineStrong}; }
  .thin {
    font-family: 'JetBrains Mono', monospace; font-size: 13px;
    letter-spacing: 0.16em; text-transform: uppercase; color: ${C.ink3};
  }

  h1 {
    margin-top: 46px;
    font-size: 51px; line-height: 1.13; font-weight: 600; letter-spacing: -0.022em;
    max-width: 21ch;
  }
  /* Its own line, as on the landing page: the second clause is the turn in the
     argument, and starting it mid-line buries that. */
  h1 .dim { display: block; color: ${C.ink3}; font-weight: 500; }

  .lede {
    margin-top: 22px; font-size: 20px; line-height: 1.5;
    color: ${C.ink2}; max-width: 62ch;
  }

  .stats {
    margin-top: auto; display: grid; grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid ${C.line}; padding-top: 24px;
  }
  .stat { padding-right: 22px; }
  .stat + .stat { border-left: 1px solid ${C.line}; padding-left: 26px; }
  .stat .v {
    font-family: 'JetBrains Mono', monospace; font-size: 34px; font-weight: 500;
    letter-spacing: -0.02em; color: ${C.ink};
  }
  .stat:nth-child(3) .v { color: ${C.accent}; }
  .stat .l {
    margin-top: 9px; font-family: 'JetBrains Mono', monospace; font-size: 12px;
    letter-spacing: 0.1em; text-transform: uppercase; color: ${C.ink4};
  }

  footer {
    margin-top: 26px; padding-top: 20px; border-top: 1px solid ${C.line};
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: 'JetBrains Mono', monospace; font-size: 13.5px; color: ${C.ink3};
  }
  footer .right { color: ${C.ink4}; }
</style></head>
<body>
  <header>
    <span class="mark"><i></i><i></i><i></i><i class="hollow"></i></span>
    <span class="wordmark">Praman</span>
    <span class="divider"></span>
    <span class="thin">defense only</span>
  </header>

  <h1>Agentic evidence is captured at transaction&nbsp;time.
      <span class="dim">By dispute time it is gone.</span></h1>

  <p class="lede">Dispute defense for agent-initiated payments. A deterministic
     gate decides contest-or-abstain; only a named human can submit.</p>

  <div class="stats">
    ${STATS.map(
      (s) => `<div class="stat"><div class="v">${s.value}</div><div class="l">${s.label}</div></div>`,
    ).join('\n    ')}
  </div>

  <footer>
    <span>praman-zif9.onrender.com</span>
    <span class="right">Agentic Dispute Defense</span>
  </footer>
</body></html>`;

/* The favicon is the product mark compacted to a 2x2 quadrant. The header lays
   the four squares in a row, which at 16px collapses into an unreadable dash;
   the quadrant keeps "three filled, one hollow" legible at tab size. The tile
   carries the page's own ground so the mark reads on a light or a dark tab bar
   rather than only one of them. */
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Praman">
  <rect width="64" height="64" rx="14" fill="${C.bg}" />
  <rect x="14" y="14" width="16" height="16" rx="3.5" fill="${C.accent}" />
  <rect x="34" y="14" width="16" height="16" rx="3.5" fill="${C.accent}" />
  <rect x="14" y="34" width="16" height="16" rx="3.5" fill="${C.accent}" />
  <rect x="35.75" y="35.75" width="12.5" height="12.5" rx="2.5" fill="none"
        stroke="${C.accentDim}" stroke-width="3.5" />
</svg>
`;

// ---------------------------------------------------------------------------
// Render over CDP
// ---------------------------------------------------------------------------

mkdirSync(PUBLIC, { recursive: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, 'og.html'), ogHtml);
writeFileSync(join(PUBLIC, 'favicon.svg'), faviconSvg);
/* A 16px-only variant. The hollow square's stroke is 3.5 units at a 64-unit
   viewBox, which is well under a pixel once the tile is 16px across -- it
   greys into a smudge and the mark stops reading as three-plus-one. At that
   size the fourth square is simply drawn dim and solid instead, which keeps
   the same "one of these is not like the others" without relying on a stroke
   the raster cannot hold. 32px and up use the real mark. */
const faviconSvgSmall = faviconSvg.replace(
  /<rect x="35.75"[\s\S]*?\/>/,
  `<rect x="34" y="34" width="16" height="16" rx="3.5" fill="${C.accentDim}" opacity="0.55" />`,
);

const iconPage = (svg) => `<!doctype html><meta charset="utf-8">
<style>*{margin:0;padding:0}html,body{width:512px;height:512px;background:transparent}
svg{width:512px;height:512px;display:block}</style>${svg}`;

writeFileSync(join(TMP, 'favicon.html'), iconPage(faviconSvg));
writeFileSync(join(TMP, 'favicon-small.html'), iconPage(faviconSvgSmall));

const port = 9444;
const chromeArgs = [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(TMP, 'profile')}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  'about:blank',
];

const { spawn } = await import('node:child_process');
const proc = spawn(chrome, chromeArgs, { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('headless Chrome never opened a debugging port');
}

const wsUrl = await endpoint();
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => (ws.onopen = resolve));

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`CDP timeout ${method}`))), 20000);
  });

await send('Page.enable');

async function shoot(file, width, height, out, scale = 2) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: false,
  });
  await send('Page.navigate', { url: `file:///${join(TMP, file).replace(/\\/g, '/')}` });
  await sleep(900); // let the embedded fonts settle before the shutter
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale },
  });
  writeFileSync(out, Buffer.from(data, 'base64'));
}

await shoot('og.html', 1200, 630, join(TMP, 'og@2x.png'));
await shoot('favicon.html', 512, 512, join(TMP, 'icon@1x.png'), 1);
await shoot('favicon-small.html', 512, 512, join(TMP, 'icon-small@1x.png'), 1);

ws.close();
proc.kill();
await sleep(400);

// Downsample the 2x card to its delivery size; scrapers want exactly 1200x630.
execFileSync('ffmpeg', [
  '-v', 'error', '-y', '-i', join(TMP, 'og@2x.png'),
  '-vf', 'scale=1200:630:flags=lanczos', join(PUBLIC, 'og.png'),
]);

for (const size of [16, 32, 48, 180, 512]) {
  const name = size === 180 ? 'apple-touch-icon.png' : `favicon-${size}.png`;
  const source = size <= 16 ? 'icon-small@1x.png' : 'icon@1x.png';
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', join(TMP, source),
    '-vf', `scale=${size}:${size}:flags=lanczos`, join(PUBLIC, name),
  ]);
}

/* A .ico is just a directory of images, and since Vista each entry may be a
   whole PNG -- so the three PNGs already rendered can be packed directly
   instead of pulling in an encoder. */
function buildIco(files) {
  const images = files.map(({ size, path }) => ({ size, buf: readFileSync(path) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]);
}

writeFileSync(
  join(PUBLIC, 'favicon.ico'),
  buildIco([16, 32, 48].map((size) => ({ size, path: join(PUBLIC, `favicon-${size}.png`) }))),
);

/* Chrome can still hold a lock on its own profile for a moment after exit, and
   a failed cleanup must not fail a build whose artifacts are already written. */
for (let i = 0; i < 10; i += 1) {
  try {
    rmSync(TMP, { recursive: true, force: true });
    break;
  } catch {
    await sleep(300);
  }
}

console.log('\nwrote apps/ui/public/:');
for (const f of ['og.png', 'favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'favicon-512.png']) {
  console.log(`  ${f}`);
}
