// POST /api/lead — recebe o lead do formulário, grava na planilha (Apps Script)
// e, se configurado, envia o evento Lead pela API de Conversões da Meta.
const crypto = require("crypto");

const SHEETS_URL = process.env.SHEETS_URL ||
  "https://script.google.com/macros/s/AKfycbzsztMZg4aWCliwYl7twoYfpDgu-3dMM8Wef6wqTZtILH6bRJ0u405yO4GnCV_uOaQK/exec";
const PIXEL_ID = process.env.META_PIXEL_ID || "567992274670139";
const CAPI_TOKEN = process.env.META_CAPI_TOKEN || "";           // opcional
const CAPI_VERSION = process.env.META_API_VERSION || "v23.0";
const TEST_CODE = process.env.META_TEST_EVENT_CODE || "";       // opcional (aba Eventos de teste)

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

async function postWithTimeout(url, body, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

async function saveToSheet(payload) {
  const body = JSON.stringify(payload);
  let lastErr = "";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await postWithTimeout(SHEETS_URL, body, 4000);
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (r.ok && j && j.ok === true) return { ok: true };
      lastErr = "resposta inesperada (" + r.status + "): " + txt.slice(0, 120).replace(/\s+/g, " ");
    } catch (e) { lastErr = String(e && e.name === "AbortError" ? "timeout" : (e && e.message) || e); }
  }
  return { ok: false, error: lastErr };
}

async function sendCapi(d, req) {
  if (!CAPI_TOKEN) return { skipped: true };
  const ip = str(req.headers["x-forwarded-for"], 100).split(",")[0].trim();
  const parts = String(d.nome).toLowerCase().split(/\s+/);
  const user = {
    ph: [sha(d.whatsapp)], fn: [sha(norm(parts[0]))], ct: [sha(norm(d.cidade))], country: [sha("br")],
    client_user_agent: str(req.headers["user-agent"], 400)
  };
  if (parts.length > 1) user.ln = [sha(norm(parts[parts.length - 1]))];
  if (ip) user.client_ip_address = ip;
  if (d.fbp) user.fbp = str(d.fbp, 100);
  if (d.fbc) user.fbc = str(d.fbc, 200);
  const evt = {
    event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: d.event_id,
    action_source: "website", event_source_url: str(d.page_url, 500).split("#")[0], user_data: user,
    custom_data: { content_name: "Especializacao Cirurgias Esteticas da Face", content_category: "Curso", cta_location: str(d.cta_location, 60) }
  };
  const payload = { data: [evt] };
  if (TEST_CODE) payload.test_event_code = TEST_CODE;
  try {
    const r = await fetch("https://graph.facebook.com/" + CAPI_VERSION + "/" + PIXEL_ID + "/events?access_token=" + encodeURIComponent(CAPI_TOKEN), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    if (!r.ok) return { ok: false, error: "status " + r.status + " " + (await r.text()).slice(0, 200) };
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ok: true, sheet: !!SHEETS_URL, capi: !!CAPI_TOKEN });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

  let d = req.body;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { d = null; } }
  if (!d || typeof d !== "object") return res.status(400).json({ ok: false, error: "body" });

  const clean = {
    nome: str(d.nome, 80).trim(), whatsapp: str(d.whatsapp, 20).replace(/\D/g, ""), cidade: str(d.cidade, 60).trim(),
    cta_location: str(d.cta_location, 60), utm_source: str(d.utm_source, 200), utm_medium: str(d.utm_medium, 200),
    utm_campaign: str(d.utm_campaign, 200), utm_content: str(d.utm_content, 200), utm_term: str(d.utm_term, 200),
    fbclid: str(d.fbclid, 300), page_url: str(d.page_url, 1000), referrer: str(d.referrer, 500),
    event_id: str(d.event_id, 80), fbp: str(d.fbp, 100), fbc: str(d.fbc, 200)
  };
  const okPhone = /^55\d{10,11}$/.test(clean.whatsapp);
  if (clean.nome.length < 2 || clean.cidade.length < 2 || !okPhone) return res.status(400).json({ ok: false, error: "dados invalidos" });

  const sheet = await saveToSheet(clean);
  let capi = { skipped: true };
  if (d.fire_lead && clean.event_id) capi = await sendCapi(clean, req);

  if (!sheet.ok) console.error("[lead] FALHA ao gravar na planilha:", sheet.error, "| tel final", clean.whatsapp.slice(-4), "| botao", clean.cta_location);
  if (capi && capi.ok === false) console.error("[lead] FALHA CAPI:", capi.error);

  return res.status(sheet.ok ? 200 : 502).json({ ok: sheet.ok, capi: capi.ok === true });
};
