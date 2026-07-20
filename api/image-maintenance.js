// api/image-maintenance.js — resize an existing Storage image IN PLACE (same
// path/URL, so nothing in products.images needs to change), or delete a
// confirmed-unused one. Built after a real incident: manually swapping a
// product's image URL to a different "smaller" file turned out to point at
// the wrong image. Resizing in place removes that whole class of mistake —
// the URL never changes, only the bytes behind it get smaller.
//
// Same auth pattern as publish.js/upload-image.js: caller must present a
// valid wd-master (Back Office) session JWT.
//
// Vercel env vars (same project/values as publish.js and upload-image.js):
//   SUPABASE_URL               = https://vdkjjyjfwfndrksruisn.supabase.co   (storefront project)
//   SUPABASE_SERVICE_ROLE_KEY  = (storefront service_role / secret key — server-side only!)
//   MASTER_SUPABASE_URL        = https://zprwqahydkwsmvgcpots.supabase.co   (optional override)
//   MASTER_SUPABASE_ANON       = (optional override)
//
// Note on caching: the object is overwritten at the same path with a 1-year
// Cache-Control header. Supabase's own edge cache is invalidated on upsert,
// but a browser that already cached the old (large) file at that URL may keep
// showing it until its own cache expires. Not a concern for correctness, just
// for how fast the size win is visible.

const sharp = require('sharp');

const SUPA_URL = process.env.SUPABASE_URL || 'https://vdkjjyjfwfndrksruisn.supabase.co';
const SERVICE  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MASTER_URL  = process.env.MASTER_SUPABASE_URL  || 'https://zprwqahydkwsmvgcpots.supabase.co';
const MASTER_ANON = process.env.MASTER_SUPABASE_ANON || 'sb_publishable_V2qZ8k1tn8rbDWQDH-tohw_HoFLl49v';
const BUCKET = 'product-images';
const MAX_EDGE_DEFAULT = 1600;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });
  if (!SERVICE) return res.status(500).json({ error: 'Server not configured: SUPABASE_SERVICE_ROLE_KEY missing' });

  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const who = await fetch(`${MASTER_URL}/auth/v1/user`, { headers: { apikey: MASTER_ANON, Authorization: `Bearer ${bearer}` } });
    if (!who.ok) return res.status(401).json({ error: 'Unauthorized — please sign in again' });
  } catch (e) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }

  const { action, path, maxEdge } = req.body || {};
  if (!action || !path) return res.status(400).json({ error: 'action and path required' });
  if (!path.startsWith('products/')) return res.status(400).json({ error: 'Refusing to touch a path outside products/' });

  const objUrl = `${SUPA_URL}/storage/v1/object/${BUCKET}/${path}`;
  const publicUrl = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  const authHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

  try {
    if (action === 'delete') {
      const delRes = await fetch(objUrl, { method: 'DELETE', headers: authHeaders });
      if (!delRes.ok) {
        const detail = await delRes.text().catch(() => '');
        return res.status(500).json({ error: 'Delete failed', detail });
      }
      return res.status(200).json({ ok: true, action: 'deleted', path });
    }

    if (action === 'resize') {
      const getRes = await fetch(publicUrl);
      if (!getRes.ok) return res.status(404).json({ error: 'Source image not found at ' + publicUrl });
      const before = Buffer.from(await getRes.arrayBuffer());

      const meta = await sharp(before).metadata();
      const edge = Number(maxEdge) || MAX_EDGE_DEFAULT;
      const longest = Math.max(meta.width || 0, meta.height || 0);

      let pipeline = sharp(before);
      if (longest > edge) {
        pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
      }

      // Keep the same format the file already is — never change the extension,
      // since the path/URL isn't changing.
      const isPng = /\.png$/i.test(path) || meta.format === 'png';
      const out = isPng
        ? await pipeline.png({ quality: 85, compressionLevel: 9 }).toBuffer()
        : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();

      const upRes = await fetch(objUrl, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': isPng ? 'image/png' : 'image/jpeg', 'x-upsert': 'true', 'Cache-Control': '31536000' },
        body: out,
      });
      if (!upRes.ok) {
        const detail = await upRes.text().catch(() => '');
        return res.status(500).json({ error: 'Re-upload failed', detail });
      }

      return res.status(200).json({
        ok: true, action: 'resized', path,
        beforeBytes: before.length, afterBytes: out.length, savedBytes: before.length - out.length,
        origWidth: meta.width, origHeight: meta.height,
      });
    }

    return res.status(400).json({ error: 'Unknown action — use "resize" or "delete"' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
