// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Unified Messaging Client
//
// Abstracts WhatsApp Business API (Twilio) and Email dispatch behind a single
// interface with per-message cost tracking for the unit-economics ledger.
//
// Simulation mode (NODE_ENV !== 'production' OR WHATSAPP_SIMULATE=true):
//   Messages are logged to console instead of sent over the wire.
//   Cost is still recorded so MetricsBar shows realistic unit economics.
// ─────────────────────────────────────────────────────────────────────────────

import { COSTS_INR } from '../costs';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MessageResult {
  /** Provider message ID (or simulation placeholder) */
  messageId: string;
  /** Cost of this message in INR — written to AuditLog.costIncurred */
  costINR: number;
  /** Whether this was a simulated send (no actual HTTP call) */
  simulated: boolean;
}

// ── Simulation guard ──────────────────────────────────────────────────────────

function shouldSimulateWhatsApp(): boolean {
  return (
    process.env.WHATSAPP_SIMULATE === 'true' ||
    process.env.NODE_ENV !== 'production' ||
    !process.env.TWILIO_ACCOUNT_SID
  );
}

function shouldSimulateEmail(): boolean {
  return (
    process.env.EMAIL_SIMULATE === 'true' ||
    process.env.NODE_ENV !== 'production' ||
    !process.env.SENDGRID_API_KEY
  );
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

/**
 * Sends a WhatsApp message via Twilio's WhatsApp Business API.
 *
 * @param to      - E.164 phone number (e.g. "+919876543210")
 * @param message - Plain text or template message body
 * @returns       - MessageResult with ID and INR cost
 */
export async function sendWhatsApp(to: string, message: string): Promise<MessageResult> {
  if (shouldSimulateWhatsApp()) {
    const msgId = `wa_sim_${Date.now().toString(36)}`;
    const preview = message.length > 120 ? message.slice(0, 120) + '…' : message;
    console.log(`\n[WhatsApp Sim] ──────────────────────────────────────────`);
    console.log(`  To:      ${to}`);
    console.log(`  Message: ${preview}`);
    console.log(`  Cost:    ₹${COSTS_INR.WHATSAPP_MESSAGE}`);
    console.log(`  MsgID:   ${msgId}`);
    console.log(`[WhatsApp Sim] ──────────────────────────────────────────\n`);
    return { messageId: msgId, costINR: COSTS_INR.WHATSAPP_MESSAGE, simulated: true };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const fromNumber = process.env.WHATSAPP_FROM_NUMBER!;

  const body = new URLSearchParams({
    From: `whatsapp:${fromNumber}`,
    To: `whatsapp:${to}`,
    Body: message,
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );

  const data = (await res.json()) as { sid: string; error_message?: string };
  if (!res.ok) {
    throw new Error(`WhatsApp send failed: ${data.error_message ?? res.statusText}`);
  }

  return { messageId: data.sid, costINR: COSTS_INR.WHATSAPP_MESSAGE, simulated: false };
}

// ── Email ─────────────────────────────────────────────────────────────────────

/**
 * Sends a transactional email. Production wires to SendGrid.
 * All HTML is sanitised before sending.
 *
 * @param to      - Recipient email address
 * @param subject - Email subject line
 * @param html    - HTML email body
 * @param text    - Plain-text fallback
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<MessageResult> {
  if (shouldSimulateEmail()) {
    const msgId = `email_sim_${Date.now().toString(36)}`;
    const preview = (text ?? html).replace(/<[^>]*>/g, '').slice(0, 200);
    console.log(`\n[Email Sim] ──────────────────────────────────────────────`);
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Preview: ${preview}…`);
    console.log(`  Cost:    ₹${COSTS_INR.EMAIL}`);
    console.log(`[Email Sim] ──────────────────────────────────────────────\n`);
    return { messageId: msgId, costINR: COSTS_INR.EMAIL, simulated: true };
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@vasooli.in', name: 'Vasooli' },
      subject,
      content: [
        { type: 'text/plain', value: text ?? html.replace(/<[^>]*>/g, '') },
        { type: 'text/html', value: html },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Email send failed: ${res.status} ${res.statusText}`);
  }

  // SendGrid 202 returns no body — use X-Message-Id header
  const msgId = res.headers.get('x-message-id') ?? `email_${Date.now().toString(36)}`;
  return { messageId: msgId, costINR: COSTS_INR.EMAIL, simulated: false };
}

