// Shared helpers for the three small server functions in /api.
// No packages are needed: everything uses the fetch built into Node.

const env = () => ({
  url: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
  publicKey: (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim(),
  secretKey: (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
  resendKey: (process.env.RESEND_API_KEY || "").trim(),
  emailFrom: (process.env.EMAIL_FROM || "").trim()
});

const isEmail = s => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const isUuid = s => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function readBody(req) {
  try {
    const b = req.body;
    if (b && typeof b === "object") return b;
    if (typeof b === "string" && b) return JSON.parse(b);
  } catch (e) { /* malformed JSON */ }
  return {};
}

// Supabase's new keys (sb_...) go in the apikey header only. The older JWT keys
// also go in Authorization. A signed-in person's token always goes in Authorization.
function headers(key, userToken) {
  const h = { apikey: key, "Content-Type": "application/json" };
  if (userToken) h.Authorization = "Bearer " + userToken;
  else if (!key.startsWith("sb_")) h.Authorization = "Bearer " + key;
  return h;
}

async function supa(path, opts) {
  const o = opts || {};
  const e = env();
  const h = headers(o.key || e.publicKey, o.userToken);
  if (o.prefer) h.Prefer = o.prefer;
  const r = await fetch(e.url + path, { method: o.method || "GET", headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  let data = null;
  const text = await r.text();
  if (text) { try { data = JSON.parse(text); } catch (err) { data = text; } }
  return { ok: r.ok, status: r.status, data };
}

function errorText(result, fallback) {
  const d = result && result.data;
  if (d && typeof d === "object") return d.msg || d.message || d.error_description || d.error || fallback;
  return fallback;
}

function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

// Who is calling, according to Supabase (never according to the browser).
async function caller(req) {
  const token = bearer(req);
  if (!token) return null;
  const u = await supa("/auth/v1/user", { userToken: token });
  if (!u.ok || !u.data || !u.data.id) return null;
  const p = await supa("/rest/v1/profiles?select=id,role,name,email&id=eq." + encodeURIComponent(u.data.id), { userToken: token });
  const profile = p.ok && Array.isArray(p.data) ? p.data[0] : null;
  return { id: u.data.id, token, role: profile ? profile.role : null, name: profile ? profile.name : "" };
}

// Common start for the owner-only functions. Returns the caller, or null after answering.
async function requireOwner(req, res) {
  const e = env();
  if (req.method !== "POST") { send(res, 405, { error: "Use POST." }); return null; }
  if (!e.url || !e.publicKey) { send(res, 503, { error: "The application is not connected to its database yet.", code: "not_configured" }); return null; }
  const who = await caller(req);
  if (!who) { send(res, 401, { error: "Sign in again and retry." }); return null; }
  if (who.role !== "owner") { send(res, 403, { error: "Only the owner can do this." }); return null; }
  return who;
}

module.exports = { env, isEmail, isUuid, send, readBody, supa, errorText, requireOwner };
