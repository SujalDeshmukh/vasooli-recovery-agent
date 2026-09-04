// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Deterministic Policy Engine (Left Brain)
//
// This module is the compliance firewall of the entire system. It MUST remain:
//   • Purely deterministic — same inputs → same output, always
//   • Synchronous — zero async, zero I/O, zero LLM calls
//   • Stateless — all required state is passed in via PolicyContext
//   • Auditable — every decision includes a human-readable reason string
//
// Architecture ref: "Dual-Brain Architecture" — Left Brain section
// Regulatory ref: NPCI UPI AutoPay Circular, RBI Digital Payment Guidelines
// ─────────────────────────────────────────────────────────────────────────────

import { PolicyContext, PolicyVerdict, AllowedAction } from './types';
import {
  getNextSalaryWindowRetry,
  daysBetween,
  countBusinessDaysBetween,
} from './retryScheduler';

// ─────────────────────────────────────────────────────────────────────────────
// NPCI / RBI Compliance Constants
// ─────────────────────────────────────────────────────────────────────────────

/** NPCI UPI AutoPay decline codes for "Insufficient Funds" */
const NPCI_INSUFFICIENT_FUNDS_CODES = new Set(['U16', 'RB']);

/**
 * Fatal card decline codes:
 *   54 = Expired Card (Visa/MC/RuPay)
 *   43 = Stolen/Lost Card
 */
const CARD_FATAL_CODES = new Set(['54', '43']);

/** NPCI UPI AutoPay: maximum retries within the 7-day window */
const MAX_NPCI_RETRIES = 3;

/** NPCI UPI AutoPay: retry window in calendar days */
const NPCI_RETRY_WINDOW_DAYS = 7;

/** Razorpay Risk Score threshold above which ALL automation is frozen */
const FRAUD_RISK_THRESHOLD = 80;

/** After a card update link is sent, escalate to human if unpaid for N days */
const CARD_UPDATE_ESCALATE_AFTER_DAYS = 5;

/** Archive OTP drop events if no action after N hours */
const OTP_ARCHIVE_AFTER_HOURS = 1;

/** B2B Tier 1: 1–15 days overdue → formal reminder */
const B2B_TIER1_UPPER_DAYS = 15;

/** B2B Tier 2: 16–30 days overdue → conversational Hinglish nudge */
const B2B_TIER2_UPPER_DAYS = 30;

/** B2B: minimum business days between any two reminder actions */
const B2B_COOLDOWN_BUSINESS_DAYS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Policy Engine Class
// ─────────────────────────────────────────────────────────────────────────────

export class PolicyEngine {
  /**
   * Evaluates a policy context and returns a deterministic verdict.
   *
   * Evaluation order (highest priority first):
   *   0. Terminal states (RECOVERED, ABANDONED) — no further action
   *   1. Risk Score > 80 — absolute freeze, instant escalation
   *   2. Dispute flag active — hard freeze, route to AM
   *   3. Active PTP within window — pause all reminders
   *   4. PTP breach — escalate or freeze depending on breach count
   *   5. Event-type-specific rules (Flow A / B / C)
   */
  evaluate(ctx: PolicyContext, now: Date = new Date()): PolicyVerdict {
    // ── Rule 0: Terminal States ───────────────────────────────────────────────
    if (ctx.status === 'RECOVERED' || ctx.status === 'ABANDONED') {
      return this.block(
        `Event is in terminal state [${ctx.status}]. No further automated action is permitted.`,
        false,
        false,
      );
    }

    // ── Rule 1: Fraud / High Risk Score — Absolute Freeze ────────────────────
    // Regulatory basis: Razorpay Risk Scorer + RBI fraud prevention mandate.
    // Even a single nudge to a flagged account can constitute fraud facilitation.
    if (ctx.riskScore !== undefined && ctx.riskScore > FRAUD_RISK_THRESHOLD) {
      return this.block(
        `HARD FREEZE: Razorpay Risk Score ${ctx.riskScore} exceeds the maximum allowed threshold of ${FRAUD_RISK_THRESHOLD}. ` +
          `All automated flows are permanently frozen for this event. Routing to human for manual fraud review.`,
        true,  // escalate to human
        true,  // freeze all automation
        'ESCALATED_HUMAN',
      );
    }

    // ── Rule 2: Active Dispute — Hard Freeze ─────────────────────────────────
    // Regulatory basis: Sending nudges to a customer who has filed a dispute
    // constitutes harassment under RBI consumer protection guidelines.
    if (ctx.isDisputed) {
      return this.block(
        `HARD FREEZE: Dispute flag is active on this event. ` +
          `All automated nudges are prohibited. Routing immediately to Account Manager with dispute notes.`,
        true,
        true,
        'ESCALATED_HUMAN',
      );
    }

    // ── Rules 3 & 4: Promise-to-Pay State Machine ─────────────────────────────
    if (ctx.activePTP) {
      const daysUntilPromise = daysBetween(now, ctx.activePTP.promisedDate);

      if (daysUntilPromise > 0) {
        // Active PTP within window — all reminders paused
        return this.block(
          `PTP_ACTIVE: Customer has an active Promise-to-Pay. ` +
            `Promised amount ₹${ctx.activePTP.agreedAmount.toLocaleString('en-IN')} due in ${daysUntilPromise} day(s). ` +
            `All reminders are paused until ${ctx.activePTP.promisedDate.toDateString()}.`,
          false,
          false,
        );
      }

      // PTP has been breached (promised date is in the past, status still PENDING via caller)
      const breachCount = ctx.activePTP.breachCount;

      if (breachCount >= 2) {
        // Second breach — freeze all automation, tag as default risk
        return this.block(
          `BREACH #${breachCount + 1}: Second Promise-to-Pay breach detected. ` +
            `Customer has failed to honor ${breachCount + 1} commitments. ` +
            `Automation permanently frozen. Event tagged as default risk.`,
          true,
          true,
          'ESCALATED_HUMAN',
        );
      }

      // First breach — escalate one tier
      return this.allow(
        'HUMAN_HANDOFF',
        `BREACH #${breachCount + 1}: First Promise-to-Pay breach. ` +
          `Escalating one tier with firm tone and CC to Finance Head.`,
        true,
        false,
        undefined,
        'ESCALATED_HUMAN',
      );
    }

    // ── Route by Event Type ───────────────────────────────────────────────────
    switch (ctx.eventType) {
      case 'SUBSCRIPTION_FAILED':
        return this.evaluateSubscriptionFailed(ctx, now);
      case 'CHECKOUT_ABANDONED':
        return this.evaluateCheckoutAbandoned(ctx, now);
      case 'B2B_INVOICE_OVERDUE':
        return this.evaluateB2BInvoice(ctx, now);
      default: {
        const _exhaustive: never = ctx.eventType;
        return this.block(
          `Unknown event type: ${String(_exhaustive)}. Cannot evaluate policy.`,
          false,
          false,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Flow A: Recurring Debit / Mandate Failures
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateSubscriptionFailed(ctx: PolicyContext, now: Date): PolicyVerdict {
    const { declineCode, retryCount, firstRetryAt, nudgeCount, cardUpdateLinkSentAt } = ctx;

    // ── NPCI Insufficient Funds: U16 or RB ───────────────────────────────────
    if (declineCode && NPCI_INSUFFICIENT_FUNDS_CODES.has(declineCode)) {
      // Check if 7-day retry window has elapsed. If so, retries are exhausted
      // regardless of count — NPCI circular prohibits attempts after 7 days.
      if (firstRetryAt) {
        const windowAgedays = daysBetween(firstRetryAt, now);
        if (windowAgedays > NPCI_RETRY_WINDOW_DAYS && retryCount >= 1) {
          return this.block(
            `NPCI FREEZE: 7-day retry window has elapsed (${windowAgedays} days since first attempt). ` +
              `Mandate frozen. Merchant alerted. Customer must create a new mandate.`,
            true,
            true,
            'ESCALATED_HUMAN',
          );
        }
      }

      // Hard cap: max 3 retries
      if (retryCount >= MAX_NPCI_RETRIES) {
        return this.block(
          `NPCI RETRY CAP: ${retryCount}/${MAX_NPCI_RETRIES} retries exhausted for decline code ${declineCode}. ` +
            `Mandate frozen per NPCI UPI AutoPay circular. Merchant escalation triggered.`,
          true,
          true,
          'ESCALATED_HUMAN',
        );
      }

      const nextAttempt = retryCount + 1;
      const retryAt = getNextSalaryWindowRetry(now, nextAttempt);

      return this.allow(
        'RETRY_SCHEDULED',
        `NPCI decline code [${declineCode}] — Insufficient Funds. ` +
          `Scheduling retry attempt ${nextAttempt}/${MAX_NPCI_RETRIES} at salary window: ` +
          `${retryAt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} 08:00 IST. ` +
          `Remaining attempts: ${MAX_NPCI_RETRIES - nextAttempt}.`,
        false,
        false,
        retryAt,
        'IN_RECOVERY',
      );
    }

    // ── Fatal Card Declines: 54 (Expired) / 43 (Stolen) ──────────────────────
    if (declineCode && CARD_FATAL_CODES.has(declineCode)) {
      const codeName = declineCode === '54' ? 'EXPIRED CARD' : 'STOLEN/LOST CARD';

      // Zero retries permitted. Check if update link already dispatched.
      if (nudgeCount >= 1 || cardUpdateLinkSentAt) {
        const sentAgo = cardUpdateLinkSentAt ? daysBetween(cardUpdateLinkSentAt, now) : 0;

        if (sentAgo >= CARD_UPDATE_ESCALATE_AFTER_DAYS) {
          return this.block(
            `${codeName} [${declineCode}]: Update link dispatched ${sentAgo} day(s) ago — ` +
              `${CARD_UPDATE_ESCALATE_AFTER_DAYS}-day threshold exceeded with no customer action. Escalating to human.`,
            true,
            false,
            'ESCALATED_HUMAN',
          );
        }

        return this.block(
          `${codeName} [${declineCode}]: 1-click update link already dispatched. ` +
            `Awaiting customer action. ${CARD_UPDATE_ESCALATE_AFTER_DAYS - sentAgo} day(s) until human escalation. ` +
            `Zero retries — card is ${declineCode === '54' ? 'expired' : 'stolen/flagged'}.`,
          false,
          false,
        );
      }

      return this.allow(
        'SEND_UPDATE_LINK',
        `${codeName} [${declineCode}]: Zero payment retries permitted. ` +
          `Dispatching exactly 1 personalised "Update Payment Method" link via WhatsApp + Email. ` +
          `Human escalation will trigger if no update in ${CARD_UPDATE_ESCALATE_AFTER_DAYS} days.`,
        false,
        false,
        undefined,
        'IN_RECOVERY',
      );
    }

    // ── Unknown decline code — conservative escalation ────────────────────────
    return this.allow(
      'HUMAN_HANDOFF',
      `Unrecognised decline code [${declineCode ?? 'none'}] for SUBSCRIPTION_FAILED. ` +
        `Routing to human agent for manual triage to avoid non-compliant automated action.`,
      true,
      false,
      undefined,
      'ESCALATED_HUMAN',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Flow B: E-Commerce Checkout Drop-off
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateCheckoutAbandoned(ctx: PolicyContext, now: Date): PolicyVerdict {
    const { funnelStep, nudgeCount, lastNudgeSentAt } = ctx;

    // Only OTP timeout gets a nudge — other steps require direct funnel fixes
    const isOtpTimeout = funnelStep === 'step_otp_timeout';

    if (nudgeCount >= 1) {
      // Exactly 1 nudge is the hard limit regardless of step
      const minutesSinceNudge = lastNudgeSentAt
        ? (now.getTime() - lastNudgeSentAt.getTime()) / 60000
        : OTP_ARCHIVE_AFTER_HOURS * 60 + 1;

      if (minutesSinceNudge >= OTP_ARCHIVE_AFTER_HOURS * 60) {
        return this.block(
          `ARCHIVE: Nudge was sent ${Math.round(minutesSinceNudge)} min ago. ` +
            `${OTP_ARCHIVE_AFTER_HOURS}h no-response window elapsed. Archiving event — no further automation.`,
          false,
          false,
          'ABANDONED',
        );
      }

      return this.block(
        `NUDGE LIMIT: Exactly 1 checkout nudge has been dispatched (${Math.round(minutesSinceNudge)} min ago). ` +
          `Cannot send another — spam prevention. Waiting for ${OTP_ARCHIVE_AFTER_HOURS}h archive window.`,
        false,
        false,
      );
    }

    if (isOtpTimeout) {
      return this.allow(
        'SEND_OTP_NUDGE',
        `CHECKOUT DROP [step_otp_timeout]: Dispatching exactly 1 resend-OTP nudge ` +
          `+ Direct UPI Intent link within ${10}-min engagement window. ` +
          `Archive triggered if no action within ${OTP_ARCHIVE_AFTER_HOURS}h.`,
        false,
        false,
        undefined,
        'IN_RECOVERY',
      );
    }

    return this.allow(
      'SEND_OTP_NUDGE',
      `CHECKOUT DROP [${funnelStep ?? 'unknown_step'}]: Dispatching 1 personalised ` +
        `dynamic payment micro-nudge with pre-filled UPI intent link. Single-send policy.`,
      false,
      false,
      undefined,
      'IN_RECOVERY',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Flow C: B2B High-Value Receivables
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateB2BInvoice(ctx: PolicyContext, now: Date): PolicyVerdict {
    const { invoiceDueDate, lastNudgeSentAt, nudgeCount } = ctx;

    if (!invoiceDueDate) {
      return this.block(
        'B2B_INVOICE_OVERDUE event is missing invoiceDueDate. ' +
          'Cannot compute overdue window. Manual review required.',
        false,
        false,
      );
    }

    const daysOverdue = daysBetween(invoiceDueDate, now);

    if (daysOverdue <= 0) {
      return this.block(
        `Invoice is not yet overdue (due date: ${invoiceDueDate.toDateString()}). ` +
          `No action is permitted before the due date.`,
        false,
        false,
      );
    }

    // ── Business-day cooldown check ───────────────────────────────────────────
    // Max 1 automated reminder per 5 business days to prevent harassment.
    if (lastNudgeSentAt && nudgeCount >= 1) {
      const bDaysSinceNudge = countBusinessDaysBetween(lastNudgeSentAt, now);
      if (bDaysSinceNudge < B2B_COOLDOWN_BUSINESS_DAYS) {
        return this.block(
          `COOLDOWN: Last reminder sent ${bDaysSinceNudge} business day(s) ago. ` +
            `Minimum cooldown is ${B2B_COOLDOWN_BUSINESS_DAYS} business days. ` +
            `Next reminder eligible in ${B2B_COOLDOWN_BUSINESS_DAYS - bDaysSinceNudge} business day(s).`,
          false,
          false,
        );
      }
    }

    // ── Tier 1: 1–15 days overdue — formal reminder ───────────────────────────
    if (daysOverdue <= B2B_TIER1_UPPER_DAYS) {
      return this.allow(
        'SEND_FORMAL_REMINDER',
        `B2B TIER 1 [${daysOverdue} day(s) overdue]: ` +
          `Dispatching polite formal reminder referencing Invoice # and PO number. ` +
          `Tone: professional, non-threatening. Cooldown: ${B2B_COOLDOWN_BUSINESS_DAYS} business days.`,
        false,
        false,
        undefined,
        'IN_RECOVERY',
      );
    }

    // ── Tier 2: 16–30 days overdue — conversational Hinglish nudge ───────────
    if (daysOverdue <= B2B_TIER2_UPPER_DAYS) {
      return this.allow(
        'SEND_CONVERSATIONAL_NUDGE',
        `B2B TIER 2 [${daysOverdue} day(s) overdue]: ` +
          `Initiating Hinglish WhatsApp / voice nudge via Right Brain LLM agent. ` +
          `Monitoring response for Promise-to-Pay extraction. ` +
          `If PTP detected → transition to PTP_ACTIVE and pause all reminders.`,
        false,
        false,
        undefined,
        'IN_RECOVERY',
      );
    }

    // ── Tier 3: >30 days overdue — human escalation ───────────────────────────
    return this.allow(
      'HUMAN_HANDOFF',
      `B2B TIER 3 [${daysOverdue} day(s) overdue]: ` +
        `Beyond automated recovery window (>30 days). ` +
        `Escalating to human Account Manager for direct engagement.`,
      true,
      false,
      undefined,
      'ESCALATED_HUMAN',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private block(
    reason: string,
    escalate: boolean,
    freeze: boolean,
    newStatus?: PolicyVerdict['newStatus'],
  ): PolicyVerdict {
    return {
      allowed: false,
      action: null,
      reason,
      escalate,
      freeze,
      newStatus,
    };
  }

  private allow(
    action: AllowedAction,
    reason: string,
    escalate: boolean,
    freeze: boolean,
    retryAt?: Date,
    newStatus?: PolicyVerdict['newStatus'],
  ): PolicyVerdict {
    return {
      allowed: true,
      action,
      reason,
      escalate,
      freeze,
      retryAt,
      newStatus,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export — import this throughout the codebase
// ─────────────────────────────────────────────────────────────────────────────
export const policyEngine = new PolicyEngine();
