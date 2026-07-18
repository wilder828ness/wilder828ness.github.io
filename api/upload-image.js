// api/upload-image.js — lets the Back Office (wd-master) edit screen upload a
// product photo straight into the storefront's Supabase Storage bucket, without
// needing a second admin login. Mirrors publish.js's pattern exactly: the Back
// Office authorizes with its own (wd-master) session JWT; this endpoint verifies
// that, then uses the storefront's service_role key server-side to do the actual
// upload and hands back the public URL.
//
// Vercel env vars (same project/values as publish.js already uses):
//   SUPABASE_URL               = https://vdkjjyjfwfndrksruisn.supabase.co   (storefront project)
//   SUPABASE_SERVICE_ROLE_KEY  = (storefront service_role / secret key — server-side only!)
//   MASTER_SUPABASE_URL        = https://zprwqahydkwsmvgcpots.supabase.co   (optional override)
//   MASTER_SUPABASE_ANON       = (optional override)
//
// Requires the 'product-images' Storage bucket to already exist (it does —
// see Photo-Upload-Storage-Setup.md), public read, and that this call uses the
// service_role key so it bypasses the "authenticated" insert policy on
// storage.objects (the Back Office session is a wd-master JWT, not a storefront
// one, so it wouldn't satisfy that policy directly).

const SUPA_URL = process.env.SUPABASE_URL || 'https://vdkjjyjfwfndrksruisn.supabase.co';
const SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MASTER_URL  = process.env.MASTER_SUPABASE_URL  || 'https://zprwqahydkwsmvgcpots.supabase.co';
const MASTER_ANON = process.env.MASTER_SUPABASE_ANON || 'sb_publishable_V2qZ8k1tn8rbDWQDH-tohw_HoFLl49v';
const BUCKET = 'product-images';
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — client already resizes/compresses before sending

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });
  if (!SERVICE) return res.status(500).json({ error: 'Server not configured: SUPABASE_SERVICE_ROLE_KEY missing' });

  // Authorize the caller: must present a valid, unexpired wd-master login (JWT) —
  // same check publish.js uses, so only a signed-in Back Office user can upload.
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

  const { filename, contentType, dataBase64 } = req.body || {};
  if (!filename || !dataBase64) return res.status(400).json({ error: 'filename and dataBase64 required' });

  try {
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length > MAX_BYTES) return res.status(400).json({ error: 'Image too large (max 8MB) — resize before upload' });

    const cleanExt = (String(filename).split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = 'products/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + cleanExt;

    const upRes = await fetch(`${SUPA_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': contentType || 'image/jpeg',
        'Cache-Control': '31536000',
        'x-upsert': 'false',
      },
      body: bytes,
    });
    if (!upRes.ok) {
      const detail = await upRes.text().catch(() => '');
      return res.status(500).json({ error: 'Storage upload failed', detail });
    }

    const publicUrl = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    return res.status(200).json({ ok: true, url: publicUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
