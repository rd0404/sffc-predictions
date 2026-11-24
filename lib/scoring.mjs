// SFFC Predictor — scoring rules, matching the "Pts Weekly" formulas of the old Data Prediction sheet.
//
//  Exact score (PP) ........ 3   (no extra GD/CW points on top)
//  Goal difference (GD) .... 1   (no extra CW point on top)
//  Correct winner (CW) ..... 0.5
//  Joker ................... the joker match's points again (PP 3, GD 1, CW 0.5)
//  Bonus questions ......... each question's own points (B1 = 2, B2 = 3 by default);
//                            a number answer is right if it is within ± tolerance of the actual
//  Scenarios ............... pick 3 of 5; scenario N is worth N points if it happens, 0 if not
//  Ties .................... Total, then PP, then GD, then CW (bonus not used)

export const DEFAULT_POINTS = { pp: 3, gd: 1, cw: 0.5 };

export function parseScore(s) {
  if (s == null) return null;
  if (typeof s === "object" && s.h != null && s.a != null) return [Number(s.h), Number(s.a)];
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(s));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const sign = (x) => (x > 0) - (x < 0);

export function matchPoints(pred, h, a, pts = DEFAULT_POINTS) {
  const p = parseScore(pred);
  if (!p || h == null || a == null || h === "" || a === "") return { kind: null, pts: 0 };
  const [ph, pa] = p;
  h = Number(h); a = Number(a);
  if (ph === h && pa === a) return { kind: "PP", pts: pts.pp };
  if (ph - pa === h - a) return { kind: "GD", pts: pts.gd };
  if (sign(ph - pa) === sign(h - a)) return { kind: "CW", pts: pts.cw };
  return { kind: null, pts: 0 };
}

const num = (x) => {
  if (x == null || String(x).trim() === "") return null;
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
};

export function hasAnswer(q) {
  return q && q.answer != null && String(q.answer).trim() !== "";
}

export function answerCorrect(given, q) {
  if (!hasAnswer(q) || given == null || String(given).trim() === "") return false;
  const g = num(given), a = num(q.answer);
  if (g != null && a != null) return Math.abs(g - a) <= (num(q.tolerance) || 0);
  return String(given).trim().toLowerCase() === String(q.answer).trim().toLowerCase();
}

export function scenarioPoints(s) {
  return s.points != null ? Number(s.points) : Number(s.n);
}

/** Score one prediction for one gameweek. */
export function scorePrediction(gw, pred, pts = DEFAULT_POINTS) {
  const out = { PP: 0, GD: 0, CW: 0, matchPts: 0, J: 0, JR: null, B: 0, S: 0, SC: 0, T: 0, bonus: {}, perMatch: {} };
  if (!pred) return out;
  for (const m of gw.matches || []) {
    const r = matchPoints(pred.scores?.[m.id], m.h, m.a, pts);
    out.perMatch[m.id] = r.kind;
    if (r.kind) { out[r.kind]++; out.matchPts += r.pts; }
    if (pred.joker === m.id) { out.J = r.pts; out.JR = r.kind; }
  }
  for (const q of gw.questions || []) {
    const ok = answerCorrect(pred.answers?.[q.id], q);
    out.bonus[q.id] = hasAnswer(q) ? ok : null;
    if (ok) out.B += Number(q.points) || 0;
  }
  const picks = new Set((pred.scenarios || []).map(Number));
  for (const s of gw.scenarios || []) {
    if (picks.has(Number(s.n)) && s.hit === true) { out.S += scenarioPoints(s); out.SC++; }
  }
  out.T = round(out.matchPts + out.J + out.B + out.S);
  return out;
}

export const round = (x) => Math.round(x * 100) / 100;

export function compareRows(a, b) {
  return b.T - a.T || b.PP - a.PP || b.GD - a.GD || b.CW - a.CW || a.name.localeCompare(b.name);
}

/** Rank with ties sharing a position (same T, PP, GD, CW). */
export function rankRows(rows) {
  rows.sort(compareRows);
  rows.forEach((r, i) => {
    const p = rows[i - 1];
    r.rank = p && p.T === r.T && p.PP === r.PP && p.GD === r.GD && p.CW === r.CW ? p.rank : i + 1;
  });
  return rows;
}

/** Build the GW table rows for every prediction in a gameweek. */
export function gwRows(gw, preds, players, pts = DEFAULT_POINTS) {
  const names = Object.fromEntries((players || []).map((p) => [p.id, p.name]));
  const rows = Object.entries(preds || {}).map(([pid, pred]) => {
    const s = scorePrediction(gw, pred, pts);
    const bonus = {};
    for (const q of gw.questions || []) bonus[q.id] = s.bonus[q.id] ? Number(q.points) || 0 : 0;
    return {
      pid, name: names[pid] || pred.name || pid,
      PP: s.PP, GD: s.GD, CW: s.CW, J: s.J, JR: s.JR, B: s.B, bonus, S: s.S, SC: s.SC, T: s.T,
      perMatch: s.perMatch, answersOk: s.bonus,
    };
  });
  return rankRows(rows);
}
