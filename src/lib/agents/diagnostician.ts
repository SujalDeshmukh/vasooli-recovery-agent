// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Root-Cause Diagnostician (Right Brain, Step 1)
//
// Powered by Gemini Flash 2.0. Called once per event at ingestion time.
// Returns a structured diagnosis that enriches the AuditLog and informs
// the tone/strategy of subsequent Right Brain agents.
//
// Critical constraint: This agent is called AFTER the Left Brain policy engine
// has approved action. It NEVER overrides a policy verdict.
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { Schema } from '@google/generative-ai';
import { COSTS_INR } from '../costs';
import type { PolicyContext } from '../engine/types';

// ── Simulation guard ──────────────────────────────────────────────────────────

function isSimulated(): boolean {
  return !process.env.GEMINI_API_KEY || process.env.GEMINI_SIMULATE === 'true';
}

// ── Gemini client (lazy-init to avoid crash when GEMINI_API_KEY is absent) ──

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

// ── Output Schema ─────────────────────────────────────────────────────────────

export interface DiagnosisResult {
  /** Machine-readable root cause (snake_case) */
  rootCause: string;
  /** Confidence score 0.0–1.0 */
  confidence: number;
  /** 1-2 sentence human-readable summary for the ops team */
  contextSummary: string;
  /** Tone recommendation for downstream messaging agents */
  suggestedTone: 'formal' | 'conversational' | 'urgent' | 'empathetic';
  /** INR cost of this LLM call */
  llmCostINR: number;
}

const RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    rootCause: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
    contextSummary: { type: SchemaType.STRING },
    suggestedTone: { type: SchemaType.STRING },
  },
  required: ['rootCause', 'confidence', 'contextSummary', 'suggestedTone'],
};

// ── Simulated responses for demo ──────────────────────────────────────────────

const SIM_RESPONSES: Record<string, Omit<DiagnosisResult, 'llmCostINR'>> = {
  SUBSCRIPTION_FAILED_U16: {
    rootCause: 'insufficient_funds_payday_lag',
    confidence: 0.91,
    contextSummary:
      'Customer\'s mandate failed with NPCI code U16 — classic payday lag pattern. High probability the account will be funded on salary credit day (1st–5th of month). Retry at next salary window.',
    suggestedTone: 'empathetic',
  },
  SUBSCRIPTION_FAILED_RB: {
    rootCause: 'insufficient_funds_temporary',
    confidence: 0.85,
    contextSummary:
      'RB decline suggests a temporary low-balance state. Customer likely has an active account but was caught mid-cycle. T+1 retry at 8 AM IST recommended.',
    suggestedTone: 'empathetic',
  },
  SUBSCRIPTION_FAILED_54: {
    rootCause: 'card_expired',
    confidence: 0.99,
    contextSummary:
      'Card has passed its expiry date (code 54). No payment retry is possible — customer must update their payment method. Zero retries; dispatch 1-click update link immediately.',
    suggestedTone: 'urgent',
  },
  SUBSCRIPTION_FAILED_43: {
    rootCause: 'card_stolen_or_lost',
    confidence: 0.99,
    contextSummary:
      'Card has been reported stolen or lost (code 43). Automated recovery is blocked. Customer must provide a new card via the update-payment portal.',
    suggestedTone: 'empathetic',
  },
  CHECKOUT_ABANDONED: {
    rootCause: 'otp_friction_drop',
    confidence: 0.88,
    contextSummary:
      'Customer abandoned during OTP verification. Likely a UX friction point — resending a 1-click UPI intent link bypasses OTP entirely and has 3× higher conversion than OTP resend.',
    suggestedTone: 'conversational',
  },
  B2B_INVOICE_OVERDUE: {
    rootCause: 'vendor_payment_cycle_delay',
    confidence: 0.79,
    contextSummary:
      'Invoice overdue — likely caught in the counterparty\'s monthly payment cycle or pending internal approvals. A professional but firm reminder referencing the invoice and PO number is most effective.',
    suggestedTone: 'formal',
  },
};

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Diagnoses the root cause of a revenue event using Gemini Flash 2.0.
 * In simulation mode returns a pre-canned response matching the event type.
 */
export async function diagnoseEvent(ctx: PolicyContext): Promise<DiagnosisResult> {
  if (isSimulated()) {
    const key =
      ctx.declineCode
        ? `${ctx.eventType}_${ctx.declineCode}`
        : ctx.eventType;
    const sim = SIM_RESPONSES[key] ?? SIM_RESPONSES[ctx.eventType] ?? SIM_RESPONSES.B2B_INVOICE_OVERDUE;
    console.log(`[Diagnostician Sim] rootCause=${sim.rootCause} confidence=${sim.confidence}`);
    return { ...sim, llmCostINR: COSTS_INR.GEMINI_DIAGNOSIS };
  }

  const prompt = buildPrompt(ctx);
  const model = getGenAI().getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2, // Low temperature for consistent, factual diagnosis
    },
  });

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = JSON.parse(text) as Omit<DiagnosisResult, 'llmCostINR'>;

  return { ...parsed, llmCostINR: COSTS_INR.GEMINI_DIAGNOSIS };
}

function buildPrompt(ctx: PolicyContext): string {
  return `You are a fintech revenue operations analyst specialising in Indian payment infrastructure.
Diagnose the root cause of the following failed payment/revenue event and return a structured JSON response.

EVENT DATA:
- Event Type: ${ctx.eventType}
- Decline Code: ${ctx.declineCode ?? 'N/A'}
- Funnel Step: ${ctx.funnelStep ?? 'N/A'}
- Days Overdue: ${ctx.invoiceDueDate ? Math.floor((Date.now() - ctx.invoiceDueDate.getTime()) / 86400000) : 'N/A'}
- Is Disputed: ${ctx.isDisputed}
- Risk Score: ${ctx.riskScore ?? 'N/A'}
- Prior Retry Count: ${ctx.retryCount}
- Active Promise-to-Pay: ${ctx.activePTP ? `Yes, promised by ${ctx.activePTP.promisedDate.toDateString()}` : 'No'}

NPCI Decline Code Reference:
- U16 = Insufficient funds (UPI)
- RB = Rejected by bank (insufficient funds)
- 54 = Expired card
- 43 = Stolen/lost card

Return JSON with fields: rootCause (snake_case string), confidence (0.0-1.0), contextSummary (1-2 sentences for ops team), suggestedTone (formal|conversational|urgent|empathetic).`;
}

