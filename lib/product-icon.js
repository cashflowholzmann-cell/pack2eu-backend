// lib/product-icon.js
//
// Schlägt anhand des Produktnamens ein passendes Emoji-Icon vor, statt des
// generischen 📦-Platzhalters - für Massenimporte, bei denen (noch) kein
// echtes Produktbild vorliegt (z.B. kein verknüpfter Shop). Deckt bewusst
// auch griechische Begriffe ab, da viele Katalognamen (z.B. Bella Rosa)
// griechisch oder gemischt griechisch/englisch sind.
//
// WICHTIG: Diese Liste existiert parallel zu EMOJI_KEYWORD_MAP in
// pack2eu-frontend/dashboard.html (dort für den manuellen "Produkt
// hinzufügen"-Dialog). Es gibt kein gemeinsames Modul zwischen den beiden
// getrennten Repos - bei Änderungen beide Stellen pflegen.
const ICON_KEYWORD_MAP = [
  { keywords: ['βερνίκι νυχιών', 'nail polish', 'nail lacquer', 'top coat', 'nagellack'], icon: '💅' },
  { keywords: ['βαφή μαλλιών', 'hair dye', 'hair color', 'hair colour', 'developer', 'οξειδωτικό', 'haarfärbemittel', 'tönung'], icon: '🎨' },
  { keywords: ['mascara', 'eyeliner', 'kohl', 'μολύβι ματιών', 'wimperntusche'], icon: '👁️' },
  { keywords: ['sheet mask', 'μάσκα προσώπου', 'μάσκα ματιών', 'face mask'], icon: '🧖' },
  { keywords: ['αντηλιακ', 'sunscreen', 'spf'], icon: '☀️' },
  { keywords: ['λαστιχάκια μαλλιών', 'scrunchie', 'hair tie', 'hair elastic'], icon: '🎀' },
  { keywords: ['βούρτσα μαλλιών', 'hairbrush', 'hair brush', 'paddle brush'], icon: '💇' },
  { keywords: ['ρουζ', 'blush', 'bronzer', 'highlighter', 'palette', 'παλέτα', 'σκιές ματιών', 'eyeshadow'], icon: '🎨' },
  { keywords: ['lip gloss', 'lip liner', 'μολύβι χειλιών', 'concealer'], icon: '💄' },
  { keywords: ['ομπρέλα', 'umbrella'], icon: '☂️' },
  { keywords: ['θερμός', 'παγούρι', 'thermos', 'vacuum bottle'], icon: '🥤' },
  { keywords: ['lunchbox', 'lunch box', 'lunch bag'], icon: '🍱' },
  { keywords: ['νεσεσέρ', 'toiletry bag'], icon: '👝' },
  { keywords: ['στυλό', 'μολύβι', 'pen ', 'pencil'], icon: '✏️' },
  { keywords: ['λίμα νυχιών', 'nail file', 'buffer'], icon: '💅' },
  { keywords: ['κερί μαλλιών', 'wax', 'pomade', 'hair paste', 'clay'], icon: '💇' },
  { keywords: ['spray μαλλιών', 'φορμάρισμα', 'hairspray', 'hair spray', 'haarspray', 'styling mousse', 'αφροί μαλλιών'], icon: '💨' },
  { keywords: ['σαμπουάν', 'shampoo'], icon: '🧴' },
  { keywords: ['conditioner', 'μαλακτική'], icon: '🧴' },
  { keywords: ['parfum', 'parfüm', 'perfume', 'άρωμα'], icon: '🧴' },
  { keywords: ['κρέμα', 'cream', 'lotion', 'λοσιόν', 'serum', 'ορός', 'τόνερ', 'toner'], icon: '🧴' },
  { keywords: ['κραγιόν', 'lipstick', 'lippenstift'], icon: '💄' },
  { keywords: ['σαπούνι', 'soap'], icon: '🧼' },
  { keywords: ['ψαλίδι', 'scissors'], icon: '✂️' },
  { keywords: ['πιστολάκι μαλλιών', 'hair dryer'], icon: '💨' }
];

function matchIconForProductName(name) {
  const normalized = ' ' + String(name || '').toLowerCase().trim() + ' ';
  if (normalized.trim() === '') return null;
  for (const entry of ICON_KEYWORD_MAP) {
    if (entry.keywords.some(kw => normalized.includes(kw))) {
      return entry.icon;
    }
  }
  return null;
}

module.exports = { matchIconForProductName, ICON_KEYWORD_MAP };
