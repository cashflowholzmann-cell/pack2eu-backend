// lib/material-savings.js
//
// Rechner für den "Material-Spar-Check" im SKU-Editor: vergleicht die
// Lizenzentgelt-Kosten einer aktuellen Materialzeile gegen eine vom
// Nutzer frei gewählte Alternative (z. B. Kunststoff-Umverpackung ->
// Papier), auf Basis der in material_license_rates gepflegten €/kg-
// Sätze (siehe Kommentar dort: Richtwerte, kein Rechtstext - Kunden
// sollten ihre echten Vertragssätze eintragen).
//
// Bewusst KEIN automatischer "nimm doch Material X"-Vorschlag: ob eine
// Alternative für ein konkretes Produkt physisch/funktional überhaupt
// geht, kann dieses System nicht beurteilen. Der Nutzer wählt die
// Alternative selbst, der Rechner zeigt nur die reale €-Differenz.
const { db } = require('../db');

function getRates() {
  return db.prepare(`
    SELECT id, material, subtype, price_per_kg_eur, source, updated_at
    FROM material_license_rates
    ORDER BY material, subtype IS NOT NULL, subtype
  `).all();
}

function buildRateIndex(rates) {
  const index = {};
  for (const r of rates) {
    index[r.material + '|' + (r.subtype || '')] = r;
  }
  return index;
}

// Exakte Subtyp-Zeile bevorzugt, sonst Rückfall auf die subtyp-lose
// Zeile des Materials (z. B. unbekannter/nicht erfasster Kunststofftyp).
function findRate(rateIndex, material, subtype) {
  if (!material) return null;
  const key = String(material).toLowerCase();
  return rateIndex[key + '|' + (subtype || '')] || rateIndex[key + '|'] || null;
}

function costForLine(weightGrams, material, subtype, rateIndex) {
  const rate = findRate(rateIndex, material, subtype);
  if (!rate || !Number.isFinite(weightGrams) || weightGrams <= 0) return null;
  const kg = weightGrams / 1000;
  return { costPerUnit: kg * rate.price_per_kg_eur, rate };
}

// Kostenaufschlüsselung einer SKU nach ihren aktuellen Materialzeilen.
function computeSkuCost(sku, rates) {
  const rateIndex = buildRateIndex(rates);
  let materials;
  try { materials = JSON.parse(sku.materials_json); } catch (e) { materials = []; }
  if (!Array.isArray(materials)) materials = [];

  const lines = materials.map((m, materialIndex) => {
    const weight = Number(m && m.weight_grams);
    const result = costForLine(weight, m && m.material, m && m.material_subtype, rateIndex);
    return {
      materialIndex,
      material: m && m.material,
      material_subtype: (m && m.material_subtype) || null,
      weight_grams: weight,
      costPerUnit: result ? Math.round(result.costPerUnit * 10000) / 10000 : null,
      rateSource: result ? result.rate.source : null
    };
  });

  const totalPerUnit = lines.reduce((sum, l) => sum + (l.costPerUnit || 0), 0);
  const annualUnits = Number(sku.estimated_annual_units);
  const hasAnnual = Number.isFinite(annualUnits) && annualUnits > 0;

  return {
    sku_id: sku.id,
    sku_name: sku.sku_name,
    lines,
    totalPerUnit: Math.round(totalPerUnit * 10000) / 10000,
    estimated_annual_units: hasAnnual ? annualUnits : null,
    totalPerYear: hasAnnual ? Math.round(totalPerUnit * annualUnits * 100) / 100 : null
  };
}

// Simuliert einen Materialtausch für EINE Zeile einer SKU, ohne die SKU
// selbst zu verändern - reine Was-wäre-wenn-Berechnung.
function simulateAlternative({ currentWeightGrams, currentMaterial, currentSubtype, altWeightGrams, altMaterial, altSubtype, annualUnits }, rates) {
  const rateIndex = buildRateIndex(rates);
  const current = costForLine(currentWeightGrams, currentMaterial, currentSubtype, rateIndex);
  const alt = costForLine(altWeightGrams, altMaterial, altSubtype, rateIndex);

  if (!current || !alt) {
    return { error: 'Für eines der Materialien liegt kein Lizenzentgelt-Richtwert vor.' };
  }

  const savingsPerUnit = current.costPerUnit - alt.costPerUnit;
  const hasAnnual = Number.isFinite(annualUnits) && annualUnits > 0;

  return {
    currentCostPerUnit: Math.round(current.costPerUnit * 10000) / 10000,
    altCostPerUnit: Math.round(alt.costPerUnit * 10000) / 10000,
    savingsPerUnit: Math.round(savingsPerUnit * 10000) / 10000,
    currentRateSource: current.rate.source,
    altRateSource: alt.rate.source,
    savingsPerYear: hasAnnual ? Math.round(savingsPerUnit * annualUnits * 100) / 100 : null
  };
}

module.exports = { getRates, buildRateIndex, findRate, computeSkuCost, simulateAlternative };
