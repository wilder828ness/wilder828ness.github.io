/** @type {import('tailwindcss').Config} */
// Nubz Toys — Tailwind build config.
//
// Replaces the Tailwind Play CDN (cdn.tailwindcss.com), which shipped the whole
// compiler to the browser on every page load. Tailwind's own docs: the Play CDN
// is "designed for development purposes only, and is not intended for production."
// Google Search Console was reporting it as a failed page resource
// ("Redirection error"), so Googlebot was rendering pages without their styles.
//
// CONTENT GLOBS — why these five:
//   './*.html'              index.html (the SPA) + the pages generate.js writes
//   './products/**/*.html'  generated product pages
//   './categories/**/*.html' generated category pages
//   './js/**/*.js'          google-reviews.js and any future front-end script
//   './generate.js'         the templates themselves — belt AND braces, so a class
//                           is found even if a page happens not to be generated
//
// The build runs `node generate.js` FIRST, so the generated HTML already exists on
// disk when Tailwind scans. Verified 2026-09-17: every class name in this codebase
// is a literal string — there is no `'bg-' + color` style concatenation anywhere —
// so static scanning finds all of them.
module.exports = {
  content: [
    './*.html',
    './products/**/*.html',
    './categories/**/*.html',
    './js/**/*.js',
    './generate.js',
  ],
  // Safelist: classes that are correct but that a scanner could plausibly miss if
  // the markup that uses them is ever moved into a template literal built at runtime.
  // Cheap insurance — these are a few hundred bytes.
  safelist: [
    'bg-slate-950', 'text-slate-200', 'bg-emerald-600/20', 'text-emerald-400',
    'bg-blue-500/20', 'text-blue-300', 'bg-purple-500/20', 'text-purple-300',
    'bg-slate-700', 'text-slate-300',
  ],
  theme: { extend: {} },
  plugins: [],
};
