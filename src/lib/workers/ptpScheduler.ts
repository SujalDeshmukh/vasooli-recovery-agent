// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — PTP Resolution Scheduler (Gap 2)
//
// A long-running process that runs every hour to resolve expired
// Promise-to-Pay commitments. For each PENDING PTP whose promisedDate
// has passed, it:
//
//   a) HONORED  — if the event is already RECOVERED (customer paid)
//   b) BREACHED — if the event is still IN_RECOVERY / PTP_ACTIVE
//      • 1st breach: re-queues SEND_CONVERSATIONAL_NUDGE with isPTPBreach=true
//      • 2nd+ breach: escalates to HUMAN_HANDOFF and freezes the event
//
// Run as a separate process:
//   npm run scheduler
//
// This MUST NOT be imported by Next.js API routes (no HTTP server here).
// ─────────────────────────────────────────────────────────────────────────────

import { Worker, Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import { QUEUE_NAME, getRedisConnection } from '../queues/recoveryQueue';
import type { RecoveryJobData } from '../queues/recoveryQueue';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// ── Scheduler queue — separate from the main recovery queue ──────────────────

const SCHEDULER_QUEUE = 'vasooli-ptp-scheduler' as const;
const CHECK_JOB_NAME = 'CHECK_EXPIRED_PTPS' as const;
/** How often to scan for expired PTPs (default: every 60 minutes) */
const INTERVAL_MS = parseInt(process.env.PTP_CHECK_INTERVAL_MS ?? '3600000', 10);

// ── Core resolution logic ─────────────────────────────────────────────────────

async function resolveExpiredPTPs(): Promise<void> {
  const now = new Date();

  // All PENDING PTPs where the promise date has passed
  const expiredPTPs = await prisma.promiseToPay.findMany({
    where: {
      status: 'PENDING',
      promisedDate: { lt: now },
    },
    include: {
      event: true,
    },
    orderBy: { promisedDate: 'asc' },
  });

  if (expiredPTPs.length === 0) {
    console.log(`[PTP Scheduler] ✓ No expired PTPs at ${now.toISOString()}`);
    return;
  }

  console.log(`[PTP Scheduler] Found ${expiredPTPs.length} expired PTP(s) — resolving...`);

  const recoveryQueue = new Queue<RecoveryJobData>(QUEUE_NAME, {
    connection: getRedisConnection(),
  });

  for (const ptp of expiredPTPs) {
    const event = ptp.event;

    // ── Case A: Payment was already captured — mark PTP as HONORED ──────────
    if (event.status === 'RECOVERED') {
      await prisma.promiseToPay.update({
        where: { id: ptp.id },
        data: { status: 'HONORED' },
      });

      await prisma.auditLog.create({
        data: {
          eventId: event.id,
          stage: 'RECOVERY_OUTCOME',
          diagnosedReason: `✓ PTP honored: event was already RECOVERED by promisedDate (${ptp.promisedDate.toDateString()}).`,
          policyPassed: true,
          actionTaken: null,
          costIncurred: 0,
          rupeesRecovered: 0, // rupeesRecovered was already logged at payment.captured
          rawReasoning: JSON.stringify({ ptpId: ptp.id, resolvedAt: now.toISOString(), outcome: 'HONORED' }),
        },
      });

      console.log(`  [${event.id.slice(0, 8)}] ✅ HONORED — event is RECOVERED`);
      continue;
    }

    // ── Case B: Payment not received — BREACH ───────────────────────────────
    await prisma.promiseToPay.update({
      where: { id: ptp.id },
      data: { status: 'BREACHED' },
    });

    // Count prior breaches for this event
    const priorBreachCount = await prisma.promiseToPay.count({
      where: { eventId: event.id, status: 'BREACHED' },
    });

    if (priorBreachCount >= 2) {
      // ── 2nd+ breach: hard freeze + human escalation ─────────────────────
      await prisma.revenueEvent.update({
        where: { id: event.id },
        data: { status: 'ESCALATED_HUMAN' },
      });

      await prisma.auditLog.create({
        data: {
          eventId: event.id,
          stage: 'RECOVERY_OUTCOME',
          diagnosedReason: `⚠ PTP breached ${priorBreachCount} times. Event frozen and escalated to human Account Manager.`,
          policyPassed: false,
          actionTaken: 'HUMAN_HANDOFF',
          costIncurred: 0,
          rupeesRecovered: 0,
          rawReasoning: JSON.stringify({ ptpId: ptp.id, breachCount: priorBreachCount, resolvedAt: now.toISOString() }),
        },
      });

      // Enqueue human handoff notification
      await recoveryQueue.add(
        'HUMAN_HANDOFF',
        {
          eventId: event.id,
          auditLogId: ptp.id,
          action: 'HUMAN_HANDOFF',
          merchantId: event.merchantId,
          customerContact: event.customerContact,
          customerName: event.customerName,
          amountAtRisk: event.amountAtRisk,
          currency: event.currency,
          metadata: {
            reason: `PTP breached ${priorBreachCount} times — final escalation by PTP scheduler`,
            ptpId: ptp.id,
            promisedDate: ptp.promisedDate.toISOString(),
          },
        },
        { jobId: `ptp_handoff_${event.id}_${ptp.id}` },
      );

      console.log(`  [${event.id.slice(0, 8)}] 🛑 BREACHED x${priorBreachCount} → ESCALATED_HUMAN`);

    } else {
      // ── 1st breach: re-activate with isPTPBreach=true Hinglish nudge ────
      await prisma.revenueEvent.update({
        where: { id: event.id },
        data: { status: 'IN_RECOVERY' },
      });

      await prisma.auditLog.create({
        data: {
          eventId: event.id,
          stage: 'POLICY_EVALUATION',
          diagnosedReason: `PTP breached (1st time). Re-activating with escalated Hinglish nudge. Promised: ${ptp.promisedDate.toDateString()}`,
          policyPassed: true,
          actionTaken: 'SEND_CONVERSATIONAL_NUDGE',
          costIncurred: 0,
          rupeesRecovered: 0,
          rawReasoning: JSON.stringify({ ptpId: ptp.id, breachCount: 1, resolvedAt: now.toISOString() }),
        },
      });

      // Re-queue a Hinglish nudge with breach context
      await recoveryQueue.add(
        'SEND_CONVERSATIONAL_NUDGE',
        {
          eventId: event.id,
          auditLogId: ptp.id,
          action: 'SEND_CONVERSATIONAL_NUDGE',
          merchantId: event.merchantId,
          customerContact: event.customerContact,
          customerName: event.customerName,
          amountAtRisk: event.amountAtRisk,
          currency: event.currency,
          invoiceDueDate: event.invoiceDueDate?.toISOString(),
          metadata: {
            isPTPBreach: true,
            ptpId: ptp.id,
            promisedDate: ptp.promisedDate.toISOString(),
            reason: 'ptp_breach_reactivation',
          },
        },
        { jobId: `ptp_breach_nudge_${event.id}_${ptp.id}` },
      );

      console.log(`  [${event.id.slice(0, 8)}] 💔 BREACHED (1st) → SEND_CONVERSATIONAL_NUDGE re-queued`);
    }
  }

  console.log(`[PTP Scheduler] Done. Resolved ${expiredPTPs.length} PTP(s).`);
}

// ── BullMQ Repeatable Job Setup ───────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const schedulerQueue = new Queue(SCHEDULER_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  });

  // Register a repeatable job that runs on the configured interval
  await schedulerQueue.add(
    CHECK_JOB_NAME,
    {},
    {
      repeat: { every: INTERVAL_MS },
      jobId: 'ptp-resolution-cron',
    },
  );

  const worker = new Worker(
    SCHEDULER_QUEUE,
    async () => {
      await resolveExpiredPTPs();
    },
    {
      connection: getRedisConnection(),
      concurrency: 1, // Only one resolution pass at a time
    },
  );

  worker.on('completed', () => {
    console.log(`[PTP Scheduler] ✓ Check completed at ${new Date().toISOString()}`);
  });
  worker.on('failed', (_job, err) => {
    console.error('[PTP Scheduler] ✗ Check failed:', err.message);
  });
  worker.on('error', (err) => {
    console.error('[PTP Scheduler] Worker error:', err.message);
  });

  console.log('\n[PTP Scheduler] 🗓 Vasooli PTP Resolution Scheduler started');
  console.log(`[PTP Scheduler] Check interval: every ${Math.round(INTERVAL_MS / 60000)} minutes`);
  console.log('[PTP Scheduler] Press Ctrl+C to stop\n');

  // Also run immediately on startup (don't wait for first interval)
  console.log('[PTP Scheduler] Running initial check...');
  await resolveExpiredPTPs();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[PTP Scheduler] ${signal} received — shutting down...`);
    await worker.close();
    await schedulerQueue.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[PTP Scheduler] Fatal bootstrap error:', err);
  process.exit(1);
});

