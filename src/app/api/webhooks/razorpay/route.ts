// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Razorpay Webhook Ingestion Endpoint
// POST /api/webhooks/razorpay
//
// Pipeline:
//   1. HMAC-SHA256 signature validation
//   2. Upsert RevenueEvent to DB
//   3. Build PolicyContext from DB state + payload
//   4. Evaluate Left Brain policy engine (synchronous, deterministic)
//   5. Write immutable AuditLog entry (always — even if blocked)
//   6. Update RevenueEvent.status if verdict specifies a new state
//   7. Dispatch approved action to BullMQ (if verdict.allowed === true)
//   8. Return 200 with full verdict summary
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { policyEngine } from '@/lib/engine/policyEngine';
import { enqueueRecoveryAction } from '@/lib/queues/recoveryQueue';
import type { PolicyContext, RazorpayWebhookPayload } from '@/lib/engine/types';
import type { EventType, EventStatus } from '@prisma/client';

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the Razorpay HMAC-SHA256 webhook signature.
 * Skipped in development to ease local testing.
 */
function validateSignature(rawBody: string, signature: string): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return true; // Dev bypass — never ship without this guard
  }
  if (!WEBHOOK_SECRET) {
    console.error('[Webhook] RAZORPAY_WEBHOOK_SECRET is not configured.');
    return false;
  }
  const computed = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return computed === signature;
}

/** Maps a Razorpay event name to a Vasooli EventType enum value */
function resolveEventType(rzpEvent: string, override?: EventType): EventType {
  if (override) return override;
  if (rzpEvent.includes('subscription')) return 'SUBSCRIPTION_FAILED';
  if (rzpEvent.includes('invoice') || rzpEvent.includes('b2b')) return 'B2B_INVOICE_OVERDUE';
  return 'CHECKOUT_ABANDONED';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap 1: Payment Capture Handler
// Handles payment.captured / payment.authorized events from Razorpay.
// These fire when a customer pays organically (via the link we sent them)
// without going through the retry flow — the only path to accurate recovery
// metrics for self-served payments.
// ─────────────────────────────────────────────────────────────────────────────

async function handlePaymentCapture(
  payload: RazorpayWebhookPayload,
): Promise<NextResponse> {
  const payment = payload.payload?.payment?.entity;
  if (!payment) {
    return NextResponse.json({ error: 'No payment entity in payload' }, { status: 400 });
  }

  const amountRecovered = payment.amount / 100; // paise → INR
  const contact = payment.contact ?? payment.email ?? null;

  // Find the most-recent active event for this contact (IN_RECOVERY or PTP_ACTIVE)
  // We match by contact because Razorpay payment IDs are per-attempt, not per-event.
  const event = contact
    ? await prisma.revenueEvent.findFirst({
        where: {
          customerContact: contact,
          status: { in: ['IN_RECOVERY', 'PTP_ACTIVE', 'DETECTED'] },
        },
        orderBy: { createdAt: 'desc' },
      })
    : null;

  if (!event) {
    // Payment not associated with a tracked Vasooli event — acknowledge and ignore
    console.log(
      `[Webhook] payment.captured for contact=${contact} — no active Vasooli event found. Ignoring.`,
    );
    return NextResponse.json({ success: true, matched: false }, { status: 200 });
  }

  // Mark event as RECOVERED
  await prisma.revenueEvent.update({
    where: { id: event.id },
    data: { status: 'RECOVERED' },
  });

  // Write immutable RECOVERY_OUTCOME AuditLog
  await prisma.auditLog.create({
    data: {
      eventId: event.id,
      stage: 'RECOVERY_OUTCOME',
      diagnosedReason: `✓ Payment captured organically. Razorpay payment ID: ${payment.id}. Amount: ₹${amountRecovered.toLocaleString('en-IN')}`,
      policyPassed: true,
      actionTaken: null,
      costIncurred: 0,
      rupeesRecovered: amountRecovered,
      rawReasoning: JSON.stringify({
        razorpayPaymentId: payment.id,
        recoverySource: 'organic_payment_capture',
        capturedAt: new Date().toISOString(),
        amountPaise: payment.amount,
      }),
    },
  });

  // Honor any active PTP commitment
  const activePTP = await prisma.promiseToPay.findFirst({
    where: { eventId: event.id, status: 'PENDING' },
  });
  if (activePTP) {
    await prisma.promiseToPay.update({
      where: { id: activePTP.id },
      data: { status: 'HONORED' },
    });
    console.log(`[Webhook] PTP ${activePTP.id} marked HONORED — payment captured.`);
  }

  console.log(
    `[Webhook] ✓ payment.captured: eventId=${event.id.slice(0, 8)} | ₹${amountRecovered.toLocaleString('en-IN')} RECOVERED`,
  );

  return NextResponse.json({
    success: true,
    matched: true,
    eventId: event.id,
    status: 'RECOVERED',
    rupeesRecovered: amountRecovered,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Step 1: Validate Signature ────────────────────────────────────────────
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  if (!validateSignature(rawBody, signature)) {
    return NextResponse.json(
      { error: 'Unauthorized: invalid webhook signature' },
      { status: 401 },
    );
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Bad request: invalid JSON payload' }, { status: 400 });
  }

  // ── Gap 1: Route payment capture events to dedicated handler ──────────────
  // payment.captured fires when any payment succeeds — including organic
  // payments made via the links Vasooli dispatches. This is the primary
  // mechanism for detecting self-served recoveries.
  const CAPTURE_EVENTS = new Set(['payment.captured', 'payment.authorized']);
  if (CAPTURE_EVENTS.has(payload.event)) {
    return handlePaymentCapture(payload);
  }

  // ── Step 2: Extract & Normalise Fields ───────────────────────────────────
  const ext = payload._vasooli ?? {};
  const paymentEntity = payload.payload?.payment?.entity;

  const eventType = resolveEventType(payload.event, ext.eventType);
  // Razorpay amounts are in paise — convert to INR.
  // B2B invoice events don't carry a payment entity, so fall back to
  // the _vasooli.amountAtRisk field injected by internal systems.
  const amountAtRisk = paymentEntity
    ? paymentEntity.amount / 100
    : (ext.amountAtRisk ?? 0);
  const currency = paymentEntity?.currency ?? 'INR';
  const declineCode = paymentEntity?.error_code ?? null;
  const merchantId = ext.merchantId ?? payload.account_id ?? 'unknown';
  const customerName =
    ext.customerName ?? paymentEntity?.notes?.['name'] ?? 'Unknown Customer';
  const customerContact =
    ext.customerId ??
    paymentEntity?.contact ??
    paymentEntity?.email ??
    'unknown';

  // ── Step 3: Create RevenueEvent ──────────────────────────────────────────
  let revenueEvent = await prisma.revenueEvent.create({
    data: {
      merchantId,
      eventType,
      amountAtRisk,
      currency,
      customerName,
      customerContact,
      declineCode,
      funnelStep: ext.funnelStep ?? null,
      riskScore: ext.riskScore ?? null,
      invoiceDueDate: ext.invoiceDueDate ? new Date(ext.invoiceDueDate) : null,
      isDisputed: ext.isDisputed ?? false,
      status: 'DETECTED',
    },
  });

  // ── Step 4: Build PolicyContext from DB history ───────────────────────────
  const sevenDaysAgo = new Date(Date.now() - NPCI_WINDOW_MS);
  const auditHistory = await prisma.auditLog.findMany({
    where: { eventId: revenueEvent.id },
    orderBy: { timestamp: 'asc' },
  });

  // Count NPCI retries within the 7-day window
  const retryLogs = auditHistory.filter(
    (l) => l.actionTaken === 'RETRY_SCHEDULED' && l.timestamp >= sevenDaysAgo,
  );

  // All nudge-type actions for this event
  const NUDGE_ACTIONS = new Set([
    'SEND_UPDATE_LINK',
    'SEND_OTP_NUDGE',
    'SEND_FORMAL_REMINDER',
    'SEND_CONVERSATIONAL_NUDGE',
  ]);
  const nudgeLogs = auditHistory.filter(
    (l) => l.actionTaken !== null && NUDGE_ACTIONS.has(l.actionTaken!),
  );

  const lastNudgeLog = nudgeLogs.at(-1);
  const cardUpdateLog = auditHistory.find((l) => l.actionTaken === 'SEND_UPDATE_LINK');
  const firstRetryLog = retryLogs[0];

  // Fetch active (PENDING) Promise-to-Pay
  const activePTP = await prisma.promiseToPay.findFirst({
    where: { eventId: revenueEvent.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });

  const ptpBreachCount = await prisma.promiseToPay.count({
    where: { eventId: revenueEvent.id, status: 'BREACHED' },
  });

  const ctx: PolicyContext = {
    eventId: revenueEvent.id,
    eventType: revenueEvent.eventType,
    status: revenueEvent.status,
    declineCode: revenueEvent.declineCode ?? undefined,
    funnelStep: revenueEvent.funnelStep ?? undefined,
    isDisputed: revenueEvent.isDisputed,
    invoiceDueDate: revenueEvent.invoiceDueDate ?? undefined,
    riskScore: revenueEvent.riskScore ?? undefined,
    retryCount: retryLogs.length,
    nudgeCount: nudgeLogs.length,
    firstRetryAt: firstRetryLog?.timestamp,
    lastNudgeSentAt: lastNudgeLog?.timestamp,
    cardUpdateLinkSentAt: cardUpdateLog?.timestamp,
    activePTP: activePTP
      ? {
          promisedDate: activePTP.promisedDate,
          agreedAmount: activePTP.agreedAmount,
          breachCount: ptpBreachCount,
        }
      : undefined,
  };

  // ── Step 5: Evaluate Policy Engine (Left Brain) ───────────────────────────
  const now = new Date();
  const verdict = policyEngine.evaluate(ctx, now);

  // ── Step 6: Write Immutable AuditLog ─────────────────────────────────────
  // Written BEFORE queue dispatch. If queue dispatch fails, the audit record
  // still exists and the job can be re-enqueued by an operator.
  const auditLog = await prisma.auditLog.create({
    data: {
      eventId: revenueEvent.id,
      stage: 'POLICY_EVALUATION',
      diagnosedReason: verdict.reason,
      policyPassed: verdict.allowed,
      actionTaken: verdict.action ?? null,
      costIncurred: 0.0,
      rupeesRecovered: 0.0,
      rawReasoning: JSON.stringify({
        verdict: {
          allowed: verdict.allowed,
          action: verdict.action,
          escalate: verdict.escalate,
          freeze: verdict.freeze,
          retryAt: verdict.retryAt?.toISOString() ?? null,
        },
        contextSnapshot: {
          riskScore: ctx.riskScore,
          retryCount: ctx.retryCount,
          nudgeCount: ctx.nudgeCount,
          isDisputed: ctx.isDisputed,
          declineCode: ctx.declineCode,
          funnelStep: ctx.funnelStep,
          activePTP: ctx.activePTP
            ? {
                promisedDate: ctx.activePTP.promisedDate.toISOString(),
                breachCount: ctx.activePTP.breachCount,
              }
            : null,
        },
        evaluatedAt: now.toISOString(),
      }),
    },
  });

  // ── Step 7: Update EventStatus ────────────────────────────────────────────
  if (verdict.newStatus && verdict.newStatus !== revenueEvent.status) {
    revenueEvent = await prisma.revenueEvent.update({
      where: { id: revenueEvent.id },
      data: { status: verdict.newStatus as EventStatus },
    });
  }

  // ── Step 8: Dispatch to BullMQ ────────────────────────────────────────────
  let jobId: string | null = null;

  if (verdict.allowed && verdict.action) {
    const delayMs = verdict.retryAt
      ? Math.max(0, verdict.retryAt.getTime() - now.getTime())
      : undefined;

    try {
      jobId = await enqueueRecoveryAction(
        {
          eventId: revenueEvent.id,
          auditLogId: auditLog.id,
          action: verdict.action,
          merchantId: revenueEvent.merchantId,
          customerContact: revenueEvent.customerContact,
          customerName: revenueEvent.customerName,
          amountAtRisk: revenueEvent.amountAtRisk,
          currency: revenueEvent.currency,
          declineCode: revenueEvent.declineCode ?? undefined,
          retryAt: verdict.retryAt?.toISOString(),
          invoiceDueDate: revenueEvent.invoiceDueDate?.toISOString(),
        },
        delayMs,
      );
    } catch (queueErr) {
      // Queue failure must never prevent a 200 response — the AuditLog is the
      // source of truth. Operators can re-enqueue from the audit record.
      console.error('[Webhook] BullMQ enqueue failed:', (queueErr as Error).message);
    }
  }

  // ── Step 9: Return Verdict ────────────────────────────────────────────────
  return NextResponse.json(
    {
      success: true,
      eventId: revenueEvent.id,
      auditLogId: auditLog.id,
      currentStatus: revenueEvent.status,
      verdict: {
        allowed: verdict.allowed,
        action: verdict.action,
        reason: verdict.reason,
        escalate: verdict.escalate,
        freeze: verdict.freeze,
        retryAt: verdict.retryAt?.toISOString() ?? null,
      },
      jobId,
    },
    { status: 200 },
  );
}

const NPCI_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

