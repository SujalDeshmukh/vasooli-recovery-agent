// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Metrics API
// GET /api/metrics
//
// Returns aggregate financial metrics and recent event rows for the Ops Dashboard.
// Cached for 5 seconds at the Next.js layer to prevent DB hammering during demos.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { MetricsResponse, RecentEventRow } from '@/lib/engine/types';
import type { EventStatus } from '@prisma/client';

export const revalidate = 5; // Next.js ISR: revalidate every 5 seconds

const ALL_STATUSES: EventStatus[] = [
  'DETECTED',
  'IN_RECOVERY',
  'PTP_ACTIVE',
  'RECOVERED',
  'ESCALATED_HUMAN',
  'ABANDONED',
];

export async function GET(): Promise<NextResponse<MetricsResponse | { error: string }>> {
  try {
    // ── Aggregate financial metrics ─────────────────────────────────────────
    // Run all queries in parallel for speed
    const [atRiskResult, recoveredResult, costResult, statusCounts, recentEventRows] =
      await Promise.all([
        // Total amount at risk: sum of all non-terminal events
        prisma.revenueEvent.aggregate({
          _sum: { amountAtRisk: true },
          where: {
            status: { in: ['DETECTED', 'IN_RECOVERY', 'PTP_ACTIVE', 'ESCALATED_HUMAN'] },
          },
        }),

        // Total amount recovered: sum of AuditLog.rupeesRecovered
        prisma.auditLog.aggregate({
          _sum: { rupeesRecovered: true },
        }),

        // Total cost incurred: LLM tokens + messaging + gateway fees
        prisma.auditLog.aggregate({
          _sum: { costIncurred: true },
        }),

        // Event count by status
        prisma.revenueEvent.groupBy({
          by: ['status'],
          _count: { id: true },
        }),

        // Recent 50 events with their latest audit log entry
        prisma.revenueEvent.findMany({
          take: 50,
          orderBy: { createdAt: 'desc' },
          include: {
            auditLogs: {
              orderBy: { timestamp: 'desc' },
              take: 1,
            },
          },
        }),
      ]);

    const totalAtRisk = atRiskResult._sum.amountAtRisk ?? 0;
    const totalRecovered = recoveredResult._sum.rupeesRecovered ?? 0;
    const totalCostIncurred = costResult._sum.costIncurred ?? 0;
    const netValueCreated = totalRecovered - totalCostIncurred;
    const recoveryRate =
      totalAtRisk + totalRecovered > 0
        ? (totalRecovered / (totalAtRisk + totalRecovered)) * 100
        : 0;

    // Build status count map
    const eventCountsMap = Object.fromEntries(
      ALL_STATUSES.map((s) => [s, 0]),
    ) as Record<EventStatus, number>;
    for (const row of statusCounts) {
      eventCountsMap[row.status] = row._count.id;
    }

    // Shape recent events for the dashboard table
    const recentEvents: RecentEventRow[] = recentEventRows.map((e) => {
      const latestLog = e.auditLogs[0] ?? null;
      return {
        id: e.id,
        eventType: e.eventType,
        amountAtRisk: e.amountAtRisk,
        currency: e.currency,
        customerName: e.customerName,
        declineCode: e.declineCode,
        riskScore: e.riskScore,
        isDisputed: e.isDisputed,
        status: e.status,
        latestVerdict: latestLog
          ? {
              policyPassed: latestLog.policyPassed,
              diagnosedReason: latestLog.diagnosedReason,
              actionTaken: latestLog.actionTaken,
              stage: latestLog.stage,
              timestamp: latestLog.timestamp.toISOString(),
            }
          : null,
        createdAt: e.createdAt.toISOString(),
      };
    });

    const response: MetricsResponse = {
      totalAtRisk: Math.round(totalAtRisk * 100) / 100,
      totalRecovered: Math.round(totalRecovered * 100) / 100,
      recoveryRate: Math.round(recoveryRate * 10) / 10,
      totalCostIncurred: Math.round(totalCostIncurred * 100) / 100,
      netValueCreated: Math.round(netValueCreated * 100) / 100,
      eventCounts: eventCountsMap,
      recentEvents,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Metrics API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

