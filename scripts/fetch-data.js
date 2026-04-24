// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Data v8
// Fix Camera: scraping comunicazione.camera.it verificato
// ========================================================================

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamento Dashboard v8 — Fetch avviato');
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

// Parse data italiana "24 Aprile 2026" o "24 apr 2026"
function parseItalianDate(str) {
  const mesi = { 'gennaio':0,'gen':0,'febbraio':1,'feb':1,'marzo':2,'mar':2,'aprile':3,'apr':3,
    'maggio':4,'mag':4,'giugno':5,'giu':5,'luglio':6,'lug':6,'agosto':7,'ago':7,
    'settembre':8,'set':8,'ottobre':9,'ott':9,'novembre':10,'nov':10,'dicembre':11,'dic':11 };
  const m = String(str).toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (!m) return null;
  const mese = mesi[m[2]];
  if (mese === undefined) return null;
  return new Date(parseInt(m[3]), mese, parseInt(m[1]));
}

async function parseRSS(url, fonte, tipo) {
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
      fonte, tipo, titolo,
      descrizione: descr.slice(0, 500),
      link,
      data: safeDate(pubDate),
    });
  });
  return items;
}

// ═══════════════════════════════════════════════════════
// CAMERA — Scraping di comunicazione.camera.it (verificato)
// ═══════════════════════════════════════════════════════

function classifyTipo(titolo, link) {
  const t = titolo.toLowerCase();
  if (/question time|qt/i.test(t)) return 'seduta';
  if (/decreto|decreto-legge|approvazione definitiva/i.test(t)) return 'disegno di legge';
  if (/audizione|audizioni/i.test(t)) return 'commissione';
  if (/disegno di legge|pdl|progetto di legge|ddl/i.test(t)) return 'disegno di legge';
  if (/interrogazione|interpellanz/i.test(t)) return 'mozione';
  if (/mozione|risoluzione/i.test(t)) return 'mozione';
  if (/ordine del giorno|odg|calendario/i.test(t)) return 'agenda';
  if (/resoconto/i.test(t)) return 'resoconto';
  if (/commissione/i.test(t)) return 'commissione';
  if (/aula|assemblea|seduta|fiducia/i.test(t)) return 'seduta';
  if (/conferenza stampa|press/i.test(t)) return 'comunicato';
  return 'comunicato';
}

async function fetchCameraPage(url, label) {
  const items = [];
  try {
    const res = await safeFetch(url);
    const html = await res.text();
    // Pattern: estrai link con titolo (tipicamente link "/archivio-prima-pagina/..." o simili con ampio testo)
    // Cerca sequenze tipo: href="URL" title="TITOLO"> oppure href="URL">TITOLO</a>
    const seen = new Set();

    // Pattern 1: link con title attribute
    const p1 = [...html.matchAll(/<a[^>]+href="([^"]*(?:archivio-prima-pagina|comunicati-stampa|eventi|comma|oggi-in)[^"]*)"[^>]*title="([^"]{15,400})"/gi)];
    p1.forEach(([_, href, titolo]) => {
      const clean = titolo.replace(/\s+/g, ' ').trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      const link = href.startsWith('http') ? href : `https://comunicazione.camera.it${href}`;
      const tipo = classifyTipo(clean, link);
      items.push({
        id: makeId(`camera-${tipo}`, link),
        fonte: 'camera', tipo, titolo: clean,
        descrizione: '', link,
        data: new Date()
      });
    });

    // Pattern 2: link con testo lungo fra tag
    const p2 = [...html.matchAll(/<a[^>]+href="([^"]*(?:archivio-prima-pagina|comunicati-stampa|eventi|comma|oggi-in)[^"]*)"[^>]*>\s*([^<]{20,400})\s*<\/a>/gi)];
    p2.forEach(([_, href, titolo]) => {
      const clean = titolo.replace(/\s+/g, ' ').trim();
      if (!clean || seen.has(clean)) return;
      if (/^(guarda|diretta|scarica|leggi|vai|visualizza|apri|condividi)/i.test(clean)) return;
      seen.add(clean);
      const link = href.startsWith('http') ? href : `https://comunicazione.camera.it${href}`;
      const tipo = classifyTipo(clean, link);
      items.push({
        id: makeId(`camera-${tipo}`, link),
        fonte: 'camera', tipo, titolo: clean,
        descrizione: '', link,
        data: new Date()
      });
    });

    console.log(`   ✓ ${label} (${seen.size})`);
  } catch (e) {
    console.warn(`   ⚠ ${label}: ${e.message}`);
  }
  return items;
}

async function fetchCamera() {
  const items = [];
  console.log('📥 Camera dei Deputati:');

  // Homepage comunicazione.camera.it (verificata, contiene 30+ notizie aggiornate)
  items.push(...await fetchCameraPage('https://comunicazione.camera.it/', 'homepage comunicazione'));
  // Archivio prima pagina (storico)
  items.push(...await fetchCameraPage('https://comunicazione.camera.it/archivio-prima-pagina', 'archivio prima pagina'));
  // Comunicati stampa
  items.push(...await fetchCameraPage('https://comunicazione.camera.it/comunicati-stampa', 'comunicati stampa'));
  // Oggi in Commissione
  items.push(...await fetchCameraPage('https://comunicazione.camera.it/oggi-in-commissione', 'oggi in commissione'));
  // Comm@ (anteprima lavori)
  items.push(...await fetchCameraPage('https://comunicazione.camera.it/comma', 'comm@'));

  // Deduplica per ID all'interno della Camera
  const dedup = Object.values(Object.fromEntries(items.map(i => [i.id, i])));
  console.log(`   ✅ Camera totale: ${dedup.length} elementi unici`);
  return dedup;
}

// ═══════════════════════════════════════════════════════
// SENATO — Feed RSS ufficiali (funzionanti)
// ═══════════════════════════════════════════════════════

const SENATO_FEEDS = [
  { url: 'http://www.senato.it/senato/feeds/1/1252.xml', tipo: 'comunicato' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGA.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedCLA.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSTA.xml', tipo: 'resoconto' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGGC.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSGC.xml', tipo: 'resoconto' },
  { url: 'http://www.senato.it/senato/feed_rss/sedute', tipo: 'commissione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedDDL.xml', tipo: 'disegno di legge' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedADG.xml', tipo: 'atto' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedMR.xml', tipo: 'mozione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedEODG.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feed.xml', tipo: 'atto' },
  { url: 'https://www.senato.it/leg/19/BGT/Schede/Dossier/rss/dossier.xml', tipo: 'comunicato' },
];

async function fetchSenato() {
  const items = [];
  console.log('📥 Senato della Repubblica:');
  for (const feed of SENATO_FEEDS) {
    try {
      const res = await parseRSS(feed.url, 'senato', feed.tipo);
      items.push(...res);
      console.log(`   ✓ ${feed.tipo} (${res.length})`);
    } catch (e) {
      console.warn(`   ⚠ ${feed.tipo}: ${e.message}`);
    }
  }
  console.log(`   ✅ Senato totale: ${items.length} elementi`);
  return items;
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
      } catch (e) {
        skippedTotal++;
      }
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
