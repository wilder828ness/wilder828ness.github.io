// api/stripe-webhook.js — own-site sale automation.
// On a completed Stripe checkout it: (1) records the sale into the Master DB
// (feeds the Ledger + CRM, idempotent by session id), and (2) draws the
// storefront product down and flips it to Sold Out when it hits zero (instant
// retreat, no manual publish). Optionally kicks a rebuild so static pages update.
//
// Vercel env vars (nubztoys project):
//   STRIPE_SECRET_KEY            (already set — used to re-fetch/verify the session)
//   SUPABASE_URL                 storefront project URL (default below)
//   SUPABASE_SERVICE_ROLE_KEY    storefront service key (already set for publish.js)
//   MASTER_SUPABASE_URL          wd-master URL (default below)
//   MASTER_SERVICE_ROLE_KEY      wd-master SERVICE ROLE key  ← the one new secret
//   REBUILD_HOOK_URL             (optional) Vercel deploy hook to regenerate static pages
//
// Stripe setup: Dashboard → Developers → Webhooks → add endpoint
//   https://nubztoys.com/api/stripe-webhook  → event: checkout.session.completed
// We verify by re-fetching the session from Stripe (no raw-body signature needed).

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPA_URL       = process.env.SUPABASE_URL || 'https://vdkjjyjfwfndrksruisn.supabase.co';
const SERVICE        = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MASTER_URL     = process.env.MASTER_SUPABASE_URL || 'https://zprwqahydkwsmvgcpots.supabase.co';
const MASTER_SERVICE = process.env.MASTER_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const event = req.body;
  if (!event || event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  try {
    // Verify by retrieving the real session from Stripe (authenticates the event).
    const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
    if (session.payment_status !== 'paid') return res.status(200).json({ ignored: 'not paid' });

    let items = [];
    try { items = JSON.parse((session.metadata && session.metadata.items) || '[]'); } catch (e) {}
    if (!items.length) return res.status(200).json({ ignored: 'no item metadata' });

    const cd   = session.customer_details || {};
    const addr = cd.address || {};
    const subtotal = items.reduce((s, i) => s + (Number(i.p) || 0) * (Number(i.q) || 1), 0);
    const procFee  = Math.round((0.029 * ((session.amount_total || 0) / 100) + 0.30) * 100) / 100;

    // ── 1. Record into the Master DB (idempotent by external_order_id = session id) ──
    // masterDebug travels in the JSON response so Ron can see exactly why a recording
    // attempt failed straight from the Stripe webhook event log — no log-digging needed.
    let recorded = false, alreadyDone = false;
    const masterDebug = { key_present: !!MASTER_SERVICE };
    if (MASTER_SERVICE) {
      const mh = { apikey: MASTER_SERVICE, Authorization: `Bearer ${MASTER_SERVICE}`, 'Content-Type': 'application/json' };
      // Map storefront SKUs → master product ids.
      const mItems = [];
      const lookupIssues = [];
      for (const it of items) {
        const r = await fetch(`${MASTER_URL}/rest/v1/products?sku=eq.${encodeURIComponent(it.s)}&select=id&limit=1`, { headers: mh });
        const rows = await r.json().catch(() => null);
        if (Array.isArray(rows) && rows[0]) {
          mItems.push({ product_id: rows[0].id, qty: Number(it.q) || 1, unit_price: Number(it.p) || 0 });
        } else {
          // Either the SKU truly isn't in the master catalog, or the key was rejected
          // (r.status 401/403 = bad/expired key; body carries Supabase's own message).
          lookupIssues.push({ sku: it.s, http_status: r.status, response: rows });
        }
      }
      masterDebug.matched = mItems.length;
      if (lookupIssues.length) masterDebug.lookup_issues = lookupIssues;
      if (mItems.length) {
        const body = {
          p_items: mItems, p_channel: 'nubz', p_store: 'NBZ',
          p_platform_fee: 0, p_processing_fee: procFee, p_shipping_collected: 0, p_shipping_cost: 0,
          p_order_date: new Date().toISOString(), p_external_order_id: session.id,
          p_buyer_name: cd.name || null, p_buyer_email: cd.email || null, p_buyer_phone: cd.phone || null,
          p_addr1: addr.line1 || null, p_addr2: addr.line2 || null, p_city: addr.city || null,
          p_state: addr.state || null, p_postal: addr.postal_code || null, p_country: addr.country || null,
          p_notes: 'Stripe web order', p_username: null,
        };
        const rr = await fetch(`${MASTER_URL}/rest/v1/rpc/record_sale_multi`, { method: 'POST', headers: mh, body: JSON.stringify(body) });
        if (rr.ok) { recorded = true; }
        else {
          const txt = await rr.text();
          masterDebug.rpc_error = txt.slice(0, 300);
          if (/already recorded/i.test(txt)) { alreadyDone = true; } // idempotent: this session was already processed
          else console.error('master record_sale_multi failed:', txt);
        }
      }
    }

    // Already processed → don't double-decrement the storefront.
    if (alreadyDone) return res.status(200).json({ ok: true, note: 'already processed' });

    // ── 2. Storefront: draw down + retreat at zero ──
    const storefrontDebug = { key_present: !!SERVICE, decremented: 0 };
    if (SERVICE) {
      const sh = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
      const issues = [];
      for (const it of items) {
        const r = await fetch(`${SUPA_URL}/rest/v1/products?sku=eq.${encodeURIComponent(it.s)}&select=id,quantity`, { headers: sh });
        const rows = await r.json().catch(() => null);
        const p = Array.isArray(rows) && rows[0];
        if (!p) { issues.push({ sku: it.s, http_status: r.status, response: rows }); continue; }
        const newQty = Math.max(0, (Number(p.quantity) || 0) - (Number(it.q) || 1));
        const upd = { quantity: newQty };
        if (newQty === 0) upd.status = 'Sold Out';
        await fetch(`${SUPA_URL}/rest/v1/products?id=eq.${p.id}`, { method: 'PATCH', headers: { ...sh, Prefer: 'return=minimal' }, body: JSON.stringify(upd) });
        storefrontDebug.decremented++;
      }
      if (issues.length) storefrontDebug.lookup_issues = issues;
    }

    // ── 3. Optional: regenerate static pages so a sold-out item leaves the static browse too ──
    if (process.env.REBUILD_HOOK_URL) {
      try { await fetch(process.env.REBUILD_HOOK_URL, { method: 'POST' }); } catch (e) {}
    }

    return res.status(200).json({ ok: true, recorded, items: items.length, masterDebug, storefrontDebug });
  } catch (e) {
    console.error('stripe-webhook error:', e);
    // Return 200 so Stripe doesn't hammer retries on a transient issue we've logged.
    return res.status(200).json({ ok: false, error: e.message });
  }
};
