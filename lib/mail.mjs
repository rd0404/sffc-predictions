// Optional Gmail emails (same setup as the SFFC site). Set GMAIL_USER and GMAIL_APP_PASSWORD in Netlify;
// without them the site works and simply skips the emails.
export const mailEnabled = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

export async function sendMail(to, subject, html) {
  if (!mailEnabled() || !to) return false;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const t = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await t.sendMail({ from: `"SFFC Predictor" <${process.env.GMAIL_USER}>`, to, subject, html });
    return true;
  } catch (e) {
    console.error("mail failed", e.message);
    return false;
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function predictionEmail(name, gw, pred, siteUrl) {
  const rows = gw.matches.map((m) => {
    const s = pred.scores[m.id] || "–";
    const j = pred.joker === m.id ? " 🃏" : "";
    return `<tr><td style="padding:4px 10px">${esc(m.home)} v ${esc(m.away)}</td><td style="padding:4px 10px;font-weight:700">${esc(s)}${j}</td></tr>`;
  }).join("");
  const qs = (gw.questions || []).map((q) => `<li>${esc(q.text)} — <b>${esc(pred.answers?.[q.id] ?? "–")}</b></li>`).join("");
  const sc = (gw.scenarios || []).filter((s) => (pred.scenarios || []).includes(s.n)).map((s) => `<li>${esc(s.text)}</li>`).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
  <h2 style="margin:0 0 6px">GW${gw.gw} prediction saved ✅</h2>
  <p>Hi ${esc(name)}, here's what you submitted. You can change it on the site until the deadline.</p>
  <table style="border-collapse:collapse;background:#f6f3fb">${rows}</table>
  ${qs ? `<p style="margin-top:12px"><b>Bonus</b></p><ul>${qs}</ul>` : ""}
  ${sc ? `<p><b>Scenarios</b></p><ul>${sc}</ul>` : ""}
  ${siteUrl ? `<p><a href="${esc(siteUrl)}">Open the SFFC Predictor</a></p>` : ""}
  </div>`;
}
