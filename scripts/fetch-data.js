// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Data v7
// Fix: date valide + scraping Camera robusto
// ========================================================================

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamento Dashboard v7 — Fetch avviato');
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

// Ritorna una Date valida o null (scarta date NaN o oltre 10 anni dal presente)
function safeDate(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    if (year < 2000 || year > 2035) return null;
    return d;
  } catch (e) { return null; }
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
      data: safeDate(pubDate),
    });
  });
  return items;
}

// ═══════════════════════════════════════════════════════
// CAMERA — Retry con delay + scraping avanzato
// ═══════════════════════════════════════════════════════

// Attende N millisecondi
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchCameraRSS(url, tipo) {
  // Retry fino a 3 volte se 503
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await parseRSS(url, 'camera', tipo);
    } catch (e) {
      if (e.message.includes('503') && attempt < 3) {
        console.log(`      ⏳ 503, retry ${attempt}/3...`);
        await sleep(2000 * attempt);
        continue;
      }
      throw e;
    }
  }
  return [];
}

const CAMERA_FEEDS = [
  { url: 'https://comunicazione.camera.it/sindacato/notizie?output=rss', tipo: 'comunicato' },
  { url: 'https://www.camera.it/leg19/rss.rss?tipo=19', tipo: 'comunicato' },
  { url: 'https://www.camera.it/leg19/rss?tipo=192', tipo: 'resoconto' },
  { url: 'https://www.camera.it/leg19/rss?tipo=195', tipo: 'agenda' },
  { url: 'https://www.camera.it/leg19/rss?tipo=196', tipo: 'commissione' },
  { url: 'https://www.camera.it/leg19/rss?tipo=197', tipo: 'disegno di legge' },
  { url: 'https://www.camera.it/leg19/rss?tipo=198', tipo: 'comunicato' },
];

async function fetchCamera() {
  const items = [];
  console.log('📥 Camera dei Deputati:');

  for (const feed of CAMERA_FEEDS) {
    try {
      const res = await fetchCameraRSS(feed.url, feed.tipo);
      items.push(...res);
      console.log(`   ✓ ${feed.tipo} (${res.length})`);
    } catch (e) {
      console.warn(`   ⚠ ${feed.tipo}: ${e.message}`);
    }
  }

  // Fallback 1: homepage comunicazione.camera.it
  if (items.length === 0) {
    console.log('   📡 Fallback scraping comunicazione.camera.it...');
    try {
      const res = await safeFetch('https://comunicazione.camera.it/');
      const html = await res.text();
      // Pattern più aperto: qualsiasi link con testo lungo ≥ 20 char
      const matches = [...html.matchAll(/<a[^>]+href="([^"]+(?:node|article|notiz)[^"]*)"[^>]*>\s*([^<]{20,300})\s*<\/a>/gi)];
      const seen = new Set();
      matches.forEach(([_, href, testo]) => {
        const titolo = testo.replace(/\s+/g, ' ').trim();
        if (!titolo || seen.has(titolo)) return;
        seen.add(titolo);
        const link = href.startsWith('http') ? href : `https://comunicazione.camera.it${href}`;
        items.push({
          id: makeId('camera-comunicato', link),
          fonte: 'camera', tipo: 'comunicato',
          titolo, descrizione: '', link,
          data: new Date()
        });
      });
      console.log(`   ✓ comunicazione.camera.it (${seen.size})`);
    } catch (e) {
      console.warn(`   ⚠ fallback 1: ${e.message}`);
    }
  }

  // Fallback 2: pagina lavori assemblea
  if (items.length < 5) {
    console.log('   📡 Fallback scraping lavori Camera...');
    try {
      await sleep(1500);
      const res = await safeFetch('https://www.camera.it/leg19/1');
      const html = await res.text();
      // Estrai qualsiasi link con titolo significativo
      const matches = [...html.matchAll(/<a[^>]+href="(\/leg19\/[^"]+)"[^>]*>\s*([^<]{25,300})\s*<\/a>/gi)];
      const seen = new Set();
      matches.slice(0, 50).forEach(([_, href, testo]) => {
        const titolo = testo.replace(/\s+/g, ' ').trim();
        if (!titolo || seen.has(titolo)) return;
        // Filtra navigazione
        if (/^(home|menu|cerca|chi|dove|contatti|trasparen|archivio|legislatur|indietro)/i.test(titolo)) return;
        if (titolo.length > 250) return;
        seen.add(titolo);
        const link = `https://www.camera.it${href}`;
        // Classifica il tipo dal titolo/link
        let tipo = 'comunicato';
        if (/seduta|assemblea|aula/i.test(titolo)) tipo = 'seduta';
        else if (/progetto di legge|disegno di legge|pdl|ddl/i.test(titolo)) tipo = 'disegno di legge';
        else if (/commissione/i.test(titolo)) tipo = 'commissione';
        else if (/ordine del giorno|odg|calendario/i.test(titolo)) tipo = 'agenda';
        else if (/resoconto/i.test(titolo)) tipo = 'resoconto';
        else if (/interrogazio|mozione|interpellan/i.test(titolo)) tipo = 'mozione';

        items.push({
          id: makeId(`camera-${tipo}`, link),
          fonte: 'camera', tipo,
          titolo, descrizione: '', link,
          data: new Date()
        });
      });
      console.log(`   ✓ lavori Camera (${seen.size})`);
    } catch (e) {
      console.warn(`   ⚠ fallback 2: ${e.message}`);
    }
  }

  console.log(`   ✅ Camera totale: ${items.length} elementi`);
  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — Feed RSS ufficiali
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
// SAVE TO FIRESTORE — con validazione dati
// ═══════════════════════════════════════════════════════

function sanitizeForFirestore(item) {
  const clean = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (v === null) { clean[k] = null; continue; }
    // Date: valida + converti a Timestamp
    if (v instanceof Date) {
      if (isNaN(v.getTime())) { clean[k] = null; continue; }
      clean[k] = admin.firestore.Timestamp.fromDate(v);
      continue;
    }
    // Stringhe/numeri/bool
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = v;
      continue;
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
  let savedTotal = 0;
  let skippedTotal = 0;

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
        console.warn(`   ⚠ Skipped ${item.id}: ${e.message}`);
        skippedTotal++;
      }
    });

    try {
      await batch.commit();
      savedTotal += batchCount;
      console.log(`   → Batch ${Math.floor(i/chunkSize)+1}: ${batchCount} salvati`);
    } catch (e) {
      console.error(`   ❌ Batch ${Math.floor(i/chunkSize)+1} fallito: ${e.message}`);
      // Prova a salvare uno alla volta per isolare il problema
      console.log(`      Salvo uno alla volta...`);
      for (const item of chunk) {
        try {
          const clean = sanitizeForFirestore(item);
          clean.fetchedAt = now;
          clean.timestamp = now;
          await db.collection('notizie').doc(item.id).set(clean, { merge: true });
          savedTotal++;
        } catch (itemErr) {
          console.warn(`      ⚠ ${item.id}: ${itemErr.message}`);
          skippedTotal++;
        }
      }
    }
  }
  console.log(`✅ Totale salvati: ${savedTotal} (skipped: ${skippedTotal})`);
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
