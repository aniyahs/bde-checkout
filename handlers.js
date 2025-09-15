// handlers.js
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { appendToSheet } from './sheets.js';
import fetch from 'node-fetch';
import { sendSponsorEmail } from './mailer.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Map your tiers → human labels (for emails/CRM)
const TIER_LABEL = {
  gold: 'Gold Sponsor',
  silver: 'Silver Sponsor',
  bronze: 'Bronze Sponsor',
  ga: 'General Admission',
  support_family: 'Support-a-Family'
};

// ---- HighLevel helpers ----
const GHL_BASE = 'https://rest.gohighlevel.com/v1'; // v1 public base
const GHL_HEADERS = {
  'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
  'Content-Type': 'application/json'
};

// --- CSV backup helper (object-based, same order as the Sheet) ---
function ensureCsvWithHeaders(filePath) {
  const headers = [
    'Timestamp','Order ID','Buyer Name','Buyer Email','Buyer Phone',
    'Tier','Seats','Amount','Covered Fees','Donation','Company','Recognition Name'
  ];
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, headers.join(',') + '\n');
  }
}

function csvEscape(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function appendCsvRow({
  orderId,
  buyerName,
  buyerEmail,
  buyerPhone,
  tier,
  seats,
  amount,
  coveredFees,
  donation,
  company,
  recognition
}) {
  const file = path.resolve('./orders.csv');
  ensureCsvWithHeaders(file);

  const row = [
    new Date().toISOString(),
    orderId,
    buyerName || '',
    buyerEmail || '',
    buyerPhone || '',
    tier,
    String(seats),
    String(amount),
    coveredFees ? 'Y' : 'N',
    donation,
    company || '',
    recognition || ''
  ].map(csvEscape).join(',');

  fs.appendFileSync(file, row + '\n');
}

// Upsert a contact in HighLevel by email
async function upsertGHLContact({ email, name, phone, company, tags = [] }) {
  const payload = {
    email,
    name,
    phone,
    companyName: company || undefined,
    source: 'Gala Checkout',
    locationId: process.env.GHL_LOCATION_ID,
    // Some accounts accept 'tags' here; if not, we'll add via /tags endpoint below
    tags
  };

  const res = await fetch(`${GHL_BASE}/contacts/`, {
    method: 'POST',
    headers: GHL_HEADERS,
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (!res.ok) {
    console.error('GHL upsert error', data);
    return null;
  }
  // Many accounts return { contact: { id, ... } }
  return data; // includes contact or id depending on account
}

// ---- Update custom fields (name-based)
async function updateGHLCustomFieldsByName(contactId, fieldObject) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: GHL_HEADERS,
    body: JSON.stringify({ customField: fieldObject })
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, data: json };
}

// ---- Fallback: Update custom fields (ID-based)
let __fieldIdCache = null;
async function getGHLFieldIdMap() {
  if (__fieldIdCache) return __fieldIdCache;

  const url = `${GHL_BASE}/custom-fields/?locationId=${process.env.GHL_LOCATION_ID}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${process.env.GHL_API_KEY}` } });
  const data = await res.json();
  const map = {};
  (data?.customFields || []).forEach(f => {
    if (f.name) map[f.name.toLowerCase()] = f.id;
    if (f.fieldKey) map[f.fieldKey.toLowerCase()] = f.id; // sometimes fieldKey is the better match
  });
  __fieldIdCache = map;
  return map;
}

async function updateGHLCustomFieldsById(contactId, fieldObject /* {ticket_tier:'gold',...} */) {
  const idMap = await getGHLFieldIdMap();
  const arr = Object.entries(fieldObject)
    .filter(([k, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => {
      const id = idMap[k.toLowerCase()];
      if (!id) {
        console.warn(`⚠️ No custom field ID found for key "${k}"`);
      }
      return id ? { id, value: v } : null;
    })
    .filter(Boolean);

  if (arr.length === 0) {
    return { ok: true, data: { note: 'no fields to update' } };
  }

  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: GHL_HEADERS,
    body: JSON.stringify({ customFields: arr }) // plural + array
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, data: json };
}

// ---- Try name-based, then fallback to ID-based
async function setGHLFields(contactId, fields) {
  const first = await updateGHLCustomFieldsByName(contactId, fields);
  if (first.ok) {
    return first;
  } else {
    console.warn('Name-based custom field update failed; trying ID-based.', first.data);
    const second = await updateGHLCustomFieldsById(contactId, fields);
    if (!second.ok) {
      console.error('ID-based custom field update failed.', second.data);
    }
    return second;
  }
}

// Optionally add a tag
async function addGHLTag(contactId, tag) {
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({ tags: [tag] })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      console.error('GHL tag error', j);
    }
  } catch (e) {
    console.error('GHL tag error (network)', e);
  }
}

// ---- Capacity helper ----
function seatsFromMetadata(meta) {
  const n = Number(meta?.seats || 0);
  return Number.isFinite(n) ? n : 0;
}

// ---- PRIMARY HANDLER ----
export async function handleCheckoutCompleted(session) {
  // session is a Stripe Checkout Session object
  const email = session.customer_details?.email || session.customer_email || '';
  const name  = session.customer_details?.name || session.metadata?.buyer_name || '';
  const phone = session.customer_details?.phone || session.metadata?.buyer_phone || '';
  const meta  = session.metadata || {};
  const tier  = (meta.tier || '').toLowerCase();
  const seats = seatsFromMetadata(meta);
  const amountTotal = ((session.amount_total || 0) / 100).toFixed(2);
  const coveredFees = meta.covered_fees === 'true';
  const isDonation  = meta.donation === 'true';
  const orderId = session.id;

  // 1) Upsert contact in HighLevel
  const contact = await upsertGHLContact({
    email,
    name,
    phone,
    company: meta.company,
    tags: ['Gala - Paid', `Tier - ${TIER_LABEL[tier] || tier}`]
  });

  const contactId = contact?.contact?.id || contact?.id;
  if (contactId) {
    // 2) Update custom fields (try by name → fallback by ID)
    await setGHLFields(contactId, {
      ticket_tier: tier,
      seats: String(seats),
      amount_paid: amountTotal,
      covered_fees: coveredFees ? 'true' : 'false',
      donation: isDonation ? 'true' : 'false',
      order_id: orderId,
      recognition_name: meta.recognition_name || ''
    });

    // Optional: tag sponsors vs GA
    if (['gold','silver','bronze','support_family'].includes(tier)) {
      await addGHLTag(contactId, 'Gala - Table Buyer');
    } else {
      await addGHLTag(contactId, 'Gala - GA');
    }
  } else {
    console.error('❌ No contactId returned from GHL upsert. Payload:', { email, name });
  }

  console.log(`✅ Recorded ${TIER_LABEL[tier] || tier} | seats: ${seats} | amount: $${amountTotal} | order: ${orderId}`);

  // Log to Google Sheets

  await appendToSheet({
    orderId,
    buyerName: name,
    buyerEmail: email,
    buyerPhone: phone,
    tier,
    seats,
    amount: amountTotal,
    coveredFees,
    donation: session.metadata?.donation_amount || (isDonation ? '1' : '0'),
    company: meta.company || '',
    recognition: meta.recognition_name || meta.company || ''
  });

    try {
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent, {
      expand: ['latest_charge'],
    });
    const receiptUrl = pi.latest_charge?.receipt_url || null;

    if (email) {
      await sendSponsorEmail({
        to: email,
        buyerName: name,
        tier: TIER_LABEL[tier] || tier,
        seats,
        amountTotal,
        coveredFees,
        receiptUrl,
        sponsorCompany: meta.company || '',
      });
    }
  } catch (err) {
    console.error('❌ Error sending confirmation email:', err);
  }

}


// Backup handler for PI succeeded (in case Checkout event missed)
export async function handlePaymentIntentSucceeded(pi) {
  try {
    const sessions = await stripe.checkout.sessions.list({ payment_intent: pi.id, limit: 1 });
    if (sessions.data[0]) {
      await handleCheckoutCompleted(sessions.data[0]);
    }
  } catch (e) {
    console.error('lookup session from PI failed', e.message);
  }
}

export async function handleRefunded(charge) {
  console.log('ℹ️ charge refunded:', charge.id);
}
