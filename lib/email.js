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

// Mehrsprachig wie die COMP_ACCESS-/Willkommens-Mails - Sprache kommt aus
// customers.preferred_lang. Fällt auf Englisch zurück, wenn keine Sprache
// übergeben wird (z.B. Alt-Accounts ohne preferred_lang).
const PASSWORD_RESET_TEXT = {
  de: {
    subject: 'Pack2EU - Passwort zurücksetzen',
    greeting: 'Hallo,',
    body: 'du (oder jemand in deinem Namen) hat einen neuen Zugangscode für dein Pack2EU-Konto angefordert.',
    linkLabel: 'Neues Passwort festlegen',
    validity: 'Der Link ist 60 Minuten gültig. Falls du das nicht warst, kannst du diese E-Mail ignorieren - dein Passwort bleibt unverändert.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: 'Pack2EU - reset your password',
    greeting: 'Hi,',
    body: 'you (or someone on your behalf) requested a new access code for your Pack2EU account.',
    linkLabel: 'Set a new password',
    validity: 'The link is valid for 60 minutes. If this wasn\'t you, you can ignore this email - your password stays unchanged.',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: 'Pack2EU - réinitialiser le mot de passe',
    greeting: 'Bonjour,',
    body: 'tu (ou quelqu\'un en ton nom) as demandé un nouveau code d\'accès pour ton compte Pack2EU.',
    linkLabel: 'Définir un nouveau mot de passe',
    validity: 'Le lien est valable 60 minutes. Si ce n\'était pas toi, tu peux ignorer cet e-mail - ton mot de passe reste inchangé.',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: 'Pack2EU - reimposta la password',
    greeting: 'Ciao,',
    body: 'tu (o qualcuno per tuo conto) ha richiesto un nuovo codice di accesso per il tuo account Pack2EU.',
    linkLabel: 'Imposta una nuova password',
    validity: 'Il link è valido per 60 minuti. Se non sei stato tu, puoi ignorare questa email - la tua password resta invariata.',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: 'Pack2EU - restablecer la contraseña',
    greeting: 'Hola,',
    body: 'tú (o alguien en tu nombre) ha solicitado un nuevo código de acceso para tu cuenta de Pack2EU.',
    linkLabel: 'Establecer una nueva contraseña',
    validity: 'El enlace es válido durante 60 minutos. Si no has sido tú, puedes ignorar este correo - tu contraseña no cambia.',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendPasswordResetEmail(to, resetUrl, lang) {
  const t = PASSWORD_RESET_TEXT[lang] || PASSWORD_RESET_TEXT.en;
  return sendMail({
    to,
    subject: t.subject,
    html: `
      <p>${t.greeting}</p>
      <p>${t.body}</p>
      <p><a href="${resetUrl}">${t.linkLabel}</a></p>
      <p>${t.validity}</p>
      <p>${t.signoff}</p>
    `
  });
}

// Mehrsprachig wie die COMP_ACCESS-/Vertriebs-Follow-up-Mails - Sprache
// kommt aus customers.preferred_lang (bei der Registrierung per currentLang
// gesetzt, siehe POST /auth/register). Fällt auf Englisch zurück, wenn
// keine Sprache übergeben wird (z.B. Alt-Accounts ohne preferred_lang).
const WELCOME_EMAIL_TEXT = {
  de: {
    subject: 'Willkommen bei Pack2EU – der erste Schritt',
    greeting: 'Hallo',
    intro: 'schön, dass du dich bei Pack2EU registriert hast!',
    body: 'Damit wir dir sagen können, welche Verpackungs-/EPR-Pflichten für dich in welchem Land gelten, brauchen wir noch deine Produkte: leg im Dashboard einfach deine SKUs mit Verpackungsmaterial und -gewicht an, dann siehst du sofort eine Übersicht pro Land.',
    linkLabel: 'Jetzt Produkte anlegen',
    questions: 'Falls du Fragen hast, egal wie klein – antworte einfach direkt auf diese E-Mail, die landet bei uns im Team.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: 'Welcome to Pack2EU – your first step',
    greeting: 'Hi',
    intro: 'great to have you registered with Pack2EU!',
    body: 'So we can tell you which packaging/EPR obligations apply to you in which country, we still need your products: just add your SKUs with packaging material and weight in the dashboard, and you\'ll immediately see an overview per country.',
    linkLabel: 'Add products now',
    questions: 'If you have any questions, however small, just reply directly to this email - it goes straight to our team.',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: 'Bienvenue chez Pack2EU – ta première étape',
    greeting: 'Bonjour',
    intro: 'ravis que tu te sois inscrit·e chez Pack2EU !',
    body: 'Pour pouvoir te dire quelles obligations d\'emballage/REP s\'appliquent à toi et dans quel pays, il nous manque encore tes produits : ajoute simplement tes SKU avec le matériau d\'emballage et le poids dans le tableau de bord, tu verras aussitôt un aperçu par pays.',
    linkLabel: 'Ajouter des produits maintenant',
    questions: 'Si tu as des questions, même petites, réponds simplement directement à cet e-mail - il arrive directement à notre équipe.',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: 'Benvenuto/a in Pack2EU – il tuo primo passo',
    greeting: 'Ciao',
    intro: 'siamo felici che ti sia registrato/a su Pack2EU!',
    body: 'Per poterti dire quali obblighi di imballaggio/EPR si applicano a te e in quale paese, ci mancano ancora i tuoi prodotti: aggiungi semplicemente i tuoi SKU con materiale di imballaggio e peso nella dashboard, e vedrai subito una panoramica per paese.',
    linkLabel: 'Aggiungi prodotti ora',
    questions: 'Se hai domande, anche piccole, rispondi direttamente a questa email - arriva dritta al nostro team.',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: 'Bienvenido/a a Pack2EU – tu primer paso',
    greeting: 'Hola',
    intro: '¡qué bien que te hayas registrado en Pack2EU!',
    body: 'Para poder decirte qué obligaciones de envases/RAP se aplican a ti y en qué país, todavía necesitamos tus productos: simplemente añade tus SKU con material de envase y peso en el panel, y verás enseguida un resumen por país.',
    linkLabel: 'Añadir productos ahora',
    questions: 'Si tienes preguntas, por pequeñas que sean, responde directamente a este correo - llega directo a nuestro equipo.',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendWelcomeEmail(to, contactName, lang) {
  const t = WELCOME_EMAIL_TEXT[lang] || WELCOME_EMAIL_TEXT.en;
  const greetingName = contactName ? contactName.split(' ')[0] : null;
  return sendMail({
    to,
    from: process.env.SUPPORT_EMAIL || undefined,
    subject: t.subject,
    html: `
      <p>${t.greeting}${greetingName ? ' ' + greetingName : ''},</p>
      <p>${t.intro}</p>
      <p>${t.body}</p>
      <p><a href="${process.env.APP_URL || 'https://pack2eu.global'}/dashboard.html">${t.linkLabel}</a></p>
      <p>${t.questions}</p>
      <p>${t.signoff}</p>
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

// Mehrsprachig - Sprache kommt aus representatives.preferred_lang (bei
// Anlage aus country_code abgeleitet, siehe lib/lang-by-country.js). Fällt
// auf Englisch zurück, wenn keine Sprache übergeben wird.
const REP_INVITE_TEXT = {
  de: {
    subject: 'Pack2EU - Einladung als Bevollmächtigter',
    greeting: (name) => `Hallo ${name},`,
    body: 'Pack2EU hat für dich einen Zugang als Bevollmächtigter eingerichtet. Über den folgenden Link legst du dein Passwort fest und aktivierst deinen Account:',
    linkLabel: 'Zugang aktivieren',
    validity: 'Der Link ist 48 Stunden gültig. Nach der Aktivierung erhältst du bei jedem Login zusätzlich einen Bestätigungscode per E-Mail.',
    unexpected: 'Falls du diese Einladung nicht erwartet hast, kannst du diese E-Mail einfach ignorieren.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: 'Pack2EU - invitation as authorized representative',
    greeting: (name) => `Hi ${name},`,
    body: 'Pack2EU has set up access for you as an authorized representative. Use the link below to set your password and activate your account:',
    linkLabel: 'Activate access',
    validity: 'The link is valid for 48 hours. After activation, you\'ll also receive a confirmation code by email on every login.',
    unexpected: 'If you weren\'t expecting this invitation, you can simply ignore this email.',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: 'Pack2EU - invitation en tant que mandataire',
    greeting: (name) => `Bonjour ${name},`,
    body: 'Pack2EU a créé pour toi un accès en tant que mandataire. Utilise le lien ci-dessous pour définir ton mot de passe et activer ton compte :',
    linkLabel: 'Activer l\'accès',
    validity: 'Le lien est valable 48 heures. Après l\'activation, tu recevras également un code de confirmation par e-mail à chaque connexion.',
    unexpected: 'Si tu ne t\'attendais pas à cette invitation, tu peux simplement ignorer cet e-mail.',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: 'Pack2EU - invito come rappresentante autorizzato',
    greeting: (name) => `Ciao ${name},`,
    body: 'Pack2EU ha attivato per te un accesso come rappresentante autorizzato. Usa il link qui sotto per impostare la password e attivare il tuo account:',
    linkLabel: 'Attiva accesso',
    validity: 'Il link è valido per 48 ore. Dopo l\'attivazione riceverai anche un codice di conferma via email a ogni accesso.',
    unexpected: 'Se non ti aspettavi questo invito, puoi semplicemente ignorare questa email.',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: 'Pack2EU - invitación como representante autorizado',
    greeting: (name) => `Hola ${name},`,
    body: 'Pack2EU ha activado para ti un acceso como representante autorizado. Usa el siguiente enlace para establecer tu contraseña y activar tu cuenta:',
    linkLabel: 'Activar acceso',
    validity: 'El enlace es válido durante 48 horas. Tras la activación, también recibirás un código de confirmación por correo en cada inicio de sesión.',
    unexpected: 'Si no esperabas esta invitación, puedes simplemente ignorar este correo.',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendRepresentativeInviteEmail(to, name, acceptUrl, lang) {
  const t = REP_INVITE_TEXT[lang] || REP_INVITE_TEXT.en;
  return sendMail({
    to,
    subject: t.subject,
    html: `
      <p>${t.greeting(name)}</p>
      <p>${t.body}</p>
      <p><a href="${acceptUrl}">${t.linkLabel}</a></p>
      <p>${t.validity}</p>
      <p>${t.unexpected}</p>
      <p>${t.signoff}</p>
    `
  });
}

const REP_LOGIN_CODE_TEXT = {
  de: {
    subject: (code) => `Pack2EU - dein Bestätigungscode: ${code}`,
    greeting: 'Hallo,',
    body: 'dein Bestätigungscode für den Login als Bevollmächtigter lautet:',
    validity: 'Der Code ist 10 Minuten gültig. Falls du diesen Login nicht angefordert hast, ändere sicherheitshalber dein Passwort.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    subject: (code) => `Pack2EU - your confirmation code: ${code}`,
    greeting: 'Hi,',
    body: 'your confirmation code to log in as an authorized representative is:',
    validity: 'The code is valid for 10 minutes. If you didn\'t request this login, change your password as a precaution.',
    signoff: 'The Pack2EU team'
  },
  fr: {
    subject: (code) => `Pack2EU - ton code de confirmation : ${code}`,
    greeting: 'Bonjour,',
    body: 'ton code de confirmation pour te connecter en tant que mandataire est :',
    validity: 'Le code est valable 10 minutes. Si tu n\'as pas demandé cette connexion, change ton mot de passe par précaution.',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    subject: (code) => `Pack2EU - il tuo codice di conferma: ${code}`,
    greeting: 'Ciao,',
    body: 'il tuo codice di conferma per accedere come rappresentante autorizzato è:',
    validity: 'Il codice è valido per 10 minuti. Se non hai richiesto questo accesso, cambia la password per precauzione.',
    signoff: 'Il team Pack2EU'
  },
  es: {
    subject: (code) => `Pack2EU - tu código de confirmación: ${code}`,
    greeting: 'Hola,',
    body: 'tu código de confirmación para iniciar sesión como representante autorizado es:',
    validity: 'El código es válido durante 10 minutos. Si no has solicitado este inicio de sesión, cambia tu contraseña por precaución.',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendRepresentativeLoginCodeEmail(to, code, lang) {
  const t = REP_LOGIN_CODE_TEXT[lang] || REP_LOGIN_CODE_TEXT.en;
  return sendMail({
    to,
    subject: t.subject(code),
    html: `
      <p>${t.greeting}</p>
      <p>${t.body}</p>
      <p style="font-size:28px; font-weight:700; letter-spacing:4px;">${code}</p>
      <p>${t.validity}</p>
      <p>${t.signoff}</p>
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

// ============================================================
// SUPPORT-TICKETS (siehe routes/support-tickets.js)
//
// Zwei Mails pro Ticket: eine Eingangsbestätigung an den Kunden, eine
// interne Benachrichtigung an SUPPORT_EMAIL. Beide tragen die Ticketnummer
// im Betreff, damit sie im selben Postfach-Thread landen (Kundenwunsch
// 10/2026: "der Betreff der Mail ist dann die Ticketnummer").
// ============================================================

// Mehrsprachig - Sprache kommt aus customers.preferred_lang. Fällt auf
// Englisch zurück, wenn keine Sprache übergeben wird.
const SUPPORT_TICKET_CONFIRMATION_TEXT = {
  de: {
    greeting: 'Hallo,',
    body: (num) => `danke für deine Nachricht - wir haben sie als Ticket <strong>#${num}</strong> erfasst und bearbeiten Anfragen der Reihe nach, in der sie eingehen.`,
    followup: 'Wir melden uns, sobald dein Ticket dran ist.',
    signoff: 'Dein Pack2EU-Team'
  },
  en: {
    greeting: 'Hi,',
    body: (num) => `thanks for your message - we've logged it as ticket <strong>#${num}</strong> and handle requests strictly in the order they come in.`,
    followup: 'We\'ll get back to you as soon as your ticket is up.',
    signoff: 'The Pack2EU team'
  },
  fr: {
    greeting: 'Bonjour,',
    body: (num) => `merci pour ton message - nous l'avons enregistré comme ticket <strong>#${num}</strong> et traitons les demandes strictement dans l'ordre d'arrivée.`,
    followup: 'Nous reviendrons vers toi dès que ton ticket sera traité.',
    signoff: 'L\'équipe Pack2EU'
  },
  it: {
    greeting: 'Ciao,',
    body: (num) => `grazie per il tuo messaggio - lo abbiamo registrato come ticket <strong>#${num}</strong> e gestiamo le richieste rigorosamente nell'ordine di arrivo.`,
    followup: 'Ti risponderemo non appena il tuo ticket sarà in lavorazione.',
    signoff: 'Il team Pack2EU'
  },
  es: {
    greeting: 'Hola,',
    body: (num) => `gracias por tu mensaje - lo hemos registrado como ticket <strong>#${num}</strong> y gestionamos las solicitudes estrictamente por orden de llegada.`,
    followup: 'Te responderemos en cuanto le toque el turno a tu ticket.',
    signoff: 'El equipo de Pack2EU'
  }
};

function sendSupportTicketConfirmationEmail(to, ticketNumber, message, lang) {
  const t = SUPPORT_TICKET_CONFIRMATION_TEXT[lang] || SUPPORT_TICKET_CONFIRMATION_TEXT.en;
  return sendMail({
    to,
    subject: `Pack2EU Support-Ticket #${ticketNumber}`,
    html: `
      <p>${t.greeting}</p>
      <p>${t.body(ticketNumber)}</p>
      <p style="background:#F8FAFC; border-left:3px solid #0A2540; padding:10px 14px; color:#334155;">${String(message || '').replace(/</g, '&lt;')}</p>
      <p>${t.followup}</p>
      <p>${t.signoff}</p>
    `
  });
}

function sendSupportTicketNotificationEmail(ticketNumber, customer, message) {
  const supportEmail = process.env.SUPPORT_EMAIL;
  if (!supportEmail) {
    console.log(`ℹ️ Support-Ticket #${ticketNumber}: SUPPORT_EMAIL nicht konfiguriert, keine interne Benachrichtigung verschickt.`);
    return Promise.resolve({ sent: false });
  }
  return sendMail({
    to: supportEmail,
    subject: `Pack2EU Support-Ticket #${ticketNumber}`,
    html: `
      <p>Neues Support-Ticket <strong>#${ticketNumber}</strong></p>
      <p>Von: ${customer?.company_name || 'Unbekannt'} (${customer?.customer_number || ''}, ${customer?.email || ''})</p>
      <p style="background:#F8FAFC; border-left:3px solid #0A2540; padding:10px 14px; color:#334155;">${String(message || '').replace(/</g, '&lt;')}</p>
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
  sendSalesFollowupEmail,
  sendSupportTicketConfirmationEmail,
  sendSupportTicketNotificationEmail
};
