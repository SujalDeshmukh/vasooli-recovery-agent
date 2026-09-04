// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Hinglish B2B Collections Message Composer (Right Brain)
//
// Composes contextual Hinglish WhatsApp messages for B2B Tier 2 collections
// (16–30 days overdue). The message tone escalates based on the overdue tier
// and previous interaction history.
//
// This agent only COMPOSES text. The Left Brain has already approved the action.
// Dispatch is handled by the messaging client (messaging.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai';
import { COSTS_INR } from '../costs';

function isSimulated(): boolean {
  return !process.env.GEMINI_API_KEY || process.env.GEMINI_SIMULATE === 'true';
}

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HinglishMessageParams {
  customerName: string;
  amountDue: number;
  currency: string;
  daysOverdue: number;
  invoiceRef?: string;
  merchantName?: string;
  /** ISO timestamp of any prior conversation context */
  previousMessageSentAt?: string;
  /** Whether a promise was previously given but not honored */
  isPTPBreach?: boolean;
}

export interface HinglishMessageResult {
  /** The composed Hinglish message ready to send */
  message: string;
  /** INR cost of this LLM call */
  llmCostINR: number;
}

// ── Simulated messages ────────────────────────────────────────────────────────

function buildSimMessage(params: HinglishMessageParams): string {
  const { customerName, amountDue, currency, daysOverdue, invoiceRef, isPTPBreach } = params;
  const firstName = customerName.split(' ')[0];
  const amtFormatted = `₹${amountDue.toLocaleString('en-IN')}`;
  const invoicePart = invoiceRef ? ` (Invoice #${invoiceRef})` : '';

  if (isPTPBreach) {
    return (
      `Namaste ${firstName} ji 🙏\n\n` +
      `Humne notice kiya ki aapne pichli baar payment date de thi, lekin ${amtFormatted}${invoicePart} abhi tak pending hai.\n\n` +
      `Samajh mein aata hai ki kabhi kabhi business mein delays ho jaate hain. ` +
      `Kya aap hume bata sakte hain ki payment kab expect karein?\n\n` +
      `Agar koi pareshani hai, toh apne account manager se baat kar sakte hain.\n\n` +
      `Dhanyavaad 🙏`
    );
  }

  if (daysOverdue >= 25) {
    return (
      `${firstName} ji,\n\n` +
      `Aapki ${amtFormatted}${invoicePart} ki payment ${daysOverdue} din se overdue hai.\n\n` +
      `Hum aapse request karte hain ki aaj hi payment process karein ya ` +
      `humse baat karein. Bahut jaldi hamein is matter ko escalate karna padega.\n\n` +
      `Payment link: [PAYMENT_LINK]\n\n` +
      `Reply karein ya call karein: +91-XXXXXXXXXX`
    );
  }

  return (
    `Namaste ${firstName} ji! 😊\n\n` +
    `Yeh ek friendly reminder hai — aapki ${amtFormatted}${invoicePart} ki payment ${daysOverdue} din se pending hai.\n\n` +
    `Agar koi problem hai payment mein, toh please hume batayein — hum mil ke solution dhundhte hain!\n\n` +
    `Payment yahan se kar sakte hain: [PAYMENT_LINK]\n\n` +
    `Koi sawaal? Bas reply kar dijiye 🙏`
  );
}

// ── Main function ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Aap Vasooli ke taraf se ek collections specialist hain. Aapka naam "Vasooli Sahayak" hai.
Aapko overdue B2B invoices ke liye WhatsApp messages likhne hain jo:
1. Hinglish mein hon (Hindi + English mix, jaise Indian professionals baat karte hain)
2. Professional aur respectful tone mein hon
3. Clear aur concise hon (max 200 words)
4. Payment ke liye gentle pressure create karein without being aggressive
5. "[PAYMENT_LINK]" placeholder use karein actual link ke liye
6. Emojis ka appropriate use karein (max 2-3)

Agar days_overdue > 24 hai, tone firm aur more urgent honi chahiye.
Agar PTP breach hai, acknowledgment ke saath next commitment maangein.`;

/**
 * Composes a contextual Hinglish WhatsApp message for B2B Tier 2 collection.
 */
export async function composeHinglishMessage(
  params: HinglishMessageParams,
): Promise<HinglishMessageResult> {
  if (isSimulated()) {
    const message = buildSimMessage(params);
    console.log(`[Hinglish Sim] Composed message for ${params.customerName} (${params.daysOverdue}d overdue)`);
    return { message, llmCostINR: COSTS_INR.GEMINI_HINGLISH_AGENT };
  }

  const { customerName, amountDue, currency, daysOverdue, invoiceRef, merchantName, isPTPBreach } =
    params;

  const userPrompt =
    `Customer: ${customerName}\n` +
    `Amount Due: ${currency} ${amountDue.toLocaleString('en-IN')}\n` +
    `Days Overdue: ${daysOverdue}\n` +
    `Invoice Reference: ${invoiceRef ?? 'N/A'}\n` +
    `Merchant/Creditor: ${merchantName ?? 'our company'}\n` +
    `PTP Breach: ${isPTPBreach ? 'Yes — customer missed a previous payment promise' : 'No'}\n\n` +
    `Write the WhatsApp collection message in Hinglish. Use [PAYMENT_LINK] as a placeholder for the payment URL.`;

  const model = getGenAI().getGenerativeModel({
    model: 'gemini-3.6-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.7, // Some creativity for natural-sounding messages
      maxOutputTokens: 400,
    },
  });

  const result = await model.generateContent(userPrompt);
  const message = result.response.text().trim();

  return { message, llmCostINR: COSTS_INR.GEMINI_HINGLISH_AGENT };
}

/**
 * Composes a formal English B2B invoice reminder for Tier 1 (1-15 days overdue).
 */
export async function composeFormalReminder(params: {
  customerName: string;
  amountDue: number;
  currency: string;
  daysOverdue: number;
  invoiceRef?: string;
  dueDate?: string;
  merchantName?: string;
}): Promise<HinglishMessageResult> {
  if (isSimulated()) {
    const { customerName, amountDue, daysOverdue, invoiceRef, dueDate } = params;
    const html = `
<p>Dear ${customerName},</p>
<p>This is a gentle reminder that Invoice${invoiceRef ? ` #${invoiceRef}` : ''} for 
<strong>₹${amountDue.toLocaleString('en-IN')}</strong> was due on 
${dueDate ?? 'the agreed date'} and remains outstanding by ${daysOverdue} day(s).</p>
<p>Please arrange payment at your earliest convenience using the secure link below:</p>
<p><a href="[PAYMENT_LINK]">[PAYMENT_LINK]</a></p>
<p>If you have any questions or need to discuss payment terms, please reply to this email.</p>
<p>Thank you for your prompt attention to this matter.</p>
<p>Warm regards,<br/>Vasooli Collections Team</p>`.trim();
    return { message: html, llmCostINR: COSTS_INR.GEMINI_HINGLISH_AGENT };
  }

  const model = getGenAI().getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
  });

  const prompt =
    `Write a formal B2B invoice reminder email in professional English (HTML format) for:\n` +
    `Customer: ${params.customerName}\n` +
    `Amount: ${params.currency} ${params.amountDue.toLocaleString('en-IN')}\n` +
    `Invoice #: ${params.invoiceRef ?? 'N/A'}\n` +
    `Days Overdue: ${params.daysOverdue}\n` +
    `Due Date: ${params.dueDate ?? 'stated on invoice'}\n` +
    `Sender: ${params.merchantName ?? 'Vasooli'}\n\n` +
    `Use [PAYMENT_LINK] for the payment URL. Keep it under 150 words. Professional but warm tone.`;

  const result = await model.generateContent(prompt);
  return { message: result.response.text().trim(), llmCostINR: COSTS_INR.GEMINI_HINGLISH_AGENT };
}

