/**
 * fetch-data.js
 * Raccoglie dati da Camera dei Deputati e Senato della Repubblica
 * e li salva su Firebase Firestore.
 *
 * Fonti:
 *  - Camera: SPARQL endpoint ufficiale su dati.camera.it
 *  - Senato: RSS/XML feed ufficiali + HTML parsing sedute
 */

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

// ─── FIREBASE INIT ──────────────────────────────────────────────────────────

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function fetchURL(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'ParlamentoDashboard/1.0 (github.com/tuo-user/parlamento-dashboard)',
        'Accept': 'application/json, application/sparql-results+json, application/xml, text/xml, */*',
        ...options.headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function parseItalianDate(str) {
  if (!str) return new Date();
  // Gestisce formati: ISO, DD/MM/YYYY, e varianti
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str);
  const [d, m, y] = str.split('/');
  if (d && m && y) return new Date(`${y}-${m}-${d}`);
  return new Date(str);
}

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

// Salva un array di notizie su Firestore (batch, deduplicando per id)
async function saveToFirestore(items) {
  if (!items.length) return;
  const batchSize = 400;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = db.batch();
    items.slice(i, i + batchSize).forEach((item) => {
      const docRef = db.collection('notizie').doc(item.id);
      batch.set(docRef, item, { merge: true });
    });
    await batch.commit();
  }
  console.log(`  ✓ Salvati ${items.length} elementi su Firestore`);
}

// ─── CAMERA DEI DEPUTATI ────────────────────────────────────────────────────

async function fetchCameraViaSPARQL() {
  console.log('📥 Camera: query SPARQL su dati.camera.it...');

  // Query per lavori parlamentari recenti (ultimi 14 giorni)
  const since = getDateNDaysAgo(14);

  const seduteQuery = encodeURIComponent(`
    PREFIX ocd: <https://dati.camera.it/ocd/>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

    SELECT DISTINCT ?uri ?titolo ?data ?sede WHERE {
      ?uri a ocd:Seduta .
      ?uri dc:title ?titolo .
      ?uri dc:date ?data .
      OPTIONAL { ?uri ocd:rif_sede ?sede . }
      FILTER(?data >= "${since}"^^xsd:date)
    }
    ORDER BY DESC(?data)
    LIMIT 50
  `);

  const attiQuery = encodeURIComponent(`
    PREFIX ocd: <https://dati.camera.it/ocd/>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

    SELECT DISTINCT ?uri ?titolo ?data ?tipo WHERE {
      ?uri dc:title ?titolo .
      ?uri dc:date ?data .
      ?uri a ?tipo .
      FILTER(?tipo IN (
        ocd:Atto, ocd:Proposta, ocd:Legge, ocd:Mozione,
        ocd:Interpellanza, ocd:Interrogazione, ocd:Risoluzione
      ))
      FILTER(?data >= "${since}"^^xsd:date)
    }
    ORDER BY DESC(?data)
    LIMIT 50
  `);

  const sparqlBase = 'https://dati.camera.it/sparql?output=json&query=';
  const results = [];

  // Fetch sedute
  try {
    const raw = await fetchURL(sparqlBase + seduteQuery);
    const json = JSON.parse(raw);
    const sedute = (json?.results?.bindings || []).map((b) => {
      const data = parseItalianDate(b.data?.value);
      const titolo = b.titolo?.value || 'Seduta parlamentare';
      return {
        id: `camera-seduta-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
        fonte: 'camera',
        tipo: 'seduta',
        titolo,
        data: admin.firestore.Timestamp.fromDate(data),
        link: b.uri?.value || 'https://www.camera.it',
        descrizione: b.sede?.value || '',
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });
    results.push(...sedute);
    console.log(`  → ${sedute.length} sedute Camera`);
  } catch (e) {
    console.warn('  ⚠ Errore sedute SPARQL Camera:', e.message);
  }

  // Fetch atti
  try {
    const raw = await fetchURL(sparqlBase + attiQuery);
    const json = JSON.parse(raw);
    const atti = (json?.results?.bindings || []).map((b) => {
      const data = parseItalianDate(b.data?.value);
      const titolo = b.titolo?.value || 'Atto parlamentare';
      const tipoUri = b.tipo?.value || '';
      const tipo = tipoUri.includes('Proposta') ? 'proposta' :
                   tipoUri.includes('Legge') ? 'legge' :
                   tipoUri.includes('Mozione') ? 'mozione' :
                   tipoUri.includes('Interpellanza') ? 'interpellanza' :
                   tipoUri.includes('Interrogazione') ? 'interrogazione' : 'atto';
      return {
        id: `camera-atto-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
        fonte: 'camera',
        tipo,
        titolo,
        data: admin.firestore.Timestamp.fromDate(data),
        link: b.uri?.value || 'https://dati.camera.it',
        descrizione: '',
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });
    results.push(...atti);
    console.log(`  → ${atti.length} atti Camera`);
  } catch (e) {
    console.warn('  ⚠ Errore atti SPARQL Camera:', e.message);
  }

  return results;
}

// Votazioni Camera — endpoint dedicato su dati.camera.it
async function fetchCameraVotazioni() {
  console.log('📥 Camera: votazioni...');
  const since = getDateNDaysAgo(14);

  const query = encodeURIComponent(`
    PREFIX ocd: <https://dati.camera.it/ocd/>
    PREFIX dc: <http://purl.org/dc/elements/1.1/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

    SELECT DISTINCT ?uri ?titolo ?data ?esito WHERE {
      ?uri a ocd:Votazione .
      ?uri dc:title ?titolo .
      ?uri dc:date ?data .
      OPTIONAL { ?uri ocd:votazione_esito ?esito . }
      FILTER(?data >= "${since}"^^xsd:date)
    }
    ORDER BY DESC(?data)
    LIMIT 50
  `);

  try {
    const raw = await fetchURL(`https://dati.camera.it/sparql?output=json&query=${query}`);
    const json = JSON.parse(raw);
    const votazioni = (json?.results?.bindings || []).map((b) => {
      const data = parseItalianDate(b.data?.value);
      const titolo = b.titolo?.value || 'Votazione';
      return {
        id: `camera-votazione-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
        fonte: 'camera',
        tipo: 'votazione',
        titolo,
        data: admin.firestore.Timestamp.fromDate(data),
        link: b.uri?.value || 'https://dati.camera.it',
        descrizione: b.esito?.value ? `Esito: ${b.esito.value}` : '',
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    });
    console.log(`  → ${votazioni.length} votazioni Camera`);
    return votazioni;
  } catch (e) {
    console.warn('  ⚠ Errore votazioni Camera:', e.message);
    return [];
  }
}

// ─── SENATO DELLA REPUBBLICA ─────────────────────────────────────────────────

async function fetchSenatoRSS() {
  console.log('📥 Senato: RSS comunicati...');

  // RSS ufficiali del Senato (verifica su https://www.senato.it/ > RSS)
  const feeds = [
    {
      url: 'https://www.senato.it/application/xmanager/projects/leg_senato/attachments/rss/rss_comunicati.xml',
      tipo: 'comunicato',
    },
    {
      url: 'https://www.senato.it/rss/leg/rss_lavori_commissioni.xml',
      tipo: 'commissione',
    },
  ];

  const results = [];

  for (const feed of feeds) {
    try {
      const raw = await fetchURL(feed.url, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      const parsed = await parseStringPromise(raw, { explicitArray: false });
      const items = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
      const arr = Array.isArray(items) ? items : [items];

      const notizie = arr.map((item) => {
        const titolo = item.title?._ || item.title || 'Notizia Senato';
        const link = item.link?.href || item.link || 'https://www.senato.it';
        const dataStr = item.pubDate || item.updated || item.date || '';
        const data = parseItalianDate(dataStr);
        const descrizione = item.description?._ || item.description || item.summary || '';

        return {
          id: `senato-${feed.tipo}-${slugify(titolo)}-${data.toISOString().split('T')[0]}`,
          fonte: 'senato',
          tipo: feed.tipo,
          titolo: String(titolo).replace(/<[^>]*>/g, '').trim(),
          data: admin.firestore.Timestamp.fromDate(data),
          link: String(link),
          descrizione: String(descrizione).replace(/<[^>]*>/g, '').trim().slice(0, 300),
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
      });

      results.push(...notizie);
      console.log(`  → ${notizie.length} elementi da feed Senato (${feed.tipo})`);
    } catch (e) {
      console.warn(`  ⚠ Errore feed Senato (${feed.tipo}):`, e.message);
    }
  }

  return results;
}

// Sedute Senato via SPARQL (Senato ha il proprio endpoint dati)
async function fetchSenatoSedute() {
  console.log('📥 Senato: sedute (sito ufficiale)...');
  // Senato pubblica i lavori anche in formato strutturato
  // Endpoint noto: https://www.senato.it/leg/19/BGT/Schede/Attsen/home.html
  // Per ora usiamo l'RSS più affidabile; qui potresti aggiungere scraping dedicato.
  return [];
}

// ─── AGGIORNAMENTO METADATA ──────────────────────────────────────────────────

async function updateMeta(totalItems) {
  await db.collection('meta').doc('status').set({
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    totalItems,
    updatedBy: 'github-actions',
  });
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🏛️  Parlamento Dashboard — Fetch avviato');
  console.log('📅 ', new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));
  console.log('─'.repeat(50));

  const allItems = [];

  // Camera
  const cameraItems = await fetchCameraViaSPARQL();
  const cameraVotazioni = await fetchCameraVotazioni();
  allItems.push(...cameraItems, ...cameraVotazioni);

  // Senato
  const senatoItems = await fetchSenatoRSS();
  await fetchSenatoSedute();
  allItems.push(...senatoItems);

  // Deduplicazione per ID
  const unique = [...new Map(allItems.map((i) => [i.id, i])).values()];

  console.log('─'.repeat(50));
  console.log(`💾 Totale unici: ${unique.length} — salvataggio su Firestore...`);
  await saveToFirestore(unique);
  await updateMeta(unique.length);

  console.log('✅ Completato!\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Errore critico:', err);
  process.exit(1);
});
