// api/describe.js — generate a product description for the inventory dashboard's
// "✨ Generate" button. Given a product's title/brand/category (+ optional notes),
// returns a short, keyword-rich store description in the Nubz voice.
//
// Vercel env vars (Project → Settings → Environment Variables):
//   PUBLISH_TOKEN      = (same token the dashboard already sends to /api/publish)
//   ANTHROPIC_API_KEY  = (preferred) an Anthropic key  — OR —
//   OPENAI_API_KEY     = an OpenAI key
// Set ONE of the two AI keys. The function auto-detects which is present.
//
// No npm dependencies — uses raw fetch, so nothing to install/build.

const TOKEN = process.env.PUBLISH_TOKEN;

function buildPrompt(p) {
  const bits = [
    p.title  ? `Product: ${p.title}` : '',
    p.brand  ? `Brand: ${p.brand}`   : '',
    p.category ? `Category: ${p.category}` : '',
    p.upc    ? `UPC: ${p.upc}`       : '',
    p.notes  ? `Notes: ${p.notes}`   : '',
  ].filter(Boolean).join('\n');

  return `You are writing a product description for Nubz Toys, an online toy & collectibles shop.
Write ONE concise, engaging description (about 40-70 words) for the product below.
Rules:
- Natural, upbeat retail voice — a collector talking to collectors, never salesy fluff.
- Work in the obvious search keywords (character/line name, brand, type) naturally, no keyword stuffing.
- No headings, no bullet points, no quotes, no emojis. Plain prose, ready to paste.
- Do not invent specifics you can't infer (exact dimensions, materials, release dates). Stay true to what's given.
- Output ONLY the description text, nothing else.

${bits}`;
}

async function viaAnthropic(prompt, key) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Anthropic request failed');
  return (j.content && j.content[0] && j.content[0].text || '').trim();
}

async function viaOpenAI(prompt, key) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'OpenAI request failed');
  return (j.choices && j.choices[0] && j.choices[0].message.content || '').trim();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  // Authorize the caller (same token as /api/publish).
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!TOKEN || bearer !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const p = (req.body && req.body.product) || {};
  if (!p.title) return res.status(400).json({ error: 'product.title is required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    return res.status(500).json({ error: 'No AI key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in Vercel.' });
  }

  try {
    const prompt = buildPrompt(p);
    const text = anthropicKey ? await viaAnthropic(prompt, anthropicKey) : await viaOpenAI(prompt, openaiKey);
    if (!text) return res.status(500).json({ error: 'Empty response from AI' });
    return res.status(200).json({ ok: true, description: text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
