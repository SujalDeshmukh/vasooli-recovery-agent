'use client';

import { useState } from 'react';
import useSWR from 'swr';
import VerdictBadge from './VerdictBadge';
import MetricsBar from './MetricsBar';
import AuditDrawer from './AuditDrawer';
import type { MetricsResponse, RecentEventRow } from '@/lib/engine/types';

const fetcher = (url: string) => fetch(url).then((r) => r.json()) as Promise<MetricsResponse>;

const EVENT_TYPE_LABELS: Record<string, string> = {
  SUBSCRIPTION_FAILED: '🔴 Mandate',
  CHECKOUT_ABANDONED: '🛒 Checkout',
  B2B_INVOICE_OVERDUE: '📄 B2B Invoice',
};

const STATUS_COLORS: Record<string, string> = {
  DETECTED: 'text-zinc-400',
  IN_RECOVERY: 'text-amber-400',
  PTP_ACTIVE: 'text-violet-400',
  RECOVERED: 'text-emerald-400',
  ESCALATED_HUMAN: 'text-red-400',
  ABANDONED: 'text-zinc-600',
};

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    DETECTED: 'bg-zinc-500',
    IN_RECOVERY: 'bg-amber-500 animate-pulse-slow',
    PTP_ACTIVE: 'bg-violet-500 animate-pulse-slow',
    RECOVERED: 'bg-emerald-500',
    ESCALATED_HUMAN: 'bg-red-500',
    ABANDONED: 'bg-zinc-700',
  };
  return <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${colors[status] ?? 'bg-zinc-500'}`} />;
}

function formatINR(n: number) {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function EventRow({
  event,
  index,
  onSelect,
}: {
  event: RecentEventRow;
  index: number;
  onSelect: (id: string) => void;
}) {
  const verdict = event.latestVerdict;
  const isHighRisk = (event.riskScore ?? 0) > 80;

  return (
    <tr
      className={`border-b border-surface-border transition-colors cursor-pointer hover:bg-zinc-800/60 animate-fade-in ${
        isHighRisk ? 'bg-red-950/10' : ''
      }`}
      style={{ animationDelay: `${index * 30}ms` }}
      onClick={() => onSelect(event.id)}
      title="Click to view audit trail"
    >
      <td className="px-4 py-3 font-mono text-xs text-zinc-500 whitespace-nowrap">
        {event.id.substring(0, 8)}…
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap">
        {EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}
      </td>
      <td className="px-4 py-3 text-sm font-semibold tabular-nums whitespace-nowrap">
        {formatINR(event.amountAtRisk)}
      </td>
      <td className="px-4 py-3 text-sm max-w-[140px] truncate" title={event.customerName}>
        {event.customerName}
      </td>
      <td className="px-4 py-3 text-xs">
        {event.declineCode ? (
          <code className="px-1.5 py-0.5 bg-zinc-800 rounded text-amber-400 font-mono">
            {event.declineCode}
          </code>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs whitespace-nowrap">
        {event.riskScore !== null && event.riskScore !== undefined ? (
          <span className={`font-semibold ${event.riskScore > 80 ? 'text-red-400' : event.riskScore > 50 ? 'text-amber-400' : 'text-zinc-400'}`}>
            {event.riskScore > 80 && '🚨 '}{event.riskScore.toFixed(0)}
          </span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-center">
        {event.isDisputed ? (
          <span className="text-red-400 text-sm" title="Disputed — Hard Freeze Active">⚠</span>
        ) : (
          <span className="text-zinc-700">—</span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        {verdict ? (
          <VerdictBadge
            policyPassed={verdict.policyPassed}
            actionTaken={verdict.actionTaken}
            escalate={verdict.actionTaken === 'HUMAN_HANDOFF'}
          />
        ) : (
          <span className="text-zinc-600 text-xs">Pending</span>
        )}
      </td>
      <td className={`px-4 py-3 text-xs font-medium whitespace-nowrap ${STATUS_COLORS[event.status] ?? 'text-zinc-400'}`}>
        <StatusDot status={event.status} />
        {event.status.replace(/_/g, ' ')}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500 max-w-[200px] truncate" title={verdict?.diagnosedReason ?? ''}>
        {verdict?.diagnosedReason ?? '—'}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-600 whitespace-nowrap">
        {timeAgo(event.createdAt)}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
          🔍 Audit
        </span>
      </td>
    </tr>
  );
}

export default function EventTable() {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const { data, error, isLoading } = useSWR<MetricsResponse>('/api/metrics', fetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
  });

  if (error) {
    return (
      <div className="rounded-xl border border-red-900 bg-red-950/20 p-6 text-center text-red-400 text-sm">
        ⚠ Failed to load metrics: {(error as Error).message ?? 'Unknown error'}
      </div>
    );
  }

  return (
    <>
      {/* Audit Drawer */}
      <AuditDrawer
        eventId={selectedEventId}
        onClose={() => setSelectedEventId(null)}
      />

      <div className="space-y-6">
        {/* Live Metrics Bar */}
        {data && <MetricsBar metrics={data} />}
        {isLoading && !data && (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-24 rounded-xl bg-surface-card border border-surface-border animate-pulse" />
            ))}
          </div>
        )}

        {/* Event Table */}
        <div className="rounded-xl border border-surface-border bg-surface-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-200">Live Recovery Events</h2>
              <span className="flex items-center gap-1 text-xs text-zinc-500">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
                Auto-refreshing every 5s
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-600 hidden sm:block">
                Click any row to view audit trail
              </span>
              <span className="text-xs text-zinc-600">
                {data?.recentEvents.length ?? 0} events
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1200px] text-left">
              <thead>
                <tr className="border-b border-surface-border bg-zinc-900/40">
                  {['Event ID', 'Type', 'At-Risk', 'Customer', 'Code', 'Risk', 'Dispute',
                    '🧠 Left Brain Verdict', 'Status', 'Policy Reason', 'Time', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading && !data &&
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-surface-border">
                      {Array.from({ length: 12 }).map((_, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 rounded bg-zinc-800 animate-pulse" style={{ width: `${40 + ((i * 17 + j * 23) % 60)}%` }} />
                        </td>
                      ))}
                    </tr>
                  ))}

                {data?.recentEvents.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-4 py-12 text-center text-zinc-600 text-sm">
                      No events yet. Run{' '}
                      <code className="font-mono text-xs bg-zinc-800 px-1.5 py-0.5 rounded">
                        npx tsx scripts/simulate.ts
                      </code>{' '}
                      to generate 100 synthetic events.
                    </td>
                  </tr>
                )}

                {data?.recentEvents.map((event, i) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    index={i}
                    onSelect={setSelectedEventId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
