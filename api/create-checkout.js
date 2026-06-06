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
            success_url: 'https://nubztoys.com?order=success',
            cancel_url: 'https://nubztoys.com?order=cancelled',
            billing_address_collection: 'required',
            shipping_address_collection: {
                allowed_countries: ['US', 'CA', 'GB', 'AU']
            },
            metadata: {
                source: 'nubztoys-web'
            }
        });

        return res.status(200).json({ url: session.url });

    } catch (error) {
        console.error('Stripe session error:', error);
        return res.status(500).json({ error: error.message });
    }
};
