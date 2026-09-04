// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Inbound WhatsApp Webhook Handler
// POST /api/webhooks/whatsapp
//
// Receives customer replies to WhatsApp nudges and runs them through
// the PTP extractor. If a promise is detected:
//   1. Creates a PromiseToPay DB record
//   2. Transitions RevenueEvent → PTP_ACTIVE
//   3. Pauses all future automated reminders (enforced by policy engine)
//   4. Sends an acknowledgement back to the customer
//
// Meta Webhook Verification: GET /api/webhooks/whatsapp (hub challenge)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { extractPTP } from '@/lib/agents/ptpExtractor';
import { sendWhatsApp } from '@/lib/integrations/messaging';
import { enqueueRecoveryAction } from '@/lib/queues/recoveryQueue';
import { roundCost } from '@/lib/costs';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? 'vasooli_dev_verify';
const APP_SECRET = process.env.META_APP_SECRET ?? '';

// ── Meta Webhook Types ────────────────────────────────────────────────────────

interface MetaWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: { display_phone_number: string; phone_number_id: string };
      contacts?: Array<{ profile: { name: string }; wa_id: string }>;
      messages?: Array<{
        from: string;
        id: string;
        timestamp: string;
        text?: { body: string };
        type: string;
      }>;
    };
    field: string;
  }>;
}

interface MetaWebhookBody {
  object: string;
  entry: MetaWebhookEntry[];
}

// ── Signature Validation ──────────────────────────────────────────────────────

function validateMetaSignature(rawBody: string, signature: string): boolean {
  if (process.env.NODE_ENV !== 'production' || !APP_SECRET) return true;
  const expected = `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
  return expected === signature;
}

// ── GET: Meta webhook verification challenge ──────────────────────────────────

export function GET(req: NextRequest): NextResponse {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WhatsApp Webhook] Meta verification challenge accepted');
    return new NextResponse(challenge ?? '', { status: 200 });
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// ── POST: Inbound message handler ─────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256') ?? '';

  if (!validateMetaSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process each message entry asynchronously (non-blocking — Meta requires 200 in <10s)
  void processEntries(body.entry);

  // Meta requires an immediate 200 OK
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

// ── Core Processing Pipeline ──────────────────────────────────────────────────

async function processEntries(entries: MetaWebhookEntry[]): Promise<void> {
  for (const entry of entries) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;

      for (const msg of change.value.messages ?? []) {
        if (msg.type !== 'text' || !msg.text?.body) continue;

        const fromPhone = `+${msg.from}`;
        const text = msg.text.body;

        console.log(`\n[WhatsApp In] From: ${fromPhone} | "${text.slice(0, 80)}"`);

        await handleInboundMessage(fromPhone, text);
      }
    }
  }
}

async function handleInboundMessage(fromPhone: string, text: string): Promise<void> {
  // Find the most recent active event for this contact
  const event = await prisma.revenueEvent.findFirst({
    where: {
      customerContact: fromPhone,
      status: { in: ['DETECTED', 'IN_RECOVERY'] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      auditLogs: { orderBy: { timestamp: 'desc' }, take: 5 },
    },
  });

  if (!event) {
    console.log(`[WhatsApp In] No active event found for ${fromPhone} — ignoring`);
    return;
  }

  // ── 1. Extract PTP / intent from the customer's message ──────────────────
  const extraction = await extractPTP(
    text,
    {
      invoiceAmount: event.amountAtRisk,
      currency: event.currency,
      daysOverdue: event.invoiceDueDate
        ? Math.floor((Date.now() - event.invoiceDueDate.getTime()) / 86400000)
        : undefined,
    },
  );

  // ── 2. Write AuditLog entry for the inbound message ──────────────────────
  await prisma.auditLog.create({
    data: {
      eventId: event.id,
      stage: 'DIAGNOSIS',
      diagnosedReason: `Inbound WhatsApp reply processed. Intent: ${extraction.intent}, Sentiment: ${extraction.sentiment}`,
      policyPassed: !extraction.requiresHumanHandoff,
      actionTaken: null,
      costIncurred: roundCost(extraction.llmCostINR),
      rupeesRecovered: 0,
      rawReasoning: JSON.stringify({ inboundText: text, extraction, fromPhone }),
    },
  });

  // ── 3. Route based on extracted intent ───────────────────────────────────

  if (extraction.intent === 'promise_to_pay' && extraction.targetDate) {
    await handlePromiseToPay(event, extraction, fromPhone, text);
    return;
  }

  if (extraction.intent === 'dispute' || extraction.requiresHumanHandoff) {
    await handleEscalation(event, extraction, fromPhone);
    return;
  }

  if (extraction.intent === 'paid_already') {
    await handlePaidAlreadyClaim(event, fromPhone);
    return;
  }

  if (extraction.intent === 'request_extension' && extraction.targetDate) {
    await handlePromiseToPay(event, extraction, fromPhone, text);
    return;
  }

  // Ambiguous — acknowledge and wait
  await sendWhatsApp(
    fromPhone,
    `Namaste! 🙏 Aapka message receive hua. Hum aapki payment details check kar rahe hain aur shortly aapse contact karenge.`,
  );
}

// ── Sub-handlers ──────────────────────────────────────────────────────────────

async function handlePromiseToPay(
  event: { id: string; amountAtRisk: number; customerName: string },
  extraction: Awaited<ReturnType<typeof extractPTP>>,
  fromPhone: string,
  originalText: string,
): Promise<void> {
  const promisedDate = new Date(extraction.targetDate!);
  const agreedAmount = extraction.agreedAmount ?? event.amountAtRisk;

  // Create PromiseToPay record
  await prisma.promiseToPay.create({
    data: {
      eventId: event.id,
      promisedDate,
      agreedAmount,
      status: 'PENDING',
      extractedQuote: extraction.extractedQuote ?? originalText.slice(0, 500),
    },
  });

  // Transition event to PTP_ACTIVE — policy engine will now block all reminders
  await prisma.revenueEvent.update({
    where: { id: event.id },
    data: { status: 'PTP_ACTIVE' },
  });

  // Send acknowledgement
  const dateStr = promisedDate.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
  const firstName = event.customerName.split(' ')[0];
  await sendWhatsApp(
    fromPhone,
    `Shukriya ${firstName} ji! 🙏\n\n` +
      `Humne aapka commitment note kar liya — ₹${agreedAmount.toLocaleString('en-IN')} ki payment ${dateStr} tak.\n\n` +
      `Hum is date tak wait karenge aur koi reminder nahi bhejenge. ` +
      `Agar koi aur madad chahiye toh batayein! 😊`,
  );

  console.log(
    `[WhatsApp In] 📅 PTP logged: ₹${agreedAmount.toLocaleString('en-IN')} by ${promisedDate.toDateString()} — event → PTP_ACTIVE`,
  );
}

async function handleEscalation(
  event: { id: string; amountAtRisk: number; currency: string; customerName: string; customerContact: string; merchantId: string },
  extraction: Awaited<ReturnType<typeof extractPTP>>,
  fromPhone: string,
): Promise<void> {
  // Update event flag if it's a dispute
  if (extraction.intent === 'dispute') {
    await prisma.revenueEvent.update({
      where: { id: event.id },
      data: { isDisputed: true },
    });
  }

  // Enqueue human handoff
  await enqueueRecoveryAction({
    eventId: event.id,
    auditLogId: 'whatsapp_inbound',
    action: 'HUMAN_HANDOFF',
    merchantId: event.merchantId,
    customerContact: event.customerContact,
    customerName: event.customerName,
    amountAtRisk: event.amountAtRisk,
    currency: event.currency,
    metadata: {
      reason: extraction.intent === 'dispute'
        ? 'Customer flagged a dispute via WhatsApp'
        : `Hostile/escalation-required intent: ${extraction.intent}`,
      inboundText: fromPhone,
    },
  });

  // Acknowledge to customer
  await sendWhatsApp(
    fromPhone,
    `Samajh mein aaya, ${event.customerName.split(' ')[0]} ji. Humne aapki concern note kar li hai.\n\n` +
      `Aapka case humari dedicated team ke paas bhej diya hai — ` +
      `koi bhi aapse 24 ghante mein contact karega.\n\n` +
      `Patience ke liye shukriya 🙏`,
  );

  console.log(`[WhatsApp In] 🚨 ESCALATED: intent=${extraction.intent} event=${event.id.slice(0, 8)}`);
}

async function handlePaidAlreadyClaim(
  event: { id: string; customerName: string; merchantId: string; amountAtRisk: number; currency: string; customerContact: string },
  fromPhone: string,
): Promise<void> {
  // Flag for manual verification — do not mark RECOVERED until confirmed
  await prisma.auditLog.create({
    data: {
      eventId: event.id,
      stage: 'DIAGNOSIS',
      diagnosedReason: 'Customer claims payment was already made. Manual verification required before marking RECOVERED.',
      policyPassed: true,
      actionTaken: 'HUMAN_HANDOFF',
      costIncurred: 0,
      rupeesRecovered: 0,
      rawReasoning: JSON.stringify({ claim: 'paid_already', fromPhone }),
    },
  });

  await enqueueRecoveryAction({
    eventId: event.id,
    auditLogId: 'whatsapp_paid_claim',
    action: 'HUMAN_HANDOFF',
    merchantId: event.merchantId,
    customerContact: event.customerContact,
    customerName: event.customerName,
    amountAtRisk: event.amountAtRisk,
    currency: event.currency,
    metadata: { reason: 'Customer claims payment was already made — verify in Razorpay dashboard' },
  });

  await sendWhatsApp(
    fromPhone,
    `${event.customerName.split(' ')[0]} ji, shukriya! 🙏\n\n` +
      `Humne note kar liya. Hum payment verify karenge aur aapko confirm karenge.\n\n` +
      `Agar payment abhi pending ho toh please receipt share karein — jaldi resolve ho jayega!`,
  );
}

