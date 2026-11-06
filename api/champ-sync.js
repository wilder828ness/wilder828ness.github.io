// api/champ-sync.js — keep the Nubz storefront in step with Champ (the back office).
//
// Replaces the old wd-master "Publish" button. Champ owns the product and its stock;
// this pulls Champ's product API and updates the storefront database by SKU.
//
// Triggers:
//   • Vercel Cron (vercel.json) every 15 minutes  → GET
//   • Champ → Inventory → Sell elsewhere → Your own website → "Sync now" → POST
//   • You, by hand:  https://nubztoys.com/api/champ-sync?dry=1   (shows what WOULD change, writes nothing)
//
// Vercel env vars (Nubz project):
//   CHAMP_SITE_KEY             = champ_site_…  (create it in Champ; secret — server-side only)
//   CHAMP_API_URL              = optional, default https://app.smbizchamp.com/api/v1/products
//   CHAMP_PRICE_MODE           = optional: "fill" (default) or "champ"
//        fill  → storefront keeps its own price/compare-at once set (Champ only fills blanks)
//        champ → Champ's price/compare-at always win
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (already set — storefront database)
//   REBUILD_HOOK_URL                            (already set — rebuilds static pages when something changed)
//
// What it changes on an existing storefront item (matched by SKU):
//   quantity + status (In Stock / Sold Out) and grouping   — always (Champ owns stock)
//   price / compare-at                                      — per CHAMP_PRICE_MODE
//   photo, name, brand, description, category, UPC, weight  — ONLY when the storefront's is blank
//     (so your own photos and SEO descriptions on the site are never overwritten)
// New Champ items (published, not on the site yet) are created.
// Items Champ marks unpublished are set to Sold Out / quantity 0 (never deleted).
// Storefront items Champ doesn't know about are left alone (listed in the report).

const SUPA_URL = process.env.SUPABASE_URL || 'https://vdkjjyjfwfndrksruisn.supabase.co';
const SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHAMP_URL = process.env.CHAMP_API_URL || 'https://app.smbizchamp.com/api/v1/products';
const CHAMP_KEY = process.env.CHAMP_SITE_KEY;
const PRICE_MODE = (process.env.CHAMP_PRICE_MODE || 'fill').toLowerCase() === 'champ' ? 'champ' : 'fill';

const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const same = (a, b) => (num(a) !== null || num(b) !== null ? num(a) === num(b) : String(a ?? '') === String(b ?? ''));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!SERVICE)   return res.status(500).json({ error: 'Not configured: SUPABASE_SERVICE_ROLE_KEY missing' });
  if (!CHAMP_KEY) return res.status(500).json({ error: 'Not configured: CHAMP_SITE_KEY missing (create a website key in Champ)' });

  const dry = String((req.query && req.query.dry) || '') === '1';

  // 1) Champ's catalog for this site key
  let champ;
  try {
    const r = await fetch(CHAMP_URL, { headers: { Authorization: `Bearer ${CHAMP_KEY}` } });
    champ = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Champ said no', status: r.status, detail: champ });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Champ', detail: String(e && e.message || e) });
  }
  const items = Array.isArray(champ.products) ? champ.products : [];
  const unpublished = new Set(Array.isArray(champ.unpublished) ? champ.unpublished : []);

  // 2) The storefront as it is now
  const sh = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const sr = await fetch(`${SUPA_URL}/rest/v1/products?select=id,sku,name,brand,description,categories,upc,shipping_weight,price,compare_to,quantity,status,images,image,group_key,variant_label,group_sort,group_name&limit=5000`, { headers: sh });
  const store = await sr.json();
  if (!sr.ok || !Array.isArray(store)) return res.status(500).json({ error: 'Could not read the storefront', detail: store });
  const bySku = new Map();
  for (const p of store) if (!blank(p.sku)) bySku.set(String(p.sku).trim(), p);

  const report = { mode: PRICE_MODE, dry, champ_items: items.length, created: [], updated: [], sold_out: [], unchanged: 0, not_in_champ: [], photo_differs: [], errors: [] };
  const writes = []; // { method, url, body, sku, kind }

  for (const c of items) {
    const ex = bySku.get(c.sku);
    const qty = Math.max(0, Number(c.quantity) || 0);
    const status = qty > 0 ? 'In Stock' : 'Sold Out';
    const img = Array.isArray(c.images) && c.images[0] ? c.images[0] : null;

    if (!ex) {
      writes.push({
        kind: 'created', sku: c.sku, method: 'POST', url: `${SUPA_URL}/rest/v1/products`,
        body: {
          sku: c.sku, name: c.title || c.sku, brand: c.brand || null, description: c.description || '',
          categories: c.category || '', upc: c.upc || null, shipping_weight: num(c.shipping_weight) ?? 0,
          price: num(c.price) ?? 0, compare_to: num(c.compare_at), quantity: qty, status,
          images: img || '', group_key: c.group_key || null, variant_label: c.variant_label || null,
          group_sort: num(c.group_sort), group_name: c.group_name || null,
        },
      });
      continue;
    }

    const upd = {};
    const set = (k, v) => { if (!same(ex[k], v)) upd[k] = v; };
    // Champ owns stock + grouping
    set('quantity', qty);
    set('status', status); // also tidies old spellings like "IN Stock"
    set('group_key', c.group_key || null);
    set('variant_label', c.variant_label || null);
    set('group_sort', num(c.group_sort));
    set('group_name', c.group_name || null);
    // Price
    if (PRICE_MODE === 'champ') {
      if (num(c.price) !== null) set('price', num(c.price));
      set('compare_to', num(c.compare_at));
    } else {
      if ((num(ex.price) ?? 0) === 0 && num(c.price) !== null) set('price', num(c.price));
      if ((num(ex.compare_to) ?? 0) === 0 && num(c.compare_at) !== null) set('compare_to', num(c.compare_at));
    }
    // Content: fill blanks only — never overwrite the site's own photos / SEO copy
    if (blank(ex.images) && blank(ex.image) && img) set('images', img);
    else if (img && !String(ex.images || ex.image || '').includes(img)) report.photo_differs.push(c.sku);
    if (blank(ex.name) && c.title) set('name', c.title);
    if (blank(ex.brand) && c.brand) set('brand', c.brand);
    if (blank(ex.description) && c.description) set('description', c.description);
    if (blank(ex.categories) && c.category) set('categories', c.category);
    if (blank(ex.upc) && c.upc) set('upc', c.upc);
    if ((num(ex.shipping_weight) ?? 0) === 0 && num(c.shipping_weight)) set('shipping_weight', num(c.shipping_weight));

    if (Object.keys(upd).length) {
      writes.push({ kind: 'updated', sku: c.sku, changes: upd, method: 'PATCH', url: `${SUPA_URL}/rest/v1/products?id=eq.${ex.id}`, body: upd });
    } else report.unchanged++;
  }

  // Pulled in Champ → Sold Out on the site (kept, never deleted)
  for (const sku of unpublished) {
    const ex = bySku.get(sku);
    if (!ex) continue;
    if (Number(ex.quantity) === 0 && ex.status === 'Sold Out') continue;
    writes.push({ kind: 'sold_out', sku, method: 'PATCH', url: `${SUPA_URL}/rest/v1/products?id=eq.${ex.id}`, body: { quantity: 0, status: 'Sold Out' } });
  }

  const champSkus = new Set(items.map((c) => c.sku));
  for (const sku of bySku.keys()) if (!champSkus.has(sku) && !unpublished.has(sku)) report.not_in_champ.push(sku);
  const noSku = store.filter((p) => blank(p.sku)).map((p) => `${p.id}: ${p.name || '(no name)'}`);
  if (noSku.length) report.no_sku_on_site = noSku;

  // 3) Apply — 10 at a time so a big first sync fits the 10-second limit
  const apply = async (w) => {
    const line = w.kind === 'updated' ? { sku: w.sku, changes: w.changes } : w.sku;
    if (dry) { report[w.kind].push(line); return; }
    try {
      const r = await fetch(w.url, { method: w.method, headers: { ...sh, Prefer: 'return=minimal' }, body: JSON.stringify(w.body) });
      if (!r.ok) report.errors.push({ sku: w.sku, status: r.status, detail: (await r.text()).slice(0, 200) });
      else report[w.kind].push(line);
    } catch (e) {
      report.errors.push({ sku: w.sku, detail: String(e && e.message || e) });
    }
  };
  for (let i = 0; i < writes.length; i += 10) await Promise.all(writes.slice(i, i + 10).map(apply));

  // 4) Rebuild static pages only when something actually changed
  const changed = report.created.length + report.updated.length + report.sold_out.length;
  if (!dry && changed && process.env.REBUILD_HOOK_URL) {
    try { await fetch(process.env.REBUILD_HOOK_URL, { method: 'POST' }); report.rebuild = 'requested'; } catch (e) { report.rebuild = 'failed'; }
  }

  return res.status(report.errors.length ? 207 : 200).json({ ok: report.errors.length === 0, summary: `${report.created.length} new, ${report.updated.length} updated, ${report.sold_out.length} set sold out, ${report.unchanged} unchanged${dry ? ' (dry run — nothing written)' : ''}`, ...report });
};
