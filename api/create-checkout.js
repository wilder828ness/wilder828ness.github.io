const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
    // Allow CORS
    res.setHeader('Access-Control-Allow-Origin', 'https://nubztoys.com');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { cartItems } = req.body;

        if (!cartItems || cartItems.length === 0) {
            return res.status(400).json({ error: 'Cart is empty' });
        }

        // ── Weight-tiered shipping ──────────────────────────────────────────
        // Light tier (no item over 1.5 lb): $6.00 first item + $1.50 each additional.
        // Heavy tier (any item over 1.5 lb): $8.00 first item + $2.00 each additional.
        // Tier is set by the HEAVIEST single item — so a light + heavy mix charges the
        // heavy tier. Items with no weight set count as 0 (light), so make sure each
        // product has a shipping_weight in the admin (especially the heavy ones).
        const totalQty = cartItems.reduce((s, i) => s + (i.quantity || 1), 0);
        const maxItemWeight = cartItems.reduce((m, i) => Math.max(m, Number(i.shipping_weight) || 0), 0);
        const isHeavy = maxItemWeight > 1.5;
        const baseCents = isHeavy ? 800 : 600;
        const extraCents = isHeavy ? 200 : 150;
        const shippingCents = baseCents + extraCents * Math.max(0, totalQty - 1);

        const lineItems = cartItems.map(item => ({
            price_data: {
                currency: 'usd',
                product_data: {
                    name: item.name,
                    description: item.brand || undefined,
                    images: (item.images && item.images[0] && item.images[0].startsWith('http'))
                        ? [item.images[0]] : undefined
                },
                unit_amount: Math.round((item.price || 0) * 100)
            },
            quantity: item.quantity
        }));

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            // Shows a "Add promotion code" field on the Stripe checkout page.
            // Create the actual codes in the Stripe dashboard (Coupons + Promotion codes).
            allow_promotion_codes: true,
            success_url: 'https://nubztoys.com?order=success',
            cancel_url: 'https://nubztoys.com?order=cancelled',
            billing_address_collection: 'required',
            shipping_address_collection: {
                allowed_countries: ['US', 'CA', 'GB', 'AU']
            },
            // Weight-tiered shipping computed above (shippingCents).
            shipping_options: [
                {
                    shipping_rate_data: {
                        type: 'fixed_amount',
                        fixed_amount: { amount: shippingCents, currency: 'usd' },
                        display_name: 'Shipping',
                        delivery_estimate: {
                            minimum: { unit: 'business_day', value: 2 },
                            maximum: { unit: 'business_day', value: 6 }
                        }
                    }
                }
            ],
            metadata: {
                source: 'nubztoys-web',
                // Compact cart so the webhook knows what sold (sku, qty, price).
                // Stripe caps a metadata value at 500 chars — typical carts fit.
                items: JSON.stringify(
                    cartItems.map(i => ({ s: String(i.sku || i.id || '').slice(0, 24), q: i.quantity || 1, p: Number(i.price) || 0 }))
                ).slice(0, 490)
            }
        });

        return res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe session error:', error);
        return res.status(500).json({ error: error.message });
    }
};
