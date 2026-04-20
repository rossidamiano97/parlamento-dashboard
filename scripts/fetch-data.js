/**
 * fetch-data.js — versione 3
 * URL verificati da dati.senato.it e dati.camera.it
 */

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

// ─── FIREBASE INIT ───────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function fetchURL(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/3.0)',
        'Accept': 'application/xml, text/xml, application/rss+xml, application/atom+xml, */*',
        ...options.headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
}

function parseDate(str) {
  if (!str) return new Date();
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  const parts = str.split('/');
  if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
  return new Date();
}

async function parseRSS(raw) {
  try {
    const parsed = await parseStringPromise(raw, { explicitArray: false, trim: true });
    const items = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
    return Array.isArray(items) ? items : (items ? [items] : []);
  } catch (e) {
    return [];
  }
}

async function saveToFirestore(items) {
  if (!items.length) { console.log('  → Nessun elemento da salvare.'); return 0; }
  const unique = [...new Map(items.map(i => [i.id, i])).values()];
  for (let i = 0; i < unique.length; i += 400) {
    const batch = db.batch();
    unique.slice(i, i + 400).forEach(item => {
      batch.set(db.collection('notizie').doc(item.id), item, { merge: true });
    });
    await batch.commit();
  }
  console.log(`  ✓ Salvati ${unique.length} elementi`);
  return unique.length;
}

function makeItem(fonte, tipo, titolo, data, link, descrizione) {
  const cleanTitle = String(titolo).replace(/<[^>]*>/g, '').trim();
  const cleanDesc = String(descrizione || '').replace(/<[^>]*>/g, '').trim().slice(0, 300);
  const d = data instanceof Date ? data : parseDate(data);
  return {
    id: `${fonte}-${tipo}-${slugify(cleanTitle)}-${d.toISOString().split('T')[0]}`,
    fonte, tipo,
    titolo: cleanTitle,
    data: admin.firestore.Timestamp.fromDate(d),
    link: String(link || `https://www.${fonte}.it`),
    descrizione: cleanDesc,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

// ─── SENATO — URL UFFICIALI DA dati.senato.it ─────────────────────────────────
// Fonte verificata: https://dati.senato.it/sito/feed_rss?testo_generico=9

const SENATO_FEEDS = [
  // Lavori assemblea
  { url: 'http://www.senato.it/senato/feeds/1/1252.xml',                          tipo: 'seduta',      label: 'Comunicati fine seduta Assemblea' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGA.xml',              tipo: 'agenda',      label: 'Ordine del giorno Assemblea' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedCLA.xml',               tipo: 'agenda',      label: 'Calendario lavori Assemblea' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSTA.xml',              tipo: 'seduta',      label: 'Resoconti Assemblea' },
  // Commissioni
  { url: 'http://www.senato.it/senato/feed_rss/sedute',                            tipo: 'commissione', label: 'Comunicati Commissioni' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGGC.xml',             tipo: 'agenda',      label: 'Ordini del giorno Commissioni' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSGC.xml',              tipo: 'commissione', label: 'Resoconti sommari Commissioni' },
  // Leggi e documenti
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedDDL.xml',               tipo: 'legge',       label: 'Disegni di legge' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedMR.xml',                tipo: 'mozione',     label: 'Mozioni e risoluzioni' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feed.xml',                  tipo: 'atto',        label: 'Tutti gli stampati della settimana' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedADG.xml',               tipo: 'atto',        label: 'Atti del Governo' },
];

async function fetchSenato() {
  console.log('\n📥 Senato della Repubblica:');
  const results = [];

  for (const feed of SENATO_FEEDS) {
    try {
      const raw = await fetchURL(feed.url);
      const items = await parseRSS(raw);
      if (!items.length) { console.log(`  ○ ${feed.label}: vuoto`); continue; }

      const notizie = items.map(item => {
        const titolo = item.title?._ || item.title || feed.label;
        const link   = item.link?.href || (typeof item.link === 'string' ? item.link : '') || item.guid?._ || item.guid || '';
        const data   = parseDate(item.pubDate || item.updated || item['dc:date'] || item.date || '');
        const desc   = item.description?._ || item.description || item.summary?._ || item.summary || '';
        return makeItem('senato', feed.tipo, titolo, data, link, desc);
      });

      results.push(...notizie);
      console.log(`  ✓ ${notizie.length} elementi — ${feed.label}`);
    } catch (e) {
      console.warn(`  ⚠ ${feed.label}: ${e.message}`);
    }
  }

  return results;
}

// ─── CAMERA DEI DEPUTATI — SPARQL + RSS ───────────────────────────────────────

async function fetchCameraSPARQL() {
  console.log('\n📥 Camera dei Deputati (SPARQL):');

  // Query senza filtro su classe specifica e senza filtro data
  // La Camera usa ocd: come namespace con classi specifiche
  // Proviamo query progressive dal più specifico al più generico
  const queries = [
    {
      label: 'Atti parlamentari (ocd:Atto)',
      tipo: 'atto',
      q: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ocd: <https://dati.camera.it/ocd/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri a ocd:Atto ; dc:title ?titolo ; dc:date ?data .
} ORDER BY DESC(?data) LIMIT 30`,
    },
    {
      label: 'Proposte di legge',
      tipo: 'proposta',
      q: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ocd: <https://dati.camera.it/ocd/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri a ocd:PropostaDiLegge ; dc:title ?titolo ; dc:date ?data .
} ORDER BY DESC(?data) LIMIT 30`,
    },
    {
      label: 'Votazioni',
      tipo: 'votazione',
      q: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ocd: <https://dati.camera.it/ocd/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri a ocd:Votazione ; dc:title ?titolo ; dc:date ?data .
} ORDER BY DESC(?data) LIMIT 30`,
    },
    {
      label: 'Query generica (qualsiasi risorsa con titolo+data)',
      tipo: 'atto',
      q: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri dc:title ?titolo ; dc:date ?data .
  FILTER(STRSTARTS(STR(?uri), "https://dati.camera.it/ocd/"))
} ORDER BY DESC(?data) LIMIT 50`,
    },
    {
      label: 'Classi disponibili (debug)',
      tipo: null,
      q: `SELECT DISTINCT ?classe (COUNT(?s) AS ?n) WHERE {
  ?s a ?classe .
  FILTER(STRSTARTS(STR(?classe), "https://dati.camera.it"))
} GROUP BY ?classe ORDER BY DESC(?n) LIMIT 20`,
    },
  ];

  const results = [];
  for (const query of queries) {
    try {
      const url = `https://dati.camera.it/sparql?output=json&query=${encodeURIComponent(query.q)}`;
      const raw = await fetchURL(url, { headers: { Accept: 'application/sparql-results+json, application/json' } });
      const json = JSON.parse(raw);
      const bindings = json?.results?.bindings || [];
      
      if (!query.tipo) {
        // query di debug — logga le classi disponibili
        console.log(`  🔍 Classi trovate nel triplestore Camera:`);
        bindings.forEach(b => console.log(`     - ${b.classe?.value} (${b.n?.value})`));
        continue;
      }

      console.log(`  ${bindings.length > 0 ? '✓' : '○'} ${bindings.length} — ${query.label}`);
      const items = bindings.map(b => {
        const titolo = b.titolo?.value || 'Atto Camera';
        const data = parseDate(b.data?.value || '');
        return makeItem('camera', query.tipo, titolo, data, b.uri?.value || '', '');
      });
      results.push(...items);
    } catch (e) {
      console.warn(`  ⚠ ${query.label}: ${e.message}`);
    }
  }
  return results;
}

// Camera: notizie ed eventi da comunicazione.camera.it (JSON API se disponibile)
async function fetchCameraNews() {
  console.log('\n📥 Camera — comunicazione.camera.it:');
  const results = [];

  // Prova il feed RSS del sito di comunicazione Camera
  const feeds = [
    { url: 'https://comunicazione.camera.it/rss.xml',    tipo: 'comunicato' },
    { url: 'https://comunicazione.camera.it/feed',       tipo: 'comunicato' },
    { url: 'https://comunicazione.camera.it/news.xml',   tipo: 'comunicato' },
    { url: 'https://www.camera.it/leg19/rss.xml',        tipo: 'comunicato' },
    { url: 'https://www.camera.it/rss.xml',              tipo: 'comunicato' },
  ];

  for (const feed of feeds) {
    try {
      const raw = await fetchURL(feed.url);
      if (!raw.trim().startsWith('<')) continue;
      const items = await parseRSS(raw);
      if (!items.length) continue;

      const notizie = items.map(item => {
        const titolo = item.title?._ || item.title || 'Notizia Camera';
        const link   = item.link?.href || (typeof item.link === 'string' ? item.link : '') || '';
        const data   = parseDate(item.pubDate || item.updated || item.date || '');
        const desc   = item.description?._ || item.description || '';
        return makeItem('camera', feed.tipo, titolo, data, link, desc);
      });

      console.log(`  ✓ ${notizie.length} — ${feed.url}`);
      results.push(...notizie);
      break; // primo feed funzionante è sufficiente
    } catch (e) {
      console.warn(`  ⚠ ${feed.url}: ${e.message}`);
    }
  }
  return results;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏛️  Parlamento Dashboard v3 — Fetch avviato');
  console.log('📅 ', new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));
  console.log('─'.repeat(50));

  const allItems = [];

  // Senato (URL ufficiali verificati)
  const senatoItems = await fetchSenato();
  allItems.push(...senatoItems);

  // Camera SPARQL
  const cameraItems = await fetchCameraSPARQL();
  allItems.push(...cameraItems);

  // Camera news (fallback se SPARQL è vuoto)
  if (cameraItems.length === 0) {
    const cameraNews = await fetchCameraNews();
    allItems.push(...cameraNews);
  }

  console.log('\n─'.repeat(50));
  const totalSaved = await saveToFirestore(allItems);

  await db.collection('meta').doc('status').set({
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    totalItems: totalSaved,
    updatedBy: 'github-actions-v3',
  });

  console.log('✅ Completato!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Errore critico:', err);
  process.exit(1);
});
