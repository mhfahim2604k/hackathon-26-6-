/**
 * Smoke test for QueueStorm Investigator.
 *
 *   npm run verify
 *
 * Spins up the Fastify server in-process, hits GET /health and
 * POST /analyze-ticket with a synthetic TKT-001-style request, then
 * shuts the server down. Exits 0 on success, non-zero on any error.
 *
 * This script is also a runnable doc: it shows the minimum viable
 * server usage.
 */
import { buildServer } from '../src/server.js';

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: 0 }); // ephemeral port

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    // ---- /health ----
    const healthRes = await fetch(`${base}/health`);
    if (healthRes.status !== 200) {
      throw new Error(`/health returned ${healthRes.status}`);
    }
    const healthBody = (await healthRes.json()) as { status: string };
    if (healthBody.status !== 'ok') {
      throw new Error(`/health status was ${healthBody.status}, expected ok`);
    }
    console.log('[verify] GET /health → 200 ok');

    // ---- POST /analyze-ticket ----
    const sample = {
      ticket_id: 'TKT-VERIFY-1',
      complaint:
        'I sent 5000 taka to a wrong number around 2pm today. The number was supposed to be 01712345678 but I think I typed it wrong.',
      language: 'en',
      channel: 'in_app_chat',
      user_type: 'customer',
      transaction_history: [
        {
          transaction_id: 'TXN-VERIFY-1',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          type: 'transfer',
          amount: 5000,
          counterparty: '+8801719876543',
          status: 'completed',
        },
      ],
    };

    const analyzeRes = await fetch(`${base}/analyze-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sample),
    });
    if (analyzeRes.status !== 200) {
      const txt = await analyzeRes.text();
      throw new Error(`/analyze-ticket returned ${analyzeRes.status}: ${txt}`);
    }
    const body = (await analyzeRes.json()) as {
      ticket_id: string;
      case_type: string;
      evidence_verdict: string;
      relevant_transaction_id: string | null;
      severity: string;
      department: string;
      human_review_required: boolean;
      customer_reply: string;
    };

    console.log('[verify] POST /analyze-ticket → 200');
    console.log('[verify] ticket_id           :', body.ticket_id);
    console.log('[verify] case_type           :', body.case_type);
    console.log('[verify] evidence_verdict    :', body.evidence_verdict);
    console.log('[verify] relevant_transaction:', body.relevant_transaction_id);
    console.log('[verify] severity            :', body.severity);
    console.log('[verify] department          :', body.department);
    console.log('[verify] human_review_required:', body.human_review_required);

    if (body.case_type !== 'wrong_transfer') {
      throw new Error(`expected case_type=wrong_transfer, got ${body.case_type}`);
    }
    if (body.evidence_verdict !== 'consistent') {
      throw new Error(`expected verdict=consistent, got ${body.evidence_verdict}`);
    }
    if (body.relevant_transaction_id !== 'TXN-VERIFY-1') {
      throw new Error(`expected relevant=TXN-VERIFY-1, got ${body.relevant_transaction_id}`);
    }
    if (body.human_review_required !== true) {
      throw new Error(`expected human_review_required=true, got ${body.human_review_required}`);
    }
    if (typeof body.customer_reply !== 'string' || body.customer_reply.length === 0) {
      throw new Error('expected non-empty customer_reply');
    }

    console.log('[verify] ✓ smoke test passed');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[verify] FAILED:', err);
  process.exitCode = 1;
});
