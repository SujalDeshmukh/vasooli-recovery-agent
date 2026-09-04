// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Unit Economics Cost Ledger
//
// Single source of truth for every per-action cost in INR.
// These values are written to AuditLog.costIncurred after each action so
// the Metrics API can compute:
//   netValueCreated = Σ rupeesRecovered − Σ costIncurred
// ─────────────────────────────────────────────────────────────────────────────

/** All recoverable costs Vasooli incurs per action, in Indian Rupees (INR). */
export const COSTS_INR = {
  /** WhatsApp Business API message (Meta/Twilio blended rate) */
  WHATSAPP_MESSAGE: 0.78,

  /** Transactional email via SendGrid/SES */
  EMAIL: 0.05,

  /** Gemini Flash 2.0 call for root-cause diagnosis (~500 in / 200 out tokens) */
  GEMINI_DIAGNOSIS: 0.12,

  /** Gemini Flash 2.0 call for Hinglish agent message composition */
  GEMINI_HINGLISH_AGENT: 0.45,

  /** Gemini Flash 2.0 call for PTP extraction from free-form text */
  GEMINI_PTP_EXTRACT: 0.18,

  /** Razorpay gateway retry fee per attempt */
  GATEWAY_RETRY: 2.0,

  /** Razorpay payment link creation — free */
  PAYMENT_LINK_CREATE: 0.0,
} as const;

export type CostKey = keyof typeof COSTS_INR;

/** Compute the total cost for a set of actions taken for a single event */
export function sumCosts(...keys: CostKey[]): number {
  return keys.reduce((acc, k) => acc + COSTS_INR[k], 0);
}

/** Round to 2 decimal places for DB storage */
export function roundCost(n: number): number {
  return Math.round(n * 100) / 100;
}
