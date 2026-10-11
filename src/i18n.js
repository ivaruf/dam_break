// i18n.js — which language the dam speaks, and every word it says.
//
// Two languages, bokmål first (hub CLAUDE.md §2, "Two languages, Norwegian
// first"). With nothing valid stored the game speaks Norwegian WHATEVER the
// browser prefers — no navigator.language sniffing; an English speaker is one
// tap away, on the language row in the sound panel or the pause menu.
//
// THE CHOICE IS THE HUB'S, NOT THIS CABINET'S. It lives under the one key every
// arcade game shares, 'arcade.lang.v1', holding "nb" or "en" and nothing else,
// so a player who picked English in another game arrives here in English. That
// key can never be renamed and never carry anything else (§6).
//
// HOW A SWITCH REACHES THE SCREEN. setLang() stores, sets <html lang>, repaints
// every [data-i18n] / [data-i18n-label] in the page, then dispatches
// 'arcade:lang' on document. Everything that builds text at runtime listens
// for that: screens.js rebuilds whichever screen is up, hud.js forgets its
// cached strings so the next frame rewrites them, and the canvas labels in
// renderer.js call t() every frame anyway. Nothing reloads, nothing restarts,
// nothing unpauses — a language must not cost a run any more than a deploy may.
// src/ui/screen.js imports nothing and keeps its own two-word table.
//
// WHAT STAYS ENGLISH ON PURPOSE: the game's name, console output, storage keys,
// and the cause line modes.js writes into the stats as `cause`. That line is an
// identifier the tests and the level checks match on (OVERTOP, BREACH…); it is
// rendered from this table in English by tFor('en', …), and the screen shows
// `causeMsg` — the same key and arguments — in the player's language instead.
// Level and material English lives in their own data files; this table holds
// only the bokmål for those (tOr below falls back to the data).
//
// Must load cleanly under node: tests/build.test.js imports modes.js with no
// document and no localStorage at all, so every touch of either is guarded.

const KEY = 'arcade.lang.v1';
const LANGS = ['nb', 'en'];

function initial() {
  try {
    const saved = globalThis.localStorage && globalThis.localStorage.getItem(KEY);
    if (saved === 'nb' || saved === 'en') return saved;
  } catch { /* private mode: fall through to the default */ }
  return 'nb';
}

let lang = initial();
const doc = typeof document !== 'undefined' ? document : null;
if (doc && doc.documentElement) doc.documentElement.lang = lang;

export const getLang = () => lang;

/** "nb-NO" / "en-GB", for anything that ever wants Intl. Nothing does today. */
export const locale = () => (lang === 'nb' ? 'nb-NO' : 'en-GB');

export function setLang(next) {
  if (LANGS.indexOf(next) < 0 || next === lang) return;
  lang = next;
  try { globalThis.localStorage && globalThis.localStorage.setItem(KEY, lang); }
  catch { /* not remembered; this visit still switches */ }
  if (!doc) return;
  if (doc.documentElement) doc.documentElement.lang = lang;
  paintStatic(doc);
  if (typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    doc.dispatchEvent(new CustomEvent('arcade:lang', { detail: lang }));
  }
}

// ---- lookup -----------------------------------------------------------------

const warned = new Set();
function warn(key) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('DAM BREAK: no ' + lang + ' text for "' + key + '"; falling back.');
}

function lookup(l, key) {
  const table = STRINGS[l];
  return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function run(v, args) { return typeof v === 'function' ? v(...args) : v; }

/** The current language, else English, else the key itself. */
export function t(key, ...args) {
  return tFor(lang, key, ...args);
}

/** A specific language, with the same fallback. modes.js writes the English
 *  cause identifier through this. */
export function tFor(l, key, ...args) {
  let v = lookup(l, key);
  if (v === undefined) {
    warn(key);
    v = lookup('en', key);
    if (v === undefined) return key;
  }
  return run(v, args);
}

/** For content whose English lives in the game's own data (level names, hints):
 *  bokmål from this table, English — or a missing bokmål line — from the data. */
export function tOr(key, english) {
  if (lang === 'en') return english;
  const v = lookup(lang, key);
  if (v === undefined) { warn(key); return english; }
  return v;
}

/** Every [data-i18n] gets its words; [data-i18n-label] its aria-label, and its
 *  title too unless [data-i18n-title] names a different (longer) one. */
export function paintStatic(root = doc) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-label]')) {
    const words = t(n.dataset.i18nLabel);
    n.setAttribute('aria-label', words);
    if (!n.dataset.i18nTitle) n.title = words;
  }
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
}

// ---- the words ----------------------------------------------------------------

// Bokmål numbers for "Seksten daler." — the level-select line spells its count.
const NB_NUM = ['Ingen', 'Én', 'To', 'Tre', 'Fire', 'Fem', 'Seks', 'Sju', 'Åtte',
  'Ni', 'Ti', 'Elleve', 'Tolv', 'Tretten', 'Fjorten', 'Femten', 'Seksten',
  'Sytten', 'Atten', 'Nitten', 'Tjue'];
const EN_NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
  'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];

const f1 = (v) => Number(v || 0).toFixed(1);
const f2 = (v) => Number(v || 0).toFixed(2);

const MAT_EN = { timber: 'TIMBER', steel: 'STEEL', concrete: 'CONCRETE', cable: 'CABLE' };
const MAT_NB = { timber: 'TRE', steel: 'STÅL', concrete: 'BETONG', cable: 'KABEL' };

// Where in the dam a member broke. English keeps its old "LOWER LEFT TIMBER";
// bokmål puts the material first, the way it would be said: "TRE NEDE TIL VENSTRE".
const VERT_EN = { lower: 'LOWER', mid: 'MID', upper: 'UPPER' };
const HORIZ_EN = { left: 'LEFT', centre: 'CENTRE', right: 'RIGHT' };
const VERT_NB = { lower: 'NEDE', mid: 'MIDT PÅ', upper: 'OPPE' };
const HORIZ_NB = { left: 'TIL VENSTRE', centre: 'I MIDTEN', right: 'TIL HØYRE' };

function whereEn(where, mat) {
  const m = MAT_EN[mat] || 'MEMBER';
  return where ? `${VERT_EN[where.vert]} ${HORIZ_EN[where.horiz]} ${m}` : m;
}
function whereNb(where, mat) {
  const m = MAT_NB[mat] || 'BJELKE';
  if (!where) return m;
  if (where.vert === 'mid' && where.horiz === 'centre') return `${m} I MIDTEN`;
  return `${m} ${VERT_NB[where.vert]} ${HORIZ_NB[where.horiz]}`;
}

const STRINGS = {
  nb: {
    // ---- shared menu words (the hub glossary, in this game's caps) ----
    'menu.back': 'TILBAKE',
    'menu.lang': 'SPRÅK',
    'menu.langGroup': 'Språk',
    // The way out is in sentence case and carries no glyph in its words — the
    // back arrow is an SVG in the button (hub §2, "One button").
    'exit.arcade': 'Tilbake til arkaden',
    'exit.close': 'Lukk',
    'exit.refused': 'Lukk fanen selv',
    'update.ready': '⬆ NY VERSJON KLAR',

    // ---- title ----
    'title.tagline': 'Når vannet kommer — holder demningen din?',
    'title.play': '▶ SPILL',
    'title.sandbox': '⚒ SANDKASSE',
    'title.hint': 'Dra for å bygge · knip eller rull for å zoome · mellomrom slipper flommen',

    // ---- level select ----
    'levels.title': 'VELG NIVÅ',
    'levels.progress': (done, total) => `${done} av ${total} demninger står`,
    'levels.intro': (total) => `${NB_NUM[total] !== undefined ? NB_NUM[total] : total} daler. Én elv som stiger.`,
    'levels.locked': 'LÅST',
    'levels.level': (n) => `Nivå ${n}`,
    'levels.sandbox': 'Sandkasse',
    'levels.best': (cost) => `REKORD ${cost}`,
    'levels.unlockHint': (n) => `Klar nivå ${n} for å åpne dette.`,
    'levels.ariaLocked': ' — låst',
    'levels.ariaBest': (cost) => ` — rekord ${cost}`,
    'badge.sandbox': 'SANDKASSE',
    'badge.countdown': 'NEDTELLING',
    'badge.freebuild': 'FRITT BYGG',

    // ---- the menu panel's sound rows ----
    'sound.music': 'MUSIKK',
    'sound.sfx': 'EFFEKTER',
    'sound.note': '⚠ DAM BREAK er helt stille ennå. Nivåene lagres likevel, så når vannet får en stemme, kommer den på nivået du valgte.',

    // ---- corner + HUD chrome ----
    'corner.mute': 'Slå av lyden',
    'corner.unmute': 'Slå på lyden',
    'hud.menu': 'Meny',
    'menu.settings': 'INNSTILLINGER',
    'pause.title': 'PAUSE',
    'pause.resume': '▶ FORTSETT',
    'hud.floodArrives': 'FLOMMEN KOMMER',
    'hud.leftOf': 'IGJEN AV',
    'hud.peakLoad': 'MAKS LAST',
    'hud.held': 'HOLDT',
    'tool.build': 'Bygg bjelker',
    'tool.buildTitle': 'Bygg bjelker — dra mellom ankerpunktene',
    'tool.erase': 'Visk ut',
    'tool.eraseTitle': 'Visk ut — dra over bjelker for å fjerne dem (E)',
    'tool.box': 'Slett med boks',
    'tool.boxTitle': 'Slett med boks — dra en boks over en del for å fjerne den (X)',
    'tool.undo': 'Angre',
    'tool.undoTitle': 'Angre (Z)',
    'tool.redo': 'Gjør om',
    'tool.redoTitle': 'Gjør om (Y)',
    'tool.clear': 'Fjern hele demningen',
    'tool.zone': 'Zoom inn på byggeområdet',
    'tool.zoneTitle': 'Zoom inn på byggeområdet — så rutene blir større enn fingeren din',
    'hud.release': '⚠ SLIPP VANNET',
    'sim.pause': 'Pause',
    'sim.retry': 'Prøv igjen',
    'sim.retryTitle': 'Prøv igjen (R)',
    'sim.edit': 'Endre demningen',
    'hud.armed': 'Trykk hvor som helst i den lyse sirkelen for å bygge bjelken',
    'mat.head': (m) => `~${m} m vann`,
    'mat.headTitle': (m) => ` Tåler omtrent ${m} m vann.`,
    'mat.timber.name': 'Tre',
    'mat.timber.blurb': 'Billig og lett. Bøyer seg, så brekker det.',
    'mat.steel.name': 'Stål',
    'mat.steel.blurb': 'Stivt og sterkt, sterkest når det blir dratt i. Dyrt.',
    'mat.concrete.name': 'Betong',
    'mat.concrete.blurb': 'Tåler enormt trykk. Sprekker hvis den blir dratt i. Veldig tung.',
    'mat.cable.name': 'Kabel',
    'mat.cable.blurb': 'Kan bare dra. Lang og lett, tetter ingenting.',

    // ---- toasts + canvas ----
    'toast.held': 'DEMNINGEN HOLDT',
    'toast.failed': 'DEMNINGEN BRAST',
    'toast.breach': 'LEKKASJE',
    'toast.overtop': 'VANNET RENNER OVER',
    'canvas.protect': 'BESKYTT',
    'canvas.zone': 'BYGGEOMRÅDE',
    'canvas.delete': (n) => (n === 1 ? 'SLETT 1 BJELKE' : `SLETT ${n} BJELKER`),

    // ---- refusal reasons (builder/snapping ids → words) ----
    'reason.too short': 'for kort',
    'reason.too long': 'for lang',
    'reason.outside build zone': 'utenfor byggeområdet',
    'reason.underground': 'under bakken',
    'reason.through the ground': 'gjennom bakken',
    'reason.no material': 'velg et materiale',
    'reason.not available here': 'ikke lov her',
    'reason.same point': 'samme punkt',
    'reason.already built': 'allerede bygd',
    'reason.overlaps a member': 'ligger oppå en bjelke',
    'reason.over budget': 'for dyrt',
    'reason.another joint there': 'det er et ledd der fra før',

    // ---- objectives ----
    'obj.retain': (p, d) => `HOLD ${p}% I ${d} s`,
    'obj.protect': (m, d) => `HOLD VANNET NEDENFOR UNDER ${m} m I ${d} s`,
    'obj.survive': (d) => `HOLD UT I ${d} s`,

    // ---- tutorial ----
    'tut.step': (n, of) => `STEG ${n} AV ${of}`,
    'tut.skip': 'HOPP OVER',
    'tut.next': 'SKJØNNER →',
    'tut.last': 'BYGG →',
    'tut.0.title': 'Trykk på et ankerpunkt, så inni sirkelen',
    'tut.0.text': 'Hver bjelke starter på et gult ankerpunkt eller et ledd du allerede har bygd. ' +
      'Trykk på ett, så dukker det opp en sirkel: alt som lyser inni den, kan bjelken nå. ' +
      'Trykk et sted som lyser, så er bjelken bygd. To trykk, hver gang — vil du bygge videre, ' +
      'trykker du på leddet du nettopp laget. (Å dra gjør det samme i én bevegelse.) ' +
      'Mørkt betyr at bakken eller området er i veien; oransje betyr at du ikke har råd til å gå så langt. ' +
      '⤢-knappen zoomer inn på byggeplassen.',
    'tut.1.title': 'Trekanter holder, firkanter faller sammen',
    'tut.1.text': 'Velg et materiale nedenfor (eller trykk 1–4). Hver bjelke koster lengden × prisen ' +
      'per meter. Stiv av muren med skråstag — en firkantet ramme bare velter.',
    'tut.2.title': 'Så slipper du vannet',
    'tut.2.text': 'Trykk SLIPP VANNET når du er klar. Følg med på bjelkene: kald blå betyr at de blir ' +
      'dratt i, varm oransje betyr at de blir klemt. Blinker de med sprekker, er de i ferd med å ryke.',

    // ---- result ----
    'result.held': 'DEMNINGEN HOLDT',
    'result.failed': 'DEMNINGEN BRAST',
    'result.newBest': (cost) => `Ny rekordpris: ${cost}.`,
    'result.unlocked': (name) => `Låst opp: ${name}.`,
    'result.retry': '↻ PRØV IGJEN',
    'result.edit': '✎ ENDRE',
    'result.next': 'NESTE NIVÅ →',
    'result.nextNamed': (name) => `NESTE: ${name} →`,
    'result.levels': 'NIVÅER',
    'stat.retained': 'Vann holdt igjen',
    'stat.needed': 'Måtte holde igjen',
    'stat.depth': 'Største dybde i magasinet',
    'stat.stress': 'Største belastning',
    'stat.broken': 'Bjelker som røk',
    'stat.cost': 'Byggekostnad',
    'stat.time': 'Tid den holdt',

    // ---- cause lines (the big amber line on a failed result) ----
    'cause.overtop': 'RANT OVER — VANNET STEG OVER TOPPEN',
    'cause.breach': 'LEKK — VANNET FANT EN VEI GJENNOM',
    'cause.nothing': 'INGENTING BLE BYGD — VANNET BARE RANT FORBI',
    'cause.slid': 'PENGENE VAR IKKE PROBLEMET — DEMNINGEN GLED UNNA',
    'cause.limit': (where, mat, mode, time) =>
      `${whereNb(where, mat)} — ${mode === 'tension' ? 'DRATT I STYKKER' : 'KLEMT I STYKKER'} etter ${f1(time)} s`,
    'cause.retained': (got, need) => `BARE ${got}% HOLDT IGJEN — ${need}% TRENGTES`,
    'cause.sustained': (load, held) => `GA ETTER FOR LANGVARIG PRESS — HOLDT PÅ ${load}% I ${held} s`,
    'cause.bending': (len, mat, depth, time) => {
      const m = MAT_NB[mat] || '';
      const what = len > 0 ? `${f1(len)} m LANGT SPENN${m ? ' AV ' + m : ''}`
        : (m ? `ET SPENN AV ${m}` : 'ET SPENN UTEN STØTTE');
      const d = depth > 0.1 ? `${f1(depth)} m VANN` : 'DYPT VANN';
      return `KNEKTE PÅ MIDTEN — ${what} UNDER ${d} etter ${f1(time)} s`;
    },
    'cause.collapse': (broken, total) => `ALT RAST SAMMEN — ${broken} AV ${total} BJELKER RØK`,
    'cause.flooded': (depth) => `FLOM NEDENFOR — ${f2(depth)} m VANN DER DET SKULLE VÆRE TØRT`,

    // ---- coaching under it, keyed like the cause ----
    'coach.overtop': 'Vannet steg over toppen. Bygg høyere, eller gi vannet et overløp.',
    'coach.breach': 'Vannet fant et hull. Bjelkene som skal holde tett, må nå helt bort til hverandre — kabler tetter ingenting.',
    'coach.sustained': 'Den holdt helt på grensen — langvarig press spiser svakt materiale. Bygg med mer margin, eller lag den våte siden av noe sterkere.',
    'coach.bending': 'Lange spenn knekker på midten — sett en pilar under fronten, eller bruk stål.',
    'coach.tension': 'Noe ble dratt i stykker. Stål og kabel er sterkest når de blir dratt i.',
    'coach.compression': 'Noe ble klemt i stykker. Gjør spennet kortere eller stiv det av — lange bjelker knekker.',
    'coach.collapse': 'Én bjelke røk og tok resten med seg. Lag trekanter, så ingen enkelt bjelke bærer alt.',
    'coach.slid': 'Hele demningen flyttet seg. Fest den til ankerpunkter på begge sider.',
    'coach.nothing': 'Trykk på et ankerpunkt, og så inni sirkelen, for å sette den første bjelken.',
    'coach.retained': 'Nesten. Tett lekkasjene og bygg toppen litt høyere.',
    'coach.flooded': 'Landsbyen fikk vann. Led vannet som renner over, bort fra den.',

    // ---- levels: bokmål only; English is the level data itself (tOr) ----
    'lvl.level-01.name': 'Den første bekken',
    'lvl.level-01.sub': 'Bygg en liten mur. Hold igjen bekken.',
    'lvl.level-01.hint0': 'Dra mellom ankerpunktene for å bygge. Trekanter står støtt — et tomt rektangel vil velte.',
    'lvl.level-02.name': 'Strømmen stiger',
    'lvl.level-02.sub': 'Bredere vann trenger avstivede trekanter, ikke bare stolper.',
    'lvl.level-02.hint0': 'Skråstag hindrer muren i å vri seg sidelengs.',
    'lvl.level-02.hint1': 'Lag trekanter i hvert felt — du kan bruke stål hvis tre ikke holder alene.',
    'lvl.level-03.name': 'Under press',
    'lvl.level-03.sub': 'Dypt vann, og en terskel som er for lang til å nå over i ett stykke.',
    'lvl.level-03.hint0': 'Ingenting du har, rekker over denne terskelen i ett stykke — sett en søyle ned på bunnen.',
    'lvl.level-03.hint1': 'Betong tåler enormt trykk: stable den til søyler, og stiv av med stål.',
    'lvl.level-04.name': 'Dårlig grunn',
    'lvl.level-04.sub': 'Den rette linjen rekker ikke. Sett søyler imellom.',
    'lvl.level-04.hint0': 'Gapet mellom breddene er for bredt for noe som også kan holde på vann.',
    'lvl.level-04.hint1': 'Sett to søyler på terskelen mellom dem, og legg tverrbjelker over de korte feltene.',
    'lvl.level-05.name': 'Bølgen',
    'lvl.level-05.sub': 'Et vannmagasin venter på hylla ovenfor. Det faller når du sier fra.',
    'lvl.level-05.hint0': 'Straks du slipper, faller vannet ned fra hylla — bygg for smellet, ikke bare for dybden.',
    'lvl.level-05.hint1': 'Et plutselig smell er ikke det samme som dypt vann. Stål tåler et slag; tre sprekker.',
    'lvl.level-06.name': 'Bredt vann',
    'lvl.level-06.sub': 'En lang, flat kryssing med lite penger.',
    'lvl.level-06.hint0': 'To lange terskler, to pilarer. Stål til tverrbjelkene — det er det eneste som rekker.',
    'lvl.level-06.hint1': 'Et skråstag blir bare dratt i. Kabel tåler det for en brøkdel av prisen på stål.',
    'lvl.level-07.name': 'To trinn',
    'lvl.level-07.sub': 'Bakken går opp et trinn midtveis. Bruk det.',
    'lvl.level-07.hint0': 'Hylla midtveis er ikke bare pynt — en mur som starter der, trenger mye mindre høyde.',
    'lvl.level-07.hint1': 'Ankerpunktene sitter i to høyder: bygg fra det som gir den billigste muren.',
    'lvl.level-08.name': 'Plutselig flom',
    'lvl.level-08.sub': 'En voldsom flom, alt på én gang. Muren din tar den rett i fleisen.',
    'lvl.level-08.hint0': 'Du kjenner formen nå: pilar på bunnen, tverrbjelker over, stiv av.',
    'lvl.level-08.hint1': 'Gjør fronten vanntett, og stiv den så av — denne flommen straffer hvert hull.',
    'lvl.level-09.name': 'Overløp',
    'lvl.level-09.sub': 'La elva få litt. Redd landsbyen.',
    'lvl.level-09.hint0': 'Du trenger ikke holde på hver dråpe — søkket rett nedenfor kan ta imot det som renner over.',
    'lvl.level-09.hint1': 'Bygg passe høyt, ikke så høyt du har råd til.',
    'lvl.level-10.name': 'Den store',
    'lvl.level-10.sub': 'Alt du har lært, i full størrelse.',
    'lvl.level-10.hint0': 'To terskler, to pilarer, betongsøyler, avstivning i stål — alt du har lært.',
    'lvl.level-10.hint1': 'Bind de ytterste søylene til toppen på motsatt side med kabel, så demningen ikke kan vri seg.',
    'lvl.patch-job.name': 'Lappejobb',
    'lvl.patch-job.sub': 'Noen bygde dette for lenge siden. Få det til å holde én flom til.',
    'lvl.patch-job.hint0': 'Rammen er god. Det som mangler: plankene langs bunnen, én tverrbjelke og alle skråstagene.',
    'lvl.patch-job.hint1': 'Se hvor det ryker første gang, og fiks akkurat det. Du får pengene tilbake når du sletter, hvis du heller vil begynne på nytt.',
    'lvl.quarry.name': 'Steinbruddet',
    'lvl.quarry.sub': 'Ingen trær på dette fjellet. Stein presser, tau drar.',
    'lvl.quarry.hint0': 'Betong rekker høyst 3 m — her må du ha en pilar på bunnen.',
    'lvl.quarry.hint1': 'Et skråstag blir bare dratt i, og tau tåler det for en brøkdel av prisen på stein.',
    'lvl.aftershock.name': 'Etterskjelv',
    'lvl.aftershock.sub': 'To flombølger. Å holde den første er ikke det samme som å holde begge.',
    'lvl.aftershock.hint0': 'Den andre bølgen er større enn den første. Bygg for vannet som kommer, ikke vannet du ser.',
    'lvl.aftershock.hint1': 'En bjelke som holder på 90% holder ikke — den blir spist opp. Gi rammen god margin.',
    'lvl.longwall.name': 'Den lange muren',
    'lvl.longwall.sub': 'Tre gap. Én mur. Den bredeste kryssingen hittil.',
    'lvl.longwall.hint0': 'Hvert gap er bredere enn stål rekker. En pilar i hver dump, og så tverrbjelker over feltene.',
    'lvl.longwall.hint1': 'Tjuesju meter front. Regn ut hva ett felt koster før du bygger seks.',
    'lvl.staircase.name': 'Trappa',
    'lvl.staircase.sub': 'Dalen går ned i trinn mot en port. Demm den opp nederst.',
    'lvl.staircase.hint0': 'Trinnene er ikke byggeplassen — de er bunnen av magasinet. Porten nederst er der du bygger.',
    'lvl.staircase.hint1': 'Sju meter vann. Smale felt tåler det; brede ligger på grensen og gir etter litt etter litt.',
    'lvl.highwater.name': 'Høyvann',
    'lvl.highwater.sub': 'Dalen fylles i ett minutt. Hold vannet i nitti sekunder.',
    'lvl.highwater.hint0': 'Brede felt tar mer vann og ligger nærmere grensen. På dette dypet betyr margin flere pilarer.',
    'lvl.highwater.hint1': 'Nitti sekunder er lenge nok til at slitasjen gjør ferdig det flommen startet. Bygg med god margin.',
    'lvl.sandbox.name': 'Sandkasse',
    'lvl.sandbox.sub': 'Ingen regler. Ingen budsjettgrense. Bare vann.',
  },

  en: {
    'menu.back': 'BACK',
    'menu.lang': 'LANGUAGE',
    'menu.langGroup': 'Language',
    'exit.arcade': 'Back to arcade',
    'exit.close': 'Close',
    'exit.refused': 'Close this tab yourself',
    'update.ready': '⬆ UPDATE READY',

    'title.tagline': 'When the water arrives — will your dam hold?',
    'title.play': '▶ PLAY',
    'title.sandbox': '⚒ SANDBOX',
    'title.hint': 'Drag to build · pinch or wheel to zoom · Space to release the flood',

    'levels.title': 'SELECT LEVEL',
    'levels.progress': (done, total) => `${done} of ${total} dams standing`,
    'levels.intro': (total) => `${EN_NUM[total] !== undefined ? EN_NUM[total] : total} valleys. One rising river.`,
    'levels.locked': 'LOCKED',
    'levels.level': (n) => `Level ${n}`,
    'levels.sandbox': 'Sandbox',
    'levels.best': (cost) => `BEST ${cost}`,
    'levels.unlockHint': (n) => `Clear level ${n} to open this one.`,
    'levels.ariaLocked': ' — locked',
    'levels.ariaBest': (cost) => ` — best ${cost}`,
    'badge.sandbox': 'SANDBOX',
    'badge.countdown': 'COUNTDOWN',
    'badge.freebuild': 'FREE BUILD',

    'sound.music': 'MUSIC',
    'sound.sfx': 'EFFECTS',
    'sound.note': '⚠ DAM BREAK is silent for now. The levels are saved anyway, so when the water gets a voice it arrives at the level you chose.',

    'corner.mute': 'Mute',
    'corner.unmute': 'Unmute',
    'hud.menu': 'Menu',
    'menu.settings': 'SETTINGS',
    'pause.title': 'PAUSED',
    'pause.resume': '▶ RESUME',
    'hud.floodArrives': 'FLOOD ARRIVES',
    'hud.leftOf': 'LEFT OF',
    'hud.peakLoad': 'PEAK LOAD',
    'hud.held': 'HELD',
    'tool.build': 'Build beams',
    'tool.buildTitle': 'Build beams — drag between anchors',
    'tool.erase': 'Erase',
    'tool.eraseTitle': 'Erase — drag across beams to delete them (E)',
    'tool.box': 'Box delete',
    'tool.boxTitle': 'Box delete — drag a box over a section to delete it (X)',
    'tool.undo': 'Undo',
    'tool.undoTitle': 'Undo (Z)',
    'tool.redo': 'Redo',
    'tool.redoTitle': 'Redo (Y)',
    'tool.clear': 'Clear the whole dam',
    'tool.zone': 'Frame the build zone',
    'tool.zoneTitle': 'Frame the build zone — zoom in so the grid is bigger than your finger',
    'hud.release': '⚠ RELEASE WATER',
    'sim.pause': 'Pause',
    'sim.retry': 'Retry',
    'sim.retryTitle': 'Retry (R)',
    'sim.edit': 'Edit dam',
    'hud.armed': 'Tap anywhere in the lit circle to build this beam',
    'mat.head': (m) => `~${m} m head`,
    'mat.headTitle': (m) => ` Holds roughly ${m} m of water head.`,
    'mat.timber.name': 'Timber',
    'mat.timber.blurb': 'Cheap and light. Bends, then breaks.',
    'mat.steel.name': 'Steel',
    'mat.steel.blurb': 'Stiff and strong, strongest in tension. Costly.',
    'mat.concrete.name': 'Concrete',
    'mat.concrete.blurb': 'Immense under compression. Cracks if pulled. Very heavy.',
    'mat.cable.name': 'Cable',
    'mat.cable.blurb': 'Pulls only. Long, light, seals nothing.',

    'toast.held': 'DAM HELD',
    'toast.failed': 'DAM FAILED',
    'toast.breach': 'BREACH',
    'toast.overtop': 'OVERTOPPING',
    'canvas.protect': 'PROTECT',
    'canvas.zone': 'BUILD ZONE',
    'canvas.delete': (n) => (n === 1 ? 'DELETE 1 BEAM' : `DELETE ${n} BEAMS`),

    'reason.too short': 'too short',
    'reason.too long': 'too long',
    'reason.outside build zone': 'outside build zone',
    'reason.underground': 'underground',
    'reason.through the ground': 'through the ground',
    'reason.no material': 'no material',
    'reason.not available here': 'not available here',
    'reason.same point': 'same point',
    'reason.already built': 'already built',
    'reason.overlaps a member': 'overlaps a member',
    'reason.over budget': 'over budget',
    'reason.another joint there': 'another joint there',

    'obj.retain': (p, d) => `HOLD ${p}% FOR ${d}s`,
    'obj.protect': (m, d) => `KEEP DOWNSTREAM UNDER ${m} m FOR ${d}s`,
    'obj.survive': (d) => `SURVIVE ${d}s`,

    'tut.step': (n, of) => `STEP ${n} OF ${of}`,
    'tut.skip': 'SKIP',
    'tut.next': 'GOT IT →',
    'tut.last': 'BUILD IT →',
    'tut.0.title': 'Tap an anchor, then tap in the circle',
    'tut.0.text': 'Every beam starts on a yellow anchor or a joint you have already built. ' +
      'Tap one and a circle appears: everywhere lit inside it is somewhere this beam ' +
      'can reach. Tap anywhere lit and the beam is built. Two taps, every time — to ' +
      'keep going, tap the joint you just made. (A drag does the same in one go.) ' +
      'Dark means the ground or the zone is in the way; amber means you cannot afford ' +
      'that far. The ⤢-style button zooms to the build site.',
    'tut.1.title': 'Triangles hold, squares fold',
    'tut.1.text': 'Pick a material below (or press 1–4). Every beam costs its length × its price ' +
      'per metre. Brace your wall with diagonals — a square frame just folds over.',
    'tut.2.title': 'Then release the water',
    'tut.2.text': 'Hit RELEASE WATER when you are ready. Watch the beams: cool blue means being ' +
      'pulled, warm orange means being crushed. Flashing with cracks means about to fail.',

    'result.held': 'DAM HELD',
    'result.failed': 'DAM FAILED',
    'result.newBest': (cost) => `New best cost: ${cost}.`,
    'result.unlocked': (name) => `Unlocked: ${name}.`,
    'result.retry': '↻ RETRY',
    'result.edit': '✎ EDIT DAM',
    'result.next': 'NEXT LEVEL →',
    'result.nextNamed': (name) => `NEXT: ${name} →`,
    'result.levels': 'LEVELS',
    'stat.retained': 'Water retained',
    'stat.needed': 'Retention needed',
    'stat.depth': 'Peak reservoir depth',
    'stat.stress': 'Maximum stress',
    'stat.broken': 'Members broken',
    'stat.cost': 'Construction cost',
    'stat.time': 'Survival time',

    // These reproduce, character for character, the lines modes.js used to
    // write by hand — tests/build.test.js and the level checks match on them.
    'cause.overtop': 'OVERTOPPED — THE RESERVOIR ROSE OVER THE CREST',
    'cause.breach': 'BREACHED — WATER FOUND A WAY THROUGH',
    'cause.nothing': 'NOTHING WAS BUILT — THE WATER JUST WALKED THROUGH',
    'cause.slid': "BUDGET WASN'T THE PROBLEM — THE DAM SLID",
    'cause.limit': (where, mat, mode, time) =>
      `${whereEn(where, mat)} — ${mode === 'tension' ? 'TENSION' : 'COMPRESSION'} LIMIT EXCEEDED at ${f1(time)}s`,
    'cause.retained': (got, need) => `ONLY ${got}% RETAINED — ${need}% WAS NEEDED`,
    'cause.sustained': (load, held) => `GAVE WAY UNDER SUSTAINED LOAD — HELD AT ${load}% FOR ${held} s`,
    'cause.bending': (len, mat, depth, time) => {
      const m = MAT_EN[mat] || '';
      const what = len > 0 ? `${f1(len)} m SPAN${m ? ' OF ' + m : ''}`
        : (m ? `A ${m} SPAN` : 'AN UNSUPPORTED SPAN');
      const d = depth > 0.1 ? `${f1(depth)} m OF WATER` : 'DEEP WATER';
      return `SNAPPED AT MIDSPAN — ${what} UNDER ${d} at ${f1(time)}s`;
    },
    'cause.collapse': (broken, total) => `PROGRESSIVE COLLAPSE — ${broken} OF ${total} MEMBERS FAILED`,
    'cause.flooded': (depth) => `FLOODED DOWNSTREAM — ${f2(depth)} m IN THE PROTECTED ZONE`,

    'coach.overtop': 'The reservoir rose over your crest. Build higher, or give the water a spillway.',
    'coach.breach': 'Water found a gap. Sealing beams must touch each other — cables seal nothing.',
    'coach.sustained': 'It was holding right at the edge — sustained pressure eats weak material. Add margin, or build the wet face from something stronger.',
    'coach.bending': 'Long spans snap in the middle — stand a pier under the face or use steel.',
    'coach.tension': 'Something was pulled apart. Steel and cable are strongest in tension.',
    'coach.compression': 'Something was crushed. Shorten the span or brace it — long beams buckle.',
    'coach.collapse': 'One failure took the rest with it. Triangulate so no single beam is critical.',
    'coach.slid': 'The dam moved bodily. Tie it to anchors on both banks.',
    'coach.nothing': 'Tap an anchor, then tap inside the circle to place your first beam.',
    'coach.retained': 'Close. Seal the leaks and raise the crest a little.',
    'coach.flooded': 'The village took water. Route the overflow away from it.',
  },
};

// ---- level content --------------------------------------------------------
// English is the level data (src/levels/levels.js); bokmål is lvl.<id>.* above.

export function levelName(lv) { return lv ? tOr('lvl.' + lv.id + '.name', lv.name || '') : ''; }
export function levelSub(lv) { return lv ? tOr('lvl.' + lv.id + '.sub', lv.subtitle || '') : ''; }
export function levelHint(lv, i) {
  const h = (lv && lv.hints) || [];
  return h[i] === undefined ? '' : tOr('lvl.' + lv.id + '.hint' + i, h[i]);
}
