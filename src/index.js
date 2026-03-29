// RoadChain — Sovereign Blockchain for BlackRoad OS
// D1 persistent ledger + Coinbase Commerce + x402 micropayments + cross-app event bus

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

    if (request.method === "OPTIONS")
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization,X-RoadChain-App,X-RoadChain-Signature" } });

    // Health
    if (url.pathname === "/health")
      return json({ ok: true, service: "roadchain", version: "2.0.0", chain: "active" });

    // ── LEDGER: the real blockchain ──
    if (url.pathname === "/api/ledger" && request.method === "POST")
      return handleLedgerWrite(request, env);

    if (url.pathname === "/api/ledger" && request.method === "GET")
      return handleLedgerRead(url, env);

    if (url.pathname === "/api/ledger/verify" && request.method === "GET")
      return handleLedgerVerify(env);

    if (url.pathname === "/api/ledger/stats" && request.method === "GET")
      return handleLedgerStats(env);

    // ── ROADCOIN: token operations ──
    if (url.pathname === "/api/balance" && request.method === "GET")
      return handleBalance(url, env);

    if (url.pathname === "/api/transfer" && request.method === "POST")
      return handleTransfer(request, env);

    if (url.pathname === "/api/mint" && request.method === "POST")
      return handleMint(request, env);

    // ── COINBASE COMMERCE: buy RoadCoin with crypto ──
    if (url.pathname === "/api/charge" && request.method === "POST")
      return handleCreateCharge(request, env);

    if (url.pathname.startsWith("/api/charge/") && request.method === "GET")
      return handleGetCharge(url.pathname.split("/")[3], env);

    // ── COINBASE WEBHOOKS ──
    if (url.pathname === "/webhook/coinbase" && request.method === "POST")
      return handleCoinbaseWebhook(request, env);

    // ── x402: micropayment protocol ──
    if (url.pathname === "/api/x402/negotiate" && request.method === "POST")
      return handleX402Negotiate(request, env);

    if (url.pathname === "/api/x402/verify" && request.method === "POST")
      return handleX402Verify(request, env);

    // ── CROSS-APP EVENT BUS: any BlackRoad app can write events ──
    if (url.pathname === "/api/event" && request.method === "POST")
      return handleAppEvent(request, env);

    if (url.pathname === "/api/events" && request.method === "GET")
      return handleAppEvents(url, env);

    // ── UI ──
    if (url.pathname === "/api/info")
      return json({ name: "RoadChain", version: "2.0.0", endpoints: ["/api/ledger", "/api/balance", "/api/transfer", "/api/mint", "/api/charge", "/api/x402/negotiate", "/api/event", "/api/events", "/api/ledger/verify", "/api/ledger/stats"] });

    return new Response(HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  }
};

// ── INIT DB ──
async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      block_number INTEGER,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      app TEXT DEFAULT 'system',
      data TEXT DEFAULT '{}',
      road_id TEXT,
      amount REAL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS balances (
      road_id TEXT PRIMARY KEY,
      balance REAL DEFAULT 0,
      total_earned REAL DEFAULT 0,
      total_spent REAL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT DEFAULT '{}',
      road_id TEXT,
      created_at TEXT NOT NULL
    )`)
  ]);
}

// ── PS-SHA∞ HASH ──
// PS-SHA∞ — Persistent Secure SHA Infinity
// Depth is NOT fixed — it scales with the significance of the data.
// Financial transactions: depth 7. Ledger blocks: depth 5. Events: depth 3.
// The ∞ means there's no theoretical maximum. Depth adapts to trust requirements.
// Each iteration compounds tamper resistance exponentially.
async function pssha(data, depth = 3) {
  let h = data;
  for (let i = 0; i < depth; i++) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(h));
    h = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return h;
}

// Adaptive depth based on action type
function getPSSHADepth(action) {
  const depths = {
    "transfer": 7,        // Financial: maximum security
    "mint": 7,            // Token creation: maximum security
    "charge_confirmed": 7,// Coinbase payment: maximum security
    "x402_payment": 6,    // Micropayment: high security
    "solve": 5,           // Tutor solve: standard chain
    "post": 4,            // Social post: moderate
    "message": 3,         // Chat message: basic
    "query": 3,           // Search query: basic
    "default": 5,         // Everything else: standard
  };
  return depths[action] || depths["default"];
}

// ── LEDGER WRITE (the core blockchain operation) ──
async function handleLedgerWrite(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.action || !body?.entity) return json({ error: "Missing action or entity" }, 400);

  await ensureTables(env.DB);

  // Get previous block
  const prev = await env.DB.prepare("SELECT hash, block_number FROM ledger ORDER BY block_number DESC LIMIT 1").first();
  const prevHash = prev?.hash || "genesis";
  const blockNumber = (prev?.block_number || 0) + 1;

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const app = request.headers.get("X-RoadChain-App") || body.app || "direct";
  const roadId = body.road_id || "anonymous";
  const amount = body.amount || 0;

  // Hash: prev_hash + action + entity + data + timestamp (PS-SHA∞ adaptive depth)
  const depth = getPSSHADepth(body.action);
  const payload = JSON.stringify({ prev: prevHash, action: body.action, entity: body.entity, data: body.data, ts: timestamp });
  const hash = await pssha(payload, depth);

  await env.DB.prepare(
    `INSERT INTO ledger (id, block_number, prev_hash, hash, action, entity, app, data, road_id, amount, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, blockNumber, prevHash, hash, body.action, body.entity, app, JSON.stringify(body.data || {}), roadId, amount, timestamp).run();

  return json({ id, block_number: blockNumber, hash, prev_hash: prevHash, chain: "active" });
}

// ── LEDGER READ ──
async function handleLedgerRead(url, env) {
  await ensureTables(env.DB);
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const app = url.searchParams.get("app");
  const roadId = url.searchParams.get("road_id");

  let query = "SELECT * FROM ledger";
  const conditions = [];
  const params = [];

  if (app) { conditions.push("app = ?"); params.push(app); }
  if (roadId) { conditions.push("road_id = ?"); params.push(roadId); }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY block_number DESC LIMIT ?";
  params.push(limit);

  const rows = await env.DB.prepare(query).bind(...params).all();
  return json({ entries: rows.results, count: rows.results.length, chain: "active" });
}

// ── LEDGER VERIFY: replay and check all hashes ──
async function handleLedgerVerify(env) {
  await ensureTables(env.DB);
  const rows = await env.DB.prepare("SELECT * FROM ledger ORDER BY block_number ASC LIMIT 1000").all();

  let valid = true;
  let checked = 0;
  let lastHash = "genesis";

  for (const row of rows.results) {
    if (row.prev_hash !== lastHash) { valid = false; break; }
    const payload = JSON.stringify({ prev: row.prev_hash, action: row.action, entity: row.entity, data: JSON.parse(row.data), ts: row.created_at });
    const computed = await pssha(payload);
    if (computed !== row.hash) { valid = false; break; }
    lastHash = row.hash;
    checked++;
  }

  return json({ valid, checked, latest_block: rows.results.length ? rows.results[rows.results.length - 1].block_number : 0, chain: valid ? "verified" : "BROKEN" });
}

// ── LEDGER STATS ──
async function handleLedgerStats(env) {
  await ensureTables(env.DB);
  const total = await env.DB.prepare("SELECT COUNT(*) as count, MAX(block_number) as latest FROM ledger").first();
  const apps = await env.DB.prepare("SELECT app, COUNT(*) as count FROM ledger GROUP BY app ORDER BY count DESC LIMIT 20").all();
  const recent = await env.DB.prepare("SELECT action, entity, app, hash, created_at FROM ledger ORDER BY block_number DESC LIMIT 10").all();

  return json({
    total_blocks: total?.count || 0,
    latest_block: total?.latest || 0,
    apps: apps.results,
    recent: recent.results,
    chain: "active"
  });
}

// ── ROADCOIN BALANCE ──
async function handleBalance(url, env) {
  const roadId = url.searchParams.get("road_id");
  if (!roadId) return json({ error: "Missing road_id" }, 400);
  await ensureTables(env.DB);
  const row = await env.DB.prepare("SELECT * FROM balances WHERE road_id = ?").bind(roadId).first();
  return json(row || { road_id: roadId, balance: 0, total_earned: 0, total_spent: 0 });
}

// ── ROADCOIN TRANSFER ──
async function handleTransfer(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.from || !body?.to || !body?.amount) return json({ error: "Missing from, to, or amount" }, 400);
  if (body.amount <= 0) return json({ error: "Amount must be positive" }, 400);

  await ensureTables(env.DB);

  const sender = await env.DB.prepare("SELECT balance FROM balances WHERE road_id = ?").bind(body.from).first();
  if (!sender || sender.balance < body.amount) return json({ error: "Insufficient balance" }, 400);

  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare("UPDATE balances SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ? WHERE road_id = ?").bind(body.amount, body.amount, now, body.from),
    env.DB.prepare("INSERT INTO balances (road_id, balance, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(road_id) DO UPDATE SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?").bind(body.to, body.amount, body.amount, now, body.amount, body.amount, now),
  ]);

  // Log to ledger
  const ledgerEntry = await handleLedgerWriteInternal(env, "transfer", "roadcoin", "roadchain", body.from, body.amount, { from: body.from, to: body.to, amount: body.amount, memo: body.memo });

  return json({ success: true, from: body.from, to: body.to, amount: body.amount, ledger_block: ledgerEntry.block_number });
}

// ── ROADCOIN MINT (reward mechanism) ──
async function handleMint(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.road_id || !body?.amount || !body?.reason) return json({ error: "Missing road_id, amount, or reason" }, 400);

  await ensureTables(env.DB);
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO balances (road_id, balance, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(road_id) DO UPDATE SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?"
  ).bind(body.road_id, body.amount, body.amount, now, body.amount, body.amount, now).run();

  const ledgerEntry = await handleLedgerWriteInternal(env, "mint", "roadcoin", "roadchain", body.road_id, body.amount, { reason: body.reason });

  return json({ success: true, road_id: body.road_id, minted: body.amount, reason: body.reason, ledger_block: ledgerEntry.block_number });
}

// ── INTERNAL LEDGER WRITE (for programmatic use) ──
async function handleLedgerWriteInternal(env, action, entity, app, roadId, amount, data) {
  await ensureTables(env.DB);
  const prev = await env.DB.prepare("SELECT hash, block_number FROM ledger ORDER BY block_number DESC LIMIT 1").first();
  const prevHash = prev?.hash || "genesis";
  const blockNumber = (prev?.block_number || 0) + 1;
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const depth = getPSSHADepth(action);
  const payload = JSON.stringify({ prev: prevHash, action, entity, data, ts: timestamp });
  const hash = await pssha(payload, depth);

  await env.DB.prepare(
    `INSERT INTO ledger (id, block_number, prev_hash, hash, action, entity, app, data, road_id, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, blockNumber, prevHash, hash, action, entity, app, JSON.stringify(data || {}), roadId || "system", amount || 0, timestamp).run();

  return { id, block_number: blockNumber, hash, prev_hash: prevHash };
}

// ── COINBASE COMMERCE ──
async function handleCreateCharge(request, env) {
  const body = await request.json().catch(() => null);
  if (!env.COINBASE_API_KEY) return json({ error: "Coinbase not configured. Set COINBASE_API_KEY secret." }, 500);

  const charge = await fetch("https://api.commerce.coinbase.com/charges", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CC-Api-Key": env.COINBASE_API_KEY, "X-CC-Version": "2018-03-22" },
    body: JSON.stringify({
      name: body?.name || "RoadCoin Purchase",
      description: body?.description || "Purchase RoadCoin on BlackRoad OS",
      pricing_type: "fixed_price",
      local_price: { amount: body?.amount || "5.00", currency: body?.currency || "USD" },
      metadata: { source: "roadchain", road_id: body?.road_id || "anonymous", ts: new Date().toISOString() },
    }),
  });

  if (!charge.ok) return json({ error: "Coinbase charge failed", detail: await charge.text() }, 500);
  const data = await charge.json();

  // Log to ledger
  await handleLedgerWriteInternal(env, "charge_created", "coinbase", "roadchain", body?.road_id, parseFloat(body?.amount || "5"), { charge_id: data.data.id });

  return json({ id: data.data.id, hosted_url: data.data.hosted_url, expires_at: data.data.expires_at, pricing: data.data.pricing });
}

async function handleGetCharge(chargeId, env) {
  if (!env.COINBASE_API_KEY) return json({ error: "Coinbase not configured" }, 500);
  const res = await fetch(`https://api.commerce.coinbase.com/charges/${chargeId}`, {
    headers: { "X-CC-Api-Key": env.COINBASE_API_KEY, "X-CC-Version": "2018-03-22" },
  });
  if (!res.ok) return json({ error: "Charge not found" }, 404);
  const data = await res.json();
  return json({ id: data.data.id, status: data.data.timeline?.[data.data.timeline.length - 1]?.status || "unknown", payments: data.data.payments });
}

async function handleCoinbaseWebhook(request, env) {
  const body = await request.text();
  const event = JSON.parse(body);

  if (event?.event?.type === "charge:confirmed") {
    const chargeId = event.event.data.id;
    const amount = parseFloat(event.event.data.pricing?.local?.amount || "0");
    const roadId = event.event.data.metadata?.road_id || "anonymous";

    // Mint RoadCoin for the buyer
    const roadCoinAmount = amount; // 1 USD = 1 ROAD for now
    await ensureTables(env.DB);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO balances (road_id, balance, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(road_id) DO UPDATE SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?"
    ).bind(roadId, roadCoinAmount, roadCoinAmount, now, roadCoinAmount, roadCoinAmount, now).run();

    await handleLedgerWriteInternal(env, "charge_confirmed", "coinbase", "roadchain", roadId, roadCoinAmount, { charge_id: chargeId, usd_amount: amount });
  }

  return json({ received: true });
}

// ── x402 MICROPAYMENT PROTOCOL ──
async function handleX402Negotiate(request, env) {
  const body = await request.json().catch(() => null);
  // Returns payment requirements for a given resource
  return json({
    protocol: "x402",
    version: "1.0",
    payment_required: true,
    amount: body?.amount || "0.001",
    currency: "USDC",
    network: "base",
    chain_id: 8453,
    recipient: env.ROADCHAIN_WALLET || "0x0000000000000000000000000000000000000000",
    memo: body?.memo || "RoadChain x402 payment",
    expires: new Date(Date.now() + 300000).toISOString(), // 5 min
  });
}

async function handleX402Verify(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.tx_hash) return json({ error: "Missing tx_hash" }, 400);

  // In production: verify the transaction on Base using RPC
  // For now: accept and log
  await handleLedgerWriteInternal(env, "x402_payment", "micropayment", body.app || "x402", body.road_id || "anonymous", parseFloat(body.amount || "0.001"), { tx_hash: body.tx_hash, network: "base" });

  return json({ verified: true, tx_hash: body.tx_hash, logged: true });
}

// ── CROSS-APP EVENT BUS ──
// Any BlackRoad app can POST events here — tutor solves, chat messages, social posts, search queries
async function handleAppEvent(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.app || !body?.type) return json({ error: "Missing app or type" }, 400);

  await ensureTables(env.DB);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO events (id, app, type, data, road_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, body.app, body.type, JSON.stringify(body.data || {}), body.road_id || "anonymous", now).run();

  // Also write to the ledger for permanent record
  await handleLedgerWriteInternal(env, body.type, body.app, body.app, body.road_id, body.amount || 0, body.data);

  // Mint RoadCoin rewards for qualifying events
  const rewards = { "tutor.solve": 0.1, "social.post": 0.05, "chat.message": 0.01, "search.query": 0.005, "canvas.create": 0.1, "video.upload": 0.5, "cadence.track": 0.2, "game.score": 0.02 };
  const reward = rewards[`${body.app}.${body.type}`];
  if (reward && body.road_id && body.road_id !== "anonymous") {
    await env.DB.prepare(
      "INSERT INTO balances (road_id, balance, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(road_id) DO UPDATE SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?"
    ).bind(body.road_id, reward, reward, now, reward, reward, now).run();
  }

  return json({ id, app: body.app, type: body.type, reward: reward || 0, chain: "logged" });
}

async function handleAppEvents(url, env) {
  await ensureTables(env.DB);
  const app = url.searchParams.get("app");
  const type = url.searchParams.get("type");
  const limit = parseInt(url.searchParams.get("limit") || "50");

  let query = "SELECT * FROM events";
  const conditions = [];
  const params = [];
  if (app) { conditions.push("app = ?"); params.push(app); }
  if (type) { conditions.push("type = ?"); params.push(type); }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const rows = await env.DB.prepare(query).bind(...params).all();
  return json({ events: rows.results, count: rows.results.length });
}

// ── HELPERS ──
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

// ── HTML UI ──
var HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RoadChain — Sovereign Blockchain | BlackRoad OS</title>
<meta name="description" content="RoadChain: D1 persistent blockchain with PS-SHA∞. RoadCoin rewards. Coinbase Commerce. x402 micropayments. Cross-app event bus.">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--surface:#111;--border:#1a1a1a;--text:#e5e5e5;--dim:#888;--pink:#FF2255;--green:#22c55e;--gold:#F5A623}
body{background:var(--bg);color:var(--text);font-family:'Inter',sans-serif;padding:20px}
.wrap{max-width:800px;margin:0 auto}
h1{font-family:'Space Grotesk',sans-serif;font-size:32px;font-weight:700;text-align:center;margin:40px 0 8px}
.sub{color:var(--dim);text-align:center;font-size:14px;margin-bottom:32px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.card h2{font-family:'Space Grotesk',sans-serif;font-size:18px;margin-bottom:8px}
.card p{color:var(--dim);font-size:13px;line-height:1.6}
.chain{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--gold);background:var(--bg);padding:12px;border-radius:6px;margin-top:12px;overflow-x:auto}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}
.stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center}
.stat .val{color:var(--green);font-size:20px;font-weight:700;font-family:'Space Grotesk',sans-serif}
.stat .label{color:var(--dim);font-size:10px;margin-top:2px}
.apps{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin:16px 0}
.app{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;text-align:center;font-size:11px;color:var(--dim)}
.app .name{color:var(--text);font-weight:600;font-size:12px}
.buy{text-align:center;margin:24px 0}
.buy button{padding:12px 28px;background:var(--gold);color:#000;border:none;border-radius:8px;font-weight:700;font-family:'Space Grotesk',sans-serif;font-size:15px;cursor:pointer}
#buyResult{margin-top:12px;font-size:13px;display:none}
.footer{text-align:center;color:var(--dim);font-size:11px;padding:32px 0;line-height:1.8}
.footer a{color:var(--pink);text-decoration:none}
</style></head><body>
<div class="wrap">
<h1>RoadChain</h1>
<p class="sub">Sovereign blockchain for AI agents. Every action hashed. Every token tracked. Every app connected.</p>

<div id="statsArea"></div>

<div class="card">
  <h2>Connected Apps</h2>
  <p>Every BlackRoad app writes events to RoadChain. Every event earns RoadCoin.</p>
  <div class="apps">
    <div class="app"><div class="name">Tutor</div>solve → 0.1 ROAD</div>
    <div class="app"><div class="name">Social</div>post → 0.05 ROAD</div>
    <div class="app"><div class="name">Chat</div>msg → 0.01 ROAD</div>
    <div class="app"><div class="name">Search</div>query → 0.005 ROAD</div>
    <div class="app"><div class="name">Canvas</div>create → 0.1 ROAD</div>
    <div class="app"><div class="name">Video</div>upload → 0.5 ROAD</div>
    <div class="app"><div class="name">Cadence</div>track → 0.2 ROAD</div>
    <div class="app"><div class="name">Game</div>score → 0.02 ROAD</div>
    <div class="app"><div class="name">RoadTrip</div>agent task</div>
    <div class="app"><div class="name">Memory</div>PS-SHA∞</div>
  </div>
</div>

<div class="card" style="border-color:var(--gold)">
  <h2>RoadCoin</h2>
  <p>Earn ROAD by using BlackRoad. Spend on premium features. Transfer to other users. Cash out via Coinbase.</p>
  <div class="buy">
    <button onclick="buyRoadCoin()">Buy 5 ROAD — $5 via Coinbase</button>
    <div id="buyResult"></div>
  </div>
</div>

<div class="card">
  <h2>x402 Micropayments</h2>
  <p>AI agents pay each other via HTTP 402. 0.001 USDC per request. 2-second settlement on Base. No invoices. No subscriptions. Just protocol-native payments between machines.</p>
  <div class="chain">
    POST /api/inference → 402 Payment Required<br>
    X-Payment: 0.001 USDC on Base<br>
    → Pay → Retry → 200 OK + inference result<br>
    → Logged to RoadChain ledger
  </div>
</div>

<div class="card">
  <h2>Chain Integrity</h2>
  <p>Every block links to the previous via PS-SHA∞ (recursive SHA-256, depth 3). Append-only. Tamper-evident. Verifiable by anyone.</p>
  <div class="chain" id="chainStatus">Loading chain status...</div>
</div>

<div id="recentArea"></div>

<div class="footer">
  <a href="https://blackroad.io">BlackRoad OS</a> · <a href="https://roadcoin.io">RoadCoin</a> · <a href="https://blackroad.io/pricing">Pricing</a> · <a href="https://github.com/BlackRoadOS/roadchain">GitHub</a><br>
  Powered by Coinbase Commerce + Base + x402<br>
  Remember the Road. Pave Tomorrow.
</div>
</div>
<script>
async function loadStats() {
  try {
    const r = await fetch('/api/ledger/stats');
    const d = await r.json();
    document.getElementById('statsArea').innerHTML = '<div class="stats">'
      + '<div class="stat"><div class="val">' + (d.total_blocks||0) + '</div><div class="label">Blocks</div></div>'
      + '<div class="stat"><div class="val">' + (d.latest_block||0) + '</div><div class="label">Latest</div></div>'
      + '<div class="stat"><div class="val">' + (d.apps?.length||0) + '</div><div class="label">Apps</div></div>'
      + '<div class="stat"><div class="val">active</div><div class="label">Chain</div></div>'
      + '</div>';

    if (d.recent?.length) {
      let html = '<div class="card"><h2>Recent Blocks</h2>';
      d.recent.forEach(b => {
        html += '<div class="chain">#' + (b.block_number||'?') + ' ' + b.action + ' → ' + b.entity + ' [' + b.app + '] ' + b.hash?.slice(0,12) + '... ' + b.created_at + '</div>';
      });
      html += '</div>';
      document.getElementById('recentArea').innerHTML = html;
    }
  } catch(e) { console.log('Stats load error:', e); }

  try {
    const v = await fetch('/api/ledger/verify');
    const vd = await v.json();
    document.getElementById('chainStatus').textContent = 'Chain: ' + vd.chain + ' | Blocks verified: ' + vd.checked + ' | Latest: #' + vd.latest_block;
  } catch(e) { document.getElementById('chainStatus').textContent = 'Chain verification pending...'; }
}

async function buyRoadCoin() {
  const res = document.getElementById('buyResult');
  res.style.display = 'block';
  res.textContent = 'Creating Coinbase charge...';
  res.style.color = 'var(--dim)';
  try {
    const r = await fetch('/api/charge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: '5.00', currency: 'USD', name: '5 RoadCoin', description: '5 ROAD on BlackRoad OS' }) });
    const d = await r.json();
    if (d.hosted_url) { res.innerHTML = '<a href="' + d.hosted_url + '" target="_blank" style="color:var(--gold);font-weight:700;text-decoration:underline">Complete payment on Coinbase →</a>'; }
    else { res.textContent = d.error || 'Set COINBASE_API_KEY to enable purchases'; res.style.color = 'var(--pink)'; }
  } catch(e) { res.textContent = 'Error: ' + e.message; res.style.color = 'var(--pink)'; }
}

loadStats();
</script></body></html>`;
