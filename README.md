# Intesa — Configuratore di pagamento Sales

**Il piano di pagamento ottimale tra Bonifico, Klarna e Scalapay, in tempo reale.**

Intesa è una web-app (PWA) pensata per il consulente commerciale durante la
trattativa: inserisci prezzo, rate desiderate ed eventuali vincoli del cliente e
l'app trova all'istante la combinazione migliore tra i tre strumenti, con un
piano mensile chiaro da mostrare e da copiare.

Funziona **completamente offline**, senza server, senza database e senza
librerie esterne: solo HTML, CSS e JavaScript. È installabile su smartphone come
un'app nativa.

---

## Come si usa

1. **Prezzo del pacchetto** — l'importo da vendere (chip rapidi o digitazione).
2. **Rate desiderate** — su quanti mesi il cliente vuole distribuire.
3. **Disponibilità oggi** e **Max rata mensile** — facoltativi: i limiti del
   cliente. Se lasciati vuoti, non vincolano.
4. **Priorità** — l'obiettivo da massimizzare (default: **Massimizza VPL**):
   Massimizza VPL, Massimizza Incassato, Equilibrata, Rata costante, Min. bonifico.
   Ogni priorità mostra una breve descrizione (tooltip) del proprio obiettivo.

Il risultato si aggiorna **in tempo reale**: punteggio 0–100, spiegazione,
incassato/pagato oggi, dettaglio per strumento e piano mese per mese.
Con **Copia proposta** ottieni un testo pronto da inviare.

### Modalità Manuale Assistita

Attivabile dal pulsante **Manuale** in alto. Puoi modificare a mano qualunque
valore (acconto, importo/rate di Scalapay e Klarna): il sistema ricalcola gli
altri mantenendo la coerenza. Ogni campo ha un **lucchetto**:

- Modificare un campo lo **blocca** automaticamente.
- I campi bloccati restano fissi; l'algoritmo ottimizza **solo i rimanenti**.
- Tocca il lucchetto per liberare di nuovo un campo.

L'indicatore di validità aggiorna in tempo reale:

- 🟢 **valida** — rispetta i vincoli ed è vicina all'ottimo;
- 🟡 **valida ma migliorabile** — accettabile ma non ottimale, oppure al limite
  della tolleranza;
- 🔴 **non compatibile** — i valori bloccati non rispettano i vincoli.

---

## Pannello Amministratore

Icona a ingranaggio in alto a destra. Tutte le impostazioni si salvano sul
dispositivo (localStorage) e restano tra una sessione e l'altra.

- **Vincoli** — tolleranza sui vincoli del cliente.
- **Profili Provider** — un profilo per ogni strumento BNPL (vedi sotto): attivo,
  nome, rate massime, importo min/max, commissione (futuro) e la *Gestione Extra
  Prima Rata* a tre modalità.
- **Smart Rounding** — arrotondamento commerciale (vedi sotto).
- **Motore** — passo di ricerca (più fine = più preciso, leggermente più lento).
- **VPL — Valore per Lead** — i coefficienti della metrica (vedi sotto).

**Esporta / Importa configurazione** genera un file `intesa-config.json`: utile
per definire una configurazione aziendale e distribuirla a tutta la rete vendita
(ogni consulente la importa con un tocco). **Ripristina default** riporta tutto
ai valori iniziali.

---

## Il modello di calcolo

**Assunzione principale (modello standard BNPL).** Klarna e Scalapay
**anticipano subito** all'azienda l'intero importo finanziato; il cliente lo
restituisce a loro nelle rate previste. Quindi:

- **Incassato oggi dall'azienda** = acconto bonifico + importo Scalapay +
  importo Klarna.
- **Pagato oggi dal cliente** = acconto bonifico + prima rata Scalapay + prima
  rata Klarna (le rate iniziali dei BNPL sono al momento dell'acquisto).
- **Bonifico rateizzato** = credito concesso dall'azienda: il cliente lo paga
  nei **mesi successivi**, quindi non entra nell'incasso di oggi.

**Coerenza matematica.** La somma di tutti gli strumenti è sempre **esattamente**
uguale al prezzo. Il bonifico-credito viene distribuito con una tecnica di
*water-filling* sui mesi successivi al primo, riempiendo prima quelli più
scarichi: questo **appiattisce la rata mensile** del cliente e lascia oggi libero
per acconto e prime rate BNPL.

**Punteggio 0–100 = qualità.** Il numero mostrato nel gauge rappresenta
**esclusivamente la qualità** della soluzione. Combina più sotto-metriche
(uniformità della rata, liquidità immediata, uso degli strumenti, acconto
minimo, comfort rispetto ai tetti, quota di bonifico, VPL) con pesi che
dipendono dalla **priorità** scelta. I pesi sono modificabili nel codice
(`DEFAULT_WEIGHTS`) e **sommano sempre a 1**. La scala è **garantita per
costruzione**: ogni sotto-punteggio (VPL incluso) e il punteggio finale sono
"clampati" a [0,100], quindi il valore non può mai superare 100 in nessuna
configurazione.

> **Nota (V1, intenzionale).** Il **VPL è una metrica composita**: `calcVPL`
> combina venduto, incasso oggi, % liquidità, importo BNPL e credito bonifico.
> Alcune di queste grandezze compaiono anche come sotto-punteggi atomici
> (liquidità, strumenti, bonifico), quindi c'è una sovrapposizione voluta. Non
> viene deduplicata in V1: il VPL è l'indicatore commerciale di sintesi.

**Compatibilità (asse separato dal punteggio).** Accanto al gauge, un indicatore
dedicato dice se la proposta rispetta i **vincoli del cliente**:
**Compatibile** (entro i limiti), **Al limite** (entro la tolleranza ma oltre il
limite esatto — con il motivo, es. "picco rata 517 € oltre il max 500 €") o
**Non compatibile** (nessuna combinazione ammissibile). Punteggio e compatibilità
sono due assi distinti: una proposta può avere punteggio alto ma essere "al
limite", o punteggio più basso ed essere pienamente compatibile. In **modalità
manuale** compare inoltre, se serve, una nota **Ottimizzabile** che segnala che
in automatico si raggiungerebbe un punteggio più alto — informazione tenuta
separata dalla compatibilità.

### Le due priorità commerciali

- **Massimizza VPL** (default) — *privilegia l'incasso immediato dell'azienda.*
  Cerca la soluzione che fa incassare all'azienda il massimo possibile fin da
  subito (i BNPL anticipano l'intero importo), riduce il credito in bonifico e
  usa **prima Scalapay, poi Klarna**, anche a costo di una commissione personale
  inferiore per il consulente.
- **Massimizza Incassato** — *privilegia il bonifico per aumentare la commissione
  del consulente.* Aumenta la quota di bonifico quando possibile, cercando il
  miglior compromesso tra incasso del consulente, sostenibilità della proposta
  per il cliente e rispetto dei vincoli — senza forzare il massimo uso dei BNPL.

Le altre tre priorità (Equilibrata, Rata costante, Min. bonifico) restano
invariate.

### Preferenza tra provider (politica commerciale)

L'ordine dei provider nel Pannello Amministratore (↑/↓) è anche l'**ordine di
preferenza**: di default **Scalapay → Klarna → Provider personalizzato**. È usato
come **tie-break**: a parità di risultato (stesso piano e stesso punteggio) il
motore attribuisce l'importo al provider più preferito (Scalapay). Se invece
Klarna produce un punteggio più alto o permette di rispettare vincoli che
Scalapay non può soddisfare (massimali, numero di rate), il motore sceglie
comunque Klarna: la preferenza non riduce mai la qualità della soluzione.

### VPL — Valore per Lead

Nel contesto aziendale la **VPL è una metrica commerciale interna**, *non* un
valore finanziario. In Intesa è una **somma pesata** completamente configurabile
dal Pannello Amministratore, senza toccare il codice:

```
VPL = Base
    + (× Totale venduto)   · totale venduto
    + (× Incassato oggi)   · incassato oggi
    + (× % liquidità oggi) · percentuale incassata oggi (0–100)
    + (× Importo BNPL)     · importo su Klarna + Scalapay
    + (× Credito bonifico) · bonifico rateizzato (di norma coefficiente negativo)
```

Modifica i coefficienti per riflettere le regole della tua azienda: ad esempio
alza *× Incassato oggi* se dai molto valore alla liquidità immediata, o rendi più
negativo *× Credito bonifico* se il credito concesso "costa" al lead.

### Smart Rounding

Trovata la soluzione ottima, gli importi vengono arrotondati a valori
**facili da comunicare** (multipli di 50, 100 o 250 €, configurabili), evitando
cifre come 987 € o 2.143 €. Il residuo confluisce nel bonifico così che il
**totale resti esatto**. Se l'arrotondamento violasse un vincolo o si
discostasse troppo (oltre la soglia impostata), l'app mantiene gli importi
esatti.

### Commercial Rounding (rate del bonifico)

Logica **separata** dallo Smart Rounding, pensata per la comunicazione in
trattativa: arrotonda le **rate del bonifico** a cifre semplici da dire al
cliente (es. `235 • 235 • 730` invece di `233,33 • 233,33 • …`). Configurabile
dal Pannello Amministratore:

- **Arrotondamento**: nessuno, all'euro, ai 5 €, ai 10 €, ai 50 €, oppure
  personalizzato.
- **Compensazione**: la differenza generata dagli arrotondamenti confluisce
  automaticamente su **una** rata — l'**ultima** (default) o la **prima** — così
  il **totale del bonifico resta invariato** e il piano resta coerente.

Agisce solo sulla presentazione (dopo ottimizzazione e Smart Rounding), non
sull'algoritmo. Nella scheda **Bonifico** compare anche il riepilogo delle rate
(`Rate: 235 € • 235 € • 730 €`), pronto da comunicare senza leggere la tabella.

### Profili Provider

Il motore **non conosce** Scalapay o Klarna: legge sempre le regole di un
**profilo provider**. Questo rende l'architettura estendibile senza toccare
l'algoritmo — se cambiano le condizioni commerciali o arriva un nuovo provider
BNPL, basta creare o modificare un profilo.

Ogni profilo definisce: **attivo/disattivo**, **nome**, **rate massime**,
**importo minimo/massimo finanziabile**, **commissione** (predisposta, non usata
in v1) e la **Gestione Extra Prima Rata**. La v1 include Scalapay, Klarna e un
**Provider personalizzato** (disattivo di default). Attivando un terzo provider
il motore lo considera automaticamente nell'ottimizzazione.

### Gestione Extra Prima Rata

Per ogni provider è configurabile come trattare l'eventuale maggiorazione della
prima rata, con tre modalità:

1. **Redistribuisci** (default) — la prima rata sale e le successive scendono:
   l'importo **totale finanziato resta invariato**.
2. **Costo aggiuntivo** — l'extra è un costo a carico del cliente sulla prima
   rata e **non modifica la ripartizione** del finanziato (il "totale venduto"
   resta identico; cambia solo quanto il cliente paga complessivamente).
3. **Manuale** — l'amministratore definisce liberamente l'extra come **importo €
   o percentuale**, e sceglie se **redistribuirlo** o trattarlo come **costo**.

Con il valore extra a 0 (default) le tre modalità coincidono e non alterano
nulla: è così che la configurazione di default riproduce esattamente i risultati
della versione precedente.

---

## Pubblicazione su GitHub Pages

1. Crea un repository e caricaci **tutti** questi file mantenendo la struttura:

   ```
   index.html
   style.css
   app.js
   manifest.json
   service-worker.js
   icons/  (le 4 immagini)
   ```

2. Su GitHub: **Settings → Pages → Build and deployment**, sorgente *Deploy from
   a branch*, ramo `main`, cartella `/ (root)`. Salva.
3. Dopo qualche minuto l'app è online su
   `https://<utente>.github.io/<nome-repo>/`.

Tutti i percorsi sono **relativi** (`./`): l'app funziona anche in una
sottocartella senza modifiche. Il service worker usa la strategia
**"prima la rete, poi la cache"**: quando sei online prende sempre la versione
aggiornata (e rinfresca la cache), quando sei offline usa l'ultima salvata.

> **Aggiornamenti automatici.** Dopo aver ricaricato i file su GitHub non devi
> cambiare nulla: alla prossima apertura online l'app mostra la versione nuova.
> Nota: la *primissima* volta che sostituisci il service worker può servire una
> ricarica in più perché il browser adotti la nuova strategia; da lì in poi è
> automatico.

---

## Personalizzazione

**Rinominare l'app (rebrand).** Il nome "Intesa" compare in: `index.html`
(intestazione e `<title>`), `manifest.json` (`name`/`short_name`) e nel testo
della proposta in `app.js`. Sostituiscilo ovunque. Le **icone** sono in `icons/`:
rimpiazza i PNG mantenendo nomi e dimensioni (192, 512, maskable 512, favicon).

**Colori.** Sono definiti come variabili CSS in cima a `style.css` (`:root`):
cambia `--emerald`, `--ink`, ecc. per ridefinire l'identità visiva.

**Extra prima rata.** Non richiede più modifiche al codice: si configura per ogni
provider dal Pannello Amministratore (sezione *Gestione Extra Prima Rata*), con le
tre modalità Redistribuisci / Costo aggiuntivo / Manuale descritte sopra.

**Aggiungere un nuovo provider BNPL.** Attiva e rinomina il *Provider
personalizzato* nell'Admin, impostandone rate, importi ed extra. Per averne più di
tre, aggiungi un altro oggetto all'array `providers` in `DEFAULT_CONFIG` (dentro
`app.js`) con un `id` univoco e un `colore`; l'algoritmo lo userà senza altre
modifiche.

**Commissioni merchant (futuro).** Ogni profilo ha già il campo `commissione`
(disattivato di fatto, valore 0). Per attivarle andrà aggiunto il calcolo del
costo azienda nelle metriche/`calcVPL`; oggi non incidono, in linea con
l'obiettivo di supportare la trattativa e non l'analisi contabile.

---

## Architettura & Roadmap

La V1 è congelata a livello di comportamento, ma la base è predisposta per le
evoluzioni future. I punti chiave:

**Ricerca e scoring separati.** L'algoritmo di ricerca (`optimize` → enumera le
combinazioni ammissibili) e il sistema di punteggio (`rankCandidates` → VPL,
sotto-punteggi, pesi) sono due sezioni indipendenti in `app.js`. La ricerca
conosce solo la *fattibilità* (`isHardValid`) e produce candidati con le loro
metriche; lo scoring li valuta. **Per cambiare interamente il punteggio** (nuove
metriche, commissioni, regole aziendali) si modifica solo la sezione SCORING:
l'algoritmo di ricerca non va toccato.

**Live Call (futura).** Non implementata. L'app espone un'API pubblica
`window.IntesaApp` con `setInput({ dispOggi, maxMensile, nRate, ... })`: un futuro
pannello con slider dovrà solo chiamare questo metodo e ascoltare `onResult(cb)`.
Il ricalcolo in tempo reale è già quello attuale — **il motore non cambia**.

**Salvataggio Trattative (futuro).** Non implementato. È predisposto il modulo
`IntesaApp.Deals` (CRUD su `localStorage`) con schema modulare: cliente, data,
prezzo, input, priorità, modalità, soluzione, note e **stato** (bozza / in corso
/ chiusa / annullata). Ogni trattativa salva uno **snapshot completo della
configurazione** usata più i suoi **metadati** (`version`, `id` = impronta delle
regole, `createdAt`), così potrà essere riaperta con le stesse regole aziendali
anche se nel frattempo saranno cambiate. `IntesaApp.Deals.buildFromCurrent()`
costruisce una trattativa dallo stato corrente.

Tutte queste predisposizioni sono **inerti**: non alterano il comportamento della
V1 e non aggiungono nulla di visibile all'utente finale.

---

## Struttura dei file

| File | Ruolo |
|------|-------|
| `index.html` | Struttura dell'interfaccia |
| `style.css` | Stile (token di design, layout mobile-first) |
| `app.js` | Motore di ottimizzazione + logica dell'interfaccia |
| `manifest.json` | Metadati PWA (nome, icone, colori) |
| `service-worker.js` | Cache offline |
| `icons/` | Icone dell'app |

Nessuna dipendenza esterna. Nessun dato lascia il dispositivo.
