// Fixtures, deadlines and live scorelines from the public FPL API (server-side, so no CORS issues).
const BASE = "https://fantasy.premierleague.com/api";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; sffc-predictor/1.0)", Accept: "application/json" };

async function get(path, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers: HEADERS });
      if (r.ok) return r.json();
      last = new Error(`FPL ${path} → HTTP ${r.status}`);
      if (r.status < 500) break; // 503s happen right after deadlines; retry those
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  throw last;
}

let bootCache = null;
export async function bootstrap() {
  if (bootCache && Date.now() - bootCache.at < 10 * 60 * 1000) return bootCache.data;
  const b = await get("/bootstrap-static/");
  const data = {
    teams: Object.fromEntries(b.teams.map((t) => [t.id, { short: t.short_name, name: t.name }])),
    events: Object.fromEntries(b.events.map((e) => [e.id, { deadline: e.deadline_time, finished: e.finished, current: e.is_current, next: e.is_next }])),
  };
  bootCache = { at: Date.now(), data };
  return data;
}

/** Build the match list + deadline for a gameweek from FPL. */
export async function gwFromFpl(n) {
  const [boot, fx] = await Promise.all([bootstrap(), get(`/fixtures/?event=${n}`)]);
  fx.sort((a, b) => String(a.kickoff_time).localeCompare(String(b.kickoff_time)) || a.id - b.id);
  const matches = fx.map((f) => {
    const home = boot.teams[f.team_h]?.short || String(f.team_h);
    const away = boot.teams[f.team_a]?.short || String(f.team_a);
    return {
      id: `${home}-${away}`.toLowerCase(), home, away, fplId: f.id, kickoff: f.kickoff_time,
      h: f.team_h_score ?? null, a: f.team_a_score ?? null,
      started: !!f.started, finished: !!(f.finished || f.finished_provisional),
    };
  });
  return { deadline: boot.events[n]?.deadline || null, matches, teams: Object.values(boot.teams).map((t) => t.short).sort() };
}

/** Pull live scores into an existing gameweek's matches (by FPL fixture id). Returns true if anything changed. */
export async function refreshScores(gw) {
  const fx = await get(`/fixtures/?event=${gw.gw}`);
  const byId = Object.fromEntries(fx.map((f) => [f.id, f]));
  let changed = false;
  for (const m of gw.matches) {
    if (m.manual) continue; // admin typed this score in; leave it alone
    const f = m.fplId ? byId[m.fplId] : null;
    if (!f) continue;
    const h = f.started ? f.team_h_score ?? null : null;
    const a = f.started ? f.team_a_score ?? null : null;
    const fin = !!(f.finished || f.finished_provisional);
    if (m.h !== h || m.a !== a || m.finished !== fin || m.started !== !!f.started) {
      Object.assign(m, { h, a, finished: fin, started: !!f.started });
      changed = true;
    }
  }
  gw.scoresFetchedAt = new Date().toISOString();
  return changed;
}
