'use client';

// ─────────────────────────────────────────────────────────────────────────────
// VerdictBadge — Left Brain Policy Verdict Display Component
//
// Renders a colour-coded badge showing the outcome of the deterministic
// policy engine evaluation for a given event.
// ─────────────────────────────────────────────────────────────────────────────

interface VerdictBadgeProps {
  policyPassed: boolean;
  actionTaken: string | null;
  escalate?: boolean;
}

const ACTION_LABELS: Record<string, string> = {
  RETRY_SCHEDULED: '🔁 Retry Scheduled',
  SEND_UPDATE_LINK: '🔗 Update Link',
  SEND_OTP_NUDGE: '📱 OTP Nudge',
  SEND_FORMAL_REMINDER: '📧 Formal Reminder',
  SEND_CONVERSATIONAL_NUDGE: '💬 Hinglish Nudge',
  HUMAN_HANDOFF: '👤 Human Handoff',
  FREEZE_MANDATE: '🛑 Mandate Frozen',
  ARCHIVE_EVENT: '📦 Archived',
};

export default function VerdictBadge({ policyPassed, actionTaken, escalate }: VerdictBadgeProps) {
  if (!policyPassed) {
    if (escalate) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-950 text-red-400 border border-red-800 whitespace-nowrap">
          🚨 Escalated
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-900 text-zinc-400 border border-zinc-700 whitespace-nowrap">
        🛡 Blocked
      </span>
    );
  }

  if (actionTaken === 'HUMAN_HANDOFF') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-950 text-orange-400 border border-orange-800 whitespace-nowrap">
        👤 Human Handoff
      </span>
    );
  }

  if (actionTaken === 'FREEZE_MANDATE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-950 text-red-400 border border-red-800 whitespace-nowrap">
        🛑 Mandate Frozen
      </span>
    );
  }

  const label = actionTaken ? (ACTION_LABELS[actionTaken] ?? actionTaken) : '✓ Allowed';

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800 whitespace-nowrap">
      {label}
    </span>
  );
}

