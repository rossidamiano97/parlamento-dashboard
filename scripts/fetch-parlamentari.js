// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Parlamentari v1 (Phase 1: lista + gruppi)
// Recupera l'anagrafica di deputati e senatori della XIX legislatura con
// gruppi di appartenenza correnti e applica un mapping di coalizione.
// Salva in Firestore collection "parlamentari".
// Le presenze (% partecipazione voti) verranno aggiunte in Phase 2.
// ========================================================================

import admin from 'firebase-admin';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamentari — Fetch v1 (Phase 1) avviato');
console.log('📅 ', new Date().toLocaleString('it-IT'));
console.log('─'.repeat(50));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/1.0)' };

// ═══════════════════════════════════════════════════════
// COALITION MAPPING (XIX Legislatura)
// Modifica liberamente: ogni regola match → coalizione.
// L'ordine conta: la prima regex che matcha vince.
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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuovi accenti
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

// ═══════════════════════════════════════════════════════
// CAMERA — SPARQL su dati.camera.it
// ═══════════════════════════════════════════════════════
const SPARQL_CAMERA = 'https://dati.camera.it/sparql';
const LEG_19 = 'http://dati.camera.it/ocd/legislatura.rdf/repubblica_19';

async function runSPARQL(endpoint, query) {
  const res = await fetch(endpoint + '?' + new URLSearchParams({
    query, format: 'application/sparql-results+json', 'default-graph-uri': ''
  }), { headers: { ...UA, 'Accept': 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
  const json = await res.json();
  return json?.results?.bindings || [];
}

async function fetchCameraDeputati() {
  console.log('📥 Camera dei Deputati (SPARQL):');
  const items = [];

  // Query principale: deputati della legislatura 19 con gruppo corrente
  const query = `
    PREFIX ocd: <http://dati.camera.it/ocd/>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT DISTINCT ?deputato ?cognome ?nome ?gruppoLabel WHERE {
      ?deputato a ocd:deputato .
      ?deputato ocd:rif_leg <${LEG_19}> .
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
    // Aggrega per deputato (ci possono essere più gruppi storici, prendiamo l'ultimo)
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
        presenze: null, // Phase 2
      });
    });
    console.log(`   ✅ Camera: ${items.length} deputati unici`);
  } catch (e) {
    console.error(`   ❌ SPARQL Camera fallito: ${e.message}`);
  }

  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — Scraping della pagina ufficiale "elenco alfabetico"
// ═══════════════════════════════════════════════════════
async function fetchSenatoSenatori() {
  console.log('📥 Senato della Repubblica (scraping):');
  const items = [];

  const URL_ELENCO = 'https://www.senato.it/composizione/senatori/elenco-alfabetico';

  try {
    const res = await fetch(URL_ELENCO, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    console.log(`   → HTML ricevuto: ${html.length} caratteri`);

    // La pagina elenca: <a href="scheda-attivita?did=..."><cognome maiuscolo> <nome></a> · <gruppo>
    // Pattern flessibile che cattura: link + nome completo + testo successivo (per il gruppo)
    const regex = /<a[^>]+href="([^"]*scheda[^"]*did=\d+[^"]*)"[^>]*>\s*([^<]{3,80})\s*<\/a>([\s\S]{0,250}?)(?=<a[^>]+href="[^"]*scheda|<\/li>|<\/tr>|<\/p>)/gi;
    const seen = new Set();
    let match;
    while ((match = regex.exec(html)) !== null) {
      const [, href, fullName, after] = match;
      const cleaned = fullName.replace(/\s+/g, ' ').trim();
      if (!cleaned || cleaned.length < 4) continue;

      // Separa cognome (parte maiuscola) da nome (parte successiva)
      const nameMatch = cleaned.match(/^([A-ZÀ-Ý][A-ZÀ-Ý'\s]+?)\s+([A-ZÀ-Ý][a-zà-ÿ].*)$/);
      if (!nameMatch) continue;
      const cognome = nameMatch[1].trim();
      const nome = nameMatch[2].trim();

      const id = makeId('senato', `${cognome}-${nome}`);
      if (seen.has(id)) continue;
      seen.add(id);

      // Cerca abbreviazione gruppo nel testo successivo (es. "· FI-BP-PPE" o " - PD-IDP")
      const gruppoMatch = after.match(/[·\u00b7\-–—]\s*([A-Z][A-Za-z0-9'\-\s\(\)]{1,60}?)(?=[<\n\r]|\s{3,})/);
      let gruppo = gruppoMatch ? gruppoMatch[1].trim() : 'Non assegnato';
      // Pulisci HTML residuo
      gruppo = gruppo.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
      // Salta se è una nota tipo "(fino al ...)"
      if (/^fino al|^dal\s/i.test(gruppo)) gruppo = 'Non assegnato';

      const link = href.startsWith('http') ? href : `https://www.senato.it${href.startsWith('/') ? '' : '/'}${href}`;
      items.push({
        id, fonte: 'senato',
        cognome, nome,
        nomeCompleto: `${cognome} ${nome}`,
        gruppo,
        coalizione: mapCoalizione(gruppo),
        link,
        presenze: null,
      });
    }
    console.log(`   ✅ Senato: ${items.length} senatori unici`);
    if (items.length > 0) {
      console.log(`   → Esempio:`, JSON.stringify(items[0]).slice(0, 250));
    }
    if (items.length === 0) {
      // Aiuto debug: mostra un pezzetto di HTML in cui dovremmo trovare i nomi
      const idx = html.search(/scheda[\s\S]{0,30}did=\d+/i);
      if (idx > 0) {
        console.log(`   ⚠ HTML attorno al primo "did": ${html.slice(Math.max(0,idx-100), idx+300)}`);
      } else {
        console.log(`   ⚠ Nessuna occorrenza di "scheda?did=..." nell'HTML — la pagina ha probabilmente cambiato struttura`);
      }
    }
  } catch (e) {
    console.error(`   ❌ Scraping Senato fallito: ${e.message}`);
  }

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

  // Salva metadata utili al frontend
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
