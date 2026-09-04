// ─────────────────────────────────────────────────────────────────────────────
// Vasooli — Per-Event Audit Trail API
// GET /api/events/[id]/audit
//
// Returns the full immutable AuditLog for a single event, interleaved with
// PromiseToPay records, for rendering in the Ops Dashboard AuditDrawer.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// ── Response Types ────────────────────────────────────────────────────────────

export interface AuditTimelineItem {
  id: string;
  kind: 'audit' | 'ptp';
  timestamp: string;

  // Audit log fields
  stage?: string;
  diagnosedReason?: string;
  policyPassed?: boolean;
  actionTaken?: string | null;
  costIncurred?: number;
  rupeesRecovered?: number;
  rawReasoning?: Record<string, unknown>;

  // PTP fields
  ptpStatus?: 'PENDING' | 'HONORED' | 'BREACHED';
  promisedDate?: string;
  agreedAmount?: number;
  extractedQuote?: string;
}

export interface EventAuditResponse {
  event: {
    id: string;
    eventType: string;
    status: string;
    amountAtRisk: number;
    currency: string;
    customerName: string;
    customerContact: string;
    declineCode: string | null;
    riskScore: number | null;
    isDisputed: boolean;
    createdAt: string;
    updatedAt: string;
  };
  timeline: AuditTimelineItem[];
  totals: {
    totalCostIncurred: number;
    totalRecovered: number;
    netValue: number;
    actionCount: number;
  };
}

// ── Route Handler ─────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<EventAuditResponse | { error: string }>> {
  const { id } = await params;

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'Missing event ID' }, { status: 400 });
  }

  try {
    const [event, auditLogs, ptps] = await Promise.all([
      prisma.revenueEvent.findUnique({ where: { id } }),
      prisma.auditLog.findMany({
        where: { eventId: id },
        orderBy: { timestamp: 'asc' },
      }),
      prisma.promiseToPay.findMany({
        where: { eventId: id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Merge and sort audit logs + PTP records into a unified timeline
    const timelineItems: AuditTimelineItem[] = [
      ...auditLogs.map(
        (log): AuditTimelineItem => ({
          id: log.id,
          kind: 'audit',
          timestamp: log.timestamp.toISOString(),
          stage: log.stage,
          diagnosedReason: log.diagnosedReason,
          policyPassed: log.policyPassed,
          actionTaken: log.actionTaken,
          costIncurred: log.costIncurred,
          rupeesRecovered: log.rupeesRecovered,
          rawReasoning: safeParseJSON(log.rawReasoning),
        }),
      ),
      ...ptps.map(
        (ptp): AuditTimelineItem => ({
          id: ptp.id,
          kind: 'ptp',
          timestamp: ptp.createdAt.toISOString(),
          ptpStatus: ptp.status,
          promisedDate: ptp.promisedDate.toISOString(),
          agreedAmount: ptp.agreedAmount,
          extractedQuote: ptp.extractedQuote,
        }),
      ),
    ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const totalCostIncurred = auditLogs.reduce((s, l) => s + l.costIncurred, 0);
    const totalRecovered = auditLogs.reduce((s, l) => s + l.rupeesRecovered, 0);

    const response: EventAuditResponse = {
      event: {
        id: event.id,
        eventType: event.eventType,
        status: event.status,
        amountAtRisk: event.amountAtRisk,
        currency: event.currency,
        customerName: event.customerName,
        customerContact: event.customerContact,
        declineCode: event.declineCode,
        riskScore: event.riskScore,
        isDisputed: event.isDisputed,
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
      },
      timeline: timelineItems,
      totals: {
        totalCostIncurred: Math.round(totalCostIncurred * 100) / 100,
        totalRecovered: Math.round(totalRecovered * 100) / 100,
        netValue: Math.round((totalRecovered - totalCostIncurred) * 100) / 100,
        actionCount: auditLogs.filter((l) => l.actionTaken !== null).length,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Audit API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function safeParseJSON(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; }
  catch { return { raw: s }; }
}
