// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Parlamentari v2 (Phase 1: lista + gruppi)
// v2: Senato passa da scraping a SPARQL su dati.senato.it
// Recupera l'anagrafica di deputati e senatori della XIX legislatura con
// gruppi di appartenenza correnti e applica un mapping di coalizione.
// Salva in Firestore collection "parlamentari".
// Le presenze (% partecipazione voti) verranno aggiunte in Phase 2.
// ========================================================================

import admin from 'firebase-admin';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamentari — Fetch v2 (Phase 1) avviato');
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

// ═══════════════════════════════════════════════════════
// SPARQL helper
// ═══════════════════════════════════════════════════════
async function runSPARQL(endpoint, query) {
  const res = await fetch(endpoint + '?' + new URLSearchParams({
    query, format: 'application/sparql-results+json', 'default-graph-uri': ''
  }), { headers: { ...UA, 'Accept': 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
  const json = await res.json();
  return json?.results?.bindings || [];
}

// ═══════════════════════════════════════════════════════
// CAMERA — SPARQL su dati.camera.it (INVARIATA, funziona)
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

  try {
    const rows = await runSPARQL(SPARQL_CAMERA, query);
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
  } catch (e) {
    console.error(`   ❌ SPARQL Camera fallito: ${e.message}`);
  }

  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — SPARQL su dati.senato.it (NUOVO in v2)
// Endpoint: http://dati.senato.it/sparql
// Ontologia: OSR (estende OCD), classe osr:Senatore
// ═══════════════════════════════════════════════════════
const SPARQL_SENATO = 'http://dati.senato.it/sparql';

async function fetchSenatoSenatori() {
  console.log('📥 Senato della Repubblica (SPARQL):');
  const items = [];

  // Query con tentativi multipli per il gruppo (OSR estende OCD,
  // ma i predicati esatti per il gruppo Senato non sono documentati
  // uniformemente — proviamo varie alternative in OPTIONAL).
  const queryConGruppo = `
    PREFIX osr: <http://dati.senato.it/osr/>
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    SELECT DISTINCT ?senatore ?cognome ?nome ?gruppoLabel WHERE {
      ?senatore a osr:Senatore .
      ?senatore osr:mandato ?mandato .
      ?mandato osr:legislatura 19 .
      FILTER NOT EXISTS { ?mandato osr:fineMandato ?fm }
      OPTIONAL { ?senatore foaf:firstName ?nome }
      OPTIONAL { ?senatore foaf:lastName ?cognome }
      OPTIONAL { ?senatore foaf:surname ?cognome }
      OPTIONAL {
        ?senatore osr:aderisce ?adesione .
        ?adesione osr:rif_gruppoSenato ?gruppo .
        ?gruppo rdfs:label ?gruppoLabel .
        FILTER NOT EXISTS { ?adesione osr:dataFine ?df }
      }
      OPTIONAL {
        ?senatore osr:gruppoSenato ?gruppo2 .
        ?gruppo2 rdfs:label ?gruppoLabel .
      }
    }
  `;

  // Fallback: query più semplice senza filtro mandato attivo
  const queryFallback = `
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
    rows = await runSPARQL(SPARQL_SENATO, queryConGruppo);
    console.log(`   → Query con gruppo: ${rows.length} righe`);
    if (rows.length > 0) {
      console.log(`   → Esempio:`, JSON.stringify(rows[0]).slice(0, 400));
    }
  } catch (e) {
    console.warn(`   ⚠ Query con gruppo fallita: ${e.message}`);
  }

  if (rows.length === 0) {
    console.log(`   → Tentativo query di fallback (senza filtro mandato attivo)...`);
    try {
      rows = await runSPARQL(SPARQL_SENATO, queryFallback);
      console.log(`   → Query fallback: ${rows.length} righe`);
      if (rows.length > 0) {
        console.log(`   → Esempio:`, JSON.stringify(rows[0]).slice(0, 400));
      }
    } catch (e) {
      console.error(`   ❌ Anche fallback fallita: ${e.message}`);
    }
  }

  // Aggrega per senatore
  const bySen = {};
  rows.forEach(r => {
    const url = r.senatore?.value;
    const cognome = r.cognome?.value || '';
    const nome = r.nome?.value || '';
    const gruppo = r.gruppoLabel?.value;
    if (!url || !cognome) return;
    if (!bySen[url]) bySen[url] = { url, cognome, nome, gruppi: [] };
    if (gruppo) bySen[url].gruppi.push(gruppo);
  });

  Object.values(bySen).forEach(s => {
    const gruppo = s.gruppi[s.gruppi.length - 1] || 'Non assegnato';
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
  try {
    const camera = await fetchCameraDeputati();
    const senato = await fetchSenatoSenatori();
    await saveItems([...camera, ...senato]);
    console.log('─'.repeat(50));
    console.log('✅ Completato!');
  } catch (err) {
    console.error('❌ Errore fatale:', err);
    process.exit(1);
  }
})();
