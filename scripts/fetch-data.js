// ========================================================================
// PARLAMENTO DASHBOARD — Fetch Data v5
// Versione migliorata con fonti Camera multiple per avere più tipi di atti
// ========================================================================

import admin from 'firebase-admin';
import { parseStringPromise } from 'xml2js';

// ──────────────── Firebase Init ────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

console.log('🏛  Parlamento Dashboard v5 — Fetch avviato');
console.log('📅 ', new Date().toLocaleString('it-IT'));
console.log('─'.repeat(50));

// ──────────────── Utility ────────────────
const UA = { 'User-Agent': 'Mozilla/5.0 (ParlamentoDashboard/1.0)' };

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: UA, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    throw new Error(`${url}: ${e.message}`);
  }
}

function makeId(prefix, uniquePart) {
  const clean = String(uniquePart)
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
    .slice(0, 80);
  return `${prefix}-${clean}`;
}

// ═══════════════════════════════════════════════════════
// CAMERA — Feeds RSS + fallback scraping
// ═══════════════════════════════════════════════════════

const CAMERA_FEEDS = [
  { url: 'https://www.camera.it/leg19/126?idLegislatura=19', tipo: 'comunicato', fonte: 'scraping' },
  // RSS candidates
  { url: 'https://www.camera.it/leg19/1216', tipo: 'agenda', fonte: 'scraping' }, // calendario lavori
  { url: 'https://www.camera.it/leg19/410?idSeduta=0&tipo=atto_sintesi_pdl&pdl=', tipo: 'atto', fonte: 'scraping' },
];

// Feed RSS di comunicati Camera (già funziona)
const CAMERA_COMUNICATI = 'https://www.camera.it/leg19/rss.rss?tipo=19';

async function fetchCamera() {
  const items = [];

  // 1) Tenta il feed RSS comunicati (già funzionante)
  console.log('📥 Camera dei Deputati:');
  try {
    console.log('   📡 RSS comunicati...');
    const res = await safeFetch(CAMERA_COMUNICATI);
    const xml = await res.text();
    const parsed = await parseStringPromise(xml);
    const rssItems = parsed?.rss?.channel?.[0]?.item || [];
    rssItems.slice(0, 50).forEach(it => {
      const titolo = (it.title?.[0] || '').trim();
      const link = (it.link?.[0] || '').trim();
      const descr = (it.description?.[0] || '').trim();
      const pubDate = it.pubDate?.[0] || '';
      if (!titolo) return;
      items.push({
        id: makeId('camera-comunicato', link || titolo),
        fonte: 'camera',
        tipo: 'comunicato',
        titolo,
        descrizione: descr,
        link,
        data: pubDate ? new Date(pubDate) : null,
      });
    });
    console.log(`      → ${rssItems.length} comunicati`);
  } catch (e) {
    console.warn(`   ⚠ RSS comunicati: ${e.message}`);
  }

  // 2) Scraping della pagina "Lavori" — prossime sedute dell'Assemblea
  try {
    console.log('   📡 Calendario Assemblea...');
    const res = await safeFetch('https://www.camera.it/leg19/1');
    const html = await res.text();
    // Cerca link con pattern "aula" o "seduta" nella homepage
    const sedutaMatches = [...html.matchAll(/<a[^>]+href="(\/leg19\/[^"]*(?:seduta|aula|resoconti)[^"]*)"[^>]*>([^<]{10,200})<\/a>/gi)];
    sedutaMatches.slice(0, 20).forEach(([_, href, testo]) => {
      const titolo = testo.replace(/\s+/g, ' ').trim();
      if (!titolo || titolo.length < 10) return;
      const link = href.startsWith('http') ? href : `https://www.camera.it${href}`;
      items.push({
        id: makeId('camera-seduta', link),
        fonte: 'camera',
        tipo: 'seduta',
        titolo,
        descrizione: '',
        link,
        data: new Date(),
      });
    });
    console.log(`      → ${sedutaMatches.length} riferimenti sedute`);
  } catch (e) {
    console.warn(`   ⚠ Calendario: ${e.message}`);
  }

  // 3) Progetti di legge — scraping pagina "Progetti di legge"
  try {
    console.log('   📡 Progetti di legge...');
    const res = await safeFetch('https://www.camera.it/leg19/126?idLegislatura=19');
    const html = await res.text();
    // Cerca titoli di PdL con link al dossier
    const pdlMatches = [...html.matchAll(/<a[^>]+href="(\/leg19\/126[^"]*)"[^>]*>([^<]{15,300})<\/a>/gi)];
    const seen = new Set();
    pdlMatches.slice(0, 40).forEach(([_, href, testo]) => {
      const titolo = testo.replace(/\s+/g, ' ').trim();
      if (!titolo || titolo.length < 15 || seen.has(titolo)) return;
      seen.add(titolo);
      const link = `https://www.camera.it${href}`;
      items.push({
        id: makeId('camera-pdl', link),
        fonte: 'camera',
        tipo: 'disegno di legge',
        titolo,
        descrizione: '',
        link,
        data: new Date(),
      });
    });
    console.log(`      → ${seen.size} progetti di legge`);
  } catch (e) {
    console.warn(`   ⚠ Progetti di legge: ${e.message}`);
  }

  // 4) Atti di indirizzo e controllo (interrogazioni, mozioni)
  try {
    console.log('   📡 Atti di indirizzo...');
    const res = await safeFetch('https://aic.camera.it/aic/search.html?tipo=&legislatura=19&numero=&dataPresentazioneFrom=&dataPresentazioneTo=&nometesto=&submit=Cerca');
    const html = await res.text();
    const matches = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(Interrogazione|Mozione|Interpellanza|Risoluzione)[^<]{0,400}<\/a>/gi)];
    const seen = new Set();
    matches.slice(0, 30).forEach(([full, href, tipo]) => {
      const titoloMatch = full.match(/>([^<]+)</);
      const titolo = titoloMatch ? titoloMatch[1].replace(/\s+/g, ' ').trim() : '';
      if (!titolo || titolo.length < 10 || seen.has(titolo)) return;
      seen.add(titolo);
      const link = href.startsWith('http') ? href : `https://aic.camera.it${href}`;
      items.push({
        id: makeId('camera-atto', link),
        fonte: 'camera',
        tipo: tipo.toLowerCase(),
        titolo,
        descrizione: '',
        link,
        data: new Date(),
      });
    });
    console.log(`      → ${seen.size} atti di indirizzo`);
  } catch (e) {
    console.warn(`   ⚠ Atti di indirizzo: ${e.message}`);
  }

  console.log(`   ✅ Camera: ${items.length} elementi totali`);
  return items;
}

// ═══════════════════════════════════════════════════════
// SENATO — Feeds RSS (già funzionanti)
// ═══════════════════════════════════════════════════════

const SENATO_FEEDS = [
  { url: 'https://www.senato.it/web/rss.nsf/feedLavori.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/web/rss.nsf/feedComunicati.xml', tipo: 'comunicato' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19DDLAssemblea.xml', tipo: 'disegno di legge' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19DDLCommissioni.xml', tipo: 'commissione' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19DDL.xml', tipo: 'disegno di legge' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19Sedute.xml', tipo: 'seduta' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19Resoconti.xml', tipo: 'resoconto' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19OrdiniGiorno.xml', tipo: 'agenda' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19Mozioni.xml', tipo: 'mozione' },
  { url: 'https://www.senato.it/web/rss.nsf/feedLeg19Giunte.xml', tipo: 'commissione' },
];

async function fetchSenato() {
  const items = [];
  console.log('📥 Senato della Repubblica:');

  for (const feed of SENATO_FEEDS) {
    try {
      const res = await safeFetch(feed.url);
      const xml = await res.text();
      const parsed = await parseStringPromise(xml);
      const rssItems = parsed?.rss?.channel?.[0]?.item || [];
      rssItems.slice(0, 40).forEach(it => {
        const titolo = (it.title?.[0] || '').trim();
        const link = (it.link?.[0] || '').trim();
        const descr = (it.description?.[0] || '').trim();
        const pubDate = it.pubDate?.[0] || '';
        if (!titolo) return;
        items.push({
          id: makeId(`senato-${feed.tipo}`, link || titolo),
          fonte: 'senato',
          tipo: feed.tipo,
          titolo,
          descrizione: descr,
          link,
          data: pubDate ? new Date(pubDate) : null,
        });
      });
      console.log(`   ✓ ${feed.tipo} (${rssItems.length})`);
    } catch (e) {
      console.warn(`   ⚠ ${feed.tipo}: ${e.message}`);
    }
  }

  console.log(`   ✅ Senato: ${items.length} elementi totali`);
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
  console.log('─'.repeat(50));
  console.log(`💾 Salvataggio di ${items.length} elementi in Firestore...`);

  // Elimina vecchi documenti per evitare accumulo (tieni solo ultimi ~2000)
  let saved = 0;
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  items.forEach(item => {
    if (!item.id) return;
    const ref = db.collection('notizie').doc(item.id);
    batch.set(ref, {
      ...item,
      data: item.data || null,
      fetchedAt: now,
      timestamp: now,
    }, { merge: true });
    saved++;
  });

  await batch.commit();
  console.log(`✅ Salvati ${saved} elementi.`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

(async () => {
  try {
    const camera = await fetchCamera();
    const senato = await fetchSenato();
    const all = [...camera, ...senato];
    await saveItems(all);
    console.log('─'.repeat(50));
    console.log('✅ Completato!');
  } catch (err) {
    console.error('❌ Errore fatale:', err);
    process.exit(1);
  }
})();
