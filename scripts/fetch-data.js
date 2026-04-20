/**
 * fetch-data.js — versione 2
 * Strategie multiple con fallback per Camera e Senato.
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
        'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/2.0)',
        'Accept': 'application/json, application/xml, text/xml, text/html, */*',
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
  // ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str);
  // RFC 822 (RSS)
  const d = new Date(str);
  if (!isNaN(d)) return d;
  // DD/MM/YYYY
  const parts = str.split('/');
  if (parts.length === 3) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
  return new Date();
}

async function saveToFirestore(items) {
  if (!items.length) { console.log('  → Nessun elemento da salvare.'); return; }
  const unique = [...new Map(items.map(i => [i.id, i])).values()];
  const batchSize = 400;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = db.batch();
    unique.slice(i, i + batchSize).forEach(item => {
      batch.set(db.collection('notizie').doc(item.id), item, { merge: true });
    });
    await batch.commit();
  }
  console.log(`  ✓ Salvati ${unique.length} elementi`);
  return unique.length;
}

// ─── CAMERA DEI DEPUTATI ─────────────────────────────────────────────────────

// Strategia 1: SPARQL semplificato (senza filtro data)
async function fetchCameraSPARQL() {
  console.log('  📡 Camera: SPARQL endpoint...');

  const queries = [
    // Query sedute
    {
      tipo: 'seduta',
      sparql: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ocd: <https://dati.camera.it/ocd/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri a ocd:Seduta ; dc:title ?titolo ; dc:date ?data .
} ORDER BY DESC(?data) LIMIT 30`,
    },
    // Query atti (più generica)
    {
      tipo: 'atto',
      sparql: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ocd: <https://dati.camera.it/ocd/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri a ocd:Atto ; dc:title ?titolo ; dc:date ?data .
} ORDER BY DESC(?data) LIMIT 30`,
    },
    // Query votazioni
    {
      tipo: 'votazione',
      sparql: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ocd: <https://dati.camera.it/ocd/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri a ocd:Votazione ; dc:title ?titolo ; dc:date ?data .
} ORDER BY DESC(?data) LIMIT 30`,
    },
    // Query generica (fallback - prende qualsiasi risorsa con titolo e data)
    {
      tipo: 'atto',
      sparql: `PREFIX dc: <http://purl.org/dc/elements/1.1/>
SELECT DISTINCT ?uri ?titolo ?data WHERE {
  ?uri dc:title ?titolo ; dc:date ?data .
  FILTER(STRSTARTS(STR(?uri), "https://dati.camera.it"))
} ORDER BY DESC(?data) LIMIT 50`,
    },
  ];

  const results = [];
  for (const q of queries) {
    try {
      const url = `https://dati.camera.it/sparql?output=json&query=${encodeURIComponent(q.sparql)}`;
      const raw = await fetchURL(url, { headers: { Accept: 'application/sparql-results+json' } });
      const json = JSON.parse(raw);
      const bindings = json?.results?.bindings || [];
      console.log(`     → ${bindings.length} risultati (${q.tipo})`);
      const items = bindings.map(b => {
        const titolo = b.titolo?.value || 'Atto Camera';
        const data = parseDate(b.data?.value);
        return {
          id: `camera-${q.tipo}-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
          fonte: 'camera', tipo: q.tipo, titolo,
          data: admin.firestore.Timestamp.fromDate(data),
          link: b.uri?.value || 'https://dati.camera.it',
          descrizione: '',
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
      });
      results.push(...items);
      if (results.length >= 30) break; // abbiamo abbastanza dati
    } catch (e) {
      console.warn(`     ⚠ SPARQL (${q.tipo}): ${e.message}`);
    }
  }
  return results;
}

// Strategia 2: RSS/Atom Camera
async function fetchCameraRSS() {
  console.log('  📡 Camera: feed RSS...');
  const feeds = [
    { url: 'https://www.camera.it/leg19/rss/lavori.xml', tipo: 'seduta' },
    { url: 'https://www.camera.it/leg19/rss/notizie.xml', tipo: 'comunicato' },
    { url: 'https://www.camera.it/rss/leg/lavori.xml', tipo: 'seduta' },
    { url: 'https://www.camera.it/rss/notizie.xml', tipo: 'comunicato' },
  ];

  const results = [];
  for (const feed of feeds) {
    try {
      const raw = await fetchURL(feed.url);
      const parsed = await parseStringPromise(raw, { explicitArray: false });
      const items = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
      const arr = Array.isArray(items) ? items : [items];
      const notizie = arr.filter(i => i).map(item => {
        const titolo = String(item.title?._ || item.title || 'Notizia Camera').replace(/<[^>]*>/g, '').trim();
        const link = item.link?.href || item.link || 'https://www.camera.it';
        const data = parseDate(item.pubDate || item.updated || item.date || '');
        return {
          id: `camera-${feed.tipo}-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
          fonte: 'camera', tipo: feed.tipo, titolo,
          data: admin.firestore.Timestamp.fromDate(data),
          link: String(link),
          descrizione: String(item.description?._ || item.description || item.summary || '').replace(/<[^>]*>/g, '').trim().slice(0, 300),
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
      });
      console.log(`     → ${notizie.length} elementi da ${feed.url}`);
      results.push(...notizie);
      if (results.length > 0) break;
    } catch (e) {
      console.warn(`     ⚠ Feed Camera (${feed.url}): ${e.message}`);
    }
  }
  return results;
}

// Strategia 3: Comunicati Camera dal sito ufficiale (JSON/HTML)
async function fetchCameraComunicati() {
  console.log('  📡 Camera: comunicati ufficiali...');
  try {
    // Camera pubblica comunicati in formato accessibile
    const raw = await fetchURL('https://www.camera.it/leg19/1445');
    // Estrai link e titoli dai comunicati (parsing HTML minimale)
    const links = [...raw.matchAll(/href="([^"]*comunicato[^"]*)"[^>]*>([^<]+)</gi)];
    const results = links.slice(0, 20).map(match => {
      const href = match[1].startsWith('http') ? match[1] : `https://www.camera.it${match[1]}`;
      const titolo = match[2].trim();
      return {
        id: `camera-comunicato-${slugify(titolo)}`,
        fonte: 'camera', tipo: 'comunicato', titolo,
        data: admin.firestore.Timestamp.fromDate(new Date()),
        link: href,
        descrizione: '',
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });
    if (results.length > 0) console.log(`     → ${results.length} comunicati Camera`);
    return results;
  } catch (e) {
    console.warn(`     ⚠ Comunicati Camera: ${e.message}`);
    return [];
  }
}

// ─── SENATO DELLA REPUBBLICA ─────────────────────────────────────────────────

async function fetchSenatoRSS() {
  console.log('  📡 Senato: RSS feeds...');

  // Molti possibili URL per i feed del Senato — li proviamo tutti
  const feeds = [
    { url: 'https://www.senato.it/rss/leg/rss_comunicati.xml', tipo: 'comunicato' },
    { url: 'https://www.senato.it/rss/comunicati.xml', tipo: 'comunicato' },
    { url: 'https://www.senato.it/rss.xml', tipo: 'comunicato' },
    { url: 'https://www.senato.it/rss/notizie.xml', tipo: 'comunicato' },
    { url: 'https://www.senato.it/leg/19/RSS/rss_comunicati.xml', tipo: 'comunicato' },
    { url: 'https://www.senato.it/application/xmanager/projects/leg_senato/file/repository/relazioni/RSS/rss_comunicati.xml', tipo: 'comunicato' },
    { url: 'https://www.senato.it/rss/leg/rss_lavori_commissioni.xml', tipo: 'commissione' },
    { url: 'https://www.senato.it/rss/commissioni.xml', tipo: 'commissione' },
  ];

  const results = [];
  for (const feed of feeds) {
    try {
      const raw = await fetchURL(feed.url);
      if (!raw.includes('<rss') && !raw.includes('<feed') && !raw.includes('<?xml')) continue;
      const parsed = await parseStringPromise(raw, { explicitArray: false });
      const items = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
      const arr = Array.isArray(items) ? items : [items];
      if (!arr.length || !arr[0]) continue;
      const notizie = arr.filter(i => i).map(item => {
        const titolo = String(item.title?._ || item.title || 'Notizia Senato').replace(/<[^>]*>/g, '').trim();
        const link = item.link?.href || (typeof item.link === 'string' ? item.link : '') || 'https://www.senato.it';
        const data = parseDate(item.pubDate || item.updated || item.date || '');
        return {
          id: `senato-${feed.tipo}-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
          fonte: 'senato', tipo: feed.tipo, titolo,
          data: admin.firestore.Timestamp.fromDate(data),
          link: String(link),
          descrizione: String(item.description?._ || item.description || item.summary || '').replace(/<[^>]*>/g, '').trim().slice(0, 300),
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
      });
      console.log(`     ✓ ${notizie.length} elementi da: ${feed.url}`);
      results.push(...notizie);
    } catch (e) {
      console.warn(`     ⚠ ${feed.url}: ${e.message}`);
    }
  }
  return results;
}

// Fallback: scraping pagina comunicati Senato
async function fetchSenatoComunicati() {
  console.log('  📡 Senato: pagina comunicati...');
  try {
    const raw = await fetchURL('https://www.senato.it/comunicati-stampa');
    // Parsing minimale dei link alla pagina comunicati
    const links = [...raw.matchAll(/href="([^"]*comunicat[^"]*)"[^>]*>([^<]{10,})</gi)];
    const results = links.slice(0, 20).map(match => {
      const href = match[1].startsWith('http') ? match[1] : `https://www.senato.it${match[1]}`;
      const titolo = match[2].trim();
      return {
        id: `senato-comunicato-${slugify(titolo)}`,
        fonte: 'senato', tipo: 'comunicato', titolo,
        data: admin.firestore.Timestamp.fromDate(new Date()),
        link: href,
        descrizione: '',
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });
    if (results.length > 0) console.log(`     → ${results.length} comunicati Senato`);
    return results;
  } catch (e) {
    console.warn(`     ⚠ Comunicati Senato: ${e.message}`);
    return [];
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏛️  Parlamento Dashboard v2 — Fetch avviato');
  console.log('📅 ', new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));
  console.log('─'.repeat(50));

  const allItems = [];

  // ── CAMERA ──
  console.log('\n📥 Camera dei Deputati:');
  const cameraSPARQL = await fetchCameraSPARQL();
  allItems.push(...cameraSPARQL);

  if (cameraSPARQL.length === 0) {
    console.log('  → SPARQL vuoto, provo RSS...');
    const cameraRSS = await fetchCameraRSS();
    allItems.push(...cameraRSS);

    if (cameraRSS.length === 0) {
      console.log('  → RSS vuoto, provo comunicati...');
      const cameraCom = await fetchCameraComunicati();
      allItems.push(...cameraCom);
    }
  }

  // ── SENATO ──
  console.log('\n📥 Senato della Repubblica:');
  const senatoRSS = await fetchSenatoRSS();
  allItems.push(...senatoRSS);

  if (senatoRSS.length === 0) {
    console.log('  → RSS vuoto, provo pagina comunicati...');
    const senatoCom = await fetchSenatoComunicati();
    allItems.push(...senatoCom);
  }

  // ── SALVATAGGIO ──
  console.log('\n─'.repeat(50));
  const totalSaved = await saveToFirestore(allItems) || 0;

  await db.collection('meta').doc('status').set({
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    totalItems: totalSaved,
    updatedBy: 'github-actions-v2',
  });

  console.log('✅ Completato!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Errore critico:', err);
  process.exit(1);
});
