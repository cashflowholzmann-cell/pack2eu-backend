// lib/ch-at-checklist.js
//
// Checkliste für Schweizer Kunden, die nach Österreich liefern - auf
// expliziten Wunsch entstanden, weil Schweizer Shops beim österreichischen
// Zoll überdurchschnittlich oft kontrolliert werden und mehrere völlig
// unterschiedliche Rechtsgebiete gleichzeitig greifen (Verpackungs-EPR,
// Zoll/Einfuhrumsatzsteuer, Verbraucherschutz). Pack2EU selbst deckt NUR
// die Verpackungs-Punkte (owner: 'pack2eu') ab; alles andere (owner:
// 'merchant') ist Zoll-/Steuerrecht und damit außerhalb dessen, was diese
// Plattform anbietet - hier bewusst nur als Erinnerungspunkt mit
// Quellenangabe, keine Ausführung/Beratung.
//
// Content-Stand 09/2026, per WebSearch recherchiert (mehrere
// unabhängige Quellen, siehe je Punkt), NICHT anwaltlich geprüft.
const CH_AT_CHECKLIST_ITEMS = [
  {
    id: 'packaging_registration',
    category: 'Verpackung',
    owner: 'pack2eu',
    text: 'Registrierung im österreichischen Verpackungsregister (EDM) + Lizenzierung bei einem Sammel-/Verwertungssystem (z. B. ARA) - übernimmt Pack2EU für dich.',
    source: 'EDM-Portal / ARA'
  },
  {
    id: 'packaging_representative_notary',
    category: 'Verpackung',
    owner: 'pack2eu',
    text: 'Bevollmächtigten-Vollmacht für Österreich unterschreiben lassen UND notariell beglaubigen (Unterschriftsbeglaubigung, auf Deutsch oder Englisch möglich) - Pack2EU vermittelt den Bevollmächtigten, die Notarbeglaubigung musst du selbst veranlassen (z. B. bei einem Schweizer Notar oder digital, z. B. über notarity.com).',
    source: 'it-recht-kanzlei.de, IHK, deutsche-recycling.de'
  },
  {
    id: 'no_threshold_reminder',
    category: 'Verpackung',
    owner: 'pack2eu',
    text: 'Beachten: Österreich kennt KEINE Bagatellgrenze - die Bevollmächtigten-Pflicht gilt schon ab dem ersten verkauften Paket, nicht erst ab einer Mindestmenge.',
    source: 'wko.at, it-recht-kanzlei.de'
  },
  {
    id: 'eori_number',
    category: 'Zoll',
    owner: 'merchant',
    text: 'EORI-Nummer beantragen (falls noch keine vorhanden) - wird für die Zollabwicklung jeder Sendung in die EU benötigt.',
    source: 'usp.gv.at'
  },
  {
    id: 'ioss_registration',
    category: 'Zoll & Steuern',
    owner: 'merchant',
    text: 'IOSS-Registrierung über einen EU-Fiskalvertreter (Intermediary) prüfen, falls Sendungswert unter 150 € - damit ist die Sendung von der österreichischen Einfuhrumsatzsteuer befreit und der Kunde bekommt keine Nachforderung an der Haustür. Schweizer Unternehmen können sich nicht direkt registrieren, sondern brauchen zwingend einen Intermediary.',
    source: 'usp.gv.at, bmf.gv.at'
  },
  {
    id: 'customs_reform_2026',
    category: 'Zoll & Steuern',
    owner: 'merchant',
    text: 'Seit 1.7.2026: zusätzlicher Pauschalzoll von 3 € pro Warengruppe (KN-Code/HS-Unterposition) bei Sendungen unter 150 € - unbedingt in der Preiskalkulation berücksichtigen, gilt befristet bis 1.7.2028.',
    source: 'bmf.gv.at, taxdoo.com, zoll.de'
  },
  {
    id: 'commercial_invoice_customs_declaration',
    category: 'Zoll',
    owner: 'merchant',
    text: 'Jedem Paket eine zweifache Handelsrechnung (ohne Schweizer MWST, Vermerk "steuerfreie Ausfuhrlieferung") sowie eine Zollinhaltserklärung CN22 (kleine Sendungen) oder CN23 (größere Pakete) sichtbar beifügen.',
    source: 'Post.ch, IHK'
  },
  {
    id: 'ddp_shipping',
    category: 'Logistik',
    owner: 'merchant',
    text: 'DDP-Versandlösung (Delivered Duty Paid, z. B. über Die Schweizerische Post oder DHL) prüfen - Einfuhrumsatzsteuer wird dann direkt im Checkout kassiert, keine böse Überraschung für den Kunden bei Zustellung.',
    source: 'international.post.ch'
  },
  {
    id: 'consumer_rights',
    category: 'Recht',
    owner: 'merchant',
    text: 'AGB und Widerrufsbelehrung an EU-Verbraucherrecht anpassen - österreichische Privatkunden haben ein gesetzliches 14-tägiges Widerrufsrecht ohne Angabe von Gründen.',
    source: 'EU-Verbraucherschutzrecht'
  },
  {
    id: 'geoblocking',
    category: 'Recht',
    owner: 'merchant',
    text: 'Geoblocking-Verordnung beachten - österreichische Kunden dürfen wegen ihrer Staatsangehörigkeit oder ihres Wohnsitzes nicht schlechter gestellt, gesperrt oder vom Kauf ausgeschlossen werden.',
    source: 'EU-Geoblocking-Verordnung'
  },
  {
    id: 'returns_handling',
    category: 'Logistik',
    owner: 'merchant',
    text: 'Retourenlösung für österreichische Kunden klären (z. B. über einen grenznahen deutschen/österreichischen Logistikpartner) - Rückversand direkt in die Schweiz ist für Kunden teuer und zollrechtlich aufwendig.',
    source: 'international.post.ch'
  }
];

function getChecklistWithState(checklistJson) {
  let checked = {};
  try { checked = JSON.parse(checklistJson || '{}'); } catch (e) { checked = {}; }
  return CH_AT_CHECKLIST_ITEMS.map(item => ({
    ...item,
    checked: Boolean(checked[item.id])
  }));
}

module.exports = { CH_AT_CHECKLIST_ITEMS, getChecklistWithState };
