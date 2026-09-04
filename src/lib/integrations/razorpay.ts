// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Razorpay API Integration Client
//
// Wraps all Razorpay REST API calls Vasooli makes. Supports a simulation mode
// (RAZORPAY_SIMULATE=true) that returns realistic fake data without hitting
// the live API — essential for demo/dev without real credentials.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.razorpay.com/v1';

function isSimulated(): boolean {
  return process.env.RAZORPAY_SIMULATE === 'true' || process.env.NODE_ENV === 'development';
}

function getAuthHeaders(): Record<string, string> {
  const keyId = process.env.RAZORPAY_KEY_ID ?? '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
  const creds = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  return {
    Authorization: `Basic ${creds}`,
    'Content-Type': 'application/json',
  };
}

async function rzpFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...getAuthHeaders(), ...(init.headers as Record<string, string>) },
  });
  const data = (await res.json()) as T & { error?: { description: string } };
  if (!res.ok) {
    throw new Error(
      (data as { error?: { description: string } }).error?.description ??
        `Razorpay API error: ${res.status} ${res.statusText}`,
    );
  }
  return data;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RetryResult {
  success: boolean;
  /** Razorpay payment ID if retry succeeded */
  paymentId?: string;
  /** Error code if retry failed */
  errorCode?: string;
}

export interface PaymentLinkResult {
  id: string;
  shortUrl: string;
  expiresAt: number;
}

// ── API Methods ───────────────────────────────────────────────────────────────

/**
 * Retries a Razorpay subscription charge.
 * Maps to: POST /v1/subscriptions/:id/invoke
 *
 * @param subscriptionId  - Razorpay subscription ID (e.g. "sub_xxxxxx")
 * @returns               - Whether the retry succeeded and the resulting payment ID
 */
export async function retrySubscription(subscriptionId: string): Promise<RetryResult> {
  if (isSimulated()) {
    // Simulate ~65% retry success rate — realistic for salary-window retries
    const success = Math.random() < 0.65;
    const paymentId = success ? `pay_sim_${Date.now().toString(36)}` : undefined;
    console.log(
      `[Razorpay Sim] retrySubscription(${subscriptionId}) → ${success ? `✓ ${paymentId}` : '✗ insufficient_funds'}`,
    );
    return { success, paymentId, errorCode: success ? undefined : 'INSUFFICIENT_FUNDS' };
  }

  try {
    const data = await rzpFetch<{ id: string; payment_id?: string }>(
      `/subscriptions/${subscriptionId}/invoke`,
      { method: 'POST' },
    );
    return { success: true, paymentId: data.payment_id };
  } catch (err) {
    const msg = (err as Error).message;
    return { success: false, errorCode: msg };
  }
}

/**
 * Creates a Razorpay Payment Link for collecting overdue amounts or updating
 * payment methods. Used for both OTP nudges (UPI intent) and card-update flows.
 *
 * Maps to: POST /v1/payment_links
 */
export async function createPaymentLink(params: {
  amountPaise: number;
  currency: string;
  description: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  /** Seconds from now until the link expires */
  expiresInSeconds?: number;
}): Promise<PaymentLinkResult> {
  if (isSimulated()) {
    const shortCode = Math.random().toString(36).slice(2, 8).toUpperCase();
    const result = {
      id: `plink_sim_${Date.now().toString(36)}`,
      shortUrl: `https://rzp.io/l/${shortCode}`,
      expiresAt: Math.floor(Date.now() / 1000) + (params.expiresInSeconds ?? 3600),
    };
    console.log(`[Razorpay Sim] createPaymentLink → ${result.shortUrl}`);
    return result;
  }

  const expireBy = params.expiresInSeconds
    ? Math.floor(Date.now() / 1000) + params.expiresInSeconds
    : undefined;

  const data = await rzpFetch<{ id: string; short_url: string; expire_by: number }>(
    '/payment_links',
    {
      method: 'POST',
      body: JSON.stringify({
        amount: params.amountPaise,
        currency: params.currency,
        description: params.description,
        customer: {
          name: params.customerName,
          email: params.customerEmail,
          contact: params.customerPhone,
        },
        expire_by: expireBy,
        reminder_enable: false, // Vasooli manages reminders independently
        upi_link: true,         // Generate UPI intent link for instant payment
      }),
    },
  );

  return { id: data.id, shortUrl: data.short_url, expiresAt: data.expire_by };
}

/**
 * Cancels (freezes) a Razorpay subscription / UPI AutoPay mandate.
 * Called when NPCI retry cap is breached or merchant requests freeze.
 *
 * Maps to: POST /v1/subscriptions/:id/cancel
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  if (isSimulated()) {
    console.log(`[Razorpay Sim] cancelSubscription(${subscriptionId}) → ✓ cancelled`);
    return;
  }
  await rzpFetch(`/subscriptions/${subscriptionId}/cancel`, { method: 'POST' });
}
