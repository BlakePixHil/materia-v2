#!/usr/bin/env node
/**
 * Render-overflow harness for the screens gallery (DES-01).
 *
 * Opens design/mockups/screens.html in Chromium at 1440, 1024 and 390px wide, in light and dark, and fails if
 *  - the page scrolls sideways, or
 *  - any visible element in a screen sits outside its frame (the screen itself, or a nested app, tablet or phone frame).
 * Elements are measured after clipping by their overflow-hidden ancestors, so intended truncation (ellipsis,
 * scrolling lists) passes and anything that spills past a frame edge fails.
 *
 * Run (after `python3 design/system/build.py`):
 *   node design/system/check.mjs                       # check
 *   node design/system/check.mjs --write-heights       # also record each screen's height at 1440 in screen-heights.json
 *   node design/system/check.mjs --shots <dir>         # also save a PNG of every screen at 1440, light and dark
 * Chromium: set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (or CHROMIUM_PATH) to use a pre-installed browser.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const GALLERY = join(HERE, '..', 'mockups', 'screens.html');
const FONTS = join(HERE, 'project', 'fonts');
const WIDTHS = [1440, 1024, 390];
const SCHEMES = ['light', 'dark'];

const { values: args } = parseArgs({ options: { 'write-heights': { type: 'boolean' }, shots: { type: 'string' } } });

// The gallery loads Geist from Google Fonts; serve the self-hosted files instead so runs are offline and repeatable.
const font = (file) => readFileSync(join(FONTS, file)).toString('base64');
const FONT_CSS = [
  ['Geist', 'Geist-Variable.woff2'],
  ['Geist Mono', 'GeistMono-Variable.woff2'],
]
  .map(([fam, file]) => `@font-face{font-family:"${fam}";src:url(data:font/woff2;base64,${font(file)}) format("woff2");font-weight:100 900}`)
  .join('');

/** Runs in the page: every overflow in every screen, as readable strings. */
function findOverflows() {
  // Screens and device frames, plus the containers whose edge content must never cross.
  const FRAME = '.mt-app, .mt-phone, .mt-onboard, [data-frame], .mt-card, .mt-clerk-card, .mt-setting, .mt-integration, .mt-dialog, .mt-menu, .mt-notif';
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}>${text ? ` "${text}"` : ''}`;
  };
  const out = [];
  for (const shot of document.querySelectorAll('.shot')) {
    const root = shot.querySelector('.stage > .mt');
    if (!root) continue;
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      // The body of a closed <details> (the charts' table views) isn't rendered, whatever its box says.
      const shut = el.parentElement.closest('details:not([open])');
      if (shut && !el.closest('summary')) continue;
      let r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      let left = r.left, right = r.right, top = r.top, bottom = r.bottom;
      const frameEl = el.parentElement.closest(FRAME) && root.contains(el.parentElement.closest(FRAME)) ? el.parentElement.closest(FRAME) : root;
      // Clip by every ancestor between the element and its frame that hides overflow.
      for (let a = el.parentElement; a && a !== frameEl; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.overflowX !== 'visible' || acs.overflowY !== 'visible') {
          const ar = a.getBoundingClientRect();
          if (acs.overflowX !== 'visible') { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
          if (acs.overflowY !== 'visible') { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
        }
      }
      if (right - left < 1 || bottom - top < 1) continue;
      const f = frameEl.getBoundingClientRect();
      const tol = 1;
      const over = [];
      if (left < f.left - tol) over.push(`left ${Math.round(f.left - left)}px`);
      if (right > f.right + tol) over.push(`right ${Math.round(right - f.right)}px`);
      if (top < f.top - tol) over.push(`top ${Math.round(f.top - top)}px`);
      if (bottom > f.bottom + tol) over.push(`bottom ${Math.round(bottom - f.bottom)}px`);
      if (over.length) out.push(`${shot.id}: ${describe(el)} overflows ${frameEl === root ? 'the screen' : describe(frameEl).slice(0, 40)} (${over.join(', ')})`);
    }
  }
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways (${doc.scrollWidth}px content in ${doc.clientWidth}px)`);
  return out;
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH || undefined,
});
let failures = 0;
const heights = {};
try {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
      await page.goto(pathToFileURL(GALLERY).href);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      const problems = await page.evaluate(findOverflows);
      const screens = await page.locator('.shot').count();
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${String(width).padStart(4)}px ${scheme.padEnd(5)} · ${screens} screens${problems.length ? ` · ${problems.length} overflows` : ''}`);
      for (const p of problems.slice(0, 40)) console.log(`       ${p}`);
      if (problems.length > 40) console.log(`       … and ${problems.length - 40} more`);
      failures += problems.length;

      if (width === 1440 && scheme === 'light' && args['write-heights']) {
        for (const [name, h] of await page.$$eval('.shot', (shots) => shots.map((s) => [s.querySelector('h2').textContent, s.querySelector('.stage > .mt').offsetHeight]))) heights[name] = h;
      }
      if (width === 1440 && args.shots) {
        // Actual size, unclipped by the gallery's scrolling stage.
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.evaluate(() => document.querySelector('.zoom button[data-fit="0"]').click());
        await page.addStyleTag({ content: '.stage{overflow:visible!important;height:auto!important}' });
        mkdirSync(args.shots, { recursive: true });
        for (const id of await page.$$eval('.shot', (s) => s.map((x) => x.id))) {
          await page.locator(`#${id} .stage > .mt`).screenshot({ path: join(args.shots, `${id}-${scheme}.png`) });
        }
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (args['write-heights']) {
  const file = join(HERE, 'screen-heights.json');
  writeFileSync(file, JSON.stringify(heights, null, 1) + '\n');
  console.log(`wrote ${Object.keys(heights).length} heights to screen-heights.json; run build.py again`);
}
console.log(failures ? `${failures} overflows` : 'No overflow at 1440, 1024 or 390, light or dark.');
process.exit(failures ? 1 : 0);
