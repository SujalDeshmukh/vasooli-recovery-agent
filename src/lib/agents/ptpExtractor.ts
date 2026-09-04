// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Promise-to-Pay Extractor (Right Brain)
//
// Uses Gemini Flash 2.0 with strict JSON schema output to extract structured
// Promise-to-Pay commitments from free-form Hinglish/English customer replies.
//
// Example:
//   Input:  "Bhaiya, abhi client se payment nahi aayi hai, Tuesday tak pakka kar dunga."
//   Output: { intent: "promise_to_pay", targetDate: "2026-09-02T16:00:00+05:30",
//             reason: "cashflow_delay", sentiment: "cooperative", confidence: 0.94 }
//
// The caller (whatsapp webhook handler) uses the output to:
//   - Create a PromiseToPay DB record
//   - Update RevenueEvent.status → PTP_ACTIVE
//   - Pause all future automated reminders
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { Schema } from '@google/generative-ai';
import { COSTS_INR } from '../costs';

function isSimulated(): boolean {
  return !process.env.GEMINI_API_KEY || process.env.GEMINI_SIMULATE === 'true';
}

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

// ── Output Types ──────────────────────────────────────────────────────────────

export type PTPIntent =
  | 'promise_to_pay'   // Customer commits to a specific date
  | 'dispute'          // Customer disputes the amount or invoice validity
  | 'request_extension'// Customer asks for more time without a specific date
  | 'paid_already'     // Customer claims payment was already made
  | 'cannot_pay'       // Customer explicitly refuses or cannot pay
  | 'no_intent';       // Ambiguous, no recoverable intent

export type Sentiment = 'cooperative' | 'neutral' | 'hostile' | 'evasive';

export interface PTPExtraction {
  intent: PTPIntent;
  /** ISO 8601 timestamp of promised payment date (only for promise_to_pay / request_extension) */
  targetDate?: string;
  /** Amount promised if different from full invoice amount */
  agreedAmount?: number;
  /** Stated reason for delay */
  reason?: string;
  /** Customer's emotional sentiment */
  sentiment: Sentiment;
  /** Confidence in the extraction 0.0–1.0 */
  confidence: number;
  /** The exact verbatim quote that justifies this extraction */
  extractedQuote?: string;
  /** Whether this response requires immediate human escalation */
  requiresHumanHandoff: boolean;
  /** INR cost of this LLM call */
  llmCostINR: number;
}

// ── Response Schema ───────────────────────────────────────────────────────────

const EXTRACTION_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    intent: { type: SchemaType.STRING },
    targetDate: { type: SchemaType.STRING },
    agreedAmount: { type: SchemaType.NUMBER },
    reason: { type: SchemaType.STRING },
    sentiment: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
    extractedQuote: { type: SchemaType.STRING },
    requiresHumanHandoff: { type: SchemaType.BOOLEAN },
  },
  required: ['intent', 'sentiment', 'confidence', 'requiresHumanHandoff'],
};

// ── Simulation responses ──────────────────────────────────────────────────────

function buildSimExtraction(text: string, nowISO: string): Omit<PTPExtraction, 'llmCostINR'> {
  const lower = text.toLowerCase();

  // Simple heuristic for simulation mode
  if (lower.includes('dispute') || lower.includes('galat') || lower.includes('wrong')) {
    return {
      intent: 'dispute', sentiment: 'hostile', confidence: 0.82,
      reason: 'invoice_disputed', extractedQuote: text.slice(0, 100),
      requiresHumanHandoff: true,
    };
  }
  if (lower.includes('pay') || lower.includes('dunga') || lower.includes('karunga') ||
      lower.includes('monday') || lower.includes('tuesday') || lower.includes('friday') ||
      lower.includes('week') || lower.includes('kal') || lower.includes('parson')) {
    // Extract a date ~3-5 days from now for simulation
    const target = new Date(nowISO);
    target.setDate(target.getDate() + 4);
    target.setHours(16, 0, 0, 0);
    return {
      intent: 'promise_to_pay', sentiment: 'cooperative', confidence: 0.91,
      targetDate: target.toISOString(),
      reason: 'cashflow_delay', extractedQuote: text.slice(0, 100),
      requiresHumanHandoff: false,
    };
  }
  if (lower.includes('nahi') || lower.includes('cannot') || lower.includes('refuse')) {
    return {
      intent: 'cannot_pay', sentiment: 'hostile', confidence: 0.76,
      reason: 'explicit_refusal', extractedQuote: text.slice(0, 100),
      requiresHumanHandoff: true,
    };
  }
  return {
    intent: 'no_intent', sentiment: 'neutral', confidence: 0.55,
    requiresHumanHandoff: false,
  };
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Extracts a structured Promise-to-Pay commitment from free-form text.
 *
 * @param text     - Raw customer reply (Hinglish or English)
 * @param context  - Optional invoice context to improve extraction accuracy
 * @param now      - Current date (defaults to new Date()) for relative date resolution
 */
export async function extractPTP(
  text: string,
  context?: {
    invoiceAmount?: number;
    currency?: string;
    daysOverdue?: number;
  },
  now: Date = new Date(),
): Promise<PTPExtraction> {
  const nowISO = now.toISOString();

  if (isSimulated()) {
    const sim = buildSimExtraction(text, nowISO);
    console.log(`[PTP Extractor Sim] intent=${sim.intent} sentiment=${sim.sentiment} confidence=${sim.confidence}`);
    return { ...sim, llmCostINR: COSTS_INR.GEMINI_PTP_EXTRACT };
  }

  const model = getGenAI().getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: EXTRACTION_SCHEMA,
      temperature: 0.1, // Near-zero temp for factual, consistent extraction
    },
  });

  const contextPart = context
    ? `\nInvoice context: Amount = ${context.currency ?? 'INR'} ${context.invoiceAmount?.toLocaleString('en-IN') ?? 'unknown'}, Days overdue = ${context.daysOverdue ?? 'unknown'}`
    : '';

  const prompt =
    `You are extracting structured payment intent from an Indian B2B customer's WhatsApp reply.\n` +
    `Current date/time (IST): ${nowISO}${contextPart}\n\n` +
    `Customer message:\n"${text}"\n\n` +
    `Instructions:\n` +
    `- targetDate must be a full ISO 8601 timestamp with IST offset (+05:30) resolved from any relative reference (e.g. "Tuesday", "kal", "next week")\n` +
    `- If no specific date is mentioned but intent is clear, add 5 business days from today\n` +
    `- requiresHumanHandoff = true for: disputes, explicit refusal, threats, hostile sentiment\n` +
    `- extractedQuote must be the minimal verbatim substring that justifies the intent\n` +
    `- confidence reflects certainty in the intent classification, not the promised date`;

  const result = await model.generateContent(prompt);
  const parsed = JSON.parse(result.response.text()) as Omit<PTPExtraction, 'llmCostINR'>;

  return { ...parsed, llmCostINR: COSTS_INR.GEMINI_PTP_EXTRACT };
}

