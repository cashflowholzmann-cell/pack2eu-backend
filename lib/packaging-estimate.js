// lib/packaging-estimate.js
//
// KI-Verpackungsschätzung pro Produktname - ausgelagert aus routes/skus.js
// (POST /skus/estimate-packaging), damit dieselbe, bereits produktiv
// genutzte Logik auch vom Cluster-Batch-Import (lib/cluster-import.js,
// siehe Bella-Rosa-Katalogimport) wiederverwendet werden kann, statt den
// Prompt/das Schema ein zweites Mal zu pflegen.
//
// WICHTIG (siehe ausführliche Begründung in der ursprünglichen Route):
// Das ist bewusst KEINE "Websuche nach dem echten Produkt" - das Modell
// schätzt rein aus allgemeinem Wissen über typische Verpackungen dieser
// Produktart und liefert IMMER einen Unsicherheits-Hinweis mit, nie eine
// verifizierte Tatsache. Kein web_search-Tool, damit das Modell gar nicht
// erst versucht, (unbelegbare) Quellen vorzutäuschen.
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod/v4');

const PackagingEstimateSchema = z.object({
  components: z.array(z.object({
    material: z.enum(['glas', 'kunststoff', 'karton', 'papier', 'metall', 'holz']),
    material_subtype: z.string().max(40),
    weight_grams: z.number().int().positive().max(5000),
    component_label: z.string().max(40)
  })).min(1).max(6),
  confidence_note: z.string().max(300)
});

const PACKAGING_ESTIMATE_SYSTEM_PROMPT = `
Du schätzt die typische Verpackungszusammensetzung eines genannten Produkts,
für die Vorbefüllung eines Formulars zur EU-Verpackungsregistrierung (EPR)
in einem Kosmetik-/Beauty-Online-Shop.

WICHTIG: Du hast KEINEN Zugriff auf echte Hersteller- oder Produktdatenblätter
und sollst auch nicht so tun, als hättest du welche. Gib eine ehrliche,
auf allgemeinem Wissen über typische Verpackungen dieser Produktart
basierende SCHÄTZUNG ab - keine erfundenen "recherchierten" Fakten,
keine Herstellerquellen, keine Chargen-/Losangaben, keine Nachkommastellen-
Präzision. Runde jedes Gewicht auf ganze Gramm aus einer einzigen
plausiblen Zahl (keine Spannen wie "24-26g").

Nenne 2-5 plausible Verpackungsbestandteile (z.B. Behälter/Flakon,
Verschluss/Deckel, Pumpe/Applikator, Umverpackung/Faltschachtel) mit
jeweils einem Gewicht und einem erkennbaren Materialtyp.

confidence_note: ein kurzer, ehrlicher Satz auf Deutsch, der klarmacht,
dass dies eine ungeprüfte Schätzung ist, kein recherchiertes Faktum (z.B.
"Richtwert basierend auf typischen Verpackungen dieser Produktkategorie -
bitte mit dem tatsächlichen Produkt abgleichen oder beim Lieferanten
nachfragen").

Falls der Produktname zu vage ist, um eine sinnvolle Schätzung
abzugeben, schätze trotzdem anhand der erkennbaren Produktkategorie
(z.B. "Nagellack" ist auch ohne genaue Marke erkennbar).

SETS/BUNDLES: Wenn der Produktname auf mehrere Stück desselben oder
ähnlicher Artikel hindeutet (z.B. "Set", "Kit", "Duo", "Trio", "3-teilig",
"tlg", griechisch "τμχ", "pcs", "pack of 3"), erkenne die Stückzahl aus dem
Namen falls möglich und skaliere das Gewicht der Einzelverpackung
entsprechend hoch (nicht einfach 1x ansetzen). Ergänze zusätzlich eine
eigene Set-Umverpackung (z.B. Faltschachtel oder Kunststoff-Clamshell) als
separate Komponente, da Sets zusätzlich zu den Einzelverpackungen fast
immer eine gemeinsame Außenverpackung haben. Ist die genaue Stückzahl
nicht erkennbar, aber "Set"/"Kit" klar erkennbar, nimm eine realistische
Mindestannahme (z.B. 2-3 Stück) und mach das in der confidence_note
kenntlich.

SPRAY-PRODUKTE: Bei Haarspray, Deo-Spray, Stylingspray o.ä., wo aus dem
Namen nicht hervorgeht, ob es sich um eine Aerosol-Dose (Metall, mit
Treibgas) oder eine Pumpflasche (Kunststoff, ohne Treibgas) handelt, triff
KEINE einseitige Annahme ohne Hinweis. Gib stattdessen eine Komponente mit
dem Materialtyp an, der laut deinem Wissen für diese konkrete
Produktart/Marke überwiegt, und mach die Unsicherheit explizit in der
confidence_note kenntlich (z.B. "Aerosol- oder Pumpflasche nicht aus dem
Namen ableitbar - hier Annahme Aerosoldose, bitte prüfen"). Erfinde keine
Gramm-genaue Mischung aus beidem - das wäre weniger ehrlich als eine klar
benannte Annahme.
`.trim();

async function estimatePackaging(productName) {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    output_config: {
      format: zodOutputFormat(PackagingEstimateSchema),
      effort: 'low'
    },
    system: PACKAGING_ESTIMATE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Produktname: ${productName}` }]
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error('Schätzung konnte nicht verarbeitet werden.');
  }
  return { components: parsed.components, confidenceNote: parsed.confidence_note };
}

module.exports = { estimatePackaging, PackagingEstimateSchema, PACKAGING_ESTIMATE_SYSTEM_PROMPT };
