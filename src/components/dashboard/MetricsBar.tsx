'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MetricsBar — Top-Level KPI Cards for the Ops Dashboard
// ─────────────────────────────────────────────────────────────────────────────

import type { MetricsResponse } from '@/lib/engine/types';

interface MetricsBarProps {
  metrics: MetricsResponse;
}

function formatINR(amount: number): string {
  if (amount >= 10_00_000) {
    return `₹${(amount / 10_00_000).toFixed(2)}L`;
  }
  if (amount >= 1_000) {
    return `₹${(amount / 1_000).toFixed(1)}K`;
  }
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

interface KPICardProps {
  label: string;
  value: string;
  subtext?: string;
  colorClass?: string;
  pulse?: boolean;
}

function KPICard({ label, value, subtext, colorClass = 'text-white', pulse = false }: KPICardProps) {
  return (
    <div className="relative bg-surface-card rounded-xl border border-surface-border p-5 flex flex-col gap-1 overflow-hidden">
      {pulse && (
        <span className="absolute top-3 right-3 flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
        </span>
      )}
      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${colorClass}`}>{value}</span>
      {subtext && <span className="text-xs text-zinc-600 mt-0.5">{subtext}</span>}
    </div>
  );
}

export default function MetricsBar({ metrics }: MetricsBarProps) {
  const {
    totalAtRisk,
    totalRecovered,
    recoveryRate,
    totalCostIncurred,
    netValueCreated,
    eventCounts,
  } = metrics;

  const inRecovery =
    (eventCounts.IN_RECOVERY ?? 0) + (eventCounts.PTP_ACTIVE ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <KPICard
          label="₹ At-Risk"
          value={formatINR(totalAtRisk)}
          subtext={`${(eventCounts.DETECTED ?? 0) + inRecovery} active events`}
          colorClass="text-amber-400"
          pulse={inRecovery > 0}
        />
        <KPICard
          label="₹ Recovered"
          value={formatINR(totalRecovered)}
          subtext={`${eventCounts.RECOVERED ?? 0} events resolved`}
          colorClass="text-emerald-400"
        />
        <KPICard
          label="Recovery Rate"
          value={`${recoveryRate.toFixed(1)}%`}
          subtext="Gross recovery ratio"
          colorClass={
            recoveryRate >= 70 ? 'text-emerald-400' : recoveryRate >= 40 ? 'text-amber-400' : 'text-red-400'
          }
        />
        <KPICard
          label="Net Value Created"
          value={formatINR(netValueCreated)}
          subtext={`Cost: ${formatINR(totalCostIncurred)}`}
          colorClass={netValueCreated >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <KPICard
          label="Escalated / Frozen"
          value={String(eventCounts.ESCALATED_HUMAN ?? 0)}
          subtext="Human review queue"
          colorClass="text-red-400"
        />
        <KPICard
          label="PTP Active"
          value={String(eventCounts.PTP_ACTIVE ?? 0)}
          subtext="Promises in flight"
          colorClass="text-violet-400"
        />
      </div>

      {/* Visual Analytics: Event Distribution Pipeline */}
      {Object.values(eventCounts).reduce((a, b) => a + b, 0) > 0 && (
        <div className="bg-surface-card rounded-xl border border-surface-border p-5 flex flex-col gap-3">
          <div className="flex justify-between items-end">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Recovery Pipeline Distribution
            </span>
          </div>
          
          <div className="w-full h-3 rounded-full flex overflow-hidden bg-zinc-900 border border-zinc-800">
            {/* Emerald - Recovered */}
            <div 
              className="h-full bg-emerald-500 transition-all duration-1000" 
              style={{ width: `${((eventCounts.RECOVERED ?? 0) / (Object.values(eventCounts).reduce((a, b) => a + b, 0) || 1)) * 100}%` }} 
              title="Recovered"
            />
            {/* Violet - PTP */}
            <div 
              className="h-full bg-violet-500 transition-all duration-1000" 
              style={{ width: `${((eventCounts.PTP_ACTIVE ?? 0) / (Object.values(eventCounts).reduce((a, b) => a + b, 0) || 1)) * 100}%` }} 
              title="Promise to Pay"
            />
            {/* Amber - In Recovery/Detected */}
            <div 
              className="h-full bg-amber-500 transition-all duration-1000" 
              style={{ width: `${(((eventCounts.DETECTED ?? 0) + (eventCounts.IN_RECOVERY ?? 0)) / (Object.values(eventCounts).reduce((a, b) => a + b, 0) || 1)) * 100}%` }} 
              title="Active / In Recovery"
            />
            {/* Red - Escalated */}
            <div 
              className="h-full bg-red-500 transition-all duration-1000" 
              style={{ width: `${((eventCounts.ESCALATED_HUMAN ?? 0) / (Object.values(eventCounts).reduce((a, b) => a + b, 0) || 1)) * 100}%` }} 
              title="Escalated / Frozen"
            />
            {/* Zinc - Abandoned */}
            <div 
              className="h-full bg-zinc-600 transition-all duration-1000" 
              style={{ width: `${((eventCounts.ABANDONED ?? 0) / (Object.values(eventCounts).reduce((a, b) => a + b, 0) || 1)) * 100}%` }} 
              title="Abandoned"
            />
          </div>

          <div className="flex gap-4 text-[10px] text-zinc-500 font-medium flex-wrap">
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Recovered</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-violet-500" /> Promise to Pay</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500" /> Active Nudges</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" /> Escalated (Guardrails)</div>
            <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-zinc-600" /> Abandoned</div>
          </div>
        </div>
      )}
    </div>
  );
}
