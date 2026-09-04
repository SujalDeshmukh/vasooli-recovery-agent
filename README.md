<div align="center">

# 🧾 Vasooli

### Autonomous Revenue Recovery Engine


[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)
[![Gemini](https://img.shields.io/badge/Gemini-3.6%20Flash-blue?logo=google)](https://ai.google.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Prisma%20ORM-336791?logo=postgresql)](https://www.prisma.io/)
[![BullMQ](https://img.shields.io/badge/BullMQ-Redis-red?logo=redis)](https://bullmq.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178c6?logo=typescript)](https://www.typescriptlang.org/)

> **Vasooli** detects revenue at risk, determines the optimal intervention, and executes a bounded, RBI-compliant recovery workflow — from payment failures and checkout abandonment to overdue B2B receivables — completely autonomously.

</div>

---

## 📌 The Problem

Revenue loss in India rarely happens in one clean step. It degrades:

- A **payment fails** with a cryptic NPCI code like `U16` (often just "payday lag")
- A **checkout gets abandoned** 2 seconds before confirmation
- A **subscription auto-debit fails** silently at 3 AM
- A **B2B invoice goes overdue** while the ops team is sleeping

Traditional systems send one reminder email and give up. **Vasooli doesn't.**

It closes the loop from **detecting the problem → diagnosing the root cause → choosing the right intervention → recovering the money** — with a full immutable audit trail at every step.

---

## 🧠 The Core Idea: Dual-Brain Architecture

The biggest mistake AI-based financial systems make is letting the LLM touch compliance decisions. We didn't do that.

```
┌─────────────────────────────────────────────────────────────────┐
│                     VASOOLI DUAL-BRAIN                          │
│                                                                 │
│   ┌──────────────────────┐    ┌──────────────────────────────┐  │
│   │   🧠 LEFT BRAIN       │    │   🧠 RIGHT BRAIN              │  │
│   │ Deterministic Policy │    │   Gemini 3.6 Flash LLM       │  │
│   │      Engine          │    │   Reasoning Engine           │  │
│   │                      │    │                              │  │
│   │  • NPCI retry caps   │    │  • Root cause diagnosis      │  │
│   │  • Risk scoring      │    │  • Hinglish message gen      │  │
│   │  • Freeze decisions  │    │  • PTP date extraction       │  │
│   │  • Human handoffs    │    │  • Sentiment analysis        │  │
│   │                      │    │                              │  │
│   │  Zero hallucination  │    │  Only fires with Left Brain  │  │
│   │  in compliance path  │    │  approval                    │  │
│   └──────────────────────┘    └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    RZP["🔵 Razorpay\nWebhook Events"]:::external
    WA_IN["💬 WhatsApp Business\nInbound Messages"]:::external
    CRON["⏰ PTP Breach\nCron Scheduler"]:::external

    RZP_ROUTE["POST /api/webhooks/razorpay\nEvent Normalizer + HMAC Validator"]:::api
    WA_ROUTE["POST /api/webhooks/whatsapp\nMeta Webhook Handler"]:::api

    DB[("🐘 PostgreSQL\nvia Prisma ORM\n\nRevenueEvent\nAuditLog\nPromiseToPay")]:::db
    REDIS[("🔴 Redis\nBullMQ Job Queue")]:::db

    subgraph LEFT_BRAIN["🧠 Left Brain — Deterministic Policy Engine"]
        direction TB
        PE["Policy Engine\npolicyEngine.ts\n\n• Evaluates risk score\n• Checks retry count\n• Evaluates freeze conditions\n• Routes to action tier"]:::engine
        RS["Retry Scheduler\nretryScheduler.ts\n\n• Salary-window targeting\n• Exponential backoff\n• NPCI mandate logic"]:::engine
    end

    subgraph RIGHT_BRAIN["🧠 Right Brain — Gemini 3.6 Flash LLM Agents"]
        direction TB
        DIAG["🔍 Diagnostician Agent\ndiagnostician.ts\n\nMaps NPCI codes to human reason\nGenerates recovery strategy"]:::ai
        HING["🗣️ Hinglish Agent\nhinglishAgent.ts\n\nGenerates contextual\nHinglish WhatsApp nudges"]:::ai
        PTP_EX["📅 PTP Extractor\nptpExtractor.ts\n\nExtracts promise dates from\nunstructured customer replies"]:::ai
    end

    subgraph WORKER["⚙️ BullMQ Recovery Worker"]
        direction TB
        RW["Recovery Worker\nrecoveryWorker.ts\n\n• SEND_CONVERSATIONAL_NUDGE\n• GENERATE_PAYMENT_LINK\n• ESCALATE_TO_HUMAN\n• FREEZE_COLLECTION\n• SCHEDULE_RETRY"]:::worker
    end

    WA_OUT["📲 WhatsApp Outbound\nHinglish + TTS"]:::action
    PAY_LINK["💳 UPI Payment Link\nZero-cost Razorpay Link"]:::action
    HUMAN["👨‍💼 Human Escalation Queue"]:::action
    FREEZE["🔒 Collection Freeze"]:::action

    subgraph DASHBOARD["📊 Ops Dashboard — Next.js 14"]
        direction LR
        METRICS["MetricsBar\nKPI Cards + Pipeline Chart"]:::ui
        TABLE["EventTable\nLive Event Feed"]:::ui
        DRAWER["AuditDrawer\nAudit Trail + WA Simulator + TTS"]:::ui
    end

    RZP --> RZP_ROUTE
    WA_IN --> WA_ROUTE
    RZP_ROUTE --> DB
    RZP_ROUTE --> REDIS
    REDIS --> RW
    RW --> PE
    PE --> RS
    PE --> DIAG
    DIAG --> HING
    HING --> WA_OUT
    PE --> PAY_LINK
    PE --> HUMAN
    PE --> FREEZE
    WA_ROUTE --> PTP_EX
    PTP_EX --> DB
    CRON --> DB
    DB --> METRICS
    DB --> TABLE
    DB --> DRAWER

    classDef external fill:#1a1a2e,stroke:#4a9eff,color:#fff
    classDef api fill:#16213e,stroke:#4a9eff,color:#fff
    classDef db fill:#0f3460,stroke:#4a9eff,color:#fff
    classDef engine fill:#1b4332,stroke:#40c057,color:#fff
    classDef ai fill:#3d0066,stroke:#be4bdb,color:#fff
    classDef worker fill:#7c2d12,stroke:#fb923c,color:#fff
    classDef action fill:#1e3a5f,stroke:#4dabf7,color:#fff
    classDef ui fill:#1a1a1a,stroke:#adb5bd,color:#fff
```

---

## 🔄 End-to-End Recovery Flow

```mermaid
sequenceDiagram
    participant RZP as Razorpay
    participant API as Vasooli API
    participant DB as PostgreSQL
    participant Q as BullMQ
    participant LB as Left Brain
    participant RB as Gemini Flash
    participant WA as WhatsApp
    participant CUST as Customer

    RZP->>API: POST /webhooks/razorpay payment.failed NPCI U16
    API->>DB: Upsert RevenueEvent status=DETECTED
    API->>Q: Enqueue recovery job

    Q->>LB: Process event
    LB->>LB: Evaluate risk score, retry count, dispute flag

    alt Risk Score less than 70 and Retries less than 3
        LB->>RB: Request diagnosis
        RB->>RB: Map NPCI U16 to Payday Lag, generate strategy
        RB->>LB: Diagnosis + recommended action
        LB->>RB: Request Hinglish nudge
        RB->>WA: Send contextual message
        LB->>DB: Write AuditLog, status=IN_RECOVERY
    else Risk Score 70 or above or Retries 3 or above
        LB->>DB: ESCALATE or FREEZE + AuditLog
    end

    CUST->>WA: Reply "Bhai Monday pakka"
    WA->>API: POST /webhooks/whatsapp
    API->>RB: extractPTP from message
    RB->>RB: Intent=promise_to_pay, Date=Monday ISO-8601
    RB->>DB: Create PromiseToPay, status=PTP_ACTIVE
    API->>WA: Send acknowledgement to customer
```

---

## ⚡ Recovery Scenarios Covered

| Scenario | Detection | Intervention | AI Agent Used |
|---|---|---|---|
| Payment failure (NPCI U16) | `payment.failed` webhook | Diagnosis + Hinglish nudge | Diagnostician + Hinglish |
| Payment failure (RB / NSF) | `payment.failed` webhook | Salary-window retry scheduling | Policy Engine |
| Checkout abandonment | `order.paid` not received | UPI 1-click intent link | Policy Engine |
| Subscription debit failure | `subscription.charged_failed` | Mandate retry sequencer | Policy Engine |
| B2B invoice overdue | Scheduled detection | Tiered Email + WhatsApp chase | Hinglish Agent |
| Customer WhatsApp reply | `messages` webhook | PTP extraction + acknowledgement | PTP Extractor |
| PTP breach detected | Cron job scheduler | Unfreeze + Human handoff | Cron + Policy Engine |
| Dispute flagged | Customer message or manual | Immediate freeze + escalation | Policy Engine |

---

## 🗄️ Data Model

```mermaid
erDiagram
    RevenueEvent {
        string id PK
        string merchantId
        string eventType
        string status
        float amountAtRisk
        float rupeesRecovered
        string currency
        string customerName
        string customerContact
        string declineCode
        int riskScore
        bool isDisputed
        bool isFrozen
        int retryCount
        datetime invoiceDueDate
        datetime createdAt
    }

    AuditLog {
        string id PK
        string eventId FK
        string stage
        string diagnosedReason
        bool policyPassed
        string actionTaken
        float costIncurred
        float rupeesRecovered
        json rawReasoning
        datetime timestamp
    }

    PromiseToPay {
        string id PK
        string eventId FK
        datetime promisedDate
        float agreedAmount
        string status
        string extractedQuote
        datetime createdAt
    }

    RevenueEvent ||--o{ AuditLog : "has many"
    RevenueEvent ||--o| PromiseToPay : "has one"
```

---

## 🤖 AI Agents in Detail

### 🔍 Diagnostician (`diagnostician.ts`)
Translates raw payment failure signals into actionable intelligence using Gemini 3.6 Flash.

**Input:** NPCI decline code, payment method, amount, customer history  
**Output:** Human-readable root cause, risk score (0–100), recommended action tier, escalation flag

```
NPCI U16 → "Payday Lag: Customer likely has funds by month-end. Schedule retry."
NPCI RB  → "Repeated Bounce: High risk. Limit retries. Consider human outreach."
```

### 🗣️ Hinglish Agent (`hinglishAgent.ts`)
Generates personalized, contextual recovery messages in Hinglish — the language your Indian customers actually speak.

**Sample output:**
```
Namaste Rahul ji! 🙏

Aapki ₹4,500 ki payment process hone mein thodi dikkat aayi.
Koi baat nahi — bas ek baar dobara try karein?

👇 Yahan click karein — 30 second mein ho jaayega!
[Pay Now ₹4,500]
```

### 📅 PTP Extractor (`ptpExtractor.ts`)
Extracts structured Promise-to-Pay data from completely unstructured Hinglish customer replies.

**Input:** `"Bhai kal pakka de dunga, salary aa gayi hai"`  
**Output:** `{ intent: "promise_to_pay", targetDate: "2026-09-06", agreedAmount: 4500, sentiment: "positive", confidence: 0.92 }`

---

## ⚙️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14 (App Router), React 18, Tailwind CSS |
| **Backend** | Next.js API Routes, TypeScript (strict mode) |
| **AI / LLM** | Google Gemini 3.6 Flash (`@google/generative-ai`) |
| **Database** | PostgreSQL 15, Prisma ORM |
| **Job Queue** | BullMQ + Redis (async recovery actions) |
| **Infrastructure** | Docker Compose (local), Razorpay Webhooks |
| **Simulation** | Custom `simulate.ts` — fires 120+ realistic events |

---

## 🚀 Running Locally

### Prerequisites
- Node.js 18+
- Docker Desktop
- A Google Gemini API key

### 1. Start Infrastructure
```bash
docker compose up -d
# Starts PostgreSQL on :5432 and Redis on :6379
```

### 2. Install & Setup Database
```bash
npm install
npm run db:push
```

### 3. Configure Environment
```bash
cp .env.example .env.local
```

Open `.env.local` and set:
```env
DATABASE_URL="postgresql://vasooli:vasooli@localhost:5432/vasooli"
REDIS_URL="redis://localhost:6379"
GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
GEMINI_SIMULATE="false"
```

### 4. Start All Services (3 terminals)

**Terminal 1 — Next.js Dashboard:**
```bash
npm run dev
# Opens at http://localhost:3000
```

**Terminal 2 — BullMQ Worker:**
```bash
npm run worker
```

**Terminal 3 — PTP Breach Cron:**
```bash
npm run scheduler
```

### 5. Load Demo Data
```bash
npx tsx scripts/simulate.ts


```

---

## 📊 Dashboard Features

### Metrics Bar
- **₹ At-Risk** — Total revenue in active recovery
- **₹ Recovered** — Money successfully recovered (with % rate)
- **PTP Active** — Live promise-to-pay commitments
- **Escalated / Frozen** — Guardrail enforcement count
- **Recovery Pipeline** — Visual stacked bar chart of event funnel

### Event Table
- Live-updating event feed (5-second refresh)
- Status badges: `DETECTED` → `IN_RECOVERY` → `PTP_ACTIVE` → `RECOVERED`
- Risk scores, decline codes, customer details

### Audit Drawer (Click any event)
- **Immutable audit trail** — Every decision logged with timestamp
- **Raw AI reasoning** — Full Gemini response visible per step
- **💬 WhatsApp Chat Simulator** — Send mock customer replies and watch AI extract PTP live
- **▶ Play Voice (TTS)** — Hear the Hinglish nudge read aloud (Web Speech API)

---

## 🛡️ Safety & Compliance

| Guardrail | Implementation |
|---|---|
| **NPCI Retry Cap** | Left Brain enforces max 3 retries; never delegated to LLM |
| **Dispute Freeze** | Any dispute flag instantly freezes all automated collection |
| **Human Handoff** | Events with risk score ≥ 70 are always escalated to a human queue |
| **PTP Pause** | Once a customer gives a Promise-to-Pay, all automated nudges stop immediately |
| **Immutable Audit Log** | Every AI decision, policy check, and action is permanently recorded |
| **Cost Accounting** | Every LLM API call cost is tracked at the per-event level |

---

## 📁 Project Structure

```
vasooli/
├── prisma/
│   └── schema.prisma              # DB schema
├── scripts/
│   └── simulate.ts                # 120-event simulation script
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── events/[id]/audit/ # Per-event audit trail API
│   │   │   ├── metrics/           # Dashboard KPI aggregation API
│   │   │   └── webhooks/
│   │   │       ├── razorpay/      # Razorpay event ingestor
│   │   │       └── whatsapp/      # Meta WhatsApp inbound handler
│   │   └── page.tsx
│   ├── components/dashboard/
│   │   ├── AuditDrawer.tsx        # Audit trail + WA simulator + TTS
│   │   ├── EventTable.tsx         # Live event feed
│   │   ├── MetricsBar.tsx         # KPI cards + pipeline chart
│   │   └── VerdictBadge.tsx
│   └── lib/
│       ├── agents/
│       │   ├── diagnostician.ts   # Gemini: root cause analysis
│       │   ├── hinglishAgent.ts   # Gemini: Hinglish nudge generation
│       │   └── ptpExtractor.ts    # Gemini: PTP date extraction
│       ├── engine/
│       │   ├── policyEngine.ts    # Left Brain: compliance state machine
│       │   ├── retryScheduler.ts  # NPCI retry + salary window logic
│       │   └── types.ts
│       ├── integrations/
│       │   ├── messaging.ts       # WhatsApp send wrapper
│       │   └── razorpay.ts        # Razorpay payment link generator
│       ├── queues/
│       │   └── recoveryQueue.ts   # BullMQ job definitions
│       └── workers/
│           ├── ptpScheduler.ts    # PTP breach detection cron
│           └── recoveryWorker.ts  # BullMQ job processor
├── docker-compose.yml
└── .env.example
```

---


