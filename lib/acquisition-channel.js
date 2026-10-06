// lib/acquisition-channel.js
//
// Einzige Stelle, die Referrer/UTM-Quelle in einen kompakten Kanal-String
// übersetzt - vorher gab es das zweimal (routes/admin.js classifyChannel()
// und index.html getAcquisitionSource()), mit identischer, aber getrennt
// gepflegter Logik. Jetzt von beiden Seiten genutzt: hier serverseitig
// (routes/admin.js, routes/auth.js), clientseitig bleibt index.html eine
// bewusste Kopie (reines Frontend, kein gemeinsames Build), MUSS aber bei
// Änderungen hier synchron gehalten werden.
function classifyChannel(referrer, utmSource) {
  if (utmSource) return String(utmSource).toLowerCase().slice(0, 100);
  const ref = String(referrer || '').toLowerCase();
  if (!ref) return 'direkt';
  if (/facebook|instagram|tiktok|linkedin|twitter|x\.com|pinterest/.test(ref)) return 'social_media';
  if (/google|bing|duckduckgo|yahoo/.test(ref)) return 'suchmaschine';
  return 'sonstige_website';
}

module.exports = { classifyChannel };
