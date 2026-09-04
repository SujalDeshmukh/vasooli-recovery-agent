// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Ops Dashboard (Root Page)
//
// Server Component: fetches initial metrics server-side for instant paint.
// Client EventTable then takes over with SWR live polling (5s refresh).
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense } from 'react';
import EventTable from '@/components/dashboard/EventTable';

// ── Server-side initial data fetch ───────────────────────────────────────────
async function getInitialMetrics() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${baseUrl}/api/metrics`, {
      next: { revalidate: 5 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Header ────────────────────────────────────────────────────────────────────
function Header() {
  return (
    <header className="border-b border-surface-border bg-surface-card/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-brand-500 text-white font-bold text-lg select-none">
            V
          </div>
          <div>
            <h1 className="text-base font-semibold text-zinc-100 leading-tight">Vasooli</h1>
            <p className="text-xs text-zinc-500">Autonomous Revenue Recovery Engine</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Architecture Tag */}
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border border-surface-border bg-surface text-xs text-zinc-500">
            <span className="w-2 h-2 rounded-full bg-blue-500" title="Left Brain — Policy" />
            <span>Left Brain</span>
            <span className="w-px h-3 bg-zinc-700 mx-1" />
            <span className="w-2 h-2 rounded-full bg-violet-500" title="Right Brain — LLM" />
            <span>Right Brain</span>
          </div>

          {/* Live indicator */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live
          </div>

          {/* Razorpay AI Buildathon badge */}
          <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full bg-brand-500/10 border border-brand-500/30 text-brand-500 text-xs font-medium">
            Razorpay AI Buildathon
          </span>
        </div>
      </div>
    </header>
  );
}

// ── Architecture Callout ──────────────────────────────────────────────────────
function ArchitectureCallout() {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-card p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="flex gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 text-sm">
          🧠
        </div>
        <div>
          <p className="text-sm font-semibold text-zinc-200">Left Brain — Deterministic Policy Engine</p>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            Pure mathematical guardrails: NPCI retry caps, dispute freezes, risk score thresholds, PTP
            state machine. Zero LLM calls. Synchronous, auditable, RBI-compliant.
          </p>
        </div>
      </div>
      <div className="flex gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-violet-400 text-sm">
          💬
        </div>
        <div>
          <p className="text-sm font-semibold text-zinc-200">Right Brain — LLM Reasoning Engine</p>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
            Contextual Hinglish communication, Promise-to-Pay extraction, root-cause diagnosis, and
            tone adaptation. Only fires after Left Brain approval. (Phase 2)
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Status Legend ─────────────────────────────────────────────────────────────
function StatusLegend() {
  const statuses = [
    { label: 'Detected', color: 'bg-zinc-500', desc: 'Ingested, not yet evaluated' },
    { label: 'In Recovery', color: 'bg-amber-500', desc: 'Action dispatched to queue' },
    { label: 'PTP Active', color: 'bg-violet-500', desc: 'Promise-to-Pay logged' },
    { label: 'Recovered', color: 'bg-emerald-500', desc: 'Payment received' },
    { label: 'Escalated', color: 'bg-red-500', desc: 'Routed to human AM' },
    { label: 'Abandoned', color: 'bg-zinc-700', desc: 'Archived, no further action' },
  ];

  return (
    <div className="flex flex-wrap gap-3">
      {statuses.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5" title={s.desc}>
          <span className={`w-2 h-2 rounded-full ${s.color}`} />
          <span className="text-xs text-zinc-500">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function DashboardPage() {
  await getInitialMetrics(); // Warm the server-side cache

  return (
    <div className="min-h-screen bg-surface">
      <Header />

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Page Title */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">Revenue Recovery Operations</h2>
            <p className="text-sm text-zinc-500 mt-1">
              Real-time view of all revenue-at-risk events and Left Brain policy decisions.
            </p>
          </div>
          <StatusLegend />
        </div>

        {/* Architecture callout */}
        <ArchitectureCallout />

        {/* Live Event Table (Client Component with SWR) */}
        <Suspense
          fallback={
            <div className="space-y-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-24 rounded-xl bg-surface-card border border-surface-border animate-pulse" />
              ))}
            </div>
          }
        >
          <EventTable />
        </Suspense>

        {/* Footer */}
        <footer className="text-center text-xs text-zinc-700 pb-4">
          Vasooli © 2026 — Built for the Razorpay AI Buildathon &middot; Dual-Brain Architecture
        </footer>
      </main>
    </div>
  );
}

