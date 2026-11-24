// SFFC Predictor — one function serves the whole API at /api/*
import crypto from "node:crypto";
import { db, getConfig, getPlayers, listGwNumbers, getGw, getPreds, slug } from "../../lib/store.mjs";
import { gwRows, parseScore } from "../../lib/scoring.mjs";
import { gwFromFpl, refreshScores } from "../../lib/fpl.mjs";
import { sendMail, mailEnabled, predictionEmail } from "../../lib/mail.mjs";

export const config = { path: "/api/*" };

/* ---------------- helpers ---------------- */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

const now = () => Date.now();
const isLocked = (gw) => gw.status === "final" || (gw.deadline && now() >= Date.parse(gw.deadline));
const hashPin = (salt, pin) => crypto.createHash("sha256").update(`${salt}:${String(pin).trim()}`).digest("hex");
const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const maskEmail = (e) => (e ? e.replace(/^(.{2}).*(@.*)$/, "$1•••$2") : "");

function publicGw(gw) {
  if (!gw) return null;
  const { gw: n, deadline, status, matches = [], questions = [], scenarios = [], note } = gw;
  return {
    gw: n, deadline, status, note: note || "",
    matches: matches.map(({ id, home, away, kickoff, h, a, started, finished }) => ({ id, home, away, kickoff, h, a, started, finished })),
    questions: questions.map(({ id, text, type, options, points, answer, tolerance }) => ({ id, text, type, options, points, answer, tolerance })),
    scenarios: scenarios.map(({ n, text, hit, points }) => ({ n, text, hit, points })),
  };
}

async function savePlayers(players) { await (await db()).set("players", players); }

async function checkPlayer(pid, pin) {
  const players = await getPlayers();
  const p = players.find((x) => x.id === pid && x.active !== false);
  if (!p) fail(404, "Player not found");
  const d = await db();
  const f = (await d.get(`fail/${pid}`)) || { n: 0, until: 0 };
  if (f.until > now()) fail(429, `Too many wrong passkeys. Try again in ${Math.ceil((f.until - now()) / 60000)} min.`);
  if (!p.pinHash) fail(403, "No passkey set yet. Use “Email me my passkey” or ask the admin.");
  if (hashPin(p.salt, pin) !== p.pinHash) {
    f.n += 1;
    if (f.n >= 5) { f.until = now() + 15 * 60 * 1000; f.n = 0; }
    await d.set(`fail/${pid}`, f);
    fail(401, "Wrong passkey");
  }
  if (f.n) await d.set(`fail/${pid}`, { n: 0, until: 0 });
  return p;
}

/** Pull live FPL scores for a gameweek that has started and isn't locked as final. */
async function maybeRefresh(gw) {
  if (!gw || gw.status === "final" || !gw.deadline || now() < Date.parse(gw.deadline)) return gw;
  if (!gw.matches?.some((m) => m.fplId && !m.manual && !m.finished)) return gw;
  if (gw.scoresFetchedAt && now() - Date.parse(gw.scoresFetchedAt) < 90 * 1000) return gw;
  try {
    await refreshScores(gw);
    await (await db()).set(`gw/${gw.gw}`, gw);
  } catch (e) { console.error("refresh failed", e.message); }
  return gw;
}

function slimRows(rows) {
  return rows.map(({ perMatch, answersOk, ...r }) => r);
}

/** Everything about a locked gameweek: gw, preds, rows. Uses the frozen snapshot once finalised. */
async function lockedGwData(n, players, cfg) {
  const d = await db();
  const fin = await d.get(`final/${n}`);
  if (fin) return fin;
  const gw = await maybeRefresh(await getGw(n));
  const preds = await getPreds(n);
  return { gw, preds, rows: gwRows(gw, preds, players, cfg.points) };
}

function validatePrediction(gw, cfg, body) {
  const scores = {};
  for (const m of gw.matches) {
    const v = body.scores?.[m.id];
    const p = parseScore(v);
    if (!p || p[0] > 20 || p[1] > 20) fail(400, `Enter a score for ${m.home} v ${m.away}`);
    scores[m.id] = `${p[0]}-${p[1]}`;
  }
  if (!gw.matches.some((m) => m.id === body.joker)) fail(400, "Pick your Joker match");
  const answers = {};
  for (const q of gw.questions || []) {
    const v = body.answers?.[q.id];
    if (v == null || String(v).trim() === "") fail(400, `Answer: ${q.text}`);
    if (q.type === "number" && !Number.isFinite(Number(v))) fail(400, `“${q.text}” needs a number`);
    const opts = q.type === "match" ? gw.matches.map((m) => `${m.home} v ${m.away}`) : q.type === "choice" ? q.options || [] : null;
    if (opts && opts.length && !opts.includes(String(v))) fail(400, `Pick one of the options for “${q.text}”`);
    answers[q.id] = String(v).trim();
  }
  const valid = new Set((gw.scenarios || []).map((s) => Number(s.n)));
  const picks = [...new Set((body.scenarios || []).map(Number))].filter((n) => valid.has(n));
  const need = Math.min(cfg.scenarioPicks || 3, valid.size);
  if (picks.length !== need) fail(400, `Pick exactly ${need} scenarios`);
  return { scores, joker: body.joker, answers, scenarios: picks.sort((a, b) => a - b) };
}

/* ---------------- public routes ---------------- */
async function state() {
  const [cfg, players, nums] = await Promise.all([getConfig(), getPlayers(), listGwNumbers()]);
  const gws = (await Promise.all(nums.map(getGw))).filter((g) => g && g.status !== "draft");
  const open = gws.filter((g) => g.status === "open" && !isLocked(g)).sort((a, b) => a.gw - b.gw)[0];
  const current = open ? open.gw : gws.length ? gws[gws.length - 1].gw : null;
  return {
    config: { name: cfg.name, season: cfg.season, scenarioPicks: cfg.scenarioPicks, phases: cfg.phases, points: cfg.points },
    players: players.filter((p) => p.active !== false).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    gws: gws.map((g) => ({ gw: g.gw, status: g.status, deadline: g.deadline, locked: isLocked(g), matches: g.matches?.length || 0 })),
    current, mail: mailEnabled(), now: new Date().toISOString(),
  };
}

async function gwView(n) {
  const [cfg, players] = await Promise.all([getConfig(), getPlayers()]);
  let gw = await getGw(n);
  if (!gw || gw.status === "draft") fail(404, "Gameweek not published yet");
  const locked = isLocked(gw);
  if (!locked) {
    const keys = await (await db()).list(`pred/${n}/`);
    return { gw: publicGw(gw), locked, submitted: keys.map((k) => k.split("/")[2]) };
  }
  const data = await lockedGwData(n, players, cfg);
  return { gw: publicGw(data.gw), locked, final: gw.status === "final", submitted: Object.keys(data.preds), preds: data.preds, rows: data.rows };
}

async function tables() {
  const [cfg, players, nums] = await Promise.all([getConfig(), getPlayers(), listGwNumbers()]);
  const gws = (await Promise.all(nums.map(getGw))).filter((g) => g && g.status !== "draft" && isLocked(g));
  const out = await Promise.all(gws.map(async (g) => {
    const data = await lockedGwData(g.gw, players, cfg);
    return {
      gw: g.gw, final: g.status === "final",
      live: g.status !== "final" && (data.gw.matches || []).some((m) => !m.finished),
      questions: (data.gw.questions || []).map(({ id, text, points }) => ({ id, text, points })),
      rows: slimRows(data.rows),
    };
  }));
  return { gws: out, players: players.map(({ id, name }) => ({ id, name })) };
}

async function sendPin(body) {
  if (!mailEnabled()) fail(400, "Email isn't set up on this site — ask the admin for your passkey.");
  const players = await getPlayers();
  const p = players.find((x) => x.id === body.pid && x.active !== false);
  if (!p) fail(404, "Player not found");
  if (!p.email) fail(400, "No email on file for you — ask the admin.");
  if (p.pinSentAt && now() - Date.parse(p.pinSentAt) < 10 * 60 * 1000) fail(429, "A passkey was emailed in the last 10 minutes — check your inbox and spam.");
  const pin = newPin();
  p.salt = crypto.randomBytes(8).toString("hex");
  p.pinHash = hashPin(p.salt, pin);
  p.pinSentAt = new Date().toISOString();
  const sent = await sendMail(p.email, "Your SFFC Predictor passkey",
    `<div style="font-family:Arial,sans-serif;font-size:15px">Hi ${p.name},<br><br>Your passkey is <b style="font-size:22px;letter-spacing:3px">${pin}</b><br><br>Use it with your name to submit predictions. Any older passkey no longer works.</div>`);
  if (!sent) fail(500, "Couldn't send the email — ask the admin.");
  await savePlayers(players);
  return { ok: true, to: maskEmail(p.email) };
}

async function predict(body, req) {
  const cfg = await getConfig();
  const p = await checkPlayer(body.pid, body.pin);
  const gw = await getGw(Number(body.gw));
  if (!gw || gw.status !== "open") fail(400, "This gameweek isn't open for predictions");
  if (isLocked(gw)) fail(403, "The deadline has passed — predictions are locked");
  const pred = { ...validatePrediction(gw, cfg, body), name: p.name, ts: new Date().toISOString() };
  await (await db()).set(`pred/${gw.gw}/${p.id}`, pred);
  let emailed = false;
  if (body.email !== false && p.email) {
    const site = new URL(req.url).origin;
    emailed = await sendMail(p.email, `SFFC Predictor — GW${gw.gw} prediction saved`, predictionEmail(p.name, gw, pred, site));
  }
  return { ok: true, savedAt: pred.ts, emailed };
}

/* ---------------- admin routes ---------------- */
function checkAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) fail(500, "ADMIN_KEY is not set in Netlify environment variables");
  const given = req.headers.get("x-admin-key") || "";
  const a = Buffer.from(given), b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(401, "Wrong admin key");
}

function cleanGw(input, existing) {
  const n = Number(input.gw);
  if (!Number.isInteger(n) || n < 1 || n > 38) fail(400, "GW must be 1–38");
  const old = Object.fromEntries((existing?.matches || []).map((m) => [m.id, m]));
  const matches = (input.matches || []).map((m) => {
    const home = String(m.home || "").trim().toUpperCase(), away = String(m.away || "").trim().toUpperCase();
    if (!home || !away) fail(400, "Every match needs two teams");
    const id = m.id || `${home}-${away}`.toLowerCase();
    const prev = old[id] || {};
    const hasScore = m.h !== "" && m.h != null && m.a !== "" && m.a != null;
    return {
      id, home, away, fplId: m.fplId ?? prev.fplId ?? null, kickoff: m.kickoff ?? prev.kickoff ?? null,
      h: hasScore ? Number(m.h) : null, a: hasScore ? Number(m.a) : null,
      manual: !!m.manual, started: hasScore || !!prev.started, finished: m.finished ?? prev.finished ?? false,
    };
  });
  if (new Set(matches.map((m) => m.id)).size !== matches.length) fail(400, "The same match is listed twice");
  const questions = (input.questions || []).filter((q) => String(q.text || "").trim()).map((q, i) => ({
    id: q.id || `b${i + 1}`, text: String(q.text).trim(), type: ["number", "text", "choice", "match"].includes(q.type) ? q.type : "text",
    options: q.type === "choice" ? (Array.isArray(q.options) ? q.options : String(q.options || "").split(/\n|,/)).map((s) => s.trim()).filter(Boolean) : [],
    points: Number(q.points) || 0, answer: q.answer === "" || q.answer == null ? null : String(q.answer).trim(),
    tolerance: q.tolerance === "" || q.tolerance == null ? null : Number(q.tolerance),
  }));
  const scenarios = (input.scenarios || []).filter((s) => String(s.text || "").trim()).map((s, i) => ({
    n: Number(s.n) || i + 1, text: String(s.text).trim(),
    hit: s.hit === true || s.hit === "y" ? true : s.hit === false || s.hit === "n" ? false : null,
    points: s.points === "" || s.points == null ? null : Number(s.points),
  }));
  const deadline = input.deadline ? new Date(input.deadline).toISOString() : null;
  return {
    ...(existing || {}), gw: n, deadline, note: input.note || "",
    status: ["draft", "open", "final"].includes(input.status) ? input.status : existing?.status || "draft",
    matches, questions, scenarios, updatedAt: new Date().toISOString(),
  };
}

async function admin(action, body, req) {
  checkAdmin(req);
  const d = await db();
  const cfg = await getConfig();
  const players = await getPlayers();
  const n = Number(body.gw);

  switch (action) {
    case "overview": {
      const nums = await listGwNumbers();
      const gws = await Promise.all(nums.map(getGw));
      const counts = {};
      await Promise.all(nums.map(async (g) => { counts[g] = (await d.list(`pred/${g}/`)).length; }));
      return {
        config: cfg, mail: mailEnabled(), gws, counts,
        players: players.map(({ id, name, email, active, pinHash, pinSentAt }) => ({ id, name, email, active: active !== false, hasPin: !!pinHash, pinSentAt })),
      };
    }
    case "save-config": {
      const c = body.config || {};
      const next = { ...cfg, name: c.name || cfg.name, season: c.season || cfg.season, scenarioPicks: Number(c.scenarioPicks) || cfg.scenarioPicks, phases: Array.isArray(c.phases) ? c.phases : cfg.phases };
      await d.set("config", next);
      return { ok: true, config: next };
    }
    case "save-player": {
      const name = String(body.name || "").trim();
      if (!name) fail(400, "Name is required");
      let p = body.id ? players.find((x) => x.id === body.id) : null;
      if (!p) {
        const id = slug(name);
        if (players.some((x) => x.id === id)) fail(400, "A player with that name already exists");
        p = { id, name };
        players.push(p);
      }
      p.name = name;
      p.email = String(body.email || "").trim().toLowerCase();
      p.active = body.active !== false;
      await savePlayers(players);
      return { ok: true, id: p.id };
    }
    case "reset-pin": {
      const list = body.pid === "*missing" ? players.filter((p) => !p.pinHash && p.active !== false)
        : body.pid === "*all" ? players.filter((p) => p.active !== false) : players.filter((p) => p.id === body.pid);
      if (!list.length) fail(400, "No players to reset");
      const pins = list.map((p) => {
        const pin = newPin();
        p.salt = crypto.randomBytes(8).toString("hex");
        p.pinHash = hashPin(p.salt, pin);
        return { pid: p.id, name: p.name, pin };
      });
      await savePlayers(players);
      return { ok: true, pins };
    }
    case "fpl-import": {
      if (!n) fail(400, "Which GW?");
      const f = await gwFromFpl(n);
      if (!f.matches.length) fail(404, `FPL has no fixtures for GW${n}`);
      const ex = (await getGw(n)) || { gw: n, status: "draft", questions: [], scenarios: [] };
      if (ex.status === "final") fail(400, "This GW is finalised — unlock it first");
      const manual = Object.fromEntries((ex.matches || []).filter((m) => m.manual).map((m) => [m.id, m]));
      ex.matches = f.matches.map((m) => manual[m.id] || m);
      ex.deadline = f.deadline;
      ex.teams = f.teams;
      ex.updatedAt = new Date().toISOString();
      await d.set(`gw/${n}`, ex);
      return { ok: true, gw: ex };
    }
    case "save-gw": {
      const ex = await getGw(Number(body.gw?.gw));
      if (ex?.status === "final") fail(400, "This GW is finalised — unlock it before editing");
      const gw = cleanGw(body.gw || {}, ex);
      if (gw.status === "final") gw.status = "open"; // finalising goes through "finalize"
      await d.set(`gw/${gw.gw}`, gw);
      return { ok: true, gw };
    }
    case "refresh": {
      const gw = await getGw(n);
      if (!gw) fail(404, "No such GW");
      await refreshScores(gw);
      await d.set(`gw/${n}`, gw);
      return { ok: true, gw };
    }
    case "finalize": {
      const gw = await getGw(n);
      if (!gw) fail(404, "No such GW");
      const preds = await getPreds(n);
      const rows = gwRows(gw, preds, players, cfg.points);
      gw.status = "final";
      gw.finalizedAt = new Date().toISOString();
      await d.set(`final/${n}`, { gw, preds, rows, at: gw.finalizedAt });
      await d.set(`gw/${n}`, gw);
      return { ok: true, rows: slimRows(rows) };
    }
    case "unlock": {
      const gw = await getGw(n);
      if (!gw) fail(404, "No such GW");
      gw.status = "open";
      delete gw.finalizedAt;
      await d.del(`final/${n}`);
      await d.set(`gw/${n}`, gw);
      return { ok: true };
    }
    case "delete-gw": {
      const keys = await d.list(`pred/${n}/`);
      if (keys.length && !body.force) fail(400, `${keys.length} predictions exist for GW${n}. Tick “force” to delete everything.`);
      await Promise.all([...keys.map((k) => d.del(k)), d.del(`gw/${n}`), d.del(`final/${n}`)]);
      return { ok: true };
    }
    case "preds": {
      const preds = await getPreds(n);
      return { preds };
    }
    case "set-pred": {
      // Admin override: enter or fix a prediction for a player at any time (e.g. sent on WhatsApp).
      const gw = await getGw(n);
      if (!gw) fail(404, "No such GW");
      if (gw.status === "final") fail(400, "This GW is finalised — unlock it first");
      const p = players.find((x) => x.id === body.pid);
      if (!p) fail(404, "Player not found");
      const pred = { ...validatePrediction(gw, cfg, body.pred || {}), name: p.name, ts: new Date().toISOString(), byAdmin: true };
      await d.set(`pred/${n}/${p.id}`, pred);
      return { ok: true };
    }
    case "delete-pred": {
      await d.del(`pred/${n}/${body.pid}`);
      return { ok: true };
    }
    case "import-history": {
      // Loads the seed file built from the old Google Sheets: players + finished GWs with predictions.
      const data = body.data || {};
      const byId = Object.fromEntries(players.map((p) => [p.id, p]));
      for (const p of data.players || []) {
        if (!byId[p.id]) { byId[p.id] = { id: p.id, name: p.name, email: p.email || "", active: true }; players.push(byId[p.id]); }
        else if (!byId[p.id].email && p.email) byId[p.id].email = p.email;
      }
      await savePlayers(players);
      let gwCount = 0, predCount = 0;
      for (const g of data.gws || []) {
        const gw = { ...g.gw, status: "final", finalizedAt: new Date().toISOString(), imported: true };
        const rows = gwRows(gw, g.preds, players, cfg.points);
        await d.set(`gw/${gw.gw}`, gw);
        for (const [pid, pred] of Object.entries(g.preds)) { await d.set(`pred/${gw.gw}/${pid}`, pred); predCount++; }
        await d.set(`final/${gw.gw}`, { gw, preds: g.preds, rows, at: gw.finalizedAt });
        gwCount++;
      }
      return { ok: true, players: players.length, gws: gwCount, preds: predCount };
    }
    case "export": {
      const keys = (await d.list("")).filter((k) => !k.startsWith("fail/"));
      const out = {};
      await Promise.all(keys.map(async (k) => { out[k] = await d.get(k); }));
      return { exportedAt: new Date().toISOString(), data: out };
    }
    case "restore": {
      const data = body.data?.data || body.data || {};
      const keys = Object.keys(data);
      if (!keys.length) fail(400, "Backup file is empty");
      for (const k of keys) await d.set(k, data[k]);
      return { ok: true, keys: keys.length };
    }
    default:
      fail(404, "Unknown admin action");
  }
}

/* ---------------- router ---------------- */
export default async (req) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (req.method === "GET" && parts[0] === "state") return json(await state());
    if (req.method === "GET" && parts[0] === "gw" && parts[1]) return json(await gwView(Number(parts[1])));
    if (req.method === "GET" && parts[0] === "tables") return json(await tables());
    if (req.method === "POST" && parts[0] === "login") {
      const p = await checkPlayer(body.pid, body.pin);
      return json({ ok: true, name: p.name });
    }
    if (req.method === "POST" && parts[0] === "my") {
      await checkPlayer(body.pid, body.pin);
      return json({ pred: (await (await db()).get(`pred/${Number(body.gw)}/${body.pid}`)) || null });
    }
    if (req.method === "POST" && parts[0] === "predict") return json(await predict(body, req));
    if (req.method === "POST" && parts[0] === "send-pin") return json(await sendPin(body));
    if (req.method === "POST" && parts[0] === "admin" && parts[1]) return json(await admin(parts[1], body, req));
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Server error: " + e.message }, 500);
  }
};
