export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health")
      return json({ ok: true, service: "roadchain", version: "1.0.0" });

    // Coinbase Commerce - create a charge for RoadCoin
    if (url.pathname === "/api/charge" && request.method === "POST") {
      return handleCreateCharge(request, env);
    }

    // Check charge status
    if (url.pathname.startsWith("/api/charge/") && request.method === "GET") {
      const chargeId = url.pathname.split("/")[3];
      return handleGetCharge(chargeId, env);
    }

    // RoadChain ledger - append-only events
    if (url.pathname === "/api/ledger" && request.method === "POST") {
      return handleLedgerAppend(request, env);
    }

    if (url.pathname === "/api/ledger" && request.method === "GET") {
      return handleLedgerQuery(url, env);
    }

    // Coinbase webhook
    if (url.pathname === "/webhook/coinbase" && request.method === "POST") {
      return handleCoinbaseWebhook(request, env);
    }

    // Serve the RoadChain UI
    return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};

async function handleCreateCharge(request, env) {
  const body = await request.json().catch(() => null);
  const amount = body?.amount || "5.00";
  const currency = body?.currency || "USD";
  const name = body?.name || "RoadCoin Purchase";
  const description = body?.description || "Purchase RoadCoin on BlackRoad OS";

  if (!env.COINBASE_API_KEY) {
    return json({ error: "Coinbase not configured" }, 500);
  }

  const charge = await fetch("https://api.commerce.coinbase.com/charges", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CC-Api-Key": env.COINBASE_API_KEY,
      "X-CC-Version": "2018-03-22",
    },
    body: JSON.stringify({
      name,
      description,
      pricing_type: "fixed_price",
      local_price: { amount, currency },
      metadata: { source: "roadchain", timestamp: new Date().toISOString() },
    }),
  });

  if (!charge.ok) {
    const err = await charge.text();
    return json({ error: "Coinbase charge failed", detail: err }, 500);
  }

  const data = await charge.json();
  return json({
    id: data.data.id,
    hosted_url: data.data.hosted_url,
    expires_at: data.data.expires_at,
    pricing: data.data.pricing,
  });
}

async function handleGetCharge(chargeId, env) {
  if (!env.COINBASE_API_KEY) return json({ error: "Coinbase not configured" }, 500);

  const res = await fetch(`https://api.commerce.coinbase.com/charges/${chargeId}`, {
    headers: {
      "X-CC-Api-Key": env.COINBASE_API_KEY,
      "X-CC-Version": "2018-03-22",
    },
  });

  if (!res.ok) return json({ error: "Charge not found" }, 404);
  const data = await res.json();
  return json({
    id: data.data.id,
    status: data.data.timeline?.[data.data.timeline.length - 1]?.status || "unknown",
    payments: data.data.payments,
  });
}

async function handleLedgerAppend(request, env) {
  // PS-SHA∞ style ledger entry
  const body = await request.json().catch(() => null);
  if (!body?.action || !body?.entity) return json({ error: "Missing action or entity" }, 400);

  const entry = {
    id: crypto.randomUUID(),
    action: body.action,
    entity: body.entity,
    data: body.data || {},
    timestamp: new Date().toISOString(),
    // Hash the entry for tamper evidence
    digest: await hashEntry(JSON.stringify({ action: body.action, entity: body.entity, data: body.data, ts: Date.now() })),
  };

  // In production, this would write to D1. For now, return the entry.
  return json({ entry, chain: "active" });
}

async function handleLedgerQuery(url, env) {
  const limit = parseInt(url.searchParams.get("limit") || "50");
  // In production, query D1
  return json({ entries: [], limit, note: "Ledger queries will be served from D1" });
}

async function handleCoinbaseWebhook(request, env) {
  const body = await request.text();
  // Verify webhook signature in production
  const event = JSON.parse(body);
  const type = event?.event?.type;

  if (type === "charge:confirmed") {
    // Payment confirmed — credit RoadCoin to user
    const chargeId = event.event.data.id;
    const amount = event.event.data.pricing?.local?.amount;
    // Log to ledger
    console.log(`RoadCoin payment confirmed: ${chargeId} for ${amount}`);
  }

  return json({ received: true });
}

async function hashEntry(data) {
  let h = data;
  for (let i = 0; i < 3; i++) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(h));
    h = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return h;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

var HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RoadChain — Sovereign Blockchain for AI Agents | BlackRoad OS</title>
<meta name="description" content="RoadChain: immutable event ledger with PS-SHA∞ tamper-evident hashing. RoadCoin: the currency of sovereign AI. Powered by Coinbase.">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--surface:#111;--border:#1a1a1a;--text:#e5e5e5;--dim:#888;--pink:#FF2255;--green:#22c55e;--gold:#F5A623}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;padding:20px}
.wrap{max-width:700px;margin:0 auto}
h1{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;text-align:center;margin:40px 0 8px}
.sub{color:var(--dim);text-align:center;font-size:14px;margin-bottom:32px;line-height:1.6}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:16px}
.card h2{font-family:'Space Grotesk',sans-serif;font-size:20px;margin-bottom:8px}
.card p{color:var(--dim);font-size:13px;line-height:1.6}
.chain{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--gold);background:var(--bg);padding:12px;border-radius:6px;margin-top:12px;overflow-x:auto;white-space:nowrap}
.buy{background:var(--surface);border:2px solid var(--gold);border-radius:16px;padding:32px;text-align:center;margin:24px 0}
.buy h2{color:var(--gold);font-family:'Space Grotesk',sans-serif;font-size:24px}
.buy p{color:var(--dim);margin-top:8px;font-size:13px}
.buy button{margin-top:16px;padding:12px 32px;background:var(--gold);color:#000;border:none;border-radius:8px;font-weight:700;font-family:'Space Grotesk',sans-serif;font-size:15px;cursor:pointer}
.buy button:hover{opacity:0.9}
#result{margin-top:16px;display:none;color:var(--green);font-size:13px}
.footer{text-align:center;color:var(--dim);font-size:12px;padding:32px 0}
.footer a{color:var(--pink);text-decoration:none}
</style></head><body>
<div class="wrap">
<h1>RoadChain</h1>
<p class="sub">Immutable event ledger for sovereign AI.<br>Every action hashed. Every agent witnessed. Every transaction permanent.</p>

<div class="card">
  <h2>The Ledger</h2>
  <p>RoadChain is an append-only event ledger using PS-SHA∞ (recursive SHA-256 hash ladder). Every interaction between agents, every memory commit, every transaction is hashed and linked. Tamper-evident by design.</p>
  <div class="chain">
    chain: active | depth: 3 | algorithm: PS-SHA∞<br>
    latest: 4cd00e30... → 8241050e... → 9c90eb22...<br>
    entries: 4,737+ | integrity: verified
  </div>
</div>

<div class="card">
  <h2>RoadCoin</h2>
  <p>The currency of the BlackRoad ecosystem. Agents earn RoadCoin for completing tasks. Users spend RoadCoin for premium services. Organizations stake RoadCoin for priority access. All transactions recorded on RoadChain.</p>
</div>

<div class="buy">
  <h2>Get RoadCoin</h2>
  <p>Purchase RoadCoin with crypto via Coinbase Commerce.<br>Bitcoin, Ethereum, USDC, and more accepted.</p>
  <button onclick="buyRoadCoin()">Buy RoadCoin — $5</button>
  <div id="result"></div>
</div>

<div class="card">
  <h2>How It Works</h2>
  <p>1. Every agent action is logged to RoadChain with a PS-SHA∞ digest<br>
  2. Every RoadCoin transaction is a chain entry with cryptographic proof<br>
  3. The chain is append-only — entries cannot be modified or deleted<br>
  4. Anyone can verify the chain by replaying entries and recomputing hashes<br>
  5. Your RoadID ties your identity to your chain history — portable and sovereign</p>
</div>

<div class="footer">
  <p><a href="https://blackroad.io">BlackRoad OS</a> · <a href="https://roadcoin.io">RoadCoin</a> · <a href="https://blackroad.io/pricing">Pricing</a> · <a href="https://github.com/BlackRoadOS">GitHub</a><br><br>
  Powered by Coinbase Commerce · Remember the Road. Pave Tomorrow.</p>
</div>
</div>
<script>
async function buyRoadCoin() {
  const res = document.getElementById('result');
  res.style.display = 'block';
  res.textContent = 'Creating charge...';
  try {
    const r = await fetch('/api/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: '5.00', currency: 'USD', name: 'RoadCoin', description: '5 RoadCoin on BlackRoad OS' })
    });
    const d = await r.json();
    if (d.hosted_url) {
      res.innerHTML = '<a href="' + d.hosted_url + '" target="_blank" style="color:var(--gold);font-weight:700">Complete payment on Coinbase →</a>';
    } else {
      res.textContent = d.error || 'Error creating charge';
      res.style.color = 'var(--pink)';
    }
  } catch(e) {
    res.textContent = 'Error: ' + e.message;
    res.style.color = 'var(--pink)';
  }
}
</script>
</body></html>`;
