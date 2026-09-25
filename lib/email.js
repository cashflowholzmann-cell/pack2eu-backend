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

// ============================================================
// EINHEITLICHER MARKEN-RAHMEN FÜR ALLE SYSTEM-MAILS
//
// LOGO_URL zeigt auf eine öffentlich erreichbare Bild-URL (z. B.
// https://pack2eu.global/logo.png) - fehlt die Env-Var, zeigt die Mail
// stattdessen nur den Markennamen als Text, damit nichts kaputt aussieht,
// solange das Logo noch nicht hochgeladen ist.
// ============================================================

const BRAND_COLOR = '#0A2540';

function wrapEmailHtml(innerHtml) {
  const appUrl = process.env.APP_URL || 'https://pack2eu.global';
  const logoUrl = process.env.LOGO_URL || null;

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <div style="background:${BRAND_COLOR}; padding: 20px; text-align:center;">
        ${logoUrl
          ? `<img src="${logoUrl}" alt="Pack2EU" style="max-height:40px; max-width:220px;" />`
          : `<span style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:0.5px;">Pack2EU</span>`
        }
      </div>
      <div style="padding: 24px 20px; background:#ffffff;">
        ${innerHtml}
      </div>
      <div style="padding: 16px 20px; text-align:center; color:#888888; font-size:12px; border-top:1px solid #eeeeee;">
        Pack2EU · <a href="${appUrl}" style="color:#888888;">${appUrl.replace(/^https?:\/\//, '')}</a>
      </div>
    </div>
  `;
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

async function sendMail({ to, subject, html, text, from }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`ℹ️ E-Mail-Versand übersprungen (SMTP nicht konfiguriert) - wäre an ${to} gegangen: "${subject}"`);
    return { sent: false };
  }

  const wrappedHtml = wrapEmailHtml(html);

  try {
    await transporter.sendMail({
      from: from || process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html: wrappedHtml,
      text: text || wrappedHtml.replace(/<[^>]+>/g, ' ')
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

function sendWelcomeEmail(to, contactName) {
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: 'Willkommen bei Pack2EU – der erste Schritt',
    html: `
      <p>Hallo${greetingName ? ' ' + greetingName : ''},</p>
      <p>schön, dass du dich bei Pack2EU registriert hast!</p>
      <p>Damit wir dir sagen können, welche Verpackungs-/EPR-Pflichten für dich in welchem Land gelten, brauchen wir noch deine Produkte: leg im Dashboard einfach deine SKUs mit Verpackungsmaterial und -gewicht an, dann siehst du sofort eine Übersicht pro Land.</p>
      <p><a href="${process.env.APP_URL || 'https://pack2eu.global'}/dashboard.html">Jetzt Produkte anlegen</a></p>
      <p>Falls du Fragen hast, egal wie klein – antworte einfach direkt auf diese E-Mail, die landet bei uns im Team.</p>
      <p>Dein Pack2EU-Team</p>
    `
  });
}

function sendCompAccessNewAccountEmail(to, contactName, setPasswordUrl, companyName) {
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: 'Pack2EU - dein kostenloser Test-Zugang ist bereit',
    html: `
      <p>Hallo${greetingName ? ' ' + greetingName : ''},</p>
      <p>wir haben ${companyName ? `für ${companyName} ` : 'für euch '}einen kostenlosen Zugang zu Pack2EU eingerichtet - genau so, als hättet ihr bezahlt, ohne Verpflichtung.</p>
      <p>Über den folgenden Link legt ihr euer Passwort fest und könnt sofort loslegen:</p>
      <p><a href="${setPasswordUrl}">Passwort festlegen & starten</a></p>
      <p>Der Link ist 24 Stunden gültig. Schaut euch gerne alles in Ruhe an - über Feedback und Verbesserungsvorschläge freuen wir uns jederzeit.</p>
      <p>Dein Pack2EU-Team</p>
    `
  });
}

function sendCompAccessActivatedEmail(to, contactName) {
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: 'Pack2EU - dein Zugang ist jetzt freigeschaltet',
    html: `
      <p>Hallo${greetingName ? ' ' + greetingName : ''},</p>
      <p>euer bestehendes Pack2EU-Konto ist ab sofort kostenlos freigeschaltet - genau so, als hättet ihr bezahlt, ohne Verpflichtung. Einfach wie gewohnt einloggen.</p>
      <p><a href="${process.env.APP_URL || 'https://pack2eu.global'}/index.html">Zum Login</a></p>
      <p>Falls ihr das Passwort nicht mehr wisst, könnt ihr es jederzeit über "Passwort vergessen" zurücksetzen.</p>
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

// ============================================================
// VERTRIEBS-FOLLOW-UP (24H NACH REGISTRIERUNG OHNE ZAHLUNG)
//
// Bewusst kurz und ohne Druck - eine einzige Erinnerung, kein Mahnwesen.
// Siehe lib/sales-followup.js für den Versand-Trigger (stündlicher Check
// in server.js, KEIN Cron-Dienst nötig).
// ============================================================
function sendSalesFollowupEmail(to, contactName) {
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  const appUrl = process.env.APP_URL || 'https://pack2eu.global';
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: 'Noch offen: dein Pack2EU-Zugang wartet auf dich',
    html: `
      <p>Hallo${greetingName ? ' ' + greetingName : ''},</p>
      <p>du hast dich gestern bei Pack2EU registriert, aber noch keinen Plan gewählt - dein Zugang ist also noch nicht aktiv. Falls dich etwas aufgehalten hat oder du noch Fragen hast: antworte einfach direkt auf diese E-Mail, wir melden uns persönlich.</p>
      <p>Zur Erinnerung, was dich erwartet: ein Dashboard für Verpackungs-/EPR-Pflichten in allen 27 EU-Ländern, ohne für jedes Land eine eigene Lösung suchen zu müssen.</p>
      <p><a href="${appUrl}/index.html#pricing">Jetzt Plan wählen &amp; loslegen</a></p>
      <p>Dein Pack2EU-Team</p>
    `
  });
}

module.exports = {
  isEmailConfigured,
  sendMail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendCompAccessNewAccountEmail,
  sendCompAccessActivatedEmail,
  sendRepresentativeInviteEmail,
  sendRepresentativeLoginCodeEmail,
  sendSalesFollowupEmail
};
