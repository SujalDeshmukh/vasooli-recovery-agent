'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AuditDrawer — Slide-in Immutable Audit Trail Panel
//
// Shows the full chronological timeline for a single RevenueEvent, including:
//   • AuditLog entries (DIAGNOSIS → POLICY_EVALUATION → ACTION_DISPATCH → RECOVERY_OUTCOME)
//   • PromiseToPay records interleaved at creation timestamp
//   • Unit economics totals (cost, recovered, net value)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type { EventAuditResponse, AuditTimelineItem } from '@/app/api/events/[id]/audit/route';

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json()) as Promise<EventAuditResponse>;

// ── Stage config ──────────────────────────────────────────────────────────────

const STAGE_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  DIAGNOSIS: { label: 'Diagnosis', color: 'border-blue-500 bg-blue-500/10 text-blue-400', icon: '🔍' },
  POLICY_EVALUATION: { label: 'Policy Eval', color: 'border-violet-500 bg-violet-500/10 text-violet-400', icon: '🧠' },
  ACTION_DISPATCH: { label: 'Dispatched', color: 'border-amber-500 bg-amber-500/10 text-amber-400', icon: '⚡' },
  RECOVERY_OUTCOME: { label: 'Outcome', color: 'border-emerald-500 bg-emerald-500/10 text-emerald-400', icon: '✅' },
};

const ACTION_ICONS: Record<string, string> = {
  RETRY_SCHEDULED: '🔁', SEND_UPDATE_LINK: '🔗', SEND_OTP_NUDGE: '📱',
  SEND_FORMAL_REMINDER: '📧', SEND_CONVERSATIONAL_NUDGE: '💬',
  HUMAN_HANDOFF: '👤', FREEZE_MANDATE: '🛑', ARCHIVE_EVENT: '📦',
};

// ── Timeline Item ─────────────────────────────────────────────────────────────

function TimelineEntry({ item }: { item: AuditTimelineItem }) {
  const ts = new Date(item.timestamp);
  const timeStr = ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const dateStr = ts.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  if (item.kind === 'ptp') {
    const ptpColors = {
      PENDING: 'border-violet-500 bg-violet-500/10 text-violet-400',
      HONORED: 'border-emerald-500 bg-emerald-500/10 text-emerald-400',
      BREACHED: 'border-red-500 bg-red-500/10 text-red-400',
    };
    const ptpIcons = { PENDING: '📅', HONORED: '✅', BREACHED: '💔' };
    const status = item.ptpStatus ?? 'PENDING';
    return (
      <div className="flex gap-3 group">
        <div className="flex flex-col items-center">
          <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs ${ptpColors[status]}`}>
            {ptpIcons[status]}
          </div>
          <div className="w-px flex-1 bg-surface-border mt-1" />
        </div>
        <div className={`mb-4 flex-1 rounded-lg border p-3 ${ptpColors[status]}`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider">
              Promise-to-Pay — {status}
            </span>
            <span className="text-xs opacity-60">{dateStr} {timeStr}</span>
          </div>
          <p className="text-xs text-zinc-400 mb-1">
            ₹{(item.agreedAmount ?? 0).toLocaleString('en-IN')} by{' '}
            {item.promisedDate ? new Date(item.promisedDate).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'}
          </p>
          {item.extractedQuote && (
            <blockquote className="text-xs italic border-l-2 border-current pl-2 mt-1 opacity-70">
              "{item.extractedQuote}"
            </blockquote>
          )}
        </div>
      </div>
    );
  }

  const stage = item.stage ?? 'DIAGNOSIS';
  const cfg = STAGE_CONFIG[stage] ?? STAGE_CONFIG.DIAGNOSIS;
  const hasCost = (item.costIncurred ?? 0) > 0;
  const hasRecovery = (item.rupeesRecovered ?? 0) > 0;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs ${cfg.color}`}>
          {cfg.icon}
        </div>
        <div className="w-px flex-1 bg-surface-border mt-1" />
      </div>
      <div className="mb-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${cfg.color}`}>
            {cfg.label}
          </span>
          {item.actionTaken && (
            <span className="text-xs text-zinc-400">
              {ACTION_ICONS[item.actionTaken] ?? '→'} {item.actionTaken.replace(/_/g, ' ')}
            </span>
          )}
          {!item.policyPassed && (
            <span className="text-xs text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">
              🛡 BLOCKED
            </span>
          )}
          <span className="ml-auto text-xs text-zinc-600 whitespace-nowrap">
            {dateStr} {timeStr}
          </span>
        </div>

        <p className="text-xs text-zinc-400 leading-relaxed mb-1.5 whitespace-pre-wrap">
          {item.diagnosedReason}
        </p>

        {(() => {
          try {
            if (item.actionTaken === 'SEND_CONVERSATIONAL_NUDGE' && item.rawReasoning) {
              const parsed = typeof item.rawReasoning === 'string' 
                ? JSON.parse(item.rawReasoning) 
                : (item.rawReasoning as any);
                
              if (parsed && parsed.generatedText) {
                return (
                  <div className="mb-2">
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        if (!window.speechSynthesis) return;
                        window.speechSynthesis.cancel();
                        const utterance = new SpeechSynthesisUtterance(parsed.generatedText.replace(/\[PAYMENT_LINK\]/g, ''));
                        const voices = window.speechSynthesis.getVoices();
                        const indianVoice = voices.find((v: SpeechSynthesisVoice) => v.lang === 'hi-IN' || v.lang === 'en-IN');
                        if (indianVoice) utterance.voice = indianVoice;
                        window.speechSynthesis.speak(utterance);
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800 hover:bg-emerald-500/20 text-emerald-400 hover:text-emerald-300 text-xs font-semibold rounded transition-colors border border-emerald-500/30"
                      title="Play AI Voice"
                    >
                      <span>▶</span> Play Voice (TTS)
                    </button>
                  </div>
                );
              }
            }
          } catch {}
          return null;
        })()}

        {(hasCost || hasRecovery) && (
          <div className="flex gap-3 text-xs">
            {hasCost && (
              <span className="text-red-400">
                Cost: ₹{(item.costIncurred ?? 0).toFixed(2)}
              </span>
            )}
            {hasRecovery && (
              <span className="text-emerald-400 font-semibold">
                Recovered: ₹{(item.rupeesRecovered ?? 0).toLocaleString('en-IN')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface AuditDrawerProps {
  eventId: string | null;
  onClose: () => void;
}

export default function AuditDrawer({ eventId, onClose }: AuditDrawerProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [replyText, setReplyText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { data, isLoading, error, mutate } = useSWR<EventAuditResponse>(
    eventId ? `/api/events/${eventId}/audit` : null,
    fetcher,
    { refreshInterval: 5000 },
  );

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Close on overlay click
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleSimulateReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || !data?.event) return;
    setIsSubmitting(true);
    try {
      const phone = data.event.customerContact.replace('+', '');
      const payload = {
        object: "whatsapp_business_account",
        entry: [{
          id: "sim_entry",
          changes: [{
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "91000000000", phone_number_id: "sim" },
              messages: [{
                from: phone,
                id: `msg_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: "text",
                text: { body: replyText }
              }]
            }
          }]
        }]
      };

      await fetch('/api/webhooks/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setReplyText('');
      
      // Wait for the background webhook (Gemini LLM) to process the text before refreshing
      await new Promise(r => setTimeout(r, 2500));
      void mutate(); // refresh the trail
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!eventId) return null;

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end"
    >
      <div className="w-full max-w-xl bg-surface-card border-l border-surface-border h-full flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex-none bg-surface-card border-b border-surface-border px-5 py-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Immutable Audit Trail</h3>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">{eventId.slice(0, 16)}…</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Event Summary */}
        {data?.event && (
          <div className="flex-none px-5 py-4 border-b border-surface-border bg-zinc-900/40">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-zinc-600">Customer</span>
                <p className="text-zinc-200 font-medium mt-0.5">{data.event.customerName}</p>
              </div>
              <div>
                <span className="text-zinc-600">Amount At-Risk</span>
                <p className="text-amber-400 font-semibold mt-0.5">
                  ₹{data.event.amountAtRisk.toLocaleString('en-IN')}
                </p>
              </div>
              <div>
                <span className="text-zinc-600">Status</span>
                <p className="text-zinc-200 mt-0.5">{data.event.status}</p>
              </div>
              <div>
                <span className="text-zinc-600">Type</span>
                <p className="text-zinc-200 mt-0.5">{data.event.eventType.replace(/_/g, ' ')}</p>
              </div>
            </div>

            {/* Unit Economics */}
            {data.totals && (
              <div className="mt-3 pt-3 border-t border-surface-border grid grid-cols-3 gap-2 text-xs text-center">
                <div>
                  <p className="text-zinc-600">Cost Incurred</p>
                  <p className="text-red-400 font-semibold">₹{data.totals.totalCostIncurred.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-zinc-600">Recovered</p>
                  <p className="text-emerald-400 font-semibold">
                    ₹{data.totals.totalRecovered.toLocaleString('en-IN')}
                  </p>
                </div>
                <div>
                  <p className="text-zinc-600">Net Value</p>
                  <p className={`font-semibold ${data.totals.netValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ₹{data.totals.netValue.toLocaleString('en-IN')}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Timeline (Scrollable) */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-zinc-800 animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 rounded bg-zinc-800 animate-pulse w-1/3" />
                    <div className="h-3 rounded bg-zinc-800 animate-pulse w-full" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 text-center mt-8">
              Failed to load audit trail
            </p>
          )}

          {data?.timeline.length === 0 && (
            <p className="text-sm text-zinc-600 text-center mt-8">
              No audit entries yet for this event.
            </p>
          )}

          {data?.timeline.map((item) => (
            <TimelineEntry key={item.id} item={item} />
          ))}
        </div>

        {/* Interactive Simulator Footer */}
        {data?.event && data.event.status !== 'RECOVERED' && data.event.status !== 'ABANDONED' && (
          <div className="flex-none p-4 border-t border-surface-border bg-surface-card">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-400">💬 Simulate Customer Reply</span>
              <span className="text-[10px] text-zinc-500">Hits /api/webhooks/whatsapp</span>
            </div>
            <form onSubmit={handleSimulateReply} className="flex gap-2">
              <input
                type="text"
                placeholder="e.g., Bhai funds fass gaye hai, next friday pakka..."
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                disabled={isSubmitting}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={isSubmitting || !replyText.trim()}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
              >
                {isSubmitting ? '...' : 'Send'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
