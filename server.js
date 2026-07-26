"use strict";
// OnePulso · servidor de la plataforma + API de correo real (IMAP/SMTP)
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const app = express();
app.use(express.json({ limit: "2mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

// ---- sesiones de correo (solo en memoria del servidor) ----
const sessions = new Map(); // token -> { imap, smtp, email }

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.indexOf("Bearer ") === 0 ? h.slice(7) : "";
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: "no_session" });
  req.creds = s;
  next();
}

// ---- IMAP: importar toda la conversación con un contacto ----
async function importConversation(creds, contact) {
  contact = String(contact || "").toLowerCase().trim();
  const me = String(creds.email || creds.imap.user).toLowerCase();
  const client = new ImapFlow({
    host: creds.imap.host, port: Number(creds.imap.port), secure: creds.imap.secure !== false,
    auth: { user: creds.imap.user, pass: creds.imap.pass }, logger: false, socketTimeout: 45000
  });
  await client.connect();
  const out = [], seen = new Set();
  try {
    const boxes = await client.list();
    for (const box of boxes) {
      if (box.flags && box.flags.has && box.flags.has("\\Noselect")) continue;
      let lock;
      try { lock = await client.getMailboxLock(box.path); } catch (e) { continue; }
      try {
        let uids = [];
        try { uids = await client.search({ or: [{ from: contact }, { to: contact }] }, { uid: true }); } catch (e) { uids = []; }
        if (!uids || !uids.length) continue;
        uids = uids.slice(-80); // últimos 80 por carpeta como tope de seguridad
        for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            const mid = parsed.messageId || box.path + ":" + msg.uid;
            if (seen.has(mid)) continue; seen.add(mid);
            const fromAddr = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "").toLowerCase();
            out.push({
              id: mid,
              direction: fromAddr === me ? "outbound" : "inbound",
              from: (parsed.from && parsed.from.text) || "",
              from_addr: fromAddr,
              to: (parsed.to && parsed.to.value || []).map(function (a) { return a.address; }),
              cc: (parsed.cc && parsed.cc.value || []).map(function (a) { return a.address; }),
              subject: parsed.subject || "",
              date: (parsed.date || new Date()).getTime(),
              body_html: parsed.html || parsed.textAsHtml || ("<p>" + escapeHtml(parsed.text || "") + "</p>"),
              body_text: parsed.text || "",
              message_id: parsed.messageId || "",
              in_reply_to: parsed.inReplyTo || "",
              references: parsed.references ? [].concat(parsed.references) : [],
              attachments: (parsed.attachments || []).map(function (a) { return { filename: a.filename, size: a.size, contentType: a.contentType }; })
            });
          } catch (e) { /* mensaje ilegible, se salta */ }
        }
      } finally { try { lock.release(); } catch (e) {} }
    }
  } finally { try { await client.logout(); } catch (e) {} }
  out.sort(function (a, b) { return a.date - b.date; });
  return out;
}

// ---- SMTP: enviar respuesta con adjuntos ----
async function sendMail(creds, opts, files) {
  const port = Number(creds.smtp.port);
  const transporter = nodemailer.createTransport({
    host: creds.smtp.host, port: port, secure: port === 465,
    auth: { user: creds.smtp.user, pass: creds.smtp.pass }
  });
  const info = await transporter.sendMail({
    from: creds.email || creds.smtp.user,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text || undefined,
    inReplyTo: opts.inReplyTo || undefined,
    references: opts.references || undefined,
    attachments: (files || []).map(function (f) { return { filename: f.originalname, content: f.buffer, contentType: f.mimetype }; })
  });
  return info.messageId;
}

// ---- API ----
app.get("/api/health", function (req, res) { res.json({ ok: true }); });

app.post("/api/email/connect", async function (req, res) {
  try {
    const b = req.body || {};
    const email = String(b.email || "").trim();
    const password = String(b.password || "");
    if (!email || !password) return res.status(400).json({ error: "faltan_datos" });
    const creds = {
      email: email,
      imap: { host: b.imapHost, port: b.imapPort || 993, secure: b.imapSecure !== false, user: b.imapUser || email, pass: password },
      smtp: { host: b.smtpHost, port: b.smtpPort || 465, user: b.smtpUser || email, pass: password }
    };
    if (!creds.imap.host || !creds.smtp.host) return res.status(400).json({ error: "faltan_servidores" });
    // verificar IMAP
    const c = new ImapFlow({ host: creds.imap.host, port: Number(creds.imap.port), secure: creds.imap.secure !== false, auth: { user: creds.imap.user, pass: creds.imap.pass }, logger: false, socketTimeout: 20000 });
    await c.connect(); await c.logout();
    // verificar SMTP
    const port = Number(creds.smtp.port);
    const t = nodemailer.createTransport({ host: creds.smtp.host, port: port, secure: port === 465, auth: { user: creds.smtp.user, pass: creds.smtp.pass } });
    await t.verify();
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, creds);
    res.json({ token: token, email: email });
  } catch (e) {
    res.status(400).json({ error: "conexion_fallida", detail: String(e && e.message || e) });
  }
});

app.post("/api/email/import", auth, async function (req, res) {
  try {
    const contact = String((req.body && req.body.contactEmail) || "").trim();
    if (!contact) return res.status(400).json({ error: "falta_email" });
    const messages = await importConversation(req.creds, contact);
    res.json({ contact: contact, messages: messages });
  } catch (e) {
    res.status(500).json({ error: "import_fallido", detail: String(e && e.message || e) });
  }
});

app.post("/api/email/send", auth, upload.array("attachments"), async function (req, res) {
  try {
    const b = req.body || {};
    if (!b.to || !b.subject) return res.status(400).json({ error: "faltan_datos" });
    let references = b.references || "";
    if (Array.isArray(references)) references = references.join(" ");
    const messageId = await sendMail(req.creds, {
      to: b.to, subject: b.subject, html: b.html || "", text: b.text || "",
      inReplyTo: b.inReplyTo || "", references: references
    }, req.files || []);
    res.json({ ok: true, messageId: messageId });
  } catch (e) {
    res.status(500).json({ error: "envio_fallido", detail: String(e && e.message || e) });
  }
});

// ---- estáticos (la plataforma) ----
app.use(express.static(path.join(__dirname), { extensions: ["html"] }));
app.get("/", function (req, res) { res.sendFile(path.join(__dirname, "Plataforma.html")); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () { console.log("OnePulso server on :" + PORT); });
