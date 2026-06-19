// /api/rebuild — triggers a Vercel rebuild via a Deploy Hook so newly added,
// edited, or removed products regenerate their static pages + sitemap.xml
// automatically (no manual redeploy). The admin calls this after a catalog change.
//
// Setup: create a Vercel Deploy Hook and store its URL as the REBUILD_HOOK_URL
// environment variable in Vercel. If it isn't set, this endpoint succeeds quietly
// so the admin UI never errors.

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://nubztoys.com');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const hook = process.env.REBUILD_HOOK_URL;
    if (!hook) {
        // Not configured yet — don't error the admin; just report it was skipped.
        return res.status(200).json({ ok: false, skipped: 'REBUILD_HOOK_URL not set' });
    }

    try {
        const r = await fetch(hook, { method: 'POST' });
        return res.status(200).json({ ok: r.ok, status: r.status });
    } catch (e) {
        return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
};
