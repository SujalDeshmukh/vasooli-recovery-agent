// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Shared TypeScript Types
// All types used across the engine, API, and UI layers.
// ─────────────────────────────────────────────────────────────────────────────

import type { EventType, EventStatus, PTPStatus } from '@prisma/client';

export type { EventType, EventStatus, PTPStatus };

// ── Policy Engine ─────────────────────────────────────────────────────────────

/**
 * All discrete actions the Left Brain policy engine can approve.
 * Each maps directly to a BullMQ job type in the recovery-actions queue.
 */
export type AllowedAction =
  | 'RETRY_SCHEDULED'          // Flow A: NPCI mandate retry at salary window
  | 'SEND_UPDATE_LINK'         // Flow A: Card expired/stolen — send 1-click update link
  | 'SEND_OTP_NUDGE'           // Flow B: Checkout drop — resend OTP or UPI intent link
  | 'SEND_FORMAL_REMINDER'     // Flow C: B2B Tier 1 — polite formal reminder
  | 'SEND_CONVERSATIONAL_NUDGE'// Flow C: B2B Tier 2 — Hinglish WhatsApp/voice
  | 'HUMAN_HANDOFF'            // Any: Escalate to Account Manager
  | 'FREEZE_MANDATE'           // Flow A: Cancel UPI AutoPay / e-NACH mandate
  | 'ARCHIVE_EVENT';           // Flow B: Archive after no-response window

/**
 * Full context snapshot passed into the policy engine for evaluation.
 * Constructed by the webhook handler from DB state + webhook payload.
 */
export interface PolicyContext {
  eventId: string;
  eventType: EventType;
  status: EventStatus;

  /** NPCI / card network decline code (e.g. "U16", "RB", "54", "43") */
  declineCode?: string;

  /** Checkout funnel step at drop-off (e.g. "step_otp_timeout") */
  funnelStep?: string;

  /** Whether a dispute flag is active — triggers hard freeze */
  isDisputed: boolean;

  /** Due date for B2B invoices */
  invoiceDueDate?: Date;

  /** Razorpay Risk Score [0–100]. >80 = absolute freeze */
  riskScore?: number;

  /** Number of RETRY_SCHEDULED actions within the last 7 days */
  retryCount: number;

  /** Total nudge-type actions sent for this event */
  nudgeCount: number;

  /** Timestamp of the first retry scheduled (for 7-day NPCI window) */
  firstRetryAt?: Date;

  /** Timestamp of the most recent nudge dispatched */
  lastNudgeSentAt?: Date;

  /** Timestamp when the card update link was last sent */
  cardUpdateLinkSentAt?: Date;

  /** Active (PENDING) Promise-to-Pay, if one exists */
  activePTP?: {
    promisedDate: Date;
    agreedAmount: number;
    /** How many times a PTP for this event has been breached */
    breachCount: number;
  };
}

/**
 * The deterministic verdict returned by the policy engine.
 * This is the single source of truth for whether any automated action fires.
 */
export interface PolicyVerdict {
  /** Whether any automated action is permitted */
  allowed: boolean;

  /** The specific action approved (null if blocked) */
  action: AllowedAction | null;

  /** Human-readable explanation for the decision (written to AuditLog.rawReasoning) */
  reason: string;

  /** Whether this verdict requires human escalation */
  escalate: boolean;

  /** Whether all automation for this event is now frozen */
  freeze: boolean;

  /** Scheduled retry timestamp for RETRY_SCHEDULED actions */
  retryAt?: Date;

  /** New EventStatus to apply after this verdict */
  newStatus?: EventStatus;
}

// ── Webhook Payload ───────────────────────────────────────────────────────────

/**
 * Raw Razorpay webhook payload shape (simplified to the fields Vasooli uses).
 * The `_vasooli` extension namespace carries Vasooli-specific metadata that
 * enriches events beyond what Razorpay natively provides.
 */
export interface RazorpayWebhookPayload {
  entity: string;
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    payment?: {
      entity: {
        id: string;
        amount: number;       // In paise (divide by 100 for INR)
        currency: string;
        status: string;
        error_code?: string;
        error_description?: string;
        contact?: string;
        email?: string;
        notes?: Record<string, string>;
      };
    };
    subscription?: {
      entity: {
        id: string;
        plan_id: string;
        status: string;
      };
    };
  };

  /**
   * Vasooli-specific extension fields.
   * These are injected by internal systems, simulation scripts, or
   * the Razorpay webhook notes field — never trusted without validation.
   */
  _vasooli?: {
    riskScore?: number;
    customerId?: string;
    customerName?: string;
    merchantId?: string;
    funnelStep?: string;
    invoiceDueDate?: string;
    isDisputed?: boolean;
    eventType?: EventType;
    /** INR amount at risk — required for B2B events that have no payment entity */
    amountAtRisk?: number;
  };
}

// ── Metrics API ───────────────────────────────────────────────────────────────

export interface MetricsResponse {
  /** Total INR amount across all DETECTED + IN_RECOVERY + PTP_ACTIVE events */
  totalAtRisk: number;

  /** Total INR recovered (sum of AuditLog.rupeesRecovered) */
  totalRecovered: number;

  /** Recovery rate as a percentage: (recovered / atRisk) * 100 */
  recoveryRate: number;

  /** Total cost of all actions taken (LLM + messaging + gateway fees) */
  totalCostIncurred: number;

  /** Net value: recovered - cost */
  netValueCreated: number;

  /** Count of events per status */
  eventCounts: Record<EventStatus, number>;

  /** Last 50 events for the dashboard table */
  recentEvents: RecentEventRow[];
}

export interface RecentEventRow {
  id: string;
  eventType: EventType;
  amountAtRisk: number;
  currency: string;
  customerName: string;
  declineCode: string | null;
  riskScore: number | null;
  isDisputed: boolean;
  status: EventStatus;

  /** Latest AuditLog entry data — shows the most recent policy verdict */
  latestVerdict: {
    policyPassed: boolean;
    diagnosedReason: string;
    actionTaken: string | null;
    stage: string;
    timestamp: string;
  } | null;

  createdAt: string;
}

