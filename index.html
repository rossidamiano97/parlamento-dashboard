// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Data v9
// Focus: solo contenuto legislativo (proposto / in discussione / approvato)
// ========================================================================

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamento Dashboard v9 — Fetch avviato');
console.log('📅 ', new Date().toLocaleString('it-IT'));
console.log('─'.repeat(50));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/1.0)' };

async function safeFetch(url, opts = {}) {
  const res = await fetch(url, { headers: UA, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function makeId(prefix, str) {
  return prefix + '-' + String(str).replace(/https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80);
}

function safeDate(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    if (y < 2000 || y > 2035) return null;
    return d;
  } catch (e) { return null; }
}

async function parseRSS(url, fonte, tipo, stato) {
  const res = await safeFetch(url);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);
  const rssItems = parsed?.rss?.channel?.[0]?.item || parsed?.['rdf:RDF']?.item || [];
  const items = [];
  rssItems.slice(0, 50).forEach(it => {
    const titolo = (it.title?.[0] || '').replace(/<[^>]+>/g, '').trim();
    const link = (it.link?.[0] || it['rss:link']?.[0] || '').trim();
    const descr = (it.description?.[0] || '').replace(/<[^>]+>/g, '').trim();
    const pubDate = it.pubDate?.[0] || it['dc:date']?.[0] || '';
    if (!titolo) return;
    items.push({
      id: makeId(`${fonte}-${tipo}`, link || titolo),
      fonte, tipo, stato, titolo,
      descrizione: descr.slice(0, 500),
      link,
      data: safeDate(pubDate),
    });
  });
  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — Solo feed legislativi, classificati per stato
// ═══════════════════════════════════════════════════════

const SENATO_FEEDS = [
  // PROPOSTE: nuovi atti presentati
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedDDL.xml', tipo: 'disegno di legge', stato: 'proposto' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedADG.xml', tipo: 'atto del governo', stato: 'proposto' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedMR.xml', tipo: 'mozione', stato: 'proposto' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedEODG.xml', tipo: 'emendamento', stato: 'proposto' },
  // IN DISCUSSIONE: ordini del giorno e sedute attuali
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGA.xml', tipo: 'ordine del giorno', stato: 'in discussione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedCLA.xml', tipo: 'calendario', stato: 'in discussione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGGC.xml', tipo: 'ordine del giorno commissioni', stato: 'in discussione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSTA.xml', tipo: 'resoconto Assemblea', stato: 'in discussione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSGC.xml', tipo: 'resoconto commissioni', stato: 'in discussione' },
  // APPROVATE: messaggi di approvazione
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedMDDL.xml', tipo: 'legge approvata', stato: 'approvato' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedMDOC.xml', tipo: 'documento approvato', stato: 'approvato' },
];

async function fetchSenato() {
  const items = [];
  console.log('📥 Senato della Repubblica:');
  for (const feed of SENATO_FEEDS) {
    try {
      const res = await parseRSS(feed.url, 'senato', feed.tipo, feed.stato);
      items.push(...res);
      console.log(`   ✓ [${feed.stato}] ${feed.tipo} (${res.length})`);
    } catch (e) {
      console.warn(`   ⚠ ${feed.tipo}: ${e.message}`);
    }
  }
  console.log(`   ✅ Senato totale: ${items.length} elementi`);
  return items;
}

// ═══════════════════════════════════════════════════════
// CAMERA — SPARQL + scraping mirato
// ═══════════════════════════════════════════════════════

const SPARQL_URL = 'https://dati.camera.it/sparql';
const LEG_19 = 'http://dati.camera.it/ocd/legislatura.rdf/repubblica_19';

async function runSPARQL(query) {
  const res = await fetch(SPARQL_URL + '?' + new URLSearchParams({
    query, format: 'application/sparql-results+json', 'default-graph-uri': ''
  }), { headers: { ...UA, 'Accept': 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`SPARQL HTTP ${res.status}`);
  const json = await res.json();
  return json?.results?.bindings || [];
}

async function fetchCameraSPARQL() {
  const items = [];
  // Query 1: ultimi progetti di legge presentati
  try {
    const query = `
      PREFIX ocd: <http://dati.camera.it/ocd/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX dc: <http://purl.org/dc/elements/1.1/>
      SELECT DISTINCT ?pdl ?titolo ?numero ?dataPres WHERE {
        ?pdl a ocd:progettoDiLegge .
        ?pdl ocd:rif_leg <${LEG_19}> .
        OPTIONAL { ?pdl dc:title ?titolo }
        OPTIONAL { ?pdl ocd:numero ?numero }
        OPTIONAL { ?pdl ocd:rif_presentazione ?presentazione . ?presentazione ocd:data ?dataPres }
      } ORDER BY DESC(?dataPres) LIMIT 50
    `;
    const rows = await runSPARQL(query);
    rows.forEach(r => {
      const titolo = r.titolo?.value || `PdL n. ${r.numero?.value || '?'}`;
      const link = r.pdl?.value || '';
      const data = r.dataPres?.value ? safeDate(r.dataPres.value) : null;
      items.push({
        id: makeId('camera-pdl', link || titolo),
        fonte: 'camera', tipo: 'disegno di legge', stato: 'proposto',
        titolo, descrizione: '', link, data
      });
    });
    console.log(`   ✓ SPARQL progetti di legge (${rows.length})`);
  } catch (e) {
    console.warn(`   ⚠ SPARQL PdL: ${e.message}`);
  }

  // Query 2: leggi approvate
  try {
    const query = `
      PREFIX ocd: <http://dati.camera.it/ocd/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX dc: <http://purl.org/dc/elements/1.1/>
      SELECT DISTINCT ?legge ?titolo ?dataApprovazione WHERE {
        ?legge a ocd:legge .
        ?legge ocd:rif_leg <${LEG_19}> .
        OPTIONAL { ?legge dc:title ?titolo }
        OPTIONAL { ?legge ocd:dataApprovazione ?dataApprovazione }
      } ORDER BY DESC(?dataApprovazione) LIMIT 30
    `;
    const rows = await runSPARQL(query);
    rows.forEach(r => {
      const titolo = r.titolo?.value || 'Legge';
      const link = r.legge?.value || '';
      const data = r.dataApprovazione?.value ? safeDate(r.dataApprovazione.value) : null;
      items.push({
        id: makeId('camera-legge', link || titolo),
        fonte: 'camera', tipo: 'legge approvata', stato: 'approvato',
        titolo, descrizione: '', link, data
      });
    });
    console.log(`   ✓ SPARQL leggi approvate (${rows.length})`);
  } catch (e) {
    console.warn(`   ⚠ SPARQL leggi: ${e.message}`);
  }

  return items;
}

async function fetchCameraScraping() {
  const items = [];

  // Resoconti Assemblea (in discussione)
  try {
    const res = await safeFetch('https://www.camera.it/leg19/207');
    const html = await res.text();
    const matches = [...html.matchAll(/<a[^>]+href="(\/leg19\/410\?idSeduta=\d+[^"]*)"[^>]*>\s*([^<]{10,400})\s*<\/a>/gi)];
    const seen = new Set();
    matches.slice(0, 40).forEach(([_, href, testo]) => {
      const titolo = testo.replace(/\s+/g, ' ').trim();
      if (!titolo || seen.has(titolo)) return;
      if (/^(guarda|odg|leggi|vai|apri|visualizza)/i.test(titolo)) return;
      seen.add(titolo);
      const link = `https://www.camera.it${href}`;
      items.push({
        id: makeId('camera-resoconto', link),
        fonte: 'camera', tipo: 'resoconto Assemblea', stato: 'in discussione',
        titolo: `Seduta: ${titolo}`, descrizione: '', link, data: new Date()
      });
    });
    console.log(`   ✓ Resoconti Assemblea (${seen.size})`);
  } catch (e) {
    console.warn(`   ⚠ Resoconti Assemblea: ${e.message}`);
  }

  // Decreti-legge esaminati (in discussione + approvati)
  try {
    const res = await safeFetch('https://www.camera.it/leg19/577');
    const html = await res.text();
    const matches = [...html.matchAll(/Decreto[\s-]*Legge[^<]{5,200}/gi)];
    const seen = new Set();
    matches.slice(0, 20).forEach(([testo]) => {
      const titolo = testo.replace(/\s+/g, ' ').trim();
      if (!titolo || seen.has(titolo) || titolo.length < 20) return;
      seen.add(titolo);
      items.push({
        id: makeId('camera-decreto', titolo),
        fonte: 'camera', tipo: 'decreto legge', stato: 'in discussione',
        titolo, descrizione: '',
        link: 'https://www.camera.it/leg19/577',
        data: new Date()
      });
    });
    console.log(`   ✓ Decreti-legge (${seen.size})`);
  } catch (e) {
    console.warn(`   ⚠ Decreti-legge: ${e.message}`);
  }

  // Atti di indirizzo (interrogazioni, mozioni, interpellanze) — proposti
  try {
    const res = await safeFetch('https://aic.camera.it/aic/search.html?legislatura=19');
    const html = await res.text();
    // Cerca tabella con righe atti
    const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
    const seen = new Set();
    let count = 0;
    rows.forEach(([tr]) => {
      if (count >= 30) return;
      const tipoMatch = tr.match(/>(Interrogazione[^<]*|Mozione[^<]*|Interpellanza[^<]*|Risoluzione[^<]*|Ordine del [Gg]iorno[^<]*)</);
      const linkMatch = tr.match(/href="([^"]+)"/);
      const titoloMatch = tr.match(/title="([^"]+)"/);
      if (!tipoMatch) return;
      const titolo = (titoloMatch?.[1] || tipoMatch[1]).replace(/\s+/g, ' ').trim();
      if (!titolo || seen.has(titolo) || titolo.length < 10) return;
      seen.add(titolo);
      const href = linkMatch?.[1] || '';
      const link = href.startsWith('http') ? href : `https://aic.camera.it${href}`;
      const tipoRaw = tipoMatch[1].toLowerCase();
      const tipo = tipoRaw.includes('mozione') ? 'mozione' :
                   tipoRaw.includes('interroga') ? 'interrogazione' :
                   tipoRaw.includes('interpella') ? 'interpellanza' :
                   tipoRaw.includes('risoluz') ? 'risoluzione' : 'ordine del giorno';
      items.push({
        id: makeId(`camera-${tipo}`, link || titolo),
        fonte: 'camera', tipo, stato: 'proposto',
        titolo, descrizione: '', link, data: new Date()
      });
      count++;
    });
    console.log(`   ✓ Atti di indirizzo (${seen.size})`);
  } catch (e) {
    console.warn(`   ⚠ Atti di indirizzo: ${e.message}`);
  }

  // Resoconti Commissioni (in discussione)
  try {
    const res = await safeFetch('https://www.camera.it/leg19/210');
    const html = await res.text();
    const matches = [...html.matchAll(/<a[^>]+href="(\/leg19\/[^"]*resoconto[^"]*)"[^>]*>\s*([^<]{10,300})\s*<\/a>/gi)];
    const seen = new Set();
    matches.slice(0, 30).forEach(([_, href, testo]) => {
      const titolo = testo.replace(/\s+/g, ' ').trim();
      if (!titolo || seen.has(titolo)) return;
      seen.add(titolo);
      const link = `https://www.camera.it${href}`;
      items.push({
        id: makeId('camera-resoconto-comm', link),
        fonte: 'camera', tipo: 'resoconto commissioni', stato: 'in discussione',
        titolo: `Commissione: ${titolo}`, descrizione: '', link, data: new Date()
      });
    });
    console.log(`   ✓ Resoconti Commissioni (${seen.size})`);
  } catch (e) {
    console.warn(`   ⚠ Resoconti Commissioni: ${e.message}`);
  }

  return items;
}

async function fetchCamera() {
  console.log('📥 Camera dei Deputati:');
  const items = [];
  // Tenta SPARQL (fonte migliore)
  try {
    items.push(...await fetchCameraSPARQL());
  } catch (e) { console.warn(`   ⚠ SPARQL: ${e.message}`); }
  // Scraping mirato (complementare e fallback)
  items.push(...await fetchCameraScraping());
  // Dedup
  const dedup = Object.values(Object.fromEntries(items.map(i => [i.id, i])));
  console.log(`   ✅ Camera totale: ${dedup.length} elementi unici`);
  return dedup;
}

// ═══════════════════════════════════════════════════════
// SAVE TO FIRESTORE
// ═══════════════════════════════════════════════════════

function sanitizeForFirestore(item) {
  const clean = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (v === null) { clean[k] = null; continue; }
    if (v instanceof Date) {
      if (isNaN(v.getTime())) { clean[k] = null; continue; }
      clean[k] = admin.firestore.Timestamp.fromDate(v);
      continue;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
    }
  }
  return clean;
}

async function saveItems(items) {
  if (!items.length) {
    console.log('─'.repeat(50));
    console.log('   → Nessun elemento da salvare.');
    return;
  }
  const unique = Object.values(Object.fromEntries(items.map(i => [i.id, i])));
  console.log('─'.repeat(50));
  console.log(`💾 Salvataggio ${unique.length} elementi (${items.length - unique.length} duplicati rimossi)...`);

  const now = admin.firestore.Timestamp.now();
  const chunkSize = 400;
  let savedTotal = 0, skippedTotal = 0;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const batch = db.batch();
    let batchCount = 0;
    chunk.forEach(item => {
      try {
        const clean = sanitizeForFirestore(item);
        clean.fetchedAt = now;
        clean.timestamp = now;
        const ref = db.collection('notizie').doc(item.id);
        batch.set(ref, clean, { merge: true });
        batchCount++;
      } catch (e) { skippedTotal++; }
    });
    try {
      await batch.commit();
      savedTotal += batchCount;
      console.log(`   → Batch ${Math.floor(i/chunkSize)+1}: ${batchCount} salvati`);
    } catch (e) {
      console.error(`   ❌ Batch fallito: ${e.message}`);
      for (const item of chunk) {
        try {
          const clean = sanitizeForFirestore(item);
          clean.fetchedAt = now;
          clean.timestamp = now;
          await db.collection('notizie').doc(item.id).set(clean, { merge: true });
          savedTotal++;
        } catch (e2) { skippedTotal++; }
      }
    }
  }
  console.log(`✅ Totale salvati: ${savedTotal} (skipped: ${skippedTotal})`);
}

(async () => {
  try {
    const camera = await fetchCamera();
    const senato = await fetchSenato();
    await saveItems([...camera, ...senato]);
    console.log('─'.repeat(50));
    console.log('✅ Completato!');
  } catch (err) {
    console.error('❌ Errore fatale:', err);
    process.exit(1);
  }
})();
