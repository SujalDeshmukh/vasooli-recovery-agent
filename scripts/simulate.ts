// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Demo Simulation Script
// Razorpay AI Buildathon 2026
//
// Generates a realistic batch of revenue-loss events and then simulates
// customer recoveries — giving the dashboard REAL, non-zero recovery numbers.
//
// Usage:
//   npx tsx scripts/simulate.ts                    # Full 90 failures + 25 recoveries
//   npx tsx scripts/simulate.ts --dry-run          # Print manifest only, don't fire
//   npx tsx scripts/simulate.ts --failures-only    # Only fire failure events (no recovery)
//   npx tsx scripts/simulate.ts --count=20         # Fire first 20 failure events only
//
// Failure batch:
//   32  SUBSCRIPTION_FAILED  (mandate / card declines, NPCI codes)
//   33  B2B_INVOICE_OVERDUE  (Tier 1, Tier 2, Tier 3, disputes)
//   25  CHECKOUT_ABANDONED   (OTP timeouts, funnel drops)
//
// Recovery batch (fired after 2s pause):
//   ~25 payment.captured events simulating customers who paid the links/reminders
//   → Shows realistic 30–35% gross recovery rate on dashboard
//
// Edge cases (Left Brain guardrails):
//   • Risk Score 95   → HARD FREEZE + Human Escalation
//   • Dispute flag    → HARD FREEZE (mandate + B2B variants)
//   • NPCI RB expired → FREEZE_MANDATE after 3 retries
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const WEBHOOK_URL = `${BASE_URL}/api/webhooks/razorpay`;
const CAPTURE_URL = WEBHOOK_URL; // same endpoint, different event name
const DELAY_MS = 150; // ms between events

// ── Synthetic customer pool ───────────────────────────────────────────────────

const CUSTOMERS = [
  { name: 'Rahul Sharma',   phone: '+919876543210', email: 'rahul@acme.in' },
  { name: 'Priya Patel',    phone: '+919876543211', email: 'priya@globaltech.in' },
  { name: 'Amit Verma',     phone: '+919876543212', email: 'amit@starups.io' },
  { name: 'Sunita Rao',     phone: '+919876543213', email: 'sunita@bigcorp.com' },
  { name: 'Vikram Singh',   phone: '+919876543214', email: 'vikram@msme.co.in' },
  { name: 'Kavitha Menon',  phone: '+919876543215', email: 'kavitha@exports.in' },
  { name: 'Deepak Joshi',   phone: '+919876543216', email: 'deepak@realty.in' },
  { name: 'Neha Gupta',     phone: '+919876543217', email: 'neha@pharma.in' },
  { name: 'Arjun Nair',     phone: '+919876543218', email: 'arjun@logistics.io' },
  { name: 'Meera Iyer',     phone: '+919876543219', email: 'meera@textiles.in' },
];

const MERCHANTS = [
  'merchant_growfast', 'merchant_zetafinance', 'merchant_bharat_pay',
  'merchant_credlink', 'merchant_nova_tech',
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min: number, max: number): number { return Math.round(Math.random() * (max - min) + min); }
function randFloat(min: number, max: number): number { return Math.random() * (max - min) + min; }

// ── Event builder types ────────────────────────────────────────────────────────

interface SimEvent {
  label: string;
  edgeCase?: string;
  contact?: string;   // stored so recovery events can target same contact
  amount?: number;    // INR
  payload: object;
}

// ── Failure event builders ────────────────────────────────────────────────────

function makeSubscriptionFailed(opts: {
  declineCode: string;
  amount: number;
  riskScore?: number;
  isDisputed?: boolean;
  label: string;
  edgeCase?: string;
}): SimEvent {
  const customer = pick(CUSTOMERS);
  return {
    label: opts.label,
    edgeCase: opts.edgeCase,
    contact: customer.phone,
    amount: opts.amount,
    payload: {
      entity: 'event',
      account_id: pick(MERCHANTS),
      event: 'subscription.charged.failed',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            amount: opts.amount * 100,
            currency: 'INR',
            status: 'failed',
            error_code: opts.declineCode,
            error_description: `Payment failed with code ${opts.declineCode}`,
            contact: customer.phone,
            email: customer.email,
          },
        },
      },
      _vasooli: {
        eventType: 'SUBSCRIPTION_FAILED',
        customerName: customer.name,
        merchantId: pick(MERCHANTS),
        riskScore: opts.riskScore ?? randFloat(10, 65),
        isDisputed: opts.isDisputed ?? false,
      },
    },
  };
}

function makeCheckoutAbandoned(funnelStep: string, amount: number, label: string): SimEvent {
  const customer = pick(CUSTOMERS);
  return {
    label,
    contact: customer.phone,
    amount,
    payload: {
      entity: 'event',
      account_id: pick(MERCHANTS),
      event: 'checkout.abandoned',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now().toString(36)}`,
            amount: amount * 100,
            currency: 'INR',
            status: 'created',
            contact: customer.phone,
            email: customer.email,
          },
        },
      },
      _vasooli: {
        eventType: 'CHECKOUT_ABANDONED',
        customerName: customer.name,
        merchantId: pick(MERCHANTS),
        funnelStep,
        riskScore: randFloat(5, 40),
      },
    },
  };
}

function makeB2BInvoice(opts: {
  daysOverdue: number;
  amount: number;          // ← FIX: now required and passed to _vasooli
  isDisputed?: boolean;
  label: string;
  edgeCase?: string;
}): SimEvent {
  const customer = pick(CUSTOMERS);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() - opts.daysOverdue);
  return {
    label: opts.label,
    edgeCase: opts.edgeCase,
    contact: customer.phone,
    amount: opts.amount,
    payload: {
      entity: 'event',
      account_id: pick(MERCHANTS),
      event: 'invoice.overdue',
      contains: [],
      payload: {},      // B2B invoices have no payment entity in Razorpay
      _vasooli: {
        eventType: 'B2B_INVOICE_OVERDUE',
        customerName: customer.name,
        merchantId: pick(MERCHANTS),
        invoiceDueDate: dueDate.toISOString(),
        isDisputed: opts.isDisputed ?? false,
        riskScore: randFloat(5, 50),
        // ← FIX: pass amount explicitly so webhook handler picks it up
        amountAtRisk: opts.amount,
      },
    },
  };
}

// ── Batch builder ─────────────────────────────────────────────────────────────

interface SimBatch {
  failures: SimEvent[];
  recoveryContacts: Array<{ contact: string; amount: number; label: string }>;
}

function buildBatch(): SimBatch {
  const failures: SimEvent[] = [];
  // Track contacts+amounts from events that are likely to be "recovered"
  // (i.e. not frozen/disputed — these are the ones where we send reminders)
  const recoverableEvents: SimEvent[] = [];

  const push = (e: SimEvent, recoverable = true) => {
    failures.push(e);
    if (recoverable && e.contact && e.amount) recoverableEvents.push(e);
  };

  // ── SUBSCRIPTION_FAILED: NPCI U16 ─────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    push(makeSubscriptionFailed({
      declineCode: 'U16', amount: rand(2000, 50000),
      label: `NPCI U16 mandate failure #${i + 1}`,
    }));
  }

  // EDGE: Risk Score 95 → HARD FREEZE (not recoverable via automation)
  push(makeSubscriptionFailed({
    declineCode: 'U16', amount: 124000, riskScore: 95,
    label: '🚨 EDGE: Risk Score 95 — hard-freeze triggered',
    edgeCase: 'RISK_SCORE_FREEZE',
  }), false); // not recoverable through automation

  // ── SUBSCRIPTION_FAILED: NPCI RB ──────────────────────────────────────────
  for (let i = 0; i < 7; i++) {
    push(makeSubscriptionFailed({
      declineCode: 'RB', amount: rand(1500, 30000),
      label: `NPCI RB mandate failure #${i + 1}`,
    }));
  }

  // ── SUBSCRIPTION_FAILED: Card 54 Expired ──────────────────────────────────
  for (let i = 0; i < 5; i++) {
    push(makeSubscriptionFailed({
      declineCode: '54', amount: rand(5000, 80000),
      label: `Expired card (54) #${i + 1}`,
    }));
  }

  // ── SUBSCRIPTION_FAILED: Card 43 Stolen ───────────────────────────────────
  for (let i = 0; i < 4; i++) {
    push(makeSubscriptionFailed({
      declineCode: '43', amount: rand(3000, 40000),
      label: `Stolen/lost card (43) #${i + 1}`,
    }));
  }

  // EDGE: Disputed subscription → HARD FREEZE
  push(makeSubscriptionFailed({
    declineCode: 'U16', amount: 75000, isDisputed: true,
    label: '🚨 EDGE: Disputed flag — hard-freeze triggered',
    edgeCase: 'DISPUTE_FREEZE',
  }), false);

  // ── B2B Tier 1 (1–15 days) ────────────────────────────────────────────────
  for (let i = 0; i < 12; i++) {
    const days = rand(1, 15);
    push(makeB2BInvoice({
      daysOverdue: days, amount: rand(25000, 500000),
      label: `B2B Tier 1 overdue (${days}d) #${i + 1}`,
    }));
  }

  // ── B2B Tier 2 (16–30 days) ───────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    const days = rand(16, 30);
    push(makeB2BInvoice({
      daysOverdue: days, amount: rand(50000, 800000),
      label: `B2B Tier 2 overdue (${days}d) — Hinglish nudge #${i + 1}`,
    }));
  }

  // ── B2B Tier 3 (>30 days) — human handoff ─────────────────────────────────
  for (let i = 0; i < 5; i++) {
    push(makeB2BInvoice({
      daysOverdue: rand(31, 90), amount: rand(100000, 2000000),
      label: `B2B Tier 3 (>30d) #${i + 1} — escalated to human`,
    }), false); // human will handle manually
  }

  // EDGE: Disputed B2B
  push(makeB2BInvoice({
    daysOverdue: 22, amount: 350000, isDisputed: true,
    label: '🚨 EDGE: Disputed B2B invoice — hard-freeze',
    edgeCase: 'B2B_DISPUTE_FREEZE',
  }), false);

  // EDGE: B2B with PTP
  push(makeB2BInvoice({
    daysOverdue: 18, amount: 245000,
    label: '📅 EDGE: B2B prior PTP — reminders paused',
    edgeCase: 'PTP_ACTIVE_BLOCK',
  }), false);

  // ── CHECKOUT_ABANDONED: OTP timeout ───────────────────────────────────────
  for (let i = 0; i < 18; i++) {
    push(makeCheckoutAbandoned(
      'step_otp_timeout', rand(500, 15000),
      `OTP timeout abandonment #${i + 1}`,
    ));
  }

  // ── CHECKOUT_ABANDONED: Other funnel steps ────────────────────────────────
  const funnelSteps = ['step_address', 'step_card_entry', 'step_upi_pin', 'step_emi_selection'];
  for (let i = 0; i < 7; i++) {
    const step = pick(funnelSteps);
    push(makeCheckoutAbandoned(
      step, rand(300, 8000),
      `Checkout drop (${step}) #${i + 1}`,
    ));
  }

  // ── Recovery: pick ~30% of recoverable events ─────────────────────────────
  // Shuffle and take 30% to simulate realistic recovery rate
  const shuffled = [...recoverableEvents].sort(() => Math.random() - 0.5);
  const toRecover = shuffled.slice(0, Math.round(shuffled.length * 0.32));

  const recoveryContacts = toRecover.map((e, i) => ({
    contact: e.contact!,
    amount: e.amount!,
    label: `✅ Recovery #${i + 1} — ${e.label.slice(0, 40)}`,
  }));

  return { failures, recoveryContacts };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes('--dry-run');
const isFailuresOnly = process.argv.includes('--failures-only');
const countArg = process.argv.find((a) => a.startsWith('--count='));
const maxCount = countArg ? parseInt(countArg.split('=')[1], 10) : undefined;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fireFailure(event: SimEvent, index: number, total: number) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event.payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);

  const data = await res.json() as {
    verdict: { allowed: boolean; action: string | null; freeze: boolean; reason: string };
  };
  const { allowed, action, freeze } = data.verdict;

  const n = `[${String(index + 1).padStart(3)}/${total}]`;
  const v = freeze ? '🛑 FROZEN   ' : allowed ? `✓ ${(action ?? 'OK').padEnd(26)}` : '🛡 BLOCKED  ';
  const edge = event.edgeCase ? ` ← ${event.edgeCase}` : '';
  const amt = event.amount ? ` ₹${event.amount.toLocaleString('en-IN')}` : '';
  console.log(`${n} ${v} |${amt.padStart(12)} | ${event.label.slice(0, 42)}${edge}`);

  return { allowed, action, freeze };
}

async function fireCapture(contact: string, amount: number, label: string, index: number, total: number) {
  const res = await fetch(CAPTURE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity: 'event',
      account_id: 'acc_sim_recovery',
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: `pay_captured_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`,
            amount: amount * 100,  // paise
            currency: 'INR',
            status: 'captured',
            contact,
          },
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json() as { matched: boolean; rupeesRecovered?: number };

  const n = `[${String(index + 1).padStart(3)}/${total}]`;
  const recovered = data.matched ? `₹${amount.toLocaleString('en-IN')} recovered` : 'no match';
  console.log(`${n} 💰 CAPTURED  | ${recovered.padStart(20)} | ${label.slice(0, 42)}`);
  return data;
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║      Vasooli — Revenue Recovery Demo Simulation              ║');
  console.log('║      Razorpay AI Buildathon 2026                             ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const { failures: allFailures, recoveryContacts } = buildBatch();
  const failures = maxCount ? allFailures.slice(0, maxCount) : allFailures;

  console.log(`Target:     ${WEBHOOK_URL}`);
  console.log(`Failures:   ${failures.length} events`);
  if (!isFailuresOnly) console.log(`Recoveries: ${recoveryContacts.length} payment.captured events (~30% recovery rate)`);
  console.log(`Delay:      ${DELAY_MS}ms between events\n`);

  if (isDryRun) {
    console.log('── FAILURE EVENTS ──');
    failures.forEach((e, i) =>
      console.log(`  [${String(i+1).padStart(3)}] ${e.label}${e.edgeCase ? ` [${e.edgeCase}]` : ''}`)
    );
    if (!isFailuresOnly) {
      console.log('\n── RECOVERY EVENTS ──');
      recoveryContacts.forEach((r, i) =>
        console.log(`  [${String(i+1).padStart(3)}] ${r.label} — ₹${r.amount.toLocaleString('en-IN')}`)
      );
    }
    console.log('\nRun without --dry-run to fire against the dev server.');
    return;
  }

  // Health check
  try {
    const health = await fetch(`${BASE_URL}/api/metrics`);
    if (!health.ok) throw new Error(`Server returned ${health.status}`);
    console.log(`✓ Server reachable at ${BASE_URL}\n`);
  } catch {
    console.error(`✗ Cannot reach server at ${BASE_URL}`);
    console.error('  Make sure "npm run dev" is running first.\n');
    process.exit(1);
  }

  // ── Phase 1: Fire all failure events ──────────────────────────────────────
  console.log('━━━ PHASE 1: Revenue Loss Events ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  let allowed = 0, blocked = 0, frozen = 0, errors = 0;
  const actionCounts: Record<string, number> = {};

  for (let i = 0; i < failures.length; i++) {
    try {
      const result = await fireFailure(failures[i], i, failures.length);
      if (result.freeze) frozen++;
      else if (result.allowed) {
        allowed++;
        if (result.action) actionCounts[result.action] = (actionCounts[result.action] ?? 0) + 1;
      } else blocked++;
    } catch (err) {
      errors++;
      console.error(`  ✗ Event ${i + 1}: ${(err as Error).message}`);
    }
    await sleep(DELAY_MS);
  }

  if (isFailuresOnly) {
    printSummary(failures.length, allowed, blocked, frozen, errors, actionCounts, 0, 0);
    return;
  }

  // ── Phase 2: Simulate recoveries (after 2s pause for worker to process) ───
  console.log('\n━━━ PHASE 2: Recovery Confirmations (payment.captured) ━━━━━━━━━\n');
  console.log('  ⏳ Waiting 2s for worker to dispatch recovery nudges...\n');
  await sleep(2000);

  let totalRecovered = 0;
  let captureErrors = 0;

  for (let i = 0; i < recoveryContacts.length; i++) {
    const { contact, amount, label } = recoveryContacts[i];
    try {
      const result = await fireCapture(contact, amount, label, i, recoveryContacts.length);
      if (result.matched) totalRecovered += amount;
    } catch (err) {
      captureErrors++;
      console.error(`  ✗ Capture ${i + 1}: ${(err as Error).message}`);
    }
    await sleep(DELAY_MS);
  }

  printSummary(failures.length, allowed, blocked, frozen, errors, actionCounts, totalRecovered, captureErrors);
}

function printSummary(
  total: number, allowed: number, blocked: number, frozen: number, errors: number,
  actionCounts: Record<string, number>, totalRecovered: number, captureErrors: number,
) {
  const atRiskEstimate = 0; // server tracks this, we print directional stats

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                   SIMULATION COMPLETE                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
  console.log(`Total Events:      ${total}`);
  console.log(`✓ Actions Fired:   ${allowed}  (${pct(allowed, total)}%)`);
  console.log(`🛡 Blocked:         ${blocked}  (${pct(blocked, total)}%)`);
  console.log(`🛑 Frozen:          ${frozen}  (${pct(frozen, total)}%)`);
  if (errors > 0) console.log(`✗ Errors:          ${errors}`);

  if (totalRecovered > 0) {
    console.log(`\n💰 Total Recovered: ₹${totalRecovered.toLocaleString('en-IN')}`);
    console.log(`   Recovery Rate:   ~${pct(totalRecovered > 0 ? 1 : 0, 1)}% (see dashboard for exact)`);
    if (captureErrors > 0) console.log(`   Capture Errors:  ${captureErrors}`);
  }

  if (Object.keys(actionCounts).length > 0) {
    console.log('\nActions Dispatched:');
    Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([action, count]) => {
        console.log(`  ${action.replace(/_/g, ' ').padEnd(32)} ${count}`);
      });
  }

  console.log(`\n→ Open ${BASE_URL} to see live results in the Ops Dashboard`);
  console.log(`→ Click any row to open the AI Audit Trail drawer\n`);
}

function pct(n: number, total: number) {
  return total > 0 ? Math.round(n / total * 100) : 0;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
