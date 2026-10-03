// lib/weee-battery-items.js
//
// Kundenwunsch: eine Bestellung kann neben reinen Verpackungsartikeln
// (z.B. Shampoo, Nagellack) auch Elektro-/Batterieprodukte enthalten
// (z.B. einen batteriebetriebenen Vibrator). WEEE/Batterie-EPR wird nicht
// nach Gewicht, sondern nach STÜCKZAHL je Kategorie/Batterietyp gemeldet -
// anders als bei Verpackungsmaterialien (routes/skus.js materials_json).
// Diese Datei bündelt die gemeinsame Logik, die jede Bestellquelle (siehe
// routes/orders.js, routes/shopify.js und alle Marktplatz-Sync-Routen)
// nutzt, um aus den bereits vorhandenen SKU-Klassifizierungsfeldern
// (is_electrical_equipment/weee_category, contains_battery/battery_type)
// ein Stückzahl-Aggregat pro Bestellung zu bilden.

const EMPTY_ITEMS = { weee: [], battery: [] };

function emptyWeeeBatteryItems() {
  return { weee: [], battery: [] };
}

// Ein SKU kann gleichzeitig Elektrogerät UND batteriebetrieben sein (z.B.
// der Vibrator) - trägt dann zu BEIDEN Strömen bei. Ohne gesetzte
// Kategorie/Batterietyp wird das Produkt zwar als elektrisch/batterie-
// betrieben geführt, aber nicht in die Meldung aufgenommen (es fehlt die
// für die Meldung nötige Einstufung) - das Frontend zeigt das bereits als
// "Kategorie wählen"-Pflichtfeld, sobald die Checkbox aktiviert ist.
function extractWeeeBatteryItems(sku, quantity) {
  const items = emptyWeeeBatteryItems();
  const qty = Number(quantity) > 0 ? Number(quantity) : 0;
  if (!sku || qty <= 0) return items;

  if (sku.is_electrical_equipment && sku.weee_category) {
    items.weee.push({ category: sku.weee_category, quantity: qty, sku_name: sku.sku_name || null });
  }
  if (sku.contains_battery && sku.battery_type) {
    items.battery.push({ battery_type: sku.battery_type, quantity: qty, sku_name: sku.sku_name || null });
  }
  return items;
}

// Fasst mehrere extractWeeeBatteryItems()-Ergebnisse zusammen (z.B. über
// alle Positionen einer Bestellung) - summiert die Menge je Kategorie/
// Batterietyp, statt Einzelzeilen zu duplizieren.
function mergeWeeeBatteryItems(...itemSets) {
  const merged = { weee: {}, battery: {} };

  itemSets.forEach((set) => {
    if (!set) return;
    (set.weee || []).forEach((entry) => {
      const key = entry.category;
      if (!merged.weee[key]) merged.weee[key] = { category: key, quantity: 0 };
      merged.weee[key].quantity += Number(entry.quantity) || 0;
    });
    (set.battery || []).forEach((entry) => {
      const key = entry.battery_type;
      if (!merged.battery[key]) merged.battery[key] = { battery_type: key, quantity: 0 };
      merged.battery[key].quantity += Number(entry.quantity) || 0;
    });
  });

  return {
    weee: Object.values(merged.weee),
    battery: Object.values(merged.battery)
  };
}

function parseWeeeBatteryItems(json) {
  if (!json) return emptyWeeeBatteryItems();
  try {
    const parsed = JSON.parse(json);
    return {
      weee: Array.isArray(parsed?.weee) ? parsed.weee : [],
      battery: Array.isArray(parsed?.battery) ? parsed.battery : []
    };
  } catch {
    return emptyWeeeBatteryItems();
  }
}

module.exports = {
  EMPTY_ITEMS,
  emptyWeeeBatteryItems,
  extractWeeeBatteryItems,
  mergeWeeeBatteryItems,
  parseWeeeBatteryItems
};
