// Storage: Netlify Blobs in production. Set LOCAL_STORE_DIR to use plain JSON files instead (local testing).
//
// Keys
//   config                 league settings
//   players                [{ id, name, email, salt, pinHash, active }]
//   gw/<n>                 gameweek: deadline, matches, questions, scenarios, status
//   pred/<n>/<playerId>    one player's prediction for a gameweek
//   final/<n>              locked snapshot of a finished gameweek (gw + preds + rows). Never rewritten
//                          unless an admin unlocks it on purpose.
//   fail/<playerId>        wrong-passkey counter (lockout)

import { promises as fs } from "node:fs";
import path from "node:path";

let impl = null;

function fileStore(dir) {
  const file = (k) => path.join(dir, encodeURIComponent(k) + ".json");
  return {
    async get(k) {
      try { return JSON.parse(await fs.readFile(file(k), "utf8")); } catch { return null; }
    },
    async set(k, v) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file(k), JSON.stringify(v)); },
    async del(k) { try { await fs.unlink(file(k)); } catch {} },
    async list(prefix) {
      try {
        return (await fs.readdir(dir)).filter((f) => f.endsWith(".json"))
          .map((f) => decodeURIComponent(f.slice(0, -5))).filter((k) => k.startsWith(prefix));
      } catch { return []; }
    },
  };
}

async function blobStore() {
  const { getStore } = await import("@netlify/blobs");
  const s = getStore({ name: "sffc-predictor", consistency: "strong" });
  return {
    get: (k) => s.get(k, { type: "json" }),
    set: (k, v) => s.setJSON(k, v),
    del: (k) => s.delete(k),
    async list(prefix) {
      const out = [];
      for await (const page of s.list({ prefix, paginate: true })) out.push(...page.blobs.map((b) => b.key));
      return out;
    },
  };
}

export async function db() {
  if (!impl) impl = process.env.LOCAL_STORE_DIR ? fileStore(process.env.LOCAL_STORE_DIR) : await blobStore();
  return impl;
}

export const DEFAULT_CONFIG = {
  name: "SFFC Predictor League",
  season: "2026-27",
  scenarioPicks: 3,
  requirePasskey: false, // players just pick their name; switch on in Admin → Settings
  points: { pp: 3, gd: 1, cw: 0.5 },
  phases: [
    { id: "p1", name: "Phase 1", from: 1, to: 19 },
    { id: "p2", name: "Phase 2", from: 20, to: 38 },
  ],
};

export async function getConfig() {
  const d = await db();
  return { ...DEFAULT_CONFIG, ...((await d.get("config")) || {}) };
}

export async function getPlayers() {
  return (await (await db()).get("players")) || [];
}

export async function listGwNumbers() {
  const keys = await (await db()).list("gw/");
  return keys.map((k) => Number(k.split("/")[1])).filter(Number.isFinite).sort((a, b) => a - b);
}

export async function getGw(n) {
  return (await db()).get(`gw/${n}`);
}

export async function getPreds(n) {
  const d = await db();
  const keys = await d.list(`pred/${n}/`);
  const vals = await Promise.all(keys.map((k) => d.get(k)));
  const out = {};
  keys.forEach((k, i) => { if (vals[i]) out[k.split("/")[2]] = vals[i]; });
  return out;
}

export const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
