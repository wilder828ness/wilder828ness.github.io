#!/usr/bin/env node
/*
 * verify-css.js — build-time guard for the compiled Tailwind stylesheet.
 *
 * WHY THIS EXISTS: the site's entire visual layer now depends on one generated
 * file. If Tailwind ever produces an empty or truncated stylesheet (a bad content
 * glob, a version bump, a partial write), the pages would still deploy — and
 * nubztoys.com would go live as unstyled HTML without anyone noticing.
 *
 * This script fails the build instead. A failed build on Vercel does NOT take the
 * site down: the previous production deployment keeps serving. Broken CSS can
 * therefore never reach a customer.
 */
const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'css', 'tailwind.css');
const MIN_BYTES = 10 * 1024;

// Sentinels: the highest-frequency classes in the codebase, one per risk category.
// If any of these is missing, the scan went wrong and the page will look broken.
const SENTINELS = [
  { sel: '.bg-slate-950',       why: 'page background on every page' },
  { sel: '.text-slate-300',     why: 'body text colour' },
  { sel: '.bg-slate-900',       why: 'card background' },
  { sel: '.border-slate-800',   why: 'card borders' },
  { sel: '.rounded-3xl',        why: 'card shape' },
  { sel: '.max-w-6xl',          why: 'page container width' },
  { sel: '.mx-auto',            why: 'page centring' },
  { sel: '.text-cyan-400',      why: 'brand accent / link colour' },
  { sel: 'hover\\:text-cyan-400', why: 'hover variant compiled' },
  { sel: '.text-\\[11px\\]',    why: 'arbitrary-value (JIT) classes compiled' },
];

function fail(msg) {
  console.error('\n❌  CSS VERIFY FAILED — ' + msg);
  console.error('   Build stopped on purpose. Vercel will keep the previous');
  console.error('   production deployment live, so nubztoys.com is unaffected.\n');
  process.exit(1);
}

if (!fs.existsSync(CSS)) fail('css/tailwind.css was not produced by the build.');

const css = fs.readFileSync(CSS, 'utf8');
const bytes = Buffer.byteLength(css);

if (bytes < MIN_BYTES) {
  fail(`css/tailwind.css is only ${bytes} bytes (expected at least ${MIN_BYTES}). ` +
       'That usually means the content globs in tailwind.config.js matched nothing.');
}

const missing = SENTINELS.filter(s => !css.includes(s.sel));
if (missing.length) {
  fail('compiled CSS is missing expected classes:\n' +
       missing.map(m => `     ${m.sel.replace(/\\/g, '')}  (${m.why})`).join('\n'));
}

console.log(`✅  CSS verify passed — css/tailwind.css, ${(bytes / 1024).toFixed(1)} KB, all ${SENTINELS.length} sentinels present.`);
