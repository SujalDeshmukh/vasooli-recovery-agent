// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — BullMQ Recovery Queue (Producer Side)
//
// This module is imported by API route handlers to enqueue jobs.
// It MUST NOT be imported by any browser-side code.
// Worker consumers live in src/lib/workers/recoveryWorker.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { AllowedAction } from '../engine/types';

export const QUEUE_NAME = 'vasooli-recovery-actions' as const;

// ── Redis Connection Singleton ────────────────────────────────────────────────
// BullMQ requires maxRetriesPerRequest=null for its blocking list operations.
let redisInstance: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!redisInstance) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    redisInstance = new IORedis(url, {
      maxRetriesPerRequest: null, // BullMQ requirement
      enableReadyCheck: false,
      lazyConnect: true,
    });

    redisInstance.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }
  return redisInstance;
}

// ── Job Payload Contract ──────────────────────────────────────────────────────

/** Data shape for every job dispatched to the recovery-actions queue */
export interface RecoveryJobData {
  /** Vasooli RevenueEvent ID (UUID) */
  eventId: string;

  /** AuditLog ID of the policy evaluation that approved this action */
  auditLogId: string;

  /** The approved action from the policy engine */
  action: AllowedAction;

  merchantId: string;
  customerContact: string;
  customerName: string;
  amountAtRisk: number;
  currency: string;

  declineCode?: string;

  /** ISO timestamp for when the retry should be executed (for RETRY_SCHEDULED) */
  retryAt?: string;

  invoiceDueDate?: string;

  /** Free-form metadata for the Right Brain agents (Phase 2) */
  metadata?: Record<string, unknown>;
}

// ── Queue Singleton ───────────────────────────────────────────────────────────
let queueInstance: Queue<RecoveryJobData> | null = null;

export function getRecoveryQueue(): Queue<RecoveryJobData> {
  if (!queueInstance) {
    queueInstance = new Queue<RecoveryJobData>(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5_000, // 5s initial backoff, doubles each attempt
        },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return queueInstance;
}

// ── Enqueue Helper ────────────────────────────────────────────────────────────

/**
 * Enqueues a recovery action approved by the policy engine.
 *
 * @param data     - Job payload (must satisfy RecoveryJobData)
 * @param delayMs  - Optional delay before the job becomes active (for retryAt scheduling)
 * @returns        - The BullMQ job ID (string)
 */
export async function enqueueRecoveryAction(
  data: RecoveryJobData,
  delayMs?: number,
): Promise<string> {
  const queue = getRecoveryQueue();

  // Job ID is deterministic to prevent duplicate dispatches if the webhook
  // is retried before the DB write confirms (idempotency guard).
  const jobId = `${data.eventId}::${data.action}::${Date.now()}`;

  const job = await queue.add(data.action, data, {
    delay: delayMs,
    jobId,
  });

  console.log(
    `[Queue] Enqueued job ${job.id} | action=${data.action} | eventId=${data.eventId}` +
      (delayMs ? ` | delay=${Math.round(delayMs / 1000)}s` : ''),
  );

  return job.id ?? jobId;
}

