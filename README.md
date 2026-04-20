# 🏛️ Parlamento Italiano — Dashboard

Dashboard che raccoglie automaticamente i lavori di Camera dei Deputati e Senato della Repubblica, aggiornata 2 volte al giorno tramite GitHub Actions. Zero costi.

---

## Stack

| Componente | Strumento | Costo |
|---|---|---|
| Database | Firebase Firestore | **Gratis** (free tier) |
| Automazione dati | GitHub Actions | **Gratis** (repo pubblico) |
| Sito web | GitHub Pages | **Gratis** |
| Fonte Camera | dati.camera.it (API SPARQL ufficiale) | **Gratis** |
| Fonte Senato | RSS ufficiali senato.it | **Gratis** |

---

## Setup — Passo dopo passo

### 1. Crea il progetto Firebase

1. Vai su [console.firebase.google.com](https://console.firebase.google.com)
2. Crea un nuovo progetto (es. `parlamento-dashboard`)
3. Nella console del progetto → **Firestore Database** → Crea database
4. Scegli **Modalità produzione**
5. Scegli la region: `eur3 (europe-west)` (server europei)

### 2. Configura le regole Firestore

1. In Firestore → **Regole**
2. Sostituisci tutto con il contenuto del file `firestore.rules` di questa repo
3. Pubblica

### 3. Genera la Service Account per GitHub Actions

1. Firebase Console → **Impostazioni progetto** (icona ingranaggio) → **Account di servizio**
2. Clicca **Genera nuova chiave privata**
3. Scarica il file JSON — **conservalo in modo sicuro**

### 4. Aggiungi il segreto a GitHub

1. Vai nel tuo repo GitHub → **Settings** → **Secrets and variables** → **Actions**
2. Crea un nuovo segreto:
   - **Nome**: `FIREBASE_SERVICE_ACCOUNT`
   - **Valore**: incolla l'intero contenuto del file JSON scaricato al passo 3
3. Salva

### 5. Configura il sito web con la tua Firebase Config

1. Firebase Console → **Impostazioni progetto** → scorri fino a **Le tue app**
2. Clicca **</>** (Aggiungi app web) e registra l'app
3. Copia i valori di `firebaseConfig`
4. Apri `index.html` e sostituisci i valori nella sezione:

```javascript
const firebaseConfig = {
  apiKey:            "INSERISCI_API_KEY",        // ← il tuo valore
  authDomain:        "...",
  projectId:         "...",
  ...
};
```

### 6. Attiva GitHub Pages

1. Repo GitHub → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, cartella: `/ (root)`
4. Salva — il sito sarà live su `https://tuo-username.github.io/nome-repo/`

### 7. Primo fetch manuale (per popolare subito il database)

1. Repo GitHub → **Actions** → **Fetch Parliamentary Data**
2. Clicca **Run workflow** → **Run workflow**
3. Attendi ~1-2 minuti
4. Ricarica il sito: i dati appariranno

---

## Come funziona automaticamente

GitHub Actions esegue `scripts/fetch-data.js` alle **8:00 e alle 20:00** ora italiana, ogni giorno:

```
dati.camera.it (SPARQL) ──┐
                           ├──→ fetch-data.js ──→ Firebase Firestore ──→ index.html (GitHub Pages)
senato.it (RSS) ───────────┘
```

Non devi fare nulla: si aggiorna da solo.

---

## Fonti dati usate

### Camera dei Deputati
- **SPARQL endpoint**: `https://dati.camera.it/sparql`
- Raccoglie: sedute, atti, proposte, mozioni, interpellanze, interrogazioni, votazioni
- Finestra temporale: **ultimi 14 giorni**
- Documentazione: [dati.camera.it](https://dati.camera.it/)

### Senato della Repubblica
- **RSS comunicati**: `https://www.senato.it/application/xmanager/projects/leg_senato/attachments/rss/rss_comunicati.xml`
- **RSS commissioni**: `https://www.senato.it/rss/leg/rss_lavori_commissioni.xml`
- Raccoglie: comunicati stampa, lavori commissioni

> ⚠️ **Nota sugli URL RSS del Senato**: il Senato aggiorna periodicamente i propri feed RSS.
> Se i dati del Senato smettono di aggiornarsi, verifica gli URL attuali su
> [senato.it](https://www.senato.it) cercando il link RSS nella pagina. Aggiorna
> `scripts/fetch-data.js` di conseguenza.

---

## Struttura del progetto

```
parlamento-dashboard/
├── index.html                    ← Il sito (GitHub Pages)
├── firestore.rules               ← Regole di sicurezza Firestore
├── package.json                  ← Dipendenze Node.js
├── README.md                     ← Questa guida
├── scripts/
│   └── fetch-data.js             ← Script di raccolta dati
└── .github/
    └── workflows/
        └── fetch-data.yml        ← GitHub Actions (cron 2x/giorno)
```

## Struttura dati in Firestore

```
/notizie/{id}
  fonte:       'camera' | 'senato'
  tipo:        'seduta' | 'votazione' | 'atto' | 'legge' | 'comunicato' | ...
  titolo:      string
  data:        Timestamp
  link:        string (URL alla fonte ufficiale)
  descrizione: string (opzionale)
  fetchedAt:   Timestamp

/meta/status
  lastUpdated: Timestamp
  totalItems:  number
```

---

## Troubleshooting

**Il sito mostra "Connessione al database..." per sempre**
→ Verifica che la `firebaseConfig` in `index.html` sia corretta.

**GitHub Actions fallisce**
→ Vai su Actions → clicca sul run fallito → leggi i log. Spesso è la `FIREBASE_SERVICE_ACCOUNT` non configurata correttamente.

**Nessun dato da Camera**
→ Il SPARQL endpoint di Camera potrebbe essere temporaneamente offline. Aspetta il prossimo run automatico o verifica su [dati.camera.it](https://dati.camera.it).

**Nessun dato da Senato**
→ Verifica che gli URL RSS siano ancora validi. Il Senato li aggiorna periodicamente.
