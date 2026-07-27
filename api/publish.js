// api/publish.js — Phase 2 sync: publish an approved Master item into the
// Nubz storefront database. Called by the inventory dashboard's "Publish" button.
//
// Vercel env vars to set (Project → Settings → Environment Variables):
//   SUPABASE_URL                = https://vdkjjyjfwfndrksruisn.supabase.co   (storefront project)
//   SUPABASE_SERVICE_ROLE_KEY   = (storefront service_role / secret key — server-side only!)
//   PUBLISH_TOKEN               = (any long random string; the dashboard sends it to authorize)
//   REBUILD_HOOK_URL            = (optional — your existing Vercel deploy hook, to regenerate static pages)
//
// Security: the service_role key bypasses RLS, so it lives ONLY here on the server,
// never in the browser. Callers must present the matching PUBLISH_TOKEN.

const SUPA_URL = process.env.SUPABASE_URL || 'https://vdkjjyjfwfndrksruisn.supabase.co';
const SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
// The dashboard authorizes with the caller's Master (wd-master) Supabase login
// (a JWT), not a static token — so nothing sensitive lives in the hosted page.
const MASTER_URL  = process.env.MASTER_SUPABASE_URL  || 'https://zprwqahydkwsmvgcpots.supabase.co';
const MASTER_ANON = process.env.MASTER_SUPABASE_ANON || 'sb_publishable_V2qZ8k1tn8rbDWQDH-tohw_HoFLl49v';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });
  if (!SERVICE) return res.status(500).json({ error: 'Server not configured: SUPABASE_SERVICE_ROLE_KEY missing' });

  // Authorize the caller: must present a valid, unexpired wd-master login (JWT).
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const who = await fetch(`${MASTER_URL}/auth/v1/user`, {
      headers: { apikey: MASTER_ANON, Authorization: `Bearer ${bearer}` },
    });
    if (!who.ok) return res.status(401).json({ error: 'Unauthorized — please sign in again' });
  } catch (e) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }

  const p = (req.body && req.body.product) || {};
  if (!p.sku || !p.name) return res.status(400).json({ error: 'product requires at least sku + name' });

  const base = `${SUPA_URL}/rest/v1/products`;
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

  // Storefront stores `images` as a comma-separated STRING (the SPA + generate.js
  // split it back into an array on load), NOT a JSON array. Every other writer
  // (SPA add/edit, CSV import) joins before writing; publish.js used to send a raw
  // array, which PostgREST stored as a bracketed literal ["…"] in the text column —
  // that then rendered as a broken/stock image and never showed the uploaded photo.
  // Flatten to the same comma-separated format here. (imagesArr kept for the length
  // check on the re-publish path below.)
  const imagesArr = Array.isArray(p.images) ? p.images.filter(Boolean) : (p.images ? [p.images] : []);
  const imagesStr = imagesArr.join(', ');

  // Map Master fields → storefront product columns.
  const row = {
    name:            p.name,
    brand:           p.brand || null,
    // Storefront stores categories as a comma-separated STRING (it splits on load),
    // so flatten whatever we get into that format — never a JSON array.
    categories:      Array.isArray(p.categories) ? p.categories.join(', ') : (p.categories || p.category || ''),
    price:           p.price != null ? p.price : 0,
    compare_to:      p.compare_to != null ? p.compare_to : null,
    quantity:        p.quantity != null ? p.quantity : 0,
    shipping_weight: p.shipping_weight != null ? p.shipping_weight : 0,
    status:          p.status || 'In Stock',
    images:          imagesStr,
    description:     p.description || '',
    sku:             p.sku,
    upc:             p.upc || null,
    cost:            p.cost != null ? p.cost : null,
    // Grouped-items (variety picker) fields — pass through master → storefront so
    // the storefront can render varieties as one card. All nullable; a standalone
    // item just sends nulls and renders exactly as before.
    group_key:       p.group_key || null,
    variant_label:   p.variant_label || null,
    group_sort:      (p.group_sort === 0 || p.group_sort) ? Number(p.group_sort) : null,
    group_name:      p.group_name || null,
  };

  try {
    // Upsert by SKU. Also read the store's current price so we don't clobber it.
    const findRes = await fetch(`${base}?sku=eq.${encodeURIComponent(p.sku)}&select=id,price,compare_to`, { headers });
    const found   = await findRes.json();

    let method, url, body;
    if (Array.isArray(found) && found.length) {
      // UPDATE existing listing. The STOREFRONT owns price + merchandising once live,
      // so a re-publish syncs availability only (status + quantity). Price/compare are
      // filled ONLY if the store has none yet, and are NEVER overwritten once set.
      const ex  = found[0];
      // Sync availability + cost (both master-owned). cost flows on every re-publish
      // so a later landed-cost update (freight added) reaches the store when you publish.
      const upd = { status: row.status, quantity: row.quantity, cost: row.cost };
      if (ex.price == null || Number(ex.price) === 0)           upd.price = row.price;
      if (ex.compare_to == null || Number(ex.compare_to) === 0) upd.compare_to = row.compare_to;
      // Grouping is master-owned (back office decides which items form a card), so
      // sync it on every re-publish — including clearing it (ungrouping an item).
      upd.group_key = row.group_key; upd.variant_label = row.variant_label;
      upd.group_sort = row.group_sort; upd.group_name = row.group_name;
      // Sync the image on re-publish when Master actually has one. This is what
      // makes the Back Office photo upload reach the live storefront — previously
      // images were dropped on UPDATE (treated as store-owned merchandising), so a
      // newly uploaded photo saved to Master but never appeared on the site; the
      // store kept its original/stock image.
      //   * Only sets images when Master has a non-empty image — so a re-publish
      //     can NEVER wipe the store's image to blank.
      //   * When Master has an image, it becomes authoritative (replaces the
      //     store's). That's the intended workflow now that photos are managed in
      //     the Back Office. TRADE-OFF: if you ever added extra angles / reordered
      //     images directly in the storefront admin for this product, the next
      //     publish will replace them with Master's single image. Flagged for Ron —
      //     easy to change to "fill only if the store has none" if he prefers.
      if (imagesArr.length) upd.images = imagesStr;
      method = 'PATCH'; url = `${base}?sku=eq.${encodeURIComponent(p.sku)}`; body = upd;
    } else {
      // CREATE: first publish seeds everything (initial staged price included).
      method = 'POST';  url = base; row.id = Date.now(); body = row;
    }

    const wRes   = await fetch(url, { method, headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(body) });
    const result = await wRes.json();
    if (!wRes.ok) return res.status(500).json({ error: (result && result.message) || 'write failed', detail: result });

    // Optionally kick a rebuild so the static product/category pages regenerate.
    if (process.env.REBUILD_HOOK_URL) {
      try { await fetch(process.env.REBUILD_HOOK_URL, { method: 'POST' }); } catch (e) { /* non-fatal */ }
    }

    return res.status(200).json({
      ok: true,
      action: method === 'POST' ? 'created' : 'updated',
      product: Array.isArray(result) ? result[0] : result,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
