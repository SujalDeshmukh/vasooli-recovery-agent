// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Retry Scheduler
//
// Computes NPCI-compliant retry timestamps aligned to salary/settlement windows
// rather than naive +24h intervals, which:
//   1. Trigger bank spam-detection filters
//   2. Waste retries on days when accounts are empty
//   3. Incur avoidable gateway retry fees
//
// Strategy (Left Brain — deterministic, no LLM):
//   Retry 1 → T+1 at 08:00 IST  (next morning)
//   Retry 2 → T+3 at 08:00 IST  (short cadence for second attempt)
//   Retry 3 → Nearest salary window: 1st or 5th of month at 08:00 IST
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_HOUR_IST = 8;           // 08:00 AM IST
const IST_OFFSET_MS = 5.5 * 3600 * 1000; // IST = UTC + 05:30

/**
 * Converts a UTC Date object to an IST Date object.
 * Note: The returned Date still represents an absolute UTC instant, but its
 * local date/hour components reflect IST.
 */
export function toIST(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

/**
 * Returns a new Date set to 08:00:00.000 on the given date's calendar day.
 * Preserves the date's year/month/day; resets time components.
 */
export function atEightAMIST(date: Date): Date {
  const d = new Date(date);
  d.setHours(RETRY_HOUR_IST, 0, 0, 0);
  return d;
}

/**
 * Computes the next NPCI-compliant retry timestamp for a mandate/subscription failure.
 *
 * @param from         - The current date/time (UTC)
 * @param retryAttempt - 1-indexed attempt number (1 = first retry, max = 3)
 * @returns            - A Date object representing the scheduled retry time (IST midnight corrected)
 */
export function getNextSalaryWindowRetry(from: Date, retryAttempt: number): Date {
  const ist = toIST(from);
  const dayOfMonth = ist.getDate();

  if (retryAttempt === 1) {
    // T+1: next morning at 08:00 IST — most accounts refresh overnight
    const next = new Date(ist);
    next.setDate(next.getDate() + 1);
    return atEightAMIST(next);
  }

  if (retryAttempt === 2) {
    // T+3: allow a 3-day gap for salary credit or UPI AutoPay settlement
    const next = new Date(ist);
    next.setDate(next.getDate() + 3);
    return atEightAMIST(next);
  }

  // Retry 3: nearest canonical salary window (1st or 5th of month)
  // This is the "last chance" retry before mandate freeze.
  const next = new Date(ist);

  if (dayOfMonth < 1) {
    // Edge case: shouldn't happen, but guard it
    next.setDate(1);
  } else if (dayOfMonth < 5) {
    // We're between 1st and 5th — align to 5th
    next.setDate(5);
  } else {
    // We're past the 5th — push to 1st of next month
    next.setMonth(next.getMonth() + 1, 1);
  }

  return atEightAMIST(next);
}

/**
 * Returns the number of calendar days between two dates (positive = b > a).
 */
export function daysBetween(a: Date, b: Date): number {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Adds N business days (Mon–Fri) to a date. Useful for B2B invoice cooldown checks.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const result = new Date(from);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) {
      added++;
    }
  }
  return result;
}

/**
 * Counts the number of business days (Mon–Fri) between two dates.
 * Used by the policy engine to enforce the 5-business-day B2B reminder cooldown.
 */
export function countBusinessDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      count++;
    }
  }
  return count;
}

