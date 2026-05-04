// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Parlamentari v5 (Phase 1: lista + gruppi)
// v5 — Senato: usa osr:gruppo (predicato corretto rivelato dalla diagnostica
//      v4) + filtro per legislatura 19 sull'adesione + 3 strategie di
//      fallback inclusa la query inversa "dal gruppo al senatore".
// ========================================================================

import admin from 'firebase-admin';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamentari — Fetch v5 (Phase 1) avviato');
console.log('📅 ', new Date().toLocaleString('it-IT'));
console.log('─'.repeat(50));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/1.0)' };

// ═══════════════════════════════════════════════════════
// COALITION MAPPING
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
// CAMERA — invariata, funziona
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
// SENATO — v5: predicato corretto osr:gruppo + 3 strategie
// SCOPERTA da diagnostica v4: il blank node aderisce ha
//   osr:legislatura, osr:inizio, osr:fine, osr:gruppo, osr:carica
// (NON ocd:dataFine, NON osr:rif_gruppoSenato, NON rif_gruppoParlamentare)
// ═══════════════════════════════════════════════════════
const SPARQL_SENATO = 'http://dati.senato.it/sparql';

async function diagnoseGruppo(gruppoUri) {
  console.log(`   🔬 Diagnostica predicati del gruppo ${gruppoUri}...`);
  const query = `SELECT DISTINCT ?p ?o WHERE { <${gruppoUri}> ?p ?o } LIMIT 50`;
  try {
    const rows = await runSPARQL(SPARQL_SENATO, query, { retries: 2 });
    console.log(`   📋 Predicati del gruppo (${rows.length}):`);
    rows.forEach(r => {
      const p = r.p?.value || '';
      const o = r.o?.value || '';
      const oShort = o.length > 100 ? o.slice(0, 100) + '...' : o;
      console.log(`      ${p}  →  ${oShort}`);
    });
  } catch (e) {
    console.log(`   ⚠ Diagnostica gruppo fallita: ${e.message}`);
  }
}

async function fetchSenatoSenatori() {
  console.log('📥 Senato della Repubblica (SPARQL):');
  const items = [];

  // Step A: lista senatori
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

  const gruppiBySenatore = {};

  // Strategia A: query "diretta" - senatore → adesione legislatura 19 → gruppo
  // Il filtro è osr:legislatura = 19 (numero), NON una URL.
  console.log('   → Strategia A: senatore → adesione lega 19 → osr:gruppo');
  const queryA = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT DISTINCT ?senatore ?gruppoUri ?gruppoNome WHERE {
      ?senatore a osr:Senatore .
      ?senatore ocd:aderisce ?adesione .
      ?adesione osr:legislatura 19 .
      ?adesione osr:gruppo ?gruppoUri .
      OPTIONAL { ?gruppoUri rdfs:label ?gruppoNome }
      OPTIONAL { ?gruppoUri dc:title ?gruppoNome }
      OPTIONAL { ?gruppoUri foaf:name ?gruppoNome }
    }
  `;
  try {
    const grows = await runSPARQL(SPARQL_SENATO, queryA, { retries: 3 });
    console.log(`      → ${grows.length} righe`);
    if (grows.length > 0) {
      console.log(`      Esempio: ${JSON.stringify(grows[0]).slice(0, 350)}`);
    }
    grows.forEach(g => {
      const sen = g.senatore?.value;
      const nome = g.gruppoNome?.value || g.gruppoUri?.value;
      if (sen && nome && !gruppiBySenatore[sen]) gruppiBySenatore[sen] = nome;
    });
  } catch (e) {
    console.log(`      ⚠ Strategia A fallita: ${e.message}`);
  }

  // Strategia B (fallback): se A non trova etichette, scarichiamo
  // tutti gli URI gruppo trovati e diagnostichiamo uno
  if (Object.keys(gruppiBySenatore).length === 0) {
    console.log('   → Strategia A senza risultati, provo query "gruppoUri only"...');
    const queryUri = `
      PREFIX ocd: <http://dati.camera.it/ocd/>
      PREFIX osr: <http://dati.senato.it/osr/>
      SELECT DISTINCT ?senatore ?gruppoUri WHERE {
        ?senatore a osr:Senatore .
        ?senatore ocd:aderisce ?adesione .
        ?adesione osr:legislatura 19 .
        ?adesione osr:gruppo ?gruppoUri .
      }
    `;
    try {
      const grows = await runSPARQL(SPARQL_SENATO, queryUri, { retries: 2 });
      console.log(`      → ${grows.length} righe (solo URI gruppo)`);
      if (grows.length > 0) {
        console.log(`      Esempio URI: ${grows[0].gruppoUri?.value}`);
        await diagnoseGruppo(grows[0].gruppoUri.value);
        // Mappa con URI come placeholder; l'utente vedrà l'URL del gruppo
        // come fallback se non c'è altro
        grows.forEach(g => {
          const sen = g.senatore?.value;
          const uri = g.gruppoUri?.value;
          if (sen && uri && !gruppiBySenatore[sen]) gruppiBySenatore[sen] = uri;
        });
      }
    } catch (e) {
      console.log(`      ⚠ Query URI fallita: ${e.message}`);
    }
  }

  // Strategia C (ultimo fallback): query inversa dal gruppo verso il senatore
  if (Object.keys(gruppiBySenatore).length === 0) {
    console.log('   → Strategia C: query inversa - gruppi della legislatura 19 con loro membri');
    const queryC = `
      PREFIX ocd: <http://dati.camera.it/ocd/>
      PREFIX osr: <http://dati.senato.it/osr/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX dc: <http://purl.org/dc/elements/1.1/>
      SELECT DISTINCT ?senatore ?gruppoUri ?gruppoNome WHERE {
        ?gruppoUri a osr:Gruppo .
        ?gruppoUri osr:legislatura 19 .
        OPTIONAL { ?gruppoUri rdfs:label ?gruppoNome }
        OPTIONAL { ?gruppoUri dc:title ?gruppoNome }
        ?adesione osr:gruppo ?gruppoUri .
        ?senatore ocd:aderisce ?adesione .
        ?senatore a osr:Senatore .
      }
    `;
    try {
      const grows = await runSPARQL(SPARQL_SENATO, queryC, { retries: 2 });
      console.log(`      → ${grows.length} righe`);
      if (grows.length > 0) {
        console.log(`      Esempio: ${JSON.stringify(grows[0]).slice(0, 350)}`);
      }
      grows.forEach(g => {
        const sen = g.senatore?.value;
        const nome = g.gruppoNome?.value || g.gruppoUri?.value;
        if (sen && nome && !gruppiBySenatore[sen]) gruppiBySenatore[sen] = nome;
      });
    } catch (e) {
      console.log(`      ⚠ Strategia C fallita: ${e.message}`);
    }
  }

  console.log(`   📊 Gruppi associati: ${Object.keys(gruppiBySenatore).length} di ${rows.length} senatori`);

  // Step D: assembla
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
    console.error('⚠  Run completato MA Camera è fallita — exit 1');
    process.exit(1);
  }
  console.log('✅ Completato!');
})();
