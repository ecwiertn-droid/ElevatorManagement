// Owner only: create a login for a technician, or set a new password for someone.
// Uses the Supabase secret key, which never leaves the server.
const { env, isEmail, isUuid, send, readBody, supa, errorText, requireOwner } = require("../lib/server");

module.exports = async (req, res) => {
  try {
    const who = await requireOwner(req, res);
    if (!who) return;
    const e = env();
    if (!e.secretKey) {
      return send(res, 503, { error: "Adding people from here is not set up yet. Add SUPABASE_SECRET_KEY in Vercel, or add the login in the Supabase dashboard.", code: "users_not_configured" });
    }
    const b = readBody(req);
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < 8) return send(res, 400, { error: "The password needs at least 8 characters." });

    if (b.action === "set-password") {
      if (!isUuid(b.userId)) return send(res, 400, { error: "That person was not found." });
      const r = await supa("/auth/v1/admin/users/" + b.userId, { method: "PUT", key: e.secretKey, body: { password } });
      if (!r.ok) return send(res, 502, { error: errorText(r, "The password could not be changed.") });
      return send(res, 200, { ok: true });
    }

    if (b.action === "create") {
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
      const role = b.role === "owner" ? "owner" : "technician";
      if (!isEmail(email)) return send(res, 400, { error: "Enter a valid email address." });
      if (!name) return send(res, 400, { error: "Enter the person's name." });

      const made = await supa("/auth/v1/admin/users", { method: "POST", key: e.secretKey, body: { email, password, email_confirm: true, user_metadata: { name } } });
      if (!made.ok || !made.data || !made.data.id) {
        return send(res, made.status === 422 || made.status === 400 ? 400 : 502, { error: errorText(made, "The login could not be created.") });
      }
      const id = made.data.id;
      // The database made a waiting profile for the new login; turn it on.
      let p = await supa("/rest/v1/profiles?id=eq." + id, { method: "PATCH", key: e.secretKey, prefer: "return=representation", body: { role, name, email } });
      if (p.ok && Array.isArray(p.data) && !p.data.length) {
        p = await supa("/rest/v1/profiles", { method: "POST", key: e.secretKey, prefer: "return=representation", body: { id, role, name, email } });
      }
      if (!p.ok || !Array.isArray(p.data) || !p.data.length) {
        return send(res, 502, { error: "The login was created but could not be turned on. Open Setup, People, and set their role there." });
      }
      return send(res, 200, { profile: p.data[0] });
    }

    return send(res, 400, { error: "Unknown action." });
  } catch (err) {
    return send(res, 500, { error: "The server could not reach the database. Try again." });
  }
};
