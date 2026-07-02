/* ============================================================================
   INTESA — Configuratore di pagamento per consulenti commerciali
   Vanilla JS, nessuna dipendenza, offline-first (PWA).
   Motore GENERICO a Profili Provider: l'algoritmo non conosce Scalapay/Klarna,
   legge sempre le regole del profilo selezionato. Testato per compatibilità
   totale (lato cliente) con la versione precedente.
   ========================================================================== */

// ---- Utilità numeriche ----------------------------------------------------
const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

// ---- Calcolo della VPL (Valore per Lead) ----------------------------------
// Formula LINEARE e completamente configurabile dal Pannello Admin.
// Nessuna formula finanziaria: i coefficienti definiscono le regole aziendali.
function calcVPL(metrics, vpl) {
  return (
    vpl.base +
    vpl.cPrezzo * metrics.venduto +
    vpl.cIncasso * metrics.incassatoOggi +
    vpl.cLiquidita * metrics.pctLiquidita + // 0..100
    vpl.cBNPL * metrics.importoBNPL +
    vpl.cCredito * metrics.bonificoCredito // di norma negativo
  );
}

// ---- Extra prima rata: lettura delle regole dal profilo provider ----------
// Il motore NON conosce Scalapay/Klarna: legge sempre profile.extra.
// Ritorna { E, gestione } dove gestione ∈ 'redistribuisci' | 'costo'.
function providerExtra(profile, amount) {
  const ex = (profile && profile.extra) || {};
  const val = ex.valore || 0;
  const E = ex.tipo === 'percentuale' ? (amount * val) / 100 : val;
  let gestione = ex.modalita;                 // 'redistribuisci' | 'costo' | 'manuale'
  if (gestione === 'manuale') gestione = ex.gestione || 'redistribuisci';
  return { E: Math.max(0, E), gestione: gestione || 'redistribuisci' };
}

// Costruisce l'array mensile di UN provider e l'eventuale costo extra.
function buildProviderMonthly(amount, rate, H, profile) {
  const arr = new Array(H).fill(0);
  let costoExtra = 0;
  if (amount > 0 && rate > 0) {
    const base = amount / rate;
    const { E, gestione } = providerExtra(profile, amount);
    if (E > 0 && gestione === 'redistribuisci' && rate > 1) {
      // La 1ª rata sale, le altre scendono: TOTALE finanziato invariato = amount
      const first = base + E;
      const rest = (amount - first) / (rate - 1);
      arr[0] = first;
      for (let m = 1; m < rate; m++) arr[m] = rest;
    } else if (E > 0 && gestione === 'costo') {
      // Costo aggiuntivo a carico del cliente sulla 1ª rata: NON tocca il finanziato
      for (let m = 0; m < rate; m++) arr[m] = base;
      arr[0] += E;
      costoExtra = E;
    } else {
      for (let m = 0; m < rate; m++) arr[m] = base; // nessun extra (default)
    }
  }
  return { arr, costoExtra };
}

// ---- Costruzione del piano mensile per una singola allocazione ------------
// alloc = { A (acconto bonifico), B (bonifico credito), prov: [{id,amount,rate,_profile}] }
function buildSchedule(alloc, input, cfg) {
  let H = input.nRate;
  for (const p of alloc.prov) H = Math.max(H, p.rate || 0);

  const bonificoM = new Array(H).fill(0);
  bonificoM[0] += alloc.A;

  const provM = {};
  let costiExtra = 0;
  let importoBNPL = 0;
  for (const p of alloc.prov) {
    const { arr, costoExtra } = buildProviderMonthly(p.amount, p.rate, H, p._profile);
    provM[p.id] = arr;
    costiExtra += costoExtra;
    importoBNPL += p.amount;
  }

  // Bonifico rateizzato (credito azienda): water-filling sui mesi SUCCESSIVI a
  // oggi, riempiendo prima i più scarichi → appiattisce la rata del cliente.
  const B = alloc.B;
  if (B > 1e-9) {
    const start = H > 1 ? 1 : 0;
    const idx = [];
    for (let m = start; m < H; m++) idx.push(m);
    const base = idx.map((m) => {
      let v = bonificoM[m];
      for (const p of alloc.prov) v += provM[p.id][m];
      return v;
    });
    let lo = Math.min(...base), hi = Math.max(...base) + B;
    for (let it = 0; it < 28; it++) {
      const mid = (lo + hi) / 2;
      let cap = 0;
      for (let j = 0; j < base.length; j++) cap += Math.max(0, mid - base[j]);
      if (cap < B) lo = mid; else hi = mid;
    }
    const L = lo;
    let used = 0;
    for (let j = 0; j < idx.length; j++) {
      const add = Math.max(0, L - base[j]);
      bonificoM[idx[j]] += add;
      used += add;
    }
    const left = B - used;
    if (Math.abs(left) > 1e-9) for (const m of idx) bonificoM[m] += left / idx.length;
  }

  const totalM = new Array(H).fill(0);
  for (let m = 0; m < H; m++) {
    let v = bonificoM[m];
    for (const p of alloc.prov) v += provM[p.id][m];
    totalM[m] = v;
  }
  const nonZero = totalM.filter((v) => v > 1e-6);

  const incassatoOggi = alloc.A + importoBNPL; // finanziato anticipato (BNPL) + acconto
  const venduto = alloc.A + importoBNPL + B;    // = prezzo (coerenza sulla vendita)

  const metrics = {
    incassatoOggi: round2(incassatoOggi),
    pagatoOggi: round2(totalM[0]),
    venduto: round2(venduto),
    peak: round2(Math.max(...totalM)),
    nRateEffettive: nonZero.length,
    nRateBonifico: bonificoM.filter((v) => v > 1e-6).length,
    nRateCredito: bonificoM.slice(1).filter((v) => v > 1e-6).length,
    uniformitaStd: stdev(nonZero),
    uniformitaMean: mean(nonZero),
    pctLiquidita: venduto > 0 ? (incassatoOggi / venduto) * 100 : 0,
    importoBNPL,
    bonificoCredito: B,
    bonificoIniziale: alloc.A,
    costiExtra: round2(costiExtra),
    totalePagatoCliente: round2(venduto + costiExtra),
  };

  return { bonificoM, provM, totalM, metrics, alloc };
}

// ---- Vincoli rigidi -------------------------------------------------------
function isHardValid(sol, input, cfg) {
  const m = sol.metrics;
  const tol = 1 + cfg.tolleranza / 100;
  if (Math.abs(m.venduto - input.prezzo) > 0.5) return false;
  if (input.dispOggi > 0 && m.pagatoOggi > input.dispOggi * tol + 1e-6) return false;
  if (input.maxMensile > 0 && m.peak > input.maxMensile * tol + 1e-6) return false;
  for (const p of sol.alloc.prov) {
    if (p.amount <= 0) continue;
    if (p.amount > p._profile.maxImporto + 1e-6) return false;
    if (p.amount < (p._profile.minImporto || 0) - 1e-6) return false;
  }
  return true;
}

// ---- Sotto-punteggi (0..100) ----------------------------------------------
function subScores(sol, input, cfg, refs) {
  const m = sol.metrics;
  const uniformity =
    m.uniformitaMean > 0 ? 100 * (1 - clamp(m.uniformitaStd / m.uniformitaMean, 0, 1)) : 100;
  const liquidita = clamp(m.pctLiquidita, 0, 100);
  const strumenti = input.prezzo > 0 ? clamp((100 * m.importoBNPL) / input.prezzo, 0, 100) : 0;
  const minBonifico = input.prezzo > 0 ? clamp(100 * (1 - m.bonificoIniziale / input.prezzo), 0, 100) : 100;

  let comfort = 100;
  if (input.maxMensile > 0) comfort = Math.min(comfort, 100 * (1 - clamp(m.peak / input.maxMensile, 0, 1)));
  if (input.dispOggi > 0) comfort = Math.min(comfort, 100 * (1 - clamp(m.pagatoOggi / input.dispOggi, 0, 1)));
  comfort = clamp(comfort, 0, 100);

  // VPL: normalizzato min-max sul set dei candidati e "clampato" a [0,100] per
  // garantire l'invariante di scala anche in configurazioni limite (set degenere,
  // coefficienti VPL personalizzati). NB (V1, intenzionale): il VPL è una metrica
  // COMPOSITA (calcVPL combina venduto, incasso, % liquidità, BNPL, credito):
  // alcune di queste grandezze compaiono anche come sotto-punteggi atomici
  // (liquidita, strumenti, bonifico). La sovrapposizione è voluta — il VPL è
  // l'indicatore commerciale di sintesi — e non viene deduplicata in V1.
  let vpl = 50;
  if (refs.vplMax > refs.vplMin) vpl = clamp((100 * (m.vplRaw - refs.vplMin)) / (refs.vplMax - refs.vplMin), 0, 100);

  // Quota di bonifico (acconto + credito) sul prezzo: base della commissione
  // del consulente. Più bonifico = più "incassato" per il consulente.
  const bonifico = input.prezzo > 0 ? clamp((100 * (m.bonificoIniziale + m.bonificoCredito)) / input.prezzo, 0, 100) : 0;

  return { uniformity, liquidita, strumenti, minBonifico, comfort, vpl, bonifico };
}

// ---- Pesi per priorità (configurabili da Admin) ---------------------------
// NB: 'vpl' e 'liquidita' rivisti (vedi rinomina UI: "Massimizza VPL" e
// "Massimizza Incassato"). Le altre tre priorità restano INVARIATE.
const DEFAULT_WEIGHTS = {
  // "Massimizza VPL": massimo incasso immediato dell'azienda (BNPL anticipa),
  // riduce il credito bonifico, valorizza la VPL. Scalapay-first via tie-break.
  vpl:          { liquidita: 0.42, vpl: 0.30, strumenti: 0.18, comfort: 0.06, uniformity: 0.04, minBonifico: 0.00, bonifico: 0.00 },
  // "Massimizza Incassato": privilegia il bonifico (commissione consulente)
  // cercando il miglior compromesso con sostenibilità (comfort/uniformità).
  liquidita:    { bonifico: 0.45, comfort: 0.22, uniformity: 0.18, vpl: 0.08, liquidita: 0.05, strumenti: 0.02, minBonifico: 0.00 },
  rata:         { uniformity: 0.50, comfort: 0.25, liquidita: 0.12, vpl: 0.08, strumenti: 0.03, minBonifico: 0.02, bonifico: 0.00 },
  minbonifico:  { minBonifico: 0.45, liquidita: 0.22, strumenti: 0.15, uniformity: 0.10, vpl: 0.05, comfort: 0.03, bonifico: 0.00 },
  equilibrata:  { uniformity: 0.20, liquidita: 0.20, vpl: 0.20, comfort: 0.20, strumenti: 0.12, minBonifico: 0.08, bonifico: 0.00 },
};

function totalScore(ss, priorita, weights) {
  const w = weights[priorita] || weights.equilibrata;
  return (
    (w.vpl || 0) * ss.vpl + (w.liquidita || 0) * ss.liquidita + (w.uniformity || 0) * ss.uniformity +
    (w.comfort || 0) * ss.comfort + (w.strumenti || 0) * ss.strumenti + (w.minBonifico || 0) * ss.minBonifico +
    (w.bonifico || 0) * ss.bonifico
  );
}

/* ============================================================================
   RICERCA — indipendente dallo SCORING
   Enumera le combinazioni ammissibili (fattibilità via isHardValid) e le
   accumula come candidati con le loro `metrics`. Non calcola punteggi: la
   valutazione è delegata al modulo SCORING (rankCandidates).
   ========================================================================== */
// ---- Ottimizzatore: ricerca a DUE FASI su N provider generici -------------
// locks: { A, providers: { <id>: { amount, rate } } } — Manuale Assistita.
function optimize(input, cfg, locks = {}) {
  const P = input.prezzo, H = input.nRate;
  const lp = locks.providers || {};
  const active = cfg.providers.filter((p) => p.attivo);

  const provMeta = active.map((p) => {
    const lk = lp[p.id] || {};
    const rate = lk.rate != null ? lk.rate : Math.min(p.maxRate, H);
    return { id: p.id, profile: p, rate, lock: lk, minI: p.minImporto || 0, maxI: Math.min(p.maxImporto, P) };
  });

  const targetPts = provMeta.length >= 3 ? 26 : 50;
  const coarse = Math.max(cfg.searchStep, Math.ceil(P / targetPts / cfg.searchStep) * cfg.searchStep);
  const fine = cfg.searchStep;
  // Il contesto di RICERCA conosce solo la fattibilità: accumula candidati.
  const ctx = { P, H, provMeta, candidates: [] };

  // Fase 1 — coarse
  scanGrid(ctx, input, cfg, {
    aVals: locks.A != null ? [locks.A] : range(0, P, coarse),
    provVals: provMeta.map((pm) => (pm.lock.amount != null ? [pm.lock.amount] : amtRange(0, pm.maxI, coarse, pm.minI))),
  });

  // Fase 2 — refine attorno al miglior coarse (lo scoring è esterno)
  const cb = rankCandidates(ctx.candidates, input, cfg);
  if (cb) {
    const win = coarse;
    scanGrid(ctx, input, cfg, {
      aVals: locks.A != null ? [locks.A] : range(Math.max(0, cb.alloc.A - win), Math.min(P, cb.alloc.A + win), fine),
      provVals: provMeta.map((pm, i) => {
        if (pm.lock.amount != null) return [pm.lock.amount];
        const amt = cb.alloc.prov[i].amount;
        return amtRange(Math.max(0, amt - win), Math.min(pm.maxI, amt + win), fine, pm.minI);
      }),
    });
  }

  return rankCandidates(ctx.candidates, input, cfg);
}

function scanGrid(ctx, input, cfg, g) {
  const tol = 1 + cfg.tolleranza / 100;
  for (const A of g.aVals) {
    if (input.dispOggi > 0 && A > input.dispOggi * tol + 1e-6) continue;
    recurseProv(ctx, input, cfg, g, A, 0, ctx.P - A, []);
  }
}

function recurseProv(ctx, input, cfg, g, A, idx, remaining, chosen) {
  const { provMeta, P } = ctx;
  if (idx === provMeta.length) {
    const sum = chosen.reduce((s, c) => s + c, 0);
    const B = round2(P - A - sum);
    if (B < -1e-6) return;
    const prov = chosen.map((amt, i) => ({
      id: provMeta[i].id, amount: amt, rate: amt > 0 ? provMeta[i].rate : 0, _profile: provMeta[i].profile,
    }));
    const sol = buildSchedule({ A, B: Math.max(0, B), prov }, input, cfg);
    if (!isHardValid(sol, input, cfg)) return; // fattibilità (ricerca), non scoring
    ctx.candidates.push(sol);
    return;
  }
  const pm = provMeta[idx];
  for (const amt of g.provVals[idx]) {
    if (amt > remaining + 1e-6) break; // vals ordinati crescenti
    recurseProv(ctx, input, cfg, g, A, idx + 1, remaining, [...chosen, amt]);
  }
}

/* ============================================================================
   SCORING — indipendente dalla RICERCA
   Unico punto che conosce VPL, pesi e sotto-punteggi. Per cambiare interamente
   il sistema di punteggio (VPL, liquidità, comfort, commissioni, nuove regole)
   si modifica SOLO questa sezione: l'algoritmo di ricerca non va toccato.
   Contratto: riceve candidati con `metrics` (prodotti da buildSchedule) e
   restituisce il migliore con `.score` e `.sub`.
   ========================================================================== */
function rankCandidates(candidates, input, cfg) {
  if (!candidates.length) return null;

  // Normalizzazione VPL sull'insieme dei candidati (concern di scoring)
  let vplMin = Infinity, vplMax = -Infinity;
  for (const sol of candidates) {
    sol.metrics.vplRaw = calcVPL(sol.metrics, cfg.vpl);
    if (sol.metrics.vplRaw < vplMin) vplMin = sol.metrics.vplRaw;
    if (sol.metrics.vplRaw > vplMax) vplMax = sol.metrics.vplRaw;
  }
  const refs = { vplMin, vplMax };
  const weights = cfg.weights || DEFAULT_WEIGHTS;
  // Ordine di preferenza provider (politica commerciale): provider attivi
  // nell'ordine configurato in Admin. Usato SOLO come tie-break.
  const order = (cfg.providers || []).filter((p) => p.attivo).map((p) => p.id);

  // Passata 1: miglior candidato per punteggio (a parità, uniformità maggiore).
  // È la STESSA logica di selezione precedente: determina il PIANO ottimo, che
  // resta quindi invariato. Se Klarna consente un punteggio più alto o l'unico
  // piano ammissibile, viene scelto qui.
  let best = null;
  for (const sol of candidates) {
    sol._ss = subScores(sol, input, cfg, { ...refs, vplRaw: sol.metrics.vplRaw });
    sol._sc = totalScore(sol._ss, input.priorita, weights);
    if (!best || sol._sc > best._sc + 1e-9 ||
        (Math.abs(sol._sc - best._sc) < 1e-9 && sol._ss.uniformity > best._ss.uniformity)) best = sol;
  }
  // Passata 2: PREFERENZA PROVIDER come tie-break, applicata SOLO tra soluzioni
  // realmente equivalenti — stesso punteggio E stesso piano mensile. Tra queste
  // sceglie chi usa di più il provider preferito (Scalapay per default). Non
  // altera mai il piano: cambia solo l'attribuzione tra provider.
  for (const sol of candidates) {
    if (sol === best) continue;
    if (Math.abs(sol._sc - best._sc) < 1e-9 && sameSchedule(sol.totalM, best.totalM) &&
        providerPrefCompare(sol, best, order) > 0) best = sol;
  }
  best.score = clamp(Math.round(best._sc), 0, 100);
  best.sub = best._ss;
  best.candidateCount = candidates.length;
  return best;
}

function sameSchedule(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-4) return false;
  return true;
}
// Confronto lessicografico sugli importi provider secondo l'ordine di preferenza:
// più importo nel provider più preferito = soluzione migliore.
function providerPrefCompare(a, b, order) {
  for (const id of order) {
    const d = amountOf(a, id) - amountOf(b, id);
    if (Math.abs(d) > 1e-6) return d;
  }
  return 0;
}
function amountOf(sol, id) {
  const p = sol.alloc.prov.find((x) => x.id === id);
  return p ? p.amount : 0;
}

// ---- Smart Rounding -------------------------------------------------------
function smartRound(best, input, cfg) {
  if (!cfg.smartRoundingOn) return best;
  const R = cfg.smartRoundingMultiplo;
  const a = best.alloc;
  let ra = roundTo(a.A, R, input.prezzo);
  const prov = a.prov.map((p) => ({
    id: p.id, _profile: p._profile, rate: p.rate,
    amount: p.amount > 0 ? roundTo(p.amount, R, p._profile.maxImporto) : 0,
  }));
  prov.forEach((p) => { if (p.amount <= 0) p.rate = 0; });
  let rb = round2(input.prezzo - ra - prov.reduce((s, p) => s + p.amount, 0));
  if (rb < 0) { ra = round2(ra + rb); rb = 0; }
  if (ra < 0) return best;

  const sol = buildSchedule({ A: ra, B: rb, prov }, input, cfg);
  if (!isHardValid(sol, input, cfg)) return best;
  const drift = Math.abs(sol.metrics.pagatoOggi - best.metrics.pagatoOggi);
  if (drift > cfg.smartRoundingTolleranza) return best;

  sol.metrics.vplRaw = calcVPL(sol.metrics, cfg.vpl);
  sol.score = best.score; sol.sub = best.sub; sol.candidateCount = best.candidateCount;
  sol.rounded = true;
  return sol;
}

/* ---- Commercial Rounding (rate del bonifico) -------------------------------
   Post-elaborazione sulla soluzione finale: arrotonda le RATE DI CREDITO del
   bonifico (mesi successivi a oggi) a cifre semplici da comunicare, mantenendo
   INVARIATO il totale del bonifico. La differenza è compensata su una sola rata
   (ultima o prima, configurabile). Non tocca l'acconto né gli altri strumenti.
   È indipendente da ricerca e scoring: agisce solo sulla presentazione.        */
function commercialMultiplo(cfg) {
  const cr = cfg.commercialRounding || {};
  switch (cr.modo) {
    case 'euro': return 1;
    case '5': return 5;
    case '10': return 10;
    case '50': return 50;
    case 'personalizzato': return Math.max(0, cr.personalizzato || 0);
    default: return 0; // 'nessuno'
  }
}
function applyCommercialRounding(sol, cfg) {
  if (!sol) return sol;
  const mult = commercialMultiplo(cfg);
  if (mult <= 0) return sol; // nessun arrotondamento
  const strategia = (cfg.commercialRounding && cfg.commercialRounding.strategia) || 'ultima';

  // Rate di credito SIGNIFICATIVE (esclude la "polvere" numerica del water-fill)
  const idx = [];
  for (let m = 1; m < sol.bonificoM.length; m++) if (sol.bonificoM[m] > 0.005) idx.push(m);
  if (idx.length === 0) return sol;

  const total = round2(sol.alloc.B);                          // credito da preservare
  const compPos = strategia === 'prima' ? 0 : idx.length - 1; // rata che assorbe

  const rounded = idx.map((m) => Math.round(sol.bonificoM[m] / mult) * mult);
  let sumOthers = 0;
  for (let i = 0; i < rounded.length; i++) if (i !== compPos) sumOthers += rounded[i];
  const comp = round2(total - sumOthers);
  if (comp < 0) return sol; // arrotondamento incoerente → mantieni i valori esatti
  rounded[compPos] = comp;

  // azzera la polvere sui mesi credito non significativi, poi applica le rate
  for (let m = 1; m < sol.bonificoM.length; m++) if (sol.bonificoM[m] <= 0.005) sol.bonificoM[m] = 0;
  for (let i = 0; i < idx.length; i++) sol.bonificoM[idx[i]] = rounded[i];
  recomputeSchedule(sol);
  sol.commercialRounded = true;
  return sol;
}
// Ricalcola piano mensile e metriche dipendenti dopo un ritocco del bonifico.
function recomputeSchedule(sol) {
  const H = sol.bonificoM.length;
  for (let m = 0; m < H; m++) {
    let v = sol.bonificoM[m];
    for (const p of sol.alloc.prov) v += sol.provM[p.id][m];
    sol.totalM[m] = round2(v);
  }
  const nonZero = sol.totalM.filter((v) => v > 1e-6);
  sol.metrics.peak = round2(Math.max(...sol.totalM));
  sol.metrics.pagatoOggi = round2(sol.totalM[0]);
  sol.metrics.nRateBonifico = sol.bonificoM.filter((v) => v > 1e-6).length;
  sol.metrics.nRateCredito = sol.bonificoM.slice(1).filter((v) => v > 1e-6).length;
  sol.metrics.nRateEffettive = nonZero.length;
  sol.metrics.uniformitaStd = stdev(nonZero);
  sol.metrics.uniformitaMean = mean(nonZero);
}

// ---- helper ---------------------------------------------------------------
function range(from, to, step) {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(round2(v));
  return out;
}
// Valori ammessi per un provider: 0 (non usato) oppure da minI a maxI col passo.
function amtRange(from, to, step, minI) {
  const out = [];
  if (from <= 1e-9) out.push(0);
  let startPos = Math.max(from, minI > 0 ? minI : step);
  startPos = Math.ceil(startPos / step) * step;
  for (let v = startPos; v <= to + 1e-9; v += step) if (v >= (minI || 0) - 1e-9) out.push(round2(v));
  return out;
}
function roundTo(v, mult, cap) {
  let r = Math.round(v / mult) * mult;
  if (cap != null && r > cap) r = Math.floor(cap / mult) * mult;
  return Math.max(0, r);
}

/* ============================================================================
   INTESA — Configurazione di default + persistenza (localStorage)
   ========================================================================== */
function extraDefault() {
  return { modalita: 'redistribuisci', tipo: 'importo', valore: 0, gestione: 'redistribuisci' };
}
const DEFAULT_CONFIG = {
  tolleranza: 5,            // % di tolleranza sui vincoli (disponibilità / max rata)
  searchStep: 50,           // granularità della ricerca (€)
  smartRoundingOn: true,
  smartRoundingMultiplo: 50,    // 50 / 100 / 250
  smartRoundingTolleranza: 100, // scostamento € max accettato per arrotondare
  // Commercial Rounding: arrotonda le RATE DEL BONIFICO a cifre "dicibili" al
  // cliente, mantenendo invariato il totale del bonifico. Logica separata dallo
  // Smart Rounding (che agisce sui TOTALI degli strumenti).
  commercialRounding: {
    modo: 'euro',            // 'nessuno' | 'euro' | '5' | '10' | '50' | 'personalizzato'
    personalizzato: 25,      // usato solo se modo === 'personalizzato'
    strategia: 'ultima',     // dove va la differenza: 'ultima' | 'prima' rata
  },
  // VPL = Valore per Lead: formula lineare configurabile (nessuna formula finanziaria)
  vpl: { base: 0, cPrezzo: 0.3, cIncasso: 0.7, cLiquidita: 2, cBNPL: 0.2, cCredito: -0.5 },
  // Profili Provider: il motore legge SEMPRE queste regole, non conosce i nomi.
  providers: [
    { id: 'scalapay', nome: 'Scalapay', attivo: true, colore: 'scalapay',
      maxRate: 4, minImporto: 0, maxImporto: 2000, commissione: 0, extra: extraDefault() },
    { id: 'klarna', nome: 'Klarna', attivo: true, colore: 'klarna',
      maxRate: 3, minImporto: 0, maxImporto: 1500, commissione: 0, extra: extraDefault() },
    { id: 'custom', nome: 'Provider personalizzato', attivo: false, colore: 'custom',
      maxRate: 3, minImporto: 0, maxImporto: 1500, commissione: 0, extra: extraDefault() },
  ],
  weights: DEFAULT_WEIGHTS,
  // Metadati della configurazione — predisposizione per il Salvataggio Trattative.
  // Il MOTORE li ignora: servono solo a identificare/versionare il set di regole.
  meta: { version: '1.0.0', id: null, createdAt: null },
};

const CFG_KEY = 'intesa.config.v2';

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    return mergeConfig(structuredClone(DEFAULT_CONFIG), JSON.parse(raw));
  } catch (e) { return structuredClone(DEFAULT_CONFIG); }
}
function mergeConfig(base, over) {
  for (const k in over) {
    if (Array.isArray(over[k])) base[k] = over[k];
    else if (over[k] && typeof over[k] === 'object') base[k] = mergeConfig(base[k] || {}, over[k]);
    else base[k] = over[k];
  }
  return base;
}
function saveConfig() { stampConfigMeta(CONFIG); try { localStorage.setItem(CFG_KEY, JSON.stringify(CONFIG)); } catch (e) {} }

// Impronta stabile delle SOLE regole (esclusi i metadati) → identificativo config.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
function configFingerprint(cfg) {
  const clone = { ...cfg }; delete clone.meta; // le regole, non i metadati
  return cyrb53(JSON.stringify(clone));
}
// Aggiorna id/createdAt quando le regole cambiano (una "nuova versione" nasce).
function stampConfigMeta(cfg) {
  if (!cfg.meta) cfg.meta = { version: '1.0.0', id: null, createdAt: null };
  const fp = configFingerprint(cfg);
  if (cfg.meta.id !== fp) { cfg.meta.id = fp; cfg.meta.createdAt = new Date().toISOString(); }
  return cfg.meta;
}

let CONFIG = loadConfig();

/* ============================================================================
   STATO + UTILITÀ DOM
   ========================================================================== */
const PRIORITA = [
  { key: 'vpl',         label: 'Massimizza VPL',       sub: 'Incasso immediato azienda',      desc: "Privilegia l'incasso immediato dell'azienda." },
  { key: 'liquidita',   label: 'Massimizza Incassato', sub: 'Commissione consulente',         desc: 'Privilegia il bonifico per aumentare la commissione del consulente.' },
  { key: 'equilibrata', label: 'Equilibrata',          sub: 'Bilanciata',                     desc: 'Bilancia incasso, sostenibilità e VPL.' },
  { key: 'rata',        label: 'Rata costante',        sub: 'Mensilità uniformi',             desc: 'Rende le rate mensili il più uniformi possibile.' },
  { key: 'minbonifico', label: 'Min. bonifico',        sub: 'Acconto minimo',                 desc: 'Riduce al minimo l\'acconto in bonifico oggi.' },
];
const PREZZI = [2000, 3000, 4000, 5000, 6000];
const RATE = [2, 3, 4, 5, 6, 8, 10, 12];

const state = {
  input: { prezzo: 3000, nRate: 6, dispOggi: 0, maxMensile: 0, priorita: 'vpl' },
  locks: {},        // chiavi piatte: 'A', 'amt_<id>', 'rate_<id>' — Manuale Assistita
  manual: false,
  sol: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

const euro0 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const euro2 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (n) => (Math.abs(n - Math.round(n)) < 0.005 ? euro0.format(Math.round(n)) : euro2.format(n));
const parseNum = (s) => { const n = parseFloat(String(s).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const activeProviders = () => CONFIG.providers.filter((p) => p.attivo);
const colorVar = (p) => `var(--${p.colore || 'custom'})`;

/* ============================================================================
   COSTRUZIONE INPUT (chips, pills)
   ========================================================================== */
function buildInputs() {
  $('#prezzo').value = state.input.prezzo ? String(state.input.prezzo) : '';
  $('#dispOggi').value = state.input.dispOggi ? String(state.input.dispOggi) : '';
  $('#maxMensile').value = state.input.maxMensile ? String(state.input.maxMensile) : '';

  const cp = $('#chipsPrezzo'); cp.innerHTML = '';
  PREZZI.forEach((p) => {
    const b = el('button', 'chip', '€' + p.toLocaleString('it-IT')); b.type = 'button';
    b.onclick = () => { $('#prezzo').value = String(p); onInput(); };
    cp.appendChild(b);
  });
  const cr = $('#chipsRate'); cr.innerHTML = '';
  RATE.forEach((r) => {
    const b = el('button', 'chip', String(r)); b.type = 'button'; b.dataset.rate = r;
    b.onclick = () => { state.input.nRate = r; syncRateChips(); compute(); };
    cr.appendChild(b);
  });
  syncRateChips();
  const pp = $('#pillsPriorita'); pp.innerHTML = '';
  PRIORITA.forEach((p) => {
    const b = el('button', 'pill', `${p.label}<small>${p.sub}</small>`); b.type = 'button'; b.dataset.key = p.key;
    if (p.desc) b.title = p.desc;
    b.onclick = () => { state.input.priorita = p.key; syncPills(); compute(); };
    pp.appendChild(b);
  });
  syncPills();
}
function syncRateChips() { document.querySelectorAll('#chipsRate .chip').forEach((c) => c.classList.toggle('is-active', Number(c.dataset.rate) === state.input.nRate)); }
function syncPills() { document.querySelectorAll('#pillsPriorita .pill').forEach((c) => c.classList.toggle('is-active', c.dataset.key === state.input.priorita)); }

/* ============================================================================
   LETTURA INPUT + RICALCOLO (debounce)
   ========================================================================== */
function readInputs() {
  state.input.prezzo = parseNum($('#prezzo').value);
  state.input.dispOggi = parseNum($('#dispOggi').value);
  state.input.maxMensile = parseNum($('#maxMensile').value);
}
let debounceT = null;
function onInput() { clearTimeout(debounceT); debounceT = setTimeout(compute, 110); }

// Converte i lucchetti piatti nella struttura attesa dal motore.
function buildLocks() {
  const L = { providers: {} };
  if (state.locks.A != null) L.A = state.locks.A;
  for (const p of activeProviders()) {
    const amt = state.locks['amt_' + p.id], rate = state.locks['rate_' + p.id];
    if (amt != null || rate != null) {
      L.providers[p.id] = {};
      if (amt != null) L.providers[p.id].amount = amt;
      if (rate != null) L.providers[p.id].rate = rate;
    }
  }
  return L;
}

function compute() {
  readInputs();
  const inp = state.input;
  if (!inp.prezzo || inp.prezzo <= 0) { $('#result').innerHTML = ''; $('#actions').hidden = true; notifyResult(null); return; }
  const focus = captureFocus();
  const mode = state.manual ? 'manual' : 'auto';
  if (state.manual) {
    let sol = optimize(inp, CONFIG, buildLocks());
    if (sol) sol = applyCommercialRounding(sol, CONFIG);
    state.sol = sol; renderResult(sol, 'manual');
  } else {
    let best = optimize(inp, CONFIG);
    if (best) best = smartRound(best, inp, CONFIG);
    if (best) best = applyCommercialRounding(best, CONFIG);
    state.sol = best; renderResult(best, 'auto');
  }
  restoreFocus(focus);
  notifyResult(state.sol, mode);
}
// Hook osservatori: predisposizione per future UI (es. Live Call) che vogliono
// reagire al ricalcolo. Inerte in V1 (nessun subscriber registrato).
const resultSubscribers = [];
function notifyResult(sol, mode) {
  for (const cb of resultSubscribers) { try { cb(sol, mode); } catch (e) {} }
}
function captureFocus() {
  const a = document.activeElement;
  if (a && a.dataset && a.dataset.field && $('#result').contains(a)) return { field: a.dataset.field, pos: a.selectionStart };
  return null;
}
function restoreFocus(f) {
  if (!f) return;
  const n = document.querySelector(`#result [data-field="${f.field}"]`);
  if (n) { n.focus(); try { n.setSelectionRange(f.pos, f.pos); } catch (e) {} }
}

/* ============================================================================
   COMPATIBILITÀ E OTTIMIZZABILITÀ — due assi distinti
   - Il PUNTEGGIO (gauge) esprime SOLO la qualità della soluzione (0-100).
   - La COMPATIBILITÀ (badge) esprime il rispetto dei vincoli del cliente:
     Compatibile / Al limite / Non compatibile, con il motivo quando serve.
   - L'OTTIMIZZABILITÀ (nota separata, solo in manuale) segnala se esiste una
     proposta con punteggio più alto. Non viene mai fusa con la compatibilità.
   ========================================================================== */
function getCompatibility(sol) {
  if (!sol) return { level: 'bad', label: 'Non compatibile', reason: '' };
  const inp = state.input, m = sol.metrics;
  const overMax = inp.maxMensile > 0 && m.peak > inp.maxMensile + 0.5;
  const overDisp = inp.dispOggi > 0 && m.pagatoOggi > inp.dispOggi + 0.5;
  if (!overMax && !overDisp) return { level: 'ok', label: 'Compatibile', reason: '' };
  const r = [];
  if (overMax) r.push(`picco rata ${eur(m.peak)} oltre il max ${eur(inp.maxMensile)}`);
  if (overDisp) r.push(`pagato oggi ${eur(m.pagatoOggi)} oltre la disponibilità ${eur(inp.dispOggi)}`);
  return { level: 'warn', label: 'Al limite', reason: r.join(' · ') };
}
// Solo in manuale: esiste una proposta automatica con punteggio più alto?
function getOptimizable(sol) {
  if (!sol) return null;
  const opt = optimize(state.input, CONFIG);
  if (opt && opt.score > sol.score + 4) return `Ottimizzabile: in automatico si raggiunge ${opt.score}/100.`;
  return null;
}

/* ============================================================================
   RENDERING
   ========================================================================== */
function renderResult(sol, mode) {
  const root = $('#result'); root.innerHTML = '';
  if (!sol) { root.appendChild(renderNoSolution(mode)); $('#actions').hidden = true; return; }
  $('#actions').hidden = false;
  root.appendChild(renderVerdict(sol, mode));
  root.appendChild(renderKpis(sol));
  if (sol.metrics.costiExtra > 0.005) root.appendChild(el('div', 'rounded-note',
    `+ costo extra a carico cliente <span class="num">${eur(sol.metrics.costiExtra)}</span> · totale pagato <span class="num">${eur(sol.metrics.totalePagatoCliente)}</span>`));
  root.appendChild(el('div', 'section-title', 'Strumenti'));
  root.appendChild(renderInstruments(sol, mode));
  if (sol.rounded) root.appendChild(el('div', 'rounded-note', '✓ Importi arrotondati per la trattativa (Smart Rounding)'));
  root.appendChild(el('div', 'section-title', 'Piano mensile'));
  root.appendChild(renderPlan(sol));
}

function renderVerdict(sol, mode) {
  const wrap = el('div', 'verdict');
  // Il gauge rappresenta ESCLUSIVAMENTE la qualità (punteggio 0-100): usa
  // l'accento del brand, indipendente dalla compatibilità coi vincoli.
  const C = 'var(--emerald)';
  const score = clamp(sol.score || 0, 0, 100), circ = 2 * Math.PI * 40, off = circ * (1 - score / 100);
  const gauge = el('div', 'gauge');
  gauge.innerHTML = `
    <svg width="92" height="92" viewBox="0 0 92 92">
      <circle cx="46" cy="46" r="40" fill="none" stroke="var(--hairline)" stroke-width="8"/>
      <circle class="gauge-arc" cx="46" cy="46" r="40" fill="none" stroke="${C}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" style="transition:stroke-dashoffset .5s ease"/>
    </svg>
    <div class="gauge-num"><span class="gauge-score" style="color:${C}">${score}</span><span class="gauge-max">/ 100</span></div>
    <div class="gauge-cap">Qualità</div>`;
  const main = el('div', 'verdict-main');

  // Badge COMPATIBILITÀ (asse distinto dai punti qualità)
  const comp = getCompatibility(sol);
  const badgeCls = comp.level === 'ok' ? 'badge--ok' : comp.level === 'warn' ? 'badge--warn' : 'badge--bad';
  main.appendChild(el('span', 'badge ' + badgeCls, `<span class="dot"></span>${comp.label}`));
  if (comp.reason) main.appendChild(el('div', 'verdict-reason', comp.reason));

  // Nota OTTIMIZZABILE (solo manuale), separata dalla compatibilità
  if (mode === 'manual') {
    const opt = getOptimizable(sol);
    if (opt) main.appendChild(el('div', 'verdict-opt', opt));
  }

  main.appendChild(el('div', 'verdict-text', explain(sol)));
  wrap.appendChild(gauge); wrap.appendChild(main);
  return wrap;
}
function explain(sol) {
  const m = sol.metrics, p = state.input.priorita, liq = Math.round(m.pctLiquidita), bits = [];
  if (p === 'liquidita') bits.push(`incassi ${eur(m.incassatoOggi)} oggi (${liq}% del totale)`);
  else if (p === 'rata') bits.push(`mensilità uniformi attorno a ${eur(m.uniformitaMean)}`);
  else if (p === 'minbonifico') bits.push(m.bonificoIniziale > 0 ? `acconto contenuto a ${eur(m.bonificoIniziale)}` : 'nessun acconto richiesto');
  else if (p === 'vpl') bits.push(`massimo Valore per Lead, con ${liq}% incassato oggi`);
  else bits.push(`equilibrio tra incasso (${liq}%) e sostenibilità della rata`);
  if (state.input.maxMensile > 0) bits.push(`picco rata ${eur(m.peak)}`);
  return 'Ottimizzata per ' + bits.join(' · ') + '.';
}
function renderKpis(sol) {
  const m = sol.metrics, wrap = el('div', 'kpis');
  const k = (lbl, val, accent) => { const n = el('div', 'kpi' + (accent ? ' kpi--accent' : '')); n.appendChild(el('div', 'kpi-label', lbl)); n.appendChild(el('div', 'kpi-val', eur(val))); return n; };
  wrap.appendChild(k('Incassato oggi', m.incassatoOggi, true));
  wrap.appendChild(k('Pagato oggi', m.pagatoOggi));
  wrap.appendChild(k('Totale venduto', m.venduto));
  return wrap;
}

function renderInstruments(sol, mode) {
  const a = sol.alloc, m = sol.metrics, wrap = el('div', 'instruments');

  // --- BONIFICO (strumento aziendale, sempre presente) ---
  const bonificoTot = round2(a.A + a.B);
  const cb = el('div', 'inst' + (bonificoTot < 1 ? ' is-zero' : ''));
  cb.style.setProperty('--c', 'var(--bonifico)');
  cb.appendChild(instHead('Bonifico', bonificoTot));
  let bd = 'Non utilizzato';
  if (bonificoTot >= 1) {
    const parts = [];
    if (a.A >= 1) parts.push(`acconto oggi <span class="num">${eur(a.A)}</span>`);
    if (a.B >= 1) parts.push(`credito <span class="num">${eur(a.B)}</span> su <span class="num">${m.nRateCredito}</span> mesi`);
    bd = parts.join(' · ');
  }
  cb.appendChild(el('div', 'inst-detail', bd));
  if (a.B >= 1) {
    const rate = [];
    for (let m = 1; m < sol.bonificoM.length; m++) if (sol.bonificoM[m] > 0.005) rate.push(eur(sol.bonificoM[m]));
    if (rate.length) cb.appendChild(el('div', 'inst-rate-summary', 'Rate: ' + rate.join(' • ')));
  }
  if (mode === 'manual') { const row = el('div', 'inst-edit'); row.appendChild(miniField('A', a.A, '€', 'Acconto')); cb.appendChild(row); }
  wrap.appendChild(cb);

  // --- PROVIDER (dinamici) ---
  for (const p of a.prov) {
    const prof = p._profile;
    const card = el('div', 'inst' + (p.amount < 1 ? ' is-zero' : ''));
    card.style.setProperty('--c', colorVar(prof));
    card.appendChild(instHead(prof.nome, p.amount));
    card.appendChild(el('div', 'inst-detail', providerDetail(p, sol)));
    if (mode === 'manual') {
      const row = el('div', 'inst-edit');
      row.appendChild(miniField('amt_' + p.id, p.amount, '€', 'Importo'));
      row.appendChild(miniField('rate_' + p.id, p.rate || prof.maxRate, '', 'Rate', prof.maxRate));
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }
  return wrap;
}
function instHead(name, amt) {
  const h = el('div', 'inst-head');
  h.appendChild(el('div', 'inst-name', `<span class="seg"></span>${name}`));
  h.appendChild(el('div', 'inst-amt', eur(amt)));
  return h;
}
function providerDetail(p, sol) {
  if (p.amount < 1) return 'Non utilizzato';
  if (p.rate === 1) return 'pagamento unico';
  const base = p.amount / p.rate;
  const info = providerExtra(p._profile, p.amount);
  if (info.E > 0 && info.gestione === 'costo')
    return `<span class="num">${p.rate}</span> rate da <span class="num">${eur(base)}</span> · +<span class="num">${eur(info.E)}</span> extra sulla 1ª`;
  const arr = sol.provM[p.id], r1 = arr[0], rr = arr[1] || 0;
  if (Math.abs(r1 - rr) < 0.01) return `<span class="num">${p.rate}</span> rate da <span class="num">${eur(rr)}</span>`;
  return `<span class="num">${p.rate}</span> rate · prima <span class="num">${eur(r1)}</span>, poi <span class="num">${eur(rr)}</span>`;
}

/* --- Manuale Assistita: campi editabili + lucchetti --- */
function currentValue(field) {
  const a = state.sol ? state.sol.alloc : null;
  if (!a) return 0;
  if (field === 'A') return a.A;
  const kind = field.slice(0, field.indexOf('_'));
  const id = field.slice(field.indexOf('_') + 1);
  const p = a.prov.find((x) => x.id === id);
  if (!p) return 0;
  return kind === 'amt' ? p.amount : (p.rate || 1);
}
function miniField(field, value, prefix, label, maxRate) {
  const isRate = !!maxRate;
  const wrap = el('div'); wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '6px';
  const box = el('div', 'mini-input' + (isRate ? ' mini-input--rate' : ''));
  if (prefix) box.appendChild(el('span', 'euro', prefix));
  const inp = document.createElement('input');
  inp.inputMode = 'numeric'; inp.dataset.field = field;
  inp.value = isRate ? String(value) : String(Math.round(value));
  inp.oninput = () => {
    const val = isRate ? clamp(parseInt(inp.value) || 1, 1, maxRate) : parseNum(inp.value);
    state.locks[field] = val;     // modificare un campo lo blocca automaticamente
    onInput();
  };
  box.appendChild(inp);
  wrap.appendChild(el('span', 'mini-label', label));
  wrap.appendChild(box);
  wrap.appendChild(lockBtn(field));
  return wrap;
}
function lockBtn(field) {
  const locked = state.locks[field] != null;
  const b = el('button', 'lock' + (locked ? ' is-locked' : '')); b.type = 'button';
  b.title = locked ? 'Bloccato — clicca per liberare' : 'Clicca per bloccare';
  b.innerHTML = locked
    ? '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5m0 2a3 3 0 0 1 3 3v3H9V6a3 3 0 0 1 3-3"/></svg>'
    : '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2H9V6a3 3 0 0 1 5.9-.8 1 1 0 0 0 1.9-.6A5 5 0 0 0 12 1"/></svg>';
  b.onclick = () => {
    if (state.locks[field] != null) delete state.locks[field];
    else state.locks[field] = currentValue(field);
    compute();
  };
  return b;
}

/* --- Piano mensile (colonne dinamiche per provider) --- */
function renderPlan(sol) {
  const wrap = el('div', 'plan'), t = el('table', 'plan-table'), H = sol.totalM.length;
  const provs = sol.alloc.prov;
  let head = '<thead><tr><th>Mese</th><th>Bonifico</th>' + provs.map((p) => `<th>${p._profile.nome}</th>`).join('') + '<th>Totale</th></tr></thead>';
  let rows = '';
  for (let i = 0; i < H; i++) {
    const lbl = i === 0 ? `1 <small>(oggi)</small>` : (i + 1);
    let tds = `<td class="num" style="color:var(--bonifico)">${cell(sol.bonificoM[i])}</td>`;
    tds += provs.map((p) => `<td class="num" style="color:${colorVar(p._profile)}">${cell(sol.provM[p.id][i])}</td>`).join('');
    rows += `<tr><td class="month-lbl">${lbl}</td>${tds}<td class="num total-col">${eur(sol.totalM[i])}</td></tr>`;
  }
  let ftds = `<td class="num" style="color:var(--bonifico)">${cell(sum(sol.bonificoM))}</td>`;
  ftds += provs.map((p) => `<td class="num" style="color:${colorVar(p._profile)}">${cell(sum(sol.provM[p.id]))}</td>`).join('');
  const foot = `<tfoot class="plan-foot"><tr><td>Totale</td>${ftds}<td class="num total-col">${eur(sol.metrics.venduto)}</td></tr></tfoot>`;
  t.innerHTML = head + '<tbody>' + rows + '</tbody>' + foot;
  wrap.appendChild(t);
  return wrap;
}
const cell = (v) => (v > 0.005 ? eur(v) : '—');
const sum = (a) => round2(a.reduce((s, x) => s + x, 0));

/* --- Nessuna soluzione --- */
function renderNoSolution(mode) {
  const inp = state.input, box = el('div', 'nosol');
  box.appendChild(el('h3', null, 'Nessuna proposta compatibile'));
  const sugg = [];
  if (mode === 'manual') {
    let locked = 0; for (const k in state.locks) if (k === 'A' || k.startsWith('amt_')) locked += state.locks[k];
    if (locked > inp.prezzo + 0.5) box.appendChild(el('p', null, 'I valori bloccati superano il prezzo del pacchetto.'));
    else box.appendChild(el('p', null, 'Con i valori bloccati nessuna combinazione rispetta i vincoli configurati.'));
    sugg.push('Sblocca uno dei campi (icona lucchetto) per dare libertà al calcolo.');
  } else box.appendChild(el('p', null, 'Con i vincoli attuali il prezzo non è dilazionabile.'));
  if (inp.maxMensile > 0) {
    const minMesi = Math.ceil(inp.prezzo / (inp.maxMensile * (1 + CONFIG.tolleranza / 100)));
    if (minMesi > inp.nRate) sugg.push(`Aumenta le rate ad almeno <b>${minMesi}</b>, oppure alza la rata massima.`);
  }
  if (inp.dispOggi > 0) sugg.push('Aumenta la disponibilità di oggi, oppure riduci il prezzo.');
  if (!sugg.length) sugg.push('Aumenta il numero di rate o alza i tetti dei provider nel Pannello Amministratore.');
  const ul = el('ul'); sugg.forEach((s) => ul.appendChild(el('li', null, s))); box.appendChild(ul);
  return box;
}

/* ============================================================================
   AZIONI: copia proposta / nuova trattativa
   ========================================================================== */
function buildProposalText(sol) {
  const a = sol.alloc, m = sol.metrics, pl = PRIORITA.find((p) => p.key === state.input.priorita), L = [];
  L.push(`PROPOSTA DI PAGAMENTO — ${eur(m.venduto)}`);
  L.push(`${state.input.nRate} rate · priorità: ${pl ? pl.label : ''}`);
  L.push('');
  if (a.A + a.B >= 1) {
    let s = `• Bonifico ${eur(a.A + a.B)}`; const det = [];
    if (a.A >= 1) det.push(`acconto oggi ${eur(a.A)}`);
    if (a.B >= 1) det.push(`credito ${eur(a.B)} su ${m.nRateCredito} mesi`);
    if (det.length) s += ` (${det.join(', ')})`;
    L.push(s);
    if (a.B >= 1) {
      const rate = [];
      for (let i = 1; i < sol.bonificoM.length; i++) if (sol.bonificoM[i] > 0.005) rate.push(eur(sol.bonificoM[i]));
      if (rate.length) L.push(`  rate bonifico: ${rate.join(' • ')}`);
    }
  }
  for (const p of a.prov) {
    if (p.amount < 1) continue;
    let s = `• ${p._profile.nome} ${eur(p.amount)} in ${p.rate} rate`;
    const info = providerExtra(p._profile, p.amount);
    if (info.E > 0 && info.gestione === 'costo') s += ` (+${eur(info.E)} sulla 1ª)`;
    L.push(s);
  }
  L.push('');
  L.push(`Pagato oggi dal cliente: ${eur(m.pagatoOggi)}`);
  L.push(`Incassato oggi dall'azienda: ${eur(m.incassatoOggi)}`);
  if (m.costiExtra > 0.005) L.push(`Totale pagato dal cliente: ${eur(m.totalePagatoCliente)} (incl. ${eur(m.costiExtra)} di extra)`);
  L.push('');
  L.push('Piano mensile:');
  sol.totalM.forEach((v, i) => { if (v > 0.005) L.push(`  Mese ${i + 1}${i === 0 ? ' (oggi)' : ''}: ${eur(v)}`); });
  return L.join('\n');
}
async function copyProposal() {
  if (!state.sol) return;
  const txt = buildProposalText(state.sol);
  try { await navigator.clipboard.writeText(txt); toast('Proposta copiata negli appunti'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Proposta copiata'); } catch (_) { toast('Copia non riuscita'); }
    document.body.removeChild(ta);
  }
}
function newDeal() {
  state.input = { prezzo: 3000, nRate: 6, dispOggi: 0, maxMensile: 0, priorita: 'vpl' };
  state.locks = {};
  if (state.manual) toggleManual(false);
  buildInputs(); compute();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================================
   TOAST
   ========================================================================== */
let toastT = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('is-show'));
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove('is-show'); setTimeout(() => (t.hidden = true), 250); }, 2200);
}

/* ============================================================================
   MODALITÀ MANUALE ASSISTITA
   ========================================================================== */
function toggleManual(force) {
  state.manual = force != null ? force : !state.manual;
  if (!state.manual) state.locks = {};
  const btn = $('#btnManual');
  btn.setAttribute('aria-pressed', String(state.manual));
  btn.querySelector('.icon-btn-label').textContent = state.manual ? 'Manuale ON' : 'Manuale';
  compute();
}

/* ============================================================================
   PANNELLO AMMINISTRATORE
   ========================================================================== */
function buildAdmin() {
  const b = $('#adminBody'); b.innerHTML = '';

  b.appendChild(admGroup('Vincoli', 'Margine di tolleranza sui vincoli del cliente.', [
    admNum('Tolleranza vincoli', 'tolleranza', '%', 'scostamento ammesso su disponibilità e rata max'),
  ]));

  // --- PROFILI PROVIDER ---
  const gp = el('div', 'adm-group');
  gp.appendChild(el('h3', null, 'Profili Provider'));
  gp.appendChild(el('p', 'hint', "Il motore legge sempre queste regole: per aggiungere o cambiare un provider basta modificare un profilo, senza toccare l'algoritmo. L'ordine (↑/↓) è anche l'ordine di preferenza: a parità di punteggio il motore sceglie il provider più in alto."));
  CONFIG.providers.forEach((p, i) => gp.appendChild(admProvider(p, i)));
  b.appendChild(gp);

  b.appendChild(admGroup('Smart Rounding', 'Arrotonda gli importi a valori facili da comunicare.', [
    admSwitch('Attivo', 'smartRoundingOn'),
    admSelect('Multiplo', 'smartRoundingMultiplo', [['50', 50], ['100', 100], ['250', 250]]),
    admNum('Scostamento max', 'smartRoundingTolleranza', '€', 'oltre questo, mantiene gli importi esatti'),
  ]));
  b.appendChild(admCommercialRounding());
  b.appendChild(admGroup('Motore di calcolo', 'Granularità della ricerca.', [
    admNum('Passo di ricerca', 'searchStep', '€'),
  ]));
  b.appendChild(admGroup('VPL — Valore per Lead',
    'Metrica commerciale interna, NON finanziaria. È una somma pesata: ogni coefficiente decide quanto pesa una grandezza della proposta.',
    [
      admNumDeep('Base fissa', 'vpl', 'base', ''),
      admNumDeep('× Totale venduto', 'vpl', 'cPrezzo', ''),
      admNumDeep('× Incassato oggi', 'vpl', 'cIncasso', ''),
      admNumDeep('× % liquidità oggi', 'vpl', 'cLiquidita', ''),
      admNumDeep('× Importo BNPL', 'vpl', 'cBNPL', ''),
      admNumDeep('× Credito bonifico', 'vpl', 'cCredito', 'di norma negativo'),
    ]));
}

// Card di un profilo provider
function admProvider(p, i) {
  const card = el('div', 'adm-provider');
  card.style.setProperty('--c', colorVar(p));
  const head = el('div', 'adm-prov-head');
  const nameWrap = el('div', 'adm-prov-name');
  const dot = el('span', 'adm-prov-dot');
  nameWrap.appendChild(dot);
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.value = p.nome; nameInp.className = 'adm-prov-nome';
  nameInp.onchange = () => { p.nome = nameInp.value || p.id; saveConfig(); compute(); };
  nameWrap.appendChild(nameInp);
  head.appendChild(nameWrap);
  const ord = el('div', 'adm-prov-order');
  const up = el('button', 'adm-ord-btn', '↑'); up.type = 'button'; up.title = 'Più preferito (tie-break)'; up.disabled = i === 0;
  up.onclick = () => moveProvider(i, -1);
  const dn = el('button', 'adm-ord-btn', '↓'); dn.type = 'button'; dn.title = 'Meno preferito (tie-break)'; dn.disabled = i === CONFIG.providers.length - 1;
  dn.onclick = () => moveProvider(i, 1);
  ord.appendChild(up); ord.appendChild(dn);
  head.appendChild(ord);
  const sw = el('label', 'switch');
  const swi = document.createElement('input'); swi.type = 'checkbox'; swi.checked = !!p.attivo;
  swi.onchange = () => { p.attivo = swi.checked; saveConfig(); state.locks = {}; compute(); };
  sw.appendChild(swi); sw.appendChild(el('span', 'track'));
  head.appendChild(sw);
  card.appendChild(head);

  const body = el('div', 'adm-prov-body');
  body.appendChild(admProvNum(p, 'maxRate', 'Rate massime', ''));
  body.appendChild(admProvNum(p, 'minImporto', 'Importo minimo', '€'));
  body.appendChild(admProvNum(p, 'maxImporto', 'Importo massimo', '€'));
  body.appendChild(admProvNum(p, 'commissione', 'Commissione (futuro)', '%'));

  // Sotto-sezione: Gestione Extra Prima Rata
  const ex = p.extra;
  const exBox = el('div', 'adm-extra');
  exBox.appendChild(el('div', 'adm-extra-title', 'Gestione Extra Prima Rata'));
  exBox.appendChild(admExtraSelect(p, 'Modalità', 'modalita',
    [['Redistribuisci', 'redistribuisci'], ['Costo aggiuntivo', 'costo'], ['Manuale', 'manuale']]));
  exBox.appendChild(admExtraNum(p, 'Valore extra', 'valore'));
  exBox.appendChild(admExtraSelect(p, 'Tipo valore', 'tipo', [['Importo €', 'importo'], ['Percentuale %', 'percentuale']]));
  if (ex.modalita === 'manuale')
    exBox.appendChild(admExtraSelect(p, 'Gestione', 'gestione', [['Redistribuisci', 'redistribuisci'], ['Costo aggiuntivo', 'costo']]));
  body.appendChild(exBox);

  card.appendChild(body);
  return card;
}
function admProvNum(p, key, label, unit) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = p[key]; inp.step = 'any';
  inp.onchange = () => { p[key] = parseFloat(inp.value) || 0; saveConfig(); compute(); };
  const w = el('div'); w.style.display = 'flex'; w.style.alignItems = 'center'; w.style.gap = '6px';
  w.appendChild(inp); if (unit) w.appendChild(el('span', 'mini-label', unit)); row.appendChild(w);
  return row;
}
function admExtraNum(p, label, key) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = p.extra[key]; inp.step = 'any';
  inp.onchange = () => { p.extra[key] = parseFloat(inp.value) || 0; saveConfig(); compute(); };
  row.appendChild(inp);
  return row;
}
function admExtraSelect(p, label, key, opts) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const sel = document.createElement('select');
  opts.forEach(([t, v]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (p.extra[key] === v) o.selected = true; sel.appendChild(o); });
  sel.onchange = () => { p.extra[key] = sel.value; saveConfig(); refreshAdmin(); compute(); };
  row.appendChild(sel);
  return row;
}

function admGroup(title, hint, rows) {
  const g = el('div', 'adm-group'); g.appendChild(el('h3', null, title));
  if (hint) g.appendChild(el('p', 'hint', hint));
  rows.forEach((r) => g.appendChild(r));
  return g;
}
function admNum(label, key, unit, sub) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label + (sub ? `<small>${sub}</small>` : '')));
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = CONFIG[key]; inp.step = 'any';
  inp.onchange = () => { CONFIG[key] = parseFloat(inp.value) || 0; saveConfig(); compute(); };
  const w = el('div'); w.style.display = 'flex'; w.style.alignItems = 'center'; w.style.gap = '6px';
  w.appendChild(inp); if (unit) w.appendChild(el('span', 'mini-label', unit)); row.appendChild(w);
  return row;
}
function admNumDeep(label, parent, key, sub) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label + (sub ? `<small>${sub}</small>` : '')));
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = CONFIG[parent][key]; inp.step = 'any';
  inp.onchange = () => { CONFIG[parent][key] = parseFloat(inp.value) || 0; saveConfig(); compute(); };
  row.appendChild(inp);
  return row;
}
function admSelect(label, key, opts) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const sel = document.createElement('select');
  opts.forEach(([t, v]) => { const o = document.createElement('option'); o.value = v; o.textContent = t + ' €'; if (CONFIG[key] === v) o.selected = true; sel.appendChild(o); });
  sel.onchange = () => { CONFIG[key] = parseFloat(sel.value); saveConfig(); compute(); };
  row.appendChild(sel);
  return row;
}
function admSwitch(label, key) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const sw = el('label', 'switch');
  const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!CONFIG[key];
  inp.onchange = () => { CONFIG[key] = inp.checked; saveConfig(); compute(); };
  sw.appendChild(inp); sw.appendChild(el('span', 'track')); row.appendChild(sw);
  return row;
}
function admCommercialRounding() {
  const cr = CONFIG.commercialRounding;
  const g = el('div', 'adm-group');
  g.appendChild(el('h3', null, 'Commercial Rounding (rate bonifico)'));
  g.appendChild(el('p', 'hint', "Arrotonda le rate del bonifico a cifre semplici da comunicare. Il totale del bonifico resta invariato: la differenza confluisce nella rata di compensazione."));
  g.appendChild(crSelect('Arrotondamento', 'modo',
    [['Nessuno', 'nessuno'], ["All'euro", 'euro'], ['Ai 5 €', '5'], ['Ai 10 €', '10'], ['Ai 50 €', '50'], ['Personalizzato', 'personalizzato']], true));
  if (cr.modo === 'personalizzato') g.appendChild(crNum('Multiplo personalizzato', 'personalizzato', '€'));
  g.appendChild(crSelect('Compensazione', 'strategia', [['Ultima rata', 'ultima'], ['Prima rata', 'prima']], false));
  return g;
}
function crSelect(label, key, opts, refresh) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const sel = document.createElement('select');
  opts.forEach(([t, v]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (CONFIG.commercialRounding[key] === v) o.selected = true; sel.appendChild(o); });
  sel.onchange = () => { CONFIG.commercialRounding[key] = sel.value; saveConfig(); if (refresh) refreshAdmin(); compute(); };
  row.appendChild(sel);
  return row;
}
function crNum(label, key, unit) {
  const row = el('div', 'adm-row'); row.appendChild(el('label', null, label));
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = CONFIG.commercialRounding[key]; inp.step = 'any';
  inp.onchange = () => { CONFIG.commercialRounding[key] = parseFloat(inp.value) || 0; saveConfig(); compute(); };
  const w = el('div'); w.style.display = 'flex'; w.style.alignItems = 'center'; w.style.gap = '6px';
  w.appendChild(inp); if (unit) w.appendChild(el('span', 'mini-label', unit)); row.appendChild(w);
  return row;
}
function refreshAdmin() { const open = $('#admin').classList.contains('is-open'); buildAdmin(); if (open) {/* resta aperto */} }
// Sposta un provider nell'array (= ordine di preferenza + colonne piano).
function moveProvider(i, dir) {
  const a = CONFIG.providers, j = i + dir;
  if (j < 0 || j >= a.length) return;
  const t = a[i]; a[i] = a[j]; a[j] = t;
  saveConfig(); refreshAdmin(); compute();
}function openAdmin() { $('#overlay').hidden = false; const d = $('#admin'); d.classList.add('is-open'); d.setAttribute('aria-hidden', 'false'); }
function closeAdmin() { $('#overlay').hidden = true; const d = $('#admin'); d.classList.remove('is-open'); d.setAttribute('aria-hidden', 'true'); }

function exportConfig() {
  const blob = new Blob([JSON.stringify(CONFIG, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'intesa-config.json'; a.click();
  URL.revokeObjectURL(url); toast('Configurazione esportata');
}
function importConfig(file) {
  const r = new FileReader();
  r.onload = () => {
    try { CONFIG = mergeConfig(structuredClone(DEFAULT_CONFIG), JSON.parse(r.result)); saveConfig(); buildAdmin(); compute(); toast('Configurazione importata'); }
    catch (e) { toast('File non valido'); }
  };
  r.readAsText(file);
}
function resetConfig() { CONFIG = structuredClone(DEFAULT_CONFIG); saveConfig(); buildAdmin(); compute(); toast('Default ripristinati'); }

/* ============================================================================
   PREDISPOSIZIONE — Salvataggio Trattative (roadmap, NON attivo in V1)
   Struttura dati modulare + CRUD su localStorage. Nessuna UI collegata: è la
   base su cui le versioni future potranno costruire il salvataggio locale.
   Ogni trattativa conserva uno snapshot COMPLETO della configurazione usata,
   così potrà essere riaperta con le stesse regole anche se nel frattempo le
   regole aziendali sono cambiate.
   ========================================================================== */
const STATI_TRATTATIVA = { BOZZA: 'bozza', IN_CORSO: 'in_corso', CHIUSA: 'chiusa', ANNULLATA: 'annullata' };
const DEALS_KEY = 'intesa.deals.v1';

const Deals = {
  STATI: STATI_TRATTATIVA,

  _read() { try { return JSON.parse(localStorage.getItem(DEALS_KEY)) || []; } catch (e) { return []; } },
  _write(list) { try { localStorage.setItem(DEALS_KEY, JSON.stringify(list)); return true; } catch (e) { return false; } },
  _uid() { return 'deal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); },

  // Snapshot "serializzabile" della soluzione (senza riferimenti ai profili).
  snapshotSolution(sol) {
    if (!sol) return null;
    return {
      score: sol.score,
      alloc: {
        A: sol.alloc.A, B: sol.alloc.B,
        prov: sol.alloc.prov.map((p) => ({ id: p.id, amount: p.amount, rate: p.rate })),
      },
      totalM: sol.totalM.slice(),
      metrics: { ...sol.metrics },
    };
  },

  // Costruisce una trattativa dallo stato corrente (senza salvarla).
  buildFromCurrent(extra = {}) {
    stampConfigMeta(CONFIG);
    const now = new Date().toISOString();
    return {
      id: this._uid(),
      createdAt: now,
      updatedAt: now,
      cliente: extra.cliente || '',
      note: extra.note || '',
      stato: extra.stato || STATI_TRATTATIVA.BOZZA,
      modalita: state.manual ? 'manual' : 'auto',
      priorita: state.input.priorita,
      prezzo: state.input.prezzo,
      input: { ...state.input },
      locks: { ...state.locks },
      soluzione: this.snapshotSolution(state.sol),
      config: structuredClone(CONFIG),        // snapshot COMPLETO delle regole
      configMeta: { ...CONFIG.meta },          // versione / id / data della config
    };
  },

  list() { return this._read(); },
  get(id) { return this._read().find((d) => d.id === id) || null; },
  save(deal) {
    const list = this._read();
    const i = list.findIndex((d) => d.id === deal.id);
    deal.updatedAt = new Date().toISOString();
    if (i >= 0) list[i] = deal; else list.push(deal);
    this._write(list);
    return deal;
  },
  remove(id) { this._write(this._read().filter((d) => d.id !== id)); },
};

/* ============================================================================
   PREDISPOSIZIONE — API pubblica (roadmap: Live Call e integrazioni)
   Superficie stabile per pilotare l'app dall'esterno SENZA toccare il motore.
   In una futura "Live Call" uno slider chiamerà semplicemente setInput(...):
   il ricalcolo in tempo reale è già quello attuale, l'algoritmo non cambia.
   Inerte in V1 (nessuno la usa).
   ========================================================================== */
// Applica lo stato input ai controlli DOM (per setInput programmatico).
function applyInputToDOM() {
  $('#prezzo').value = state.input.prezzo ? String(state.input.prezzo) : '';
  $('#dispOggi').value = state.input.dispOggi ? String(state.input.dispOggi) : '';
  $('#maxMensile').value = state.input.maxMensile ? String(state.input.maxMensile) : '';
  syncRateChips(); syncPills();
}
const IntesaApp = {
  // Input (target della futura Live Call)
  getInput: () => ({ ...state.input }),
  setInput(patch) { Object.assign(state.input, patch || {}); applyInputToDOM(); compute(); },
  // Risultato corrente + osservatori
  getSolution: () => state.sol,
  onResult(cb) { resultSubscribers.push(cb); return () => { const i = resultSubscribers.indexOf(cb); if (i >= 0) resultSubscribers.splice(i, 1); }; },
  recompute: () => compute(),
  // Modalità ('auto' | 'manual'; estendibile a 'livecall' in futuro)
  getMode: () => (state.manual ? 'manual' : 'auto'),
  setMode(mode) { toggleManual(mode === 'manual'); },
  // Configurazione (sola lettura consigliata) + trattative
  getConfig: () => CONFIG,
  configFingerprint: () => configFingerprint(CONFIG),
  Deals,
  version: '1.0.0',
};

/* ============================================================================
   INIZIALIZZAZIONE
   ========================================================================== */
function init() {
  buildInputs();
  buildAdmin();
  $('#prezzo').addEventListener('input', onInput);
  $('#dispOggi').addEventListener('input', onInput);
  $('#maxMensile').addEventListener('input', onInput);
  $('#btnManual').onclick = () => toggleManual();
  $('#btnAdmin').onclick = openAdmin;
  $('#btnAdminClose').onclick = closeAdmin;
  $('#overlay').onclick = closeAdmin;
  $('#btnCopia').onclick = copyProposal;
  $('#btnNuova').onclick = newDeal;
  $('#btnAdminExport').onclick = exportConfig;
  $('#btnAdminImport').onclick = () => $('#importFile').click();
  $('#importFile').onchange = (e) => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ''; };
  $('#btnAdminReset').onclick = resetConfig;
  compute();
  window.IntesaApp = IntesaApp; // superficie pubblica per estensioni future
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
}
document.addEventListener('DOMContentLoaded', init);
