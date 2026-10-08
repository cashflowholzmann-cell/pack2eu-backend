// lib/credential-crypto.js
//
// AES-256-GCM-Verschlüsselung für Marktplatz-Zugangsdaten (API-Tokens,
// Consumer Secrets, Passwörter) in der customers-Tabelle - die lagen
// bislang im Klartext in der DB. Der Schlüssel kommt ausschließlich aus
// der Umgebungsvariable CREDENTIALS_ENCRYPTION_KEY (nie in der DB selbst),
// damit ein DB-Dump allein nicht mehr ausreicht, um Zugangsdaten zu
// kompromittieren.
//
// Format eines verschlüsselten Werts:
// "enc:v1:<iv base64>:<authTag base64>:<ciphertext base64>"
// Der "enc:v1:"-Präfix macht erkennbar, ob ein Wert schon verschlüsselt ist
// (Migrations-Idempotenz, siehe db/index.js migrateEncryptCredentials()) und
// ist von einem rohen Klartext-Token (z.B. ein Shopify "shpat_..."-Token)
// nie zu verwechseln.
//
// Fehlt CREDENTIALS_ENCRYPTION_KEY (z.B. weil die Variable auf Render noch
// nicht gesetzt wurde), verschlüsselt/entschlüsselt encrypt()/decrypt()
// NICHT, sondern reichen den Wert unverändert durch - bewusst kein harter
// Fehler, der den ganzen Server lahmlegen würde, nur eine einmalige Warnung.
// Sobald die Variable gesetzt ist, greift die Verschlüsselung automatisch
// beim nächsten Request bzw. Serverstart (siehe Migration).
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENC_PREFIX = 'enc:v1:';

let warnedMissingKey = false;
function warnMissingKeyOnce() {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  console.warn('⚠️ CREDENTIALS_ENCRYPTION_KEY fehlt in der .env - Marktplatz-Zugangsdaten werden bis dahin unverschlüsselt gespeichert/gelesen.');
}

function getKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) return null;
  // Akzeptiert eine 64-stellige Hex-Zeichenkette (32 Byte) direkt, oder
  // leitet aus einem beliebigen anderen String per SHA-256 32 Byte ab.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // schon verschlüsselt - nicht doppelt verschlüsseln

  const key = getKey();
  if (!key) {
    warnMissingKeyOnce();
    return plaintext;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncrypted(value)) return value; // Klartext-Altwert (vor der Migration) oder kein verschlüsseltes Feld

  const key = getKey();
  if (!key) {
    warnMissingKeyOnce();
    return value;
  }

  const [, , ivB64, authTagB64, ciphertextB64] = value.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// Spalten in "customers" mit Zugangsdaten zu Marktplatz-APIs - Whitelist
// analog zu MARKETPLACE_SKU_FIELDS in lib/marketplace-auto-sku.js.
const CREDENTIAL_FIELDS = [
  'shopify_access_token',
  'shopify_refresh_token',
  'etsy_access_token',
  'etsy_refresh_token',
  'kaufland_client_key',
  'kaufland_secret_key',
  'woocommerce_consumer_key',
  'woocommerce_consumer_secret',
  'emag_password',
  'shein_open_key_id',
  'shein_secret_key',
  'temu_access_token',
  'amazon_refresh_token',
  'ebay_access_token',
  'ebay_refresh_token',
  'skroutz_api_token',
  'baselinker_api_token'
];

// Entschlüsselt alle bekannten Zugangsdaten-Felder einer Kundenzeile IN
// PLACE - direkt nach jedem "SELECT * FROM customers"-Aufruf benutzen,
// damit der restliche Routen-Code die Felder exakt wie vorher (im
// Klartext) weiterverwenden kann, ohne an jeder einzelnen Nutzungsstelle
// decrypt() aufzurufen.
function decryptCustomerCredentials(customer) {
  if (!customer) return customer;
  CREDENTIAL_FIELDS.forEach(field => {
    if (customer[field] != null) customer[field] = decrypt(customer[field]);
  });
  return customer;
}

module.exports = { encrypt, decrypt, isEncrypted, CREDENTIAL_FIELDS, decryptCustomerCredentials };
