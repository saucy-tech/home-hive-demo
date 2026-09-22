/* The Home Hive — client.
 *
 * Two modes on one page: Plan (grown-ups, the week folded into the evening)
 * and Play (the kid — big targets, read aloud, games driven by the same week
 * JSON so next week's content swaps without touching this file).
 *
 * TOPICS. The school's lesson plan is one track among several — body and
 * doctor words, code, AI, Bitcoin, robots — and a track is nothing but a folder
 * of week docs plus its own index. The topic picker chooses the folder, the week
 * picker chooses the doc inside it, and which GAMES exist is decided by which
 * config blocks that doc happens to carry. Adding a topic is therefore data:
 * a folder, an index, and a line in weeks/index.json.
 *
 * No name is hardcoded anywhere in here; the child's name comes from
 * weeks/index.json, which is also what lets the public demo ship a different
 * one without a code change.
 */

/* ───────────────────────── helpers ───────────────────────── */
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sample = (a, n) => shuffle(a).slice(0, n);

/* Deal `n` from a pool, preferring whatever he did NOT get last time.
 *
 * A fresh shuffle every play is not the same thing as feeling different. Letter
 * Hunt asked for as many words as the week had, so it dealt the identical five
 * every single time; even off a bank twice that size, an unweighted deal
 * repeats often enough that a four-year-old says "this one again". The last
 * deal is remembered per caller — the letter game's memory and the match
 * board's are separate — and everything else in the pool goes first. */
function freshSample(key, pool, n){
  const K = "hive:last:" + key;
  const idOf = x => x.id || x.word || x.text;
  let last = [];
  try { last = JSON.parse(localStorage.getItem(K)) || []; } catch {}
  const unseen = pool.filter(x => !last.includes(idOf(x)));
  const seen = pool.filter(x => last.includes(idOf(x)));
  const pick = shuffle([
    ...sample(unseen, Math.min(n, unseen.length)),
    ...sample(seen, Math.max(0, n - unseen.length)),
  ]);
  try { localStorage.setItem(K, JSON.stringify(pick.map(idOf))); } catch {}
  return pick;
}
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DAY_KEYS = ["mon","tue","wed","thu","fri"];
const DAY_SHORT = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri" };
/* Sunday-first, so the index matches Date#getDay() and the "what comes after"
 * arithmetic is a modulo rather than a lookup table. */
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/* Numbers to SAY. A numeral on its own is not a word, and the voice model reads
 * it like one — the pack came back with "1" as a grunt, "2" with no t on the
 * front and "11" as something closer to "it lived". Inside a sentence the same
 * digit is fine ("Find the number 11." is exact), so this is only for the lines
 * that are nothing but the number. The screen still shows the numeral; reading
 * that is the thing he's here to practise. */
const NUM_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
  "Nineteen", "Twenty", "Twenty-one", "Twenty-two", "Twenty-three", "Twenty-four", "Twenty-five",
  "Twenty-six", "Twenty-seven", "Twenty-eight", "Twenty-nine", "Thirty"];
const numWord = n => (NUM_WORDS[n] || n) + ".";
/* "1 bees" is the kind of thing you only hear once it's being read out loud. */
const beeCount = n => `${n} ${n === 1 ? "bee" : "bees"}`;

function parseDay(iso){ return new Date(iso + "T00:00:00"); }
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b){ return a.toDateString() === b.toDateString(); }

/* ───────────────────────── read aloud ───────────────────────── */
/* A four-year-old can't read the prompts, so the games are unplayable solo
 * without this. It's a parent's voice: every line the app can say is recorded
 * ahead of time by scripts/audio/generate.mjs and looked up here by the exact
 * sentence. A line that ISN'T in the pack — a week nobody has generated yet —
 * falls back to the device's own voice, so the app still talks. It just talks
 * like a robot until someone runs the generator.
 *
 * iOS only allows audio after a user gesture. Every game starts from a tap,
 * which satisfies it. */
let soundOn = localStorage.getItem("hive:sound") !== "off";
let vo = null;              // { "<sentence>": "<file>.mp3" } — null until loaded
let voice = null;
function pickVoice(){
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find(v => v.lang === "en-US" && /samantha|karen|allison|ava/i.test(v.name))
       || vs.find(v => v.lang === "en-US")
       || vs.find(v => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window){ pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

/* Every utterance gets a number. Anything that wants to speak AFTER something
 * else finishes can then check that nothing spoke in between — `say` cancels
 * whatever is in progress, so "when the prompt ends" and "when the prompt was
 * interrupted by a wrong answer" are otherwise the same event. */
let speechSeq = 0;

/* Both paths hand back the same thing: something you can hang "when this has
 * finished" on, without the caller caring whether it was an mp3 or the speech
 * engine. */
function endHandle(){
  let cbs = [];
  return {
    onEnd(cb){ cbs.push(cb); },
    fire(){ const list = cbs; cbs = []; list.forEach(f => { try { f(); } catch {} }); },
  };
}

/* `parts` is one sentence, or several played back to back. Where to split is a
 * real decision, not a style one: "That one is 5. Find the number 7." as a
 * single recording needs one file for every PAIR of numbers — four hundred of
 * them. Said as two, it needs forty. */
function say(parts, { rate = 0.92, onPart } = {}){
  if (!soundOn) return null;
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean).map(String);
  if (!list.length) return null;
  hush();
  speechSeq++;
  const files = vo && list.map(t => vo[t]);
  if (files && files.every(Boolean)) return playClips(list, files, rate, onPart);
  if (vo) missing(list);
  return speak(list.join(" "), rate);
}

/* ONE audio element, reused for every line for the life of the page. Making a
 * fresh `new Audio` per sentence is the obvious way to write this and it dies
 * on the device it's for: a game says a few hundred things in a sitting, and
 * iOS caps how many media elements a page may hold. It doesn't error — it just
 * stops making sound partway through the evening. */
let voiceEl = null, voiceChain = 0;

/* The pack is recorded at an adult's reading pace — five and a half syllables a
 * second on the longer prompts, half again quicker than anyone talks to a
 * four-year-old, and a blur to someone still holding the question in his head.
 * Slowing playback is the one knob that reaches the recordings already on disk,
 * and the browser stretches the time without moving the pitch, so it's still
 * a parent's voice, just unhurried. Turn it down further here if it's still
 * quick; below about 0.75 the stretching starts to sound like it. */
const CLIP_RATE = 0.85;

/* `onPart(idx)` fires as part idx starts playing — the pattern game lights each
 * cell as its name is said. Best-effort: the device-voice fallback reads the
 * whole line as one utterance, so it never fires there. */
function playClips(texts, files, rate, onPart){
  const gen = ++voiceChain;
  const h = endHandle();
  if (!voiceEl){
    voiceEl = new Audio();
    voiceEl.preload = "auto";
    // Both: loading a new src resets playbackRate to defaultPlaybackRate, and
    // this element takes a new src for every line it says.
    voiceEl.defaultPlaybackRate = CLIP_RATE;
    voiceEl.playbackRate = CLIP_RATE;
  }
  const a = voiceEl;
  let i = 0;
  let settled = -1;                                 // last index whose outcome was handled

  const step = () => {
    if (gen !== voiceChain) return;                 // something else started talking
    if (i >= files.length){ h.fire(); return; }
    const idx = i++;
    if (onPart) try { onPart(idx); } catch {}
    // Reassigned per clip, so a stale chain's handlers can never fire.
    a.onended = () => settle(idx, false);
    a.onerror = () => settle(idx, true);
    a.src = "/audio/vo/" + files[idx];
    a.play().catch(() => settle(idx, true));
  };

  /* A recording that won't play — offline before the pack finished warming, a
   * corrupt cache entry — must not become silence. He can't read the prompt, so
   * a part that gets skipped is a question he has no way to answer, and a
   * one-part prompt would drop the whole thing. Say that part with the device
   * voice and carry on with the rest of the sentence.
   *
   * `error` and a rejected `play()` can both fire for the same clip, which is
   * what `settled` is for: without it a failure speaks twice and skips the
   * clip after it. */
  const settle = (idx, failed) => {
    if (gen !== voiceChain || settled >= idx) return;
    settled = idx;
    if (!failed) return step();
    const spoken = speak(texts[idx], rate);
    if (!spoken) return step();
    /* And a backstop on the backstop. The speech engine doesn't always report
     * back — it's blocked outright until the page has been touched, and iOS
     * drops `end` if the tab goes to the background mid-sentence — which would
     * leave the rest of the sentence waiting on an utterance that never
     * finishes. Roughly a beat longer than the line takes to say. */
    let moved = false;
    const go = () => { if (!moved){ moved = true; step(); } };
    spoken.onEnd(go);
    setTimeout(go, 1200 + texts[idx].length * 90);
  };

  step();
  return h;
}

function speak(text, rate){
  if (!("speechSynthesis" in window)) return null;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate; u.pitch = 1.05;
    if (voice) u.voice = voice;
    const h = endHandle();
    u.onend = () => h.fire();
    speechSynthesis.speak(u);
    return h;
  } catch { /* speech is a bonus, never a blocker */ }
  return null;
}

function hush(){
  voiceChain++;
  // Paused, not discarded — the element is reused, and dropping it here is how
  // the page ends up allocating a new one per sentence again.
  if (voiceEl){ try { voiceEl.pause(); } catch {} }
  // The sing-along too: every way out of that screen — back, mode switch, the
  // master sound toggle — runs through here, so this is the one off switch.
  songStop();
  try { speechSynthesis.cancel(); } catch {}
}

/* The pack is built from a list that mirrors these strings by hand, so the two
 * can drift — a reworded prompt is a line in the wrong voice, and nothing about
 * playing it says so. Collect the misses where a play-through will show them:
 * `hiveVoMisses` in the console after a game is the drift report. */
window.hiveVoMisses = [];
function missing(list){
  list.forEach(t => {
    if (vo[t] || window.hiveVoMisses.includes(t)) return;
    window.hiveVoMisses.push(t);
    console.warn("[hive] no recording for:", JSON.stringify(t));
  });
}

/* Short, and layered over the narration rather than interrupting it. Quiet on
 * purpose — the voice is the part carrying the game. */
const sfxEls = {};
function sfx(name, vol = 0.45){
  if (!soundOn) return;
  try {
    const a = sfxEls[name] || (sfxEls[name] = new Audio(`/audio/sfx/${name}.mp3`));
    a.volume = vol;
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {}
}

/* One loop, and only on the game picker. Underneath a question being read out
 * it's just noise, so every game stops it on the way in. */
let musicOn = localStorage.getItem("hive:music") !== "off";
let musicEl = null, musicWanted = false;
function musicStart(){ musicWanted = true; musicSync(); }
function musicStop(){ musicWanted = false; musicSync(); }
function musicSync(){
  const play = musicWanted && musicOn && soundOn;
  try {
    if (!play){ if (musicEl) musicEl.pause(); return; }
    if (!musicEl){
      musicEl = new Audio("/audio/music/hive.mp3");
      musicEl.loop = true;
      musicEl.volume = 0.16;
    }
    if (musicEl.paused) musicEl.play().catch(() => {});
  } catch {}
}
/* Autoplay is blocked until he touches the screen, so the picker can come up
 * silent on a cold open. Retry on the first tap taken while it should be on. */
document.addEventListener("pointerdown", musicSync, { passive: true });

/* Pull clips into the cache a few at a time, so the first "Find the number
 * seven" of a game isn't sitting waiting on the network. The service worker
 * serves /audio/ cache-first and keeps whatever it fetches, so an ordinary
 * fetch from here is what puts a file where an offline game will find it.
 *
 * `done` is handed the number that never arrived. A clip the worker has no
 * copy of and no signal to fetch is a plain network error rather than the 503
 * the other routes answer with, so a failed warm looks exactly like a finished
 * one unless somebody counts. */
function warmVoice(files, done){
  let i = 0, failed = 0;
  let live = Math.min(6, files.length);
  if (!live){ if (done) done(0); return; }
  const step = () => {
    const f = files[i++];
    if (!f){ if (--live === 0 && done) done(failed); return; }
    fetch("/audio/vo/" + f).then(res => { if (!res.ok) failed++; }, () => { failed++; }).then(step);
  };
  for (let n = live; n > 0; n--) step();
}

/* The loaded week's own clips, warmed ahead of the rest of the pack.
 *
 * The pack is every week the deploy carries at once — a couple of thousand
 * files — and a fresh week opened somewhere with no signal before that finishes
 * is a week read in the device's robot voice. One week's lines are a sixth of
 * it, so they go first and the remainder follows once they have landed. The
 * list comes from the same module the generator records from, so what he can
 * hear and what was warmed are one list rather than two that drift.
 *
 * `hiveVoWarm` in the console is the report: which week, how many of its lines
 * have a recording behind them, and whether the fetches have finished. */
window.hiveVoWarm = null;
const voWarmed = new Set();
let packWarmed = false;

function warmWeekVoice(){
  if (!vo || !week || voWarmed.has(weekId)) return;
  const id = weekId, doc = week;
  voWarmed.add(id);
  import("/phrases.mjs").then(({ phrasesFor }) => {
    const lines = phrasesFor(doc, index);
    const files = [...new Set(lines.map(t => vo[t]).filter(Boolean))];
    const mark = window.hiveVoWarm = { week: id, lines: lines.length, clips: files.length, done: false, failed: 0 };
    warmVoice(files, failed => {
      mark.done = true;
      mark.failed = failed;
      // Signal died partway. Nothing was warmed, so forget the week rather than
      // remember it as handled: the next week or topic switch tries again, and
      // without this it stays silent offline until somebody reloads the page.
      if (failed){ voWarmed.delete(id); return; }
      if (packWarmed) return;
      packWarmed = true;
      warmVoice([...new Set(Object.values(vo))], rest => { if (rest) packWarmed = false; });
    });
    // Warming is a head start, never a requirement: a deploy that doesn't
    // serve the module plays exactly as it did before, off the network.
  }).catch(() => { voWarmed.delete(id); });
}

async function loadVoice(){
  try {
    const res = await fetch("/audio/vo/index.json", { cache: "no-store" });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return;
    const doc = await res.json();
    if (doc && doc.clips){
      vo = doc.clips;
      warmWeekVoice();
    }
  } catch { /* no pack on this deploy — the device voice covers it */ }
}

/* ───────────────────────── sing-along songs ─────────────────────────
 * The week doc names the song and carries its lyrics; the generated pack under
 * /audio/songs is what actually sings. The manifest maps song id → file plus
 * the moment each lyric line starts, measured by forced alignment when the
 * song was generated — that's what lets the words light up as they're sung.
 * Unlike the voice pack there is no fallback to generate FROM: a song nobody
 * has generated yet simply isn't offered, so the tile only appears once the
 * manifest names it. */
let songBook = null;
const songMeta = id => (songBook && songBook[id]) || null;

/* And only trusted for the config it was generated from: a reworded song
 * whose audio nobody has regenerated yet must degrade to no tile, not to the
 * new words scrolling over the old recording. The manifest carries the
 * generator's config hash; recompute it here and compare. SHA-1 is async in
 * the browser, so verdicts land in a cache and the picker repaints when one
 * arrives — the same late-arrival pattern the manifest itself uses. */
const songOkCache = {};
function songReady(sg){
  const meta = songMeta(sg.id);
  if (!meta) return false;
  // Rows from before `hash` was recorded named the file AFTER the config
  // hash, so the filename is the identity to check against.
  const want = meta.hash || (meta.file || "").replace(/\.mp3$/, "");
  // Byte-identical to the generator's hash input, key order included.
  const cfg = JSON.stringify({ style: sg.style, lyrics: sg.lyrics, ms: sg.ms || 60000 });
  /* The whole config is in the key, not just the id: one id can be defined in
   * more than one week — the feelings song rides both school weeks — and
   * editing one of those copies has to be a different question from the other.
   * Keyed on the id alone, the first week answered for both. */
  const key = `${sg.id}:${meta.file}:${want}:${cfg}`;
  if (key in songOkCache) return songOkCache[key];
  // No crypto.subtle means an insecure origin, which only happens in odd dev
  // setups — trust the manifest there rather than losing every tile.
  if (!(window.crypto && crypto.subtle)) return (songOkCache[key] = true);
  songOkCache[key] = false;
  crypto.subtle.digest("SHA-1", new TextEncoder().encode(cfg)).then(buf => {
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hex.slice(0, 12) === want){
      songOkCache[key] = true;
      if (mode === "play" && !$("playHome").hidden) renderPlayHome();
      // The map counted this song out while the verdict was pending.
      else if (mode === "map") renderMap();
      // The day card too: a visit move's "Sing it" door only draws once the
      // song it names is ready.
      else if (mode === "plan" && week){ renderWeekMeter(); renderDay(); }
    } else {
      console.warn(`[hive] song "${sg.id}" was reworded — regenerate the audio pack`);
    }
  }).catch(() => {});
  return songOkCache[key];
}

async function loadSongs(){
  try {
    const res = await fetch("/audio/songs/index.json", { cache: "no-store" });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return;
    const doc = await res.json();
    if (doc && doc.songs) songBook = doc.songs;
  } catch { /* no songs on this deploy — Play just has one tile fewer */ }
}

/* One element for every song, for the same iOS media-element reason as the
 * voice. Paused from hush(), which every exit from the sing screen runs
 * through, so a song can never keep playing under another game. */
let songEl = null;
function songStop(){ if (songEl){ try { songEl.pause(); } catch {} } }

/* ───────────────────────── match card packs ─────────────────────────
 * The week's feelings are built in and always there: they are the lesson, and
 * Match is where the vocabulary gets drilled. The other decks — the cars and
 * the robots he actually asks for — are DATA under /packs, fetched the first
 * time he picks one and kept for the session.
 *
 * A deploy that ships no packs at all (the public demo does not) simply has one
 * mode and no picker, so nothing here is allowed to be a hard dependency. */
let packList = [];                 // [{ id, name, emoji, noun }] — what to offer
const packCache = {};              // id -> { cards: [...] }, fetched once

async function loadPackList(){
  try {
    const res = await fetch("/packs/index.json");
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return;
    const doc = await res.json();
    if (doc && Array.isArray(doc.packs)) packList = doc.packs;
  } catch { /* no packs on this deploy — feelings mode is the whole game */ }
}

async function loadPack(id){
  if (packCache[id]) return packCache[id];
  const res = await fetch(`/packs/${id}.json`);
  if (!res.ok) throw new Error("pack " + id);
  const doc = await res.json();
  if (!doc || !Array.isArray(doc.cards) || !doc.cards.length) throw new Error("pack " + id);
  packCache[id] = doc;
  return doc;
}

/* ───────────────────────── shared state ───────────────────────── */
const BUCKETS = ["checks","stretch","feelings","helps","notes","stars","games","notices"];
const LS_KEY = "hive:mirror:v1";

/* Shared-state sync is allowed on exactly these hosts and nowhere else.
 * Default-deny on purpose: the public demo runs the same bundle, and an
 * allowlist that has to be updated to ENABLE sync can't accidentally leave it
 * on somewhere new. Off this list the app is pure localStorage — a demo
 * visitor's taps live in their own browser and go nowhere. */
const SYNC_HOSTS = ["app.example.invalid", "localhost", "127.0.0.1"];
const syncEnabled = SYNC_HOSTS.includes(location.hostname);

function emptyState(){ const s = {}; for (const b of BUCKETS) s[b] = {}; s.updatedAt = 0; s.updatedBy = null; return s; }
let state = emptyState();
let pending = {};
let pushTimer = null;
let needsLogin = false;

function syncMsg(text, warn){
  const n = $("sync");
  n.textContent = text || "";
  n.classList.toggle("warn", !!warn);
}

function mirror(){ try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {} }

function get(bucket, k, dflt){
  const v = state[bucket] ? state[bucket][k] : undefined;
  return v === undefined ? dflt : v;
}
function set(bucket, k, v){
  state[bucket][k] = v;
  (pending[bucket] || (pending[bucket] = {}))[k] = v;
  mirror();
  schedulePush();
}

function schedulePush(){
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 400);
}

/* Put a sent entry back on the queue, unless something newer is already there.
 * push() swaps the queue out before it awaits, so anything sitting in it by the
 * time a failure comes back was typed while the request was in flight and is
 * more recent than what we sent. Overwriting it un-taps the box the user just
 * tapped — and the retry then saves the stale value and adopts it back over the
 * screen, so the change is gone rather than merely late.
 *
 * This is only sound because push() runs one request at a time: with two in
 * flight, the newer value could be inside the second request rather than in the
 * queue, and there would be nothing here to compare against. */
function requeue(bucket, key, value){
  const queued = pending[bucket];
  if (queued && key in queued) return false;
  (queued || (pending[bucket] = {}))[key] = value;
  return true;
}

/* One request at a time. A push is a read-modify-write of a single shared
 * document, so two of them in flight can be applied by the server in either
 * order, and a failure returning from the first can put stale values back over
 * what the second already sent. Whatever arrives while one is running waits for
 * the queue rather than opening a second. */
let pushing = false;
let pushQueued = false;

async function push(){
  if (!syncEnabled){ pending = {}; syncMsg("Saved on this device"); return; }
  if (!Object.keys(pending).length) return;
  if (pushing) { pushQueued = true; return; }
  pushing = true;
  const delta = pending;
  pending = {};
  syncMsg("Saving…");
  try {
    const res = await fetch("/api/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delta),
    });
    const doc = await asJson(res);
    adopt(doc);
    syncMsg("Saved");
    setTimeout(() => { if ($("sync").textContent === "Saved") syncMsg(""); }, 1800);
  } catch (e) {
    if (e && e.rejected) {
      // Requeueing something the server will never accept is how one bad value
      // stops the household syncing for good: it rides along in every later
      // push and takes each one down with it, while the message still says the
      // work was saved somewhere. So the refused entries go, and only those —
      // a push is a coalesced batch, and a star earned this morning should not
      // be thrown away because a note from last week is too long. What is kept
      // goes back on the queue and is retried immediately; each round strictly
      // removes what was named, so this settles rather than looping.
      //
      // A 413 or a 507 names nothing, because nothing in particular is at
      // fault: the body or the record as a whole is over its ceiling. Those
      // drop the batch, which is all there is to do — but they are still local
      // and mirrored, and the message says so rather than claiming a save.
      // Joined on a NUL rather than anything a key could contain: the server's
      // KEY_PATTERN admits spaces, colons, dots and dashes.
      const refused = new Set(
        (e.body && Array.isArray(e.body.invalid) ? e.body.invalid : [])
          .map(entry => entry.bucket + "\u0000" + entry.key)
      );
      const keep = [];
      let identified = 0;
      for (const [b, m] of Object.entries(delta)) {
        for (const [k, v] of Object.entries(m)) {
          if (refused.has(b + "\u0000" + k)) { identified++; continue; }
          keep.push([b, k, v]);
        }
      }
      // Only put the rest back if a refused entry was actually found. If the
      // server named something this batch cannot match, keeping it would resend
      // the same bytes — and the reschedule below would do that every 400ms for
      // as long as the tab is open. Dropping is the fallback a 413 or a 507
      // already gets, and it keeps the no-wedge guarantee from depending on the
      // two sides spelling a key the same way.
      if (identified) for (const [b, k, v] of keep) requeue(b, k, v);
      if (Object.keys(pending).length) schedulePush();
      syncMsg(e.full ? "Hive is full — not saved" : "Some changes weren't saved", true);
      return;
    }
    // Put the delta back so nothing typed is lost, and try again on the next change.
    for (const [b, m] of Object.entries(delta)) {
      for (const [k, v] of Object.entries(m)) requeue(b, k, v);
    }
    offline(e);
  } finally {
    pushing = false;
    // Anything that arrived mid-flight was held back rather than sent; it goes
    // now. The `return` on the rejected path above lands here too.
    if (pushQueued) { pushQueued = false; schedulePush(); }
  }
}

async function pull(){
  if (!syncEnabled) return;
  try {
    const doc = await asJson(await fetch("/api/state", { cache: "no-store" }));
    adopt(doc);
    needsLogin = false;
    syncMsg("");
  } catch (e) { offline(e); }
}

/* Cloudflare Access answers an expired session with an HTML login page, not
 * JSON. Detect that rather than letting JSON.parse throw something useless. */
async function asJson(res){
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("application/json")) {
    const err = new Error(res.status === 302 || !type.includes("json") ? "login" : "http " + res.status);
    err.login = !type.includes("json");
    // The three the API uses for "this will not be accepted": a key or value
    // that failed validation, a body over the size cap, and a record already at
    // its ceiling. All three are deterministic for the same bytes — 507 as much
    // as the others, since the document does not shrink on its own — so a retry
    // fails identically and only drags later changes down with it. Every other
    // status, 401 and the rest of the 5xx included, is worth retrying and must
    // not land here.
    err.rejected = res.status === 400 || res.status === 413 || res.status === 507;
    err.full = res.status === 507;
    // The 400 body names each refused entry, which is what lets push() keep the
    // valid half of a coalesced batch instead of discarding all of it.
    try { err.body = await res.json(); } catch {}
    throw err;
  }
  return res.json();
}

function offline(e){
  if (e && e.login) {
    needsLogin = true;
    syncMsg("Tap to sign in", true);
  } else {
    syncMsg("Offline — saved here", true);
  }
}

function adopt(doc){
  if (!doc || typeof doc !== "object") return;
  for (const b of BUCKETS) if (doc[b]) state[b] = doc[b];
  state.updatedAt = doc.updatedAt || 0;
  state.updatedBy = doc.updatedBy || null;
  mirror();
}

$("sync").addEventListener("click", () => { if (needsLogin) location.reload(); });

/* ───────────────────────── week data ───────────────────────── */
let index = null;      // weeks/index.json — the child, the class, the topic registry
let curriculum = null; // weeks/curriculum.json — the school's year map, or null
let topic = null;      // the track being shown, from index.topics
let track = null;      // that track's own index — { weeks: [...] }
let week = null;       // the loaded week doc
let weekId = null;
let dayKey = "mon";
let mode = "plan";
let synced = false;    // the boot pull has landed (or been given up on)

const K = (...parts) => [weekId, ...parts].join(":");

/* Behind Access, a request whose session has expired comes back as a login
 * PAGE, not an error — status 200, content-type text/html. Calling .json() on
 * that throws something unreadable ("Unexpected token <"), so check the
 * content-type and say what actually happened. */
async function getJSON(path){
  const res = await fetch(path, { cache: "no-store" });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("json")){
    const err = new Error(`${path} returned ${res.status} ${type || "no content-type"}`);
    err.login = res.redirected || type.includes("html");
    throw err;
  }
  return res.json();
}

async function loadIndex(){
  index = await getJSON("/weeks/index.json");
  index.weeks.sort((a, b) => a.start < b.start ? 1 : -1);   // newest first
}

/* The school hands out two different things: a year map in August, and a poster
 * every week after that. The map is the one that answers "what is next Monday"
 * without walking to the fridge, and it's also what every week doc is copied
 * FROM — the Monday, the label and the theme are its columns. So it lives here,
 * once, instead of being retyped into each week and quietly drifting.
 *
 * Missing is a normal state rather than an error. The sanitizer drops
 * public/weeks by directory and the demo's replacement carries no calendar, so
 * no calendar simply means no term card — the same way a missing voice pack
 * means the iPad reads in its own voice. */
async function loadCurriculum(){
  try { curriculum = await getJSON("/weeks/curriculum.json"); }
  catch { curriculum = null; }
}

/* Every calendar week in order, each still holding the month it belongs to,
 * because the monthly focus lives on the month and the week needs to say it. */
function calendarWeeks(){
  return (curriculum?.months || []).flatMap(m => (m.weeks || []).map(w => ({ ...w, month: m })));
}
function calendarWeekFor(start){
  return calendarWeeks().find(w => w.start === start) || null;
}

/* The school's lesson plan is a topic like any other and keeps its original
 * home, so a checkout with no topic registry at all — the public demo — is
 * simply a one-topic app with no picker. */
const SCHOOL_TOPIC = { id: "school", name: "Preschool", emoji: "🏫", dir: "/weeks" };
function topicList(){
  const list = (index.topics || []).filter(t => t && t.id && t.dir);
  return list.length ? list : [SCHOOL_TOPIC];
}
/* The school's track is the only one with a class, a curriculum and a year map
 * behind it. Our own tracks run on their own clock and are measured by nobody. */
function isSchool(){ return topic.dir === "/weeks"; }

/* ONE door for every navigation, and the last tap through it wins.
 *
 * A track is a folder: its index lists the weeks, each week doc sits beside it,
 * and the school's index is the top-level one already in hand, so switching to
 * it costs no fetch.
 *
 * Everything is fetched before ANYTHING is committed, and a switch that has been
 * superseded commits nothing at all. Both halves of that matter, and the first
 * version had neither: it assigned `topic` before awaiting that topic's index
 * and `track` after, so two quick taps on the picker — which is a thing a
 * four-year-old does to a dropdown — could finish out of order and leave `topic`
 * on one track with `track` holding another's weeks. The next line then asked
 * Code's folder for Body's week, got a 404, and painted "couldn't load this
 * week" over a screen that had been working a second earlier.
 *
 * `wantWeek` is for the week picker; without it this lands on the current week.
 * Returns false when a later navigation has already taken over, which is the
 * caller's signal to leave the screen alone rather than render half of this
 * one. */
let navGen = 0;

/* A fetch belonging to a navigation that has already been overtaken must not
 * report its FAILURE either. Checking the generation only on the way out of a
 * successful fetch left the other half open: the rejection skipped every guard,
 * came out of `goTo`, and the caller's `catch` painted "couldn't load this week"
 * over the screen that had meanwhile loaded perfectly well. Offline for a moment
 * while switching topics was enough to do it.
 *
 * So a stale failure is answered with STALE — nobody's problem any more — and
 * only the current navigation's failure is allowed to travel. */
const STALE = Symbol("stale");
let libraryResolver;
async function resolveWeekDoc(doc){
  libraryResolver ||= import("/library.mjs").then(m => m.createLibraryResolver(getJSON))
    .catch(error => { libraryResolver = null; throw error; });
  return (await libraryResolver)(doc);
}

async function getFor(gen, path, resolve = false){
  try {
    const doc = await getJSON(path);
    return resolve ? await resolveWeekDoc(doc) : doc;
  } catch (e) {
    if (gen !== navGen) return STALE;
    throw e;
  }
}

async function goTo(topicId, wantWeek){
  const gen = ++navGen;
  const nextTopic = topicList().find(t => t.id === topicId) || topicList()[0];
  // Fetched against the topic this call is FOR, never against the global — a
  // stale call must fetch the wrong-but-harmless file, not a missing one.
  const nextTrack = nextTopic.dir === "/weeks"
    ? index
    : await getFor(gen, `${nextTopic.dir}/index.json`);
  if (nextTrack === STALE || gen !== navGen) return false;

  const weeks = (nextTrack.weeks || []).slice().sort((a, b) => a.start < b.start ? 1 : -1);
  const id = weeks.some(w => w.id === wantWeek) ? wantWeek : currentWeekId(weeks);
  const doc = await getFor(gen, `${nextTopic.dir}/${id}.json`, true);
  if (doc === STALE || gen !== navGen) return false;

  topic = nextTopic;
  // A copy, so sorting a track's weeks never reorders the index it came from.
  track = { ...nextTrack, weeks };
  week = doc;
  weekId = id;
  dayKey = todayDayKey();
  // The pack is usually still in flight on a cold open, so loadVoice warms
  // whichever week is loaded by the time it lands; this covers every switch
  // after that.
  warmWeekVoice();
  localStorage.setItem("hive:topic", topic.id);
  return true;
}

/* This week's doc if the track has one, and otherwise the newest one that has
 * already started. The fallback is what makes a track CARRY OVER: a topic
 * nobody has written a new unit for keeps playing the last one it was given
 * rather than going blank or jumping to something out of order.
 *
 * Takes the list rather than reading the global, so it can be asked about a
 * track that hasn't been committed yet. */
function currentWeekId(weeks){
  const today = new Date();
  for (const w of weeks){
    const s = parseDay(w.start);
    if (today >= s && today < addDays(s, 7)) return w.id;
  }
  const past = weeks.filter(w => parseDay(w.start) <= today);
  return (past[0] || weeks[0]).id;
}

function todayDayKey(){
  const start = parseDay(week.start);
  for (let i = 0; i < 5; i++) if (sameDay(addDays(start, i), new Date())) return DAY_KEYS[i];
  return "mon";
}

/* ───────────────────────── plan mode ───────────────────────── */
function renderHero(){
  // The school week is the one that belongs to a class; a topic track is ours,
  // so it wears the topic's own name in that slot instead.
  const who = isSchool() ? index.class : `${topic.emoji} ${topic.name}`;
  // A week doc may name its own monthly focus; when it doesn't, the school's
  // calendar already knows it, and the calendar is the copy that can't drift.
  const focus = week.monthlyFocus
    || (isSchool() ? calendarWeekFor(week.start)?.month.focus : null);
  $("heroEyebrow").textContent = [who, week.label, focus].filter(Boolean).join(" · ");
  $("heroTheme").textContent = week.themeSub ? `${week.theme} — ${week.themeSub}` : week.theme;
  $("heroIntro").textContent = week.intro || "";
  const gelds = week.gelds || [];
  // A track we wrote ourselves is measured against nothing official, so it
  // names its own list — or has none, and the whole disclosure goes away.
  $("geldsBox").hidden = !gelds.length;
  $("geldsLabel").textContent = week.focusLabel || "What the school is measuring";
  const list = $("geldsList");
  list.innerHTML = "";
  gelds.forEach(g => {
    const li = el("li");
    if (g.code) li.append(el("b", null, g.code), " ");
    li.append(g.text);
    list.appendChild(li);
  });
}

/* Every track has activities; only the school's are arranged as a five-day
 * grid, because that is the shape of the poster it comes from. A track with no
 * `days` is a handful of things to try any evening, which is all a topic we
 * invented can honestly claim to be. */
function hasDays(){ return Boolean(week.days && week.days.length); }

/* The in-class visit: a parent's turn in the classroom, carrying the week's
 * one lesson back to the whole class. It's the school's week's sixth comb,
 * keyed under "visit" so its ticks count on the week bar and the Map like
 * any day's, and it never touches the five-day arithmetic Day by Day does. */
const VISIT_KEY = "visit";
function hasVisit(){ return Boolean(hasDays() && week.visit && (week.visit.moves || []).length); }

function moveCount(dk){
  let done = 0, total = 0;
  const tally = key => {
    if (get("checks", key, false)) done++;
    if (get("stretch", key, false)) done++;
    total += 2;
  };
  // The class visit has no every-day strip: it isn't a day, it's a job.
  if (dk === VISIT_KEY){
    (week.visit?.moves || []).forEach((_, i) => tally(K(VISIT_KEY, i)));
    return { done, total };
  }
  const day = week.days.find(d => d.key === dk);
  if (!day) return { done, total };
  // The every-day ritual is part of the day, so it fills the comb like anything
  // else. It lives in its own key namespace, so adding the strip to a running
  // week doesn't disturb a single tick already made against that day's moves.
  (week.daily || []).forEach((m, i) => tally(dailyKey(dk, m, i)));
  day.moves.forEach((_, i) => tally(K(dk, i)));
  return { done, total };
}

function renderComb(){
  const comb = $("comb");
  comb.innerHTML = "";
  comb.hidden = !hasDays();
  if (!hasDays()) return;
  const start = parseDay(week.start);
  week.days.forEach((d, i) => {
    const { done, total } = moveCount(d.key);
    const date = addDays(start, i);
    const b = el("button", "cell" + (done === total && total ? " done" : "") + (sameDay(date, new Date()) ? " today" : ""));
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(dayKey === d.key));
    b.setAttribute("aria-label", `${DAY_SHORT[d.key]} — ${d.title}, ${done} of ${total} done`);
    b.innerHTML =
      `<span class="hex"><span class="fill" style="height:${total ? (done / total * 100) : 0}%"></span></span>` +
      `<span class="lbl">${DAY_SHORT[d.key]}<small>${MONTHS[date.getMonth()]} ${date.getDate()}</small></span>`;
    b.onclick = () => { dayKey = d.key; renderPlan(); };
    comb.appendChild(b);
  });
  // The sixth comb: the week's in-class visit. It floats — whichever day the
  // teacher gives us — so it wears no date, and it sits after Friday because
  // it's the week's lesson brought back to the class, not a day of it.
  if (hasVisit()){
    const { done, total } = moveCount(VISIT_KEY);
    const b = el("button", "cell visit" + (done === total && total ? " done" : ""));
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(dayKey === VISIT_KEY));
    b.setAttribute("aria-label", `In class — ${week.visit.title}, ${done} of ${total} done`);
    b.innerHTML =
      `<span class="hex"><span class="fill" style="height:${total ? (done / total * 100) : 0}%"></span></span>` +
      `<span class="lbl">🏫<small>In class</small></span>`;
    b.onclick = () => { dayKey = VISIT_KEY; renderPlan(); };
    comb.appendChild(b);
  }
}

/* The week's scoreboard, in the same two numbers the Map keeps: class-level
 * ticks out of moves, and games with at least one star. Stretch ticks fill the
 * day hexes but not this bar — extra credit, not the bar to clear. The button
 * writes one flag, `<weekId>:done` in `checks`, so Reset and the server's
 * prefix-delete already know how to clear it. */
function renderWeekMeter(){
  const box = $("weekbar");
  const p = stopProgress(week, weekId);
  box.hidden = !(p.moves || p.games);
  if (box.hidden) return;
  const status = stopStatus(p, week.start);
  box.innerHTML = "";

  const head = el("div", "weekbar-head");
  const word = `${STATUS_MARK[status]} ${STATUS_WORD[status]}`.trim();
  head.append(el("h2", null, "This week so far"),
    el("span", "weekbar-status" + (status === "done" ? " ok" : ""), word));
  box.appendChild(head);

  const meters = el("div", "weekbar-meters");
  const meter = (label, on, total, unit) => {
    const m = el("div", "wm");
    const track = el("span", "wm-bar");
    const fill = el("span", "wm-fill");
    fill.style.width = (total ? on / total * 100 : 0) + "%";
    track.appendChild(fill);
    m.append(el("span", "wm-lab", label), track, el("span", "wm-num", `${on} of ${total}${unit}`));
    return m;
  };
  if (p.moves) meters.appendChild(meter("Learn", p.ticked, p.moves, " ticked"));
  if (p.games) meters.appendChild(meter("Play", p.played, p.games, " games"));
  box.appendChild(meters);

  // Folded shut: it explains the two bars once, and after the first week it is
  // three lines of read-it-already between them and the button.
  const how = el("details", "weekbar-how");
  how.append(el("summary", null, "What counts here"), el("p", "school",
    "🍯 ticks here and games he's played in Play are what count — the same numbers the Map keeps. ⭐ stretch ticks are extra credit."));
  box.appendChild(how);

  // The button only overrides the arithmetic, so it goes away in the two cases
  // where there is nothing to override: a week the counts already finished, and
  // one whose Monday hasn't come — the lock the map draws is a real fact about
  // the calendar, not a score to beat.
  const bare = stopStatus({ ...p, done: false }, week.start);
  // A week already flagged keeps its undo either way, so a stray tap on a
  // future week is never a one-way door.
  if (bare !== "done" && (bare !== "soon" || p.done)){
    const btn = el("button",
      p.done ? "reset" : "btn ghost",
      p.done ? "Reopen the week" : "Call this week done");
    btn.onclick = () => { set("checks", K("done"), !p.done); renderPlan(); };
    box.appendChild(btn);
  }
}

function renderDay(){
  const box = $("moves");
  if (dayKey === VISIT_KEY && hasVisit()){
    const v = week.visit;
    $("dayTitle").textContent = `In class — ${v.title}`;
    $("daySchool").innerHTML = v.note || "";
    $("daySchool").hidden = !v.note;
    box.innerHTML = "";
    v.moves.forEach((m, i) => box.appendChild(moveNode(m, K(VISIT_KEY, i))));
    return;
  }
  // A track with no five-day grid still has a day card — it just holds the
  // every-day strip and nothing else, keyed to one bucket rather than five.
  const d = hasDays() ? (week.days.find(x => x.key === dayKey) || week.days[0]) : null;
  const dk = d ? d.key : "any";
  $("dayTitle").textContent = d ? `${DAY_SHORT[d.key]} — ${d.title}` : (week.tryTitle || "Try these any evening");
  $("daySchool").innerHTML = d ? d.school : (week.tryNote || "");
  $("daySchool").hidden = !d && !week.tryNote;

  box.innerHTML = "";

  // Things the teacher asked us to do EVERY day sit above the day's own
  // activities, ticked per day so Tuesday's rep doesn't cross off Wednesday's.
  const daily = week.daily || [];
  if (daily.length){
    const strip = el("div", "daily");
    if (d) strip.appendChild(el("p", "daily-h", "Every day this week"));
    daily.forEach((m, i) => strip.appendChild(moveNode(m, dailyKey(dk, m, i))));
    box.appendChild(strip);
  }

  if (d) d.moves.forEach((m, i) => box.appendChild(moveNode(m, K(d.key, i))));
}

/* The every-day items are the ones most likely to be edited in the middle of a
 * running week — that's the whole point of them — so they key off an `id` the
 * author gives them rather than their position in the array. Reordering the
 * strip then moves the item and its five ticks together. Position is only the
 * fallback for a week whose author didn't give them ids. */
function dailyKey(dk, m, i){ return K(dk, "daily", m.id || i); }

/* One activity — the class version, and under it the same thing pushed to his
 * level. Both tick independently; `key` is what tells them apart in state. */
function moveNode(m, key){
  const baseOn = get("checks", key, false);
  const upOn = get("stretch", key, false);

  const wrap = el("div", "move" + (baseOn ? " done" : ""));

  // base activity — the version his class is doing
  const top = el("div", "move-top");
  const tick = el("button", "tick", baseOn ? "🍯" : "");
  tick.setAttribute("aria-pressed", String(baseOn));
  tick.setAttribute("aria-label", `Mark ${m.title} done`);
  tick.onclick = () => { set("checks", key, !baseOn); renderPlan(); };
  const body = el("div", "body");
  // Namespaced: a bare slot class collides with the layout classes of the same
  // name — "book" once picked up the book-list rule and stretched the time chip
  // across the card.
  body.appendChild(el("span", "when slot-" + m.slot, m.when));
  body.appendChild(el("h3", null, m.title));
  body.appendChild(el("p", null, m.do));
  // A move that names one of the week's songs gets a door straight to it:
  // Play, the sing-along open, words lit — the iPad on the classroom table.
  const song = m.song && gameList().find(g => g.id === m.song);
  if (song){
    const go = el("button", "btn ghost sing", `${song.emoji} Sing it`);
    go.onclick = () => { setMode("play"); openGame(song); };
    body.appendChild(go);
  }
  top.append(tick, body);
  wrap.appendChild(top);

  // stretch — his level
  const lv = el("div", "level" + (upOn ? " done" : ""));
  const lt = el("button", "tick", upOn ? "⭐" : "");
  lt.setAttribute("aria-pressed", String(upOn));
  lt.setAttribute("aria-label", `Mark the harder version of ${m.title} done`);
  lt.onclick = () => { set("stretch", key, !upOn); renderPlan(); };
  const lb = el("div", "level-b");
  // The child's name rather than a pronoun: the demo ships a different kid
  // and nobody stated their pronouns, and "Sam's level" reads warmer anyway.
  lb.appendChild(el("p", "level-h", `${index.child}'s level`));
  lb.appendChild(el("p", null, m.stretch));
  if (m.skill) lb.appendChild(el("span", "skill", m.skill));
  lv.append(lt, lb);
  wrap.appendChild(lv);

  return wrap;
}

function renderBooks(){
  const box = $("books");
  box.innerHTML = "";
  // Read-alouds are school's; a track with no verified videos hides the card
  // rather than showing an empty shelf.
  $("booksCard").hidden = !(week.books || []).length;
  (week.books || []).forEach(bk => {
    const row = el("div", "book");
    const spine = el("div", "spine");
    spine.style.background = bk.spine || "var(--sky)";
    const body = el("div");
    body.appendChild(el("h3", null, bk.title));
    body.appendChild(el("p", "by", bk.author));
    const ask = el("p");
    ask.append(el("em", null, "Ask: "), bk.ask);
    body.appendChild(ask);
    if (bk.askStretch){
      const up = el("p", "up");
      up.append(el("em", null, `${index.child}'s level: `), bk.askStretch);
      body.appendChild(up);
    }
    const watch = el("div", "watch");
    (bk.videos || []).forEach((v, i) => {
      const b = el("button", i ? "alt" : "", (i ? "" : "▶ ") + v.label);
      b.onclick = () => openVideo(v, bk.title, bk.ask);
      watch.appendChild(b);
    });
    body.appendChild(watch);
    row.append(spine, body);
    box.appendChild(row);
  });
}

/* What came home from school this week. Pure content — a week with no notices
 * hides the card entirely, so nothing here needs code next Monday. */
function renderNotices(){
  const items = week.notices || [];
  $("noticesCard").hidden = !items.length;
  const list = $("noticesList");
  list.innerHTML = "";
  items.forEach((n, i) => {
    // Only the ones that are actually a task get a tick; "practice this at
    // home" is never finished, and a box that can't honestly be closed is
    // noise. Those live in the every-day strip instead.
    const on = n.todo ? get("notices", K("notice", i), false) : false;
    const li = el("li", "notice" + (on ? " done" : ""));
    if (n.todo){
      const t = el("button", "tick", on ? "🍯" : "");
      t.setAttribute("aria-pressed", String(on));
      t.setAttribute("aria-label", `Mark "${n.title}" done`);
      t.onclick = () => { set("notices", K("notice", i), !on); renderNotices(); };
      li.appendChild(t);
    }
    const b = el("div", "notice-b");
    b.appendChild(el("h3", null, n.title));
    b.appendChild(el("p", null, n.text));
    li.appendChild(b);
    list.appendChild(li);
  });
}

function renderGoals(){
  const fill = (node, arr) => { node.innerHTML = ""; (arr || []).forEach(g => node.appendChild(el("li", null, g))); };
  const goals = week.goals || {};
  // A topic track has no class to be measured against, so it gets one column —
  // his — and the empty half of the split collapses rather than sitting there
  // with a heading over nothing.
  const cls = goals.class || [];
  $("goalsCard").hidden = !cls.length && !(goals.his || []).length && !week.weekend;
  $("goalsClassCol").hidden = !cls.length;
  $("goalsTitle").textContent = week.goalsTitle || "What he should have by Friday";
  $("goalsHisHead").textContent = index.child;
  fill($("goalsClass"), cls);
  fill($("goalsHis"), goals.his);
  $("weekend").innerHTML = week.weekend ? "<b>Weekend bonus:</b> " + week.weekend : "";
  $("weekend").hidden = !week.weekend;
}

/* What's coming, off the school's own year map.
 *
 * The weekly poster arrives on a Monday and the question it never answers is
 * the one asked on Friday afternoon — what is next week about, and is there a
 * break in it. Both are on the August calendar, so the card leads with the four
 * weeks either side of today and keeps the other thirty-six folded away. */
function renderTerm(){
  const card = $("termCard");
  const weeks = isSchool() ? calendarWeeks() : [];
  card.hidden = !weeks.length;
  if (!weeks.length) return;

  const today = new Date();
  /* A row runs until the NEXT row starts, rather than for a flat seven days.
   * December's is deliberately a fortnight — "Dec 21–Jan 1" — and it is the row
   * carrying the closure notice, so a hard +7 retired it on the 28th: for the
   * whole week a parent most needs telling the school is shut, the card skipped
   * it and opened on January. The last row of the year has nothing following it
   * and keeps the week. */
  const ends = weeks.map((w, i) =>
    weeks[i + 1] ? parseDay(weeks[i + 1].start) : addDays(parseDay(w.start), 7));
  // The first row that hasn't finished yet: the current one during term, and
  // the one on the far side of the summer once the year has run out.
  const at = weeks.findIndex((w, i) => today < ends[i]);
  // Only one row can be current, and none is before the year starts — so the
  // "Now" pill is decided once here instead of re-derived at each render site.
  const here = at >= 0 && today >= parseDay(weeks[at].start) ? weeks[at].start : null;
  const ahead = at < 0 ? weeks.slice(-1) : weeks.slice(at, at + 4);
  const month = ahead[0].month;

  $("termNow").textContent =
    `${month.name} is ${month.focus}. Every Monday's poster comes off this map, so next week's theme is already known.`;

  const next = $("termNext");
  next.innerHTML = "";
  ahead.forEach(w => {
    const now = w.start === here;
    const li = el("li", "term-w" + (now ? " now" : ""));
    // The pill carries the dates for every week but the current one, where
    // "Now" is the more useful word and the dates move down a line.
    li.appendChild(el("span", "term-when", now ? "Now" : w.label));
    const b = el("div", "term-b");
    b.appendChild(el("h3", null, w.theme));
    // The month only gets said when it CHANGES. Repeating "August · Welcome to
    // Preschool" under four August weeks, directly below a line that just said
    // it, is noise; the one place it matters is the week the focus turns over.
    const sub = now ? w.label
      : w.month !== month ? `${w.month.name} · ${w.month.focus}`
      : null;
    if (sub) b.appendChild(el("p", null, sub));
    if (w.note) b.appendChild(el("p", "term-note", w.note));
    li.appendChild(b);
    next.appendChild(li);
  });

  const year = $("termYear");
  year.innerHTML = "";
  (curriculum.months || []).forEach(m => {
    const box = el("div", "term-m");
    box.appendChild(el("h3", null, `${m.emoji || ""} ${m.name} — ${m.focus}`.trim()));
    const ul = el("ul");
    (m.weeks || []).forEach(w => {
      const li = el("li", w.start === here ? "now" : null);
      li.append(el("b", null, w.label), " " + w.theme);
      if (w.note) li.append(el("i", null, ` — ${w.note}`));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    year.appendChild(box);
  });
}

let noteTimer = null;
function renderNotes(){
  const ta = $("notes");
  const saved = get("notes", weekId, "");
  if (ta.value !== saved && document.activeElement !== ta) ta.value = saved;
  const meta = $("noteMeta");
  meta.textContent = state.updatedAt
    ? `Last change ${new Date(state.updatedAt).toLocaleString()}${state.updatedBy ? " · " + state.updatedBy : ""}`
    : "";
}
$("notes").addEventListener("input", e => {
  clearTimeout(noteTimer);
  const v = e.target.value;
  noteTimer = setTimeout(() => set("notes", weekId, v), 600);
});

function renderPlan(){
  renderHero();
  renderComb();
  renderWeekMeter();
  renderDay();
  renderNotices();
  renderBooks();
  renderGoals();
  renderTerm();
  renderNotes();
}

$("reset").onclick = async () => {
  if (!confirm(`Clear every check, feeling and note for ${week.label}?`)) return;
  for (const b of BUCKETS)
    for (const k of Object.keys(state[b]))
      if (k.startsWith(weekId + ":") || k === weekId) delete state[b][k];
  mirror();
  renderPlan();
  if (mode === "play") renderPlayHome();
  if (!syncEnabled){ syncMsg("Week cleared"); return; }
  try {
    adopt(await asJson(await fetch("/api/state", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: weekId }),
    })));
    syncMsg("Week cleared");
  } catch (e) { offline(e); }
};

/* ───────────────────────── play mode ───────────────────────── */
const HONEY_TARGET = 40;

/* The family picture at the top of Play. It is markup rather than something
 * rendered, because it never changes between renders — but it does have to
 * survive not being there: public/photos is one of the directories the public
 * fork drops, so the frame stays hidden until the file actually arrives.
 *
 * `complete` is not belt and braces. This script is at the end of the body and
 * the picture is 150KB off the same origin, so on a warm cache it has already
 * finished by the time we get here — the events never fire and the frame stays
 * hidden forever. Which is exactly what it did the first time. */
(() => {
  const img = $("playPhotoImg"), frame = $("playPhoto");
  const show = () => { frame.hidden = false; };
  const drop = () => { frame.remove(); };
  if (img.complete) (img.naturalWidth ? show : drop)();
  img.onload = show;
  img.onerror = drop;
})();

/* Games run on timers: a right answer paints for a second before the next
 * question. If he taps Back, flips to Plan, switches week or changes band in
 * that second, the timer still fires — and the iPad reads the next question
 * out loud over the game picker. Every entry and exit bumps this; `later`
 * drops anything scheduled by a game that is no longer on screen. */
let playGen = 0;
function later(fn, ms){
  const gen = playGen;
  return setTimeout(() => { if (gen === playGen) fn(); }, ms);
}

/* Move on when the answer has finished being SAID, not on a stopwatch.
 *
 * Every one of these rounds ends by speaking and then opening the next one,
 * which speaks again — and speaking cancels whatever is still playing. Measured
 * against the recordings, the fixed gaps were shorter than the lines they were
 * meant to cover: "Yes. That is the number 7." runs 1.76s behind a 1.1s gap,
 * and What Helps says a 3.7–4.2s sentence behind a 2.2s one. He heard "Yes,
 * that is the numb—" and then a new question. The whole point of What Helps is
 * that sentence.
 *
 * `gap` is the beat AFTER the voice stops, so the game still breathes. `silent`
 * is the whole wait when there is nothing to say (sound off), which is where
 * the old fixed numbers still belong. The backstop covers a browser that never
 * reports the end — iOS drops it if the tab backgrounds mid-sentence — so a
 * missed event can never strand the game. Both paths go through `later`, so
 * leaving the screen still cancels them. */
function afterSaying(said, fn, { gap = 650, silent = 1100, backstop = 9000 } = {}){
  if (!said) return later(fn, silent);
  let moved = false;
  const go = () => { if (!moved){ moved = true; later(fn, gap); } };
  said.onEnd(go);
  later(go, backstop);
}

/* A four-year-old double-taps. Every game that answers a tap by scoring it and
 * then scheduling the next round a beat later has the same hole: the buttons are
 * still live during that beat, so the second tap scores the same question again
 * AND consumes the round after it — six questions become three, and the game
 * ends early with a full score it didn't earn.
 *
 * Number Hive and Match still carry their own `locked` flag for this; Day by
 * Day and Code the Bee have been moved onto this one. It is that flag, once,
 * for the engines: the gate opens as a round paints and the first ACCEPTED
 * answer closes it. Wrong answers deliberately leave it open — he keeps trying
 * until he gets it.
 *
 * A CLOSED gate ignores every tap, not just a repeat of the one accepted. A
 * wrong tap landing in the beat after a right one is the more damaging version
 * of the same bug: it counted a miss he didn't make (which is what decides
 * whether he keeps his level), painted over the praise, and cut the recorded
 * answer off mid-sentence. And because cancelling a clip pauses it rather than
 * ending it, the handle the round was waiting on never fired — so the next
 * question sat there for the full nine-second backstop. Hence `swallowed()`,
 * checked before anything else a tap might do — and, since it is only ever
 * called by a tap that is about to be dropped, the place the tick and the dim
 * belong. `busy()` is the same question without the noise, for the one caller
 * that is not a tap: Day by Day reading the choices out. */
function roundGate(box){
  let open = true;
  /* The dim belongs here rather than at each call site, because the gate is the
   * only thing that knows. He can't read the prompt and he can't hear that the
   * voice hasn't finished — all he has is the board, and a board that looks
   * exactly as live as it did a second ago is one he keeps tapping. */
  const paint = () => { if (box) box.classList.toggle("busy", !open); };
  return {
    busy(){ return !open; },
    /* The tap-handler form of the same question. A dropped tap gets the pack's
     * tap noise played quiet — not a new recording, because a soft version of
     * the sound a tap already makes says "heard you, not yet", where the
     * wrong-answer bloop would tell him he got something wrong when all he did
     * was tap early. */
    swallowed(){ if (open) return false; sfx("tap", 0.18); return true; },
    take(){ if (!open) return false; open = false; paint(); return true; },
    reopen(){ open = true; paint(); },
  };
}

/* ── the hint ladder ──
 *
 * A wrong tap used to get "That one is X. Try again." and nothing else, however
 * many times it came. A round he genuinely cannot do is then a round somebody
 * in the room has to rescue him out of, and the game he opened by himself
 * becomes the game he gets stuck in. So the board gets easier instead: two
 * wrong taps rule half the wrong pictures out, three put a ring on the right
 * one and say so out loud.
 *
 * The misses still count. Being shown the answer is not the same as knowing it,
 * and misses are the whole of what `nudgeLevel` reads on these games — a board
 * he was hinted through is exactly the board that should open a level easier
 * tomorrow.
 *
 * One ladder per game, re-opened as each round paints. Letter Hunt is the odd
 * one: the whole board is a single round there, with several right answers at
 * once, so it opens once and hands over all of them. */
const HINT_SAY = "It is this one.";
function hintLadder(){
  let wrongs = [], rights = [], taps = 0;
  const tried = new Set();
  return {
    open(wrongChoices, rightChoices){
      [...wrongs, ...rights].forEach(b => b.classList.remove("ruled-out", "this-one"));
      wrongs = wrongChoices.filter(Boolean);
      rights = rightChoices.filter(Boolean);
      taps = 0; tried.clear();
    },
    /* One wrong tap, already scored as a miss by the engine. Hands back the line
     * to say after the engine's own correction, or "" while the ladder has
     * nothing to add yet. */
    miss(b){
      taps++;
      if (b) tried.add(b);
      if (taps === 2){
        /* Half of them, rounded up, and never the last one — a board with one
         * picture on it is not a question. The ones he has already ruled out go
         * first, so the taps he spent are what buys the help. Two big buttons
         * have nothing to halve, which is why the sorting games skip straight
         * to the ring. */
        const order = [...wrongs].sort((x, y) => (tried.has(y) ? 1 : 0) - (tried.has(x) ? 1 : 0));
        order.slice(0, Math.min(Math.ceil(wrongs.length / 2), wrongs.length - 1))
          .forEach(x => x.classList.add("ruled-out"));
      }
      if (taps >= 3){
        // One ring at a time, and past the ones he has already found — both of
        // which are only ever Letter Hunt, where the board holds several right
        // answers and the ladder points at whichever is still open.
        rights.forEach(x => x.classList.remove("this-one"));
        const target = rights.find(x => !x.classList.contains("right")) || rights[0];
        if (target){ target.classList.add("this-one"); return HINT_SAY; }
      }
      return "";
    },
    /* A right choice has been taken. Letter Hunt is the only board where that
     * happens without the round ending, and a word he has now found must stop
     * pointing at itself. It does NOT re-point at the next one: help escalates
     * on misses, and getting one right is not being stuck. */
    found(b){ if (b) b.classList.remove("this-one"); },
  };
}

/* ── progression ──
 *
 * A game that is the same difficulty on the fortieth play as the first is a
 * game he stops opening. One number per game, 1 to 3, and it moves on its own:
 * a clean board takes him up, a rough one puts him back. What a level MEANS is
 * the game's own business — more tiles, more choices, harder words — this only
 * remembers where he got to and hands it back next time.
 *
 * Synced with the rest of the household state, so the level he reached on the
 * iPad is the level the phone opens at. Two devices moving it the same evening
 * resolve last-write-wins per game, which is the right answer for one child.
 * Levels from before this synced live under hive:lvl:* and are read as the
 * fallback until the first change writes the synced copy. The row of pills is
 * there so a grown-up can move it by hand when the auto-nudge reads the evening
 * wrong — a tired night is not a demotion. */
const LEVELS = 3;
const LVL_KEY = id => `hive:lvl:${id}`;
/* Null when the game has never moved — which is also "has never been played",
 * since only the auto-levelled games write one. The map uses that to show
 * levels for exactly the games that have some history, and nothing for a
 * game he hasn't touched. */
function recordedLevel(id){
  const s = get("games", `lvl:${id}`, null);
  if (s >= 1 && s <= LEVELS) return s;
  const n = Number(localStorage.getItem(LVL_KEY(id)));
  return n >= 1 && n <= LEVELS ? n : null;
}
/* `top` is the highest level the loaded board can honestly play. The shared
 * levels (more, trace) are one number across every week, but the boards are
 * not one size: a week that counts to nine cannot deal level 3's piles, and a
 * level 3 earned on that week would open Money's twelve-and-one-apart board at
 * the top. So the board in front of him caps what it reads and what it writes. */
function levelOf(id, top = LEVELS){ return Math.min(recordedLevel(id) || 1, top); }
/* What the map says a game is at: the recorded level, capped the way the board
 * in that week caps it (`top` rides the gameList entry), or null when the game
 * has never moved one. The board and the map must not disagree. */
function shownLevel(g){
  const n = recordedLevel(g.id);
  return n && Math.min(n, g.top || LEVELS);
}
function setLevel(id, n){
  set("games", `lvl:${id}`, Math.max(1, Math.min(LEVELS, n)));
}
/* The highest level whose tier the loaded doc can fill, 1 when none can. */
function tierTop(tiers, fits){
  let top = 1;
  for (let n = 1; n <= LEVELS; n++) if (fits(tiers[n])) top = n;
  return top;
}
/* One reading of a finished board, shared by the level nudge and the history
 * dots so the two can never disagree: 1 earns the next level, -1 hands one
 * back, 0 holds.
 *
 * Clean is a ratio, not a count. The games nobody can lose end at the full
 * score every time — a round ends when the right thing is finally tapped — so
 * the wrong taps on the way are the whole of the evidence, and "one miss
 * forgiven" promoted a six-round board as readily as a ten-round one. Wrong
 * taps at or under a tenth of the rounds, rounded down: none on a board under
 * ten rounds, one on ten. Rough is misses reaching half the rounds, or the
 * score under half on the games that can actually be scored. */
function boardVerdict(got, total, misses = 0){
  const rounds = total || 1;
  if (got === total && misses <= Math.floor(rounds / 10)) return 1;
  if (got * 2 < total || misses * 2 >= rounds) return -1;
  return 0;
}
/* Returns the direction he moved, so the done panel can say so out loud. A
 * clean board at the cap holds rather than writing a level this board cannot
 * play; a rough one still steps down. */
function nudgeLevel(id, got, total, misses = 0, top = LEVELS){
  const was = levelOf(id, top);
  const v = boardVerdict(got, total, misses);
  if (v > 0 && was < top) setLevel(id, was + 1);
  else if (v < 0) setLevel(id, was - 1);
  return levelOf(id, top) - was;
}

/* ── the record ──
 *
 * The last five boards per game, kept under the bare game id like the level so
 * the dots beside the pills are the evidence for that level and not a second
 * opinion. A JSON string, because the Worker stores scalars only. Date, score,
 * misses and the level the board was played at — enough for a grown-up to see
 * whether tonight's level 3 was earned or lucky, which the bare 1–3 never said. */
const HIST_KEEP = 5;
function history(id){
  try {
    const h = JSON.parse(get("games", `hist:${id}`, "[]"));
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}
function recordResult(id, entry){
  set("games", `hist:${id}`, JSON.stringify([...history(id), entry].slice(-HIST_KEEP)));
}
const DOT_CLASS = { 1: "clean", 0: "held", "-1": "rough" };
const histLine = r => `${r.date}: ${r.got} of ${r.total}, ${r.misses} wrong` + (r.level ? `, level ${r.level}` : "");
/* The dots are a button, because the numbers behind them have to be reachable
 * on the iPad: a title tooltip needs a mouse. One tap opens the lines. */
function histDots(id){
  const h = history(id);
  const row = el("span", "hist");
  if (!h.length) return row;
  const dots = el("button", null);
  dots.type = "button";
  dots.setAttribute("aria-label", h.length === 1 ? "Last board" : `Last ${h.length} boards`);
  dots.setAttribute("aria-expanded", "false");
  h.forEach(r => {
    const dot = el("i", DOT_CLASS[boardVerdict(r.got, r.total, r.misses)]);
    dot.title = histLine(r);
    dots.appendChild(dot);
  });
  const detail = el("small", "hist-detail", h.map(histLine).join(" · "));
  detail.hidden = true;
  dots.onclick = () => { detail.hidden = !detail.hidden; dots.setAttribute("aria-expanded", String(!detail.hidden)); };
  row.append(dots, detail);
  return row;
}
/* Those pills were the biggest thing on a game screen after the question:
 * three buttons at his eye line, above every levelled board, each one writing a
 * synced level in the middle of a round. He found them.
 *
 * So they ride the parent gate — `levelset` is what `kidlock` hides, the same
 * class that takes the top bar's right side away in Play. One hold on the bee
 * opens the bar and these together, and the same twenty seconds close both.
 * The Class / his level pickers keep the bare `levelpick` class and stay: those
 * bands are already a grown-up's call, and they are not what he was pressing. */
function levelRow(id, replay, top = LEVELS){
  const pick = el("div", "levelpick levelset");
  for (let n = 1; n <= LEVELS; n++){
    const b = el("button", null, `Level ${n}`);
    b.setAttribute("aria-pressed", String(levelOf(id, top) === n));
    if (n > top){ b.disabled = true; b.title = `This week's board stops at level ${top}`; }
    b.onclick = () => { setLevel(id, n); playGen++; replay(); };
    pick.appendChild(b);
  }
  pick.appendChild(histDots(id));
  return pick;
}

/* Renamed authored games get new bare ids so their levels and history no
 * longer bleed into different boards. Week-scoped stars and last-played days
 * belong to the board the child already finished, so these three published
 * keys remain read aliases. Read both in case a renamed board was played
 * between deployments; the best/latest value wins. */
const GAME_PROGRESS_ALIASES = new Map([
  ["2026-08-17:friends-order", "school-order"],
  ["2026-08-24:school-family", "family"],
  ["2026-08-31:care-review", "care"],
]);
const gameIdOf = game => typeof game === "string" ? game : game.id;
const legacyGameId = (id, game) => GAME_PROGRESS_ALIASES.get(`${id}:${gameIdOf(game)}`);
function weekGameValues(bucket, id, game, suffix = ""){
  return [gameIdOf(game), legacyGameId(id, game)]
    .filter(Boolean)
    .map(gameId => get(bucket, `${id}:${gameId}${suffix}`, undefined))
    .filter(v => v !== undefined);
}
function weekGameStars(id, game){
  const values = weekGameValues("stars", id, game);
  return values.length ? Math.max(...values.map(Number)) : 0;
}
function stars(game){ return weekGameStars(weekId, game); }
/* The day a game last handed out stars — which is the only honest answer to
 * "has he played this tonight", since that is the moment a board is finished.
 * Keyed like the stars themselves, week and game, because the picker is asking
 * about this week's board. Synced, so the iPad knows what the phone did.
 *
 * The week id has to LEAD the key. Both ends of "Clear this week" delete by
 * week prefix — the loop over every bucket here and the same match in the
 * Worker's DELETE — so a key that started `day:` would outlive the stars it
 * belongs to and leave the game sitting under Played today with an empty row
 * of stars, then push that back to the other device. */
function lastPlayed(game){
  const values = weekGameValues("games", weekId, game, ":day");
  return values.length ? values.sort().at(-1) : null;
}
function playedToday(game){ return lastPlayed(game) === todayISO(); }
function award(gameId, n){
  bumpStreak();   // a finished round counts toward the streak even at 0 stars
  const today = todayISO();
  if (lastPlayed(gameId) !== today) set("games", `${K(gameId)}:day`, today);
  const best = Math.max(n, stars(gameId));
  if (best > get("stars", K(gameId), 0)) set("stars", K(gameId), best);   // keep his best, never demote
}

/* ── streak ──
 *
 * Days with at least one finished round, any game, any track, allowing one
 * skipped day between them: a Saturday away is not the end of a run he built
 * all week. One key, "YYYY-MM-DD|n", so two devices the same evening converge
 * on a whole value rather than a torn pair. Read forgivingly: the streak is
 * alive until two whole days have passed with nothing played. */
const isoDay = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function todayISO(){ return isoDay(new Date()); }
/* The Monday this calendar week started on, Sunday included in the week before. */
function weekMondayISO(){
  const d = new Date();
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return isoDay(d);
}
/* Whole calendar days between two ISO dates. Rounded because local midnights
 * across a DST change are 23 or 25 hours apart, which an exact 24-hour
 * quotient would misread as "not a day" — and reset a live streak twice a year. */
const dayGap = (from, to) => Math.round((parseDay(to) - parseDay(from)) / 86400000);
const STREAK_GRACE = 1;   // missed days a streak forgives
function streakDays(){
  const [day, n] = String(get("games", "streak", "|0")).split("|");
  if (!day || !+n) return 0;
  return dayGap(day, todayISO()) <= STREAK_GRACE + 1 ? +n : 0;
}
function bumpStreak(){
  const [day, n] = String(get("games", "streak", "|0")).split("|");
  const today = todayISO();
  if (day === today) return;
  const gap = day ? dayGap(day, today) : Infinity;
  set("games", "streak", `${today}|${gap <= STREAK_GRACE + 1 ? +n + 1 : 1}`);
}

/* ── the honey jar ──
 *
 * This week's honey, not this doc's. The jar used to sum the loaded week's
 * games, so flipping the topic picker emptied it and the school week's stars
 * came back when the picker did — a jar that drains when a grown-up changes a
 * dropdown is not his jar. Now it is every star on every board he finished
 * since Monday, whichever track it sits on, read straight off the synced
 * buckets: `stars` keeps his best per board and `games` keeps the day that
 * board was last finished, so a board counts while its last finish is this
 * week. Monday morning nothing has been finished this week and the jar is
 * empty again, which is the whole point of a target. */
function weekStars(){
  const since = weekMondayISO();
  let sum = 0;
  const aliases = new Set();
  for (const [current, legacyId] of GAME_PROGRESS_ALIASES) {
    const id = current.slice(0, current.indexOf(":"));
    const legacy = `${id}:${legacyId}`;
    aliases.add(current).add(legacy);
    const currentStars = state.games[`${current}:day`] >= since ? Number(state.stars[current] || 0) : 0;
    const legacyStars = state.games[`${legacy}:day`] >= since ? Number(state.stars[legacy] || 0) : 0;
    sum += Math.max(currentStars, legacyStars);
  }
  for (const [k, n] of Object.entries(state.stars))
    if (!aliases.has(k) && state.games[`${k}:day`] >= since) sum += n;
  return sum;
}
const JAR_FULL = "Your honey jar is full!";
/* Week-suffixed, like the streak is bare: a key that LED with the Monday would
 * match the school week's id, and "Start this week over" would take the marker
 * with the stars — leaving a jar still full of topic honey to burst again. */
const jarKey = () => `jar:${weekMondayISO()}`;
/* What Play says about the jar on the way in. The count is in the sentence,
 * one recording per number, because "Six." "more stars fill your honey jar."
 * is two clips with a seam in the middle of the one line that matters. */
function jarLine(total){
  const left = HONEY_TARGET - total;
  if (left <= 0) return JAR_FULL;
  return `${left} more ${left === 1 ? "star fills" : "stars fill"} your honey jar.`;
}

const hello = () => `Hi ${index.child}! Pick a game.`;
/* `greeting` is the line Play opens on; every other way back to this screen
 * arrives silent. The jar speaks here because this is where the jar IS: the
 * board that filled it said its own praise, and the moment he comes back to
 * see the jar is the moment to say so — once a week, with a burst of its own,
 * so the fortieth star looks different from the thirty-ninth.
 *
 * Neither happens off the cached mirror. Boot paints from it before the
 * server's copy arrives, and the other device may have filled the jar since
 * this one last synced: a count said off the cache is wrong out loud, and a
 * burst off it is the once-a-week burst twice. The paint goes ahead; the
 * words and the marker wait for the pull, which greets on the way out. */
function renderPlayHome(greeting){
  playGen++;
  $("playHome").hidden = false;
  $("playGame").hidden = true;
  $("gameStage").innerHTML = "";
  hush();
  musicStart();

  $("playHi").textContent = `Hi ${index.child}!`;
  const total = weekStars();
  const full = total >= HONEY_TARGET;
  $("jarCount").textContent = total;
  $("jarFill").style.height = Math.min(100, total / HONEY_TARGET * 100) + "%";
  const first = synced && full && !get("games", jarKey(), false);
  if (first){
    set("games", jarKey(), true);
    celebrate(["🍯", "🐝", "⭐", "🍯"], 40);
    const jar = $("jar");
    jar.classList.remove("full");
    void jar.offsetWidth;   // restart the animation on a second fill this session
    jar.classList.add("full");
  }
  if (synced && (greeting || first)) say([greeting, first ? JAR_FULL : greeting ? jarLine(total) : ""]);
  // One day is just today; the streak becomes a thing worth saying at two.
  const run = streakDays();
  $("playStreak").hidden = run < 2;
  $("playStreak").textContent = run >= 2 ? `🔥 ${run} days in a row!` : "";

  const tiles = $("tiles");
  tiles.innerHTML = "";
  const tile = g => {
    const t = el("button", "tile");
    t.append(
      el("div", "tile-emoji", typeof g.emoji === "function" ? g.emoji() : g.emoji),
      el("div", "tile-name", typeof g.name === "function" ? g.name() : g.name),
      el("div", "tile-sub", g.sub),
      el("div", "tile-stars", "⭐".repeat(Math.min(5, stars(g))))
    );
    t.onclick = () => { sfx("tap"); openGame(g); };
    return t;
  };
  /* A full school week deals sixteen tiles in the order the doc happens to list
   * them, which is a wall. The one thing that actually sorts them tonight is
   * whether he has already had that game tonight, so the ones he hasn't come
   * first. The played ones stay on the page underneath rather than vanishing —
   * playing a favourite twice is allowed, it just isn't the first thing he
   * sees — and a heading only appears when it has tiles under it, so the first
   * play of the day is one "Today" over the whole grid. */
  const list = gameList();
  [["Today", list.filter(g => !playedToday(g))],
   ["Played today", list.filter(g => playedToday(g))]].forEach(([label, games]) => {
    if (!games.length) return;
    tiles.append(el("h2", "tiles-head", label), ...games.map(tile));
  });
}

function openGame(g){
  playGen++;
  // A tune under a question being read out is just noise.
  musicStop();
  $("playHome").hidden = true;
  $("playGame").hidden = false;
  $("gameStage").innerHTML = "";
  g.run($("gameStage"));
}

$("backBtn").onclick = () => renderPlayHome();

/* small building blocks the games share */
function stageShell(host, title){
  const s = el("div", "stage");
  s.appendChild(el("h2", null, title));
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const opts = el("div", "opts");
  const fb = el("div", "fb");
  s.append(bar, prompt, opts, fb);
  host.appendChild(s);
  return { s, bar, prompt, opts, fb };
}
function setPrompt(node, text, spoken, sayOpts){
  node.innerHTML = "";
  node.append(text);
  const b = el("button", "say", "🔊");
  b.setAttribute("aria-label", "Say it again");
  b.onclick = () => say(spoken || text, sayOpts);
  node.appendChild(b);
  return say(spoken || text, sayOpts);
}
function scoreDots(bar, got, total){
  bar.textContent = "⭐".repeat(got) + "·".repeat(Math.max(0, total - got));
}
/* The end of a round is the most-heard sentence in the app, and it is a parent
 * saying it. One fixed line turned into furniture — he stopped hearing it — so
 * the praise rotates and never lands on the line it used last. Recorded like
 * everything else, which is the whole reason there are five and not fifty. */
function praiseLine(perfect){
  const pool = perfect
    ? ["You got all of them! Great job.",
       `Every single one, ${index.child}!`,
       "That was perfect. I am proud of you.",
       "All of them. You worked hard on that."]
    : ["Nice work!",
       `Nice work, ${index.child}.`,
       "That was good thinking.",
       "You kept going. That is the part that counts."];
  return freshSample(`praise${perfect ? 1 : 0}`, pool.map(text => ({ text })), 1)[0].text;
}
/* The singing gets its own praise: "that was good thinking" is a game line,
 * and the end of a song deserves to be about the singing. Recorded in his
 * the same voice as the rest, rotating the same way. */
function singPraise(){
  const pool = [
    `You sang the whole song, ${index.child}!`,
    "I love hearing you sing.",
    "That was beautiful singing.",
    "We can sing it again anytime.",
  ];
  return freshSample("praiseSing", pool.map(text => ({ text })), 1)[0].text;
}

/* A real moment, not just a line: a burst of falling emoji over the whole
 * screen. Only for the finishes that earned it — a whole song sung, a perfect
 * board at the top of a game's ladder — because confetti every round would
 * stop being confetti. Cleans itself up; taps fall straight through it. */
function celebrate(bits = ["🎉", "⭐", "🍯", "✨", "🎊"], count = 24){
  const burst = el("div", "burst");
  for (let i = 0; i < count; i++){
    const b = el("span", null, bits[i % bits.length]);
    b.style.left = Math.random() * 100 + "%";
    b.style.animationDelay = Math.random() * 0.6 + "s";
    b.style.fontSize = 18 + Math.random() * 22 + "px";
    burst.appendChild(b);
  }
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 3200);
}

/* `levels: true` opts a game into the progression above. Only the games whose
 * difficulty this file actually controls take it — the ones with their own
 * class/stretch picker are set by a grown-up and must not drift underneath. */
function donePanel(host, gameId, got, total, again, { levels = false, misses = 0, top = LEVELS } = {}){
  hush();
  host.innerHTML = "";
  recordResult(gameId, { date: todayISO(), got, total, misses, level: levels ? levelOf(gameId, top) : null });
  const moved = levels ? nudgeLevel(gameId, got, total, misses, top) : 0;
  const d = el("div", "stage done-panel");
  const perfect = got === total;
  d.append(
    el("div", "big", perfect ? "🏆" : "🍯"),
    el("h2", null, perfect ? "All of them!" : "Nice work!"),
    el("p", null, `${got} out of ${total}.`)
  );
  // Moving up is the reward; moving back down is not announced. He gets an
  // easier board next time, which is the whole help — being told he lost a
  // level is just the bad round said twice.
  if (moved > 0) d.append(el("p", "levelup", `Level ${levelOf(gameId, top)}! ⭐`));
  // The burst: a clean board at the top of the ladder — the top this board
  // has, which is the cap on a week too small for level 3 — or on a game whose
  // difficulty a grown-up sets, where clean is the whole story. Clean means no
  // wrong taps on the way, not just every round finished: a game he cannot
  // lose always ends at the full score, and confetti every play is wallpaper.
  if (perfect && misses === 0 && (!levels || levelOf(gameId, top) === top)) celebrate();
  // Arrows and a house, because "the honey one" and "the white one" is the
  // whole difference between these two otherwise, and he doesn't read them.
  const a = el("button", "btn", "🔄 Play again");
  a.onclick = () => { playGen++; again(); };
  const b = el("button", "btn ghost", "🏠 Pick another game");
  b.onclick = () => renderPlayHome();
  d.append(a, b);
  host.appendChild(d);
  award(gameId, got);
  sfx("win");
  say([praiseLine(perfect), moved > 0 ? `Level ${levelOf(gameId, top)}!` : ""]);
}

/* ── engine: name it ──
 *
 * "Here is a word, find the picture." Feelings Faces is one instance and it is
 * the one that has been running all along; the topic tracks are the others —
 * the real names for the parts of a body, what the pieces of a robot are
 * called, the words that mean something in code. Same game, different bank.
 *
 * Two lists per bank, not one: `basic` is the vocabulary he should already have
 * and `advanced` is the vocabulary this unit is actually teaching. The level
 * moves WHICH list he's asked for and how many pictures he has to rule out, and
 * both matter — "find Mad" against Lonely and Disappointed is not the same
 * question as "find Mad" against Happy and Sad.
 *
 * An item may carry `say` (how the word is spoken, when the label alone reads
 * wrong out loud — "the heart", not "Heart") and `note`, one sentence of why,
 * said after a right answer. The note is the actual teaching in a naming game;
 * without it he learns which picture, not what it does. */
const NAME_TIERS = {
  1: { from: "basic",    choices: 4, rounds: 6 },
  2: { from: "all",      choices: 5, rounds: 8 },
  3: { from: "advanced", choices: 6, rounds: 8 },
};
const spokenOf = it => it.say || it.label;
/* Which list a tier asks from, and which one its wrong answers come from. */
function nameLists(cfg, tier){
  const basic = cfg.basic || [], advanced = cfg.advanced || [];
  const pool = [...basic, ...advanced];
  // A bank with only one list plays every level off that list rather than
  // handing out an empty board.
  const wanted = tier.from === "basic" ? basic : tier.from === "advanced" ? advanced : pool;
  // Level 1 keeps the wrong answers inside the easy list too, when there are
  // enough of them to fill a board.
  const distractors = tier.from === "basic" && basic.length >= tier.choices ? basic : pool;
  return { asked: wanted.length ? wanted : pool, distractors, pool };
}
const nameChoices = (target, distractors, n) =>
  shuffle([target, ...sample(distractors.filter(f => f.id !== target.id), n - 1)]);

/* One "find the picture" round. `ctx` is the prompt, opts and fb of the stage
 * it plays on plus the gate and hint ladder the board shares between rounds;
 * Old Honey plays these between rounds of other kinds on one stage, which is
 * why the round is not the game. `done(misses)` fires once the right answer
 * and its note have been said. `lead` is a spoken line before the question. */
function nameRound(ctx, target, choices, done, lead){
  const { prompt, opts, fb, gate, hint } = ctx;
  gate.reopen();
  fb.textContent = "";
  let missed = 0;
  setPrompt(prompt, `Find… ${target.label}`, [lead, `Find ${spokenOf(target)}`]);
  opts.innerHTML = "";
  let rightBtn = null; const wrongBtns = [];
  choices.forEach(c => {
    const b = el("button", "opt");
    b.append(el("em", null, c.icon), c.label);
    if (c.id === target.id) rightBtn = b; else wrongBtns.push(b);
    b.onclick = () => {
      if (gate.swallowed()) return;          // this round already has its answer
      if (c.id === target.id){
        gate.take();
        b.classList.add("right"); sfx("right");
        fb.textContent = target.note || `Yes — that's ${target.label}!`;
        fb.className = "fb good";
        // The note gets its own beat: it's a whole sentence, and the point.
        afterSaying(say([`Yes! ${spokenOf(target)}.`, target.note]), () => done(missed),
          target.note ? { gap: 850, silent: 2200 } : {});
      } else {
        missed++;
        b.classList.add("wrong"); sfx("wrong");
        fb.textContent = `That one is ${c.label}. Try again.`; fb.className = "fb soft";
        say([`That one is ${spokenOf(c)}. Try again.`, hint.miss(b)]);
        later(() => b.classList.remove("wrong"), 400);
      }
    };
    opts.appendChild(b);
  });
  hint.open(wrongBtns, [rightBtn]);
}

function gameName(host, cfg){
  const lvl = levelOf(cfg.id);
  const tier = NAME_TIERS[lvl];
  const { asked, distractors, pool } = nameLists(cfg, tier);
  // A list short of the tier's rounds is topped up from the other list rather
  // than dealing a shorter board: six advanced words at level 3 is an eight-
  // round board with two easy ones mixed in, not a six-round one.
  const short = Math.max(0, tier.rounds - asked.length);
  const rounds = shuffle([
    ...freshSample(cfg.id + lvl, asked, Math.min(tier.rounds, asked.length)),
    ...(short ? freshSample(cfg.id + lvl + ":fill", pool.filter(x => !asked.includes(x)), short) : []),
  ]);
  // Wrong answers don't end a round here — he keeps going until he finds it —
  // so the score is a perfect one every time and the taps he got wrong on the
  // way are the only thing that says how it went. Without them the level would
  // climb to 3 on the second board and never come back down.
  let i = 0, got = 0, missed = 0;
  const replay = () => { host.innerHTML = ""; gameName(host, cfg); };
  const { s, bar, prompt, opts, fb } = stageShell(host, cfg.title);
  const ctx = { prompt, opts, fb, gate: roundGate(opts), hint: hintLadder() };
  s.insertBefore(levelRow(cfg.id, replay), bar);

  function round(){
    if (i >= rounds.length) return donePanel(host, cfg.id, got, rounds.length, replay,
      { levels: true, misses: missed });
    scoreDots(bar, got, rounds.length);
    const target = rounds[i];
    nameRound(ctx, target, nameChoices(target, distractors, tier.choices),
      m => { got++; missed += m; i++; round(); });
  }
  round();
}

/* The week's feelings, as a bank for the engine above. The lists are named
 * core/big in the week doc because that is what the school calls them. */
function feelingsBank(w = week){
  const F = w.games.feelings;
  return { id: "faces", title: "Feelings Faces", basic: F.core, advanced: F.big };
}

/* ── game 2: Number Hive ──
 *
 * Numeral recognition, and only that.
 *
 * It used to open with "tap 1 to 11" and then "now backwards", and both were
 * GATES: twenty-two ordered taps before the game would hand him the thing he
 * actually came to it for, which is picking a number he's been asked for by
 * name. Getting stuck at 6 meant never seeing the rest of the game. Counting
 * has its own tile now, where skipping it costs nothing. */

/* Number Hive and Count the Hive are the same numbers, so they share the band
 * the week's author set rather than each keeping their own. */
/* Per TOPIC, and still shared between Number Hive and Count the Hive inside it.
 * One global key could not survive two tracks with different bands: choosing his
 * 20 on the school week and then opening Money, which runs 10 and 21, matched
 * neither — so it silently dropped to the easy band, and choosing 21 there
 * overwrote the 20 so the school week dropped too. Where he is, is a grown-up's
 * call; changing subject shouldn't quietly undo it.
 *
 * The un-namespaced key is still read as a fallback, so the band already set on
 * the school week survives this change. */
const LEGACY_BAND_KEY = "hive:nummax";
const numBandKey = () => `hive:nummax:${topic.id}`;
function numBand(){
  const cfg = week.games.numbers;
  const fits = n => n === cfg.classMax || n === cfg.stretchMax;
  const saved = Number(localStorage.getItem(numBandKey()));
  if (fits(saved)) return saved;
  const legacy = Number(localStorage.getItem(LEGACY_BAND_KEY));
  return fits(legacy) ? legacy : cfg.classMax;
}
function bandPicker(max, onPick){
  const cfg = week.games.numbers;
  const pick = el("div", "levelpick");
  // "Class" is only the right word on a school week; a topic track names its own
  // easy band, because there is no class to be level with.
  [[cfg.easyLabel || "Class", cfg.classMax], [`${index.child}'s level`, cfg.stretchMax]].forEach(([label, n]) => {
    const b = el("button", null, `${label} · to ${n}`);
    b.setAttribute("aria-pressed", String(max === n));
    b.onclick = () => { localStorage.setItem(numBandKey(), String(n)); onPick(n); };
    pick.appendChild(b);
  });
  return pick;
}
function hiveBoard(max, onTap){
  const hive = el("div", "hive");
  for (let n = 1; n <= max; n++){
    const b = el("button", "num");
    b.setAttribute("aria-label", "Number " + n);
    b.innerHTML = `<i></i><b>${n}</b>`;
    b.onclick = () => onTap(n, b);
    hive.appendChild(b);
  }
  return hive;
}

function gameNumbers(host){
  let max = numBand();

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Number Hive"));
  const pick = bandPicker(max, () => { playGen++; host.innerHTML = ""; gameNumbers(host); });
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const board = el("div");
  const fb = el("div", "fb");
  s.append(pick, bar, prompt, board, fb);
  host.appendChild(s);

  // Three stages, the three the teacher asked for: recognise the numeral by
  // name, count a set and name it, and hand over a set for a numeral. Each one
  // is the same skill from a different side.
  let got = 0, misses = 0;
  const TOTAL = 3;
  /* A tap that ends a round schedules the next one 1.1s later, and a
   * four-year-old double-taps. Without this, the second tap answers a question
   * that is already over: rounds overlap, questions get skipped, and the game
   * can hand out more stars than it has. Every stage clears it as it paints. */
  let locked = false;

  /* Counting is not reading a numeral. He can say "seven" in a sequence and
   * still not pick 7 out of the hive, which is exactly the gap school flagged.
   * Whole board visible, one numeral named out loud. */
  function findNumeral(){
    let q = 0, last = 0;
    const QS = 5;
    function ask(){
      if (q >= QS){ got++; return howMany(); }
      scoreDots(bar, got, TOTAL);
      let n = last;
      while (n === last) n = 1 + Math.floor(Math.random() * max);
      last = n;
      locked = false;
      setPrompt(prompt, `Find the number ${n}`, `Find the number ${n}.`);
      board.innerHTML = "";
      board.appendChild(hiveBoard(max, (v, b) => {
        if (locked) return;
        if (v === n){
          locked = true;
          b.classList.add("lit"); q++; sfx("right");
          fb.textContent = `That's ${n}! ⭐`; fb.className = "fb good";
          afterSaying(say(`Yes. That is the number ${n}.`), ask);
        } else {
          misses++;
          b.classList.add("miss"); sfx("wrong");
          later(() => b.classList.remove("miss"), 400);
          fb.textContent = `That one is ${v}. Find ${n}.`; fb.className = "fb soft";
          say([`That one is ${v}.`, `Find the number ${n}.`]);
        }
      }));
      fb.textContent = "";
    }
    ask();
  }

  function howMany(){
    let q = 0;
    // Four rather than five: three numeral stages back to back is already a lot
    // of taps for a four-year-old, and the last one is the hardest.
    const QS = 4;
    function ask(){
      if (q >= QS){ got++; return giveMe(); }
      scoreDots(bar, got, TOTAL);
      // Counting a set is a different skill from reciting the sequence, and it
      // falls apart well before 20. Cap the pile at something he can actually
      // count one-to-one, even when the recite band is set to 20.
      const cap = Math.min(max, 12);
      const n = 1 + Math.floor(Math.random() * cap);
      locked = false;
      setPrompt(prompt, "How many bees?", "How many bees?");
      board.innerHTML = "";
      // Rows of five — a countable arrangement beats a wrapped run of emoji.
      const bees = el("div", "bees");
      for (let b = 0; b < n; b++) bees.appendChild(el("span", null, "🐝"));
      const opts = el("div", "opts");
      // Bounded by the pool, not by a fixed 3 — a future week with a tiny
      // number range would otherwise spin here forever looking for distractors.
      const wrongs = new Set();
      const wantWrong = Math.min(3, cap - 1);
      while (wrongs.size < wantWrong){
        const w = 1 + Math.floor(Math.random() * cap);
        if (w !== n) wrongs.add(w);
      }
      shuffle([n, ...wrongs]).forEach(v => {
        const b = el("button", "opt", String(v));
        b.onclick = () => {
          if (locked) return;
          if (v === n){
            locked = true;
            b.classList.add("right"); q++; sfx("right");
            fb.textContent = `${beeCount(n)}!`; fb.className = "fb good";
            afterSaying(say([`${beeCount(n)}.`, "Yes!"]), ask);
          } else {
            misses++;
            b.classList.add("wrong"); sfx("wrong");
            fb.textContent = "Count them again."; fb.className = "fb soft";
            say("Count them again.");
            later(() => b.classList.remove("wrong"), 400);
          }
        };
        opts.appendChild(b);
      });
      board.append(bees, opts);
      fb.textContent = "";
    }
    ask();
  }

  /* The other direction, and the one school asked for by name: here is the
   * numeral, now hand me that many. Reversing it catches a child who has
   * learned to answer "how many" by counting without ever reading the digit. */
  function giveMe(){
    let q = 0;
    const QS = 3;
    const cap = Math.min(max, 10);
    function ask(){
      if (q >= QS){
        got++;
        return donePanel(host, "numbers", got, TOTAL, () => { host.innerHTML = ""; gameNumbers(host); }, { misses });
      }
      scoreDots(bar, got, TOTAL);
      const n = 1 + Math.floor(Math.random() * cap);
      locked = false;
      setPrompt(prompt, `Give me ${beeCount(n)}`, [`Give me ${beeCount(n)}.`, "Find the bunch with that many."]);
      board.innerHTML = "";
      // The numeral stays on screen while he counts each bunch — that pairing is
      // the whole point of the stage.
      board.appendChild(el("div", "numbig", String(n)));
      const wrongs = new Set();
      // Near misses, not wild ones: telling 6 from 7 needs counting, telling 6
      // from 1 doesn't.
      while (wrongs.size < Math.min(2, cap - 1)){
        const w = Math.max(1, Math.min(cap, n + (Math.random() < .5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2))));
        if (w !== n) wrongs.add(w);
      }
      const opts = el("div", "opts");
      shuffle([n, ...wrongs]).forEach(v => {
        const b = el("button", "opt bunch");
        const clump = el("div", "clump");
        for (let i = 0; i < v; i++) clump.appendChild(el("span", null, "🐝"));
        b.appendChild(clump);
        b.setAttribute("aria-label", beeCount(v));
        b.onclick = () => {
          if (locked) return;
          if (v === n){
            locked = true;
            b.classList.add("right"); q++; sfx("right");
            fb.textContent = `That's ${n}! 🍯`; fb.className = "fb good";
            afterSaying(say(["Yes.", `${beeCount(n)}.`]), ask);
          } else {
            misses++;
            b.classList.add("wrong"); sfx("wrong");
            fb.textContent = `That bunch has ${v}. Count again.`; fb.className = "fb soft";
            say([`That bunch has ${v}.`, "Count again."]);
            later(() => b.classList.remove("wrong"), 400);
          }
        };
        opts.appendChild(b);
      });
      board.appendChild(opts);
      fb.textContent = "";
    }
    ask();
  }

  findNumeral();
}

/* ── game 9: Count the Hive ──
 *
 * The counting drill, kept because school asks for it and pulled out of Number
 * Hive because in there it was standing in front of the door. Two things make
 * it survivable on a bad night: the direction is his choice, and a wrong tap
 * doesn't stop anything — it names the number he hit and points at the one it
 * wants, with the target sitting on screen the whole time so there's always
 * something to look for. He can leave at any point and nothing downstream is
 * waiting on him. */
function gameCount(host, startDir){
  let max = numBand();

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Count the Hive"));
  const pick = bandPicker(max, () => { playGen++; host.innerHTML = ""; gameCount(host); });
  const prompt = el("div", "prompt");
  const board = el("div");
  const fb = el("div", "fb");
  s.append(pick, prompt, board, fb);
  host.appendChild(s);

  function chooser(){
    setPrompt(prompt, "Which way?", "Which way do you want to count?");
    board.innerHTML = "";
    fb.textContent = "";
    const two = el("div", "big2");
    const up = el("button");
    up.append(el("em", null, "⬆️"), `Count up to ${max}`);
    up.onclick = () => run("up");
    const down = el("button");
    down.append(el("em", null, "⬇️"), `Count back from ${max}`);
    down.onclick = () => run("down");
    two.append(up, down);
    board.appendChild(two);
  }

  function run(dir){
    const up = dir === "up";
    let next = up ? 1 : max;
    let done = false;

    setPrompt(prompt,
      up ? `Tap the numbers from 1 to ${max}` : `Tap them backwards — ${max} down to 1`,
      up ? `Count up to ${max}. Start at one.` : `Now count backwards. Start at ${max}.`);
    fb.textContent = "";

    /* The echo of a tap waits its turn instead of cutting the one before it.
     * Everywhere else in the app a new line SHOULD stop the old one — a fresh
     * question replaces a stale one. Counting is the opposite: the numbers are
     * a sequence, and tapping at any kind of pace left every one of them
     * chopped to its first syllable, which is the sound of the app losing count
     * rather than him. Two deep is the whole queue; get further ahead than that
     * and the oldest number waiting is dropped, so the voice stays with his
     * finger rather than trailing further behind it with every tap. */
    const waiting = [];
    let echoing = false, echoGen = 0, onDrained = null;
    function echo(n){
      waiting.push(n);
      if (waiting.length > 2) waiting.shift();     // the newest is always kept
      if (!echoing) drain();
    }
    function drain(){
      if (!waiting.length){
        echoing = false;
        const done = onDrained;
        onDrained = null;
        if (done) done();
        return;
      }
      echoing = true;
      const gen = ++echoGen;
      const said = say(numWord(waiting.shift()));
      if (!said) return drain();                  // sound off — nothing to wait for
      let moved = false;
      const go = () => { if (!moved && gen === echoGen){ moved = true; drain(); } };
      said.onEnd(go);
      // A clip that never reports back can't be allowed to stall the count.
      later(go, 3000);
    }
    /* Anything that speaks over the count has to end it, not just empty the
     * queue. Something else saying a line pauses the clip playing rather than
     * ending it, so the handle it was waiting on never fires: leave `echoing`
     * standing and every later tap queues silently behind a number that has
     * already been talked over, until the backstop fires three seconds on and
     * interrupts whatever is being said by then. The generation counter is what
     * makes that stranded backstop harmless when it does fire. */
    /* Run `fn` once the count has finished saying itself. */
    function afterEcho(fn){
      if (!echoing) return fn();
      onDrained = fn;
    }
    function endEcho(){
      waiting.length = 0;
      echoing = false;
      onDrained = null;
      echoGen++;
    }

    function paint(){
      board.innerHTML = "";
      // The number it's waiting for, big, above the hive. Counting out loud and
      // finding the numeral are different jobs and this game only asks for the
      // second one — so don't make him hold the first one in his head too.
      board.appendChild(el("div", "numbig", String(next)));
      board.appendChild(hiveBoard(max, (n, b) => {
        if (done) return;
        if (n !== next){
          // No red, no shake. He is being asked to find one number out of
          // twenty and the answer to a wrong guess is the question again.
          sfx("wrong");
          fb.textContent = `That one is ${n}. Find ${next}.`; fb.className = "fb soft";
          endEcho();
          say([`That one is ${n}.`, `Find the number ${next}.`]);
          return;
        }
        b.classList.add("lit"); sfx("right"); echo(n);
        next = up ? next + 1 : next - 1;
        if (up ? next > max : next < 1){
          done = true;
          sfx("win");
          award("count", up ? 1 : 2);
          /* The last number is the one he climbed the whole hive for, and on a
           * fast run it can still be waiting its turn — a fixed second here cut
           * it off, or lost it entirely, to make room for the cheer. So the
           * panel waits for the count to finish saying itself, then a beat.
           * The panel speaks too, which is why the echo ends on the way out
           * rather than surfacing three seconds into it, and the backstop is
           * for a clip that never reports back: a number nobody hears is a
           * disappointment, a win panel that never arrives is a stuck game. */
          let shown = false;
          const show = () => { if (!shown){ shown = true; endEcho(); finish(dir); } };
          afterEcho(() => later(show, 700));
          later(show, 5000);
          return;
        }
        // Repaint rather than re-render the whole stage: the numeral at the top
        // has to follow him up the hive.
        later(paint, 350);
      }));
    }
    paint();
  }

  function finish(dir){
    hush();
    host.innerHTML = "";
    const d = el("div", "stage done-panel");
    const up = dir === "up";
    d.append(
      el("div", "big", up ? "🎉" : "🐝"),
      el("h2", null, up ? "All the way up!" : "Backwards is the hard one."),
      el("p", null, up ? "Every number in the hive." : "You did it anyway.")
    );
    const other = el("button", "btn", up ? "⬇️ Now try backwards" : "⬆️ Now try counting up");
    other.onclick = () => { playGen++; host.innerHTML = ""; gameCount(host, up ? "down" : "up"); };
    const b = el("button", "btn ghost", "🏠 Pick another game");
    b.onclick = () => renderPlayHome();
    d.append(other, b);
    host.appendChild(d);
    say(up ? "All the way up! Great counting." : "Backwards is the hard one. You did it.");
  }

  if (startDir) run(startDir); else chooser();
}

/* ── game 3: Letter Hunt ──
 *
 * This one used to take every yes-word the week had, so the board was the same
 * five words in a different order, play after play. The week now ships a BANK
 * — a dozen of each — and a level decides how much of it comes out.
 *
 * The distractors are the real difficulty knob, not the count. A word marked
 * `hard` carries the letter's sound somewhere other than the front (cat, ladder,
 * banana for A): ruling those out is listening for where the sound sits rather
 * than whether it's in there at all, which is the actual skill. Level 1 keeps
 * them off the board entirely. */
const LETTER_TIERS = { 1: { yes: 3, no: 3, hard: 0 }, 2: { yes: 4, no: 5, hard: 1 }, 3: { yes: 5, no: 7, hard: 4 } };
/* The deal: `want` is how many yes, no and hard-no words, each capped by what
 * the bank holds, the hard ones drawn first so a short easy list can't crowd
 * them out. `key` is the memory freshSample deals against. */
function letterDeal(L, want, key){
  const yes = freshSample(key, L.yes, Math.min(want.yes, L.yes.length));
  const hardNo = L.no.filter(w => w.hard), easyNo = L.no.filter(w => !w.hard);
  const wantNo = Math.min(want.no, L.no.length);
  const wantHard = Math.min(want.hard, hardNo.length, wantNo);
  const no = shuffle([...sample(hardNo, wantHard), ...sample(easyNo, Math.min(wantNo - wantHard, easyNo.length))]);
  return { yes, no };
}

/* One board: every yes-word has to be found. `ctx` as in nameRound, plus an
 * optional `progress(found, total)` the game's own score bar follows.
 * `done(misses)` fires once the last right word has been found and said. */
function letterRound(ctx, L, yes, no, done, lead){
  const { prompt, opts, fb, gate, hint } = ctx;
  gate.reopen();
  fb.textContent = "";
  const items = shuffle([...yes.map(x => ({ ...x, hit: true })), ...no.map(x => ({ ...x, hit: false }))]);
  let found = 0, missed = 0;
  const anywhere = L.match === "anywhere";
  setPrompt(prompt, anywhere ? `Find the /${L.sound}/ sound anywhere` : `Tap everything that starts with ${L.letter}`,
    [lead, anywhere ? `Tap everything with the ${L.sound} sound anywhere. Like ${L.example}.`
      : `Tap everything that starts with the ${L.sound} sound. Like ${L.example}.`]);
  if (ctx.progress) ctx.progress(0, yes.length);
  opts.innerHTML = "";

  const wrongBtns = [], rightBtns = [];
  items.forEach(it => {
    const b = el("button", "opt");
    b.append(el("em", null, it.emoji), it.word);
    (it.hit ? rightBtns : wrongBtns).push(b);
    // Each word settles once. This is the only board where several answers are
    // right at the same time, so it counts hits rather than closing after one —
    // and without this, three taps on the same word counted three finds and
    // finished a three-word board on its own. Tapping a settled word still says
    // it again, because that is how he re-reads; it just doesn't score again.
    let spent = false;
    b.onclick = () => {
      if (gate.swallowed()) return;
      const first = !spent;
      spent = true;
      if (it.hit){
        hint.found(b);
        b.classList.add("right", "dim");
        if (first){ found++; sfx("right"); if (ctx.progress) ctx.progress(found, yes.length); }
        fb.textContent = `${it.word} — yes!`; fb.className = "fb good";
        const said = say(anywhere ? `${it.word}. Hear the ${L.sound} sound in ${it.word}.`
          : `${it.word}. ${it.word} starts with ${L.letter}.`);
        if (first && found === yes.length){
          gate.take();
          afterSaying(said, () => done(missed), { silent: 1300 });
        }
      } else {
        // Same rule for a distractor: he hears why it doesn't belong every time
        // he asks, but the same word is one mistake however often he taps it.
        // Misses decide whether he keeps his level, and two taps on one word
        // was enough to take it away.
        if (first) missed++;
        b.classList.add("wrong"); sfx("wrong");
        const why = anywhere ? `${it.word} does not have the ${L.sound} sound.`
          : `${it.word} starts with ${it.word[0].toUpperCase()}.`;
        fb.textContent = why; fb.className = "fb soft";
        say([why, hint.miss(b)]);
        later(() => b.classList.remove("wrong"), 400);
      }
    };
    opts.appendChild(b);
  });
  hint.open(wrongBtns, rightBtns);
}

function gameLetter(host){
  const L = week.games.letter;
  const lvl = levelOf("letter");
  const { yes, no } = letterDeal(L, LETTER_TIERS[lvl], "letter" + lvl);
  const replay = () => { host.innerHTML = ""; gameLetter(host); };
  const { s, bar, prompt, opts, fb } = stageShell(host, `Letter ${L.letter} Hunt`);
  s.insertBefore(levelRow("letter", replay), bar);
  // Closed by the word that completes the board — see roundGate. Every earlier
  // tap, right or wrong, is still a legitimate move. The board is the round:
  // the ladder counts wrong taps across all of it and points at whichever
  // right word he still hasn't found.
  const ctx = { prompt, opts, fb, gate: roundGate(opts), hint: hintLadder(),
    progress: (n, total) => scoreDots(bar, n, total) };
  letterRound(ctx, L, yes, no,
    missed => donePanel(host, "letter", yes.length, yes.length, replay, { levels: true, misses: missed }));
}

/* ── engine: which of the two is it? ──
 *
 * One sentence read out loud, two big buttons. Kind or Not Kind was the first
 * of these and is now one row of data among several: inside you or outside you,
 * a machine or something alive, a secret you keep or a thing you can tell
 * everybody. The shape suits every topic because the shape is the lesson —
 * there are two piles and this belongs in one of them.
 *
 * What it was missing was the REASON. Eight scenarios and eight "that's kind"s
 * is a game he can win without thinking, so an item may carry a `note`: the one
 * sentence that says why, read out after he answers. That is also what makes it
 * bear repeating, because the sentence is new even when the scenario isn't.
 *
 * `hard: true` marks an item that doesn't split cleanly — kindness with a catch
 * in it, a machine that looks alive. Level 1 keeps them off the board. */
const SORT_TIERS = { 1: { rounds: 6, hard: 0 }, 2: { rounds: 8, hard: 2 }, 3: { rounds: 10, hard: 5 } };

function gameSort(host, cfg){
  const items = cfg.items || [];
  const lvl = levelOf(cfg.id);
  const tier = SORT_TIERS[lvl];
  const hard = items.filter(x => x.hard), easy = items.filter(x => !x.hard);
  const want = Math.min(tier.rounds, items.length);
  const wantHard = Math.min(tier.hard, hard.length, want);
  // Two separate memories, so the hard ones rotate on their own rather than
  // being crowded out by the easy ones every deal.
  const rounds = shuffle([
    ...freshSample(cfg.id + ":hard", hard, wantHard),
    ...freshSample(cfg.id, easy, Math.min(want - wantHard, easy.length)),
  ]);
  let i = 0, got = 0, missed = 0;
  const replay = () => { host.innerHTML = ""; gameSort(host, cfg); };

  const s = el("div", "stage");
  s.appendChild(el("h2", null, cfg.title));
  const bar = el("div", "scorebar");
  const scene = el("div", "scene");
  const two = el("div", "big2");
  const fb = el("div", "fb");
  s.append(levelRow(cfg.id, replay), bar, scene, two, fb);
  host.appendChild(s);

  const gate = roundGate(two);
  const hint = hintLadder();
  const mk = (side, val) => {
    const b = el("button");
    b.append(el("em", null, side.emoji), side.label);
    b.onclick = () => answer(val, b);
    return b;
  };
  const yesBtn = mk(cfg.yes, true), noBtn = mk(cfg.no, false);
  two.append(yesBtn, noBtn);

  function answer(val, b){
    if (gate.swallowed()) return;
    const r = rounds[i];
    if (val === r.yes){
      gate.take();
      got++; sfx("right");
      fb.textContent = r.note || (r.yes ? cfg.yesSay : cfg.noSay);
      fb.className = "fb good";
      i++;
      afterSaying(say([r.yes ? cfg.yesSay : cfg.noSay, r.note]), round,
        r.note ? { gap: 850, silent: 2600 } : { silent: 1300 });
    } else {
      missed++;
      b.classList.add("wrong"); sfx("wrong");
      fb.textContent = cfg.retry; fb.className = "fb soft";
      say([cfg.retry, hint.miss(b)]);
      later(() => b.classList.remove("wrong"), 400);
    }
  }

  function round(){
    if (i >= rounds.length) return donePanel(host, cfg.id, got, rounds.length, replay,
      { levels: true, misses: missed });
    scoreDots(bar, got, rounds.length);
    gate.reopen();
    hint.open([rounds[i].yes ? noBtn : yesBtn], [rounds[i].yes ? yesBtn : noBtn]);
    fb.textContent = "";
    scene.textContent = rounds[i].text;
    say(rounds[i].text);
  }
  round();
}

/* ── game 5: Match ──
 *
 * Nine pairs is three rows and a board he has to actually remember. The stretch
 * band deals twelve — a fourth row, twenty-four cards — and the extra faces come
 * out of the big-feeling vocabulary, so the longer game is also the harder-word
 * game rather than just more of the same nine.
 *
 * MODES. The feelings are the week's lesson and stay the mode it opens on, but
 * memory is memory: the board works just as well with the cars and the robots
 * he already knows every name of, and a board he wants to open is worth more
 * than one he's correct about. The decks are data under /packs — a deploy that
 * ships none has one mode and no picker, which is what the public demo is. */
const MATCH_PACK_KEY = "hive:matchpack";
const MATCH_PAIRS_KEY = "hive:matchpairs";

/* The deck the loaded WEEK is about, built out of whatever that week teaches:
 * the feelings on a school week, the naming bank on a topic track. It ships
 * with its cards attached, so this mode needs no fetch and works offline on the
 * first play of a new topic. */
function weekDeck(w = week){
  const g = w.games || {};
  if (g.feelings) return {
    id: "week", name: "Feelings", emoji: "😀", noun: "faces",
    cards: [...g.feelings.core, ...g.feelings.big],
  };
  const bank = (g.naming || [])[0];
  if (bank) return {
    id: "week", name: bank.matchName || bank.title, emoji: bank.emoji || "🃏",
    noun: bank.noun || "cards",
    cards: [...(bank.basic || []), ...(bank.advanced || [])],
  };
  return null;
}

/* What the picker and the home tile say WITHOUT fetching anything — the tile
 * has to paint on a cold start, before any deck has been loaded. A stored id
 * that isn't a deck on this deploy any more falls through to the week's own. */
function matchPackMeta(w = week){
  const id = localStorage.getItem(MATCH_PACK_KEY);
  return packList.find(p => p.id === id) || weekDeck(w) || packList[0] || null;
}

async function gameMatch(host){
  const gen = playGen;
  const meta = matchPackMeta();
  // The week's own deck arrives with cards; a generated pack has to be fetched.
  let pack = meta && meta.cards ? meta : null;
  if (meta && !pack){
    try { pack = await loadPack(meta.id); }
    catch { localStorage.removeItem(MATCH_PACK_KEY); pack = weekDeck(); }   // deck gone or offline before it cached
  }
  // The fetch is a beat during which he can have tapped Back or flipped to
  // Plan, and a board painted after that lands on top of another screen.
  if (gen !== playGen) return;
  if (!pack || !(pack.cards || []).length) return renderPlayHome();

  const pool = pack.cards;
  const replay = () => { playGen++; host.innerHTML = ""; gameMatch(host); };
  // Bounded by the deck: one that ships fewer than twelve cards deals what it
  // has instead of dealing duplicates.
  const bands = [...new Set([Math.min(9, pool.length), Math.min(12, pool.length)])];
  let want = Number(localStorage.getItem(MATCH_PAIRS_KEY));
  if (!bands.includes(want)) want = bands[0];

  const s = el("div", "stage");
  s.appendChild(el("h2", null, `${pack.name} Match`));
  const modeList = [weekDeck(), ...packList].filter(Boolean);
  if (modeList.length > 1){
    const modes = el("div", "levelpick");
    modeList.forEach(p => {
      const b = el("button", null, `${p.emoji} ${p.name}`);
      b.setAttribute("aria-pressed", String(p.id === pack.id));
      b.onclick = () => { localStorage.setItem(MATCH_PACK_KEY, p.id); replay(); };
      modes.appendChild(b);
    });
    s.appendChild(modes);
  }
  if (bands.length > 1){
    const pick = el("div", "levelpick");
    [["Class", bands[0]], [`${index.child}'s level`, bands[1]]].forEach(([label, n]) => {
      const b = el("button", null, `${label} · ${n} pairs`);
      b.setAttribute("aria-pressed", String(want === n));
      b.onclick = () => { localStorage.setItem(MATCH_PAIRS_KEY, String(n)); replay(); };
      pick.appendChild(b);
    });
    s.appendChild(pick);
  }
  const bar = el("div", "scorebar");
  // Both boards are a multiple of the six columns a tablet gets; `wide` is the
  // twenty-four card one, which has to give up card size to fit four rows.
  const grid = el("div", "grid-match" + (want > 9 ? " wide" : ""));
  const fb = el("div", "fb");
  s.append(bar, grid, fb);
  host.appendChild(s);

  const faces = freshSample("match:" + pack.id, pool, want);
  const deck = shuffle([...faces, ...faces].map((f, n) => ({ ...f, n })));
  let open = [], locked = false, pairs = 0, misses = 0;
  scoreDots(bar, 0, want);
  say(`Find the two ${pack.noun} that match.`);

  deck.forEach(card => {
    const c = el("div", "mcard");
    c.setAttribute("role", "button");
    c.setAttribute("tabindex", "0");
    // Emoji for the feelings, drawn art for the drawn packs, a photograph for
    // the family. The svg is a local file this app shipped, which is the only
    // reason innerHTML is allowed near it; the photo goes through an <img>
    // element and never near innerHTML at all.
    const face = el("span", "face");
    if (card.photo){
      face.classList.add("photo");
      const img = el("img");
      img.src = card.photo;
      img.alt = "";          // the label is read aloud and shown; this would double it
      face.appendChild(img);
    }
    else if (card.art){ face.classList.add("art"); face.innerHTML = card.art; }
    else face.textContent = card.icon;
    c.appendChild(face);
    const flip = () => {
      if (locked || c.classList.contains("up") || c.classList.contains("got")) return;
      c.classList.add("up");
      sfx("flip");
      say(card.label);
      open.push({ c, card });
      if (open.length === 2){
        locked = true;
        const [a, b] = open;
        if (a.card.id === b.card.id){
          later(() => {
            a.c.classList.add("got"); b.c.classList.add("got");
            pairs++; scoreDots(bar, pairs, want); sfx("star");
            fb.textContent = `Two ${a.card.label} ${pack.noun}!`; fb.className = "fb good";
            open = []; locked = false;
            if (pairs === want) later(() => donePanel(host, "match", want, want, () => { host.innerHTML = ""; gameMatch(host); }, { misses }), 900);
          }, 450);
        } else {
          misses++;
          later(() => {
            a.c.classList.remove("up"); b.c.classList.remove("up");
            open = []; locked = false;
            fb.textContent = "Not a match — try again."; fb.className = "fb soft";
          }, 950);
        }
      }
    };
    c.onclick = flip;
    c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } };
    grid.appendChild(c);
  });
}

/* ── game 6: What Helps? ── */
/* Deliberately unscored. There is no wrong way to calm down, and turning
 * self-regulation into something he can fail would defeat the point. */
function gameHelps(host){
  const hard = week.games.feelings.big;
  const helps = week.games.feelings.helps;
  // Rotated rather than freshly sampled: four of six meant the same two big
  // feelings most nights, and the whole game is four questions long.
  const rounds = freshSample("helps", hard, Math.min(4, hard.length));
  /* Half the rounds ask about a FRIEND feeling it instead of him. Same list,
   * same strategies, but answering for somebody else is the perspective-taking
   * jump — and it's the difference between a game he has heard four times and a
   * game with eight questions in it. Alternating from a coin flip means one play
   * always has both, and which one he gets first changes. */
  let other = Math.random() < 0.5;
  let i = 0;
  const gate = roundGate();
  const { bar, prompt, opts, fb } = stageShell(host, "What Helps?");
  bar.remove();

  function round(){
    if (i >= rounds.length){
      hush();
      host.innerHTML = "";
      const d = el("div", "stage done-panel");
      d.append(el("div", "big", "🌬️"), el("h2", null, "You know what helps."),
        el("p", null, "Big feelings get smaller when you do something about them."));
      const a = el("button", "btn", "🔄 Again");
      a.onclick = () => { playGen++; host.innerHTML = ""; gameHelps(host); };
      const b = el("button", "btn ghost", "🏠 Pick another game");
      b.onclick = () => renderPlayHome();
      d.append(a, b);
      host.appendChild(d);
      award("helps", 4);
      say("You know what helps. Great job.");
      return;
    }
    const f = rounds[i];
    const mine = !other;
    other = !other;
    gate.reopen();
    fb.textContent = "";
    const ask = mine ? `You feel ${f.label}. What helps?` : `Your friend feels ${f.label}. What helps?`;
    setPrompt(prompt, `${f.icon}  ${ask}`, ask);
    opts.innerHTML = "";
    freshSample("helpopts", helps, Math.min(4, helps.length)).forEach(h => {
      const b = el("button", "opt");
      /* The strategies are written in HIS voice — "use my words", "draw how I
       * feel" — which is wrong on a round about somebody else, out loud and on
       * the button: "when your friend feels nervous, they can move my body".
       * The friend wording lives in the week doc next to the first-person one,
       * because whose words they are is content, not a string transform. */
      const label = mine ? h.label : (h.friend || h.label);
      b.append(el("em", null, h.icon), label);
      b.onclick = () => {
        if (!gate.take()) return;              // every tap here is an answer
        b.classList.add("right"); sfx("right");
        // Only what he'd do himself is worth showing a parent; what he'd suggest
        // for somebody else is a different question and would muddy the record.
        if (mine) set("helps", K(f.id), h.id);
        fb.textContent = "Good idea. 💛"; fb.className = "fb good";
        i++;
        // A longer beat than the rest: this one is worth sitting with.
        afterSaying(
          say(["Good idea.",
               mine ? `When you feel ${f.label}` : `When your friend feels ${f.label}`,
               mine ? `you can ${h.label.toLowerCase()}.` : `they can ${label.toLowerCase()}.`]),
          round, { gap: 1000, silent: 2200 });
      };
      opts.appendChild(b);
    });
  }
  round();
}

/* ── game 7: Day by Day ── */
/* Yesterday, today, tomorrow, before and after — school's ask, and the thing
 * that turns "Wednesday" from a word into a position. Needs no week config:
 * the days of the week are the same every Monday. The only week-specific part
 * is the aside after a correct answer, which names what that day holds if the
 * date happens to fall inside the loaded week. */
function gameDays(host){
  const BAND_KEY = "hive:daysband";
  let band = localStorage.getItem(BAND_KEY) === "stretch" ? "stretch" : "class";

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Day by Day"));
  const pick = el("div", "levelpick");
  [["Class", "class"], [`${index.child}'s level`, "stretch"]].forEach(([label, v]) => {
    const b = el("button", null, label);
    b.setAttribute("aria-pressed", String(band === v));
    b.onclick = () => { localStorage.setItem(BAND_KEY, v); playGen++; host.innerHTML = ""; gameDays(host); };
    pick.appendChild(b);
  });
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const opts = el("div", "opts");
  const again = el("div", "recap");
  const fb = el("div", "fb");
  s.append(pick, bar, prompt, opts, again, fb);
  host.appendChild(s);

  const today = new Date();
  const dow = today.getDay();
  const nameOf = i => WEEKDAYS[(i % 7 + 7) % 7];
  // Never name the same day twice running — with six rounds off five question
  // shapes, an unfiltered pick hands him "before Saturday" twice in one game.
  let lastAsked = -1;
  const some = () => {
    let d = lastAsked;
    while (d === lastAsked) d = Math.floor(Math.random() * 7);
    lastAsked = d;
    return d;
  };

  /* A question is a prompt, the day it wants, and — when the answer is a real
   * date rather than an abstract "after Tuesday" — that date, so the reply can
   * say what actually happens on it. */
  const dated = n => addDays(today, n);
  const CLASS_QS = [
    () => ({ text: "What day is it today?", want: dow, on: dated(0) }),
    () => ({ text: "What day was yesterday?", want: dow - 1, on: dated(-1) }),
    () => ({ text: "What day is tomorrow?", want: dow + 1, on: dated(1) }),
    () => { const d = some(); return { text: `What day comes after ${nameOf(d)}?`, want: d + 1 }; },
    () => { const d = some(); return { text: `What day comes before ${nameOf(d)}?`, want: d - 1 }; },
  ];
  const STRETCH_QS = [
    () => ({ text: "What day is it today?", want: dow, on: dated(0) }),
    () => ({ text: "What day was yesterday?", want: dow - 1, on: dated(-1) }),
    () => ({ text: "What day comes after tomorrow?", want: dow + 2, on: dated(2) }),
    () => ({ text: "What day was it before yesterday?", want: dow - 2, on: dated(-2) }),
    () => { const d = some(); return { text: `If yesterday was ${nameOf(d)}, what day is it today?`, want: d + 1 }; },
    () => { const d = some(); return { text: `What day comes two days after ${nameOf(d)}?`, want: d + 2 }; },
  ];

  const rounds = (band === "stretch" ? STRETCH_QS : CLASS_QS).slice();
  // The three the teacher listed come first and in order; the rest are shuffled
  // so a second play isn't the same six questions in the same order.
  const head = rounds.slice(0, 3), tail = shuffle(rounds.slice(3));
  const plan = [...head, ...tail];
  // Six rounds either way. The before/after questions pick their own day each
  // time they're built, so re-using one is a new question, not a repeat.
  for (let n = 0; plan.length < 6 && tail.length; n++) plan.push(tail[n % tail.length]);
  plan.splice(6);

  let i = 0, got = 0, misses = 0;
  const gate = roundGate(opts);
  const hint = hintLadder();
  // Everything scheduled belongs to the round that scheduled it. Without this,
  // the "say the choices" timer from a finished round talks over the next one.
  let token = 0;

  /* If the day being asked about is a school day of the week on screen, say
   * what's on it. "Tomorrow is Thursday — kindness you can see" is the answer
   * to the teacher's other question, the one about what we did yesterday. */
  /* The aside only exists when the loaded doc HAS school days to describe. A
   * topic track has none, and its `start` is still a Monday — so the
   * today/yesterday/tomorrow questions land inside the five-day window and used
   * to reach straight into an undefined `week.days`. Day by Day is calendar
   * arithmetic and belongs on any track; it just has nothing extra to say on
   * one without a poster behind it. */
  function whatsOn(date){
    const rows = (week && week.days) || [];
    if (!date || !rows.length) return "";
    const start = parseDay(week.start);
    for (let n = 0; n < 5; n++){
      if (sameDay(addDays(start, n), date)){
        const d = rows.find(x => x.key === DAY_KEYS[n]);
        return d ? d.title : "";
      }
    }
    return "";
  }

  function round(){
    if (i >= plan.length) return donePanel(host, "days", got, plan.length, () => { host.innerHTML = ""; gameDays(host); }, { misses });
    scoreDots(bar, got, plan.length);
    fb.textContent = "";
    gate.reopen();
    const mine = ++token;

    const q = plan[i]();
    const want = ((q.want % 7) + 7) % 7;
    const choices = shuffle([want, ...sample([0,1,2,3,4,5,6].filter(d => d !== want), 3)]);

    const said = setPrompt(prompt, q.text, q.text);
    opts.innerHTML = "";
    let rightBtn = null; const wrongBtns = [];
    choices.forEach(d => {
      const b = el("button", "opt day");
      // The initial is a foothold, not the answer — Tuesday and Thursday share
      // one, which is its own small lesson.
      b.append(el("em", null, nameOf(d)[0]), nameOf(d));
      if (d === want) rightBtn = b; else wrongBtns.push(b);
      b.onclick = () => {
        if (gate.swallowed()) return;
        if (d === want){
          gate.take();
          b.classList.add("right"); got++; sfx("right");
          const on = whatsOn(q.on);
          fb.textContent = on ? `${nameOf(want)} — ${on}.` : `Yes — ${nameOf(want)}!`;
          fb.className = "fb good";
          // Day titles are written to be read, not spoken: "I feel ___ because"
          // is silence or a run of underscores when something reads it out.
          const reply = say(on ? [`Yes. ${nameOf(want)}.`, `At school, ${on.replace(/_+/g, "blank")}.`]
                              : `Yes. ${nameOf(want)}.`);
          i++;
          afterSaying(reply, round, { silent: on ? 1900 : 1200 });
        } else {
          misses++;
          b.classList.add("wrong"); sfx("wrong");
          fb.textContent = `That one is ${nameOf(d)}. Try again.`; fb.className = "fb soft";
          say([`That one is ${nameOf(d)}. Try again.`, hint.miss(b)]);
          later(() => b.classList.remove("wrong"), 400);
        }
      };
      opts.appendChild(b);
    });
    hint.open(wrongBtns, [rightBtn]);

    // He can't read the buttons yet, so the choices have to be sayable on
    // demand — otherwise the only way to hear one is to get it wrong.
    again.innerHTML = "";
    // Four day names in one recording would be a recording per permutation.
    // Said as five short ones it's the seven day names plus two joins.
    const names = choices.map(nameOf);
    const list = ["Is it", ...names.slice(0, -1), `or ${names[names.length - 1]}?`];
    const rb = el("button", null, "🔊 Say the choices");
    rb.onclick = () => say(list);
    again.appendChild(rb);

    /* Read the choices when the QUESTION has finished, not on a stopwatch. The
     * long stretch prompts run past three seconds and a fixed timer cut them
     * off mid-sentence. The seq check is what keeps this from talking over a
     * wrong-answer correction, since cancelling an utterance ends it too. */
    const seq = speechSeq;
    const readChoices = () => { if (mine === token && !gate.busy() && speechSeq === seq) say(list); };
    if (said) said.onEnd(readChoices);
    // Backstop: iOS drops `end` if the tab goes to the background mid-sentence,
    // and with sound off there is no utterance to hang this on at all.
    later(readChoices, said ? 9000 : 2200);
  }
  round();
}

/* ── game 8: Story Time ── */
function gameStory(host){
  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Story Time"));
  s.appendChild(el("p", null, "This week's books."));
  const opts = el("div", "opts");
  (week.books || []).forEach(bk => {
    (bk.videos || []).forEach((v, n) => {
      const b = el("button", "opt");
      b.style.minWidth = "260px";
      b.append(el("em", null, "📖"), bk.title, el("div", "tile-sub", v.label));
      b.onclick = () => openVideo(v, bk.title, bk.ask);
      opts.appendChild(b);
    });
  });
  s.appendChild(opts);
  host.appendChild(s);
  say("Pick a story.");
}

/* ── sing along ──
 * The unit's song, with the words on screen and the line being sung lit up —
 * a read-along for a pre-reader, and the Music & Movement column of the poster
 * finally wired to something. The mp3 was generated from the lyrics in the
 * week doc; the line times came from forced alignment and live in the song
 * manifest. A song the alignment couldn't place still works: the lines pace
 * themselves evenly across the recording, which is roughly right for a song
 * told to start singing straight away. */
function gameSing(host, cfg){
  const meta = songMeta(cfg.id);
  const lines = (cfg.lyrics || []).map(String);
  if (!meta || !lines.length) return renderPlayHome();

  const s = el("div", "stage");
  s.appendChild(el("h2", null, cfg.title));
  const play = el("button", "singplay", "▶");
  play.setAttribute("aria-label", "Play or pause the song");
  const box = el("div", "lyrics");
  const rows = lines.map(t => { const r = el("div", "lyric", t); box.appendChild(r); return r; });
  const fb = el("div", "fb");
  s.append(play, box, fb);
  host.appendChild(s);

  if (!songEl){ songEl = new Audio(); songEl.preload = "auto"; }
  const a = songEl;
  a.src = "/audio/songs/" + meta.file;

  /* Measured times when the generator has them; otherwise an even spread,
   * which needs the duration and so waits for metadata to arrive. */
  const aligned = Array.isArray(meta.lines) && meta.lines.length === lines.length
    && meta.lines.every(t => typeof t === "number");
  const times = () => aligned ? meta.lines
    : (isFinite(a.duration) && a.duration
        ? lines.map((_, i) => a.duration * (0.04 + 0.9 * i / lines.length))
        : null);

  let active = -1, done = false;
  const restart = () => {
    a.currentTime = 0;
    active = -1; done = false;
    rows.forEach(r => r.classList.remove("now"));
    fb.textContent = "";
  };
  const paint = () => {
    const ts = times();
    if (!ts) return;
    let i = -1;
    while (i + 1 < ts.length && a.currentTime >= ts[i + 1]) i++;
    if (i === active) return;
    active = i;
    rows.forEach((r, n) => r.classList.toggle("now", n === i));
    // Scroll the lyrics box, not the page — the play button stays put.
    if (i >= 0) box.scrollTo({
      top: rows[i].offsetTop - box.offsetTop - box.clientHeight / 2 + rows[i].offsetHeight / 2,
      behavior: "smooth",
    });
  };

  // The element is shared, so the handlers are reassigned on every entry — a
  // stale screen's can never fire, same deal as the voice element.
  a.ontimeupdate = paint;
  a.onplay = () => { play.textContent = "⏸"; };
  a.onpause = () => { play.textContent = "▶"; };
  a.onerror = () => { fb.textContent = "The song wouldn't load. Try it again in a minute."; fb.className = "fb soft"; };
  a.onended = () => {
    if (done) return;
    done = true;
    award(cfg.id, 1);
    sfx("win");
    celebrate();
    fb.textContent = "🎉 You sang the whole song!";
    fb.className = "fb good";
    say(singPraise());
  };

  play.onclick = () => {
    // 🔊 is the master — off means silence, the sing-along included. Toggling
    // it off mid-song already stops through hush(); this covers pressing play
    // while it's off, with the reason on screen since it can't be said.
    if (!soundOn){ fb.textContent = "Sound is off."; fb.className = "fb soft"; return; }
    if (a.paused){
      if (done || a.ended) restart();
      a.play().catch(() => {});
    } else a.pause();
  };
}

/* ── engine: put it in order ──
 *
 * A sequence is the first idea in programming and nothing else in the app
 * teaches it: washing your hands, getting dressed, sending a coin, how a
 * computer learns a new word. The steps arrive shuffled and he taps them into
 * order, which is a harder ask than it looks — he has to hold the whole
 * sequence while judging one step.
 *
 * Every step carries an icon and gets read out loud, because he can't read the
 * buttons. The order lives in the data: `steps` is already correct and the game
 * shuffles a copy. */
/* The cap comes from the doc, not a table: level 3 is the longest set the
 * block carries and each level under it is one step shorter. A fixed 4/5/6
 * made the four tracks with nothing over four steps play one board at every
 * level, and a week with a single four-step set dealt a one-round level 1. */
const ORDER_SETS = 3;

function gameOrder(host, cfg){
  const lvl = levelOf(cfg.id);
  const all = (cfg.sets || []).map(s => ({ ...s, id: s.goal }))
    .sort((a, b) => a.steps.length - b.steps.length);
  const longest = all.length ? all[all.length - 1].steps.length : 0;
  const cap = longest - (LEVELS - lvl);
  // Short sets at level 1, everything by level 3 — and a cap that fits fewer
  // sets than a board deals is topped up with the next-shortest rather than
  // dealing a shorter game.
  const fits = all.filter(s => s.steps.length <= cap);
  const usable = fits.length >= ORDER_SETS ? fits : all.slice(0, ORDER_SETS);
  const rounds = freshSample(cfg.id + lvl, usable, Math.min(ORDER_SETS, usable.length));
  let i = 0, got = 0, missed = 0;
  const replay = () => { host.innerHTML = ""; gameOrder(host, cfg); };

  const s = el("div", "stage");
  s.appendChild(el("h2", null, cfg.title));
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const strip = el("div", "orderstrip");
  const opts = el("div", "opts");
  const again = el("div", "recap");
  const fb = el("div", "fb");
  s.append(levelRow(cfg.id, replay), bar, prompt, strip, opts, again, fb);
  host.appendChild(s);

  function round(){
    if (i >= rounds.length) return donePanel(host, cfg.id, got, rounds.length, replay,
      { levels: true, misses: missed });
    scoreDots(bar, got, rounds.length);
    fb.textContent = "";
    const task = rounds[i];
    let at = 0;                                   // how much of the order he has
    const left = shuffle(task.steps.slice());
    const line = `Put these in order. ${task.goal}.`;
    const said = setPrompt(prompt, `In order: ${task.goal}`, line);
    strip.innerHTML = "";

    function paint(){
      opts.innerHTML = "";
      left.forEach(st => {
        const b = el("button", "opt step");
        b.append(el("em", null, st.icon), st.text);
        b.onclick = () => tap(st, b);
        opts.appendChild(b);
      });
      again.innerHTML = "";
      const rb = el("button", null, "🔊 Say them again");
      rb.onclick = () => say(left.map(st => st.text));
      again.appendChild(rb);
    }

    function tap(st, b){
      // A step already in the strip is not a candidate: a double-tap used to
      // splice at index -1, which quietly removed the LAST step in the pile.
      if (!left.includes(st)) return;
      if (st.text === task.steps[at].text){
        left.splice(left.indexOf(st), 1);
        const slot = el("div", "ostep");
        slot.append(el("b", null, String(at + 1)), el("em", null, st.icon), st.text);
        strip.appendChild(slot);
        at++;
        sfx("right");
        if (at >= task.steps.length){
          got++; i++;
          fb.textContent = "That's the whole order! ⭐"; fb.className = "fb good";
          opts.innerHTML = ""; again.innerHTML = "";
          afterSaying(say([st.text, "That is the right order."]), round, { silent: 1800 });
          return;
        }
        fb.textContent = "";
        paint();
        say(st.text);
      } else {
        missed++;
        b.classList.add("wrong"); sfx("wrong");
        fb.textContent = at ? "Not that one next." : "Something else comes first.";
        fb.className = "fb soft";
        say(at ? "Not that one next. What comes next?" : "Something else comes first. What comes first?");
        later(() => b.classList.remove("wrong"), 400);
      }
    }

    paint();
    /* Read the choices once the question has finished asking itself — same
     * reason as Day by Day: he cannot read them, so a game that never says them
     * out loud is a guessing game. */
    const seq = speechSeq;
    const readAll = () => { if (speechSeq === seq) say(left.map(st => st.text)); };
    if (said) said.onEnd(readAll); else later(readAll, 900);
  }
  round();
}

/* ── game: Code the Bee ──
 *
 * The one that is actually programming. He builds a whole program before
 * anything runs — four arrows, tapped in the order they'll happen — and then
 * presses Run and watches it play out. Everything that makes code code is in
 * there: the instructions are followed exactly and in order, the machine does
 * what you SAID rather than what you meant, and a wrong answer is not a wrong
 * answer but a program you go back and fix.
 *
 * Which is why a failed run keeps the program on screen. Clearing it would make
 * this a guessing game; leaving it there makes the next tap a correction, and
 * correcting your own program is the whole skill.
 *
 * Absolute directions, not turn-left/turn-right: relative turning needs him to
 * hold the bee's heading in his head, which is a different and much later
 * skill. Up is up. */
const CODE_TIERS = {
  1: { size: 4, len: 3, rocks: 0 },
  2: { size: 4, len: 4, rocks: 1 },
  3: { size: 5, len: 5, rocks: 2 },
};
const CODE_PUZZLES = 3;
const DIRS = [
  { id: "up",    arrow: "⬆️", dx: 0,  dy: -1, say: "Up." },
  { id: "down",  arrow: "⬇️", dx: 0,  dy: 1,  say: "Down." },
  { id: "left",  arrow: "⬅️", dx: -1, dy: 0,  say: "Left." },
  { id: "right", arrow: "➡️", dx: 1,  dy: 0,  say: "Right." },
];

/* A random walk from the corner that never crosses itself, so the path it
 * leaves IS a solution — the puzzle is generated from the answer rather than
 * generated and then checked. Rocks go anywhere that walk didn't touch, which
 * is what keeps them from ever sealing the board off. */
/* How few moves the board can actually be crossed in, rocks included. Used to
 * measure a candidate puzzle rather than trust it. */
function shortestRoute(size, from, to, stones){
  const blocked = new Set(stones.map(r => `${r.x},${r.y}`));
  const seen = new Set([`${from.x},${from.y}`]);
  let edge = [from], steps = 0;
  while (edge.length){
    if (edge.some(p => p.x === to.x && p.y === to.y)) return steps;
    const next = [];
    for (const p of edge){
      for (const d of DIRS){
        const nx = p.x + d.dx, ny = p.y + d.dy, k = `${nx},${ny}`;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (blocked.has(k) || seen.has(k)) continue;
        seen.add(k);
        next.push({ x: nx, y: ny });
      }
    }
    edge = next;
    steps++;
  }
  return Infinity;
}

function codePuzzle({ size, len, rocks }){
  for (let tries = 0; tries < 400; tries++){
    let x = 0, y = size - 1;
    const path = [{ x, y }];
    let ok = true;
    for (let n = 0; n < len; n++){
      const open = shuffle(DIRS).filter(d => {
        const nx = x + d.dx, ny = y + d.dy;
        return nx >= 0 && ny >= 0 && nx < size && ny < size &&
               !path.some(p => p.x === nx && p.y === ny);
      });
      if (!open.length){ ok = false; break; }
      x += open[0].dx; y += open[0].dy;
      path.push({ x, y });
    }
    if (!ok || (x === 0 && y === size - 1)) continue;
    const free = [];
    for (let ry = 0; ry < size; ry++) for (let rx = 0; rx < size; rx++)
      if (!path.some(p => p.x === rx && p.y === ry)) free.push({ x: rx, y: ry });
    const stones = sample(free, Math.min(rocks, free.length));
    /* The walk IS a solution, but it is not necessarily the shortest one. A walk
     * that curls back on itself — up, right, right, down, left — can leave the
     * flower one square from the corner it started in, so the five-instruction
     * puzzle the level promised is answered with a single `right`. The rocks
     * can't be relied on to close that off, because they are placed off the walk
     * and the shortcut usually isn't. So measure it: the shortest clear route has
     * to be exactly as long as the level advertises. */
    if (shortestRoute(size, { x: 0, y: size - 1 }, { x, y }, stones) !== len) continue;
    return { size, goal: { x, y }, rocks: stones };
  }
  return null;
}

function gameCode(host, cfg){
  const lvl = levelOf("code");
  const tier = CODE_TIERS[lvl];
  const actor = cfg.actor || "🐝", goalIcon = cfg.goal || "🌻";
  const lines = cfg.lines || {};
  const replay = () => { host.innerHTML = ""; gameCode(host, cfg); };

  const s = el("div", "stage");
  s.appendChild(el("h2", null, cfg.title || "Code the Bee"));
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const board = el("div", "codeboard");
  const strip = el("div", "progstrip");
  const pad = el("div", "arrows");
  const fb = el("div", "fb");
  s.append(levelRow("code", replay), bar, prompt, board, strip, pad, fb);
  host.appendChild(s);

  let puzzle = null, program = [], at = null;
  let done = 0, fails = 0;
  /* The pad is the round here. While a program is walking, every control on it
   * is inert — which is exactly the moment a four-year-old presses ▶ again. */
  const gate = roundGate(pad);

  function paintBoard(){
    board.innerHTML = "";
    board.style.setProperty("--n", puzzle.size);
    for (let y = 0; y < puzzle.size; y++){
      for (let x = 0; x < puzzle.size; x++){
        const c = el("div", "ccell");
        if (puzzle.rocks.some(r => r.x === x && r.y === y)) c.append(el("span", null, "🪨"));
        else if (puzzle.goal.x === x && puzzle.goal.y === y) c.append(el("span", "cgoal", goalIcon));
        if (at && at.x === x && at.y === y) c.append(el("span", "cactor", actor));
        board.appendChild(c);
      }
    }
  }

  function paintProgram(){
    strip.innerHTML = "";
    if (!program.length) strip.appendChild(el("span", "phint", "Your program goes here"));
    program.forEach(d => strip.appendChild(el("span", "parrow", d.arrow)));
  }

  function paintPad(){
    pad.innerHTML = "";
    DIRS.forEach(d => {
      const b = el("button", "arrow", d.arrow);
      b.setAttribute("aria-label", d.id);
      b.onclick = () => {
        if (gate.swallowed() || program.length >= 10) return;
        program.push(d); paintProgram(); sfx("tap"); say(d.say);
      };
      pad.appendChild(b);
    });
    const undo = el("button", "arrow ghost", "⤺");
    undo.setAttribute("aria-label", "Take the last one off");
    undo.onclick = () => { if (!gate.swallowed() && program.length){ program.pop(); paintProgram(); sfx("tap"); } };
    const clear = el("button", "arrow ghost", "✕");
    clear.setAttribute("aria-label", "Start the program over");
    clear.onclick = () => { if (!gate.swallowed()){ program = []; paintProgram(); sfx("tap"); } };
    const run = el("button", "arrow go", "▶");
    run.setAttribute("aria-label", "Run the program");
    run.onclick = () => { if (!gate.swallowed() && program.length) runProgram(); };
    pad.append(undo, clear, run);
  }

  function newPuzzle(){
    // Unlocking happens HERE, not when the run finished: a win holds the
    // controls through its own cheer, and this is the moment the board is
    // genuinely ready for a new program.
    gate.reopen();
    // A generator that can't place the harder board hands back nothing rather
    // than looping; an easier one is a better answer than a stuck game.
    puzzle = codePuzzle(tier) || codePuzzle(CODE_TIERS[1]) ||
      { size: 4, goal: { x: 1, y: 1 }, rocks: [] };   // three moves, like level 1 asks
    program = [];
    at = { x: 0, y: puzzle.size - 1 };
    scoreDots(bar, done, CODE_PUZZLES);
    fb.textContent = "";
    paintBoard(); paintProgram(); paintPad();
    setPrompt(prompt, "Get there. Tap the arrows, then press ▶",
      lines.start || "Tell the bee how to get to the flower.");
  }

  function runProgram(){
    gate.take();
    fb.textContent = ""; fb.className = "fb";
    let step = 0;
    at = { x: 0, y: puzzle.size - 1 };
    paintBoard();

    const tick = () => {
      if (step >= program.length) return settle();
      const d = program[step++];
      const nx = at.x + d.dx, ny = at.y + d.dy;
      const off = nx < 0 || ny < 0 || nx >= puzzle.size || ny >= puzzle.size;
      const rock = puzzle.rocks.some(r => r.x === nx && r.y === ny);
      if (off || rock) return bump();
      at = { x: nx, y: ny };
      sfx("tap");
      paintBoard();
      later(tick, 520);
    };

    // The program kept, deliberately. This is where debugging is learned.
    function bump(){
      gate.reopen(); fails++;
      sfx("wrong");
      fb.textContent = "Bump! Fix your program and try again."; fb.className = "fb soft";
      say(lines.wall || "The bee bumped the wall. Fix it and try again.");
    }

    /* Only a FAILED run gives the controls back, and it gives them back at once
     * — the program he has to fix is the whole point of it still being there.
     *
     * A win keeps them locked until `newPuzzle` or the done panel actually
     * advances the game. Unlocking here instead left the solved program and a
     * live Run button on screen all the way through the spoken cheer, and a
     * four-year-old who taps Run again in that gap scored the same puzzle twice,
     * walked a second bee over the first, and could send the game past its own
     * last round. */
    function settle(){
      if (at.x === puzzle.goal.x && at.y === puzzle.goal.y){
        done++;
        sfx("star");
        fb.textContent = "You got there! ⭐"; fb.className = "fb good";
        scoreDots(bar, done, CODE_PUZZLES);
        const said = say(lines.win || "Your bee found the flower!");
        if (done >= CODE_PUZZLES)
          afterSaying(said, () => donePanel(host, "code", done, CODE_PUZZLES, replay,
            { levels: true, misses: fails }), { silent: 1600 });
        else afterSaying(said, newPuzzle, { silent: 1600 });
      } else {
        gate.reopen();                     // his program is waiting to be fixed
        fails++;
        sfx("wrong");
        fb.textContent = "Not there yet. Fix your program."; fb.className = "fb soft";
        say(lines.stop || "The bee stopped in the wrong place. Try again.");
      }
    }

    later(tick, 400);
  }

  newPuzzle();
}

/* ── game: Which is More? ──
 *
 * Comparing two amounts, which is a different skill from counting one of them
 * and the one that money runs on. Level 3 puts the two piles one apart, so
 * eyeballing stops working and he has to actually count both. */
const MORE_TIERS = {
  1: { gap: 3, cap: 8,  less: false },
  2: { gap: 2, cap: 10, less: false },
  3: { gap: 1, cap: 12, less: true },
};
const MORE_ROUNDS = 6;
/* Shared level, capped by this week's count: a level is open only when its
 * piles fit inside the doc's `max`. */
const moreTop = cfg => tierTop(MORE_TIERS, t => t.cap <= (cfg.max || 12));

function gameMore(host, cfg){
  const icon = cfg.icon || "🐝";
  const top = moreTop(cfg);
  const lvl = levelOf("more", top);
  const tier = MORE_TIERS[lvl];
  const cap = Math.min(cfg.max || 12, tier.cap);
  const replay = () => { host.innerHTML = ""; gameMore(host, cfg); };
  let i = 0, got = 0, missed = 0;
  // Alternating rather than random, so a level-3 game always asks both.
  let askLess = false;

  const { s, bar, prompt, opts, fb } = stageShell(host, cfg.title || "Which is More?");
  const gate = roundGate(opts);
  const hint = hintLadder();
  s.insertBefore(levelRow("more", replay, top), bar);

  function round(){
    if (i >= MORE_ROUNDS) return donePanel(host, "more", got, MORE_ROUNDS, replay,
      { levels: true, misses: missed, top });
    scoreDots(bar, got, MORE_ROUNDS);
    gate.reopen();
    fb.textContent = "";
    const less = tier.less && (askLess = !askLess);
    // Pick the second pile from the numbers that are actually far enough away,
    // rather than guessing and re-rolling: on a small `max` a re-roll loop can
    // have nothing to find and spin forever.
    const gap = Math.min(tier.gap, Math.max(1, cap - 1));
    const a = 1 + Math.floor(Math.random() * cap);
    const far = [];
    for (let n = 1; n <= cap; n++) if (Math.abs(n - a) >= gap) far.push(n);
    const b = far.length ? far[Math.floor(Math.random() * far.length)] : (a === 1 ? cap : 1);
    const want = less ? Math.min(a, b) : Math.max(a, b);
    setPrompt(prompt, less ? "Which one is less?" : "Which one is more?",
      less ? "Which one is less?" : "Which one is more?");
    opts.innerHTML = "";
    let rightBtn = null; const wrongBtns = [];
    shuffle([a, b]).forEach(n => {
      const btn = el("button", "opt bunch pile");
      const clump = el("div", "clump");
      for (let k = 0; k < n; k++) clump.appendChild(el("span", null, icon));
      btn.appendChild(clump);
      btn.setAttribute("aria-label", `${n}`);
      if (n === want) rightBtn = btn; else wrongBtns.push(btn);
      btn.onclick = () => {
        if (gate.swallowed()) return;
        if (n === want){
          gate.take();
          btn.classList.add("right"); got++; i++; sfx("right");
          fb.textContent = `${n} is ${less ? "less" : "more"}! ⭐`; fb.className = "fb good";
          afterSaying(say(["Yes.", `${n} is ${less ? "less" : "more"}.`]), round);
        } else {
          missed++;
          btn.classList.add("wrong"); sfx("wrong");
          fb.textContent = "Count them again."; fb.className = "fb soft";
          say(["Count them again.", hint.miss(btn)]);
          later(() => btn.classList.remove("wrong"), 400);
        }
      };
      opts.appendChild(btn);
    });
    hint.open(wrongBtns, [rightBtn]);
  }
  round();
}

/* ── engine: what comes next? ──
 *
 * Patterns are the first thing that behaves like a loop: a small unit, repeated,
 * and you can say what comes next without being told because you worked out the
 * rule. Level 1 is A-B-A-B; level 3 is three-part units, where he has to hold
 * the whole unit rather than just alternating.
 *
 * The items can be the topic's own naming bank — `use: "<bank id>"` — which
 * means the pattern game is free content on any track that already has one, and
 * its words are already in the voice pack. */
const PATTERN_TIERS = {
  1: { kinds: [["A","B"]], choices: 3, rounds: 5 },
  2: { kinds: [["A","B"], ["A","A","B"], ["A","B","B"]], choices: 3, rounds: 5 },
  3: { kinds: [["A","B","C"], ["A","A","B","B"], ["A","B","B"]], choices: 4, rounds: 6 },
};
const PATTERN_CELLS = 6;

function gamePattern(host, cfg){
  const bank = (week.games.naming || []).find(n => n.id === cfg.use);
  const pool = (cfg.items && cfg.items.length ? cfg.items
    : bank ? [...(bank.basic || []), ...(bank.advanced || [])] : []);
  // Fewer than two kinds of thing cannot make a pattern — that would be one
  // item repeated, which he'd be right to find insulting.
  if (pool.length < 2) return renderPlayHome();
  const lvl = levelOf("pattern");
  const tier = PATTERN_TIERS[lvl];
  const replay = () => { host.innerHTML = ""; gamePattern(host, cfg); };
  let i = 0, got = 0, missed = 0;

  const s = el("div", "stage");
  s.appendChild(el("h2", null, cfg.title || "What Comes Next?"));
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const row = el("div", "patrow");
  const opts = el("div", "opts");
  const fb = el("div", "fb");
  s.append(levelRow("pattern", replay), bar, prompt, row, opts, fb);
  host.appendChild(s);
  const gate = roundGate(opts);
  const hint = hintLadder();

  function round(){
    if (i >= tier.rounds) return donePanel(host, "pattern", got, tier.rounds, replay,
      { levels: true, misses: missed });
    scoreDots(bar, got, tier.rounds);
    gate.reopen();
    fb.textContent = "";
    const kind = tier.kinds[Math.floor(Math.random() * tier.kinds.length)];
    const need = new Set(kind).size;
    const cast = sample(pool, Math.min(need, pool.length));
    // A pool too small for the unit falls back to the simplest pattern it can
    // actually build rather than repeating one item and calling it a pattern.
    const unit = kind.map(letter => cast[("ABC".indexOf(letter)) % cast.length]);
    const cells = [];
    while (cells.length <= PATTERN_CELLS) cells.push(unit[cells.length % unit.length]);
    const answer = cells[PATTERN_CELLS];
    const shown = cells.slice(0, PATTERN_CELLS);

    row.innerHTML = "";
    const cellEls = shown.map(it => {
      const c = el("span", "pcell", it.icon);
      // Dead while the gate is taken: a tap here would interrupt the "Yes!"
      // line, whose end handler is what starts the next round.
      c.onclick = () => {
        if (gate.swallowed()) return;
        cellEls.forEach(x => x.classList.toggle("lit", x === c)); say(it.label);
      };
      row.appendChild(c);
      return c;
    });
    row.appendChild(el("span", "pcell hole", "?"));
    // The pattern is read to him first — "Yellow. Blue. Yellow. Blue." — with
    // each cell lighting as it's named, so the repeat is heard, not just seen.
    // Past the last cell (the question itself), the toggle turns them all off.
    setPrompt(prompt, "What comes next?", [...shown.map(it => it.label), "What comes next?"],
      { onPart: n => cellEls.forEach((c, j) => c.classList.toggle("lit", j === n)) });

    opts.innerHTML = "";
    const choices = shuffle([answer,
      ...sample(pool.filter(p => p.id !== answer.id), Math.min(tier.choices - 1, Math.max(0, pool.length - 1)))]);
    let rightBtn = null; const wrongBtns = [];
    choices.forEach(c => {
      const b = el("button", "opt");
      b.append(el("em", null, c.icon), c.label);
      if (c.id === answer.id) rightBtn = b; else wrongBtns.push(b);
      b.onclick = () => {
        if (gate.swallowed()) return;
        if (c.id === answer.id){
          gate.take();
          b.classList.add("right"); got++; i++; sfx("right");
          // The hole fills with his answer, so the pattern he completed is on
          // screen while the cheer confirms it.
          const hole = row.querySelector(".hole");
          if (hole){ hole.textContent = answer.icon; hole.classList.remove("hole"); }
          fb.textContent = `Yes — ${answer.label}!`; fb.className = "fb good";
          afterSaying(say(`Yes! ${spokenOf(answer)}.`), round);
        } else {
          missed++;
          b.classList.add("wrong"); sfx("wrong");
          fb.textContent = `That one is ${c.label}. Try again.`; fb.className = "fb soft";
          say([`That one is ${spokenOf(c)}. Try again.`, hint.miss(b)]);
          later(() => b.classList.remove("wrong"), 400);
        }
      };
      opts.appendChild(b);
    });
    hint.open(wrongBtns, [rightBtn]);
  }
  round();
}

/* ── engine: trace it ──
 *
 * The Pencil game. The week's letter and numbers drawn big and faint, and he
 * goes over them. Nothing here knows what a C looks like: the glyph is the
 * font's, rasterised into a mask, and the score is two fractions read off
 * that mask — how much of the shape his line covered, and how much of his
 * line stayed on the shape. That is what makes it free for every week, past
 * and future: `trace.items` is a list of strings, and the font does the rest.
 *
 * Both fractions matter. Coverage alone rewards scribbling the whole square;
 * staying-on alone rewards a single careful dot. The level moves how wide the
 * line he has to stay inside is, and whether the guide stays on screen — at
 * level 3 it fades the moment he touches down, which is writing from memory
 * with the shape still warm.
 *
 * Finger or Pencil both work; the Pencil is the point, because this is the
 * one game in here that is actually his hand. */
const TRACE_TIERS = {
  1: { tol: 26, cover: 0.55, stay: 0.55, items: 4, ghost: false },
  2: { tol: 18, cover: 0.65, stay: 0.70, items: 5, ghost: false },
  3: { tol: 14, cover: 0.70, stay: 0.75, items: 6, ghost: true },
};
const traceGlyphs = cfg => (cfg.items || []).map(String).filter(Boolean);
/* Shared level, capped by this week's glyphs: a level is open only when the
 * pool can deal its full board. */
const traceTop = cfg => tierTop(TRACE_TIERS, t => t.items <= traceGlyphs(cfg).length);
const TRACE_SIZE = 320;   // CSS px high; single glyphs remain square
const traceWidth = glyph => /^[A-Za-z]{2,}$/.test(glyph) ? TRACE_SIZE * 2 : TRACE_SIZE;
const TRACE_FONT = "700 250px Fredoka, Nunito, sans-serif";

function traceSpoken(glyph){
  if (/^[A-Za-z]{2,}$/.test(glyph)) return `Trace the word ${glyph}.`;
  if (/^\d+$/.test(glyph)) return `Trace the number ${glyph}.`;
  if (glyph === glyph.toUpperCase()) return `Trace big ${glyph}.`;
  return `Trace little ${glyph.toUpperCase()}.`;
}
function traceLabel(glyph){
  if (/^[A-Za-z]{2,}$/.test(glyph)) return `the word ${glyph}`;
  if (/^\d+$/.test(glyph)) return `the number ${glyph}`;
  return glyph === glyph.toUpperCase() ? `big ${glyph}` : `little ${glyph}`;
}

/* Offscreen raster of a glyph, and the two masks the score reads. `near` is
 * the glyph dilated by `tol`, which is the band his line has to stay in. */
function traceMasks(glyph, tol){
  const n = TRACE_SIZE;
  const w = traceWidth(glyph);
  const off = document.createElement("canvas");
  off.width = w; off.height = n;
  const c = off.getContext("2d", { willReadFrequently: true });
  const paint = (width) => {
    c.clearRect(0, 0, w, n);
    c.fillStyle = "#000"; c.strokeStyle = "#000";
    c.lineJoin = "round"; c.lineCap = "round";
    c.font = TRACE_FONT;
    c.textAlign = "center"; c.textBaseline = "middle";
    // Words get a wider pad; digits keep the original square.
    const m = c.measureText(glyph);
    const scale = Math.min(1, (w * 0.78) / Math.max(1, m.width));
    c.save();
    c.translate(w / 2, n / 2 + (/^\d+$/.test(glyph) ? 0 : 8));
    c.scale(scale, scale);
    if (width){ c.lineWidth = width / scale; c.strokeText(glyph, 0, 0); }
    c.fillText(glyph, 0, 0);
    c.restore();
    const a = c.getImageData(0, 0, w, n).data;
    const mask = new Uint8Array(w * n);
    for (let i = 0; i < w * n; i++) mask[i] = a[i * 4 + 3] > 90 ? 1 : 0;
    return mask;
  };
  return { shape: paint(0), near: paint(tol * 2), width: w };
}

/* His strokes rasterised the same way, so the two questions are the same
 * lookup: shape pixel under his ink = covered; ink pixel under near = stayed. */
function traceScore(strokes, masks, tol){
  const n = TRACE_SIZE;
  const w = masks.width;
  const off = document.createElement("canvas");
  off.width = w; off.height = n;
  const c = off.getContext("2d", { willReadFrequently: true });
  c.strokeStyle = "#000"; c.lineCap = "round"; c.lineJoin = "round";
  c.lineWidth = tol * 2;
  for (const s of strokes){
    c.beginPath();
    s.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
    if (s.length === 1) c.lineTo(s[0].x + 0.1, s[0].y);
    c.stroke();
  }
  const ink = c.getImageData(0, 0, w, n).data;
  let shapeAll = 0, shapeHit = 0;
  for (let i = 0; i < w * n; i++){
    if (!masks.shape[i]) continue;
    shapeAll++;
    if (ink[i * 4 + 3] > 90) shapeHit++;
  }
  // Staying-on is judged on the actual points, not the fat raster: the fat
  // line is the forgiveness, and forgiving it twice makes a scribble pass.
  let pts = 0, on = 0;
  for (const s of strokes) for (const p of s){
    pts++;
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x >= 0 && y >= 0 && x < w && y < n && masks.near[y * w + x]) on++;
  }
  return { cover: shapeAll ? shapeHit / shapeAll : 0, stay: pts ? on / pts : 0 };
}

/* The pad: two canvases, the pen handling, Start over and Done. Built once per
 * stage and handed one glyph at a time, so Old Honey can mount the same pad
 * between rounds of other kinds. `present(glyph, lead)` draws the guide, says
 * the prompt and resolves with { pass, misses } once he is through with it:
 * a first miss gets a retry, a second is scored and moved past. `prompt` and
 * `fb` are the stage's, above and below the pad. */
function tracePad(tier, prompt, fb){
  /* Closed from the moment it is built, because the pad reaches the screen
   * before it is ready to be drawn on: `ready()` waits on the font, and
   * `gameTrace` has already appended the canvases and their handlers by then.
   * A Done pressed in that window used to score a glyph that had not been
   * presented yet — no masks, nothing to score against. The first `present()`
   * is what opens it. */
  const gate = roundGate();
  gate.take();
  const pad = el("div", "tracepad");
  const guide = document.createElement("canvas");
  const ink = document.createElement("canvas");
  guide.className = "guide"; ink.className = "ink";
  pad.append(guide, ink);
  const row = el("div", "tracerow");
  const clear = el("button", "btn ghost", "Start over");
  const done = el("button", "btn", "Done");
  row.append(clear, done);
  const gc = guide.getContext("2d");
  const ic = ink.getContext("2d");

  // The font has to be IN before the guide is drawn from it, or the first
  // glyph of the night is Helvetica's idea of a C.
  async function ready(){
    try { await document.fonts.load(TRACE_FONT); } catch {}
  }

  let width = TRACE_SIZE;
  function resize(glyph){
    width = traceWidth(glyph);
    pad.style.width = `min(${width}px, 84vw, 100%)`;
    pad.style.aspectRatio = `${width} / ${TRACE_SIZE}`;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const cv of [guide, ink]){
      cv.width = width * dpr; cv.height = TRACE_SIZE * dpr;
      cv.getContext("2d").scale(dpr, dpr);
    }
    ic.lineCap = "round"; ic.lineJoin = "round";
  }

  let strokes = [], live = null, masks = null, retried = false, misses = 0, settle = null;

  function drawGuide(glyph){
    gc.clearRect(0, 0, width, TRACE_SIZE);
    gc.save();
    gc.font = TRACE_FONT;
    gc.textAlign = "center"; gc.textBaseline = "middle";
    const m = gc.measureText(glyph);
    const scale = Math.min(1, (width * 0.78) / Math.max(1, m.width));
    gc.translate(width / 2, TRACE_SIZE / 2 + (/^\d+$/.test(glyph) ? 0 : 8));
    gc.scale(scale, scale);
    // The band he has to stay inside, then the shape itself, dotted like a
    // worksheet so it reads as "go over me" and not "this is the answer".
    gc.lineJoin = "round"; gc.lineCap = "round";
    gc.strokeStyle = "rgba(255,194,46,.28)"; gc.lineWidth = tier.tol * 2 / scale;
    gc.strokeText(glyph, 0, 0);
    gc.fillStyle = "rgba(46,27,6,.22)";
    gc.fillText(glyph, 0, 0);
    gc.setLineDash([6 / scale, 9 / scale]);
    gc.strokeStyle = "rgba(46,27,6,.6)"; gc.lineWidth = 3 / scale;
    gc.strokeText(glyph, 0, 0);
    gc.restore();
    guide.classList.remove("ghost");
  }
  function clearInk(){
    strokes = []; live = null;
    ic.clearRect(0, 0, width, TRACE_SIZE);
  }
  const at = e => {
    const r = ink.getBoundingClientRect();
    return { x: (e.clientX - r.left) * width / r.width, y: (e.clientY - r.top) * TRACE_SIZE / r.height };
  };
  ink.onpointerdown = e => {
    if (gate.busy()) return;
    e.preventDefault();
    ink.setPointerCapture(e.pointerId);
    live = [at(e)]; strokes.push(live);
    // Level 3: the guide leaves when the pen lands.
    if (tier.ghost) guide.classList.add("ghost");
    ic.strokeStyle = e.pointerType === "pen" ? "#2F6DB5" : "#C7375F";
    ic.lineWidth = e.pointerType === "pen" ? 9 : 14;
    ic.beginPath(); ic.moveTo(live[0].x, live[0].y);
  };
  ink.onpointermove = e => {
    if (!live) return;
    e.preventDefault();
    const p = at(e);
    live.push(p);
    ic.lineTo(p.x, p.y); ic.stroke();
    ic.beginPath(); ic.moveTo(p.x, p.y);
  };
  ink.onpointerup = ink.onpointercancel = () => { live = null; };

  clear.onclick = () => { if (!gate.busy()){ sfx("tap"); clearInk(); fb.textContent = ""; } };

  function present(glyph, lead){
    gate.reopen();
    fb.textContent = ""; fb.className = "fb";
    retried = false; misses = 0;
    resize(glyph);
    masks = traceMasks(glyph, tier.tol);
    drawGuide(glyph);
    clearInk();
    setPrompt(prompt, `Trace ${traceLabel(glyph)}`, [lead, traceSpoken(glyph)]);
    return new Promise(r => { settle = r; });
  }

  done.onclick = () => {
    if (gate.busy()) return;
    if (!strokes.length){ sfx("tap"); say("Draw on the lines first."); fb.textContent = "Draw on the lines first."; fb.className = "fb soft"; return; }
    gate.take();
    const sc = traceScore(strokes, masks, tier.tol);
    const pass = sc.cover >= tier.cover && sc.stay >= tier.stay;
    if (pass || retried){
      // The miss was counted when the retry was offered; giving up is the same
      // glyph, not a second one.
      if (pass){ sfx("right"); fb.textContent = "You traced it!"; fb.className = "fb good"; }
      else { sfx("tap"); fb.textContent = "Okay — next one."; fb.className = "fb soft"; }
      afterSaying(say(pass ? "You traced it!" : "Okay. Next one."), () => settle({ pass, misses }));
    } else {
      misses++; retried = true; sfx("wrong");
      const why = sc.cover < tier.cover ? "Go over the whole shape." : "Stay on the line.";
      fb.textContent = `Try that one again. ${why}`; fb.className = "fb soft";
      afterSaying(say(["Try that one again.", why]), () => { clearInk(); gate.reopen(); });
    }
  };

  return { nodes: [pad, row], ready, present };
}

async function gameTrace(host, cfg){
  const gen = playGen;
  const pool = traceGlyphs(cfg);
  if (!pool.length) return renderPlayHome();
  const top = traceTop(cfg);
  const lvl = levelOf("trace", top);
  const tier = TRACE_TIERS[lvl];
  const replay = () => { host.innerHTML = ""; gameTrace(host, cfg); };
  const items = freshSample("trace", pool.map(id => ({ id })), tier.items).map(x => x.id);
  let i = 0, got = 0, missed = 0;

  const s = el("div", "stage");
  s.appendChild(el("h2", null, cfg.title || "Trace It"));
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const fb = el("div", "fb");
  const pad = tracePad(tier, prompt, fb);
  s.append(levelRow("trace", replay, top), bar, prompt, ...pad.nodes, fb);
  host.appendChild(s);

  await pad.ready();
  if (gen !== playGen) return;

  async function round(){
    if (i >= items.length) return donePanel(host, "trace", got, items.length, replay,
      { levels: true, misses: missed, top });
    scoreDots(bar, got, items.length);
    const { pass, misses } = await pad.present(items[i]);
    if (pass) got++;
    missed += misses; i++;
    round();
  }
  round();
}

/* ── game: Old Honey ──
 *
 * Nothing from a past week ever came back. Letter Hunt reads this week's
 * letter, the naming banks are this week's, Trace this week's glyphs, and the
 * Monday after, last week is gone. This board deals from the last three docs
 * of the loaded track instead: letter-sound boards, find-the-picture rounds
 * and, up the ladder, a couple of glyphs, shuffled together, each one led in
 * by the week it came from so he hears that this is old honey. The rounds are
 * the other games' own; only the deal and the stage are this one's.
 *
 * `board` is one letter round's deal (see letterDeal); `from` and `choices`
 * move the naming rounds the way NAME_TIERS does. The glyphs are traced at
 * the Pencil game's own width, since that ladder is his hand and this one is
 * his memory. */
const REVIEW_TIERS = {
  1: { letter: 3, name: 2, trace: 0, board: { yes: 2, no: 2, hard: 0 }, from: "basic",    choices: 4 },
  2: { letter: 3, name: 3, trace: 1, board: { yes: 2, no: 3, hard: 1 }, from: "all",      choices: 5 },
  3: { letter: 3, name: 3, trace: 2, board: { yes: 3, no: 4, hard: 2 }, from: "advanced", choices: 6 },
};
const REVIEW_BACK = 3;   // docs it reaches back over

/* The docs before this one on its track, nearest first. School weeks sit on
 * their Monday and a topic's units on the same field, so one order serves. */
function earlierWeeks(w = week, weeks = track.weeks){
  return weeks.filter(x => x.start < w.start)
    .sort((a, b) => a.start < b.start ? 1 : -1)
    .slice(0, REVIEW_BACK);
}
const fromLine = w => `From ${w.theme || w.label}.`;

function reviewBanks(doc){
  const g = doc.games || {};
  return [...(g.feelings ? [feelingsBank(doc)] : []), ...(g.naming || [])];
}

/* Round-robin over the docs, so three letter boards are three different weeks
 * when there are three to draw from, and the naming rounds likewise. Each
 * source keeps its own last-deal memory, as the games this borrows from do. */
function reviewDeal(docs, tier){
  const spread = (list, n) => Array.from({ length: list.length ? n : 0 }, (_, i) => list[i % list.length]);
  const letters = spread(docs.filter(d => d.doc.games && d.doc.games.letter), tier.letter).map(d => {
    const L = d.doc.games.letter;
    return { kind: "letter", src: d, L, ...letterDeal(L, tier.board, `review:letter:${d.id}`) };
  });
  const banked = docs.map(d => ({ src: d, banks: reviewBanks(d.doc) })).filter(x => x.banks.length);
  const names = spread(banked, tier.name).map(({ src, banks }) => {
    const cfg = sample(banks, 1)[0];
    const { asked, distractors } = nameLists(cfg, tier);
    const target = freshSample(`review:${src.id}:${cfg.id}`, asked, 1)[0];
    return { kind: "name", src, target, choices: nameChoices(target, distractors, tier.choices) };
  });
  const glyphs = docs.flatMap(d => (((d.doc.games || {}).trace || {}).items || [])
    .map(String).filter(Boolean).map(glyph => ({ id: `${d.id}:${glyph}`, glyph, src: d })));
  const traces = tier.trace
    ? freshSample("review:trace", glyphs, Math.min(tier.trace, glyphs.length))
        .map(t => ({ kind: "trace", src: t.src, glyph: t.glyph }))
    : [];
  return shuffle([...letters, ...names, ...traces]);
}

async function gameReview(host){
  const gen = playGen;
  const lvl = levelOf("review");
  const tier = REVIEW_TIERS[lvl];
  const replay = () => { host.innerHTML = ""; gameReview(host); };

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Old Honey"));
  const bar = el("div", "scorebar");
  const from = el("div", "from");
  const prompt = el("div", "prompt");
  const area = el("div");
  const opts = el("div", "opts");
  const fb = el("div", "fb");
  s.append(levelRow("review", replay), bar, from, prompt, area, fb);
  host.appendChild(s);
  const ctx = { prompt, opts, fb, gate: roundGate(opts), hint: hintLadder() };
  // The Pencil game's level, uncapped: a week too short to deal that game's
  // board is why `traceTop` exists, and this board deals its own glyphs. All
  // it borrows from the tier is how wide a line the hand is allowed.
  const pad = tier.trace ? tracePad(TRACE_TIERS[levelOf("trace")], prompt, fb) : null;

  // Everything is fetched before anything is dealt. A doc that won't load
  // tonight — offline, and never opened on this device — is left out of the
  // hand rather than failing the board.
  const docs = (await Promise.all(earlierWeeks().map(async w => ({ ...w, doc: await weekDocFor(topic, w.id) }))))
    .filter(d => d.doc);
  if (pad) await pad.ready();
  if (gen !== playGen) return;
  const rounds = reviewDeal(docs, tier);
  if (!rounds.length) return renderPlayHome();

  let i = 0, got = 0, missed = 0;
  function round(){
    if (i >= rounds.length) return donePanel(host, "review", got, rounds.length, replay,
      { levels: true, misses: missed });
    scoreDots(bar, got, rounds.length);
    const r = rounds[i];
    from.textContent = `🍯 ${r.src.theme || r.src.label} · ${r.src.label}`;
    const lead = fromLine(r.src);
    const next = m => { got++; missed += m; i++; round(); };
    if (r.kind === "trace"){
      area.replaceChildren(...pad.nodes);
      pad.present(r.glyph, lead).then(({ pass, misses }) => { if (pass) got++; missed += misses; i++; round(); });
      return;
    }
    area.replaceChildren(opts);
    if (r.kind === "letter") letterRound(ctx, r.L, r.yes, r.no, next, lead);
    else nameRound(ctx, r.target, r.choices, next, lead);
  }
  round();
}

/* Which games exist is the loaded week's decision, not this list's: a game
 * appears when the doc carries the config it needs, and vanishes when it
 * doesn't. That is what makes a whole topic data — a track with a `code` block
 * gets Code the Bee and no Letter Hunt, and nothing in here changed.
 *
 * `id` is the key his stars are stored under, so it has to be stable and unique
 * across every topic. The engines take theirs from the config block, which is
 * why a naming bank or a sort has to name itself in the JSON. */
function gameList(w = week, weeks = track.weeks){
  const g = w.games || {};
  const out = [];
  const add = (...items) => items.forEach(x => out.push(x));

  if (g.feelings) add({ id: "faces", emoji: "😀", name: "Feelings Faces",
    sub: "Find the feeling", run: h => gameName(h, feelingsBank()) });
  (g.naming || []).forEach(cfg => add({ id: cfg.id, emoji: cfg.emoji || "🏷️",
    name: cfg.title, sub: cfg.sub || "Find the right one", run: h => gameName(h, cfg) }));
  if (g.numbers) add(
    { id: "numbers", emoji: "🔢", name: "Number Hive",    sub: "Find the number",  run: gameNumbers },
    { id: "count",   emoji: "🔟", name: "Count the Hive", sub: "Up and backwards", run: gameCount },
  );
  if (g.compare) add({ id: "more", emoji: "⚖️", name: g.compare.title || "Which is More?",
    sub: g.compare.sub || "The bigger pile", top: moreTop(g.compare), run: h => gameMore(h, g.compare) });
  if (g.days) add({ id: "days", emoji: "🗓️", name: "Day by Day",
    sub: "Yesterday and tomorrow", run: gameDays });
  if (g.letter) add({ id: "letter", emoji: "🔤", name: `Letter ${g.letter.letter} Hunt`,
    sub: "Find the sound", run: gameLetter });
  if (g.trace && traceGlyphs(g.trace).length) add({ id: "trace", emoji: "✏️",
    name: g.trace.title || "Trace It", sub: g.trace.sub || "Pencil on the lines", top: traceTop(g.trace), run: h => gameTrace(h, g.trace) });
  // Only once the track has enough behind it to look back on.
  if (earlierWeeks(w, weeks).length >= 2) add({ id: "review", emoji: "🐻", name: "Old Honey",
    sub: "Weeks you already know", run: gameReview });
  (g.sort || []).forEach(cfg => add({ id: cfg.id, emoji: cfg.emoji || "🪣",
    name: cfg.title, sub: cfg.sub || "You be the judge", run: h => gameSort(h, cfg) }));
  (g.order || []).forEach(cfg => add({ id: cfg.id, emoji: cfg.emoji || "👣",
    name: cfg.title, sub: cfg.sub || "First, then, last", run: h => gameOrder(h, cfg) }));
  if (g.code) add({ id: "code", emoji: g.code.actor || "🐝", name: g.code.title || "Code the Bee",
    sub: g.code.sub || "Write the program", run: h => gameCode(h, g.code) });
  if (g.pattern) add({ id: "pattern", emoji: "🔁", name: g.pattern.title || "What Comes Next?",
    sub: g.pattern.sub || "Finish the pattern", run: h => gamePattern(h, g.pattern) });
  // The tile wears the mode it will open in, so he can see from the picker
  // whether he's about to get the faces or the cars.
  if (weekDeck(w) || packList.length) add({ id: "match",
    emoji: () => (matchPackMeta(w) || {}).emoji || "🃏",
    name: () => `${(matchPackMeta(w) || {}).name || "Card"} Match`,
    sub: "Find the pairs", run: gameMatch });
  if (g.feelings && g.feelings.helps) add({ id: "helps", emoji: "🌬️", name: "What Helps?",
    sub: "When it feels big", run: gameHelps });
  if ((w.books || []).some(b => (b.videos || []).length)) add({ id: "story", emoji: "📖",
    name: "Story Time", sub: "This week's books", run: gameStory });
  // Only songs the manifest can actually play — and only when the recording
  // was made from THESE lyrics: the doc's words without their own audio is a
  // tile that opens on silence, or worse, on somebody else's song.
  (w.songs || []).forEach(sg => {
    if ((sg.lyrics || []).length && songReady(sg)) add({ id: sg.id, emoji: sg.emoji || "🎤",
      name: sg.title, sub: sg.sub || "Sing along", run: h => gameSing(h, sg) });
  });

  return out;
}

/* ───────────────────────── YouTube ─────────────────────────
 * Deliberately the IFrame API and not a bare <iframe>. A plain embed drops
 * him onto a wall of tappable suggestions the second the story ends; with the
 * API we catch ENDED and cover the player before that grid ever renders.
 *
 * Catching ENDED is necessary and it is not sufficient. Three other doors out
 * of the video open while it is still playing, and none of them fire an event:
 *
 *   - End screens. The last twenty seconds of a video can carry the uploader's
 *     own cards for other videos. They are painted while the state is still
 *     PLAYING, so ENDED is too late. iv_load_policy only ever killed the old
 *     annotations, never these.
 *   - The player chrome. The title, the channel name and "Watch on YouTube" are
 *     links to youtube.com. modestbranding stopped hiding them in 2023, and it
 *     would not have hidden all of them anyway.
 *   - Pause. Pausing an embed paints a grid of suggestions over the frame.
 *
 * rel:0 does not close any of these. Since 2018 it does not mean "no related
 * videos" — it means "related videos from this channel only".
 *
 * So the frame is treated as hostile: its own controls are turned off, and a
 * shield over it eats every tap so nothing inside can be pressed no matter what
 * YouTube decides to paint there. The buttons below the video are ours.
 *
 * The embed also refuses to play at all — error 153 — if the page sends no
 * referrer; YouTube started enforcing that in late 2025 and Safari/iPad hits
 * it hardest. public/_headers therefore says strict-origin-when-cross-origin,
 * not no-referrer. Putting no-referrer back breaks every book video. */
let ytReady = false, ytQueued = null, player = null, currentAsk = "", lastVideo = null;

function loadYT(){
  if (window.YT && window.YT.Player){ ytReady = true; return; }
  if (document.getElementById("ytapi")) return;
  const s = document.createElement("script");
  s.id = "ytapi";
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
}
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (ytQueued){ const q = ytQueued; ytQueued = null; openVideo(q.v, q.title, q.ask); }
};

/* YT.Player replaces the #player div with its iframe, so the shield and the
 * pause cover have to be rebuilt as its siblings every time. */
function resetStage(){
  const wrap = document.querySelector(".player-wrap");
  wrap.innerHTML = '<div id="player"></div><div class="player-shield"></div>' +
                   '<div class="player-cover" hidden>Paused</div>';
  return wrap;
}
const playerCover = () => document.querySelector(".player-cover");

function openVideo(v, title, ask){
  hush();
  musicStop();
  currentAsk = ask || "";
  lastVideo = { v, title, ask };   // what "Try again" rebuilds after an error
  $("veil").hidden = false;
  $("veilTitle").textContent = `${title} — ${v.label}`;
  $("veilDone").hidden = true;
  $("veilDone").innerHTML = "";
  const wrap = resetStage();
  wrap.hidden = false;
  $("veilCtrls").hidden = false;

  if (!ytReady){ ytQueued = { v, title, ask }; loadYT(); return; }

  player = new YT.Player("player", {
    host: "https://www.youtube-nocookie.com",
    videoId: v.id,
    playerVars: {
      rel: 0, playsinline: 1, iv_load_policy: 3,
      controls: 0,      // no title, no channel link, no "Watch on YouTube"
      disablekb: 1,     // and no reaching those with the keyboard either
      fs: 0,            // fullscreen would put the frame outside the shield
      autoplay: 1,      // nothing left in the frame to press play with
    },
    events: {
      onReady: () => {
        // The shield only stops taps. Sequential focus — a paired keyboard,
        // Switch Control — walks straight past it into the frame and lands on
        // the title and channel links; disablekb does not cover that, it only
        // turns off the player's own keyboard shortcuts. Taking the iframe out
        // of the tab order is what keeps those links unreachable.
        try { player.getIframe().tabIndex = -1; } catch {}
        try { player.playVideo(); } catch {}
      },
      onStateChange: onPlayerState,
      onError: e => videoFailed(e.data),
    },
  });
}

/* Autoplay can still be refused — the queued path builds the player after the
 * tap that asked for it has expired — so the button follows the real state
 * rather than assuming we are playing. */
function onPlayerState(e){
  const S = YT.PlayerState;
  if (e.data === S.ENDED){ videoEnded(); return; }
  const paused = e.data === S.PAUSED || e.data === S.UNSTARTED || e.data === S.CUED;
  const cover = playerCover();
  if (cover) cover.hidden = !paused;
  $("veilPlay").textContent = paused ? "Play" : "Pause";
}

$("veilPlay").onclick = () => {
  if (!player) return;
  try {
    const s = player.getPlayerState();
    if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) player.pauseVideo();
    else player.playVideo();
  } catch {}
};
$("veilStop").onclick = closeVideo;

function renderDone(nodes){
  const done = $("veilDone");
  done.innerHTML = "";
  nodes.forEach(n => done.appendChild(n));
  done.hidden = false;
}

/* The whole reason for using the IFrame API: cover the player the instant the
 * story ends, before YouTube paints its grid of tappable suggestions. */
function videoEnded(){
  document.querySelector(".player-wrap").hidden = true;
  $("veilCtrls").hidden = true;
  const again = el("button", "btn", "Watch it again");
  again.onclick = () => {
    try { player.seekTo(0); player.playVideo(); } catch {}
    $("veilDone").hidden = true;
    document.querySelector(".player-wrap").hidden = false;
    $("veilCtrls").hidden = false;
  };
  const close = el("button", "btn ghost", "Done");
  close.onclick = closeVideo;
  renderDone([
    el("p", "veil-done-h", "That's the book. 📖"),
    el("p", null, currentAsk),
    again, close,
  ]);
  // A book heard to the end is a finished round: one star on the Story Time
  // tile, a day on the streak, honey in the jar. Once, not once per book — the
  // star says he sat through a story this week, not how many.
  award("story", 1);
  say("The end.");
}

/* onError covers four different failures and only one of them is the uploader's
 * doing, so the code picks the words. Blaming the channel for all of them sent
 * us hunting a block that did not exist — every book video in the weeks so far
 * is embeddable, and what actually fired was a player-side stumble.
 *
 * 5, 101 and 150 are worth simply retrying: 5 is the player failing to start,
 * and 150 comes back on videos that play perfectly on the next attempt. 2 (bad
 * ID in the week file) and 100 (video gone) will fail every time, so they get
 * no retry — there is nothing on the other end of it. */
const VIDEO_ERRORS = {
  2:   { why: "The video ID in this week's file isn't a video.", again: false },
  5:   { why: "The player couldn't start it. That usually clears on a second try.",
         again: true },
  100: { why: "The video is gone from YouTube — deleted or made private.",
         again: false },
  101: { why: "YouTube wouldn't play it here. The channel may block playing it "
              + "off-site, or it may be a hiccup.", again: true },
};
VIDEO_ERRORS[150] = VIDEO_ERRORS[101];   // same failure, two codes

/* The error screen used to link to youtube.com in Learn mode. That was the one
 * door in the whole app that opened onto YouTube itself, and on the iPad it
 * launched the YouTube app — so it's gone in both modes. Retry or close. */
function videoFailed(code){
  const e = VIDEO_ERRORS[code]
    || { why: `YouTube stopped with error ${code}.`, again: true };
  console.warn(`[hive] video ${lastVideo && lastVideo.v.id} failed: YouTube error ${code}`);
  document.querySelector(".player-wrap").hidden = true;
  $("veilCtrls").hidden = true;
  const out = [
    el("p", "veil-done-h", "This one won't play here."),
    el("p", null, mode === "play" ? "Ask a grown-up to put this book on." : e.why),
  ];
  if (e.again){
    const r = el("button", "btn", "Try again");
    r.onclick = () => { const q = lastVideo; closeVideo(); openVideo(q.v, q.title, q.ask); };
    out.push(r);
  }
  const c = el("button", "btn ghost", "Close");
  c.onclick = closeVideo;
  out.push(c);
  renderDone(out);
}

function closeVideo(){
  try { if (player && player.destroy) player.destroy(); } catch {}
  player = null;
  ytQueued = null;
  $("veil").hidden = true;
  resetStage().hidden = false;
  $("veilCtrls").hidden = true;
  $("veilDone").hidden = true;
  hush();
}
$("veilX").onclick = closeVideo;

/* ───────────────────────── map mode ─────────────────────────
 *
 * The road: every week of every track as a stop on one path, so he and a
 * grown-up can both see what's done and what isn't without opening each week.
 * Done is two fractions read straight off shared state — activities ticked,
 * games with a star — against what the doc actually carries, so a week with
 * three games and a week with eleven are each measured against themselves.
 *
 * Each stop wears one of his worlds in
 * name, colour and emoji only. The characters are somebody's, and this file
 * is published in the fork; a real picture goes in public/roadmap/ on this
 * deploy alone, which the sanitizer drops by directory like the photos. */
/* The worlds. A world belongs to a TRACK, not a week: the school year is the
 * railway the whole board runs along, and each track we wrote ourselves is a
 * land off to the side of it. Names, colours and a scene drawn here from
 * shapes; the characters are somebody's, and this file is published. A real
 * picture goes in public/roadmap/ on this deploy alone (see loadRoadmapArt). */
const WORLDS = {
  railway:       { name: "Railway Island",    emoji: "🚂", tone: "#5C8FD6" },
  backyard:        { name: "The Backyard",   emoji: "🐶", tone: "#7FB7E6" },
  puddles:        { name: "Puddle Hill",    emoji: "🐷", tone: "#F5A9C5" },
  clubhouse:       { name: "The Clubhouse", emoji: "🐭", tone: "#F26B6B" },
  city:     { name: "Animal City",           emoji: "🦊", tone: "#F4A44A" },
  speedway:         { name: "Desert Speedway",   emoji: "🏎️", tone: "#E0553D" },
  planet: { name: "Robot Planet",          emoji: "🤖", tone: "#8FA3B8" },
  pond:      { name: "Pond Hideout",    emoji: "🐢", tone: "#6DBB6D" },
  meadow:        { name: "Mushroom Meadow",   emoji: "🍄", tone: "#F06060" },
};
/* Which track lives in which world. Anything not named here takes the next
 * unused world in the order above, so a new track gets a land for free. */
const TRACK_WORLDS = {
  school: "railway", body: "puddles", code: "meadow", ai: "clubhouse",
  bitcoin: "city", robots: "planet", build: "speedway",
};
function worldFor(topicId){
  const id = TRACK_WORLDS[topicId];
  if (id) return { id, ...WORLDS[id] };
  const taken = new Set(Object.values(TRACK_WORLDS));
  const spare = Object.keys(WORLDS).find(k => !taken.has(k)) || "backyard";
  return { id: spare, ...WORLDS[spare] };
}
/* The little scene on each land's sign — shapes only, no characters. */
function worldArt(id){
  const A = {
    railway: `<rect x="0" y="40" width="64" height="24" fill="#6DBB6D"/><rect x="0" y="44" width="64" height="6" fill="#6B5230"/><g fill="#ddd"><rect x="4" y="42" width="4" height="10"/><rect x="16" y="42" width="4" height="10"/><rect x="28" y="42" width="4" height="10"/><rect x="40" y="42" width="4" height="10"/><rect x="52" y="42" width="4" height="10"/></g><rect x="10" y="18" width="30" height="20" rx="3" fill="#3B6FC4"/><rect x="36" y="10" width="16" height="28" rx="3" fill="#3B6FC4"/><circle cx="18" cy="42" r="5" fill="#2E1B06"/><circle cx="44" cy="42" r="5" fill="#2E1B06"/><rect x="14" y="6" width="6" height="12" fill="#2E1B06"/><circle cx="17" cy="4" r="4" fill="#fff" opacity=".8"/>`,
    backyard: `<rect x="0" y="36" width="64" height="28" fill="#7FC97F"/><g fill="#E9C27A"><rect x="2" y="22" width="6" height="24"/><rect x="12" y="22" width="6" height="24"/><rect x="22" y="22" width="6" height="24"/><rect x="32" y="22" width="6" height="24"/></g><rect x="0" y="28" width="40" height="4" fill="#D9A95A"/><circle cx="52" cy="20" r="12" fill="#3F8F5E"/><rect x="50" y="28" width="4" height="14" fill="#6B5230"/><circle cx="12" cy="12" r="6" fill="#FFC22E"/>`,
    puddles: `<rect x="0" y="0" width="64" height="64" fill="#BEE3F8"/><ellipse cx="32" cy="50" rx="26" ry="9" fill="#8B5E3C"/><ellipse cx="32" cy="48" rx="22" ry="6" fill="#A9764F"/><ellipse cx="32" cy="46" rx="18" ry="4" fill="#8B5E3C"/><circle cx="14" cy="14" r="7" fill="#fff"/><circle cx="22" cy="14" r="9" fill="#fff"/><circle cx="30" cy="15" r="6" fill="#fff"/><rect x="0" y="56" width="64" height="8" fill="#7FC97F"/>`,
    clubhouse: `<rect x="8" y="30" width="48" height="30" rx="6" fill="#F26B6B"/><path d="M4 32 L32 8 L60 32 Z" fill="#C7375F"/><rect x="31" y="2" width="2" height="14" fill="#2E1B06"/><path d="M33 3 L44 7 L33 11 Z" fill="#FFE07A"/><rect x="26" y="42" width="12" height="18" rx="2" fill="#FFE07A"/><rect x="14" y="38" width="8" height="8" fill="#fff"/><rect x="42" y="38" width="8" height="8" fill="#fff"/>`,
    city: `<rect x="0" y="0" width="64" height="64" fill="#FFE9B0"/><rect x="4" y="30" width="10" height="34" fill="#F4A44A"/><rect x="16" y="18" width="12" height="46" fill="#E0553D"/><rect x="30" y="26" width="10" height="38" fill="#3B7EA1"/><rect x="42" y="10" width="14" height="54" fill="#7A4FA3"/><g fill="#fff"><rect x="19" y="22" width="3" height="3"/><rect x="24" y="22" width="3" height="3"/><rect x="19" y="30" width="3" height="3"/><rect x="45" y="16" width="3" height="3"/><rect x="51" y="16" width="3" height="3"/><rect x="45" y="24" width="3" height="3"/><rect x="33" y="32" width="3" height="3"/></g><circle cx="8" cy="10" r="5" fill="#FFC22E"/>`,
    speedway: `<rect x="0" y="0" width="64" height="64" fill="#FBD38D"/><path d="M0 40 Q32 20 64 40 L64 64 L0 64 Z" fill="#555"/><path d="M4 44 Q32 28 60 44" stroke="#FFE07A" stroke-width="3" stroke-dasharray="6 6" fill="none"/><rect x="18" y="28" width="28" height="12" rx="5" fill="#E0553D"/><rect x="24" y="22" width="14" height="8" rx="3" fill="#E0553D"/><circle cx="24" cy="40" r="4" fill="#2E1B06"/><circle cx="40" cy="40" r="4" fill="#2E1B06"/><path d="M0 24 L10 8 L20 24 Z" fill="#C98A3E"/><path d="M44 22 L54 4 L64 22 Z" fill="#C98A3E"/>`,
    planet: `<rect x="0" y="0" width="64" height="64" fill="#2C3A4F"/><circle cx="12" cy="12" r="2" fill="#fff"/><circle cx="50" cy="8" r="1.5" fill="#fff"/><circle cx="56" cy="30" r="2" fill="#fff"/><circle cx="32" cy="60" r="30" fill="#8FA3B8"/><circle cx="32" cy="60" r="22" fill="#B8C7D9"/><rect x="20" y="30" width="24" height="18" rx="3" fill="#5C8FD6"/><rect x="25" y="36" width="5" height="5" fill="#FFE07A"/><rect x="34" y="36" width="5" height="5" fill="#FFE07A"/><rect x="28" y="24" width="8" height="6" fill="#5C8FD6"/>`,
    pond: `<rect x="0" y="0" width="64" height="64" fill="#3C4A3E"/><rect x="0" y="44" width="64" height="20" fill="#2A3A2C"/><ellipse cx="32" cy="30" rx="18" ry="12" fill="#6DBB6D"/><ellipse cx="32" cy="30" rx="12" ry="7" fill="#4E9A4E"/><rect x="14" y="44" width="36" height="6" rx="3" fill="#6B5230"/><circle cx="32" cy="54" r="8" fill="#555"/><circle cx="32" cy="54" r="5" fill="#333"/><rect x="4" y="4" width="56" height="30" rx="4" fill="none" stroke="#5B6B5D" stroke-width="3"/>`,
    meadow: `<rect x="0" y="0" width="64" height="64" fill="#8FD3F4"/><rect x="0" y="50" width="64" height="14" fill="#7FC97F"/><ellipse cx="20" cy="28" rx="16" ry="12" fill="#F06060"/><rect x="13" y="32" width="14" height="18" rx="3" fill="#FFF6E2"/><circle cx="14" cy="24" r="3.5" fill="#fff"/><circle cx="26" cy="22" r="3.5" fill="#fff"/><rect x="44" y="18" width="12" height="12" fill="#FFC22E" stroke="#C98A3E" stroke-width="2"/><circle cx="48" cy="44" r="8" fill="#4E9A4E"/><circle cx="41" cy="47" r="5" fill="#3F8F5E"/>`,
  };
  return A[id] || "";
}
const DONE_AT = 0.7;   // a stop is done when both halves clear this

/* Which worlds have a picture on this deploy: public/roadmap/index.json lists
 * the ids with a file. One fetch, not nine 404s every time the map opens, and
 * a deploy with no such folder (the demo, a fresh clone) simply has none. */
let roadmapArt = null;
async function loadRoadmapArt(){
  if (roadmapArt) return roadmapArt;
  try {
    const res = await fetch("/roadmap/index.json", { cache: "no-store" });
    roadmapArt = res.ok ? await res.json() : [];
  } catch { roadmapArt = []; }
  if (!Array.isArray(roadmapArt)) roadmapArt = [];
  return roadmapArt;
}

const docCache = {};
async function weekDocFor(t, id){
  const path = `${t.dir}/${id}.json`;
  // A failure is not remembered: offline tonight must not mean "not written"
  // until the page is reloaded.
  if (!docCache[path]) docCache[path] = getJSON(path).then(resolveWeekDoc).catch(() => { delete docCache[path]; return null; });
  return docCache[path];
}

/* Every track with its weeks in date order; the school first. */
async function allTracks(){
  const out = [];
  for (const t of topicList()){
    let idx;
    try { idx = t.dir === "/weeks" ? index : await getJSON(`${t.dir}/index.json`); }
    catch { continue; }
    const weeks = (idx.weeks || []).slice().sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    out.push({ topic: t, weeks, world: worldFor(t.id) });
  }
  return out.sort((a, b) => (a.topic.dir === "/weeks" ? 0 : 1) - (b.topic.dir === "/weeks" ? 0 : 1));
}

/* The two fractions. Keys are built by hand here rather than through K(),
 * which only knows the week that's open. They have to match moveNode,
 * dailyKey and award exactly, or the map lies about a week it can't open. */
function stopProgress(doc, id){
  const keys = [];
  (doc.days || []).forEach(d => (d.moves || []).forEach((m, i) => keys.push(`${id}:${d.key}:${i}`)));
  if ((doc.days || []).length) (doc.visit?.moves || []).forEach((m, i) => keys.push(`${id}:visit:${i}`));
  // A track with no five-day grid keys its every-day strip under "any" — one
  // tick per item, not five (see renderDay).
  const dks = doc.days && doc.days.length ? DAY_KEYS : ["any"];
  (doc.daily || []).forEach((m, i) => dks.forEach(dk => keys.push(`${id}:${dk}:daily:${m.id || i}`)));
  const ticked = keys.filter(k => get("checks", k, false)).length;
  // A stop's own games only: Old Honey rides whichever week is open, and
  // counting it here would move the Done mark on every past week. Its honey
  // still counts, so the stars are read off the bucket by week, as the jar
  // reads them, rather than off this list.
  const games = gameList(doc, []);
  const played = games.filter(g => weekGameStars(id, g) > 0).length;
  // Keep honey from removed games, but count a renamed game's current and
  // legacy keys as one board if both exist.
  const aliasedGames = games.filter(g => legacyGameId(id, g));
  const aliasedKeys = new Set(aliasedGames.flatMap(g => [`${id}:${g.id}`, `${id}:${legacyGameId(id, g)}`]));
  const aliasedStars = aliasedGames.reduce((n, g) => n + weekGameStars(id, g), 0);
  const starsGot = aliasedStars + Object.entries(state.stars).reduce((n, [k, v]) =>
    k.startsWith(`${id}:`) && !aliasedKeys.has(k) ? n + v : n, 0);
  return { ticked, moves: keys.length, played, games: games.length, stars: starsGot, list: games,
    done: get("checks", `${id}:done`, false) };
}
function stopStatus(p, start){
  // Called done by hand beats the arithmetic: a week can be over without every
  // box ticked, and the parent who lived it is the one who knows.
  if (p.done) return "done";
  const today = new Date();
  const moveF = p.moves ? p.ticked / p.moves : 1;
  const gameF = p.games ? p.played / p.games : 1;
  if (p.ticked + p.played === 0) return parseDay(start) > today ? "soon" : "open";
  return moveF >= DONE_AT && gameF >= DONE_AT ? "done" : "going";
}
const STATUS_WORD = { done: "Done!", going: "Working on it", open: "Not started", soon: "Coming up" };
const STATUS_MARK = { done: "✅", going: "🚧", open: "", soon: "🔒" };

/* ── the board ──
 *
 * Candy Land, not a list. The school year is the main path: a serpentine of
 * squares, one per week, coloured by the month it belongs to, with a ribbon
 * where each month starts. Every other track is a LAND off to the side — its
 * own sign, its own colour, its units in a short column — tethered by a
 * dotted branch to the school week it started in, alternating left and right
 * down the board so the shortcuts never pile up on one side. The bee sits on
 * the week we're in. Everything is one SVG in a 1000-wide space that scales
 * to whatever screen it's on. */
const BOARD = { w: 1000, cols: 5, step: 110, row: 130, sq: 72, x0: 255, y0: 110, unit: 60 };
const MONTH_TONES = ["#F26B6B", "#F4A44A", "#FFD43B", "#6DBB6D", "#5C8FD6", "#7A4FA3", "#F5A9C5", "#8FA3B8", "#E0553D", "#3F8F5E"];

function svgEl(name, attrs = {}, text){
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

async function renderMap(){
  const road = $("mapRoad");
  const detail = $("mapDetail");
  detail.hidden = true; detail.innerHTML = "";
  road.innerHTML = "";
  road.appendChild(el("p", "school", "Loading the map…"));
  const tracks = await allTracks();
  if (mode !== "map") return;
  const art = await loadRoadmapArt();
  const stops = tracks.flatMap(t => t.weeks.map(w => ({ ...w, topic: t.topic, world: t.world })));
  const docs = await Promise.all(stops.map(s => weekDocFor(s.topic, s.id)));
  if (mode !== "map") return;
  stops.forEach((s, n) => {
    s.doc = docs[n];
    s.p = s.doc ? stopProgress(s.doc, s.id) : { ticked: 0, moves: 0, played: 0, games: 0, stars: 0, list: [] };
    s.status = s.doc ? stopStatus(s.p, s.start) : "soon";
  });
  road.innerHTML = "";

  const school = tracks.find(t => t.topic.dir === "/weeks") || tracks[0];
  const written = stops.filter(s => s.topic === school.topic);
  // The whole year is the road, written or not: the calendar names every
  // week, so the board is the full path from the first day, with the weeks
  // nobody has written yet drawn faint. No calendar (the demo) — just the
  // weeks that exist.
  const cal = calendarWeeks();
  const main = cal.length
    ? cal.map(c => written.find(s => s.start === c.start)
        || { id: null, start: c.start, label: c.label, theme: c.theme, topic: school.topic, world: school.world,
             status: "unwritten", p: { ticked: 0, moves: 0, played: 0, games: 0, stars: 0, list: [] } })
    : written;
  const lands = tracks.filter(t => t !== school);
  const B = BOARD;

  // main path geometry: serpentine, left-to-right then back
  const pos = main.map((s, i) => {
    const r = Math.floor(i / B.cols), c = i % B.cols;
    const col = r % 2 === 0 ? c : B.cols - 1 - c;
    return { x: B.x0 + col * B.step, y: B.y0 + r * B.row };
  });

  // each land hangs off the school week its first unit started in; sides
  // alternate, and a side keeps a running floor so two lands on it can't
  // overlap when they start the same Monday.
  const floor = { left: B.y0 - 40, right: B.y0 - 40 };
  const landBoxes = lands.map((t, n) => {
    const first = t.weeks[0];
    let at = 0;
    main.forEach((s, i) => { if (first && s.start <= first.start) at = i; });
    const side = n % 2 ? "right" : "left";
    const h = 92 + t.weeks.length * (B.unit + 12);
    const y = Math.max(pos[at] ? pos[at].y - 30 : B.y0, floor[side]);
    floor[side] = y + h + 24;
    const x = side === "left" ? 18 : B.w - 18 - 200;
    return { t, at, side, x, y, w: 200, h };
  });

  const height = Math.max(
    B.y0 + Math.ceil(main.length / B.cols) * B.row + 40, floor.left, floor.right) + 20;
  const svg = svgEl("svg", { class: "board", viewBox: `0 0 ${B.w} ${height}`, role: "img" });
  svg.appendChild(svgEl("title", {}, `${index.child}'s road`));

  // the railway under the main path
  const d = pos.map((p, i) => `${i ? "L" : "M"}${p.x + B.sq / 2} ${p.y + B.sq / 2}`).join(" ");
  svg.appendChild(svgEl("path", { d, class: "rail" }));
  svg.appendChild(svgEl("path", { d, class: "rail ties" }));
  // The honey trail: the stretch of the year already travelled, drawn along
  // the rail up to this week so the journey reads at a glance — how far
  // he's come is the line, how far there is to go is the brown still bare.
  const today = new Date();
  let travelled = -1;
  main.forEach((s, i) => { if (parseDay(s.start) <= today) travelled = i; });
  if (travelled > 0){
    const dg = pos.slice(0, travelled + 1)
      .map((p, i) => `${i ? "L" : "M"}${p.x + B.sq / 2} ${p.y + B.sq / 2}`).join(" ");
    svg.appendChild(svgEl("path", { d: dg, class: "rail gone" }));
  }

  // month ribbons: the first week of each calendar month gets its name
  const months = calendarWeeks();
  const monthOf = s => months.find(w => w.start === s.start)?.month || null;
  const toneOf = s => {
    const m = monthOf(s);
    const n = m ? (curriculum.months.indexOf(m)) : 0;
    return MONTH_TONES[n % MONTH_TONES.length];
  };
  let lastMonth = null;
  main.forEach((s, i) => {
    const m = monthOf(s);
    if (m && m !== lastMonth){
      lastMonth = m;
      const p = pos[i];
      const g = svgEl("g", { class: "ribbon" });
      const lift = s.id && s.id === weekId && s.topic === topic ? 30 : 0;   // make room for the bee
      g.appendChild(svgEl("rect", { x: p.x - 8, y: p.y - 28 - lift, width: B.sq + 16, height: 22, rx: 11, fill: toneOf(s) }));
      g.appendChild(svgEl("text", { x: p.x + B.sq / 2, y: p.y - 13 - lift, "text-anchor": "middle" }, (m.emoji ? m.emoji + " " : "") + m.name));
      svg.appendChild(g);
    }
  });

  // branches to the lands, then the lands
  // A land's branch leaves the path from the square BESIDE it — the end of
  // the row the land sits level with, on its own side — not from the week it
  // started in. A tether back to Aug 10 was a dotted line across the whole
  // board; this is a short one to the nearest edge.
  landBoxes.forEach(L => {
    const rows = Math.ceil(main.length / B.cols);
    const r = Math.max(0, Math.min(rows - 1, Math.round((L.y + 46 - B.y0 - B.sq / 2) / B.row)));
    const col = L.side === "left" ? 0 : Math.min(B.cols, main.length - r * B.cols) - 1;
    const idx = r * B.cols + (r % 2 === 0 ? col : (B.cols - 1 - col));
    const p = pos[Math.min(idx, pos.length - 1)] || pos[0];
    const from = { x: p.x + (L.side === "left" ? 0 : B.sq), y: p.y + B.sq / 2 };
    const to = { x: L.side === "left" ? L.x + L.w : L.x, y: L.y + 46 };
    svg.appendChild(svgEl("path", { class: "branch", d: `M${from.x} ${from.y} C ${(from.x + to.x) / 2} ${from.y}, ${(from.x + to.x) / 2} ${to.y}, ${to.x} ${to.y}`, stroke: L.t.world.tone }));
  });
  landBoxes.forEach(L => {
    const w = L.t.world;
    const unitsDone = L.t.weeks.filter(wk =>
      stops.find(x => x.topic === L.t.topic && x.id === wk.id)?.status === "done").length;
    const complete = L.t.weeks.length > 0 && unitsDone === L.t.weeks.length;
    const g = svgEl("g", { class: "land" + (complete ? " complete" : "") });
    g.appendChild(svgEl("rect", { x: L.x, y: L.y, width: L.w, height: L.h, rx: 22, fill: "#fff", stroke: w.tone, "stroke-width": 5 }));
    // the sign: drawn scene (or a dropped-in picture), track name, world name
    const sign = svgEl("g", { transform: `translate(${L.x + 14} ${L.y + 14})` });
    sign.appendChild(svgEl("clipPath", { id: `clip-${w.id}` })).appendChild(svgEl("rect", { width: 64, height: 64, rx: 14 }));
    const scene = svgEl("g", { "clip-path": `url(#clip-${w.id})` });
    scene.innerHTML = worldArt(w.id);
    if (art.includes(w.id)) scene.appendChild(svgEl("image", { href: `/roadmap/${w.id}.png`, width: 64, height: 64, preserveAspectRatio: "xMidYMid slice" }));
    sign.appendChild(scene);
    g.appendChild(sign);
    // A finished land wears the crown at the sign's top-right, so its name
    // line stops short of that corner instead of being squeezed underneath it.
    g.appendChild(svgEl("text", { x: L.x + 90, y: L.y + 38, class: "land-name", "data-fit": L.w - (complete ? 128 : 102) }, `${L.t.topic.emoji || ""} ${L.t.topic.name}`.trim()));
    g.appendChild(svgEl("text", { x: L.x + 90, y: L.y + 60, class: "land-world", "data-fit": L.w - 102 },
      `${w.name} · ${unitsDone}/${L.t.weeks.length}`));
    // A finished land wears the crown — the whole point of a short path is
    // that its end is reachable.
    if (complete) g.appendChild(svgEl("text", { x: L.x + L.w - 22, y: L.y + 32, class: "crown", "text-anchor": "middle" }, "👑"));
    // the units, one under another, a short path of their own
    L.t.weeks.forEach((wk, i) => {
      const s = stops.find(x => x.topic === L.t.topic && x.id === wk.id);
      const y = L.y + 92 + i * (B.unit + 12);
      if (i) g.appendChild(svgEl("line", { x1: L.x + 44, y1: y - 12, x2: L.x + 44, y2: y, class: "link" }));
      g.appendChild(stopNode(s, L.x + 14, y, B.unit, w.tone, wk.label));
      if (s.id === weekId && s.topic === topic)
        g.appendChild(svgEl("text", { x: L.x + 14 + B.unit - 8, y: y + 12, class: "pawn small", "text-anchor": "middle" }, "🐝"));
      g.appendChild(svgEl("text", { x: L.x + 14 + B.unit + 12, y: y + 24, class: "unit-name", "data-fit": L.w - B.unit - 36 }, truncate(wk.theme || wk.label, 16)));
      g.appendChild(svgEl("text", { x: L.x + 14 + B.unit + 12, y: y + 44, class: "unit-meter", "data-fit": L.w - B.unit - 36 }, meterText(s.p, s.status)));
    });
    svg.appendChild(g);
  });

  // the school squares, on top of the rail
  main.forEach((s, i) => {
    const p = pos[i];
    svg.appendChild(stopNode(s, p.x, p.y, B.sq, toneOf(s), s.label.split("–")[0].replace(/[A-Za-z]+ /, m => m)));
    if (s.id === weekId && s.topic === topic){
      const bee = svgEl("text", { x: p.x + B.sq / 2, y: p.y - 6, class: "pawn", "text-anchor": "middle" }, "🐝");
      svg.appendChild(bee);
    }
  });
  // the finish
  const last = pos[pos.length - 1];
  if (last) svg.appendChild(svgEl("text", { x: last.x + B.sq / 2, y: last.y + B.sq + 34, class: "flag", "text-anchor": "middle" }, "🏁"));

  const doneCount = stops.filter(s => s.status === "done").length;
  const unwritten = main.filter(s => s.status === "unwritten").length;
  const landsDone = lands.filter(t => t.weeks.length && t.weeks.every(wk =>
    stops.find(x => x.topic === t.topic && x.id === wk.id)?.status === "done")).length;
  const honey = stops.reduce((n, s) => n + s.p.stars, 0);
  const bits = stops.reduce((a, s) =>
    ({ done: a.done + s.p.ticked + s.p.played, all: a.all + s.p.moves + s.p.games }), { done: 0, all: 0 });
  const run = streakDays();

  const head = el("div", "map-head");
  head.appendChild(el("h1", null, `${index.child}'s Road`));
  // The scoreboard: the year's honey, the stops, the lands, the streak —
  // every number the board already knows, said once at the top.
  const stats = el("div", "map-stats");
  const stat = (icon, big, label) => {
    const box = el("span", "map-stat");
    box.append(el("b", null, `${icon} ${big}`), el("small", null, label));
    stats.appendChild(box);
  };
  stat("🍯", honey, "honey");
  stat("✅", `${doneCount}/${stops.length}`, "stops done");
  if (lands.length) stat("👑", `${landsDone}/${lands.length}`, "lands finished");
  if (run >= 2) stat("🔥", run, "days in a row");
  head.appendChild(stats);
  // The whole year as one bar: everything ticked over everything tickable.
  const bar = el("div", "map-bar");
  const fill = el("i");
  fill.style.width = (bits.all ? Math.round(bits.done / bits.all * 100) : 0) + "%";
  bar.appendChild(fill);
  bar.title = `${bits.done} of ${bits.all} things done across the whole year`;
  head.appendChild(bar);
  // Where the auto-levels stand, for this week's games that have moved one.
  const lvls = gameList().filter(shownLevel);
  if (lvls.length){
    const lvlRow = el("div", "map-levels");
    lvlRow.appendChild(el("small", null, `${index.child}'s levels`));
    lvls.forEach(g => {
      const n = shownLevel(g);
      const chip = el("span", "lvl-chip");
      chip.append(`${typeof g.emoji === "function" ? g.emoji() : g.emoji} `,
        el("i", null, "●".repeat(n) + "○".repeat(LEVELS - n)));
      chip.title = `${typeof g.name === "function" ? g.name() : g.name} — level ${n} of ${LEVELS}`
        + (g.top < LEVELS ? ` (this week's board stops at ${g.top})` : "");
      lvlRow.appendChild(chip);
    });
    head.appendChild(lvlRow);
  }
  head.appendChild(el("p", "school", "Tap a square to see what's left."
    + (unwritten ? " The faint ones are weeks nobody has written yet." : "")));
  road.append(head, svg);
  // SVG text neither wraps nor clips, so a long land or unit line paints
  // straight over its box border. Squeeze only the lines that overflow the
  // room their `data-fit` names — measured, which is why this runs after the
  // board is in the DOM.
  svg.querySelectorAll("[data-fit]").forEach(t => {
    if (t.getComputedTextLength() > +t.dataset.fit){
      t.setAttribute("textLength", t.dataset.fit);
      t.setAttribute("lengthAdjust", "spacingAndGlyphs");
    }
  });
}

/* One square. Filled with its land's colour when done, outlined when not,
 * greyed when its Monday hasn't come, and filling with honey from the bottom
 * as a started week gets worked through — so "Working on it" also says how
 * far along, without opening the stop. Tap opens the stop. */
let sqClip = 0;
function stopNode(s, x, y, size, tone, label){
  const live = s.status !== "unwritten";
  const g = svgEl("g", live ? { class: `sq ${s.status}`, tabindex: 0, role: "button" } : { class: "sq unwritten" });
  const meter = live && s.status !== "soon" ? ` · ${meterText(s.p, s.status)}` : "";
  g.appendChild(svgEl("title", {}, `${s.label} · ${s.theme || ""} — ${live ? STATUS_WORD[s.status] : "Not written yet"}${meter}`));
  g.appendChild(svgEl("rect", { x, y, width: size, height: size, rx: 16, fill: tone }));
  g.appendChild(svgEl("rect", { x: x + 5, y: y + 5, width: size - 10, height: size - 10, rx: 12, class: "inner" }));
  const total = s.p.moves + s.p.games;
  const frac = total ? (s.p.ticked + s.p.played) / total : 0;
  if (s.status === "going" && frac > 0){
    const cid = `sqfill-${++sqClip}`;
    g.appendChild(svgEl("clipPath", { id: cid }))
      .appendChild(svgEl("rect", { x: x + 5, y: y + 5, width: size - 10, height: size - 10, rx: 12 }));
    const h = Math.max(5, Math.round((size - 10) * Math.min(1, frac)));
    g.appendChild(svgEl("rect", { x: x + 5, y: y + size - 5 - h, width: size - 10, height: h, class: "fill", "clip-path": `url(#${cid})` }));
  }
  g.appendChild(svgEl("text", { x: x + size / 2, y: y + size / 2 + (STATUS_MARK[s.status] ? 2 : 7), "text-anchor": "middle", class: "sq-label" }, label));
  if (STATUS_MARK[s.status]) g.appendChild(svgEl("text", { x: x + size / 2, y: y + size - 8, "text-anchor": "middle", class: "sq-mark" }, STATUS_MARK[s.status]));
  if (!live) return g;
  const open = () => { sfx("tap"); showStop(s, s.doc, s.world, s.p, s.status); };
  g.addEventListener("click", open);
  g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); open(); } });
  return g;
}
function truncate(t, n){ return t.length > n ? t.slice(0, n - 1) + "…" : t; }
function meterText(p, status){
  if (status === "soon") return "Coming up";
  const bits = [];
  if (p.moves) bits.push(`${p.ticked}/${p.moves} to do`);
  if (p.games) bits.push(`${p.played}/${p.games} games`);
  if (p.stars) bits.push(`⭐${p.stars}`);
  return bits.join(" · ") || "Nothing to do here";
}

/* One stop opened: each day's ticks and each game's stars, and the two doors
 * into it. Read aloud for him; the numbers are for the grown-up. */
function showStop(s, doc, world, p, status){
  const d = $("mapDetail");
  d.innerHTML = ""; d.hidden = false;
  d.style.setProperty("--tone", world.tone);
  const h = el("div", "stop-head");
  const sign = el("span", "stop-badge big");
  sign.innerHTML = `<svg viewBox="0 0 64 64">${worldArt(world.id)}</svg>`;
  if ((roadmapArt || []).includes(world.id)){
    const img = document.createElement("img"); img.src = `/roadmap/${world.id}.png`; img.alt = ""; sign.appendChild(img);
  }
  h.append(sign, el("div", null));
  h.lastChild.append(el("h2", null, s.theme || s.label), el("p", "school", `${s.label} · ${world.name} · ${STATUS_WORD[status]}`));
  d.appendChild(h);
  if (!doc){ d.appendChild(el("p", "school", "This week isn't written yet.")); return; }

  const cols = el("div", "stop-cols");
  if (p.moves){
    const c = el("div", "card");
    c.appendChild(el("h3", null, `Learn · ${p.ticked} of ${p.moves}`));
    const ul = el("ul", "stop-list");
    (doc.days || []).forEach(day => {
      const ks = (day.moves || []).map((m, i) => `${s.id}:${day.key}:${i}`);
      const on = ks.filter(k => get("checks", k, false)).length;
      const li = el("li", on === ks.length && ks.length ? "ok" : "");
      li.append(el("span", null, on === ks.length && ks.length ? "🍯" : "·"), ` ${day.title || DAY_SHORT[day.key]} — ${on}/${ks.length}`);
      ul.appendChild(li);
    });
    if ((doc.days || []).length && (doc.visit?.moves || []).length){
      const ks = doc.visit.moves.map((m, i) => `${s.id}:visit:${i}`);
      const on = ks.filter(k => get("checks", k, false)).length;
      const li = el("li", on === ks.length ? "ok" : "");
      li.append(el("span", null, on === ks.length ? "🍯" : "·"), ` In class — ${on}/${ks.length}`);
      ul.appendChild(li);
    }
    const dks = doc.days && doc.days.length ? DAY_KEYS : ["any"];
    (doc.daily || []).forEach((m, i) => {
      const on = dks.filter(dk => get("checks", `${s.id}:${dk}:daily:${m.id || i}`, false)).length;
      const li = el("li", on === dks.length ? "ok" : "");
      li.append(el("span", null, on === dks.length ? "🍯" : "·"),
        ` ${m.title} — ${dks.length > 1 ? `${on}/5 days` : (on ? "done" : "not yet")}`);
      ul.appendChild(li);
    });
    c.appendChild(ul);
    cols.appendChild(c);
  }
  if (p.games){
    const c = el("div", "card");
    c.appendChild(el("h3", null, `Play · ${p.played} of ${p.games} games`));
    const ul = el("ul", "stop-list");
    p.list.forEach(g => {
      const n = weekGameStars(s.id, g);
      const li = el("li", n ? "ok" : "");
      li.append(el("span", null, typeof g.emoji === "function" ? g.emoji() : g.emoji),
        ` ${typeof g.name === "function" ? g.name() : g.name} `, el("em", null, n ? "⭐".repeat(Math.min(5, n)) : "not yet"));
      const lv = shownLevel(g);
      if (lv) li.appendChild(el("span", "lv", ` · Level ${lv}`));
      li.appendChild(histDots(g.id));
      ul.appendChild(li);
    });
    c.appendChild(ul);
    cols.appendChild(c);
  }
  d.appendChild(cols);

  const row = el("div", "tracerow");
  const jump = async (m) => {
    let landed;
    try { landed = await goTo(s.topic.id, s.id); } catch (e) { return fatal(e); }
    if (!landed) return;
    renderTopicPicker(); renderWeekPicker();
    setMode(m);
  };
  const learn = el("button", "btn ghost", "Open in Learn");
  learn.onclick = () => jump("plan");
  const play = el("button", "btn", "Play this week");
  play.onclick = () => jump("play");
  row.append(learn, play);
  d.appendChild(row);
  d.scrollIntoView({ behavior: "smooth", block: "start" });
  say(status === "done" ? `${s.theme || s.label}. All done!` : `${s.theme || s.label}.`);
}

/* ───────────────────────── chrome ───────────────────────── */
function setMode(m){
  playGen++;   // leaving Play must silence whatever a game had queued
  const arriving = mode !== m;
  mode = m;
  $("modePlan").setAttribute("aria-selected", String(m === "plan"));
  $("modePlay").setAttribute("aria-selected", String(m === "play"));
  $("modeMap").setAttribute("aria-selected", String(m === "map"));
  $("planMode").hidden = m !== "plan";
  $("playMode").hidden = m !== "play";
  $("mapMode").hidden = m !== "map";
  localStorage.setItem("hive:mode", m);
  // Every arrival in Play starts locked, including a return from Learn two
  // seconds after a grown-up opened the bar. Both pickers end their change
  // handler with setMode(mode) to repaint, though — that is the same mode, and
  // it must not shut the bar on the parent who is standing there using it.
  if (arriving) lockGate(); else applyGate();
  hush();
  if (m === "play"){
    renderPlayHome(hello());
  } else if (m === "map"){
    musicStop();
    renderMap();
    say("Here is your road. Tap a stop.");
  } else {
    musicStop();
    renderPlan();
  }
  window.scrollTo(0, 0);
}
$("modePlan").onclick = () => setMode("plan");
$("modePlay").onclick = () => setMode("play");
$("modeMap").onclick = () => setMode("map");

/* ── the parent gate ──
 * Play is the one mode he holds by himself, and everything on the right of the
 * top bar is a way out of the game: the tabs land him in Learn, either picker
 * changes the week under him, and the mute leaves a pre-reader with a game he
 * has no way to read. So in Play the bar's right side is off the screen until a
 * grown-up presses and holds the bee for HOLD_MS, which is longer than any tap
 * of his has ever been. Learn and Map are grown-up screens and keep the bar as
 * it always was.
 *
 * OPEN_MS is measured from the last touch of the bar, not from the hold: a
 * parent halfway down a week dropdown when the clock ran out would be a worse
 * bug than a bar that stays open a few seconds longer. */
const HOLD_MS = 1500;
const OPEN_MS = 20000;
let gateOpen = false, holdTimer = null, gateTimer = null;

function applyGate(){
  document.body.classList.toggle("kidlock", mode === "play" && !gateOpen);
  const b = $("brand");
  if (mode === "play"){
    b.setAttribute("role", "button");
    b.setAttribute("tabindex", "0");
    b.setAttribute("aria-expanded", String(gateOpen));
    b.title = "Press and hold to open the grown-up controls";
  } else {
    b.removeAttribute("role");
    b.removeAttribute("tabindex");
    b.removeAttribute("aria-expanded");
    b.removeAttribute("title");
  }
}

function lockGate(){
  clearTimeout(gateTimer); gateTimer = null;
  clearTimeout(holdTimer); holdTimer = null;
  $("brand").classList.remove("holding");
  gateOpen = false;
  applyGate();
}

function keepGate(){
  if (!gateOpen) return;
  clearTimeout(gateTimer);
  gateTimer = setTimeout(lockGate, OPEN_MS);
}

function holdStart(){
  if (mode !== "play" || gateOpen || holdTimer) return;
  $("brand").classList.add("holding");
  holdTimer = setTimeout(() => {
    holdTimer = null;
    $("brand").classList.remove("holding");
    gateOpen = true;
    applyGate();
    sfx("flip");
    keepGate();
  }, HOLD_MS);
}

function holdStop(){
  clearTimeout(holdTimer); holdTimer = null;
  $("brand").classList.remove("holding");
}

$("brand").addEventListener("pointerdown", e => {
  // Capture the pointer for the length of the hold. A thumb never sits still
  // for a second and a half, and uncaptured, a few pixels of drift either left
  // the bee (pointerleave) or turned into a page scroll (pointercancel), and
  // the hold quietly ended under a parent who was doing it right. Captured,
  // the release lands here wherever the finger is by then.
  try { $("brand").setPointerCapture(e.pointerId); } catch { /* an id the browser no longer knows; the hold still counts */ }
  holdStart();
});
["pointerup", "pointercancel"].forEach(e => $("brand").addEventListener(e, holdStop));
// A hold is a hold on a keyboard too: keydown repeats while the key is down.
$("brand").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  holdStart();
});
$("brand").addEventListener("keyup", holdStop);
$("brand").addEventListener("contextmenu", e => { if (mode === "play") e.preventDefault(); });
// Using the bar is what keeps it open; the countdown restarts on every touch.
["pointerdown", "change", "focusin"].forEach(e => $("topbar").addEventListener(e, keepGate));

/* These handlers are live from the moment this script runs, but `mode` is not
 * settled until boot has been to the network and back — and on a cold offline
 * start that is long enough for a tap to land on a bar that should not have
 * been there. Lock it up front on the mode he left in; setMode() settles it
 * either way when boot lands. */
const rememberedMode = localStorage.getItem("hive:mode");
if (rememberedMode === "play") document.body.classList.add("kidlock");

/* 🔊 is the master — off means silence, including the music. 🎵 is only the
 * loop, for the nights the tune is the thing driving everyone mad. */
$("soundBtn").onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem("hive:sound", soundOn ? "on" : "off");
  $("soundBtn").setAttribute("aria-pressed", String(soundOn));
  $("soundBtn").textContent = soundOn ? "🔊" : "🔇";
  musicSync();
  if (!soundOn) hush(); else say("Sound on.");
};

$("musicBtn").onclick = () => {
  musicOn = !musicOn;
  localStorage.setItem("hive:music", musicOn ? "on" : "off");
  $("musicBtn").setAttribute("aria-pressed", String(musicOn));
  musicSync();
};

/* The topic sits ABOVE the week and outlives it: the tracks are the standing
 * list of what we're teaching him, and the week is where inside one of them we
 * are. Picking a topic always lands on that topic's current week — never on
 * whatever week was open in the topic before it, which would be a different
 * unit of a different subject. */
function renderTopicPicker(){
  const sel = $("topicSel");
  const topics = topicList();
  // One topic is not a choice. The public demo ships exactly one.
  $("topicPick").hidden = topics.length < 2;
  sel.innerHTML = "";
  topics.forEach(t => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = `${t.emoji || ""} ${t.name}`.trim();
    o.selected = t.id === topic.id;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    let landed;
    try { landed = await goTo(sel.value); }
    catch (e) { return fatal(e); }
    // A tap that has already been overtaken renders nothing: the tap that
    // overtook it is about to.
    if (!landed) return;
    renderWeekPicker();
    setMode(mode);
  };
}

function renderWeekPicker(){
  const sel = $("weekSel");
  sel.innerHTML = "";
  track.weeks.forEach(w => {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = [w.label, w.theme].filter(Boolean).join(" · ");
    o.selected = w.id === weekId;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    let landed;
    /* Against the topic the picker is SHOWING, not the one last committed.
     * Changing the week while a topic switch is still in flight used to cancel
     * that switch and load a week out of the track being left — so the topic
     * picker said Code, the screen said Body, and both were telling the truth
     * about different things. Handing goTo the visible topic makes the two agree:
     * a week id that doesn't exist in that track falls back to its current week. */
    const showing = $("topicSel").value || topic.id;
    try { landed = await goTo(showing, sel.value); }
    catch (e) { return fatal(e); }
    if (!landed) return;
    renderWeekPicker();
    setMode(mode);
  };
}

/* ───────────────────────── boot ───────────────────────── */
async function boot(){
  // Paint from the local mirror first so a cold cellular start isn't a blank
  // screen, then let the server's copy win.
  try { const m = localStorage.getItem(LS_KEY); if (m) adopt(JSON.parse(m)); } catch {}

  await loadIndex();
  // The topic is remembered — it's a standing choice about what he's working on.
  // The week deliberately is NOT: it always opens on the current one, because
  // the alternative is finding out in November that he's been playing October's
  // letter all month. Changing it is one tap away and lasts for the session.
  // A remembered topic whose folder is gone — renamed, or a deploy that doesn't
  // carry it — must not be a blank app. The first topic is the school's, whose
  // index is the one already in hand, so the fallback can't fail too.
  try { await goTo(localStorage.getItem("hive:topic") || topicList()[0].id); }
  catch { await goTo(topicList()[0].id); }

  renderTopicPicker();
  renderWeekPicker();
  $("soundBtn").setAttribute("aria-pressed", String(soundOn));
  $("soundBtn").textContent = soundOn ? "🔊" : "🔇";
  $("musicBtn").setAttribute("aria-pressed", String(musicOn));
  // Not awaited: neither a missing voice pack nor a missing card deck may hold
  // up the week. Both degrade to something the app already does — the device's
  // own voice, and a Match game with one mode.
  loadVoice();
  // Nor may the year map. It answers "what's next Monday", which is never the
  // reason the app was opened, so it arrives late and paints the two places it
  // feeds rather than holding up the week it's an aside to.
  loadCurriculum().then(() => { if (week && mode === "plan"){ renderHero(); renderTerm(); } });
  // Repaint only if the picker is what's on screen: the deck list arriving is
  // not a reason to throw him out of a game he has already started.
  // The map counts tiles too, so it repaints on the same arrivals.
  const repaintTiles = () => {
    if (mode === "play" && !$("playHome").hidden) renderPlayHome();
    else if (mode === "map") renderMap();
    // Learn's week bar counts games too, so its denominator is stale until
    // these arrive — and the day card's "Sing it" door needs the song named.
    else if (mode === "plan" && week){ renderWeekMeter(); renderDay(); }
  };
  loadPackList().then(repaintTiles);
  // Same deal for the song manifest — it's what makes the Sing Along tile appear.
  loadSongs().then(repaintTiles);
  // Read once, up where the gate seeds itself from it, so the lock applied
  // before boot and the mode chosen after it can never disagree.
  setMode(rememberedMode === "play" || rememberedMode === "map" ? rememberedMode : "plan");

  await pull();
  synced = true;
  if (mode === "play") renderPlayHome(hello()); else if (mode === "map") renderMap(); else renderPlan();
}

/* If boot fails there is nothing on screen but empty cards, which reads as "the
 * app is broken" when the real answer is usually "sign in again". Say so, and
 * offer the one button that fixes a PWA stuck on a bad cache — an installed app
 * has no address bar and no way to hard-reload. */
function fatal(e){
  console.error("[hive] boot failed:", e);
  hush();
  const box = el("section", "card");
  box.appendChild(el("h2", null, e && e.login ? "Please sign in again" : "Couldn't load this week"));
  box.appendChild(el("p", "school", e && e.login
    ? "The login expired, so the week couldn't be fetched. Reloading will take you back to the sign-in screen."
    : String((e && e.message) || e)));
  const reload = el("button", "btn", "Reload");
  reload.onclick = () => location.reload();
  const reset = el("button", "btn ghost", "Reset app cache");
  reset.onclick = async () => {
    try {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
    } catch {}
    location.reload();
  };
  box.append(reload, reset);
  $("planMode").prepend(box);
  $("planMode").hidden = false;
  $("playMode").hidden = true;
}

// Another device may have ticked something off while this tab was in a pocket.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !week) return;
  await pull();
  if (mode === "play") renderPlayHome(); else if (mode === "map") renderMap(); else renderPlan();
});

if ("serviceWorker" in navigator){
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot().catch(fatal);
