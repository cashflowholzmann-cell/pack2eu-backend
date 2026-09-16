// lib/email.js
//
// Provider-unabhängiger Transaktions-E-Mail-Versand über SMTP (Nodemailer).
// Funktioniert mit praktisch jedem Anbieter (Gmail-SMTP, SendGrid,
// Postmark, AWS-SES-SMTP-Relay, ...) - einfach die passenden SMTP_*-
// Umgebungsvariablen setzen (siehe .env.example). Ohne diese Variablen
// wird der Versand übersprungen und nur geloggt, statt den aufrufenden
// Request scheitern zu lassen (z. B. "Passwort vergessen" soll auch
// funktionieren, wenn SMTP noch nicht eingerichtet ist - der Kunde
// bekommt dann zwar keine Mail, aber die Anfrage selbst crasht nicht).
const nodemailer = require('nodemailer');

let cachedTransporter = null;
let cachedTransporterKey = null;

function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isEmailConfigured()) return null;

  const key = `${process.env.SMTP_HOST}:${process.env.SMTP_PORT}:${process.env.SMTP_USER}`;
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`ℹ️ E-Mail-Versand übersprungen (SMTP nicht konfiguriert) - wäre an ${to} gegangen: "${subject}"`);
    return { sent: false };
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ')
    });
    return { sent: true };
  } catch (error) {
    console.error('❌ E-Mail-Versand fehlgeschlagen:', error.message);
    return { sent: false, error: error.message };
  }
}

function sendPasswordResetEmail(to, resetUrl) {
  return sendMail({
    to,
    subject: 'Pack2EU - Passwort zurücksetzen',
    html: `
      <p>Hallo,</p>
      <p>du (oder jemand in deinem Namen) hat einen neuen Zugangscode für dein Pack2EU-Konto angefordert.</p>
      <p><a href="${resetUrl}">Neues Passwort festlegen</a></p>
      <p>Der Link ist 60 Minuten gültig. Falls du das nicht warst, kannst du diese E-Mail ignorieren - dein Passwort bleibt unverändert.</p>
      <p>Dein Pack2EU-Team</p>
    `
  });
}

function sendRepresentativeInviteEmail(to, name, acceptUrl) {
  return sendMail({
    to,
    subject: 'Pack2EU - Einladung als Bevollmächtigter',
    html: `
      <p>Hallo ${name},</p>
      <p>Pack2EU hat für dich einen Zugang als Bevollmächtigter eingerichtet. Über den folgenden Link legst du dein Passwort fest und aktivierst deinen Account:</p>
      <p><a href="${acceptUrl}">Zugang aktivieren</a></p>
      <p>Der Link ist 48 Stunden gültig. Nach der Aktivierung erhältst du bei jedem Login zusätzlich einen Bestätigungscode per E-Mail.</p>
      <p>Falls du diese Einladung nicht erwartet hast, kannst du diese E-Mail einfach ignorieren.</p>
      <p>Dein Pack2EU-Team</p>
    `
  });
}

function sendRepresentativeLoginCodeEmail(to, code) {
  return sendMail({
    to,
    subject: `Pack2EU - dein Bestätigungscode: ${code}`,
    html: `
      <p>Hallo,</p>
      <p>dein Bestätigungscode für den Login als Bevollmächtigter lautet:</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:4px;">${code}</p>
      <p>Der Code ist 10 Minuten gültig. Falls du diesen Login nicht angefordert hast, ändere sicherheitshalber dein Passwort.</p>
      <p>Dein Pack2EU-Team</p>
    `
  });
}

module.exports = {
  isEmailConfigured,
  sendMail,
  sendPasswordResetEmail,
  sendRepresentativeInviteEmail,
  sendRepresentativeLoginCodeEmail
};
