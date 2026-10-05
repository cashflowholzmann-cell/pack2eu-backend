// ============================================================
// PACK2EU – ZENTRALE COMPLIANCE ENGINE
// ============================================================

const EU_CODES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK'
]);


// ============================================================
// CODE NORMALISIEREN
// ============================================================

function normalizeCode(code) {

  return String(
    code ?? ''
  )
    .trim()
    .toUpperCase();
}


// ============================================================
// EU LAND?
// ============================================================

function isEUCountry(code) {

  return EU_CODES.has(
    normalizeCode(code)
  );
}


// ============================================================
// COMPLIANCE ENTSCHEIDUNG
// ============================================================

// Rechtsgrundlage + Fallback-Erklärung je Pflichtenstrom, nur für den
// "keine verifizierte Regel"-Fall unten (rule === null) - sobald eine
// echte, recherchierte Regel für Land+Stream vorliegt, kommen Text/Quelle
// von dort, nicht von hier. 'packaging' bleibt exakt der bisherige,
// bereits live genutzte Text (keine Verhaltensänderung für Bestandskunden).
const STREAM_FALLBACK = {
  packaging: {
    legalBasis: 'Regulation (EU) 2025/40',
    sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2025/40/oj',
    explanationRepRequired: 'Sie benötigen für dieses EU-Zielland einen Bevollmächtigten für die erweiterte Herstellerverantwortung, da Sie dort nicht niedergelassen sind (Art. 45 Abs. 3 EU-Verpackungsverordnung PPWR) - unabhängig davon, ob Sie selbst in der EU ansässig sind. Die weiteren nationalen Anforderungen werden noch geprüft.',
    explanationDefault: 'Für dieses Länderpaar liegt bei Pack2EU noch keine verifizierte nationale Regel vor. Deshalb wird keine pauschale Bevollmächtigtenpflicht angenommen.'
  },
  weee: {
    legalBasis: 'Richtlinie 2012/19/EU (WEEE)',
    sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32012L0019',
    explanationRepRequired: 'Als außerhalb der EU ansässiger Händler benötigen Sie für dieses EU-Zielland einen Bevollmächtigten für die Elektro-/Elektronikgeräte-Herstellerverantwortung (WEEE). Die weiteren nationalen Anforderungen werden noch geprüft.',
    explanationDefault: 'Für dieses Länderpaar liegt bei Pack2EU noch keine verifizierte nationale WEEE-Regel vor. Deshalb wird keine pauschale Bevollmächtigtenpflicht angenommen.'
  },
  battery: {
    legalBasis: 'Verordnung (EU) 2023/1542',
    sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1542',
    explanationRepRequired: 'Als außerhalb der EU ansässiger Händler benötigen Sie für dieses EU-Zielland einen Bevollmächtigten für die Batterie-Herstellerverantwortung. Die weiteren nationalen Anforderungen werden noch geprüft.',
    explanationDefault: 'Für dieses Länderpaar liegt bei Pack2EU noch keine verifizierte nationale Batterie-Regel vor. Deshalb wird keine pauschale Bevollmächtigtenpflicht angenommen.'
  }
};

// Übersetzungen (EN/FR/IT/ES) der Fallback-/Status-Texte oben - direkt von
// mir (dem LLM) manuell übersetzt, keine Anthropic-API-Kosten (gleiche
// Vorgabe wie bei den Länder-/Stream-Rechtstexten, siehe db/index.js-
// Kommentar bei applyBundledCountryTranslationSeed()). Bug: die komplette
// Compliance-Weltkarte im Dashboard zeigte diese Texte bisher IMMER auf
// Deutsch, unabhängig von der gewählten Sprache, weil decide() bislang gar
// keinen lang-Parameter kannte. legalBasis bleibt unübersetzt (Gesetzes-
// zitate). Gilt nur für den Fallback-Zweig (rule === null) - eine echte,
// recherchierte compliance_rules-Zeile bringt ihren Text weiterhin auf
// Deutsch mit, da diese Tabelle aktuell noch keine translations_json-Spalte
// hat (bislang keine Zeilen befüllt, siehe Kommentar in routes/compliance.js).
const FALLBACK_TRANSLATIONS = {
  en: {
    unsupportedLegalLabel: 'Destination country not supported',
    unsupportedExplanation: 'This destination country was not found in the Pack2EU country database.',
    needsReviewLegalLabel: 'National rule under review',
    packaging: {
      explanationRepRequired: 'You need an authorised representative for extended producer responsibility for this EU destination country, because you are not established there (Article 45(3) of the EU Packaging Regulation, PPWR) - regardless of whether you are based in the EU yourself. The further national requirements are still being reviewed.',
      explanationDefault: 'Pack2EU does not yet have a verified national rule for this country pair. Therefore, no blanket authorised representative obligation is assumed.'
    },
    weee: {
      explanationRepRequired: 'As a trader established outside the EU, you need an authorised representative for electrical/electronic equipment producer responsibility (WEEE) for this EU destination country. The further national requirements are still being reviewed.',
      explanationDefault: 'Pack2EU does not yet have a verified national WEEE rule for this country pair. Therefore, no blanket authorised representative obligation is assumed.'
    },
    battery: {
      explanationRepRequired: 'As a trader established outside the EU, you need an authorised representative for battery producer responsibility for this EU destination country. The further national requirements are still being reviewed.',
      explanationDefault: 'Pack2EU does not yet have a verified national battery rule for this country pair. Therefore, no blanket authorised representative obligation is assumed.'
    }
  },
  fr: {
    unsupportedLegalLabel: 'Pays de destination non pris en charge',
    unsupportedExplanation: "Ce pays de destination n'a pas été trouvé dans la base de données pays de Pack2EU.",
    needsReviewLegalLabel: 'Règle nationale en cours de vérification',
    packaging: {
      explanationRepRequired: "Vous avez besoin d'un mandataire pour la responsabilité élargie des producteurs pour ce pays de destination de l'UE, car vous n'y êtes pas établi (article 45, paragraphe 3, du règlement UE sur les emballages, PPWR) - que vous soyez établi dans l'UE ou non. Les autres exigences nationales sont encore en cours de vérification.",
      explanationDefault: "Pack2EU ne dispose pas encore d'une règle nationale vérifiée pour cette paire de pays. Aucune obligation générale de mandataire n'est donc supposée."
    },
    weee: {
      explanationRepRequired: "En tant que commerçant établi en dehors de l'UE, vous avez besoin d'un mandataire pour la responsabilité des producteurs d'équipements électriques et électroniques (DEEE) pour ce pays de destination de l'UE. Les autres exigences nationales sont encore en cours de vérification.",
      explanationDefault: "Pack2EU ne dispose pas encore d'une règle nationale DEEE vérifiée pour cette paire de pays. Aucune obligation générale de mandataire n'est donc supposée."
    },
    battery: {
      explanationRepRequired: "En tant que commerçant établi en dehors de l'UE, vous avez besoin d'un mandataire pour la responsabilité des producteurs de piles et batteries pour ce pays de destination de l'UE. Les autres exigences nationales sont encore en cours de vérification.",
      explanationDefault: "Pack2EU ne dispose pas encore d'une règle nationale sur les piles et batteries vérifiée pour cette paire de pays. Aucune obligation générale de mandataire n'est donc supposée."
    }
  },
  it: {
    unsupportedLegalLabel: 'Paese di destinazione non supportato',
    unsupportedExplanation: 'Questo paese di destinazione non è stato trovato nel database paesi di Pack2EU.',
    needsReviewLegalLabel: 'Regola nazionale in fase di verifica',
    packaging: {
      explanationRepRequired: "È necessario un rappresentante autorizzato per la responsabilità estesa del produttore per questo paese di destinazione UE, poiché non vi si è stabiliti (articolo 45, paragrafo 3, del regolamento UE sugli imballaggi, PPWR) - indipendentemente dal fatto che si sia stabiliti nell'UE. Gli ulteriori requisiti nazionali sono ancora in fase di verifica.",
      explanationDefault: "Per questa coppia di paesi, Pack2EU non dispone ancora di una regola nazionale verificata. Pertanto non si presume alcun obbligo generale di rappresentante autorizzato."
    },
    weee: {
      explanationRepRequired: "In quanto commerciante stabilito al di fuori dell'UE, per questo paese di destinazione UE è necessario un rappresentante autorizzato per la responsabilità del produttore di apparecchiature elettriche ed elettroniche (RAEE). Gli ulteriori requisiti nazionali sono ancora in fase di verifica.",
      explanationDefault: "Per questa coppia di paesi, Pack2EU non dispone ancora di una regola nazionale RAEE verificata. Pertanto non si presume alcun obbligo generale di rappresentante autorizzato."
    },
    battery: {
      explanationRepRequired: "In quanto commerciante stabilito al di fuori dell'UE, per questo paese di destinazione UE è necessario un rappresentante autorizzato per la responsabilità del produttore di pile e accumulatori. Gli ulteriori requisiti nazionali sono ancora in fase di verifica.",
      explanationDefault: "Per questa coppia di paesi, Pack2EU non dispone ancora di una regola nazionale sulle pile verificata. Pertanto non si presume alcun obbligo generale di rappresentante autorizzato."
    }
  },
  es: {
    unsupportedLegalLabel: 'País de destino no compatible',
    unsupportedExplanation: 'Este país de destino no se encontró en la base de datos de países de Pack2EU.',
    needsReviewLegalLabel: 'Norma nacional en revisión',
    packaging: {
      explanationRepRequired: 'Necesita un representante autorizado para la responsabilidad ampliada del productor en este país de destino de la UE, ya que no está establecido allí (artículo 45, apartado 3, del Reglamento UE sobre envases, PPWR) - independientemente de si está establecido en la UE. Los demás requisitos nacionales todavía se están revisando.',
      explanationDefault: 'Pack2EU todavía no dispone de una norma nacional verificada para este par de países. Por lo tanto, no se asume ninguna obligación general de representante autorizado.'
    },
    weee: {
      explanationRepRequired: 'Como comerciante establecido fuera de la UE, necesita un representante autorizado para la responsabilidad del productor de aparatos eléctricos y electrónicos (RAEE) en este país de destino de la UE. Los demás requisitos nacionales todavía se están revisando.',
      explanationDefault: 'Pack2EU todavía no dispone de una norma nacional RAEE verificada para este par de países. Por lo tanto, no se asume ninguna obligación general de representante autorizado.'
    },
    battery: {
      explanationRepRequired: 'Como comerciante establecido fuera de la UE, necesita un representante autorizado para la responsabilidad del productor de pilas y baterías en este país de destino de la UE. Los demás requisitos todavía se están revisando.',
      explanationDefault: 'Pack2EU todavía no dispone de una norma nacional sobre pilas verificada para este par de países. Por lo tanto, no se asume ninguna obligación general de representante autorizado.'
    }
  }
};

const SUPPORTED_DECISION_LANGS = ['en', 'fr', 'it', 'es'];

function decide({
  originCountry,
  destinationCountry,
  rule,
  destinationMeta,
  stream = 'packaging',
  lang
}) {

  const t = SUPPORTED_DECISION_LANGS.includes(lang)
    ? FALLBACK_TRANSLATIONS[lang]
    : null;

  const origin =
    normalizeCode(
      originCountry
    );

  const destination =
    normalizeCode(
      destinationCountry
    );

  const originEU =
    isEUCountry(origin);

  // KORREKTUR 10/2026 (vorher fälschlich nur für Nicht-EU-Herkunft
  // angenommen): Art. 45 Abs. 3 PPWR (Verordnung (EU) 2025/40, Art. 3
  // Abs. 1 Nr. 15 Buchst. c/d) verpflichtet JEDEN Hersteller - auch EU-
  // ansässige, nicht nur Nicht-EU -, der nicht im jeweiligen Zielland
  // niedergelassen ist und dort per Fernabsatz direkt an Endverbraucher
  // verkauft, dort einen Bevollmächtigten zu bestellen ("shall appoint"),
  // seit 12.08.2026 unmittelbar EU-weit geltend. Gilt nur für den
  // Verpackungs-Stream. Für WEEE (Richtlinie 2012/19/EU Art. 17) und
  // Batterie (Verordnung (EU) 2023/1542 Art. 43) bleibt die engere,
  // bereits recherchierte Regel bestehen (nur Nicht-EU-Herkunft - siehe
  // STREAM_RESEARCH_FOCUS in legal-watch.js), da das dortige Regelwerk
  // keine entsprechend weite EU-weite Fernabsatz-Pflicht kennt.
  const notEstablishedInDestination =
    origin !== destination;
  const distanceSellingRepresentativeRequired =
    stream === 'packaging'
      ? notEstablishedInDestination && isEUCountry(destination)
      : !originEU && isEUCountry(destination);


  // ----------------------------------------------------------
  // Zielland existiert nicht
  // ----------------------------------------------------------

  if (!destinationMeta) {

    return {

      status:
        'unsupported',

      registrationRequired:
        false,

      representativeRequired:
        false,

      notaryRequired:
        false,

      legalLabel:
        t ? t.unsupportedLegalLabel : 'Zielland nicht unterstützt',

      explanation:
        t ? t.unsupportedExplanation : 'Das Zielland wurde in der Pack2EU-Länderdatenbank nicht gefunden.',

      legalBasis:
        '',

      confidence:
        'unsupported',

      policyVersion:
        '',

      sourceUrl:
        '',

      sourceType:
        'internal',

      providerAvailable:
        false,

      providerId:
        null,

      providerCostEur:
        null,

      effectiveFrom:
        null,

      stream,

      originEU,

      originCountry:
        origin,

      destinationCountry:
        destination

    };
  }


  // ----------------------------------------------------------
  // VERIFIZIERTE REGEL VORHANDEN
  // ----------------------------------------------------------

  if (rule) {

    return {

      status:
        rule.status ||
        'needs_review',

      registrationRequired:
        Number(
          rule.registration_required
        ) === 1,

      representativeRequired:
        distanceSellingRepresentativeRequired ||
        Number(rule.representative_required) === 1,

      notaryRequired:
        Number(
          rule.notary_required
        ) === 1,

      legalLabel:
        rule.legal_label ||
        'Prüfung erforderlich',

      explanation:
        rule.explanation ||
        '',

      legalBasis:
        rule.legal_basis ||
        '',

      confidence:
        rule.confidence ||
        'needs_review',

      policyVersion:
        rule.policy_version ||
        '',

      sourceUrl:
        rule.source_url ||
        '',

      sourceType:
        rule.source_type ||
        'internal',

      providerAvailable:
        Number(
          rule.provider_available
        ) === 1,

      providerId:
        rule.provider_id ||
        null,

      providerCostEur:
        rule.provider_cost_eur ??
        null,

      effectiveFrom:
        rule.effective_from ||
        null,

      stream,

      originEU,

      originCountry:
        origin,

      destinationCountry:
        destination

    };
  }


  // ----------------------------------------------------------
  // KEINE VERIFIZIERTE REGEL
  // ----------------------------------------------------------
  //
  // Für EU-Händler wird ohne verifizierte Länderregel keine pauschale
  // Bevollmächtigtenpflicht behauptet. Bei Nicht-EU-Händlern und einem
  // EU-Zielland gilt die Pflicht jedoch unabhängig davon.
  // ----------------------------------------------------------

  const fallback =
    STREAM_FALLBACK[stream] ||
    STREAM_FALLBACK.packaging;

  const tStream =
    t && (t[stream] || t.packaging);

  return {

    status:
      'needs_review',

    registrationRequired:
      true,

    representativeRequired:
      distanceSellingRepresentativeRequired,

    notaryRequired:
      false,

    legalLabel:
      t ? t.needsReviewLegalLabel : 'Nationale Regel wird geprüft',

    explanation:
      tStream
        ? (distanceSellingRepresentativeRequired ? tStream.explanationRepRequired : tStream.explanationDefault)
        : (distanceSellingRepresentativeRequired ? fallback.explanationRepRequired : fallback.explanationDefault),

    legalBasis:
      fallback.legalBasis,

    confidence:
      'needs_national_rule',

    policyVersion:
      '2026-08-25',

    sourceUrl:
      fallback.sourceUrl,

    sourceType:
      'eu_regulation',

    providerAvailable:
      false,

    providerId:
      null,

    providerCostEur:
      null,

    effectiveFrom:
      null,

    stream,

    originEU,

    originCountry:
      origin,

    destinationCountry:
      destination

  };
}


// ============================================================
// ENTSCHEIDUNG VERIFIZIERT?
// ============================================================

function isVerifiedDecision(decision) {

  return Boolean(
    decision &&
    decision.confidence ===
      'primary_source_verified' &&
    decision.status !==
      'needs_review'
  );
}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  EU_CODES,

  normalizeCode,

  isEUCountry,

  decide,

  isVerifiedDecision

};
