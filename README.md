# Vasooli — Autonomous Revenue Recovery Engine 🚀

![Vasooli Dashboard](https://via.placeholder.com/1000x500?text=Vasooli+Dashboard)

**Vasooli** is a Dual-Brain AI agent built for **Track 03 (AI Revenue Recovery)** of the Razorpay AI Buildathon. It detects revenue at risk, determines the optimal intervention, and executes bounded recovery workflows—from payment failures to overdue B2B receivables.

## 🏆 How it hits the Track 03 Bar
- **Payment degradation → root cause:** Gemini 3.6 Flash diagnoses Razorpay webhooks (e.g., mapping NPCI U16 to "Payday Lag").
- **Checkout drop-off & Failed subscriptions:** Dispatches zero-cost 1-click UPI intent links.
- **B2B receivables chaser:** Multi-channel (Email & WhatsApp) escalation tiers.
- **Mandate retry sequencer:** Left Brain strictly limits NPCI retries (max 3) and targets salary windows.
- **Promise-to-pay tracker:** Live LLM extraction of unstructured Hinglish WhatsApp replies into exact ISO-8601 target dates.
- **Hinglish voice recovery:** Converts AI-generated Hinglish nudges into local TTS.

## 🧠 The "Dual-Brain" Architecture
We explicitly separated compliance from intelligence to ensure RBI safety and enterprise trust:

1. **The Left Brain (Deterministic Policy Engine):** A strict TypeScript state machine. It enforces NPCI retry caps, evaluates risk scores, triggers hard freezes on disputes, and manages human handoffs. *Zero LLM hallucinations in the critical compliance path.*
2. **The Right Brain (LLM Reasoning Engine):** Powered by **Gemini 3.6 Flash**. It handles unstructured data: diagnosing root causes, generating contextual Hinglish WhatsApp messages, and extracting Promise-to-Pay dates from chaotic customer replies. *It only fires when the Left Brain approves.*

## ⚙️ Tech Stack
- **Framework:** Next.js 14 (App Router), React, Tailwind CSS
- **AI/LLM:** Google Gemini 3.6 Flash (`@google/generative-ai`)
- **Database:** PostgreSQL (Prisma ORM)
- **Queues/Workers:** BullMQ & Redis (Asynchronous recovery actions)
- **Integrations:** Razorpay Webhooks, WhatsApp Business API (simulated)

## 🚀 Running Locally

1. **Start Infrastructure (Postgres & Redis):**
   ```bash
   docker compose up -d
   ```
2. **Setup Database:**
   ```bash
   npm install
   npm run db:push
   ```
3. **Environment Variables:**
   Copy `.env` to `.env.local` and add your Gemini API Key. Set `GEMINI_SIMULATE="false"`.
4. **Start the Microservices (3 terminals):**
   ```bash
   npm run dev       # Starts Next.js Dashboard
   npm run worker    # Starts BullMQ Action Dispatcher
   npm run scheduler # Starts PTP Breach Cron Job
   ```
5. **Run the Simulation:**
   ```bash
   npx tsx scripts/simulate.ts
   ```

## 📊 Judging Criteria Alignment
- **Problem taste:** Focuses on the hardest B2B collection problems (NPCI U16/RB failures, Promise-to-Pay negotiations).
- **Build quality:** Asynchronous BullMQ architecture survives Razorpay API outages via exponential backoff.
- **AI judgment:** We specifically chose *not* to use AI for billing decisions. AI is restricted to diagnosis and natural language extraction.
- **Failure recovery:** If a customer breaches a Promise-to-Pay date, a cron job detects the breach and automatically routes them to human escalation.
