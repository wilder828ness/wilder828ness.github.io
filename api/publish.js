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
const TOKEN    = process.env.PUBLISH_TOKEN;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });
  if (!SERVICE) return res.status(500).json({ error: 'Server not configured: SUPABASE_SERVICE_ROLE_KEY missing' });

  // Authorize the caller.
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!TOKEN || bearer !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const p = (req.body && req.body.product) || {};
  if (!p.sku || !p.name) return res.status(400).json({ error: 'product requires at least sku + name' });

  const base = `${SUPA_URL}/rest/v1/products`;
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

  // Map Master fields → storefront product columns.
  const row = {
    name:            p.name,
    brand:           p.brand || null,
    categories:      Array.isArray(p.categories) ? p.categories : (p.category ? [p.category] : []),
    price:           p.price != null ? p.price : 0,
    compare_to:      p.compare_to != null ? p.compare_to : null,
    quantity:        p.quantity != null ? p.quantity : 0,
    shipping_weight: p.shipping_weight != null ? p.shipping_weight : 0,
    status:          p.status || 'In Stock',
    images:          Array.isArray(p.images) ? p.images : (p.images ? [p.images] : []),
    description:     p.description || '',
    sku:             p.sku,
    upc:             p.upc || null,
    cost:            p.cost != null ? p.cost : null,
  };

  try {
    // Upsert by SKU: update if it already exists on the store, else insert.
    const findRes = await fetch(`${base}?sku=eq.${encodeURIComponent(p.sku)}&select=id`, { headers });
    const found   = await findRes.json();

    let method, url;
    if (Array.isArray(found) && found.length) {
      method = 'PATCH'; url = `${base}?sku=eq.${encodeURIComponent(p.sku)}`;
    } else {
      method = 'POST';  url = base; row.id = Date.now();
    }

    const wRes   = await fetch(url, { method, headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(row) });
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
