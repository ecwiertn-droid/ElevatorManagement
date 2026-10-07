// Owner only: email the invoice for an approved work order, copy the owner, and mark it sent.
// The invoice is built here from the database, not from what the browser shows.
const { env, isEmail, isUuid, send, readBody, supa, errorText, requireOwner } = require("../lib/server");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = iso => iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" }) : "";

function invoiceHtml(d) {
  const { wo, elevator, settings, technician, invoiceNumber } = d;
  const lines = Array.isArray(wo.lines) ? wo.lines : [];
  const td = "padding:8px 10px;border-bottom:1px solid #d9dfe2;font-size:14px;";
  const th = "padding:8px 10px;border-bottom:2px solid #162027;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#586872;text-align:left;";
  const place = [elevator.address, elevator.city, elevator.state].filter(Boolean).join(", ");
  const title = (elevator.building_name || elevator.address || "Elevator") + (elevator.unit_label ? ", " + elevator.unit_label : "");
  const rows = lines.map(l => {
    const qty = Number(l.qty) || 0, price = Number(l.price) || 0;
    return `<tr><td style="${td}">${esc(l.name)}</td><td style="${td}text-align:right;">${esc(qty)}</td><td style="${td}text-align:right;">${money(price)}</td><td style="${td}text-align:right;">${money(qty * price)}</td></tr>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f5f6;font-family:Arial,Helvetica,sans-serif;color:#162027;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d1d9dd;"><tr><td style="padding:24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:24px;font-weight:bold;letter-spacing:.04em;">INVOICE<div style="font-size:13px;font-weight:normal;font-family:Consolas,monospace;margin-top:4px;">${esc(invoiceNumber)}</div></td>
<td style="text-align:right;font-size:15px;font-weight:bold;">${esc(settings.company_name || "")}<div style="font-size:13px;font-weight:normal;color:#586872;margin-top:4px;">${esc(day(new Date().toISOString()))}</div></td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;font-size:14px;line-height:1.45;"><tr>
<td style="vertical-align:top;padding-right:12px;"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#586872;">Bill to</div>${esc(elevator.owner_name || "")}${elevator.contact_name ? "<br>" + esc(elevator.contact_name) : ""}</td>
<td style="vertical-align:top;padding-right:12px;"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#586872;">Elevator</div>${esc(title)}<br>${esc(place)}<br><span style="font-family:Consolas,monospace;font-size:13px;">${esc(elevator.cert_number || "")}</span></td>
<td style="vertical-align:top;"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#586872;">Work order</div>${esc(wo.number)} · ${esc(wo.visit_type)}<br>${esc(day(wo.created_at))}${technician ? " · " + esc(technician) : ""}</td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border-collapse:collapse;">
<tr><th style="${th}">Item</th><th style="${th}text-align:right;">Qty</th><th style="${th}text-align:right;">Price</th><th style="${th}text-align:right;">Amount</th></tr>
${rows}
<tr><td colspan="3" style="padding:10px;font-size:15px;font-weight:bold;">Total</td><td style="padding:10px;font-size:15px;font-weight:bold;text-align:right;">${money(wo.total)}</td></tr>
</table>
${wo.notes ? `<p style="font-size:13px;line-height:1.45;margin:16px 0 0;"><span style="color:#586872;">Work performed: </span>${esc(wo.notes)}</p>` : ""}
</td></tr></table></body></html>`;
}

module.exports = async (req, res) => {
  try {
    const who = await requireOwner(req, res);
    if (!who) return;
    const e = env();
    const b = readBody(req);
    const to = typeof b.to === "string" ? b.to.trim() : "";
    if (!isUuid(b.workOrderId)) return send(res, 400, { error: "That work order was not found." });
    if (!isEmail(to)) return send(res, 400, { error: "Enter a valid email address to send the invoice to." });
    if (!e.resendKey || !e.emailFrom) {
      return send(res, 503, { error: "Email is not set up yet. Add RESEND_API_KEY and EMAIL_FROM in Vercel.", code: "email_not_configured" });
    }

    // Read everything as the owner, so the database's own rules apply.
    const t = { userToken: who.token };
    const woR = await supa("/rest/v1/work_orders?select=*&id=eq." + b.workOrderId, t);
    const wo = woR.ok && Array.isArray(woR.data) ? woR.data[0] : null;
    if (!wo) return send(res, 404, { error: "That work order was not found." });
    if (wo.status !== "approved" && wo.status !== "sent") return send(res, 409, { error: "Approve the work order before sending its invoice." });

    const [elR, setR, techR] = await Promise.all([
      supa("/rest/v1/elevators?select=*&id=eq." + encodeURIComponent(wo.elevator_id), t),
      supa("/rest/v1/settings?select=*&id=eq.1", t),
      supa("/rest/v1/profiles?select=name&id=eq." + wo.technician_id, t)
    ]);
    const elevator = elR.ok && Array.isArray(elR.data) && elR.data[0] ? elR.data[0] : null;
    if (!elevator) return send(res, 404, { error: "The elevator for this work order was not found." });
    const settings = setR.ok && Array.isArray(setR.data) && setR.data[0] ? setR.data[0] : {};
    const technician = techR.ok && Array.isArray(techR.data) && techR.data[0] ? techR.data[0].name : "";

    const numR = await supa("/rest/v1/rpc/assign_invoice_number", { method: "POST", userToken: who.token, body: { p_id: wo.id } });
    const invoiceNumber = numR.ok && typeof numR.data === "string" ? numR.data : "";
    if (!invoiceNumber) return send(res, 502, { error: "The invoice number could not be assigned." });

    const ownerEmail = isEmail(settings.owner_email) ? settings.owner_email.trim() : "";
    const copy = ownerEmail && ownerEmail.toLowerCase() !== to.toLowerCase() ? ownerEmail : "";
    const message = {
      from: e.emailFrom,
      to: [to],
      subject: "Invoice " + invoiceNumber + (settings.company_name ? " from " + settings.company_name : ""),
      html: invoiceHtml({ wo, elevator, settings, technician, invoiceNumber })
    };
    if (copy) message.cc = [copy];
    if (ownerEmail) message.reply_to = ownerEmail;

    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + e.resendKey, "Content-Type": "application/json" },
      body: JSON.stringify(message)
    });
    if (!mail.ok) {
      let why = "";
      try { const j = await mail.json(); why = j && (j.message || j.error) ? String(j.message || j.error) : ""; } catch (err) { /* no detail */ }
      return send(res, 502, { error: "The email service did not accept the invoice." + (why ? " It said: " + why : ""), code: "email_failed" });
    }

    const upd = await supa("/rest/v1/work_orders?id=eq." + wo.id, {
      method: "PATCH", userToken: who.token, prefer: "return=representation",
      body: { status: "sent", sent_to: to, copy_to: copy || null, sent_at: new Date().toISOString(), emailed: true }
    });
    if (!upd.ok || !Array.isArray(upd.data) || !upd.data.length) {
      return send(res, 502, { error: "The invoice email went out, but the work order could not be marked as sent. " + errorText(upd, ""), code: "sent_not_recorded" });
    }
    return send(res, 200, { workOrder: upd.data[0] });
  } catch (err) {
    return send(res, 500, { error: "The server could not finish sending. Check the work order before trying again." });
  }
};

module.exports.invoiceHtml = invoiceHtml;
