/**
 * generate.js — Nubz Toys & Collectibles static SEO page generator
 * -----------------------------------------------------------------
 * Runs at BUILD TIME on Vercel (and locally). It pulls the live product
 * catalog from Supabase, then writes real, crawlable HTML pages:
 *
 *   /products/<slug>.html     one page per product  (Product schema)
 *   /categories/<slug>.html   one page per category (ItemList schema)
 *   /sitemap.xml              every real URL
 *   /robots.txt              points crawlers at the sitemap
 *   /products.json           a JSON snapshot of the catalog
 *
 * The single-page app (index.html), the admin panel, Supabase and Stripe
 * checkout are all left untouched. These generated pages give Google
 * something to index per product — and each one can take an order via the
 * existing /api/create-checkout function.
 *
 * Re-run on every deploy. Add a product in the admin panel -> redeploy ->
 * a new indexable page appears automatically.
 */

const fs = require('fs');
const path = require('path');

// ── CONFIG ─────────────────────────────────────────────────────────────
const SITE         = 'https://nubztoys.com';
const SITE_NAME    = 'Nubz Toys & Collectibles';
const SUPABASE_URL = process.env.SUPABASE_URL      || 'https://vdkjjyjfwfndrksruisn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_MUbT8VJ6HKCa1pNUgZYjuA_wzXzECNr';
const SKIP_SUPABASE = process.env.SKIP_SUPABASE === '1';
// Set GA_MEASUREMENT_ID in Vercel env vars to turn on Google Analytics on the
// generated product/category pages. Left empty = no tracking script emitted.
const GA_ID = process.env.GA_MEASUREMENT_ID || 'G-3C0EDZG38D';
const GA_SNIPPET = GA_ID ? `  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');gtag('config','AW-18266305787');</script>` : '';

const ROOT           = __dirname;
const PRODUCTS_DIR   = path.join(ROOT, 'products');
const CATEGORIES_DIR = path.join(ROOT, 'categories');
const LOGO           = '/nubz-header-logo.png';

const SOCIAL = {
  facebook:  'https://facebook.com/nubztoys',
  instagram: 'https://instagram.com/nubz_toys',
  youtube:   'https://youtube.com/@nubztoys',
  whatnot:   'https://www.whatnot.com/user/wildernessdealz',
};

// Canonical categories (match the storefront) + aliases for messy source data.
// Edit this map if your admin uses different category names.
const CATEGORY_ALIASES = {
  'bulk': 'Bulk',
  'case': 'Bulk',
  'cases': 'Bulk',
  'by the case': 'Bulk',
  'funko': 'Funko Pop',
  'funko pops': 'Funko Pop',
  'funko pop': 'Funko Pop',
  'model kit': 'Model Sets',
  'model kits': 'Model Sets',
  'model set': 'Model Sets',
  'model sets': 'Model Sets',
  'blind bag': 'Blind Bag & Mini Figures',
  'blind bags': 'Blind Bag & Mini Figures',
  'blind bag & mini figures': 'Blind Bag & Mini Figures',
  'blind bags & mini figures': 'Blind Bag & Mini Figures',
  'mini figures': 'Blind Bag & Mini Figures',
  'action figure': 'Action Figures',
  'action figures': 'Action Figures',
  'collectible': 'Collectibles',
  'collectibles': 'Collectibles',
  'toy': 'Toys',
  'toys': 'Toys',
};
// normalize a category string for fuzzy matching: lowercase, "&"->"and",
// strip plurals/punctuation, collapse whitespace
const catKey = (c) => String(c || '')
  .toLowerCase().replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').map(w => w.replace(/s$/, '')).join(' ');
const ALIAS_BY_KEY = Object.fromEntries(
  Object.entries(CATEGORY_ALIASES).map(([k, v]) => [catKey(k), v]));
const canonicalCat = (c) => ALIAS_BY_KEY[catKey(c)] || String(c || '').trim();

// Hand-written, keyword-rich category descriptions (better than a generic template).
// Falls back to a template for any category not listed here.
const CATEGORY_DESC = {
  'Funko Pop': 'Funko Pop! vinyl figures spanning Marvel, Star Wars, horror, anime and WWE — plus store and convention exclusives.',
  'Action Figures': 'Collectible action figures from Transformers, DC, Marvel, McFarlane and more — new in box and ready to display.',
  'Model Sets': 'Snap-together model kits and building sets, including Blokees Transformers — no glue required, great for all ages.',
  'Blind Bag & Mini Figures': 'Blind bags, mystery minis and 3D foam bag clips — surprise collectibles to open, trade and hunt down.',
  'Toys': 'Die-cast cars, card games and playtime favorites for kids and collectors alike.',
  'Collectibles': 'Hard-to-find collectibles, exclusives and display pieces for the serious collector.',
  'Bulk': 'Buy by the case and save — sealed cases and multi-packs at bulk pricing, perfect for resellers and serious collectors.',
};

// ── HELPERS ────────────────────────────────────────────────────────────
const slugify = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'item';

// HTML-escape for text nodes / attributes
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Build a clean meta description: drop the "Keywords:" tail, collapse space, trim.
const metaFrom = (desc, fallback) => {
  let t = String(desc || '').split(/keywords:/i)[0].replace(/\s+/g, ' ').trim();
  if (!t) t = fallback;
  if (t.length > 158) t = t.slice(0, 155).replace(/\s+\S*$/, '') + '…';
  return t;
};

const firstImage = (p) => (p.images && p.images[0]) ||
  'https://placehold.co/800x800/0f172a/22d3ee?text=Nubz+Toys';

const inStock = (p) => {
  const s = String(p.status || '').toLowerCase();
  const qty = Number(p.quantity);
  if (s.includes('sold') || s.includes('out')) return false;
  if (!isNaN(qty) && qty <= 0) return false;
  return true;
};

// Four marketable states: in_stock | in_transit (pre-order) | on_order (coming soon) | sold_out
const availState = (p) => {
  const s = String(p.status || '').toLowerCase().replace(/\s+/g, '');
  const qty = Number(p.quantity);
  if (s === 'onorder') return 'on_order';
  if (s === 'intransit') return 'in_transit';   // pre-order: available even with 0 on hand
  if (s.includes('sold') || s.includes('out')) return 'sold_out';
  if (!isNaN(qty) && qty <= 0) return 'sold_out';
  return 'in_stock';
};

const price = (p) => {
  const n = Number(p.price);
  return isNaN(n) ? null : n;
};

// Supabase stores categories/images as comma-separated strings — match the app.
function normalize(p) {
  const toArr = (v) => typeof v === 'string'
    ? v.split(',').map(x => x.trim()).filter(Boolean)
    : (Array.isArray(v) ? v.filter(Boolean) : []);
  // Images may contain base64 "data:" URLs (which include commas), so split
  // only before a new http/data entry. Prefer real URLs over base64 for SEO.
  const imgs = (typeof p.images === 'string'
    ? p.images.split(/\s*,\s*(?=https?:\/\/|data:)/)
    : (Array.isArray(p.images) ? p.images : []))
    .map(s => String(s).trim()).filter(Boolean);
  const httpFirst = [...imgs.filter(u => /^https?:/.test(u)), ...imgs.filter(u => !/^https?:/.test(u))];
  const cats = [...new Set(toArr(p.categories).map(canonicalCat).filter(Boolean))];
  return { ...p, categories: cats, images: httpFirst };
}

// ── GROUPED ITEMS (variety picker) ─────────────────────────────────────
// Items that share a `group_key` render as ONE card on listing grids (with an
// "N options" badge) and each of their product pages shows a variety picker so
// a shopper can switch between varieties without leaving the page. Standalone
// items (no group_key) are completely unaffected — every existing product keeps
// behaving exactly as before. This is a display layer only: each variety is
// still its own product row with its own SKU/price/stock, so checkout and the
// inventory webhook are untouched.
const groupKeyOf = (p) => {
  const k = (p && p.group_key != null) ? String(p.group_key).trim() : '';
  return k || null;
};
// Order siblings for the picker: group_sort ascending (0 = the card face shown
// before a pick), then name. Missing sort sinks to the end.
function sortGroup(items) {
  return items.slice().sort((a, b) => {
    const sa = (a.group_sort == null || a.group_sort === '') ? 9999 : Number(a.group_sort);
    const sb = (b.group_sort == null || b.group_sort === '') ? 9999 : Number(b.group_sort);
    if (sa !== sb) return sa - sb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}
// Collapse a listing so each group shows once, at the position of its first
// member (preserves the incoming order), represented by its group_sort=0 item.
// Tags the representative with `_variantCount` so the card can badge it.
function collapseGroups(items) {
  const membersByKey = {};
  for (const p of items) {
    const k = groupKeyOf(p);
    if (k) (membersByKey[k] = membersByKey[k] || []).push(p);
  }
  const seen = {}; const out = [];
  for (const p of items) {
    const k = groupKeyOf(p);
    if (!k) { out.push(p); continue; }
    if (seen[k]) continue;
    seen[k] = true;
    const rep = sortGroup(membersByKey[k])[0];
    rep._variantCount = membersByKey[k].length;
    out.push(rep);
  }
  return out;
}
// All siblings of p (including p) that share its group_key, ordered for the picker.
function groupMembers(p, all) {
  const k = groupKeyOf(p);
  if (!k) return [];
  return sortGroup(all.filter(x => groupKeyOf(x) === k));
}
// "N options" badge for a collapsed representative card.
const variantBadge = (p) => (p && p._variantCount > 1)
  ? `<span class="absolute top-2 right-2 z-10 bg-cyan-500 text-black text-[11px] font-bold px-2 py-0.5 rounded-full shadow">${p._variantCount} options</span>`
  : '';

// Neutral "not yet reviewed" state — visual only, NO rating schema (a 0-rating
// aggregateRating can itself trip Merchant Center). Replaces the old Whatnot claim.
const noReviews = `<div class="text-[11px] text-slate-600 mt-1" aria-label="No reviews yet"><span class="tracking-tight">☆☆☆☆☆</span> No reviews yet</div>`;

// ── DATA SOURCE ────────────────────────────────────────────────────────
async function getProducts() {
  if (!SKIP_SUPABASE) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/products?select=*&order=created_at.desc`;
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!res.ok) throw new Error('Supabase HTTP ' + res.status);
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        console.log(`✅ Pulled ${data.length} products from Supabase`);
        return data.map(normalize);
      }
      console.warn('⚠️  Supabase returned no rows — falling back to products.json');
    } catch (e) {
      console.warn('⚠️  Supabase fetch failed (' + e.message + ') — falling back to products.json');
    }
  }
  // Fallback: local snapshot so a build never produces an empty site.
  const local = path.join(ROOT, 'products.json');
  if (fs.existsSync(local)) {
    const data = JSON.parse(fs.readFileSync(local, 'utf8'));
    console.log(`📄 Loaded ${data.length} products from products.json`);
    return data.map(normalize);
  }
  throw new Error('No product data available from Supabase or products.json');
}

// ── SHARED CHROME (header/footer) ──────────────────────────────────────
const head = ({ title, desc, canonical, image, type = 'website', jsonld = [] }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="${type}">
  <meta property="og:site_name" content="${esc(SITE_NAME)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${esc(image)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${esc(image)}">
${GA_SNIPPET}
  <script defer src="/_vercel/insights/script.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    html { -webkit-text-size-adjust: 100%; }
    html, body { overflow-x: hidden; }
    body { font-family: 'Inter', system-ui, sans-serif; min-height: 100%; }
    .gradient-title { background: linear-gradient(to right,#22d3ee,#e879f9,#fbbf24);
      -webkit-background-clip:text; -webkit-text-fill-color:transparent;
      line-height:1.15; padding-bottom:0.12em; }
    .compare-price { text-decoration: line-through; color:#64748b; }
  </style>
${jsonld.map(j => `  <script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body class="bg-slate-950 text-slate-200">
  <nav class="border-b border-slate-800 bg-slate-950/95">
    <div class="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
      <a href="/" class="flex items-center gap-x-3"><img src="${LOGO}" alt="${esc(SITE_NAME)}" class="h-14 w-auto"></a>
      <div class="flex items-center gap-x-6">
        <div class="hidden md:flex items-center gap-x-8 text-sm font-medium">
          <a href="/" class="hover:text-cyan-400">Home</a>
          <a href="/categories" class="hover:text-cyan-400">Categories</a>
          <a href="/inventory" class="hover:text-cyan-400">All Inventory</a>
          <a href="/about" class="hover:text-cyan-400">About</a>
          <a href="/contact" class="hover:text-cyan-400">Contact</a>
          <a href="/blog" class="hover:text-cyan-400">Blog</a>
        </div>
        <a href="/?checkout=1" aria-label="View cart" class="inline-flex items-center gap-x-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-3xl text-sm">
          <i class="fa-solid fa-shopping-bag"></i>
          <span id="navCartCount" class="font-mono text-xs bg-slate-800 px-2 py-0.5 rounded-full">0</span>
        </a>
      </div>
    </div>
  </nav>`;

const footer = () => `
  <footer class="border-t border-slate-800 mt-20">
    <div class="max-w-7xl mx-auto px-6 py-12 text-sm text-slate-400">
      <div class="flex flex-wrap items-start justify-between gap-8 mb-8">
        <div>
          <img src="${LOGO}" alt="${esc(SITE_NAME)}" class="h-10 w-auto mb-3">
          <p>Action figures, Funko, blind bags &amp; more — shipped fast from the USA.</p>
          <div class="flex items-center gap-x-5 text-xl mt-4">
            <a href="${SOCIAL.facebook}"  target="_blank" rel="noopener noreferrer" aria-label="Nubz Toys on Facebook"  class="hover:text-cyan-400"><i class="fa-brands fa-facebook"></i></a>
            <a href="${SOCIAL.instagram}" target="_blank" rel="noopener noreferrer" aria-label="Nubz Toys on Instagram" class="hover:text-cyan-400"><i class="fa-brands fa-instagram"></i></a>
            <a href="${SOCIAL.youtube}"   target="_blank" rel="noopener noreferrer" aria-label="Nubz Toys on YouTube"   class="hover:text-cyan-400"><i class="fa-brands fa-youtube"></i></a>
            <a href="${SOCIAL.whatnot}"   target="_blank" rel="noopener noreferrer" aria-label="Wilderness Dealz on Whatnot" class="hover:text-cyan-400"><i class="fa-solid fa-tower-broadcast"></i></a>
          </div>
        </div>
        <div class="flex flex-wrap gap-x-12 gap-y-6 text-sm">
          <div>
            <p class="font-semibold text-slate-300 mb-3 uppercase tracking-widest text-xs">Shop</p>
            <ul class="space-y-2">
              <li><a href="/categories" class="hover:text-white">Categories</a></li>
              <li><a href="/inventory" class="hover:text-white">All Inventory</a></li>
              <li><a href="/categories/funko-pop" class="hover:text-white">Funko Pop</a></li>
              <li><a href="/categories/action-figures" class="hover:text-white">Action Figures</a></li>
              <li><a href="/categories/blind-bag-and-mini-figures" class="hover:text-white">Blind Bags</a></li>
              <li><a href="/categories/model-sets" class="hover:text-white">Model Sets</a></li>
            </ul>
          </div>
          <div>
            <p class="font-semibold text-slate-300 mb-3 uppercase tracking-widest text-xs">Company</p>
            <ul class="space-y-2">
              <li><a href="/about" class="hover:text-white">About Us</a></li>
              <li><a href="/contact" class="hover:text-white">Contact</a></li>
              <li><a href="/shipping" class="hover:text-white">Shipping</a></li>
              <li><a href="/privacy-policy" class="hover:text-white">Privacy Policy</a></li>
              <li><a href="/returns" class="hover:text-white">Returns &amp; Exchanges</a></li>
            </ul>
          </div>
          <div>
            <p class="font-semibold text-slate-300 mb-3 uppercase tracking-widest text-xs">Contact</p>
            <address class="not-italic space-y-1">
              <p>Wilderness Dealz LLC<br>dba Nubz Toys &amp; Collectibles</p>
              <p>125 Lexington Ave, Suite 101A PMB 187<br>Asheville, NC 28801</p>
              <p>Phone: <a href="tel:+18286494355" class="hover:text-white">828-649-4355</a></p>
              <p>WhatsApp: <a href="https://wa.me/18286494355" target="_blank" rel="noopener noreferrer" class="hover:text-white">@NubzTC</a></p>
              <p>Email: <a href="mailto:sales@nubztoys.com" class="hover:text-white">sales@nubztoys.com</a></p>
            </address>
          </div>
        </div>
      </div>
      <p class="text-xs text-slate-600 leading-relaxed mb-3">Nubz Toys &amp; Collectibles is a retailer of brand-new, 100% authentic, officially licensed merchandise sourced through authorized distributors. All product names, characters, logos, and brands are the property of their respective owners; their use here does not imply any affiliation with, or endorsement by, the manufacturers.</p>
      <p class="border-t border-slate-800 pt-6 text-xs text-slate-600">© ${new Date().getFullYear()} ${esc(SITE_NAME)} — a Wilderness Dealz LLC company. All rights reserved.</p>
    </div>
  </footer>
  <script>
    // Shared cart (same localStorage key as the storefront) — keep nav count in sync.
    (function(){
      try {
        var c = JSON.parse(localStorage.getItem('nubz_cart')) || [];
        var n = c.reduce(function(s,i){ return s + (i.quantity||1); }, 0);
        var el = document.getElementById('navCartCount');
        if (el) el.textContent = n;
      } catch(e) {}
    })();
  </script>
  <script defer src="/js/google-reviews.js"></script>
</body>
</html>`;

// ── PRODUCT PAGE ───────────────────────────────────────────────────────
function productPage(p, related, members) {
  members = members || [];
  const isGroup   = members.length > 1;
  const slug      = p.slug;
  const canonical = `${SITE}/products/${slug}`;
  const img       = firstImage(p);
  const pr        = price(p);
  const cmp       = Number(p.compare_to);
  const cat       = (p.categories[0] || 'Toys');
  const catSlug   = slugify(cat);
  const desc      = metaFrom(p.description, `${p.name} — available now at ${SITE_NAME}.`);
  const st        = availState(p);
  // Standalone: purchasable only if in stock / pre-order. Grouped: always show the
  // buy UI so a shopper who lands on a sold-out variety can still pick an in-stock
  // sibling; the buttons enable/disable in JS based on the selected variety.
  const available = (st === 'in_stock' || st === 'in_transit'); // purchasable (in stock or pre-order)
  const showBuyUI = available || isGroup;

  const productLd = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name,
    image: p.images.length ? p.images : [img],
    description: metaFrom(p.description, p.name),
    sku: p.sku || String(p.id || slug),
    brand: { '@type': 'Brand', name: p.brand || SITE_NAME },
    category: cat,
    offers: {
      '@type': 'Offer', url: canonical, priceCurrency: 'USD',
      ...(pr != null ? { price: pr.toFixed(2) } : {}),
      availability: st === 'in_stock' ? 'https://schema.org/InStock'
                  : (st === 'in_transit' || st === 'on_order') ? 'https://schema.org/PreOrder'
                  : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: SITE_NAME },
    },
  };
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: cat, item: `${SITE}/categories/${catSlug}` },
      { '@type': 'ListItem', position: 3, name: p.name, item: canonical },
    ],
  };

  const relatedHtml = related.length ? `
    <section class="max-w-6xl mx-auto px-6 mt-20">
      <h2 class="text-2xl font-bold mb-6 gradient-title inline-block">You might also like</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
        ${related.map(r => `
        <a href="/products/${r.slug}" class="block bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-cyan-500/50 transition">
          <img src="${esc(firstImage(r))}" alt="${esc(r.name)}" class="w-full aspect-square object-cover object-top" loading="lazy">
          <div class="p-3"><p class="text-sm font-medium line-clamp-2">${esc(r.name)}</p>
          ${price(r) != null ? `<p class="text-cyan-400 font-bold mt-1">$${price(r).toFixed(2)}</p>` : ''}</div>
        </a>`).join('')}
      </div>
    </section>` : '';

  const buyItem = JSON.stringify({
    id: p.id, sku: p.sku || '', name: p.name, price: pr || 0, images: p.images, quantity: 1, shipping_weight: p.shipping_weight || 0,
  });

  // Grouped-items variety picker: embed every sibling so selecting one swaps the
  // photo, price and Add-to-Cart target in place (no reload). Each variety is its
  // own product row, so the cart item / checkout / inventory path is unchanged.
  const groupData = members.map(m => {
    const mst = availState(m);
    return {
      id: m.id, sku: m.sku || '', name: m.name,
      label: (m.variant_label && String(m.variant_label).trim()) || m.name,
      price: price(m) || 0,
      compare_to: (!isNaN(Number(m.compare_to)) && Number(m.compare_to) > (price(m) || 0)) ? Number(m.compare_to) : null,
      img: firstImage(m), images: m.images, shipping_weight: m.shipping_weight || 0,
      state: mst, buyable: (mst === 'in_stock' || mst === 'in_transit'),
    };
  });
  const curIdx = isGroup ? Math.max(0, members.findIndex(m => String(m.id) === String(p.id))) : 0;
  const pickerHtml = isGroup ? `
      <div id="variantPicker" class="mb-6" data-cur="${curIdx}">
        <p class="text-sm font-semibold text-slate-300 mb-2">Choose your option <span class="text-slate-500 font-normal">· ${members.length} in this set</span></p>
        <div class="flex flex-wrap gap-2">
          ${groupData.map((m, i) => `<button type="button" data-idx="${i}" class="vpick text-sm px-3 py-2 rounded-xl border transition ${m.buyable ? 'border-slate-700 hover:border-cyan-500 text-slate-200' : 'border-slate-800 text-slate-600 cursor-not-allowed'}"${m.buyable ? '' : ' disabled'}>${esc(m.label)}${m.buyable ? '' : ' · sold out'}</button>`).join('')}
        </div>
      </div>` : '';

  const body = `
  <nav class="max-w-6xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a>
    <span class="mx-2">/</span>
    <a href="/categories/${catSlug}" class="hover:text-cyan-400">${esc(cat)}</a>
    <span class="mx-2">/</span><span class="text-slate-300">${esc(p.name)}</span>
  </nav>

  <article class="max-w-6xl mx-auto px-6 py-10 grid md:grid-cols-2 gap-12">
    <div>
      <img id="mainImg" src="${esc(img)}" alt="${esc(p.name)}" class="w-full rounded-3xl border border-slate-800 bg-slate-900 object-contain cursor-zoom-in">
      ${p.images.length > 1 ? `<div class="grid grid-cols-4 gap-3 mt-3">${p.images.map((u,i)=>`<img data-full="${esc(u)}" src="${esc(u)}" alt="${esc(p.name)} view ${i+1}" class="thumb w-full aspect-square object-cover rounded-xl border ${i===0?'border-cyan-500':'border-slate-800'} cursor-pointer hover:border-cyan-500 transition" loading="lazy">`).join('')}</div>` : ''}
    </div>
    <div>
      ${p.brand ? `<p class="text-cyan-400 text-sm font-semibold tracking-wide uppercase mb-2">${esc(p.brand)}</p>` : ''}
      <h1 id="pdpTitle" class="text-3xl md:text-4xl font-bold leading-tight mb-4">${esc(p.name)}</h1>
      <div class="flex items-center gap-x-3 mb-6">
        <span id="pdpPrice" class="text-3xl font-bold"${(pr != null && st !== 'on_order') ? '' : ' style="display:none"'}>${pr != null ? '$' + pr.toFixed(2) : ''}</span>
        <span id="pdpCompare" class="compare-price text-lg"${(!isNaN(cmp) && cmp > (pr||0) && st !== 'on_order') ? '' : ' style="display:none"'}>${!isNaN(cmp) ? '$' + cmp.toFixed(2) : ''}</span>
        <span id="pdpStatus" class="text-xs font-semibold px-3 py-1 rounded-full ${st==='in_stock' ? 'bg-emerald-600/20 text-emerald-400' : st==='in_transit' ? 'bg-blue-500/20 text-blue-300' : st==='on_order' ? 'bg-purple-500/20 text-purple-300' : 'bg-slate-700 text-slate-300'}">${st==='in_stock' ? 'In Stock' : st==='in_transit' ? 'Pre-order' : st==='on_order' ? 'Coming Soon' : 'Sold Out'}</span>
      </div>
      ${pickerHtml}
      <div class="prose prose-invert text-slate-300 leading-relaxed mb-8 whitespace-pre-line">${esc(String(p.description || '').split(/keywords:/i)[0].trim())}</div>
      ${showBuyUI ? `${st === 'in_transit' ? `<div class="mb-3 text-sm bg-blue-500/15 border border-blue-500/40 text-blue-200 rounded-2xl px-4 py-3">⏳ Available for <b>pre-order</b> — ships when it arrives in stock.</div>` : ''}<div class="flex flex-col sm:flex-row gap-3">
        <button id="addCart" class="flex-1 px-8 py-4 bg-cyan-500 hover:bg-cyan-600 text-black font-bold rounded-3xl text-lg inline-flex items-center justify-center gap-x-2"><i class="fa-solid fa-cart-plus"></i> ${st === 'in_transit' ? 'Pre-order' : 'Add to Cart'}</button>
        <button id="buyNow" class="flex-1 px-8 py-4 bg-white text-slate-950 font-bold rounded-3xl text-lg hover:bg-slate-100 transition inline-flex items-center justify-center gap-x-2"><i class="fa-solid fa-bolt"></i> Buy Now</button>
      </div>
      <div id="addedMsg" class="hidden mt-4 bg-slate-900 border border-slate-700 rounded-2xl p-4">
        <p class="text-cyan-400 font-semibold mb-3"><i class="fa-solid fa-check"></i> Added to your cart.</p>
        <div class="flex flex-col sm:flex-row gap-3">
          <a href="/categories/${catSlug}" class="flex-1 text-center px-5 py-3 border border-slate-600 rounded-2xl font-semibold hover:bg-white/5">← Continue shopping</a>
          <a href="/?checkout=1" class="flex-1 text-center px-5 py-3 bg-white text-slate-950 hover:bg-slate-100 rounded-2xl font-semibold">View cart &amp; checkout →</a>
        </div>
      </div>
      <p class="text-sm text-slate-300 mt-4"><i class="fa-solid fa-bolt text-cyan-400"></i> Fast shipping · Packed with care · 100% authentic, officially licensed</p>
      <p class="text-xs text-slate-500 mt-2">🔒 Secure checkout powered by Stripe</p>` :
      st === 'on_order'
        ? `<div class="inline-block px-6 py-4 bg-purple-500/15 border border-purple-500/40 text-purple-200 rounded-3xl font-semibold">🔜 Coming soon — not yet available to order. Check back!</div>`
        : `<a href="/inventory" class="inline-block px-10 py-4 border border-slate-700 rounded-3xl font-semibold hover:bg-white/5">Browse other items</a>`}
      <p class="mt-6 text-sm"><a href="/categories/${catSlug}" class="text-cyan-400 hover:text-cyan-300">← More in ${esc(cat)}</a></p>
      <a id="editListingLink" href="#" class="hidden mt-3 text-sm items-center gap-x-1 text-amber-400 hover:text-amber-300"><i class="fa-solid fa-pen"></i> Edit this listing</a>
    </div>
  </article>
  ${relatedHtml}
  <div id="lightbox" class="hidden fixed inset-0 z-[200] bg-black/90 items-center justify-center p-4" role="dialog" aria-modal="true">
    <button id="lightboxClose" aria-label="Close" class="absolute top-4 right-5 text-white text-4xl leading-none">&times;</button>
    <img id="lightboxImg" src="" alt="${esc(p.name)}" class="max-w-full max-h-full object-contain rounded-xl">
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3"></script>
  <script>
    (function(){
      var ITEM = ${buyItem};
      function readCart(){ try { return JSON.parse(localStorage.getItem('nubz_cart')) || []; } catch(e){ return []; } }
      function writeCart(c){ try { localStorage.setItem('nubz_cart', JSON.stringify(c)); } catch(e){} }
      function count(c){ return c.reduce(function(s,i){ return s + (i.quantity||1); }, 0); }
      function syncBadge(){ var el = document.getElementById('navCartCount'); if (el) el.textContent = count(readCart()); }

      // --- Image gallery: thumbnails swap the main image; click/tap to enlarge ---
      var mainImg = document.getElementById('mainImg');
      var thumbs  = Array.prototype.slice.call(document.querySelectorAll('.thumb'));
      thumbs.forEach(function(t){
        t.addEventListener('click', function(){
          var full = t.getAttribute('data-full');
          if (full && mainImg) mainImg.src = full;
          thumbs.forEach(function(x){ x.classList.remove('border-cyan-500'); x.classList.add('border-slate-800'); });
          t.classList.add('border-cyan-500'); t.classList.remove('border-slate-800');
        });
      });
      var lb = document.getElementById('lightbox');
      var lbImg = document.getElementById('lightboxImg');
      var lbClose = document.getElementById('lightboxClose');
      function openLb(){ if (!lb || !mainImg) return; lbImg.src = mainImg.src; lb.classList.remove('hidden'); lb.classList.add('flex'); document.body.style.overflow = 'hidden'; }
      function closeLb(){ if (!lb) return; lb.classList.add('hidden'); lb.classList.remove('flex'); document.body.style.overflow = ''; }
      if (mainImg) mainImg.addEventListener('click', openLb);
      if (lbClose) lbClose.addEventListener('click', closeLb);
      if (lb) lb.addEventListener('click', function(e){ if (e.target === lb) closeLb(); });
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeLb(); });

      var add = document.getElementById('addCart');
      if (add) add.addEventListener('click', function(){
        ${st === 'in_transit' ? `if(!confirm('Heads up — this item is available for PRE-ORDER only. It ships when it arrives in stock. Add to cart?')) return;` : ''}
        var c = readCart();
        var ex = c.find(function(x){ return String(x.id) === String(ITEM.id); });
        if (ex) ex.quantity = (ex.quantity||1) + 1; else c.push(Object.assign({}, ITEM));
        writeCart(c); syncBadge();
        document.getElementById('addedMsg').classList.remove('hidden');
        add.innerHTML = '<i class="fa-solid fa-check"></i> Added';
      });

      // --- Grouped-items variety picker: swap photo/price/status/target in place ---
      var GROUP = ${JSON.stringify(groupData)};
      if (GROUP && GROUP.length > 1) {
        var vpTitle = document.getElementById('pdpTitle');
        var vpPrice = document.getElementById('pdpPrice');
        var vpCompare = document.getElementById('pdpCompare');
        var vpStatus = document.getElementById('pdpStatus');
        var vpMain = document.getElementById('mainImg');
        var addBtn = document.getElementById('addCart');
        var buyBtn = document.getElementById('buyNow');
        var STMAP = {
          in_stock:   { cls:'bg-emerald-600/20 text-emerald-400', txt:'In Stock' },
          in_transit: { cls:'bg-blue-500/20 text-blue-300',       txt:'Pre-order' },
          on_order:   { cls:'bg-purple-500/20 text-purple-300',   txt:'Coming Soon' },
          sold_out:   { cls:'bg-slate-700 text-slate-300',        txt:'Sold Out' }
        };
        function selectVariant(i){
          var m = GROUP[i]; if(!m) return;
          ITEM = { id:m.id, sku:m.sku||'', name:m.name, price:m.price||0, images:m.images||[], quantity:1, shipping_weight:m.shipping_weight||0 };
          if (vpTitle) vpTitle.textContent = m.name;
          if (vpMain && m.img) vpMain.src = m.img;
          if (vpPrice){ vpPrice.textContent = '$' + Number(m.price||0).toFixed(2); vpPrice.style.display = ''; }
          if (vpCompare){ if(m.compare_to){ vpCompare.textContent = '$' + Number(m.compare_to).toFixed(2); vpCompare.style.display=''; } else { vpCompare.style.display='none'; } }
          if (vpStatus){ var s = STMAP[m.state] || STMAP.in_stock; vpStatus.className = 'text-xs font-semibold px-3 py-1 rounded-full ' + s.cls; vpStatus.textContent = s.txt; }
          var okBuy = !!m.buyable;
          [addBtn, buyBtn].forEach(function(b){ if(!b) return; b.disabled = !okBuy; b.classList.toggle('opacity-40', !okBuy); b.classList.toggle('cursor-not-allowed', !okBuy); });
          if (addBtn) addBtn.innerHTML = okBuy ? ('<i class="fa-solid fa-cart-plus"></i> ' + (m.state==='in_transit' ? 'Pre-order' : 'Add to Cart')) : '<i class="fa-solid fa-ban"></i> Sold Out';
          var addedMsg = document.getElementById('addedMsg'); if (addedMsg) addedMsg.classList.add('hidden');
          document.querySelectorAll('.vpick').forEach(function(btn){
            var on = String(btn.getAttribute('data-idx')) === String(i);
            btn.classList.toggle('border-cyan-500', on); btn.classList.toggle('bg-cyan-500/10', on);
          });
        }
        document.querySelectorAll('.vpick').forEach(function(btn){
          if (btn.disabled) return;
          btn.addEventListener('click', function(){ selectVariant(Number(btn.getAttribute('data-idx'))); });
        });
        var vp = document.getElementById('variantPicker');
        selectVariant(vp ? Number(vp.getAttribute('data-cur')) : 0);
      }

      var buy = document.getElementById('buyNow');
      if (buy) buy.addEventListener('click', async function(e){
        var btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Redirecting…';
        try {
          var res = await fetch('/api/create-checkout', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ cartItems: [ITEM] })
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Checkout failed');
          window.location.href = data.url;
        } catch (err) {
          btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Buy Now';
          alert('Unable to start checkout. Please try again.');
        }
      });
      // Show an "Edit this listing" link if signed in as admin (same Supabase
      // login used on the homepage) — deep-links back to the homepage admin
      // modal for this SKU rather than duplicating the edit UI on every page.
      (function(){
        var link = document.getElementById('editListingLink');
        if (!link || typeof supabase === 'undefined' || !supabase.createClient) return;
        try {
          var sb = supabase.createClient('https://vdkjjyjfwfndrksruisn.supabase.co', 'sb_publishable_MUbT8VJ6HKCa1pNUgZYjuA_wzXzECNr');
          sb.auth.getSession().then(function(r){
            if (r && r.data && r.data.session) {
              link.href = '/?edit=' + encodeURIComponent(ITEM.sku || ITEM.id);
              link.classList.remove('hidden'); link.classList.add('inline-flex');
            }
          });
        } catch (e) {}
      })();
    })();
  </script>`;

  return head({ title: `${p.name} | ${SITE_NAME}`, desc, canonical, image: img,
    type: 'product', jsonld: [productLd, crumbLd] }) + body + footer();
}

// ── CATEGORY PAGE ──────────────────────────────────────────────────────
function categoryPage(cat, items) {
  const slug      = slugify(cat);
  const canonical = `${SITE}/categories/${slug}`;
  const img       = items.length ? firstImage(items[0]) : `${SITE}${LOGO}`;
  const n         = items.length;
  const base      = CATEGORY_DESC[cat] || `Shop ${cat} at ${SITE_NAME}.`;
  const desc      = metaFrom(`${base} Fair prices and fast shipping from the USA.`, base);

  const listLd = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: `${cat} — ${SITE_NAME}`,
    itemListElement: items.map((p, i) => ({
      '@type': 'ListItem', position: i + 1, url: `${SITE}/products/${p.slug}`, name: p.name,
    })),
  };
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: cat, item: canonical },
    ],
  };

  items = collapseGroups(items);
  const grid = items.map(p => `
    <a href="/products/${p.slug}" class="block bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-cyan-500/50 transition">
      <div class="relative">
        ${variantBadge(p)}
        <img src="${esc(firstImage(p))}" alt="${esc(p.name)}" class="w-full aspect-square object-cover object-top" loading="lazy">
      </div>
      <div class="p-4">
        ${p.brand ? `<p class="text-xs text-cyan-400 font-semibold uppercase mb-1">${esc(p.brand)}</p>` : ''}
        <p class="text-sm font-medium line-clamp-2 mb-2">${esc(p.name)}</p>
        ${price(p) != null ? `<p class="font-bold">$${price(p).toFixed(2)}${p._variantCount > 1 ? '<span class="text-slate-400 text-xs font-medium"> & up</span>' : ''}</p>` : ''}
        ${noReviews}
      </div>
    </a>`).join('');

  const body = `
  <nav class="max-w-6xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">${esc(cat)}</span>
  </nav>
  <header class="max-w-6xl mx-auto px-6 py-8">
    <h1 class="text-4xl font-bold gradient-title inline-block">${esc(cat)}</h1>
    <p class="text-slate-400 mt-2">${items.length} item${items.length===1?'':'s'} available</p>
  </header>
  <section class="max-w-6xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-6">${grid}</section>`;

  return head({ title: `${cat} | ${SITE_NAME}`, desc, canonical, image: img,
    type: 'website', jsonld: [listLd, crumbLd] }) + body + footer();
}

// ── SITEMAP / ROBOTS ───────────────────────────────────────────────────
function sitemap(products, categories) {
  const today = new Date().toISOString().slice(0, 10);
  const url = (loc, pr) =>
    `  <url><loc>${loc}</loc><lastmod>${today}</lastmod><priority>${pr}</priority></url>`;
  const urls = [
    url(`${SITE}/`, '1.0'),
    url(`${SITE}/categories`, '0.8'),
    url(`${SITE}/inventory`, '0.8'),
    url(`${SITE}/about`, '0.5'),
    url(`${SITE}/contact`, '0.5'),
    url(`${SITE}/blog`, '0.6'),
    url(`${SITE}/privacy-policy`, '0.3'),
    url(`${SITE}/returns`, '0.3'),
    url(`${SITE}/shipping`, '0.4'),
    ...categories.map(c => url(`${SITE}/categories/${slugify(c)}`, '0.7')),
    ...products.map(p => url(`${SITE}/products/${p.slug}`, '0.8')),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

const robots = () => `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml`;

// ── GOOGLE MERCHANT CENTER FEED ────────────────────────────────────────
// RSS 2.0 product feed at /feed.xml. Uses the SAME canonical apex URLs as the
// sitemap so there's no redirect mismatch. Licensing-restricted lines are
// excluded (Blokees, Mickey Mouse blind bags, Godzilla, Pokémon keychains).
const FEED_EXCLUDE = (p) => {
  const t = `${p.name || ''} ${p.brand || ''}`.toLowerCase();
  return /blokees/.test(t)
      || /godzilla/.test(t)
      || (/mickey/.test(t) && /(blind|bag|mini)/.test(t))
      || (/pok[eé]?mon/.test(t) && /key ?chain/.test(t));
};
// Always give Google a valid absolute https image URL: first real http(s) image,
// forced to https, else a valid placeholder. Never emits http://, data:, or relative.
function feedImage(p) {
  const list = Array.isArray(p.images) ? p.images : [];
  const httpImg = list.map(String).find(u => /^https?:\/\//i.test(u));
  const chosen = (httpImg || 'https://placehold.co/800x800/0f172a/22d3ee?text=Nubz+Toys').replace(/^http:\/\//i, 'https://');
  // Route through the weserv image CDN → always https + resized under Google's
  // size cap, so oversized EE "XL/XXL" images can't be rejected as "too big".
  return `https://wsrv.nl/?url=${encodeURIComponent(chosen)}&w=1200&output=jpg&q=82`;
}
function productFeed(products) {
  const items = products.filter(p => {
    const st = availState(p);
    return price(p) > 0 && (st === 'in_stock' || st === 'sold_out') && !FEED_EXCLUDE(p);
  }).map(p => {
    const avail = availState(p) === 'sold_out' ? 'out_of_stock' : 'in_stock';
    const desc = String(p.description || p.name || '')
      .split(/keywords:/i)[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4900);
    const gtin = p.upc ? `\n      <g:gtin>${esc(String(p.upc))}</g:gtin>` : '';
    const mpn  = p.sku ? `\n      <g:mpn>${esc(String(p.sku))}</g:mpn>` : '';
    const wt   = Number(p.shipping_weight) > 0 ? `\n      <g:shipping_weight>${Number(p.shipping_weight)} lb</g:shipping_weight>` : '';
    return `    <item>
      <g:id>${esc(String(p.sku || p.id))}</g:id>
      <title>${esc(p.name || '')}</title>
      <g:description>${esc(desc)}</g:description>
      <link>${SITE}/products/${p.slug}</link>
      <g:image_link>${esc(feedImage(p))}</g:image_link>
      <g:availability>${avail}</g:availability>
      <g:price>${price(p).toFixed(2)} USD</g:price>
      <g:condition>new</g:condition>
      <g:brand>${esc(p.brand || SITE_NAME)}</g:brand>${gtin}${mpn}${wt}
      <g:product_type>${esc(p.categories[0] || 'Toys')}</g:product_type>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${esc(SITE_NAME)}</title>
    <link>${SITE}</link>
    <description>Product feed for ${esc(SITE_NAME)}</description>
${items}
  </channel>
</rss>`;
}

// ── CATEGORIES INDEX PAGE ─────────────────────────────────────────────
function categoriesIndexPage(byCat) {
  const canonical = `${SITE}/categories`;
  const desc = 'Browse all toy and collectible categories at Nubz Toys — Action Figures, Funko Pop, Blind Bags, Model Sets, die-cast and more. Fair prices, fast USA shipping.';
  const ICONS = {
    'Action Figures': 'fa-dragon',
    'Model Sets': 'fa-cube',
    'Funko Pop': 'fa-box-open',
    'Blind Bag & Mini Figures': 'fa-question-circle',
    'Toys': 'fa-gamepad',
    'Collectibles': 'fa-star',
    'Bulk': 'fa-boxes-stacked',
  };
  const COLORS = {
    'Action Figures': '#22d3ee',
    'Model Sets': '#34d399',
    'Funko Pop': '#c084fc',
    'Blind Bag & Mini Figures': '#e879f9',
    'Toys': '#fbbf24',
    'Collectibles': '#fb7185',
    'Bulk': '#fb923c',
  };
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Categories', item: canonical },
    ],
  };
  // Fixed, deliberate card order (known categories in this sequence, any others
  // after, alphabetically) so the landing page never renders them shuffled.
  const CAT_ORDER = Object.keys(ICONS);
  const rank = (c) => { const i = CAT_ORDER.indexOf(c); return i === -1 ? 999 : i; };
  // Brand logos we carry, shown as white chips on each card (files in /logos/).
  const BRAND_LOGOS = {
    'Action Figures':          ['dc', 'marvel', 'starwars'],
    'Model Sets':              ['blokees', 'transformers'],
    'Funko Pop':               ['funko', 'starwars'],
    'Blind Bag & Mini Figures':['disney', 'minecraft', 'loungefly'],
    'Toys':                    ['hotwheels', 'barbie', 'hasbro'],
    'Collectibles':            ['funko', 'dc', 'marvel'],
  };
  const BRAND_ALT = { dc:'DC Comics', marvel:'Marvel', starwars:'Star Wars', blokees:'Blokees',
    transformers:'Transformers', funko:'Funko', disney:'Disney', minecraft:'Minecraft',
    loungefly:'Loungefly', hotwheels:'Hot Wheels', barbie:'Barbie', hasbro:'Hasbro', mattel:'Mattel' };
  const chipRow = (cat) => {
    const logos = BRAND_LOGOS[cat] || [];
    if (!logos.length) return '';
    return `<div class="flex flex-wrap gap-2 mb-5">` + logos.map(l =>
      `<span class="bg-white rounded-lg h-9 px-2.5 flex items-center"><img src="/logos/${l}.png" alt="${esc(BRAND_ALT[l] || l)}" class="h-5 w-auto" loading="lazy"></span>`
    ).join('') + `</div>`;
  };
  const cards = Object.entries(byCat)
    .sort((a, b) => (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]))
    .map(([cat, items]) => {
    const slug  = slugify(cat);
    const icon  = ICONS[cat] || 'fa-tag';
    const color = COLORS[cat] || '#22d3ee';
    // Brand-logo chips when we have them; icon tile fallback otherwise (e.g. Bulk).
    const header = BRAND_LOGOS[cat] ? chipRow(cat)
      : `<div class="mb-5 w-16 h-16 rounded-2xl flex items-center justify-center" style="background:${color}1a"><i class="fa-solid ${icon} text-3xl" style="color:${color}"></i></div>`;
    return `
    <a href="/categories/${slug}" class="group relative bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden hover:border-cyan-500/50 transition-all hover:-translate-y-1 flex flex-col p-8">
      ${header}
      <h2 class="font-bold text-xl mb-2">${esc(cat)}</h2>
      <p class="text-slate-400 text-sm mb-6 flex-1">${esc(CATEGORY_DESC[cat] || `Shop ${cat} at Nubz Toys.`)}</p>
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-500">${items.length} item${items.length === 1 ? '' : 's'}</span>
        <span class="text-cyan-400 text-sm font-semibold group-hover:text-cyan-300">Shop Now →</span>
      </div>
    </a>`;
  }).join('');

  const body = `
  <nav class="max-w-6xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">Categories</span>
  </nav>
  <header class="max-w-6xl mx-auto px-6 py-10 text-center">
    <div class="text-xs uppercase tracking-[2px] text-cyan-400 font-semibold mb-3">SHOP BY CATEGORY</div>
    <h1 class="text-4xl md:text-5xl font-bold gradient-title inline-block mb-4">All Categories</h1>
    <p class="text-slate-400 text-lg max-w-2xl mx-auto">Straight to what you collect — authentic pieces, fair prices, and fast USA shipping on every order.</p>
  </header>
  <section class="max-w-6xl mx-auto px-6 pb-20 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">${cards}</section>`;

  return head({ title: `All Categories | ${SITE_NAME}`, desc, canonical, image: `${SITE}${LOGO}`,
    type: 'website', jsonld: [crumbLd] }) + body + footer();
}

// ── ALL INVENTORY PAGE ─────────────────────────────────────────────────
function inventoryPage(products) {
  const canonical = `${SITE}/inventory`;
  const desc = `Shop the full catalog of toys and collectibles at Nubz Toys — action figures, Funko Pop, blind bags, model kits, die-cast and more. Fair prices, fast USA shipping.`;
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'All Inventory', item: canonical },
    ],
  };
  const listLd = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: `All Products — ${SITE_NAME}`,
    itemListElement: products.map((p, i) => ({
      '@type': 'ListItem', position: i + 1, url: `${SITE}/products/${p.slug}`, name: p.name,
    })),
  };
  products = collapseGroups(products);
  const grid = products.map(p => {
    const pr = price(p);
    const st = availState(p);
    const available = (st === 'in_stock' || st === 'in_transit');
    return `
    <a href="/products/${p.slug}" class="block bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-cyan-500/50 transition">
      <div class="relative">
        ${variantBadge(p)}
        <img src="${esc(firstImage(p))}" alt="${esc(p.name)}" class="w-full aspect-square object-cover object-top" loading="lazy">
        ${st==='sold_out' ? '<div class="absolute inset-0 bg-black/60 flex items-center justify-center"><span class="bg-slate-900 text-slate-300 text-xs font-bold px-3 py-1 rounded-full border border-slate-700">SOLD OUT</span></div>' : st==='on_order' ? '<div class="absolute inset-0 bg-black/50 flex items-center justify-center"><span class="bg-purple-600 text-white text-xs font-bold px-3 py-1 rounded-full">COMING SOON</span></div>' : st==='in_transit' ? '<span class="absolute top-2 left-2 bg-blue-500 text-white text-xs font-bold px-2.5 py-1 rounded-full">PRE-ORDER</span>' : ''}
      </div>
      <div class="p-4">
        ${p.brand ? `<p class="text-xs text-cyan-400 font-semibold uppercase mb-1">${esc(p.brand)}</p>` : ''}
        <p class="text-sm font-medium line-clamp-2 mb-2">${esc(p.name)}</p>
        ${(pr != null && st !== 'on_order') ? `<p class="font-bold">${available ? `$${pr.toFixed(2)}` : `<span class="text-slate-500 line-through">$${pr.toFixed(2)}</span>`}${p._variantCount > 1 ? '<span class="text-slate-400 text-xs font-medium"> & up</span>' : ''}</p>` : (st === 'on_order' ? `<p class="font-bold text-purple-300 text-sm">Coming soon</p>` : '')}
        ${noReviews}
      </div>
    </a>`;
  }).join('');

  const body = `
  <nav class="max-w-6xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">All Inventory</span>
  </nav>
  <header class="max-w-6xl mx-auto px-6 py-10">
    <div class="text-xs uppercase tracking-[2px] text-cyan-400 font-semibold mb-3">COMPLETE CATALOG</div>
    <h1 class="text-4xl md:text-5xl font-bold gradient-title inline-block mb-4">All Inventory</h1>
    <p class="text-slate-400 text-lg">${products.length} items · Browse our full catalog of toys and collectibles</p>
  </header>
  <section class="max-w-6xl mx-auto px-6 pb-20 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">${grid}</section>`;

  return head({ title: `All Inventory | ${SITE_NAME}`, desc, canonical, image: `${SITE}${LOGO}`,
    type: 'website', jsonld: [crumbLd, listLd] }) + body + footer();
}

// ── ABOUT PAGE ─────────────────────────────────────────────────────────
function aboutPage() {
  const canonical = `${SITE}/about`;
  const desc = 'Nubz Toys & Collectibles — Est. 2026. Action figures, Funko Pop and everything in between. For collectors, the nostalgic, and anyone who never stopped playing.';
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'About Us', item: canonical },
    ],
  };
  const orgLd = {
    '@context': 'https://schema.org', '@type': 'Organization',
    name: SITE_NAME, url: SITE + '/', logo: SITE + LOGO,
    foundingDate: '2026',
    description: desc,
    parentOrganization: { '@type': 'Organization', name: 'Wilderness Dealz LLC' },
    sameAs: [SOCIAL.facebook, SOCIAL.instagram, SOCIAL.youtube, SOCIAL.whatnot],
    telephone: '+1-828-649-4355',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '125 Lexington Ave, Suite 101A PMB 187',
      addressLocality: 'Asheville', addressRegion: 'NC', postalCode: '28801', addressCountry: 'US',
    },
    contactPoint: { '@type': 'ContactPoint', telephone: '+1-828-649-4355', email: 'sales@nubztoys.com', contactType: 'customer service' },
  };

  const body = `
  <nav class="max-w-4xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">About Us</span>
  </nav>
  <article class="max-w-4xl mx-auto px-6 py-16">
    <div class="text-center mb-16">
      <div class="text-xs uppercase tracking-[2px] text-cyan-400 font-semibold mb-3">OUR STORY</div>
      <h1 class="text-4xl md:text-5xl font-bold gradient-title inline-block mb-6">About Nubz Toys &amp; Collectibles</h1>
    </div>
    <div class="prose prose-invert max-w-none text-lg text-slate-300 leading-relaxed space-y-6">
      <p>Nubz Toys &amp; Collectibles was founded in 2026 with one simple mission: to just keep it simple. Remember when we used to just play? We owned the dialogue. We wrote the scenes. We defined the storyline — it didn't define us. Well, maybe it did, and we just got away from it for a while.</p>
      <p>From yesterday's nostalgia to discovering the vintage of tomorrow, we're here for it. Don't mind the fake airplane noises — we're just going on a little journey. Thanks for joining us. Remember, you might not be old enough for some toys &amp; collectibles, but you're never too old for them.</p>
      <div class="grid md:grid-cols-3 gap-6 my-12 not-prose">
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 text-center">
          <div class="text-3xl font-black text-cyan-400 mb-2">45+</div>
          <div class="text-slate-300 font-semibold">Products in Stock</div>
          <div class="text-slate-500 text-sm mt-1">Action figures, Funko, die-cast &amp; more</div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 text-center">
          <div class="text-3xl font-black text-fuchsia-400 mb-2">100%</div>
          <div class="text-slate-300 font-semibold">Authentic &amp; Licensed</div>
          <div class="text-slate-500 text-sm mt-1">Brand-new official merchandise</div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 text-center">
          <div class="text-3xl font-black text-amber-400 mb-2">🚀</div>
          <div class="text-slate-300 font-semibold">Fast Shipping</div>
          <div class="text-slate-500 text-sm mt-1">Packed with care, ships from the USA</div>
        </div>
      </div>
      <h2 class="text-2xl font-bold text-white not-prose">Part of the Wilderness Dealz Family</h2>
      <p>Nubz Toys &amp; Collectibles is a DBA of Wilderness Dealz LLC, based in North Carolina. We also operate <strong>Wilderness Dealz</strong> — an auction and resale business on Whatnot and our own Shopify store. Whether you find us through Nubz or Dealz, you're shopping with the same team that packs your order, answers your emails, and takes pride in getting it right.</p>

      <h2 class="text-2xl font-bold text-white not-prose">The basics</h2>
      <ul class="not-prose text-slate-300 space-y-2 leading-relaxed list-none pl-0">
        <li><strong class="text-white">Who we are:</strong> Nubz Toys &amp; Collectibles, a DBA of Wilderness Dealz LLC — a North Carolina limited liability company.</li>
        <li><strong class="text-white">What we sell:</strong> brand-new, 100% authentic, officially licensed toys &amp; collectibles — action figures, Funko Pop, blind bags, model kits, die-cast and more — sourced through authorized distributors.</li>
        <li><strong class="text-white">Where we are:</strong> 125 Lexington Ave, Suite 101A PMB 187, Asheville, NC 28801.</li>
        <li><strong class="text-white">In business since:</strong> 2026.</li>
        <li><strong class="text-white">Reach a human:</strong> <a href="tel:+18286494355" class="text-cyan-400 hover:text-cyan-300">828-649-4355</a> · WhatsApp <a href="https://wa.me/18286494355" class="text-cyan-400 hover:text-cyan-300">@NubzTC</a> · <a href="mailto:sales@nubztoys.com" class="text-cyan-400 hover:text-cyan-300">sales@nubztoys.com</a>.</li>
      </ul>
      <p class="text-sm text-slate-500 not-prose">Nubz Toys &amp; Collectibles is a retailer of officially licensed merchandise. All product names, characters, logos, and brands are the property of their respective owners; their use here does not imply affiliation with, or endorsement by, the manufacturers.</p>

      <!-- Live Google reviews mount (populated by /js/google-reviews once place_id + key are set) -->
      <div id="google-reviews" class="not-prose my-8"></div>
    </div>
    <div class="mt-12 flex flex-wrap gap-4 justify-center">
      <a href="/categories" class="px-8 py-4 bg-white text-slate-950 font-bold rounded-3xl text-lg hover:bg-slate-100 transition">Shop Now</a>
      <a href="/contact" class="px-8 py-4 border border-slate-700 hover:bg-white/5 font-semibold rounded-3xl text-lg">Contact Us</a>
    </div>
  </article>`;

  return head({ title: `About Us | ${SITE_NAME}`, desc, canonical, image: SITE + LOGO,
    type: 'website', jsonld: [crumbLd, orgLd] }) + body + footer();
}

// ── CONTACT PAGE ────────────────────────────────────────────────────────
function contactPage() {
  const canonical = `${SITE}/contact`;
  const desc = 'Contact Nubz Toys & Collectibles — order questions, returns, or just want to say hi? Email sales@nubztoys.com. Real people, real responses.';
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Contact Us', item: canonical },
    ],
  };
  const contactLd = {
    '@context': 'https://schema.org', '@type': 'ContactPage',
    name: `Contact ${SITE_NAME}`, url: canonical,
    mainEntity: { '@type': 'Organization', name: SITE_NAME, email: 'sales@nubztoys.com',
      telephone: '+1-828-649-4355',
      address: { '@type': 'PostalAddress', streetAddress: '125 Lexington Ave, Suite 101A PMB 187', addressLocality: 'Asheville', addressRegion: 'NC', postalCode: '28801', addressCountry: 'US' } },
  };

  const body = `
  <nav class="max-w-2xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">Contact Us</span>
  </nav>
  <section class="max-w-2xl mx-auto px-6 py-16">
    <div class="text-center mb-12">
      <div class="text-xs uppercase tracking-[2px] text-cyan-400 font-semibold mb-3">LET'S CONNECT</div>
      <h1 class="text-4xl md:text-5xl font-bold gradient-title inline-block mb-4">Contact Us</h1>
      <p class="text-slate-400 text-lg">We're real people. We actually respond.</p>
    </div>
    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 mb-8">
      <h2 class="font-bold text-lg mb-2 text-white">Email us directly</h2>
      <p class="text-slate-400 text-sm mb-4">The fastest way to reach us for order questions, returns, or anything else.</p>
      <a href="mailto:sales@nubztoys.com" class="inline-flex items-center gap-x-2 text-cyan-400 hover:text-cyan-300 font-semibold text-lg">
        <i class="fa-solid fa-envelope"></i> sales@nubztoys.com
      </a>
    </div>
    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 mb-8">
      <h2 class="font-bold text-lg mb-4 text-white">Call, message, or write us</h2>
      <div class="grid sm:grid-cols-2 gap-6 text-sm">
        <div class="space-y-3">
          <p><i class="fa-solid fa-phone text-cyan-400 w-5"></i> <a href="tel:+18286494355" class="text-slate-200 hover:text-white">828-649-4355</a></p>
          <p><i class="fa-brands fa-whatsapp text-cyan-400 w-5"></i> <a href="https://wa.me/18286494355" target="_blank" rel="noopener noreferrer" class="text-slate-200 hover:text-white">WhatsApp @NubzTC</a></p>
        </div>
        <address class="not-italic text-slate-400 leading-relaxed">
          Wilderness Dealz LLC<br>dba Nubz Toys &amp; Collectibles<br>
          125 Lexington Ave, Suite 101A PMB 187<br>Asheville, NC 28801
        </address>
      </div>
    </div>
    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 mb-8">
      <h2 class="font-bold text-lg mb-4 text-white">Send a message</h2>
      <form id="contact-form" class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <input type="text" id="contact-name" name="name" placeholder="Your Name" required
            class="bg-slate-800 border border-slate-700 rounded-2xl px-5 py-3 text-sm w-full focus:outline-none focus:border-cyan-500">
          <input type="email" id="contact-email" name="email" placeholder="Your Email" required
            class="bg-slate-800 border border-slate-700 rounded-2xl px-5 py-3 text-sm w-full focus:outline-none focus:border-cyan-500">
        </div>
        <textarea id="contact-message" name="message" placeholder="Your message…" rows="6" required
          class="w-full bg-slate-800 border border-slate-700 rounded-3xl px-5 py-4 text-sm focus:outline-none focus:border-cyan-500"></textarea>
        <button type="button" onclick="submitContactForm()" class="w-full py-4 bg-white text-slate-950 font-bold rounded-3xl text-lg hover:bg-slate-100 transition">SEND MESSAGE</button>
      </form>
    </div>
    <div class="grid grid-cols-2 gap-4">
      <a href="/returns" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-solid fa-rotate-left text-2xl text-cyan-400 mb-2"></i>
        <p class="font-semibold text-sm">Returns</p>
        <p class="text-slate-500 text-xs mt-1">Our return policy</p>
      </a>
      <a href="/about" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-solid fa-store text-2xl text-fuchsia-400 mb-2"></i>
        <p class="font-semibold text-sm">About Us</p>
        <p class="text-slate-500 text-xs mt-1">Who we are</p>
      </a>
    </div>
  </section>
  <script>
    function submitContactForm() {
      var name    = document.getElementById('contact-name').value.trim();
      var email   = document.getElementById('contact-email').value.trim();
      var message = document.getElementById('contact-message').value.trim();
      if (!name || !email || !message) { alert('Please fill in all fields.'); return; }
      var subject = encodeURIComponent('Message from ' + name + ' via NubzToys.com');
      var body    = encodeURIComponent('Name: ' + name + '\\nEmail: ' + email + '\\n\\n' + message);
      window.location.href = 'mailto:sales@nubztoys.com?subject=' + subject + '&body=' + body;
    }
  </script>`;

  return head({ title: `Contact Us | ${SITE_NAME}`, desc, canonical, image: SITE + LOGO,
    type: 'website', jsonld: [crumbLd, contactLd] }) + body + footer();
}

// ── PRIVACY POLICY PAGE ────────────────────────────────────────────────
function privacyPage() {
  const canonical = `${SITE}/privacy-policy`;
  const desc = 'Privacy Policy for Nubz Toys & Collectibles — how we collect, use, and protect your personal information. Updated June 2026.';
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Privacy Policy', item: canonical },
    ],
  };

  const body = `
  <nav class="max-w-4xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">Privacy Policy</span>
  </nav>
  <article class="max-w-4xl mx-auto px-6 py-16">
    <h1 class="text-4xl font-bold gradient-title inline-block mb-3">Privacy Policy</h1>
    <p class="text-slate-500 text-sm mb-10">Last updated: June 5, 2026</p>
    <div class="prose prose-invert text-slate-300 leading-relaxed space-y-6 text-base">
      <p>Wilderness Dealz LLC dba Nubz Toys &amp; Collectibles ("we," "us," or "our") operates this website at nubztoys.com. This Privacy Policy describes how we collect, use, and disclose your personal information when you visit, use, or make a purchase from us.</p>

      <h2 class="text-xl font-bold text-white mt-8 not-prose">Information We Collect</h2>
      <p>We may collect the following categories of personal information: contact details (name, email, phone, shipping address), financial information (payment method — processed securely by Stripe; we do not store full card numbers), transaction information (order history, items purchased, prices paid), device and usage information (browser type, IP address, pages visited, referring URLs), and account information if you create an account with us.</p>

      <h2 class="text-xl font-bold text-white mt-8 not-prose">How We Use Your Information</h2>
      <p>We use your information to: process and fulfill orders; communicate with you about your purchases; provide customer support; send marketing communications (with your consent); detect and prevent fraud; comply with legal obligations; and improve our website and services.</p>

      <h2 class="text-xl font-bold text-white mt-8 not-prose">Sharing Your Information</h2>
      <p>We may share your information with: service providers who help us operate our business (payment processors, shipping carriers, email platforms); business partners and affiliates under confidentiality obligations; and as required by law, court order, or government authority.</p>

      <h2 class="text-xl font-bold text-white mt-8 not-prose">Your Rights</h2>
      <p>Depending on your location, you may have the right to access, correct, delete, or port your personal data. To exercise any of these rights, contact us at <a href="mailto:sales@nubztoys.com" class="text-cyan-400 hover:text-cyan-300">sales@nubztoys.com</a>.</p>

      <h2 class="text-xl font-bold text-white mt-8 not-prose">Children's Privacy</h2>
      <p>Our services are not directed to children under the age of majority. We do not knowingly collect personal information from minors. If you believe a minor has provided us personal information, contact us immediately.</p>

      <h2 class="text-xl font-bold text-white mt-8 not-prose">Contact</h2>
      <p>Questions about this policy? Email us at <a href="mailto:sales@nubztoys.com" class="text-cyan-400 hover:text-cyan-300">sales@nubztoys.com</a>.</p>
    </div>
  </article>`;

  return head({ title: `Privacy Policy | ${SITE_NAME}`, desc, canonical, image: SITE + LOGO,
    type: 'website', jsonld: [crumbLd] }) + body + footer();
}

// ── RETURNS PAGE ────────────────────────────────────────────────────────
function shippingPage() {
  const canonical = `${SITE}/shipping`;
  const desc = 'Shipping at Nubz Toys — flat, no-upcharge shipping across the USA with fast handling, plus FREE local delivery in NC within 45 miles of Waynesville.';
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Shipping', item: canonical },
    ],
  };
  const body = `
  <nav class="max-w-4xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">Shipping</span>
  </nav>
  <article class="max-w-4xl mx-auto px-6 py-16">
    <h1 class="text-4xl font-bold gradient-title inline-block mb-3">Shipping</h1>
    <p class="text-slate-500 text-sm mb-10">Fair, fast, and no shipping games. Here's exactly how it works.</p>
    <div class="grid md:grid-cols-3 gap-4 mb-10">
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
        <div class="text-3xl mb-2">🇺🇸</div>
        <div class="font-bold text-white">Ships from the USA</div>
        <div class="text-slate-400 text-sm mt-1">Packed with care, dispatched fast</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
        <div class="text-3xl mb-2">🏷️</div>
        <div class="font-bold text-white">No Upcharge</div>
        <div class="text-slate-400 text-sm mt-1">Shipping billed at cost, never padded</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
        <div class="text-3xl mb-2">🚚</div>
        <div class="font-bold text-white">Free Local Delivery</div>
        <div class="text-slate-400 text-sm mt-1">NC, within 45 miles of Waynesville</div>
      </div>
    </div>
    <div class="prose prose-invert text-slate-300 leading-relaxed space-y-5 text-base">
      <h2 class="text-xl font-bold text-white not-prose">Processing &amp; handling</h2>
      <p>Orders are typically packed and shipped within 1–2 business days. You'll get a confirmation email when your order is placed, and everything ships from the USA with tracking.</p>
      <h2 class="text-xl font-bold text-white mt-8 not-prose">Shipping cost</h2>
      <p>We don't inflate shipping to pad the order — it's based on the item's weight. Because we keep it at cost, buyers cover return shipping (see <a href="/returns" class="text-cyan-400 hover:text-cyan-300">Returns &amp; Exchanges</a>).</p>
      <h2 class="text-xl font-bold text-white mt-8 not-prose">Free local delivery 🚚</h2>
      <p><strong class="text-white">Local to us?</strong> We deliver <strong>free within 45 miles of Waynesville, North Carolina</strong>. Just choose <strong>“Local delivery (free)”</strong> at checkout. If your address turns out to be outside the zone, we'll reach out to set up standard shipping before anything ships — no surprise charges, ever.</p>
      <h2 class="text-xl font-bold text-white mt-8 not-prose">Questions?</h2>
      <p>Email <a href="mailto:sales@nubztoys.com" class="text-cyan-400 hover:text-cyan-300">sales@nubztoys.com</a> or call <a href="tel:+18286494355" class="text-cyan-400 hover:text-cyan-300">828-649-4355</a>. Real people, real answers.</p>
    </div>
    <div class="mt-10">
      <a href="/inventory" class="inline-flex items-center gap-x-2 px-8 py-4 bg-white text-slate-950 font-bold rounded-3xl hover:bg-slate-100 transition">Start shopping</a>
    </div>
  </article>`;
  return head({ title: `Shipping | ${SITE_NAME}`, desc, canonical, image: SITE + LOGO,
    type: 'website', jsonld: [crumbLd] }) + body + footer();
}

function returnsPage() {
  const canonical = `${SITE}/returns`;
  const desc = 'Returns & Exchanges at Nubz Toys — 30-day returns on new, unopened items. Manufacturer defects and fulfillment errors always made right. Easy process.';
  const crumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Returns & Exchanges', item: canonical },
    ],
  };

  const body = `
  <nav class="max-w-4xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a><span class="mx-2">/</span><span class="text-slate-300">Returns &amp; Exchanges</span>
  </nav>
  <article class="max-w-4xl mx-auto px-6 py-16">
    <h1 class="text-4xl font-bold gradient-title inline-block mb-3">Returns &amp; Exchanges</h1>
    <p class="text-slate-500 text-sm mb-10">We want you to love what you ordered. Here's how returns work.</p>
    <div class="grid md:grid-cols-3 gap-4 mb-10">
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
        <div class="text-3xl mb-2">📦</div>
        <div class="font-bold text-white">30 Days</div>
        <div class="text-slate-400 text-sm mt-1">Return window from delivery</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
        <div class="text-3xl mb-2">✅</div>
        <div class="font-bold text-white">New &amp; Unopened</div>
        <div class="text-slate-400 text-sm mt-1">Item must be in original condition</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
        <div class="text-3xl mb-2">💳</div>
        <div class="font-bold text-white">Full Refund</div>
        <div class="text-slate-400 text-sm mt-1">Sales price refunded, no restocking fee</div>
      </div>
    </div>
    <div class="prose prose-invert text-slate-300 leading-relaxed space-y-5 text-base">
      <p>We accept returns on new, unopened merchandise purchased from us within 30 days of delivery. Items must be in original, unaltered condition with original packaging intact. We do not accept returns on opened, damaged, or altered merchandise.</p>
      <p>Since we do not upcharge for shipping, return shipping is the buyer's responsibility. Refunds are equal to the sales price of the item at the time of purchase. We currently do not charge a restocking fee, though we reserve the right to introduce them on a case-by-case basis if the policy is abused.</p>
      <h2 class="text-xl font-bold text-white mt-8 not-prose">Exceptions — We Always Make It Right</h2>
      <p>Manufacturer defects (no, that hand was <em>not</em> supposed to fall off Superman!) and fulfillment errors on our end (you received Donatello instead of Squirtle) are fully covered. In these cases, we will either send the correct item or issue a full refund including return shipping — your choice.</p>
      <h2 class="text-xl font-bold text-white mt-8 not-prose">How to Start a Return</h2>
      <p>Email us at <a href="mailto:sales@nubztoys.com" class="text-cyan-400 hover:text-cyan-300">sales@nubztoys.com</a> with your order details and the reason for the return. Please respond to any follow-up communication so we can process it quickly. Have a Nub-riffic day!</p>
    </div>
    <div class="mt-10">
      <a href="/contact" class="inline-flex items-center gap-x-2 px-8 py-4 bg-white text-slate-950 font-bold rounded-3xl hover:bg-slate-100 transition">
        <i class="fa-solid fa-envelope"></i> Start a Return
      </a>
    </div>
  </article>`;

  return head({ title: `Returns & Exchanges | ${SITE_NAME}`, desc, canonical, image: SITE + LOGO,
    type: 'website', jsonld: [crumbLd] }) + body + footer();
}

// ── ORDER CONFIRMATION PAGE ──────────────────────────────────────────────
// Real, standalone URL Stripe redirects to on a successful checkout (see
// api/create-checkout.js success_url). Replaces the old approach of dumping
// the customer back on the homepage with a toast that vanished in 6 seconds —
// that read as "paid then dumped back on the site" with no proof of purchase.
// noindex'd (transactional, not for search) and left out of sitemap.xml.
function orderConfirmedPage() {
  const canonical = `${SITE}/order-confirmed`;
  const desc = `Your order at ${SITE_NAME} is confirmed.`;

  const body = `
  <section class="max-w-2xl mx-auto px-6 py-16">
    <div class="text-center mb-10">
      <div class="inline-flex items-center justify-center w-20 h-20 rounded-full bg-emerald-500/15 border border-emerald-500/40 mb-6">
        <i class="fa-solid fa-check text-4xl text-emerald-400"></i>
      </div>
      <h1 class="text-4xl md:text-5xl font-bold gradient-title inline-block mb-4">Order Confirmed!</h1>
      <p class="text-slate-400 text-lg">Thank you for shopping at ${esc(SITE_NAME)}.</p>
    </div>
    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-8 mb-8 text-center">
      <p class="text-slate-300 mb-2"><i class="fa-solid fa-envelope text-cyan-400 mr-2"></i>A confirmation email with your receipt is on its way.</p>
      <p class="text-slate-300 mb-4"><i class="fa-solid fa-box text-cyan-400 mr-2"></i>We'll get your order packed and shipped within 1–2 business days.</p>
      <p id="order-ref" class="text-slate-500 text-xs font-mono hidden"></p>
    </div>
    <div class="grid sm:grid-cols-2 gap-4 mb-12">
      <a href="/" class="text-center py-4 bg-white text-slate-950 font-bold rounded-3xl hover:bg-slate-100 transition">Continue Shopping</a>
      <a href="/inventory" class="text-center py-4 bg-slate-900 border border-slate-700 text-white font-bold rounded-3xl hover:bg-slate-800 transition">Browse All Inventory</a>
    </div>
    <div class="text-center mb-6">
      <p class="text-xs uppercase tracking-[2px] text-slate-500 font-semibold">While you're here</p>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
      <a href="https://wildernessdealz.com" target="_blank" rel="noopener noreferrer" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-solid fa-store text-2xl text-amber-400 mb-2"></i>
        <p class="font-semibold text-sm">Wilderness Dealz</p>
        <p class="text-slate-500 text-xs mt-1">Our sister shop</p>
      </a>
      <a href="${SOCIAL.instagram}" target="_blank" rel="noopener noreferrer" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-brands fa-instagram text-2xl text-fuchsia-400 mb-2"></i>
        <p class="font-semibold text-sm">Instagram</p>
        <p class="text-slate-500 text-xs mt-1">Follow along</p>
      </a>
      <a href="${SOCIAL.facebook}" target="_blank" rel="noopener noreferrer" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-brands fa-facebook text-2xl text-cyan-400 mb-2"></i>
        <p class="font-semibold text-sm">Facebook</p>
        <p class="text-slate-500 text-xs mt-1">Like our page</p>
      </a>
      <a href="${SOCIAL.youtube}" target="_blank" rel="noopener noreferrer" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-brands fa-youtube text-2xl text-red-400 mb-2"></i>
        <p class="font-semibold text-sm">YouTube</p>
        <p class="text-slate-500 text-xs mt-1">Watch our videos</p>
      </a>
      <a href="${SOCIAL.whatnot}" target="_blank" rel="noopener noreferrer" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-solid fa-tower-broadcast text-2xl text-violet-400 mb-2"></i>
        <p class="font-semibold text-sm">Whatnot</p>
        <p class="text-slate-500 text-xs mt-1">Live auctions</p>
      </a>
      <a href="/blog" class="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-cyan-500/50 transition text-center">
        <i class="fa-solid fa-newspaper text-2xl text-emerald-400 mb-2"></i>
        <p class="font-semibold text-sm">Blog</p>
        <p class="text-slate-500 text-xs mt-1">Latest posts</p>
      </a>
    </div>
  </section>
  <script>
    (function() {
      try {
        // Order confirmed — clear the cart (shared localStorage key with the storefront).
        localStorage.removeItem('nubz_cart');
        var params = new URLSearchParams(window.location.search);
        var sid = params.get('sid');
        var value = parseFloat(params.get('value')) || 0;
        if (sid) {
          var ref = document.getElementById('order-ref');
          if (ref) { ref.textContent = 'Order ref: ' + sid.slice(-12); ref.classList.remove('hidden'); }
        }
        // Google Ads purchase conversion — reports the real order value + Stripe id.
        if (window.gtag && (sid || value)) {
          gtag('event', 'conversion', {
            send_to: 'AW-18266305787/1jErCIyB988cEPvphoZE',
            value: value,
            currency: 'USD',
            transaction_id: sid || ''
          });
        }
      } catch (e) {}
    })();
  </script>`;

  return head({ title: `Order Confirmed | ${SITE_NAME}`, desc, canonical, image: SITE + LOGO,
    type: 'website', jsonld: [] }).replace('</title>', '</title>\n  <meta name="robots" content="noindex,nofollow">') + body + footer();
}

// ── MAIN ───────────────────────────────────────────────────────────────
(async () => {
  const raw = await getProducts();

  // assign unique slugs
  const seen = {};
  const products = raw.map(p => {
    let s = slugify(p.name);
    if (seen[s]) s = `${s}-${(seen[s] = (seen[s] || 1) + 1)}`; else seen[s] = 1;
    return { ...p, slug: s };
  });

  // Start clean so renamed/removed products don't leave orphan pages.
  // (No-op on overwrite-only filesystems; Vercel always builds from a clean checkout.)
  for (const d of [PRODUCTS_DIR, CATEGORIES_DIR]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  }
  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  fs.mkdirSync(CATEGORIES_DIR, { recursive: true });

  // category map — FULL (every product; keeps product pages + sitemap alive)
  const byCat = {};
  for (const p of products) {
    const cats = p.categories.length ? p.categories : ['Toys'];
    for (const c of cats) (byCat[c] = byCat[c] || []).push(p);
  }

  // RETREAT: sold-out items disappear from BROWSE (category grids, related,
  // categories index, homepage) so customers never hit a dead listing — but
  // each keeps its own product page + sitemap entry so the earned Google
  // authority survives and it's a one-flip return when restocked.
  const isLive = (p) => availState(p) !== 'sold_out';
  const liveByCat = {};
  for (const [cat, items] of Object.entries(byCat)) {
    const live = items.filter(isLive);
    if (live.length) liveByCat[cat] = live;
  }

  // product pages for ALL products (sold-out included → URL stays crawlable),
  // related pulled from LIVE items only (never link out to a retreated item).
  for (const p of products) {
    const cat = p.categories[0] || 'Toys';
    const gk = groupKeyOf(p);
    // Related: collapse groups (don't list 4 siblings) and never link back into
    // the item's own group.
    const related = collapseGroups((liveByCat[cat] || []).filter(r => r.slug !== p.slug && groupKeyOf(r) !== gk)).slice(0, 4);
    // Members: all siblings (incl. sold-out, so the picker can grey them) for the
    // variety picker; empty for standalone items.
    const members = groupMembers(p, products);
    fs.writeFileSync(path.join(PRODUCTS_DIR, `${p.slug}.html`), productPage(p, related, members));
  }

  // category pages — page still generated for every category (SEO), grid shows
  // LIVE items only. An all-sold-out category renders empty until restocked.
  for (const cat of Object.keys(byCat)) {
    fs.writeFileSync(path.join(CATEGORIES_DIR, `${slugify(cat)}.html`), categoryPage(cat, liveByCat[cat] || []));
  }

  // categories index page (/categories/) — only categories with live items show.
  fs.writeFileSync(path.join(CATEGORIES_DIR, 'index.html'), categoriesIndexPage(liveByCat));

  // standalone pages — homepage / all-inventory grid shows LIVE items only.
  fs.writeFileSync(path.join(ROOT, 'inventory.html'), inventoryPage(products.filter(isLive)));
  fs.writeFileSync(path.join(ROOT, 'about.html'), aboutPage());
  fs.writeFileSync(path.join(ROOT, 'contact.html'), contactPage());
  fs.writeFileSync(path.join(ROOT, 'privacy-policy.html'), privacyPage());
  fs.writeFileSync(path.join(ROOT, 'returns.html'), returnsPage());
  fs.writeFileSync(path.join(ROOT, 'shipping.html'), shippingPage());
  fs.writeFileSync(path.join(ROOT, 'order-confirmed.html'), orderConfirmedPage());

  // sitemap / robots / snapshot
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap(products, Object.keys(byCat)));
  fs.writeFileSync(path.join(ROOT, 'robots.txt'), robots());
  fs.writeFileSync(path.join(ROOT, 'feed.xml'), productFeed(products));
  fs.writeFileSync(path.join(ROOT, 'products.json'), JSON.stringify(raw, null, 2));

  console.log(`\n✨ Generated:`);
  console.log(`   ${products.length} product pages  -> /products/`);
  console.log(`   ${Object.keys(byCat).length} category pages -> /categories/`);
  console.log(`   /categories/index.html (categories landing page)`);
  console.log(`   /inventory.html, /about.html, /contact.html, /privacy-policy.html, /returns.html`);
  console.log(`   sitemap.xml, robots.txt, products.json`);
})().catch(e => { console.error('❌ Build failed:', e); process.exit(1); });
