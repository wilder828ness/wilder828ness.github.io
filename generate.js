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
const GA_ID = process.env.GA_MEASUREMENT_ID || '';
const GA_SNIPPET = GA_ID ? `  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>` : '';

const ROOT           = __dirname;
const PRODUCTS_DIR   = path.join(ROOT, 'products');
const CATEGORIES_DIR = path.join(ROOT, 'categories');
const LOGO           = '/nubz-header-logo.png';

const SOCIAL = {
  facebook:  'https://facebook.nubztoys.com',
  instagram: 'https://instagram.nubztoys.com',
  youtube:   'https://youtube.nubztoys.com',
  whatnot:   'https://whatnot.nubztoys.com',
};

// Canonical categories (match the storefront) + aliases for messy source data.
// Edit this map if your admin uses different category names.
const CATEGORY_ALIASES = {
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
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    html { -webkit-text-size-adjust: 100%; }
    html, body { overflow-x: hidden; }
    body { font-family: 'Inter', system-ui, sans-serif; min-height: 100%; }
    .gradient-title { background: linear-gradient(to right,#22d3ee,#e879f9,#fbbf24);
      -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
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
          <a href="/#categories" class="hover:text-cyan-400">Categories</a>
          <a href="/#inventory" class="hover:text-cyan-400">All Inventory</a>
          <a href="/#about" class="hover:text-cyan-400">About</a>
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
      <div class="flex flex-wrap items-center justify-between gap-6">
        <div>
          <img src="${LOGO}" alt="${esc(SITE_NAME)}" class="h-10 w-auto mb-3">
          <p>Action figures, Funko, blind bags &amp; more — shipped fast from the USA.</p>
        </div>
        <div class="flex items-center gap-x-5 text-xl">
          <a href="${SOCIAL.facebook}"  aria-label="Facebook"  class="hover:text-cyan-400"><i class="fa-brands fa-facebook"></i></a>
          <a href="${SOCIAL.instagram}" aria-label="Instagram" class="hover:text-cyan-400"><i class="fa-brands fa-instagram"></i></a>
          <a href="${SOCIAL.youtube}"   aria-label="YouTube"   class="hover:text-cyan-400"><i class="fa-brands fa-youtube"></i></a>
          <a href="${SOCIAL.whatnot}"   aria-label="Whatnot"   class="hover:text-cyan-400"><i class="fa-solid fa-tower-broadcast"></i></a>
        </div>
      </div>
      <p class="mt-8 text-xs text-slate-600">© ${new Date().getFullYear()} ${esc(SITE_NAME)} — a Wilderness Dealz LLC company. All rights reserved.</p>
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
</body>
</html>`;

// ── PRODUCT PAGE ───────────────────────────────────────────────────────
function productPage(p, related) {
  const slug      = p.slug;
  const canonical = `${SITE}/products/${slug}`;
  const img       = firstImage(p);
  const pr        = price(p);
  const cmp       = Number(p.compare_to);
  const cat       = (p.categories[0] || 'Toys');
  const catSlug   = slugify(cat);
  const desc      = metaFrom(p.description, `${p.name} — available now at ${SITE_NAME}.`);
  const available = inStock(p);

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
      availability: available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
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
          <img src="${esc(firstImage(r))}" alt="${esc(r.name)}" class="w-full aspect-square object-cover" loading="lazy">
          <div class="p-3"><p class="text-sm font-medium line-clamp-2">${esc(r.name)}</p>
          ${price(r) != null ? `<p class="text-cyan-400 font-bold mt-1">$${price(r).toFixed(2)}</p>` : ''}</div>
        </a>`).join('')}
      </div>
    </section>` : '';

  const buyItem = JSON.stringify({
    id: p.id, name: p.name, price: pr || 0, images: p.images, quantity: 1,
  });

  const body = `
  <nav class="max-w-6xl mx-auto px-6 pt-6 text-xs text-slate-500">
    <a href="/" class="hover:text-cyan-400">Home</a>
    <span class="mx-2">/</span>
    <a href="/categories/${catSlug}" class="hover:text-cyan-400">${esc(cat)}</a>
    <span class="mx-2">/</span><span class="text-slate-300">${esc(p.name)}</span>
  </nav>

  <article class="max-w-6xl mx-auto px-6 py-10 grid md:grid-cols-2 gap-12">
    <div>
      <img src="${esc(img)}" alt="${esc(p.name)}" class="w-full rounded-3xl border border-slate-800 bg-slate-900 object-contain">
      ${p.images.length > 1 ? `<div class="grid grid-cols-4 gap-3 mt-3">${p.images.slice(0,4).map(u=>`<img src="${esc(u)}" alt="${esc(p.name)}" class="w-full aspect-square object-cover rounded-xl border border-slate-800" loading="lazy">`).join('')}</div>` : ''}
    </div>
    <div>
      ${p.brand ? `<p class="text-cyan-400 text-sm font-semibold tracking-wide uppercase mb-2">${esc(p.brand)}</p>` : ''}
      <h1 class="text-3xl md:text-4xl font-bold leading-tight mb-4">${esc(p.name)}</h1>
      <div class="flex items-center gap-x-3 mb-6">
        ${pr != null ? `<span class="text-3xl font-bold">$${pr.toFixed(2)}</span>` : ''}
        ${(!isNaN(cmp) && cmp > (pr||0)) ? `<span class="compare-price text-lg">$${cmp.toFixed(2)}</span>` : ''}
        <span class="text-xs font-semibold px-3 py-1 rounded-full ${available ? 'bg-emerald-600/20 text-emerald-400' : 'bg-slate-700 text-slate-300'}">${available ? 'In Stock' : 'Sold Out'}</span>
      </div>
      <div class="prose prose-invert text-slate-300 leading-relaxed mb-8 whitespace-pre-line">${esc(String(p.description || '').split(/keywords:/i)[0].trim())}</div>
      ${available ? `<div class="flex flex-col sm:flex-row gap-3">
        <button id="addCart" class="flex-1 px-8 py-4 bg-cyan-500 hover:bg-cyan-600 text-black font-bold rounded-3xl text-lg inline-flex items-center justify-center gap-x-2"><i class="fa-solid fa-cart-plus"></i> Add to Cart</button>
        <button id="buyNow" class="flex-1 px-8 py-4 bg-white text-slate-950 font-bold rounded-3xl text-lg hover:bg-slate-100 transition inline-flex items-center justify-center gap-x-2"><i class="fa-solid fa-bolt"></i> Buy Now</button>
      </div>
      <div id="addedMsg" class="hidden mt-4 bg-slate-900 border border-slate-700 rounded-2xl p-4">
        <p class="text-cyan-400 font-semibold mb-3"><i class="fa-solid fa-check"></i> Added to your cart.</p>
        <div class="flex flex-col sm:flex-row gap-3">
          <a href="/categories/${catSlug}" class="flex-1 text-center px-5 py-3 border border-slate-600 rounded-2xl font-semibold hover:bg-white/5">← Continue shopping</a>
          <a href="/?checkout=1" class="flex-1 text-center px-5 py-3 bg-white text-slate-950 hover:bg-slate-100 rounded-2xl font-semibold">View cart &amp; checkout →</a>
        </div>
      </div>
      <p class="text-sm text-slate-300 mt-4"><i class="fa-solid fa-bolt text-cyan-400"></i> Fast shipping · Packed with care · <span class="text-amber-400">★</span> 5-star seller on Whatnot</p>
      <p class="text-xs text-slate-500 mt-2">🔒 Secure checkout powered by Stripe</p>` :
      `<a href="/#inventory" class="inline-block px-10 py-4 border border-slate-700 rounded-3xl font-semibold hover:bg-white/5">Browse other items</a>`}
      <p class="mt-6 text-sm"><a href="/categories/${catSlug}" class="text-cyan-400 hover:text-cyan-300">← More in ${esc(cat)}</a></p>
    </div>
  </article>
  ${relatedHtml}
  <script>
    (function(){
      var ITEM = ${buyItem};
      function readCart(){ try { return JSON.parse(localStorage.getItem('nubz_cart')) || []; } catch(e){ return []; } }
      function writeCart(c){ try { localStorage.setItem('nubz_cart', JSON.stringify(c)); } catch(e){} }
      function count(c){ return c.reduce(function(s,i){ return s + (i.quantity||1); }, 0); }
      function syncBadge(){ var el = document.getElementById('navCartCount'); if (el) el.textContent = count(readCart()); }

      var add = document.getElementById('addCart');
      if (add) add.addEventListener('click', function(){
        var c = readCart();
        var ex = c.find(function(x){ return String(x.id) === String(ITEM.id); });
        if (ex) ex.quantity = (ex.quantity||1) + 1; else c.push(Object.assign({}, ITEM));
        writeCart(c); syncBadge();
        document.getElementById('addedMsg').classList.remove('hidden');
        add.innerHTML = '<i class="fa-solid fa-check"></i> Added';
      });

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
  const desc      = `${base} ${n} in stock — fair prices, fast shipping from the USA.`;

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

  const grid = items.map(p => `
    <a href="/products/${p.slug}" class="block bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden hover:border-cyan-500/50 transition">
      <img src="${esc(firstImage(p))}" alt="${esc(p.name)}" class="w-full aspect-square object-cover" loading="lazy">
      <div class="p-4">
        ${p.brand ? `<p class="text-xs text-cyan-400 font-semibold uppercase mb-1">${esc(p.brand)}</p>` : ''}
        <p class="text-sm font-medium line-clamp-2 mb-2">${esc(p.name)}</p>
        ${price(p) != null ? `<p class="font-bold">$${price(p).toFixed(2)}</p>` : ''}
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

  // category map
  const byCat = {};
  for (const p of products) {
    const cats = p.categories.length ? p.categories : ['Toys'];
    for (const c of cats) (byCat[c] = byCat[c] || []).push(p);
  }

  // product pages (+ related from same category)
  for (const p of products) {
    const cat = p.categories[0] || 'Toys';
    const related = (byCat[cat] || []).filter(r => r.slug !== p.slug).slice(0, 4);
    fs.writeFileSync(path.join(PRODUCTS_DIR, `${p.slug}.html`), productPage(p, related));
  }

  // category pages
  for (const [cat, items] of Object.entries(byCat)) {
    fs.writeFileSync(path.join(CATEGORIES_DIR, `${slugify(cat)}.html`), categoryPage(cat, items));
  }

  // sitemap / robots / snapshot
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap(products, Object.keys(byCat)));
  fs.writeFileSync(path.join(ROOT, 'robots.txt'), robots());
  fs.writeFileSync(path.join(ROOT, 'products.json'), JSON.stringify(raw, null, 2));

  console.log(`\n✨ Generated:`);
  console.log(`   ${products.length} product pages  -> /products/`);
  console.log(`   ${Object.keys(byCat).length} category pages -> /categories/`);
  console.log(`   sitemap.xml, robots.txt, products.json`);
})().catch(e => { console.error('❌ Build failed:', e); process.exit(1); });
