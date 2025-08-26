// Clinic POS — Minimal Stripe Terminal (WisePOS E) server-driven flow
// 1) Shows a form (amount + optional name/email/description)
// 2) Creates a PaymentIntent
// 3) Sends it to your WisePOS E
// 4) Polls until succeeded (or shows failure/cancel)

require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // Live key in .env
const READER_ID = process.env.READER_ID;                   // tmr_... from Dashboard
const PORT = process.env.PORT || 3000;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// --- UI form ---
app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Clinic POS</title>
<style>
body{font-family:-apple-system,system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
label{display:block;margin-top:14px} input,button{width:100%;font-size:18px;padding:10px;margin-top:6px}
button{cursor:pointer} .note{color:#555;margin-top:10px}
</style></head>
<body>
  <h1>Charge Patient</h1>
  <form method="POST" action="/charge">
    <label>Amount (USD)</label>
    <input name="amount" type="number" step="0.01" min="0.01" placeholder="e.g. 250.00" required>

    <label>Patient name (optional)</label>
    <input name="patient_name" type="text" placeholder="e.g. Jane Doe">

    <label>Receipt email (optional)</label>
    <input name="receipt_email" type="email" placeholder="e.g. jane@example.com">

    <label>Description (optional)</label>
    <input name="description" type="text" placeholder="e.g. Copay / Deposit">

    <button type="submit">Send to Reader</button>
  </form>
  <p class="note">Reader: ${READER_ID || '(set READER_ID in .env)'} • Mode: Live</p>
</body></html>`);
});

// --- Create PI + send to reader ---
app.post('/charge', async (req, res) => {
  try {
    if (!READER_ID) throw new Error('READER_ID is not set in .env');

    const amount = Number.parseFloat(req.body.amount);
    if (!amount || amount <= 0) throw new Error('Amount must be > 0');

    const description = (req.body.description || '').trim() || 'In-person payment';
    const receiptEmail = (req.body.receipt_email || '').trim() || undefined;
    const patientName = (req.body.patient_name || '').trim() || undefined;

    // 1) Create PaymentIntent for in-person
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      description,
      receipt_email: receiptEmail,               // optional
      metadata: { patient_name: patientName || '', source: 'clinic-pos' }, // optional
    });

    // 2) Send PaymentIntent to the reader
    await stripe.terminal.readers.processPaymentIntent(READER_ID, { payment_intent: intent.id });

    // 3) Poll for completion (up to ~2 minutes)
    for (let i = 0; i < 80; i++) {
      await sleep(1500);
      const latest = await stripe.paymentIntents.retrieve(intent.id);

      if (latest.status === 'succeeded') {
        return res.send(
          `<h2>✅ Payment Succeeded</h2>
           <p>Amount: $${(latest.amount/100).toFixed(2)}</p>
           <p>Description: ${latest.description || ''}</p>
           <p>Patient: ${(latest.metadata && latest.metadata.patient_name) || ''}</p>
           <p>PaymentIntent: ${latest.id}</p>
           <p><a href="/refund?pi=${latest.id}">Refund this payment</a></p>
           <p><a href="/">← New payment</a></p>`
        );
      }

      if (['requires_payment_method','canceled'].includes(latest.status)) {
        return res.send(
          `<h2>❌ Failed or Canceled</h2>
           <p>Status: ${latest.status}</p>
           <p>PaymentIntent: ${latest.id}</p>
           <p><a href="/">← Try again</a></p>`
        );
      }

      if (latest.status === 'requires_capture') {
        return res.send(
          `<h2>✅ Authorized (manual capture needed)</h2>
           <p>PI: ${latest.id}</p>
           <p><a href="/">← New payment</a></p>`
        );
      }
    }

    const finalPi = await stripe.paymentIntents.retrieve(intent.id);
    res.send(
      `<h2>ℹ️ Payment Status: ${finalPi.status}</h2>
       <p>PI: ${finalPi.id}</p>
       <p><a href="/">← New payment</a></p>`
    );

  } catch (e) {
    res.status(500).send(`<h2>Error</h2><pre>${e.message}</pre><p><a href="/">← Back</a></p>`);
  }
});

// --- Quick refund by PaymentIntent ---
app.get('/refund', async (req, res) => {
  try {
    const piId = req.query.pi;
    if (!piId) throw new Error('Missing ?pi=PaymentIntentID');
    const pi = await stripe.paymentIntents.retrieve(piId);
    if (pi.status !== 'succeeded') throw new Error('Only succeeded payments can be refunded');

    const refund = await stripe.refunds.create({ charge: pi.latest_charge });
    res.send(
      `<h2>🔄 Refund Created</h2>
       <p>Refund: ${refund.id}</p>
       <p>For PaymentIntent: ${piId}</p>
       <p><a href="/">← New payment</a></p>`
    );
  } catch (e) {
    res.status(500).send(`<h2>Error</h2><pre>${e.message}</pre><p><a href="/">← Back</a></p>`);
  }
});

app.listen(PORT, () => {
  console.log(`Mini POS listening on http://localhost:${PORT}`);
});

