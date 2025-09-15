import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { handleCheckoutCompleted, handlePaymentIntentSucceeded, handleRefunded } from './handlers.js';

// --- Stripe key & mode ---
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const IS_TEST = stripeKey.startsWith('sk_test_');

// --- Donation tracker config ---
const CAMPAIGN_KEY   = process.env.CAMPAIGN_KEY   || 'gala2025';
const CAMPAIGN_START = process.env.CAMPAIGN_START || '2025-01-01T00:00:00Z'; 
const ALLOW_ORIGIN   = process.env.ALLOW_ORIGIN   || 'https://gala.bestdayever.info';

// Price IDs by mode (unchanged idea)
const PRICE_BY_TIER = IS_TEST ? {
  gold:   process.env.TEST_PRICE_GOLD,
  silver: process.env.TEST_PRICE_SILVER,
  bronze: process.env.TEST_PRICE_BRONZE,
  ga:     process.env.TEST_PRICE_GA,
} : {
  platinum: process.env.LIVE_PRICE_PLATINUM,
  gold:   process.env.LIVE_PRICE_GOLD,
  silver: process.env.LIVE_PRICE_SILVER,
  bronze: process.env.LIVE_PRICE_BRONZE,
};

// Ensure price IDs exist
for (const [tier, id] of Object.entries(PRICE_BY_TIER)) {
  if (!id) throw new Error(`Missing price id for ${tier} in ${IS_TEST ? 'TEST' : 'LIVE'} mode`);
}

// Webhook secret per env
const STRIPE_WEBHOOK_SECRET = IS_TEST
  ? process.env.STRIPE_WEBHOOK_SECRET_TEST
  : process.env.STRIPE_WEBHOOK_SECRET_LIVE;

console.log('Running in', IS_TEST ? 'TEST' : 'LIVE', 'mode');
console.log('Webhook secret prefix:', (STRIPE_WEBHOOK_SECRET || '').slice(0, 8), 'len:', (STRIPE_WEBHOOK_SECRET || '').length);

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ===== Stripe webhook FIRST (raw body) =====
app.post(
  '/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('Has Stripe-Signature header?', !!req.headers['stripe-signature']);
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;
        case 'payment_intent.succeeded':
          await handlePaymentIntentSucceeded(event.data.object);
          break;
        case 'charge.refunded':
          await handleRefunded(event.data.object);
          break;
        default:
          break;
      }
      return res.json({ received: true });
    } catch (err) {
      console.error('❌ Webhook handler error:', err);
      // Avoid infinite retries if a side-effect fails
      return res.json({ received: true, note: 'handler error logged' });
    }
  }
);

// ===== Other middleware AFTER webhook =====
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// ===== Helpers =====
const SEATS_BY_TIER = { gold: 8, silver: 8, bronze: 8, ga: 1, support_family: 8 };

function computeFeeCover(baseCents, pct = Number(process.env.FEE_PCT || 0.029), fixed = Number(process.env.FEE_FIXED_CENTS || 30)) {
  const gross = (baseCents + fixed) / (1 - pct);
  return Math.round(gross - baseCents);
}

function normalizeTier(input) {
  const v = String(input || '').toLowerCase();
  if (v.includes('gold'))   return 'gold';
  if (v.includes('silver')) return 'silver';
  if (v.includes('bronze')) return 'bronze';
  if (v.includes('general') || v.includes('ga')) return 'ga';
  if (v.includes('support')) return 'support_family';
  return '';
}

// ===== Create Checkout =====
app.post('/create-checkout', async (req, res) => {
  try {
    const {
      first_name = '',
      last_name = '',
      phone = '',
      email = '',
      company_for_sponsorships = '',
      ticket_selection = '',
      additional_donation = '0',
      processing_fee = '',
      accept_terms = '',
      terms_and_conditions = '',
      seats = ''
    } = req.body;

    const buyer_email = String(email).trim();
    const buyer_name  = `${String(first_name||'').trim()} ${String(last_name||'').trim()}`.trim();
    const buyer_phone = String(phone||'').trim();
    const company     = String(company_for_sponsorships||'').trim();

    const tierRaw = String(ticket_selection || '');
    const tier    = normalizeTier(tierRaw);
    const accepted = !!(accept_terms || terms_and_conditions);

    if (!buyer_email) throw new Error('Buyer email is required.');
    if (!tier)        throw new Error('Ticket selection is required.');
    if (!accepted)    throw new Error('Terms must be accepted.');

    const selectedPrice = PRICE_BY_TIER[tier];
    if (!selectedPrice) throw new Error(`Invalid ticket tier: ${tier}`);

    // Donation (extra)
    const donationNum   = Math.max(0, Number(String(additional_donation).replace(/[^0-9.]/g,'')) || 0);
    const donationCents = Math.round(donationNum * 100);

    // Cover fees
    const wantsFeeCover = !!processing_fee;

    // Seats
    const seatsParsed = Number(seats);
    const seatsCount  = Number.isFinite(seatsParsed) && seatsParsed > 0
      ? Math.floor(seatsParsed)
      : (SEATS_BY_TIER[tier] || 1);

    // Build line items
    const line_items = [{ price: selectedPrice, quantity: 1 }];

    // Fee cover amount
    const priceObj        = await stripe.prices.retrieve(selectedPrice);
    const baseAmountCents = priceObj.unit_amount;
    if (wantsFeeCover && typeof baseAmountCents === 'number') {
      const feeCents = computeFeeCover(baseAmountCents);
      if (feeCents > 0) {
        line_items.push({
          price_data: {
            currency: priceObj.currency || 'usd',
            product_data: { name: 'Processing fee cover' },
            unit_amount: feeCents
          },
          quantity: 1
        });
      }
    }

    // Donation line
    if (donationCents > 0) {
      line_items.push({
        price_data: {
          currency: priceObj.currency || 'usd',
          product_data: { name: 'Additional donation' },
          unit_amount: donationCents
        },
        quantity: 1
      });
    }

    const thanks = process.env.THANK_YOU_URL;
    const cancel = process.env.CANCEL_URL;
    if (!thanks || !cancel) throw new Error('THANK_YOU_URL or CANCEL_URL not set.');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${thanks}?tier=${encodeURIComponent(tier)}&order={CHECKOUT_SESSION_ID}&buyer=${encodeURIComponent(buyer_email)}`,
      cancel_url: cancel,
      customer_email: buyer_email,
      phone_number_collection: { enabled: true },
      billing_address_collection: 'auto',
      metadata: {
        tier,
        seats: String(seatsCount),
        covered_fees: wantsFeeCover ? 'true' : 'false',
        donation: donationCents > 0 ? 'true' : 'false',
        donation_amount: donationCents > 0 ? (donationCents/100).toFixed(2) : '0',
        company,
        recognition_name: company,
        buyer_name,
        buyer_phone,
        // 👇 NEW for the tracker
        campaign: CAMPAIGN_KEY,
        counts_for_goal: 'true',
      },
      payment_intent_data: {
        metadata: {
          tier,
          seats: String(seatsCount),
          covered_fees: wantsFeeCover ? 'true' : 'false',
          donation: donationCents > 0 ? 'true' : 'false',
          donation_amount: donationCents > 0 ? (donationCents/100).toFixed(2) : '0',
          company,
          recognition_name: company,
          buyer_name,
          buyer_phone,
          // 👇 NEW (PI search reads this)
          campaign: CAMPAIGN_KEY,
          counts_for_goal: 'true',
        }
      }
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err.message, { body: req.body });
    return res.status(500).send(`Checkout error: ${err.message}`);
  }
});

// --- Admin CSV download (unchanged) ---
app.get('/admin/orders.csv', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send('Unauthorized');

  const filePath = './orders.csv';
  if (!require('fs').existsSync(filePath)) return res.status(404).send('No orders yet');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  require('fs').createReadStream(filePath).pipe(res);
});

// ===== Donation tracker API =====
let _raisedCache = { at: 0, data: null };

app.get('/api/raised', async (req, res) => {
  try {
    // Allow gala site to call this
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);

    // 60s cache
    const cacheMs = 60_000;
    if (_raisedCache.data && Date.now() - _raisedCache.at < cacheMs) {
      return res.json(_raisedCache.data);
    }

    const createdGt = Math.floor(new Date(CAMPAIGN_START).getTime() / 1000);
    let totalCents = 0;

    // Preferred: PaymentIntent Search (server-side filter)
    try {
      const query =
        `status:'succeeded' AND metadata['campaign']:'${CAMPAIGN_KEY}' AND metadata['counts_for_goal']:'true' AND created>${createdGt}`;

      let page = await stripe.paymentIntents.search({ query, limit: 100 });
      while (true) {
        for (const pi of page.data) totalCents += (pi.amount_received ?? 0);
        if (!page.has_more) break;
        page = await stripe.paymentIntents.search({ query, limit: 100, page: page.next_page });
      }
    } catch (searchErr) {
      console.warn('PI Search not available, falling back to Checkout Sessions list:', searchErr?.message || searchErr);

      // Fallback: paginate Checkout Sessions, filter in code
      let page = await stripe.checkout.sessions.list({ limit: 100 });
      while (true) {
        for (const s of page.data) {
          if (
            s.payment_status === 'paid' &&
            s.metadata?.campaign === CAMPAIGN_KEY &&
            s.metadata?.counts_for_goal === 'true' &&
            (s.created || 0) > createdGt
          ) {
            totalCents += (s.amount_total ?? 0);
          }
        }
        if (!page.has_more) break;
        page = await stripe.checkout.sessions.list({ limit: 100, starting_after: page.data.at(-1)?.id });
      }
    }

    const payload = {
      campaign: CAMPAIGN_KEY,
      since: CAMPAIGN_START,
      cents: totalCents,
      dollars: totalCents / 100,
    };
    _raisedCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (err) {
    console.error('raised endpoint error:', err);
    res.status(500).json({ error: 'unable_to_fetch' });
  }
});

// Health
app.get('/', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));