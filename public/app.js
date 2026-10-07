/* Elevator Tag: the whole browser application.
   It talks to Supabase for logins and data. What each person may read or change is
   enforced by the database rules in supabase/schema.sql, not by this file. */
(() => {
"use strict";

const STATUS = { review: "Waiting for review", approved: "Approved", sent: "Invoice sent" };
const ROLES = { owner: "Owner", technician: "Technician", pending: "Waiting to be turned on", disabled: "Turned off" };
const TABLE = { people: "profiles", visittypes: "visit_types", items: "items", elevators: "elevators", workorders: "work_orders" };
const PREF_KEY = "elevator-tag-prefs";

const S = { settings: {}, people: {}, visittypes: {}, items: {}, elevators: {}, workorders: {} };
let sb = null, session = null, busy = false, pendingRender = false, pendingHash = "", lastLoad = 0;
let info = { emailReady: false, usersReady: false };

const ui = {
  phase: "starting", message: "", view: "office", ownerTab: "dashboard",
  tech: { screen: "scan" },
  login: { email: "", password: "", error: "" },
  search: "", wo: null, add: null, rev: null, elev: null, confirm: null, lastWo: null,
  filter: { status: "", visit: "", tech: "" },
  newItem: { name: "", price: "" }, newVisit: { name: "" },
  newPerson: { name: "", email: "", password: "", role: "technician" },
  passFor: "", passNew: "", myPass: ""
};

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
const fmtDay = ymd => { if (!ymd) return ""; const p = String(ymd).slice(0, 10).split("-").map(Number); return p.length === 3 ? new Date(p[0], p[1] - 1, p[2]).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : String(ymd); };
const rand = n => { let s = ""; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const list = c => Object.values(S[c] || {});
const cfg = () => Object.assign({ companyName: "", ownerEmail: "", showPricesToTech: true }, S.settings || {});
const lineTotal = l => (Number(l.qty) || 0) * (Number(l.price) || 0);
const sumLines = lines => (lines || []).reduce((a, l) => a + lineTotal(l), 0);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const myId = () => (session && session.user && session.user.id) || "";
const me = () => S.people[myId()] || null;
const isOwner = () => !!me() && me().role === "owner";
const fieldView = () => !isOwner() || ui.view === "field";
const personName = id => { const p = S.people[id]; return p ? (p.name || p.email || "Unnamed") : "Unknown"; };
const elevTitle = e => e ? ((e.buildingName || e.address || "Elevator") + (e.unitLabel ? ", " + e.unitLabel : "")) : "Elevator not found";
const elevSub = e => e ? [e.address, e.city, e.state].filter(Boolean).join(", ") : "";
const byName = (a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || "");
const staff = () => list("people").filter(p => p.role === "owner" || p.role === "technician").sort(byName);
const visits = () => list("visittypes").sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
const items = () => list("items").sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
const elevators = () => list("elevators").sort((a, b) => elevTitle(a).localeCompare(elevTitle(b)));
const workorders = () => list("workorders").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
const showPrices = () => isOwner() || cfg().showPricesToTech;

function setPath(obj, path, value) {
  const parts = path.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) return; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = value;
}
function prefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; } catch (e) { return {}; } }
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ view: ui.view })); } catch (e) { /* optional */ } }

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

/* ---------- data ---------- */
const camelKey = k => k.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
const snakeKey = k => k.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
const camel = row => { const o = {}; Object.keys(row || {}).forEach(k => { o[camelKey(k)] = row[k]; }); return o; };
const snake = obj => { const o = {}; Object.keys(obj || {}).forEach(k => { o[snakeKey(k)] = obj[k]; }); return o; };

function dbError(e) {
  const code = e && e.code, raw = (e && e.message) || "";
  let msg = raw || "The database did not accept that.";
  if (code === "PGRST116") msg = "That change was not allowed, or the record no longer exists.";
  else if (code === "42501") msg = "You do not have permission to do that.";
  else if (code === "23505") msg = /cert_number/.test(raw) ? "An elevator with this number is already in the records." : /visit_types/.test(raw) ? "That visit type is already on the list." : "That already exists.";
  else if (code === "PGRST205" || code === "42P01") msg = "The database tables are missing. Run supabase/schema.sql in the Supabase SQL editor.";
  else if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) msg = "No connection. Check the signal and try again.";
  const err = new Error(msg); err.code = code; return err;
}
async function q(builder) { const r = await builder; if (r.error) throw dbError(r.error); return r.data; }
function norm(coll, o) {
  if (coll === "items") o.price = Number(o.price) || 0;
  if (coll === "workorders") { o.total = Number(o.total) || 0; if (!Array.isArray(o.lines)) o.lines = []; }
  if (coll === "elevators" && !Array.isArray(o.emails)) o.emails = [];
  return o;
}
function index(rows, coll) { const m = {}; (rows || []).forEach(r => { const o = norm(coll, camel(r)); m[o.id] = o; }); return m; }
function put(coll, o) { S[coll] = Object.assign({}, S[coll], { [o.id]: o }); }
function drop(coll, id) { const c = Object.assign({}, S[coll]); delete c[id]; S[coll] = c; }

async function loadAll() {
  const r = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).maybeSingle(),
    sb.from("profiles").select("*"),
    sb.from("visit_types").select("*"),
    sb.from("items").select("*"),
    sb.from("elevators").select("*"),
    sb.from("work_orders").select("*").order("created_at", { ascending: false }).limit(2000)
  ]);
  r.forEach(x => { if (x.error) throw dbError(x.error); });
  S.settings = r[0].data ? camel(r[0].data) : {};
  S.people = index(r[1].data, "people");
  S.visittypes = index(r[2].data, "visittypes");
  S.items = index(r[3].data, "items");
  S.elevators = index(r[4].data, "elevators");
  S.workorders = index(r[5].data, "workorders");
  lastLoad = Date.now();
}
const data = {
  async insert(coll, obj) { const row = await q(sb.from(TABLE[coll]).insert(snake(obj)).select().single()); const o = norm(coll, camel(row)); put(coll, o); return o; },
  async update(coll, id, patch) { const row = await q(sb.from(TABLE[coll]).update(snake(patch)).eq("id", id).select().single()); const o = norm(coll, camel(row)); put(coll, o); return o; },
  async remove(coll, id) { await q(sb.from(TABLE[coll]).delete().eq("id", id)); drop(coll, id); },
  async saveSettings(patch) { const row = await q(sb.from("settings").update(snake(patch)).eq("id", 1).select().single()); S.settings = camel(row); }
};
async function apiCall(path, body) {
  const s = await sb.auth.getSession();
  const token = s && s.data && s.data.session ? s.data.session.access_token : "";
  let r;
  try { r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error("No connection. Check the signal and try again."); }
  let j = {};
  try { j = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) { const err = new Error(j.error || "The server could not do that."); err.code = j.code; throw err; }
  return j;
}

/* ---------- QR code and tag ---------- */
const tagLink = e => location.origin + "/#" + e.id;
function qrMatrix(text) {
  if (typeof qrcode !== "function") return null;
  try {
    const qr = qrcode(0, "M"); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), rows = [];
    for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(qr.isDark(r, c)); rows.push(row); }
    return rows;
  } catch (e) { return null; }
}
function qrSvg(text) {
  const m = qrMatrix(text); if (!m) return "";
  const n = m.length, pad = 2, size = n + pad * 2; let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += "M" + (c + pad) + "," + (r + pad) + "h1v1h-1z";
  return '<svg viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="QR code for this elevator" shape-rendering="crispEdges"><rect class="qr-bg" width="' + size + '" height="' + size + '"></rect><path class="qr-fg" d="' + d + '"></path></svg>';
}
function tagHtml(e) {
  const svg = qrSvg(tagLink(e));
  return '<div class="tag"><div class="tag-top"><span class="tag-hole" aria-hidden="true"></span>SCAN FOR SERVICE</div><div class="tag-body"><div class="tag-qr">' +
    (svg || '<div class="tag-noqr">The QR code could not be drawn. Reload the page and try again.</div>') +
    '</div><div class="tag-info"><div class="tag-co">' + esc(cfg().companyName || "Elevator service") + '</div><div class="tag-id">' + esc(e.certNumber) + '</div><div class="tag-addr">' + esc(e.address) + (e.unitLabel ? "<br>" + esc(e.unitLabel) : "") + "</div></div></div></div>";
}
function tagTools(e) {
  return '<div class="rowline"><button class="btn" data-act="print-tag" data-id="' + esc(e.id) + '">Print label</button><button class="btn" data-act="save-label" data-id="' + esc(e.id) + '">Save label image</button></div>' +
    '<p class="small muted">Scanning this tag with a phone camera opens this elevator. Only someone signed in can see it.</p>';
}
function labelCanvas(e) {
  const W = 900, H = 470, c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d"), tag = "#F2B705", ink = "#1A1A1A";
  x.fillStyle = "#FFFFFF"; x.fillRect(0, 0, W, H);
  x.fillStyle = tag; x.beginPath();
  const r = 34; x.moveTo(r, 0); x.arcTo(W, 0, W, H, r); x.arcTo(W, H, 0, H, r); x.arcTo(0, H, 0, 0, r); x.arcTo(0, 0, W, 0, r); x.closePath(); x.fill();
  x.fillStyle = "#FFFFFF"; x.beginPath(); x.arc(62, 62, 20, 0, Math.PI * 2); x.fill();
  x.strokeStyle = ink; x.lineWidth = 4; x.stroke();
  x.fillStyle = ink; x.textBaseline = "middle";
  x.font = "700 46px 'Barlow Condensed', 'Arial Narrow', Arial, sans-serif"; x.fillText("SCAN FOR SERVICE", 106, 64);
  const m = qrMatrix(tagLink(e)), box = 320, bx = 40, by = 116;
  x.fillStyle = "#FFFFFF"; x.fillRect(bx, by, box, box);
  if (m) { const n = m.length, cell = Math.floor((box - 24) / n), off = Math.floor((box - cell * n) / 2); x.fillStyle = "#000000"; for (let rr = 0; rr < n; rr++) for (let cc = 0; cc < n; cc++) if (m[rr][cc]) x.fillRect(bx + off + cc * cell, by + off + rr * cell, cell, cell); }
  const tx = 392, maxW = W - tx - 30;
  const fit = (text, weight, size, family, y) => { let s = size; do { x.font = weight + " " + s + "px " + family; s -= 2; } while (x.measureText(text).width > maxW && s > 14); x.fillText(text, tx, y); };
  x.fillStyle = ink;
  fit((cfg().companyName || "Elevator service").toUpperCase(), "600", 28, "'IBM Plex Sans', Arial, sans-serif", 160);
  fit(e.certNumber || "", "500", 50, "'IBM Plex Mono', Consolas, monospace", 232);
  fit(e.address || "", "400", 30, "'IBM Plex Sans', Arial, sans-serif", 304);
  if (e.unitLabel) fit(e.unitLabel, "400", 30, "'IBM Plex Sans', Arial, sans-serif", 350);
  return c;
}
function saveLabel(e) {
  const name = "tag-" + String(e.certNumber || "elevator").replace(/[^A-Za-z0-9_-]+/g, "-") + ".png";
  labelCanvas(e).toBlob(blob => {
    if (!blob) { toast("The label image could not be made."); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}
function printHtml(html) {
  const area = $("#print-area"); if (!area) return;
  area.innerHTML = html; document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); area.innerHTML = ""; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
}

/* ---------- photo ---------- */
function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("read"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image"));
      img.onload = () => {
        for (const max of [1200, 1000, 800, 600]) {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          const url = c.toDataURL("image/jpeg", 0.7);
          if (url.length < 350000) { resolve(url); return; }
        }
        resolve(null);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/* ---------- shared pieces ---------- */
const pill = st => '<span class="pill ' + st + '">' + esc(STATUS[st] || st) + "</span>";
function confirmBtn(key, label, act, attrs) {
  return ui.confirm === key
    ? '<button class="btn danger sm" data-act="' + act + '" ' + (attrs || "") + '>Confirm</button> <button class="btn ghost sm" data-act="cancel-confirm">Cancel</button>'
    : '<button class="btn ghost sm" data-act="ask" data-key="' + esc(key) + '">' + esc(label) + "</button>";
}
function historyHtml(elevatorId, prices) {
  const rows = workorders().filter(w => w.elevatorId === elevatorId);
  if (!rows.length) return '<p class="muted">No work has been recorded on this elevator yet.</p>';
  return '<div class="stack">' + rows.map(w =>
    '<div class="hist"><div class="h1"><span>' + esc(fmtDate(w.createdAt)) + "</span><span>" + esc(w.visitType) + "</span>" + pill(w.status) + "</div>" +
    '<div class="small muted">' + esc(w.number) + " · " + esc(personName(w.technicianId)) + "</div>" +
    "<div>" + (w.lines || []).map(l => esc(l.name) + (Number(l.qty) !== 1 ? " × " + esc(l.qty) : "")).join("; ") + (prices ? ' <span class="muted">(' + money(w.total) + ")</span>" : "") + "</div>" +
    (w.notes ? '<div class="small">' + esc(w.notes) + "</div>" : "") + "</div>").join("") + "</div>";
}

/* ---------- field (technician) screens ---------- */
function scanListHtml() {
  const s = ui.search.trim().toLowerCase();
  const rows = elevators().filter(e => !s || (elevTitle(e) + " " + elevSub(e) + " " + e.certNumber).toLowerCase().includes(s));
  if (!list("elevators").length) return '<p class="muted">No elevators yet. Use Add elevator on the first visit.</p>';
  if (!rows.length) return '<p class="muted">No elevator matches that search.</p>';
  return rows.map(e => '<button class="rowbtn" data-act="open-elev" data-id="' + esc(e.id) + '"><span class="t">' + esc(elevTitle(e)) + '</span><span class="small muted">' + esc(elevSub(e)) + '</span><span class="mono">' + esc(e.certNumber) + "</span></button>").join("");
}
function fieldScreens() {
  const t = ui.tech;
  const tabOf = (t.screen === "add" || t.screen === "created") ? "add" : t.screen === "account" ? "account" : "scan";
  let body = "";
  if (t.screen === "scan") {
    body = '<div class="stack"><h2>Scan a tag</h2><p class="note">Point the phone camera at the tag on the elevator and open the link. The elevator opens here.</p>' +
      '<label class="f"><span>Tag missing or damaged? Find the elevator by address or ID number</span><input type="search" id="scan-search" data-bind="search" data-live="scan" value="' + esc(ui.search) + '" placeholder="Address or ID number"></label>' +
      '<div class="list" id="scan-list">' + scanListHtml() + "</div></div>";
  } else if (t.screen === "elevator") {
    const e = S.elevators[t.elevatorId];
    if (!e) body = '<p class="muted">This elevator is not in the records.</p><button class="btn" data-act="ttab" data-tab="scan">Back to all elevators</button>';
    else body = '<div class="stack"><button class="linkbtn" data-act="ttab" data-tab="scan">← All elevators</button>' +
      "<div><h2>" + esc(elevTitle(e)) + '</h2><p class="muted">' + esc(elevSub(e)) + "</p></div>" +
      '<div class="rowline"><span class="mono">' + esc(e.certNumber) + "</span>" + (e.inspectionDate ? '<span class="small muted">Certificate inspection date ' + esc(fmtDay(e.inspectionDate)) + "</span>" : "") + (e.needsInfo ? '<span class="pill review">Office still to add owner details</span>' : "") + "</div>" +
      (e.ownerName || e.contactName || e.contactPhone ? '<p class="small">' + [e.ownerName, e.contactName, e.contactPhone].filter(Boolean).map(esc).join(" · ") + "</p>" : "") +
      '<button class="btn primary big" data-act="start-wo" data-id="' + esc(e.id) + '">Start work order</button>' +
      '<div class="panel"><h3>Past work on this elevator</h3>' + historyHtml(e.id, showPrices()) + "</div>" +
      '<button class="btn" data-act="toggle-tag">' + (t.showTag ? "Hide tag" : "Show tag") + "</button>" +
      (t.showTag ? tagHtml(e) + tagTools(e) : "") + "</div>";
  } else if (t.screen === "workorder" && ui.wo) {
    body = workOrderForm();
  } else if (t.screen === "submitted") {
    const w = S.workorders[ui.lastWo];
    body = '<div class="stack"><h2>Sent for review</h2><p>Work order <strong>' + esc(w ? w.number : "") + "</strong> is now with the owner. Nothing goes to the customer until the owner approves it.</p>" +
      (w ? '<button class="btn" data-act="open-elev" data-id="' + esc(w.elevatorId) + '">Back to this elevator</button>' : "") +
      '<button class="btn primary" data-act="ttab" data-tab="scan">Next elevator</button></div>';
  } else if (t.screen === "add" && ui.add) {
    body = addForm();
  } else if (t.screen === "created") {
    const e = S.elevators[t.elevatorId];
    body = e ? '<div class="stack"><h2>Tag created</h2><p>The record for <strong>' + esc(elevTitle(e)) + "</strong> is saved. Put this tag on the elevator. The office will add the owner details.</p>" + tagHtml(e) + tagTools(e) +
      '<button class="btn primary" data-act="start-wo" data-id="' + esc(e.id) + '">Start work order on this elevator</button><button class="btn" data-act="ttab" data-tab="scan">Done</button></div>' : "";
  } else if (t.screen === "account") {
    body = accountPanel();
  }
  const tab = (id, label) => '<button data-act="ttab" data-tab="' + id + '"' + (tabOf === id ? ' aria-current="page"' : "") + ">" + label + "</button>";
  return '<div class="phone"><nav class="tabs" aria-label="Field">' + tab("scan", "Scan a tag") + tab("add", "Add elevator") + tab("account", "Account") + "</nav>" + body + "</div>";
}
function workOrderForm() {
  const w = ui.wo, e = S.elevators[w.elevatorId], show = showPrices(), its = items();
  const lines = its.filter(i => w.qty[i.id] > 0).map(i => ({ price: i.price, qty: w.qty[i.id] }));
  return '<div class="stack"><button class="linkbtn" data-act="open-elev" data-id="' + esc(w.elevatorId) + '">← Back to elevator</button>' +
    '<div><h2>New work order</h2><p class="muted">' + esc(elevTitle(e)) + ' · <span class="mono">' + esc(e ? e.certNumber : "") + "</span></p></div>" +
    '<p class="small muted">Technician: ' + esc(personName(myId())) + "</p>" +
    '<div class="stack"><span class="small muted">Visit type</span><div class="chips">' + visits().map(v => '<button class="chip" data-act="pick-visit" data-name="' + esc(v.name) + '" aria-pressed="' + (w.visitType === v.name) + '">' + esc(v.name) + "</button>").join("") + "</div></div>" +
    '<div class="panel"><h3>Saved items</h3>' + (its.length ? its.map(i => '<div class="item"><div class="nm"><div>' + esc(i.name) + "</div>" + (show ? '<div class="small muted">' + money(i.price) + "</div>" : "") + '</div><div class="step"><button data-act="qty" data-id="' + esc(i.id) + '" data-d="-1" aria-label="One less ' + esc(i.name) + '">−</button><span>' + (w.qty[i.id] || 0) + '</span><button data-act="qty" data-id="' + esc(i.id) + '" data-d="1" aria-label="One more ' + esc(i.name) + '">+</button></div></div>').join("") : '<p class="muted">The owner has not set up any saved items yet.</p>') + "</div>" +
    '<label class="f"><span>What was found and done</span><textarea id="wo-notes" data-bind="wo.notes">' + esc(w.notes) + "</textarea></label>" +
    (show ? '<div class="total"><span>Total</span><span class="num">' + money(sumLines(lines)) + "</span></div>" : "") +
    (w.error ? '<p class="err">' + esc(w.error) + "</p>" : "") +
    '<button class="btn primary big" data-act="submit-wo">Send to owner for review</button></div>';
}
function addForm() {
  const a = ui.add;
  const f = (id, label, key, type, extra) => '<label class="f"><span>' + label + '</span><input type="' + (type || "text") + '" id="' + id + '" data-bind="add.' + key + '" value="' + esc(a[key]) + '" ' + (extra || "") + "></label>";
  return '<div class="stack"><div><h2>Add elevator</h2><p class="muted">First visit: put the elevator onto maintenance and create its tag.</p></div>' +
    '<div class="panel"><h3>1. Photograph the certificate of operation</h3><input type="file" id="cert-photo" accept="image/*" capture="environment" data-chg="photo" aria-label="Certificate photo">' +
    (a.photo ? '<img class="photo" src="' + a.photo + '" alt="Certificate photo">' : "") +
    (a.photoNote ? '<p class="small muted">' + esc(a.photoNote) + "</p>" : "") +
    '<p class="small muted">The photo is kept with the record. Type the details from it below.</p></div>' +
    '<div class="panel"><h3>2. Enter the details</h3><div class="grid2">' +
    f("add-cert", "Certificate or ID number (required)", "certNumber") +
    '<label class="f"><span>State</span><select id="add-state" data-bind="add.state">' + ["PA", "NJ", "DE", "Other"].map(s => "<option" + (a.state === s ? " selected" : "") + ">" + s + "</option>").join("") + "</select></label>" +
    f("add-addr", "Building address (required)", "address") + f("add-city", "City", "city") +
    f("add-bldg", "Building name", "buildingName") + f("add-unit", "Elevator or car label", "unitLabel", "text", 'placeholder="For example Car 1"') +
    f("add-insp", "Inspection date on the certificate", "inspectionDate", "date") + "</div></div>" +
    (a.error ? '<p class="err">' + esc(a.error) + "</p>" : "") +
    '<button class="btn primary big" data-act="add-create">Create record and tag</button></div>';
}
function accountPanel() {
  const m = me() || {};
  return '<div class="stack"><h2>Account</h2><div class="panel"><p><strong>' + esc(m.name || "Unnamed") + '</strong><br><span class="muted">' + esc(m.email || "") + " · " + esc(ROLES[m.role] || "") + "</span></p>" +
    '<label class="f"><span>New password (at least 8 characters)</span><input type="password" id="my-pass" data-bind="myPass" value="' + esc(ui.myPass) + '" autocomplete="new-password"></label>' +
    '<div class="rowline"><button class="btn" data-act="my-pass">Change my password</button><button class="btn" data-act="signout">Sign out</button></div></div></div>';
}

/* ---------- office (owner) screens ---------- */
function officeScreens() {
  const waiting = list("workorders").filter(w => w.status === "review").length;
  const needs = list("elevators").filter(e => e.needsInfo).length;
  const tab = (id, label, n) => '<button data-act="otab" data-tab="' + id + '"' + (ui.ownerTab === id ? ' aria-current="page"' : "") + ">" + label + (n ? '<span class="count">' + n + "</span>" : "") + "</button>";
  let body = "";
  if (ui.ownerTab === "dashboard") body = dashboard();
  else if (ui.ownerTab === "review") body = ui.rev ? reviewDetail() : reviewList();
  else if (ui.ownerTab === "elevators") body = ui.elev ? elevatorDetail() : elevatorList();
  else if (ui.ownerTab === "prices") body = priceList();
  else body = setup();
  return '<div class="desk"><nav class="tabs" aria-label="Office">' + tab("dashboard", "Dashboard") + tab("review", "Review", waiting) + tab("elevators", "Elevators", needs) + tab("prices", "Saved items") + tab("setup", "Setup") + "</nav>" + body + "</div>";
}
function woRow(w) {
  const e = S.elevators[w.elevatorId];
  return '<tr><td><button class="linkbtn mono" data-act="open-wo" data-id="' + esc(w.id) + '">' + esc(w.number) + "</button></td><td>" + esc(fmtDate(w.createdAt)) + "</td><td>" + esc(elevTitle(e)) + "</td><td>" + esc(w.visitType) + "</td><td>" + esc(personName(w.technicianId)) + '</td><td class="num">' + money(w.total) + "</td><td>" + pill(w.status) + "</td></tr>";
}
const woHead = '<thead><tr><th>Work order</th><th>Date</th><th>Elevator</th><th>Visit type</th><th>Technician</th><th class="num">Total</th><th>Status</th></tr></thead>';
function gettingStarted() {
  const steps = [
    [!!cfg().companyName && !!cfg().ownerEmail, "Enter the company name and owner email", "setup"],
    [list("items").length > 0, "Add the saved items and their prices", "prices"],
    [list("people").some(p => p.role === "technician"), "Add the technicians", "setup"],
    [list("elevators").length > 0, "Add the first elevator from the Field view", ""]
  ];
  if (steps.every(s => s[0])) return "";
  return '<div class="panel"><h3>Getting started</h3><ol class="stack">' + steps.map(s => "<li>" + (s[0] ? '<span class="pill sent">Done</span> ' : '<span class="pill review">To do</span> ') + (s[2] && !s[0] ? '<button class="linkbtn" data-act="otab" data-tab="' + s[2] + '">' + s[1] + "</button>" : s[1]) + "</li>").join("") + "</ol></div>";
}
function dashboard() {
  const all = workorders(), by = st => all.filter(w => w.status === st);
  const sent = by("sent"), needs = list("elevators").filter(e => e.needsInfo).length;
  const f = ui.filter;
  const rows = all.filter(w => (!f.status || w.status === f.status) && (!f.visit || w.visitType === f.visit) && (!f.tech || w.technicianId === f.tech));
  const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (cur === v ? " selected" : "") + ">" + esc(label) + "</option>";
  const visitNames = Array.from(new Set(visits().map(v => v.name).concat(all.map(w => w.visitType)))).filter(Boolean);
  return '<div class="stack"><h2>All work</h2>' + gettingStarted() + '<div class="tiles">' +
    '<button class="tile review" data-act="otab" data-tab="review"><span class="n">' + by("review").length + '</span><span class="l">Waiting for review</span></button>' +
    '<button class="tile approved" data-act="otab" data-tab="review"><span class="n">' + by("approved").length + '</span><span class="l">Approved, invoice not sent</span></button>' +
    '<button class="tile sent" data-act="otab" data-tab="review"><span class="n">' + sent.length + '</span><span class="l">Invoices sent, ' + money(sent.reduce((a, w) => a + (w.total || 0), 0)) + "</span></button>" +
    '<button class="tile" data-act="otab" data-tab="elevators"><span class="n">' + needs + '</span><span class="l">Elevators needing owner details</span></button></div>' +
    '<div class="filters"><select id="f-status" data-chg="filter" data-f="status" aria-label="Status">' + opt("", "All statuses", f.status) + Object.keys(STATUS).map(k => opt(k, STATUS[k], f.status)).join("") + "</select>" +
    '<select id="f-visit" data-chg="filter" data-f="visit" aria-label="Visit type">' + opt("", "All visit types", f.visit) + visitNames.map(n => opt(n, n, f.visit)).join("") + "</select>" +
    '<select id="f-tech" data-chg="filter" data-f="tech" aria-label="Technician">' + opt("", "All technicians", f.tech) + staff().map(t => opt(t.id, personName(t.id), f.tech)).join("") + "</select></div>" +
    (rows.length ? '<div class="scroll"><table class="wide">' + woHead + "<tbody>" + rows.map(woRow).join("") + '</tbody><tfoot><tr><td colspan="5">' + rows.length + " work order" + (rows.length === 1 ? "" : "s") + '</td><td class="num">' + money(rows.reduce((a, w) => a + (w.total || 0), 0)) + "</td><td></td></tr></tfoot></table></div>" : '<p class="muted">' + (all.length ? "No work orders match these filters." : "No work orders yet. They appear here when a technician sends one for review.") + "</p>") + "</div>";
}
function reviewList() {
  const all = workorders(), sec = (title, st, empty) => { const r = all.filter(w => w.status === st); return '<div class="stack"><h3>' + title + "</h3>" + (r.length ? '<div class="scroll"><table class="wide">' + woHead + "<tbody>" + r.map(woRow).join("") + "</tbody></table></div>" : '<p class="muted">' + empty + "</p>") + "</div>"; };
  return '<div class="stack"><h2>Review</h2><p class="muted">Every work order stops here. Nothing goes out until it is approved.</p>' +
    sec("Waiting for review", "review", "Nothing is waiting for review.") + sec("Approved, invoice not sent", "approved", "No approved work orders are waiting to be invoiced.") + sec("Invoices sent", "sent", "No invoices have been sent yet.") + "</div>";
}
function invoiceHtml(w) {
  const e = S.elevators[w.elevatorId] || {}, c = cfg(), lines = w.lines || [];
  return '<div class="inv"><div class="inv-head"><div><div class="inv-title">Invoice</div><div class="mono">' + esc(w.invoiceNumber || "Number assigned when sent") + "</div></div><div><strong>" + esc(c.companyName || "Company name not set") + '</strong><div class="small muted">' + esc(fmtDate(w.sentAt || new Date().toISOString())) + "</div></div></div>" +
    '<div class="kv"><div><span class="k">Bill to</span>' + esc(e.ownerName || "Building owner not entered") + (e.contactName ? "<br>" + esc(e.contactName) : "") + '</div><div><span class="k">Elevator</span>' + esc(elevTitle(e)) + "<br>" + esc(elevSub(e)) + '<br><span class="mono">' + esc(e.certNumber || "") + '</span></div><div><span class="k">Work order</span>' + esc(w.number) + " · " + esc(w.visitType) + "<br>" + esc(fmtDate(w.createdAt)) + " · " + esc(personName(w.technicianId)) + "</div></div>" +
    '<div class="scroll"><table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>' + lines.map(l => "<tr><td>" + esc(l.name) + '</td><td class="num">' + esc(l.qty) + '</td><td class="num">' + money(l.price) + '</td><td class="num">' + money(lineTotal(l)) + "</td></tr>").join("") + '</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">' + money(w.total) + "</td></tr></tfoot></table></div>" +
    (w.notes ? '<div class="small"><span class="muted">Work performed: </span>' + esc(w.notes) + "</div>" : "") + "</div>";
}
function reviewDetail() {
  const r = ui.rev, w = S.workorders[r.id];
  if (!w) return '<p class="muted">This work order is no longer in the records.</p><button class="btn" data-act="rev-back">Back</button>';
  const e = S.elevators[w.elevatorId] || {};
  let out = '<div class="stack"><button class="linkbtn" data-act="rev-back">← Back to review list</button><div class="rowline"><h2>' + esc(w.number) + "</h2>" + pill(w.status) + "</div>" +
    '<p class="muted">' + esc(elevTitle(e)) + " · " + esc(elevSub(e)) + " · " + esc(fmtDate(w.createdAt)) + "</p>";
  if (w.status === "review") {
    const its = items(), people = staff();
    out += '<div class="panel"><div class="grid2"><label class="f"><span>Technician</span><select id="rev-tech" data-bind="rev.technicianId">' + people.map(x => '<option value="' + esc(x.id) + '"' + (x.id === r.technicianId ? " selected" : "") + ">" + esc(personName(x.id)) + "</option>").join("") + (people.some(x => x.id === r.technicianId) ? "" : '<option value="' + esc(r.technicianId) + '" selected>' + esc(personName(r.technicianId)) + "</option>") + "</select></label>" +
      '<label class="f"><span>Visit type</span><select id="rev-visit" data-bind="rev.visitType">' + Array.from(new Set(visits().map(v => v.name).concat([r.visitType]))).map(n => "<option" + (n === r.visitType ? " selected" : "") + ">" + esc(n) + "</option>").join("") + "</select></label></div>" +
      '<div class="scroll"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th class="num">Amount</th><th></th></tr></thead><tbody>' +
      r.lines.map((l, i) => "<tr><td>" + esc(l.name) + '</td><td><div class="step"><button data-act="rev-qty" data-i="' + i + '" data-d="-1" aria-label="One less">−</button><span>' + esc(l.qty) + '</span><button data-act="rev-qty" data-i="' + i + '" data-d="1" aria-label="One more">+</button></div></td><td><input type="number" id="rev-price-' + i + '" min="0" step="0.01" data-bind="rev.lines.' + i + '.price" data-chg="rerender" value="' + esc(l.price) + '" aria-label="Price for ' + esc(l.name) + '"></td><td class="num">' + money(lineTotal(l)) + '</td><td><button class="btn ghost sm" data-act="rev-rm" data-i="' + i + '">Remove</button></td></tr>').join("") +
      '</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">' + money(sumLines(r.lines)) + "</td><td></td></tr></tfoot></table></div>" +
      (its.length ? '<div class="rowline"><select id="rev-add" data-bind="rev.addItemId" style="width:auto;flex:1;min-width:180px" aria-label="Saved item to add">' + its.map(i => '<option value="' + esc(i.id) + '"' + (i.id === r.addItemId ? " selected" : "") + ">" + esc(i.name) + " (" + money(i.price) + ")</option>").join("") + '</select><button class="btn" data-act="rev-add">Add item</button></div>' : "") +
      '<label class="f"><span>What was found and done</span><textarea id="rev-notes" data-bind="rev.notes">' + esc(r.notes) + "</textarea></label>" +
      (r.error ? '<p class="err">' + esc(r.error) + "</p>" : "") +
      '<div class="rowline"><button class="btn primary" data-act="approve">Approve</button><button class="btn" data-act="rev-save">Save changes without approving</button></div></div>';
  } else if (w.status === "approved") {
    const emails = e.emails || [], c = cfg();
    out += invoiceHtml(w) +
      '<div class="panel"><h3>Send the invoice</h3><label class="f"><span>Send to</span><select id="rev-sendto" data-bind="rev.sendTo" data-chg="rerender">' + emails.map(m => '<option value="' + esc(m) + '"' + (r.sendTo === m ? " selected" : "") + ">" + esc(m) + "</option>").join("") + '<option value="__other"' + (r.sendTo === "__other" ? " selected" : "") + ">Another email address…</option></select></label>" +
      (r.sendTo === "__other" ? '<label class="f"><span>Email address</span><input type="email" id="rev-other" data-bind="rev.sendOther" value="' + esc(r.sendOther) + '" placeholder="name@company.com"></label>' : "") +
      '<p class="small">A copy goes automatically to the owner: <strong>' + esc(c.ownerEmail || "owner email not set (add it in Setup)") + "</strong></p>" +
      (info.emailReady ? "" : '<p class="note warn">Email is not set up yet, so Send invoice will not work. You can still mark the work order as sent after sending the invoice yourself.</p>') +
      (r.error ? '<p class="err">' + esc(r.error) + "</p>" : "") +
      '<div class="rowline"><button class="btn primary" data-act="send-invoice">Send invoice</button><button class="btn" data-act="print-invoice">Print invoice</button><button class="btn" data-act="reopen">Reopen for changes</button>' + confirmBtn("mark-sent", "Mark as sent without emailing", "mark-sent") + "</div></div>";
  } else {
    out += invoiceHtml(w) + '<div class="panel"><h3>Sent</h3>' +
      (w.emailed ? "<p>Emailed to <strong>" + esc(w.sentTo) + "</strong> on " + esc(fmtDate(w.sentAt)) + "." + (w.copyTo ? " Copy to the owner at <strong>" + esc(w.copyTo) + "</strong>." : "") + "</p>"
        : "<p>Marked as sent on " + esc(fmtDate(w.sentAt)) + ". The application did not email this invoice." + (w.sentTo ? " Recipient on record: <strong>" + esc(w.sentTo) + "</strong>." : "") + "</p>") +
      '<div class="rowline"><button class="btn" data-act="print-invoice">Print invoice</button></div></div>';
  }
  return out + "</div>";
}
function elevatorList() {
  const rows = elevators();
  return '<div class="stack"><h2>Elevators</h2><p class="muted">New elevators arrive here after a technician\'s first visit. Open one to add the rest of its information.</p>' +
    (rows.length ? '<div class="scroll"><table class="wide"><thead><tr><th>Elevator</th><th>ID number</th><th>Address</th><th>Building owner</th><th>Status</th></tr></thead><tbody>' +
      rows.map(e => '<tr><td><button class="linkbtn" data-act="open-elev-o" data-id="' + esc(e.id) + '">' + esc(elevTitle(e)) + '</button></td><td class="mono">' + esc(e.certNumber) + "</td><td>" + esc(elevSub(e)) + "</td><td>" + esc(e.ownerName || "") + "</td><td>" + (e.needsInfo ? '<span class="pill review">Needs owner details</span>' : '<span class="pill sent">Complete</span>') + "</td></tr>").join("") + "</tbody></table></div>" : '<p class="muted">No elevators yet. Switch to the Field view and use Add elevator on the first visit.</p>') + "</div>";
}
function elevatorDetail() {
  const d = ui.elev, e = S.elevators[d.id];
  if (!e) return '<p class="muted">This elevator is no longer in the records.</p><button class="btn" data-act="elev-back">Back</button>';
  const f = (id, label, key, type) => '<label class="f"><span>' + label + '</span><input type="' + (type || "text") + '" id="' + id + '" data-bind="elev.' + key + '" value="' + esc(d[key]) + '"></label>';
  return '<div class="stack"><button class="linkbtn" data-act="elev-back">← Back to elevators</button><div class="rowline"><h2>' + esc(elevTitle(e)) + "</h2>" + (e.needsInfo ? '<span class="pill review">Needs owner details</span>' : "") + "</div>" +
    '<div class="panel"><h3>From the certificate</h3><div class="grid2">' + f("el-cert", "Certificate or ID number", "certNumber") + f("el-state", "State", "state") + f("el-addr", "Building address", "address") + f("el-city", "City", "city") + f("el-bldg", "Building name", "buildingName") + f("el-unit", "Elevator or car label", "unitLabel") + f("el-insp", "Inspection date on the certificate", "inspectionDate", "date") + "</div>" +
    (d.photo ? '<img class="photo" src="' + d.photo + '" alt="Certificate photo taken on the first visit">' : '<p class="small muted">' + (d.photoState === "loading" ? "Looking for the certificate photo…" : "No certificate photo is stored for this elevator.") + "</p>") + "</div>" +
    '<div class="panel"><h3>Added by the office</h3><div class="grid2">' + f("el-owner", "Building owner", "ownerName") + f("el-contact", "Contact name", "contactName") + f("el-phone", "Contact phone", "contactPhone") + "</div>" +
    '<label class="f"><span>Email addresses for invoices (one per line)</span><textarea id="el-emails" data-bind="elev.emailsText">' + esc(d.emailsText) + '</textarea></label><label class="f"><span>Notes</span><textarea id="el-notes" data-bind="elev.notes">' + esc(d.notes) + "</textarea></label>" +
    (d.error ? '<p class="err">' + esc(d.error) + "</p>" : "") + '<div class="rowline"><button class="btn primary" data-act="elev-save">Save</button></div></div>' +
    '<div class="panel"><h3>Tag</h3>' + tagHtml(e) + tagTools(e) + "</div>" +
    '<div class="panel"><h3>Past work</h3>' + historyHtml(e.id, true) + "</div></div>";
}
function priceList() {
  const its = items();
  return '<div class="stack"><h2>Saved items</h2><p class="muted">Technicians pick from this list on a work order. The price set here comes onto the work order. Changing a price does not alter work orders already created.</p>' +
    '<div class="scroll"><table><thead><tr><th>Item</th><th>Price</th><th></th></tr></thead><tbody>' +
    its.map(i => '<tr><td><input type="text" id="it-n-' + esc(i.id) + '" value="' + esc(i.name) + '" data-chg="item" data-id="' + esc(i.id) + '" data-f="name" aria-label="Item name"></td><td><input type="number" id="it-p-' + esc(i.id) + '" min="0" step="0.01" value="' + esc(i.price) + '" data-chg="item" data-id="' + esc(i.id) + '" data-f="price" aria-label="Price"></td><td>' + confirmBtn("item-" + i.id, "Remove", "item-rm", 'data-id="' + esc(i.id) + '"') + "</td></tr>").join("") +
    '<tr><td><input type="text" id="it-new-n" data-bind="newItem.name" value="' + esc(ui.newItem.name) + '" placeholder="New item name" aria-label="New item name"></td><td><input type="number" id="it-new-p" min="0" step="0.01" data-bind="newItem.price" value="' + esc(ui.newItem.price) + '" placeholder="0.00" aria-label="New item price"></td><td><button class="btn sm" data-act="item-add">Add item</button></td></tr></tbody></table></div></div>';
}
function setup() {
  const c = cfg(), np = ui.newPerson;
  const people = list("people").sort(byName);
  const roleSel = p => '<select id="pr-' + esc(p.id) + '" data-chg="person" data-id="' + esc(p.id) + '" data-f="role" aria-label="Role for ' + esc(personName(p.id)) + '">' + Object.keys(ROLES).map(k => '<option value="' + k + '"' + (p.role === k ? " selected" : "") + ">" + ROLES[k] + "</option>").join("") + "</select>";
  return '<div class="stack"><h2>Setup</h2>' +
    '<div class="panel"><h3>Company</h3><div class="grid2"><label class="f"><span>Company name (shown on tags and invoices)</span><input type="text" id="cfg-co" value="' + esc(c.companyName) + '" data-chg="cfg" data-f="companyName"></label><label class="f"><span>Owner email (gets a copy of every invoice)</span><input type="email" id="cfg-em" value="' + esc(c.ownerEmail) + '" data-chg="cfg" data-f="ownerEmail"></label></div>' +
    '<label class="rowline"><input type="checkbox" id="cfg-pr" ' + (c.showPricesToTech ? "checked" : "") + ' data-chg="cfg" data-f="showPricesToTech"> Technicians see prices on the work order</label></div>' +
    '<div class="panel"><h3>Visit types</h3><p class="small muted">The technician picks one on each work order.</p>' +
    visits().map(x => '<div class="rowline between"><span>' + esc(x.name) + "</span><span>" + confirmBtn("visit-" + x.id, "Remove", "visit-rm", 'data-id="' + esc(x.id) + '"') + "</span></div>").join("") +
    '<div class="rowline"><input type="text" id="new-visit" data-bind="newVisit.name" value="' + esc(ui.newVisit.name) + '" placeholder="New visit type" style="flex:1;min-width:160px" aria-label="New visit type"><button class="btn" data-act="visit-add">Add</button></div></div>' +
    '<div class="panel"><h3>People</h3><p class="small muted">Each person signs in with their own email and password. A new login can do nothing until its role is Technician or Owner.</p>' +
    '<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>' +
    people.map(p => '<tr><td><input type="text" id="pn-' + esc(p.id) + '" value="' + esc(p.name) + '" data-chg="person" data-id="' + esc(p.id) + '" data-f="name" aria-label="Name"></td><td>' + esc(p.email) + (p.id === myId() ? ' <span class="muted">(you)</span>' : "") + "</td><td>" + roleSel(p) + "</td><td>" +
      (info.usersReady ? (ui.passFor === p.id
        ? '<div class="rowline"><input type="text" id="pass-new" data-bind="passNew" value="' + esc(ui.passNew) + '" placeholder="New password" style="width:150px" aria-label="New password"><button class="btn sm" data-act="person-pass" data-id="' + esc(p.id) + '">Save</button><button class="btn ghost sm" data-act="pass-cancel">Cancel</button></div>'
        : '<button class="btn ghost sm" data-act="pass-open" data-id="' + esc(p.id) + '">Set password</button>') : "") + "</td></tr>").join("") + "</tbody></table></div>" +
    (info.usersReady
      ? '<h3>Add a person</h3><div class="grid2"><label class="f"><span>Name</span><input type="text" id="np-name" data-bind="newPerson.name" value="' + esc(np.name) + '"></label><label class="f"><span>Email</span><input type="email" id="np-email" data-bind="newPerson.email" value="' + esc(np.email) + '"></label><label class="f"><span>Starting password (at least 8 characters)</span><input type="text" id="np-pass" data-bind="newPerson.password" value="' + esc(np.password) + '"></label><label class="f"><span>Role</span><select id="np-role" data-bind="newPerson.role"><option value="technician"' + (np.role === "technician" ? " selected" : "") + '>Technician</option><option value="owner"' + (np.role === "owner" ? " selected" : "") + '>Owner</option></select></label></div><div><button class="btn" data-act="person-add">Add person</button></div><p class="small muted">Give the person their email and starting password. They can change the password under Account.</p>'
      : '<p class="note warn">Adding people from here is not set up yet. Until it is, add each login in the Supabase dashboard under Authentication, Users, then set their role here.</p>') + "</div>" +
    accountPanel() + "</div>";
}

/* ---------- shell ---------- */
function shell() {
  const head = (right) => '<header class="top"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Elevator Tag</span></div><div class="topright">' + (right || "") + "</div></header>";
  if (ui.phase === "starting" || ui.phase === "loading") return head() + '<p class="muted">Loading…</p>';
  if (ui.phase === "notconnected") return head() + '<div class="phone"><div class="panel"><h2>Not connected yet</h2><p>The application is deployed, but it has not been told where its database is.</p><ol class="stack"><li>Create a Supabase project and run <span class="mono">supabase/schema.sql</span> in its SQL editor.</li><li>In Vercel, open the project settings and add the environment variables <span class="mono">SUPABASE_URL</span> and <span class="mono">SUPABASE_PUBLISHABLE_KEY</span>.</li><li>Redeploy, then reload this page.</li></ol><p class="small muted">The README in the repository has the full steps.</p><button class="btn" data-act="reload">Reload</button></div></div>';
  if (ui.phase === "error") return head() + '<div class="phone"><div class="panel"><h2>Something is wrong</h2><p>' + esc(ui.message) + '</p><div class="rowline"><button class="btn primary" data-act="reload">Reload</button>' + (session ? '<button class="btn" data-act="signout">Sign out</button>' : "") + "</div></div></div>";
  if (ui.phase === "login") return head() + '<div class="phone"><form class="panel" data-form="login" novalidate><h2>Sign in</h2><label class="f"><span>Email</span><input type="email" id="login-email" data-bind="login.email" value="' + esc(ui.login.email) + '" autocomplete="username" inputmode="email"></label><label class="f"><span>Password</span><input type="password" id="login-pass" data-bind="login.password" value="' + esc(ui.login.password) + '" autocomplete="current-password"></label>' + (ui.login.error ? '<p class="err">' + esc(ui.login.error) + "</p>" : "") + '<button class="btn primary big" type="submit">Sign in</button><p class="small muted">Forgot your password? Ask the owner to set a new one.</p></form></div>';
  if (ui.phase === "blocked") {
    const m = me();
    const text = !m ? "This login has no profile in the database yet. If the database setup was just run, sign out and sign in again." : m.role === "disabled" ? "This account has been turned off. Ask the owner if that is a mistake." : "This account is waiting for the owner to turn it on.";
    return head() + '<div class="phone"><div class="panel"><h2>Not turned on</h2><p>' + text + '</p><div class="rowline"><button class="btn primary" data-act="recheck">Check again</button><button class="btn" data-act="signout">Sign out</button></div></div></div>';
  }
  const m = me() || {};
  const right = (isOwner() ? '<div class="seg" role="group" aria-label="View"><button data-act="view" data-view="office" aria-pressed="' + (ui.view === "office") + '">Office</button><button data-act="view" data-view="field" aria-pressed="' + (ui.view === "field") + '">Field</button></div>' : "") +
    '<span class="me">' + esc(m.name || m.email || "") + '</span><button class="linkbtn" data-act="signout">Sign out</button>';
  return head(right) + (fieldView() ? fieldScreens() : officeScreens()) +
    '<footer class="foot"><span>' + esc(cfg().companyName || "") + '</span><button class="linkbtn" data-act="refresh">Refresh</button></footer>';
}
function render() { pendingRender = false; const app = $("#app"); if (app) app.innerHTML = shell(); }
function isEditing() { const a = document.activeElement, app = $("#app"); return !!(a && app && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox" && a.type !== "file" && app.contains(a)); }
function scheduleRender() { if (isEditing()) { pendingRender = true; return; } render(); }
function go() { ui.confirm = null; render(); window.scrollTo(0, 0); }

/* ---------- session ---------- */
function clearData() { Object.keys(S).forEach(k => { S[k] = {}; }); ui.rev = null; ui.elev = null; ui.wo = null; ui.add = null; ui.tech = { screen: "scan" }; ui.ownerTab = "dashboard"; }
function openFromHash(h) {
  if (!/^e-[a-z0-9]+$/.test(h || "")) return;
  if (S.elevators[h]) { ui.view = "field"; ui.tech = { screen: "elevator", elevatorId: h }; }
  else toast("That tag is not in the records.");
}
async function enter() {
  ui.phase = "loading"; render();
  try { await loadAll(); }
  catch (e) { ui.phase = "error"; ui.message = e.message; render(); return; }
  const m = me();
  if (!m || (m.role !== "owner" && m.role !== "technician")) { ui.phase = "blocked"; render(); return; }
  ui.phase = "app";
  ui.view = m.role === "owner" ? (prefs().view === "field" ? "field" : "office") : "field";
  if (pendingHash) { openFromHash(pendingHash); pendingHash = ""; }
  go();
}
async function refresh(quiet) {
  if (ui.phase !== "app" || busy || !sb) return;
  try {
    await loadAll();
    const m = me();
    if (!m || (m.role !== "owner" && m.role !== "technician")) { ui.phase = "blocked"; render(); return; }
    scheduleRender();
  } catch (e) { if (!quiet) toast(e.message); }
}
function onAuth(event, s) {
  if (event === "SIGNED_OUT") { session = null; clearData(); ui.phase = "login"; ui.login = { email: "", password: "", error: "" }; render(); }
  else if (s) session = s;
}

/* ---------- actions ---------- */
function revDraft(w) {
  const e = S.elevators[w.elevatorId] || {}, emails = e.emails || [], its = items();
  return { id: w.id, technicianId: w.technicianId, visitType: w.visitType, lines: (w.lines || []).map(l => Object.assign({}, l)), notes: w.notes || "", addItemId: its[0] ? its[0].id : "", sendTo: emails[0] || "__other", sendOther: "", error: "" };
}
const cleanLines = lines => lines.map(l => ({ itemId: l.itemId || "", name: l.name, price: Math.max(0, Number(l.price) || 0), qty: Math.max(1, Number(l.qty) || 1) }));
async function saveReview(status) {
  const r = ui.rev, w = S.workorders[r.id]; if (!w) return false;
  if (!r.lines.length) { r.error = "Add at least one item before approving or saving."; render(); return false; }
  const patch = { technicianId: r.technicianId, visitType: r.visitType, lines: cleanLines(r.lines), notes: r.notes.trim(), status };
  if (status === "approved") patch.reviewedAt = new Date().toISOString();
  const saved = await data.update("workorders", w.id, patch);
  ui.rev = revDraft(saved);
  return true;
}
function sendToAddress() { const r = ui.rev; return (r.sendTo === "__other" ? r.sendOther : r.sendTo || "").trim(); }

const actions = {
  reload() { location.reload(); },
  async signout() { try { await sb.auth.signOut(); } catch (e) { /* signed out locally below */ } session = null; clearData(); ui.phase = "login"; ui.login = { email: "", password: "", error: "" }; go(); },
  async recheck() { await enter(); },
  async refresh() { await loadAll(); toast("Up to date."); render(); },
  view(d) { ui.view = d.view === "field" ? "field" : "office"; savePrefs(); go(); },
  ttab(d) {
    if (d.tab === "add") { ui.add = { photo: null, photoNote: "", certNumber: "", state: "PA", address: "", city: "", buildingName: "", unitLabel: "", inspectionDate: "", error: "" }; ui.tech = { screen: "add" }; }
    else if (d.tab === "account") ui.tech = { screen: "account" };
    else ui.tech = { screen: "scan" };
    go();
  },
  otab(d) { ui.ownerTab = d.tab; ui.rev = null; ui.elev = null; go(); },
  "open-elev"(d) { ui.tech = { screen: "elevator", elevatorId: d.id }; go(); },
  "toggle-tag"() { ui.tech.showTag = !ui.tech.showTag; render(); },
  "start-wo"(d) { ui.wo = { elevatorId: d.id, visitType: "", qty: {}, notes: "", error: "" }; ui.tech = { screen: "workorder", elevatorId: d.id }; go(); },
  "pick-visit"(d) { ui.wo.visitType = d.name; ui.wo.error = ""; render(); },
  qty(d) { const qy = ui.wo.qty; qy[d.id] = Math.max(0, (qy[d.id] || 0) + Number(d.d)); ui.wo.error = ""; render(); },
  async "submit-wo"() {
    const w = ui.wo, lines = items().filter(i => w.qty[i.id] > 0).map(i => ({ itemId: i.id, name: i.name, price: Number(i.price) || 0, qty: w.qty[i.id] }));
    if (!w.visitType || !lines.length) { w.error = "Pick a visit type and at least one saved item."; render(); return; }
    const saved = await data.insert("workorders", { id: uuid(), elevatorId: w.elevatorId, technicianId: myId(), visitType: w.visitType, lines, notes: w.notes.trim(), status: "review" });
    ui.lastWo = saved.id; ui.wo = null; ui.tech = { screen: "submitted" }; go();
  },
  async "add-create"() {
    const a = ui.add, cert = a.certNumber.trim(), addr = a.address.trim();
    if (!cert || !addr) { a.error = "Enter the certificate or ID number and the building address."; render(); return; }
    if (list("elevators").some(e => e.certNumber.trim().toLowerCase() === cert.toLowerCase())) { a.error = "An elevator with this number is already in the records. Find it on the Scan a tag screen."; render(); return; }
    const id = "e-" + rand(10);
    let saved;
    try { saved = await data.insert("elevators", { id, certNumber: cert, state: a.state, address: addr, city: a.city.trim(), buildingName: a.buildingName.trim(), unitLabel: a.unitLabel.trim(), inspectionDate: a.inspectionDate || null, needsInfo: true, createdBy: myId() }); }
    catch (e) { a.error = e.message; render(); return; }
    if (a.photo) {
      try { await q(sb.from("elevator_photos").insert({ elevator_id: saved.id, data_url: a.photo })); }
      catch (e) { toast("The record was saved, but the photo could not be stored."); }
    }
    ui.add = null; ui.tech = { screen: "created", elevatorId: saved.id }; go();
  },
  "save-label"(d) { const e = S.elevators[d.id]; if (e) saveLabel(e); },
  "print-tag"(d) { const e = S.elevators[d.id]; if (e) printHtml(tagHtml(e)); },
  "print-invoice"() { const w = ui.rev && S.workorders[ui.rev.id]; if (w) printHtml(invoiceHtml(w)); },
  ask(d) { ui.confirm = d.key; render(); },
  "cancel-confirm"() { ui.confirm = null; render(); },
  "open-wo"(d) { const w = S.workorders[d.id]; if (!w) return; ui.ownerTab = "review"; ui.rev = revDraft(w); go(); },
  "rev-back"() { ui.rev = null; go(); },
  "rev-qty"(d) { const l = ui.rev.lines[Number(d.i)]; if (l) l.qty = Math.max(1, (Number(l.qty) || 1) + Number(d.d)); render(); },
  "rev-rm"(d) { ui.rev.lines.splice(Number(d.i), 1); render(); },
  "rev-add"() {
    const it = S.items[ui.rev.addItemId]; if (!it) return;
    const ex = ui.rev.lines.find(l => l.itemId === it.id);
    if (ex) ex.qty = (Number(ex.qty) || 0) + 1; else ui.rev.lines.push({ itemId: it.id, name: it.name, price: Number(it.price) || 0, qty: 1 });
    ui.rev.error = ""; render();
  },
  async "rev-save"() { if (await saveReview("review")) { toast("Changes saved. Still waiting for approval."); render(); } },
  async approve() { if (await saveReview("approved")) { toast("Approved. The invoice is ready to send."); go(); } },
  async reopen() { const w = S.workorders[ui.rev.id]; if (!w) return; const saved = await data.update("workorders", w.id, { status: "review" }); ui.rev = revDraft(saved); go(); },
  async "send-invoice"() {
    const r = ui.rev, w = S.workorders[r.id]; if (!w) return;
    const to = sendToAddress();
    if (!isEmail(to)) { r.error = "Enter a valid email address to send the invoice to."; render(); return; }
    r.error = "";
    let out;
    try { out = await apiCall("/api/send-invoice", { workOrderId: w.id, to }); }
    catch (e) { r.error = e.message; try { await loadAll(); } catch (e2) { /* keep what is on screen */ } if (S.workorders[r.id]) { const keep = ui.rev; ui.rev = revDraft(S.workorders[r.id]); ui.rev.sendTo = keep.sendTo; ui.rev.sendOther = keep.sendOther; ui.rev.error = e.message; } render(); return; }
    const saved = norm("workorders", camel(out.workOrder)); put("workorders", saved);
    ui.rev = revDraft(saved);
    toast("Invoice " + (saved.invoiceNumber || "") + " emailed to " + to + "."); go();
  },
  async "mark-sent"() {
    const r = ui.rev, w = S.workorders[r.id]; if (!w) return;
    const to = sendToAddress();
    await q(sb.rpc("assign_invoice_number", { p_id: w.id }));
    const saved = await data.update("workorders", w.id, { status: "sent", sentTo: isEmail(to) ? to : null, copyTo: null, sentAt: new Date().toISOString(), emailed: false });
    ui.rev = revDraft(saved);
    toast("Marked as sent. No email went out."); go();
  },
  async "open-elev-o"(d) {
    const e = S.elevators[d.id]; if (!e) return;
    ui.ownerTab = "elevators";
    ui.elev = { id: e.id, certNumber: e.certNumber || "", state: e.state || "", address: e.address || "", city: e.city || "", buildingName: e.buildingName || "", unitLabel: e.unitLabel || "", inspectionDate: (e.inspectionDate || "").slice(0, 10), ownerName: e.ownerName || "", contactName: e.contactName || "", contactPhone: e.contactPhone || "", emailsText: (e.emails || []).join("\n"), notes: e.notes || "", error: "", photo: null, photoState: "loading" };
    go();
    const draft = ui.elev;
    try { const row = await q(sb.from("elevator_photos").select("data_url").eq("elevator_id", e.id).maybeSingle()); draft.photo = row && /^data:image\//.test(row.data_url || "") ? row.data_url : null; }
    catch (err) { draft.photo = null; }
    draft.photoState = "done";
    if (ui.elev === draft) scheduleRender();
  },
  "elev-back"() { ui.elev = null; go(); },
  async "elev-save"() {
    const d = ui.elev, e = S.elevators[d.id]; if (!e) return;
    const parts = d.emailsText.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean), bad = parts.filter(p => !isEmail(p));
    if (!d.certNumber.trim() || !d.address.trim()) { d.error = "The certificate or ID number and the building address cannot be empty."; render(); return; }
    if (bad.length) { d.error = "This does not look like an email address: " + bad[0]; render(); return; }
    const ownerName = d.ownerName.trim();
    try {
      await data.update("elevators", e.id, { certNumber: d.certNumber.trim(), state: d.state.trim(), address: d.address.trim(), city: d.city.trim(), buildingName: d.buildingName.trim(), unitLabel: d.unitLabel.trim(), inspectionDate: d.inspectionDate || null, ownerName, contactName: d.contactName.trim(), contactPhone: d.contactPhone.trim(), emails: parts, notes: d.notes.trim(), needsInfo: !(ownerName && parts.length) });
    } catch (err) { d.error = err.message; render(); return; }
    d.error = ""; d.emailsText = parts.join("\n");
    toast(ownerName && parts.length ? "Saved. This elevator's record is complete." : "Saved. Add a building owner and an invoice email to complete it."); render();
  },
  async "item-add"() {
    const name = ui.newItem.name.trim(), price = Number(ui.newItem.price);
    if (!name || ui.newItem.price === "" || !(price >= 0)) { toast("Enter an item name and a price."); return; }
    const sort = items().reduce((m, i) => Math.max(m, i.sort || 0), 0) + 1;
    await data.insert("items", { id: uuid(), name, price, sort }); ui.newItem = { name: "", price: "" }; render();
  },
  async "item-rm"(d) { await data.remove("items", d.id); ui.confirm = null; render(); },
  async "visit-add"() {
    const name = ui.newVisit.name.trim(); if (!name) { toast("Enter a name for the visit type."); return; }
    if (visits().some(v => v.name.toLowerCase() === name.toLowerCase())) { toast("That visit type is already on the list."); return; }
    const sort = visits().reduce((m, v) => Math.max(m, v.sort || 0), 0) + 1;
    await data.insert("visittypes", { id: uuid(), name, sort }); ui.newVisit = { name: "" }; render();
  },
  async "visit-rm"(d) { await data.remove("visittypes", d.id); ui.confirm = null; render(); },
  async "person-add"() {
    const p = ui.newPerson, name = p.name.trim(), email = p.email.trim();
    if (!name) { toast("Enter the person's name."); return; }
    if (!isEmail(email)) { toast("Enter a valid email address."); return; }
    if ((p.password || "").length < 8) { toast("The starting password needs at least 8 characters."); return; }
    const out = await apiCall("/api/people", { action: "create", name, email, password: p.password, role: p.role });
    if (out.profile) put("people", camel(out.profile));
    ui.newPerson = { name: "", email: "", password: "", role: "technician" };
    toast(name + " can now sign in."); render();
  },
  "pass-open"(d) { ui.passFor = d.id; ui.passNew = ""; render(); },
  "pass-cancel"() { ui.passFor = ""; ui.passNew = ""; render(); },
  async "person-pass"(d) {
    if ((ui.passNew || "").length < 8) { toast("The password needs at least 8 characters."); return; }
    await apiCall("/api/people", { action: "set-password", userId: d.id, password: ui.passNew });
    ui.passFor = ""; ui.passNew = ""; toast("Password changed for " + personName(d.id) + "."); render();
  },
  async "my-pass"() {
    if ((ui.myPass || "").length < 8) { toast("The password needs at least 8 characters."); return; }
    const r = await sb.auth.updateUser({ password: ui.myPass });
    if (r.error) throw new Error(r.error.message || "The password could not be changed.");
    ui.myPass = ""; toast("Your password is changed."); render();
  }
};
const forms = {
  async login() {
    const l = ui.login, email = l.email.trim();
    if (!isEmail(email) || !l.password) { l.error = "Enter your email and password."; render(); return; }
    l.error = "";
    const r = await sb.auth.signInWithPassword({ email, password: l.password });
    if (r.error || !r.data || !r.data.session) {
      l.error = r.error && /invalid login/i.test(r.error.message || "") ? "That email and password do not match." : (r.error && r.error.message) || "Sign in did not work. Try again.";
      l.password = ""; render(); return;
    }
    session = r.data.session; ui.login = { email: "", password: "", error: "" };
    await enter();
  }
};
const changes = {
  filter(d, el) { ui.filter[d.f] = el.value; render(); },
  rerender() { render(); },
  async cfg(d, el) {
    const v = el.type === "checkbox" ? el.checked : el.value.trim();
    if (d.f === "ownerEmail" && v && !isEmail(v)) { toast("That does not look like an email address."); return; }
    await data.saveSettings({ [d.f]: v }); scheduleRender();
  },
  async item(d, el) {
    const it = S.items[d.id]; if (!it) return;
    let v = el.value;
    if (d.f === "price") { v = Number(v); if (el.value === "" || !(v >= 0)) { toast("Enter a price of 0 or more."); el.value = it.price; return; } }
    else { v = v.trim(); if (!v) { toast("An item needs a name."); el.value = it.name; return; } }
    await data.update("items", it.id, { [d.f]: v }); scheduleRender();
  },
  async person(d, el) {
    const p = S.people[d.id]; if (!p) return;
    const v = d.f === "name" ? el.value.trim() : el.value;
    try { await data.update("people", p.id, { [d.f]: v }); }
    catch (e) { el.value = p[d.f]; throw e; }
    if (d.f === "role") toast(personName(p.id) + " is now: " + ROLES[v] + "."); scheduleRender();
  },
  photo(d, el) {
    const file = el.files && el.files[0]; if (!file || !ui.add) return;
    return readPhoto(file).then(url => {
      if (!ui.add) return;
      ui.add.photo = url; ui.add.photoNote = url ? "Photo added." : "That photo is too large to keep. The record can still be created.";
      render();
    }).catch(() => { if (ui.add) { ui.add.photoNote = "That file could not be read as a photo."; render(); } });
  }
};
const live = { scan() { const l = $("#scan-list"); if (l) l.innerHTML = scanListHtml(); } };

function dispatch(fn, args) {
  if (busy) return;
  let r;
  try { r = fn.apply(null, args); }
  catch (e) { toast(e && e.message ? e.message : "Something went wrong."); return; }
  if (r && typeof r.then === "function") {
    busy = true; document.body.classList.add("busy");
    r.catch(e => { toast(e && e.message ? e.message : "Something went wrong."); })
      .then(() => { busy = false; document.body.classList.remove("busy"); if (pendingRender && !isEditing()) render(); });
  }
}
document.addEventListener("click", ev => {
  const el = ev.target.closest("[data-act]"), app = $("#app");
  if (!el || !app || !app.contains(el)) return;
  const fn = actions[el.dataset.act]; if (fn) dispatch(fn, [el.dataset, el]);
});
document.addEventListener("submit", ev => {
  const f = ev.target; if (!f.dataset || !f.dataset.form) return;
  ev.preventDefault();
  const fn = forms[f.dataset.form]; if (fn) dispatch(fn, []);
});
document.addEventListener("input", ev => {
  const t = ev.target; if (!t.dataset) return;
  if (t.dataset.bind) setPath(ui, t.dataset.bind, t.type === "checkbox" ? t.checked : t.value);
  if (t.dataset.live && live[t.dataset.live]) live[t.dataset.live](t);
});
document.addEventListener("change", ev => {
  const t = ev.target; if (!t.dataset) return;
  if (t.dataset.bind && t.tagName === "SELECT") setPath(ui, t.dataset.bind, t.value);
  if (t.dataset.chg && changes[t.dataset.chg]) dispatch(changes[t.dataset.chg], [t.dataset, t]);
});
document.addEventListener("focusout", () => { if (pendingRender) setTimeout(() => { if (pendingRender && !isEditing() && !busy) render(); }, 60); });
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (!h) return; if (ui.phase === "app") { openFromHash(h); go(); } else pendingHash = h; });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastLoad > 20000) refresh(true); });
setInterval(() => { if (document.visibilityState === "visible" && !isEditing() && Date.now() - lastLoad > 55000) refresh(true); }, 60000);

/* ---------- start ---------- */
async function boot() {
  pendingHash = location.hash.slice(1);
  render();
  let conf = null;
  try { const r = await fetch("/api/config", { cache: "no-store" }); if (r.ok) conf = await r.json(); } catch (e) { /* handled below */ }
  if (!conf || !conf.supabaseUrl || !conf.supabaseKey) { ui.phase = "notconnected"; render(); return; }
  if (!window.supabase || typeof window.supabase.createClient !== "function") { ui.phase = "error"; ui.message = "The database library could not be loaded. Check the connection and reload."; render(); return; }
  info = { emailReady: !!conf.emailReady, usersReady: !!conf.usersReady };
  sb = window.supabase.createClient(conf.supabaseUrl, conf.supabaseKey);
  sb.auth.onAuthStateChange((event, s) => { setTimeout(() => onAuth(event, s), 0); });
  let s = null;
  try { const r = await sb.auth.getSession(); s = r && r.data ? r.data.session : null; } catch (e) { s = null; }
  session = s;
  if (!session) { ui.phase = "login"; render(); return; }
  await enter();
}
boot().catch(e => { ui.phase = "error"; ui.message = (e && e.message) || "The application could not start."; render(); });
})();
