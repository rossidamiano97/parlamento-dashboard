// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Data v6
// URL verificati il 24/04/2026
// ========================================================================

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamento Dashboard v6 — Fetch avviato');
console.log('📅 ', new Date().toLocaleString('it-IT'));
console.log('─'.repeat(50));

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ParlamentoDashboard/1.0; +https://rossidamiano97.github.io/parlamento-dashboard)' };

async function safeFetch(url, opts = {}) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function makeId(prefix, str) {
  return prefix + '-' + String(str).replace(/https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80);
}

async function parseRSS(url, fonte, tipo) {
  const res = await safeFetch(url);
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);
  const rssItems = parsed?.rss?.channel?.[0]?.item || parsed?.['rdf:RDF']?.item || [];
  const items = [];
  rssItems.slice(0, 50).forEach(it => {
    const titolo = (it.title?.[0] || '').replace(/<[^>]+>/g, '').trim();
    const link   = (it.link?.[0] || it['rss:link']?.[0] || '').trim();
    const descr  = (it.description?.[0] || '').replace(/<[^>]+>/g, '').trim();
    const pubDate = it.pubDate?.[0] || it['dc:date']?.[0] || '';
    if (!titolo) return;
    items.push({
      id: makeId(`${fonte}-${tipo}`, link || titolo),
      fonte, tipo, titolo,
      descrizione: descr.slice(0, 500),
      link,
      data: pubDate ? new Date(pubDate) : null,
    });
  });
  return items;
}

// ═══════════════════════════════════════════════════════
// CAMERA — Feed RSS ufficiali (da camera.it/leg19/68)
// ═══════════════════════════════════════════════════════

const CAMERA_FEEDS = [
  // Comunicati della Camera (fonte verificata che funzionava)
  { url: 'https://comunicazione.camera.it/sindacato/notizie?output=rss', tipo: 'comunicato' },
  { url: 'https://www.camera.it/leg19/rss.rss?tipo=19', tipo: 'comunicato' },
  // Resoconti Assemblea (RSS1.0)
  { url: 'https://www.camera.it/leg19/rss?tipo=192', tipo: 'resoconto' },
  // Ordine del giorno
  { url: 'https://www.camera.it/leg19/rss?tipo=195', tipo: 'agenda' },
  // Commissioni
  { url: 'https://www.camera.it/leg19/rss?tipo=196', tipo: 'commissione' },
  // Progetti di legge ultimi
  { url: 'https://www.camera.it/leg19/rss?tipo=197', tipo: 'disegno di legge' },
  // Notizie generali
  { url: 'https://www.camera.it/leg19/rss?tipo=198', tipo: 'comunicato' },
];

async function fetchCamera() {
  const items = [];
  console.log('📥 Camera dei Deputati:');

  for (const feed of CAMERA_FEEDS) {
    try {
      const res = await parseRSS(feed.url, 'camera', feed.tipo);
      items.push(...res);
      console.log(`   ✓ ${feed.tipo} (${res.length})`);
    } catch (e) {
      console.warn(`   ⚠ ${feed.tipo} [${feed.url.slice(-30)}]: ${e.message}`);
    }
  }

  // Fallback: scraping pagina comunicati
  if (items.length === 0) {
    console.log('   📡 Fallback scraping comunicati...');
    try {
      const res = await safeFetch('https://comunicazione.camera.it/');
      const html = await res.text();
      const matches = [...html.matchAll(/<article[^>]*>[\s\S]{0,500}?<a[^>]+href="([^"]+)"[^>]*>([^<]{15,300})<\/a>/gi)];
      matches.slice(0, 30).forEach(([_, href, testo]) => {
        const titolo = testo.replace(/\s+/g, ' ').trim();
        if (!titolo) return;
        const link = href.startsWith('http') ? href : `https://comunicazione.camera.it${href}`;
        items.push({ id: makeId('camera-comunicato', link), fonte: 'camera', tipo: 'comunicato', titolo, descrizione: '', link, data: new Date() });
      });
      console.log(`   ✓ scraping comunicati (${items.length})`);
    } catch (e) {
      console.warn(`   ⚠ scraping comunicati: ${e.message}`);
    }
  }

  console.log(`   ✅ Camera totale: ${items.length} elementi`);
  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — Feed RSS ufficiali (da dati.senato.it)
// ═══════════════════════════════════════════════════════

const SENATO_FEEDS = [
  // Lavori del Senato
  { url: 'http://www.senato.it/senato/feeds/1/1252.xml', tipo: 'comunicato' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGA.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedCLA.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSTA.xml', tipo: 'resoconto' },
  // Commissioni
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedODGGC.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedRSGC.xml', tipo: 'resoconto' },
  { url: 'http://www.senato.it/senato/feed_rss/sedute', tipo: 'commissione' },
  // Leggi e documenti
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedDDL.xml', tipo: 'disegno di legge' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedADG.xml', tipo: 'atto' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedMR.xml', tipo: 'mozione' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feedEODG.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/static/bgt/UltimiAtti/feed.xml', tipo: 'atto' },
  // Dossier
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
      console.warn(`   ⚠ ${feed.tipo} [${feed.url.slice(-40)}]: ${e.message}`);
    }
  }

  console.log(`   ✅ Senato totale: ${items.length} elementi`);
  return items;
}

// ═══════════════════════════════════════════════════════
// SAVE TO FIRESTORE
// ═══════════════════════════════════════════════════════

async function saveItems(items) {
  if (!items.length) {
    console.log('─'.repeat(50));
    console.log('   → Nessun elemento da salvare.');
    return;
  }
  // Deduplica per ID
  const unique = Object.values(Object.fromEntries(items.map(i => [i.id, i])));
  console.log('─'.repeat(50));
  console.log(`💾 Salvataggio ${unique.length} elementi (${items.length - unique.length} duplicati rimossi)...`);

  const now = admin.firestore.FieldValue.serverTimestamp();
  // Firestore ha limite di 500 operazioni per batch
  const chunkSize = 400;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const batch = db.batch();
    chunk.forEach(item => {
      const ref = db.collection('notizie').doc(item.id);
      batch.set(ref, { ...item, fetchedAt: now, timestamp: now }, { merge: true });
    });
    await batch.commit();
    console.log(`   → Batch ${Math.floor(i/chunkSize)+1}: ${chunk.length} salvati`);
  }
  console.log(`✅ Totale salvati: ${unique.length}`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

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
