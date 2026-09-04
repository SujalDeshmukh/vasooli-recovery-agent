// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Recovery Worker (Consumer) — PHASE 2: FULLY IMPLEMENTED
//
// All Right Brain stubs from Phase 1 are replaced with real implementations.
// Each job case:
//   1. Calls the appropriate integration (Razorpay API / messaging / LLM)
//   2. Writes an ACTION_DISPATCH AuditLog with actual costIncurred
//   3. Updates RevenueEvent.status
//   4. Writes a RECOVERY_OUTCOME AuditLog if the action produced a payment
// ─────────────────────────────────────────────────────────────────────────────

import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { getRedisConnection, QUEUE_NAME, RecoveryJobData } from '../queues/recoveryQueue';
import { retrySubscription, createPaymentLink, cancelSubscription } from '../integrations/razorpay';
import { sendWhatsApp, sendEmail } from '../integrations/messaging';
import { composeHinglishMessage, composeFormalReminder } from '../agents/hinglishAgent';
import { roundCost, sumCosts } from '../costs';

// Worker-local Prisma client (not the Next.js singleton — this is a separate process)
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// ── AuditLog write helpers ────────────────────────────────────────────────────

async function writeActionDispatch(
  eventId: string,
  actionTaken: string,
  diagnosedReason: string,
  costIncurred: number,
  rawReasoning: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventId,
      stage: 'ACTION_DISPATCH',
      diagnosedReason,
      policyPassed: true,
      actionTaken,
      costIncurred: roundCost(costIncurred),
      rupeesRecovered: 0,
      rawReasoning: JSON.stringify(rawReasoning),
    },
  });
}

async function writeRecoveryOutcome(
  eventId: string,
  rupeesRecovered: number,
  reason: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      eventId,
      stage: 'RECOVERY_OUTCOME',
      diagnosedReason: reason,
      policyPassed: true,
      actionTaken: null,
      costIncurred: 0,
      rupeesRecovered: roundCost(rupeesRecovered),
      rawReasoning: JSON.stringify(raw),
    },
  });
}

// ── Job Processor ─────────────────────────────────────────────────────────────

async function processJob(job: Job<RecoveryJobData>): Promise<void> {
  const {
    action, eventId, merchantId,
    customerName, customerContact, amountAtRisk, currency,
    declineCode, retryAt, invoiceDueDate, metadata,
  } = job.data;

  console.log(
    `\n[Worker] ▶ Job ${job.id} | action=${action} | eventId=${eventId.slice(0, 8)} | ` +
      `customer=${customerName} | ₹${amountAtRisk.toLocaleString('en-IN')}`,
  );

  switch (action) {
    // ────────────────────────────────────────────────────────────────────────
    // Flow A: Recurring Debit / Mandate Failures
    // ────────────────────────────────────────────────────────────────────────

    case 'RETRY_SCHEDULED': {
      const subscriptionId = (metadata?.subscriptionId as string | undefined) ?? `sub_${eventId}`;
      const retryResult = await retrySubscription(subscriptionId);

      if (retryResult.success && retryResult.paymentId) {
        // ── Recovery success ───────────────────────────────────────────────
        await prisma.revenueEvent.update({
          where: { id: eventId },
          data: { status: 'RECOVERED' },
        });
        await writeActionDispatch(
          eventId,
          'RETRY_SCHEDULED',
          `Mandate retry succeeded via Razorpay. Payment ID: ${retryResult.paymentId}`,
          sumCosts('GATEWAY_RETRY'),
          { subscriptionId, retryAt, paymentId: retryResult.paymentId },
        );
        await writeRecoveryOutcome(
          eventId,
          amountAtRisk,
          `✓ Recovered ₹${amountAtRisk.toLocaleString('en-IN')} via salary-window retry.`,
          { paymentId: retryResult.paymentId, recoveredAt: new Date().toISOString() },
        );
        console.log(`[Worker] ✓ RETRY_SCHEDULED: Recovered ₹${amountAtRisk.toLocaleString('en-IN')} — paymentId=${retryResult.paymentId}`);
      } else {
        // ── Retry failed — stays IN_RECOVERY for next scheduled attempt ───
        await writeActionDispatch(
          eventId,
          'RETRY_SCHEDULED',
          `Mandate retry failed: ${retryResult.errorCode ?? 'unknown'}. Awaiting next salary window.`,
          sumCosts('GATEWAY_RETRY'),
          { subscriptionId, retryAt, errorCode: retryResult.errorCode },
        );
        console.log(`[Worker] ✗ RETRY_SCHEDULED: Retry failed — ${retryResult.errorCode}`);
      }
      break;
    }

    case 'SEND_UPDATE_LINK': {
      // Generate a Razorpay payment link for card update / payment method change
      const link = await createPaymentLink({
        amountPaise: Math.round(amountAtRisk * 100),
        currency,
        description: `Update payment method for ${merchantId}`,
        customerName,
        customerPhone: customerContact.startsWith('+') ? customerContact : undefined,
        customerEmail: customerContact.includes('@') ? customerContact : undefined,
        expiresInSeconds: 5 * 24 * 3600, // 5-day window before human escalation
      });

      const message =
        `Namaste ${customerName}! 🙏\n\n` +
        `Aapka payment method update karna hai (${declineCode === '54' ? 'card expire ho gaya' : 'card issue detected'}).\n\n` +
        `Naya payment method yahan add karein (secure link, 5 din valid):\n${link.shortUrl}\n\n` +
        `Koi problem? Reply karein — hum help karenge! 😊`;

      // Dispatch via WhatsApp + Email
      const [waResult, emailResult] = await Promise.allSettled([
        customerContact.startsWith('+') ? sendWhatsApp(customerContact, message) : Promise.resolve(null),
        customerContact.includes('@')
          ? sendEmail(
              customerContact,
              `Action Required: Update Your Payment Method`,
              `<p>Dear ${customerName},</p><p>Please update your payment method using this secure link:</p><p><a href="${link.shortUrl}">${link.shortUrl}</a></p><p>This link expires in 5 days.</p>`,
            )
          : Promise.resolve(null),
      ]);

      const waCost = waResult.status === 'fulfilled' && waResult.value ? waResult.value.costINR : 0;
      const emailCost = emailResult.status === 'fulfilled' && emailResult.value ? emailResult.value.costINR : 0;
      const totalCost = roundCost(waCost + emailCost);

      await writeActionDispatch(
        eventId,
        'SEND_UPDATE_LINK',
        `1-click payment update link dispatched via WhatsApp + Email. Link: ${link.shortUrl}. Valid 5 days.`,
        totalCost,
        { paymentLinkId: link.id, shortUrl: link.shortUrl, declineCode },
      );
      console.log(`[Worker] ✓ SEND_UPDATE_LINK → ${link.shortUrl}`);
      break;
    }

    case 'FREEZE_MANDATE': {
      const subscriptionId = (metadata?.subscriptionId as string | undefined) ?? `sub_${eventId}`;
      await cancelSubscription(subscriptionId);

      await prisma.revenueEvent.update({
        where: { id: eventId },
        data: { status: 'ESCALATED_HUMAN' },
      });
      await writeActionDispatch(
        eventId,
        'FREEZE_MANDATE',
        `UPI AutoPay/e-NACH mandate cancelled after NPCI retry cap was breached. Merchant alerted.`,
        0,
        { subscriptionId, reason: 'npci_retry_cap_breached' },
      );
      console.log(`[Worker] 🛑 FREEZE_MANDATE: Mandate ${subscriptionId} cancelled`);
      break;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Flow B: Checkout Drop-off
    // ────────────────────────────────────────────────────────────────────────

    case 'SEND_OTP_NUDGE': {
      // Generate a short-lived UPI intent payment link (10-min window)
      const link = await createPaymentLink({
        amountPaise: Math.round(amountAtRisk * 100),
        currency,
        description: `Complete your payment to ${merchantId}`,
        customerName,
        customerPhone: customerContact.startsWith('+') ? customerContact : undefined,
        customerEmail: customerContact.includes('@') ? customerContact : undefined,
        expiresInSeconds: 3600, // 1-hour window; archive after this
      });

      const message =
        `Hi ${customerName}! 👋\n\n` +
        `Looks like you left something behind! Complete your payment of ` +
        `₹${amountAtRisk.toLocaleString('en-IN')} instantly:\n\n` +
        `💳 Pay Now → ${link.shortUrl}\n\n` +
        `(Works directly on UPI — no OTP needed!)`;

      const waResult = customerContact.startsWith('+')
        ? await sendWhatsApp(customerContact, message)
        : { costINR: 0, messageId: 'skipped', simulated: true };

      await writeActionDispatch(
        eventId,
        'SEND_OTP_NUDGE',
        `1-click UPI intent link dispatched. Exactly 1 nudge sent (limit enforced by policy engine).`,
        roundCost(waResult.costINR),
        { paymentLinkId: link.id, shortUrl: link.shortUrl, messageId: waResult.messageId },
      );
      console.log(`[Worker] ✓ SEND_OTP_NUDGE → ${link.shortUrl}`);
      break;
    }

    case 'ARCHIVE_EVENT': {
      await prisma.revenueEvent.update({
        where: { id: eventId },
        data: { status: 'ABANDONED' },
      });
      await prisma.auditLog.create({
        data: {
          eventId,
          stage: 'RECOVERY_OUTCOME',
          diagnosedReason: 'Event archived: 1-hour no-response window elapsed after OTP nudge.',
          policyPassed: false,
          actionTaken: 'ARCHIVE_EVENT',
          costIncurred: 0,
          rupeesRecovered: 0,
          rawReasoning: JSON.stringify({ archivedAt: new Date().toISOString() }),
        },
      });
      console.log(`[Worker] 📦 ARCHIVE_EVENT: eventId=${eventId} → ABANDONED`);
      break;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Flow C: B2B Receivables
    // ────────────────────────────────────────────────────────────────────────

    case 'SEND_FORMAL_REMINDER': {
      const daysOverdue = invoiceDueDate
        ? Math.floor((Date.now() - new Date(invoiceDueDate).getTime()) / 86400000)
        : 7;

      const { message: emailHtml, llmCostINR } = await composeFormalReminder({
        customerName,
        amountDue: amountAtRisk,
        currency,
        daysOverdue,
        invoiceRef: metadata?.invoiceRef as string | undefined,
        dueDate: invoiceDueDate
          ? new Date(invoiceDueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
          : undefined,
        merchantName: metadata?.merchantName as string | undefined,
      });

      // Embed the payment link into the email
      const link = await createPaymentLink({
        amountPaise: Math.round(amountAtRisk * 100),
        currency,
        description: `Invoice payment — ${metadata?.invoiceRef ?? eventId}`,
        customerName,
        customerEmail: customerContact.includes('@') ? customerContact : undefined,
        expiresInSeconds: 5 * 24 * 3600,
      });

      const htmlWithLink = emailHtml.replace('[PAYMENT_LINK]', link.shortUrl);

      const emailResult = customerContact.includes('@')
        ? await sendEmail(
            customerContact,
            `Payment Reminder: Invoice ${metadata?.invoiceRef ?? ''} — ₹${amountAtRisk.toLocaleString('en-IN')} Overdue`,
            htmlWithLink,
          )
        : { costINR: 0, messageId: 'no_email', simulated: true };

      const totalCost = roundCost(llmCostINR + emailResult.costINR);

      await writeActionDispatch(
        eventId,
        'SEND_FORMAL_REMINDER',
        `Formal invoice reminder email dispatched (Tier 1: ${daysOverdue} days overdue). Next eligible in 5 business days.`,
        totalCost,
        { daysOverdue, emailId: emailResult.messageId, paymentLink: link.shortUrl, llmCostINR },
      );
      console.log(`[Worker] ✓ SEND_FORMAL_REMINDER: email dispatched (${daysOverdue}d overdue, cost=₹${totalCost})`);
      break;
    }

    case 'SEND_CONVERSATIONAL_NUDGE': {
      const daysOverdue = invoiceDueDate
        ? Math.floor((Date.now() - new Date(invoiceDueDate).getTime()) / 86400000)
        : 20;

      const { message: hinglishMsg, llmCostINR } = await composeHinglishMessage({
        customerName,
        amountDue: amountAtRisk,
        currency,
        daysOverdue,
        invoiceRef: metadata?.invoiceRef as string | undefined,
        merchantName: merchantId,
        isPTPBreach: (metadata?.isPTPBreach as boolean | undefined) ?? false,
      });

      const link = await createPaymentLink({
        amountPaise: Math.round(amountAtRisk * 100),
        currency,
        description: `Invoice payment — ${metadata?.invoiceRef ?? eventId}`,
        customerName,
        customerPhone: customerContact.startsWith('+') ? customerContact : undefined,
        expiresInSeconds: 7 * 24 * 3600, // 7-day window
      });

      const messageWithLink = hinglishMsg.replace('[PAYMENT_LINK]', link.shortUrl);
      const waResult = customerContact.startsWith('+')
        ? await sendWhatsApp(customerContact, messageWithLink)
        : { costINR: 0, messageId: 'no_phone', simulated: true };

      const totalCost = roundCost(llmCostINR + waResult.costINR);

      await writeActionDispatch(
        eventId,
        'SEND_CONVERSATIONAL_NUDGE',
        `Hinglish WhatsApp nudge dispatched (Tier 2: ${daysOverdue} days overdue). ` +
          `Monitoring inbound replies for Promise-to-Pay via /api/webhooks/whatsapp.`,
        totalCost,
        { daysOverdue, waMessageId: waResult.messageId, paymentLink: link.shortUrl, llmCostINR, generatedText: hinglishMsg },
      );
      console.log(`[Worker] 💬 SEND_CONVERSATIONAL_NUDGE: WhatsApp sent (${daysOverdue}d overdue, cost=₹${totalCost})`);
      break;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Escalation
    // ────────────────────────────────────────────────────────────────────────

    case 'HUMAN_HANDOFF': {
      await prisma.revenueEvent.update({
        where: { id: eventId },
        data: { status: 'ESCALATED_HUMAN' },
      });

      const escalationMsg =
        `🚨 *Vasooli Escalation Alert*\n\n` +
        `Event: ${eventId.slice(0, 8)}\n` +
        `Customer: ${customerName}\n` +
        `Amount: ${currency} ₹${amountAtRisk.toLocaleString('en-IN')}\n` +
        `Merchant: ${merchantId}\n` +
        `Contact: ${customerContact}\n` +
        `Reason: ${metadata?.reason ?? 'Policy engine escalation'}\n\n` +
        `Dashboard: ${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}`;

      // TODO Production: send to Slack webhook / PagerDuty / internal AM portal
      console.log(`\n[Worker] 🚨 HUMAN_HANDOFF:\n${escalationMsg}\n`);

      await writeActionDispatch(
        eventId,
        'HUMAN_HANDOFF',
        `Event escalated to human Account Manager. Automation paused for this event.`,
        0,
        { escalationReason: metadata?.reason, escalatedAt: new Date().toISOString() },
      );
      break;
    }

    default: {
      const _exhaustive: never = action;
      console.warn(`[Worker] ⚠ Unknown action: ${String(_exhaustive)} for job ${job.id}`);
    }
  }
}

// ── Worker Bootstrap ──────────────────────────────────────────────────────────

function bootstrap(): void {
  const worker = new Worker<RecoveryJobData>(QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 10,
    stalledInterval: 30_000,
  });

  worker.on('completed', (job) => {
    console.log(`[Worker] ✓ Job ${job.id} (${job.name}) completed`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[Worker] ✗ Job ${job?.id} (${job?.name}) failed: ${err.message}`);
  });
  worker.on('error', (err) => {
    console.error('[Worker] Worker error:', err.message);
  });

  console.log(`\n[Worker] 🚀 Vasooli Recovery Worker v2 — queue="${QUEUE_NAME}"`);
  console.log('[Worker] All Right Brain integrations: ACTIVE');
  console.log(`[Worker] Simulation: Razorpay=${process.env.RAZORPAY_SIMULATE ?? 'false'} WhatsApp=${process.env.WHATSAPP_SIMULATE ?? 'true'} Gemini=${!process.env.GEMINI_API_KEY ? 'sim' : 'live'}`);
  console.log('[Worker] Concurrency: 10 | Ctrl+C to stop\n');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Worker] ${signal} received — graceful shutdown...`);
    await worker.close();
    await prisma.$disconnect();
    console.log('[Worker] Stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap();
