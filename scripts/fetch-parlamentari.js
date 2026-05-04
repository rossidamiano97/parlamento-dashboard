// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Parlamentari v4 (Phase 1: lista + gruppi)
// v4 — Senato: usa ocd:aderisce (predicato Camera riusato dal Senato)
//      come scoperto dalla diagnostica nei log v3.
// ========================================================================

import admin from 'firebase-admin';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamentari — Fetch v4 (Phase 1) avviato');
console.log('📅 ', new Date().toLocaleString('it-IT'));
console.log('─'.repeat(50));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/1.0)' };

// ═══════════════════════════════════════════════════════
// COALITION MAPPING (XIX Legislatura)
// ═══════════════════════════════════════════════════════
const COALITION_MAP = [
  { match: /fratelli d'italia|^fdi|\bfdi\b/i,                      coalizione: 'centrodestra' },
  { match: /\blega\b|lsp|salvini premier/i,                        coalizione: 'centrodestra' },
  { match: /forza italia|\bfi-|^fi\b|\bppe\b/i,                    coalizione: 'centrodestra' },
  { match: /noi moderati|\bnm\(/i,                                  coalizione: 'centrodestra' },
  { match: /civici/i,                                               coalizione: 'centrodestra' },
  { match: /partito democratico|pd-idp|\bpd\b/i,                   coalizione: 'centrosinistra' },
  { match: /alleanza verdi|\bavs\b|verdi.*sinistra/i,              coalizione: 'centrosinistra' },
  { match: /movimento 5 stelle|\bm5s\b/i,                          coalizione: 'm5s' },
  { match: /\bazione\b|\baz-|italia viva|\biv-|\bivrè\b|\brè\b/i,  coalizione: 'terzo polo' },
  { match: /autonomie|\bsvp\b|trentino|valle.*aosta/i,             coalizione: 'autonomie' },
  { match: /misto/i,                                                coalizione: 'misto' },
];

function mapCoalizione(gruppo) {
  if (!gruppo) return 'altri';
  for (const r of COALITION_MAP) if (r.match.test(gruppo)) return r.coalizione;
  return 'altri';
}

function makeId(prefix, str) {
  return prefix + '-' + String(str)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// SPARQL helper con retry
// ═══════════════════════════════════════════════════════
async function runSPARQL(endpoint, query, opts = {}) {
  const { retries = 3, retryDelay = 5000 } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(endpoint + '?' + new URLSearchParams({
        query, format: 'application/sparql-results+json', 'default-graph-uri': ''
      }), { headers: { ...UA, 'Accept': 'application/sparql-results+json' } });
      if (res.status === 503 || res.status === 504 || res.status === 502) {
        lastErr = new Error(`SPARQL HTTP ${res.status} (server overloaded)`);
        if (attempt < retries) {
          console.log(`   ↻ Tentativo ${attempt}/${retries} fallito (HTTP ${res.status}), retry tra ${retryDelay/1000}s...`);
          await sleep(retryDelay);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
      const json = await res.json();
      return json?.results?.bindings || [];
    } catch (e) {
      lastErr = e;
      if (attempt < retries && /network|fetch failed|timeout/i.test(e.message)) {
        await sleep(retryDelay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════════
// CAMERA — SPARQL su dati.camera.it (con retry)
// ═══════════════════════════════════════════════════════
const SPARQL_CAMERA = 'https://dati.camera.it/sparql';
const LEG_19_CAMERA = 'http://dati.camera.it/ocd/legislatura.rdf/repubblica_19';

async function fetchCameraDeputati() {
  console.log('📥 Camera dei Deputati (SPARQL):');
  const items = [];

  const query = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?deputato ?cognome ?nome ?gruppoLabel WHERE {
      ?deputato a ocd:deputato .
      ?deputato ocd:rif_leg <${LEG_19_CAMERA}> .
      OPTIONAL { ?deputato foaf:firstName ?nome }
      OPTIONAL { ?deputato foaf:surname ?cognome }
      OPTIONAL {
        ?deputato ocd:aderisce ?adesione .
        ?adesione ocd:rif_gruppoParlamentare ?gruppo .
        ?gruppo rdfs:label ?gruppoLabel .
        FILTER NOT EXISTS { ?adesione ocd:dataFine ?df }
      }
    }
  `;

  const rows = await runSPARQL(SPARQL_CAMERA, query, { retries: 4, retryDelay: 8000 });
  console.log(`   → SPARQL ha restituito ${rows.length} righe`);
  if (rows.length > 0) {
    console.log(`   → Esempio prima riga:`, JSON.stringify(rows[0]).slice(0, 300));
  }

  const byDep = {};
  rows.forEach(r => {
    const url = r.deputato?.value;
    const cognome = r.cognome?.value || '';
    const nome = r.nome?.value || '';
    const gruppo = r.gruppoLabel?.value;
    if (!url || !cognome) return;
    if (!byDep[url]) byDep[url] = { url, cognome, nome, gruppi: [] };
    if (gruppo) byDep[url].gruppi.push(gruppo);
  });
  Object.values(byDep).forEach(d => {
    const gruppo = d.gruppi[d.gruppi.length - 1] || 'Non assegnato';
    items.push({
      id: makeId('camera', `${d.cognome}-${d.nome}`),
      fonte: 'camera',
      cognome: d.cognome,
      nome: d.nome,
      nomeCompleto: `${d.cognome} ${d.nome}`.trim(),
      gruppo,
      coalizione: mapCoalizione(gruppo),
      link: d.url,
      presenze: null,
    });
  });
  console.log(`   ✅ Camera: ${items.length} deputati unici`);

  if (items.length === 0) {
    throw new Error('Camera ha restituito 0 deputati — abort per non sovrascrivere dati validi');
  }

  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — SPARQL su dati.senato.it
// FIX v4: usa ocd:aderisce (il Senato riusa il predicato Camera).
// La diagnostica v3 ha rivelato che ogni senatore ha più nodi
// ocd:aderisce (uno per legislatura). Filtriamo per quello senza
// dataFine per avere il gruppo corrente. Inoltre esploriamo il
// blank node con una seconda diagnostica.
// ═══════════════════════════════════════════════════════
const SPARQL_SENATO = 'http://dati.senato.it/sparql';

async function diagnoseAdesione(senatoreUri) {
  console.log(`   🔬 Diagnostica blank node ocd:aderisce per ${senatoreUri}...`);
  const query = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    SELECT DISTINCT ?p ?o WHERE {
      <${senatoreUri}> ocd:aderisce ?adesione .
      ?adesione ?p ?o .
    } LIMIT 60
  `;
  try {
    const rows = await runSPARQL(SPARQL_SENATO, query, { retries: 2 });
    console.log(`   📋 Predicati DENTRO il blank node aderisce (${rows.length}):`);
    const seen = new Set();
    rows.forEach(r => {
      const p = r.p?.value || '';
      const o = r.o?.value || '';
      const oShort = o.length > 100 ? o.slice(0, 100) + '...' : o;
      const key = `${p}::${oShort}`;
      if (seen.has(key)) return;
      seen.add(key);
      console.log(`      ${p}  →  ${oShort}`);
    });
  } catch (e) {
    console.log(`   ⚠ Diagnostica adesione fallita: ${e.message}`);
  }
}

async function fetchSenatoSenatori() {
  console.log('📥 Senato della Repubblica (SPARQL):');
  const items = [];

  // Step A: lista senatori (sappiamo che funziona)
  const queryLista = `
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT DISTINCT ?senatore ?cognome ?nome WHERE {
      ?senatore a osr:Senatore .
      ?senatore osr:mandato ?mandato .
      ?mandato osr:legislatura 19 .
      OPTIONAL { ?senatore foaf:firstName ?nome }
      OPTIONAL { ?senatore foaf:lastName ?cognome }
      OPTIONAL { ?senatore foaf:surname ?cognome }
    }
  `;

  let rows = [];
  try {
    rows = await runSPARQL(SPARQL_SENATO, queryLista, { retries: 3 });
    console.log(`   → Lista senatori: ${rows.length} righe`);
  } catch (e) {
    console.error(`   ❌ Lista senatori fallita: ${e.message}`);
    return items;
  }

  // Step B: diagnostica del blank node aderisce per capire la struttura
  if (rows.length > 0) {
    await diagnoseAdesione(rows[0].senatore.value);
  }

  // Step C: query gruppi tentando varie strategie sul blank node aderisce.
  // Tentiamo simultaneamente diversi predicati interni al blank node.
  const gruppiBySenatore = {};

  // Strategia A: rif_gruppoParlamentare (predicato Camera classico)
  const queryA = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    SELECT DISTINCT ?senatore ?gruppoNome WHERE {
      ?senatore a osr:Senatore .
      ?senatore osr:mandato ?mandato .
      ?mandato osr:legislatura 19 .
      ?senatore ocd:aderisce ?adesione .
      ?adesione ocd:rif_gruppoParlamentare ?gruppo .
      FILTER NOT EXISTS { ?adesione ocd:dataFine ?df }
      OPTIONAL { ?gruppo rdfs:label ?gruppoNome }
      OPTIONAL { ?gruppo dc:title ?gruppoNome }
    }
  `;

  // Strategia B: predicato osr-specific se esiste
  const queryB = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    SELECT DISTINCT ?senatore ?gruppoNome WHERE {
      ?senatore a osr:Senatore .
      ?senatore ocd:aderisce ?adesione .
      ?adesione osr:rif_gruppoSenato ?gruppo .
      FILTER NOT EXISTS { ?adesione ocd:dataFine ?df }
      OPTIONAL { ?gruppo rdfs:label ?gruppoNome }
      OPTIONAL { ?gruppo dc:title ?gruppoNome }
    }
  `;

  // Strategia C: cerca direttamente il label sul blank node (alcuni datasets ci mettono il nome del gruppo direttamente)
  const queryC = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?senatore ?gruppoNome WHERE {
      ?senatore a osr:Senatore .
      ?senatore ocd:aderisce ?adesione .
      ?adesione rdfs:label ?gruppoNome .
      FILTER NOT EXISTS { ?adesione ocd:dataFine ?df }
    }
  `;

  for (const [label, q] of [
    ['A: rif_gruppoParlamentare', queryA],
    ['B: rif_gruppoSenato', queryB],
    ['C: label diretta su adesione', queryC],
  ]) {
    try {
      const grows = await runSPARQL(SPARQL_SENATO, q, { retries: 2 });
      console.log(`   → ${label}: ${grows.length} righe`);
      if (grows.length > 0) {
        console.log(`      Esempio: ${JSON.stringify(grows[0]).slice(0, 300)}`);
        grows.forEach(g => {
          const sen = g.senatore?.value;
          const gruppo = g.gruppoNome?.value;
          if (sen && gruppo && !gruppiBySenatore[sen]) {
            gruppiBySenatore[sen] = gruppo;
          }
        });
      }
    } catch (e) {
      console.log(`   ⚠ ${label} fallita: ${e.message}`);
    }
  }
  console.log(`   📊 Gruppi associati: ${Object.keys(gruppiBySenatore).length} di ${rows.length} senatori`);

  // Step D: assembla i risultati
  const bySen = {};
  rows.forEach(r => {
    const url = r.senatore?.value;
    const cognome = r.cognome?.value || '';
    const nome = r.nome?.value || '';
    if (!url || !cognome) return;
    if (!bySen[url]) bySen[url] = { url, cognome, nome };
  });

  Object.values(bySen).forEach(s => {
    const gruppo = gruppiBySenatore[s.url] || 'Non assegnato';
    items.push({
      id: makeId('senato', `${s.cognome}-${s.nome}`),
      fonte: 'senato',
      cognome: s.cognome,
      nome: s.nome,
      nomeCompleto: `${s.cognome} ${s.nome}`.trim(),
      gruppo,
      coalizione: mapCoalizione(gruppo),
      link: s.url,
      presenze: null,
    });
  });

  console.log(`   ✅ Senato: ${items.length} senatori unici`);
  return items;
}

// ═══════════════════════════════════════════════════════
// SAVE TO FIRESTORE
// ═══════════════════════════════════════════════════════
function sanitize(item) {
  const clean = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (v === null) { clean[k] = null; continue; }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
    }
  }
  return clean;
}

async function saveItems(items) {
  if (!items.length) {
    console.log('─'.repeat(50));
    console.log('   → Nessun parlamentare da salvare. Esco.');
    return;
  }
  console.log('─'.repeat(50));
  console.log(`💾 Salvataggio ${items.length} parlamentari...`);

  const now = admin.firestore.Timestamp.now();
  const chunkSize = 400;
  let saved = 0, skipped = 0;

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const batch = db.batch();
    chunk.forEach(item => {
      try {
        const clean = sanitize(item);
        clean.fetchedAt = now;
        const ref = db.collection('parlamentari').doc(item.id);
        batch.set(ref, clean, { merge: true });
      } catch (e) { skipped++; }
    });
    try {
      await batch.commit();
      saved += chunk.length;
      console.log(`   → Batch ${Math.floor(i/chunkSize)+1}: ${chunk.length} salvati`);
    } catch (e) {
      console.error(`   ❌ Batch fallito: ${e.message}`);
    }
  }

  await db.collection('meta').doc('parlamentari').set({
    lastUpdate: now,
    totalCount: items.length,
    cameraCount: items.filter(i => i.fonte === 'camera').length,
    senatoCount: items.filter(i => i.fonte === 'senato').length,
  }, { merge: true });

  console.log(`✅ Totale salvati: ${saved} (skipped: ${skipped})`);
}

(async () => {
  let camera = [], senato = [];
  let cameraOk = false;

  try {
    camera = await fetchCameraDeputati();
    cameraOk = true;
  } catch (err) {
    console.error(`⚠ Camera fallita: ${err.message}`);
    console.error(`   I dati Camera esistenti in Firestore non saranno toccati.`);
  }

  try {
    senato = await fetchSenatoSenatori();
  } catch (err) {
    console.error(`⚠ Senato fallita: ${err.message}`);
  }

  if (camera.length === 0 && senato.length === 0) {
    console.error('❌ Entrambe le fonti hanno fallito, esco senza scrivere.');
    process.exit(1);
  }

  await saveItems([...camera, ...senato]);

  await db.collection('meta').doc('parlamentari').set({
    lastRun: admin.firestore.Timestamp.now(),
    cameraOk,
    senatoOk: senato.length > 0,
  }, { merge: true });

  console.log('─'.repeat(50));
  if (!cameraOk) {
    console.error('⚠  Run completato MA Camera è fallita — exit 1 per segnalare il problema');
    process.exit(1);
  }
  console.log('✅ Completato!');
})();
