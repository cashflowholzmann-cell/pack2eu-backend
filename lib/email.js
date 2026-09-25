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

// Mehrsprachig (DE/EN/FR/IT/ES, gleiche 5 Sprachen wie im restlichen
// Produkt) - vorher fest Deutsch, egal an wen die Einladung ging (Bug:
// eine Einladung an z.B. griechische Interessenten kam auf Deutsch an).
// 'lang' kommt vom Admin-Formular (admin.html); unbekannte/leere Werte
// fallen auf 'en' zurück (Nutzerentscheidung 25.09.2026: Englisch statt
// Deutsch als Standard, da die meisten Interessenten nicht deutschsprachig
// sind), damit bestehende Aufrufe ohne lang-Parameter (z.B.
// TEST_ACCESS_EMAILS-Auto-Grant in routes/auth.js) trotzdem sinnvoll
// funktionieren.
const COMP_ACCESS_NEW_ACCOUNT_TEXT = {
  de: {
    subject: 'Pack2EU - dein kostenloser Test-Zugang ist bereit',
    greeting: 'Hallo',
    intro: (company) => `wir haben ${company ? `für ${company} ` : 'für euch '}einen kostenlosen Zugang zu Pack2EU eingerichtet - genau so, als hättet ihr bezahlt, ohne Verpflichtung.`,
    linkIntro: 'Über den folgenden Link legt ihr euer Passwort fest und könnt sofort loslegen:',
    linkLabel: 'Passwort festlegen & starten',
    validity: 'Der Link ist 48 Stunden gültig. Schaut euch gerne alles in Ruhe an - über Feedback und Verbesserungsvorschläge freuen wir uns jederzeit.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: 'Pack2EU - your free test access is ready',
    greeting: 'Hi',
    intro: (company) => `we've set up free access to Pack2EU ${company ? `for ${company}` : 'for you'} - just like a paid account, no strings attached.`,
    linkIntro: 'Use the link below to set your password and get started right away:',
    linkLabel: 'Set password & start',
    validity: 'The link is valid for 48 hours. Take your time exploring - we\'d love to hear any feedback or suggestions.',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: 'Pack2EU - ton accès de test gratuit est prêt',
    greeting: 'Bonjour',
    intro: (company) => `nous avons mis en place un accès gratuit à Pack2EU ${company ? `pour ${company}` : 'pour vous'} - exactement comme si vous aviez payé, sans engagement.`,
    linkIntro: 'Utilise le lien ci-dessous pour définir ton mot de passe et commencer tout de suite :',
    linkLabel: 'Définir le mot de passe et démarrer',
    validity: 'Le lien est valable 48 heures. Prends le temps de tout découvrir - tes retours et suggestions sont toujours les bienvenus.',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: 'Pack2EU - il tuo accesso di prova gratuito è pronto',
    greeting: 'Ciao',
    intro: (company) => `abbiamo attivato un accesso gratuito a Pack2EU ${company ? `per ${company}` : 'per te'} - esattamente come se avessi pagato, senza impegno.`,
    linkIntro: 'Usa il link qui sotto per impostare la password e iniziare subito:',
    linkLabel: 'Imposta la password e inizia',
    validity: 'Il link è valido per 48 ore. Prenditi il tempo per esplorare tutto - siamo sempre felici di ricevere feedback e suggerimenti.',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: 'Pack2EU - tu acceso de prueba gratuito está listo',
    greeting: 'Hola',
    intro: (company) => `hemos activado un acceso gratuito a Pack2EU ${company ? `para ${company}` : 'para ti'} - igual que si hubieras pagado, sin compromiso.`,
    linkIntro: 'Usa el siguiente enlace para establecer tu contraseña y empezar enseguida:',
    linkLabel: 'Establecer contraseña y empezar',
    validity: 'El enlace es válido durante 48 horas. Tómate tu tiempo para explorarlo todo - siempre agradecemos comentarios y sugerencias.',
    signoff: 'El equipo de Pack2EU'
  }
};

const COMP_ACCESS_ACTIVATED_TEXT = {
  de: {
    subject: 'Pack2EU - dein Zugang ist jetzt freigeschaltet',
    greeting: 'Hallo',
    body: 'euer bestehendes Pack2EU-Konto ist ab sofort kostenlos freigeschaltet - genau so, als hättet ihr bezahlt, ohne Verpflichtung. Einfach wie gewohnt einloggen.',
    linkLabel: 'Zum Login',
    forgot: 'Falls ihr das Passwort nicht mehr wisst, könnt ihr es jederzeit über "Passwort vergessen" zurücksetzen.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: 'Pack2EU - your access is now unlocked',
    greeting: 'Hi',
    body: 'your existing Pack2EU account is now unlocked for free - just like a paid account, no strings attached. Simply log in as usual.',
    linkLabel: 'Go to login',
    forgot: 'If you\'ve forgotten your password, you can reset it anytime via "Forgot password".',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: 'Pack2EU - ton accès est maintenant débloqué',
    greeting: 'Bonjour',
    body: 'ton compte Pack2EU existant est désormais débloqué gratuitement - exactement comme si tu avais payé, sans engagement. Connecte-toi simplement comme d\'habitude.',
    linkLabel: 'Se connecter',
    forgot: 'Si tu as oublié ton mot de passe, tu peux le réinitialiser à tout moment via "Mot de passe oublié".',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: 'Pack2EU - il tuo accesso è ora sbloccato',
    greeting: 'Ciao',
    body: 'il tuo account Pack2EU esistente è ora sbloccato gratuitamente - esattamente come se avessi pagato, senza impegno. Accedi semplicemente come al solito.',
    linkLabel: 'Vai al login',
    forgot: 'Se non ricordi più la password, puoi reimpostarla in qualsiasi momento tramite "Password dimenticata".',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: 'Pack2EU - tu acceso ya está desbloqueado',
    greeting: 'Hola',
    body: 'tu cuenta existente de Pack2EU ya está desbloqueada de forma gratuita - igual que si hubieras pagado, sin compromiso. Simplemente inicia sesión como siempre.',
    linkLabel: 'Ir al login',
    forgot: 'Si has olvidado tu contraseña, puedes restablecerla en cualquier momento con "Olvidé mi contraseña".',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendCompAccessNewAccountEmail(to, contactName, setPasswordUrl, companyName, lang) {
  const t = COMP_ACCESS_NEW_ACCOUNT_TEXT[lang] || COMP_ACCESS_NEW_ACCOUNT_TEXT.en;
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: t.subject,
    html: `
      <p>${t.greeting}${greetingName ? ' ' + greetingName : ''},</p>
      <p>${t.intro(companyName)}</p>
      <p>${t.linkIntro}</p>
      <p><a href="${setPasswordUrl}">${t.linkLabel}</a></p>
      <p>${t.validity}</p>
      <p>${t.signoff}</p>
    `
  });
}

function sendCompAccessActivatedEmail(to, contactName, lang) {
  const t = COMP_ACCESS_ACTIVATED_TEXT[lang] || COMP_ACCESS_ACTIVATED_TEXT.en;
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: t.subject,
    html: `
      <p>${t.greeting}${greetingName ? ' ' + greetingName : ''},</p>
      <p>${t.body}</p>
      <p><a href="${process.env.APP_URL || 'https://pack2eu.global'}/index.html">${t.linkLabel}</a></p>
      <p>${t.forgot}</p>
      <p>${t.signoff}</p>
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
//
// Mehrsprachig wie die COMP_ACCESS-Mails oben. Die "customers"-Tabelle
// speichert (Stand 09/2026) keine bevorzugte Sprache pro Kunde - das
// Registrierungsformular selbst ist nur eine Landingpage-Sprachauswahl,
// nicht persistiert - deshalb ruft lib/sales-followup.js diese Funktion
// ohne lang auf und bekommt automatisch Englisch (Nutzerentscheidung
// 25.09.2026: Englisch statt Deutsch als Standard).
// ============================================================
const SALES_FOLLOWUP_TEXT = {
  de: {
    subject: 'Noch offen: dein Pack2EU-Zugang wartet auf dich',
    greeting: 'Hallo',
    body1: 'du hast dich gestern bei Pack2EU registriert, aber noch keinen Plan gewählt - dein Zugang ist also noch nicht aktiv. Falls dich etwas aufgehalten hat oder du noch Fragen hast: antworte einfach direkt auf diese E-Mail, wir melden uns persönlich.',
    body2: 'Zur Erinnerung, was dich erwartet: ein Dashboard für Verpackungs-/EPR-Pflichten in allen 27 EU-Ländern, ohne für jedes Land eine eigene Lösung suchen zu müssen.',
    linkLabel: 'Jetzt Plan wählen & loslegen',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: 'Still open: your Pack2EU access is waiting',
    greeting: 'Hi',
    body1: 'you registered with Pack2EU yesterday but haven\'t chosen a plan yet - so your access isn\'t active yet. If something got in the way or you still have questions, just reply directly to this email and we\'ll get back to you personally.',
    body2: 'As a reminder, here\'s what\'s waiting for you: a dashboard for packaging/EPR obligations across all 27 EU countries, without having to find a separate solution for each one.',
    linkLabel: 'Choose a plan & get started',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: 'Toujours en attente : ton accès Pack2EU t\'attend',
    greeting: 'Bonjour',
    body1: 'tu t\'es inscrit hier chez Pack2EU mais tu n\'as pas encore choisi de forfait - ton accès n\'est donc pas encore actif. Si quelque chose t\'en a empêché ou si tu as encore des questions, réponds simplement directement à cet e-mail, nous te répondrons personnellement.',
    body2: 'Pour rappel, ce qui t\'attend : un tableau de bord pour les obligations d\'emballage/REP dans les 27 pays de l\'UE, sans devoir chercher une solution différente pour chaque pays.',
    linkLabel: 'Choisir un forfait et démarrer',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: 'Ancora aperto: il tuo accesso a Pack2EU ti aspetta',
    greeting: 'Ciao',
    body1: 'ieri ti sei registrato su Pack2EU ma non hai ancora scelto un piano - quindi il tuo accesso non è ancora attivo. Se qualcosa te l\'ha impedito o hai ancora domande, rispondi direttamente a questa email, ti risponderemo personalmente.',
    body2: 'Per ricordarti cosa ti aspetta: una dashboard per gli obblighi di imballaggio/EPR in tutti i 27 paesi UE, senza dover cercare una soluzione diversa per ogni paese.',
    linkLabel: 'Scegli un piano e inizia',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: 'Aún pendiente: tu acceso a Pack2EU te espera',
    greeting: 'Hola',
    body1: 'ayer te registraste en Pack2EU pero todavía no has elegido un plan - así que tu acceso aún no está activo. Si algo te lo impidió o todavía tienes preguntas, simplemente responde directamente a este correo y te contestaremos personalmente.',
    body2: 'Como recordatorio, esto es lo que te espera: un panel para las obligaciones de envases/RAP en los 27 países de la UE, sin tener que buscar una solución distinta para cada país.',
    linkLabel: 'Elegir un plan y empezar',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendSalesFollowupEmail(to, contactName, lang) {
  const t = SALES_FOLLOWUP_TEXT[lang] || SALES_FOLLOWUP_TEXT.en;
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  const appUrl = process.env.APP_URL || 'https://pack2eu.global';
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: t.subject,
    html: `
      <p>${t.greeting}${greetingName ? ' ' + greetingName : ''},</p>
      <p>${t.body1}</p>
      <p>${t.body2}</p>
      <p><a href="${appUrl}/index.html#pricing">${t.linkLabel}</a></p>
      <p>${t.signoff}</p>
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
