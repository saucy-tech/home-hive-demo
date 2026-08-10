/* The Home Hive — client.
 *
 * Two modes on one page: Plan (grown-ups, the week folded into the evening)
 * and Play (the kid — big targets, read aloud, seven games driven by the same
 * week JSON so next week's content swaps without touching this file).
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
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DAY_KEYS = ["mon","tue","wed","thu","fri"];
const DAY_SHORT = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri" };

function parseDay(iso){ return new Date(iso + "T00:00:00"); }
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b){ return a.toDateString() === b.toDateString(); }

/* ───────────────────────── read aloud ───────────────────────── */
/* A four-year-old can't read the prompts, so the games are unplayable solo
 * without this. iOS only allows speech after a user gesture — every game
 * starts from a tap, which satisfies it. */
let soundOn = localStorage.getItem("hive:sound") !== "off";
let voice = null;
function pickVoice(){
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find(v => v.lang === "en-US" && /samantha|karen|allison|ava/i.test(v.name))
       || vs.find(v => v.lang === "en-US")
       || vs.find(v => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window){ pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text, { rate = 0.92 } = {}){
  if (!soundOn || !("speechSynthesis" in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.rate = rate; u.pitch = 1.05;
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch { /* speech is a bonus, never a blocker */ }
}
function hush(){ try { speechSynthesis.cancel(); } catch {} }

/* ───────────────────────── shared state ───────────────────────── */
const BUCKETS = ["checks","stretch","feelings","helps","notes","stars","games"];
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

async function push(){
  if (!syncEnabled){ pending = {}; syncMsg("Saved on this device"); return; }
  if (!Object.keys(pending).length) return;
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
    // Put the delta back so nothing typed is lost, and try again on the next change.
    for (const [b, m] of Object.entries(delta)) Object.assign(pending[b] || (pending[b] = {}), m);
    offline(e);
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
let index = null;      // weeks/index.json
let week = null;       // the loaded week doc
let weekId = null;
let dayKey = "mon";
let mode = "plan";

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

async function loadWeek(id){
  week = await getJSON(`/weeks/${id}.json`);
  weekId = id;
  localStorage.setItem("hive:week", id);
}

function currentWeekId(){
  const today = new Date();
  for (const w of index.weeks){
    const s = parseDay(w.start);
    if (today >= s && today < addDays(s, 7)) return w.id;
  }
  const past = index.weeks.filter(w => parseDay(w.start) <= today);
  return (past[0] || index.weeks[0]).id;
}

function todayDayKey(){
  const start = parseDay(week.start);
  for (let i = 0; i < 5; i++) if (sameDay(addDays(start, i), new Date())) return DAY_KEYS[i];
  return "mon";
}

/* ───────────────────────── plan mode ───────────────────────── */
function renderHero(){
  $("heroEyebrow").textContent = `${index.class} · ${week.label} · ${week.monthlyFocus}`;
  $("heroTheme").textContent = week.themeSub ? `${week.theme} — ${week.themeSub}` : week.theme;
  $("heroIntro").textContent = week.intro || "";
  const list = $("geldsList");
  list.innerHTML = "";
  (week.gelds || []).forEach(g => {
    const li = el("li");
    li.append(el("b", null, g.code), " " + g.text);
    list.appendChild(li);
  });
}

function moveCount(dk){
  const day = week.days.find(d => d.key === dk);
  if (!day) return { done: 0, total: 0 };
  let done = 0;
  day.moves.forEach((_, i) => {
    if (get("checks", K(dk, i), false)) done++;
    if (get("stretch", K(dk, i), false)) done++;
  });
  return { done, total: day.moves.length * 2 };
}

function renderComb(){
  const comb = $("comb");
  comb.innerHTML = "";
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
}

function renderDay(){
  const d = week.days.find(x => x.key === dayKey) || week.days[0];
  $("dayTitle").textContent = `${DAY_SHORT[d.key]} — ${d.title}`;
  $("daySchool").innerHTML = d.school;

  const box = $("moves");
  box.innerHTML = "";

  d.moves.forEach((m, i) => {
    const baseOn = get("checks", K(d.key, i), false);
    const upOn = get("stretch", K(d.key, i), false);

    const wrap = el("div", "move" + (baseOn ? " done" : ""));

    // base activity — the version his class is doing
    const top = el("div", "move-top");
    const tick = el("button", "tick", baseOn ? "🍯" : "");
    tick.setAttribute("aria-pressed", String(baseOn));
    tick.setAttribute("aria-label", `Mark ${m.title} done`);
    tick.onclick = () => { set("checks", K(d.key, i), !baseOn); renderPlan(); };
    const body = el("div", "body");
    body.appendChild(el("span", "when " + m.slot, m.when));
    body.appendChild(el("h3", null, m.title));
    body.appendChild(el("p", null, m.do));
    top.append(tick, body);
    wrap.appendChild(top);

    // stretch — his level
    const lv = el("div", "level" + (upOn ? " done" : ""));
    const lt = el("button", "tick", upOn ? "⭐" : "");
    lt.setAttribute("aria-pressed", String(upOn));
    lt.setAttribute("aria-label", `Mark the harder version of ${m.title} done`);
    lt.onclick = () => { set("stretch", K(d.key, i), !upOn); renderPlan(); };
    const lb = el("div", "level-b");
    // The child's name rather than a pronoun: the demo ships a different kid
    // and nobody stated their pronouns, and "Sam's level" reads warmer anyway.
    lb.appendChild(el("p", "level-h", `${index.child}'s level`));
    lb.appendChild(el("p", null, m.stretch));
    if (m.skill) lb.appendChild(el("span", "skill", m.skill));
    lv.append(lt, lb);
    wrap.appendChild(lv);

    box.appendChild(wrap);
  });
}

function renderBooks(){
  const box = $("books");
  box.innerHTML = "";
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

function renderGoals(){
  const fill = (node, arr) => { node.innerHTML = ""; (arr || []).forEach(g => node.appendChild(el("li", null, g))); };
  $("goalsHisHead").textContent = index.child;
  fill($("goalsClass"), week.goals && week.goals.class);
  fill($("goalsHis"), week.goals && week.goals.his);
  $("weekend").innerHTML = "<b>Weekend bonus:</b> " + (week.weekend || "");
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
  renderDay();
  renderBooks();
  renderGoals();
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

function stars(gameId){ return get("stars", K(gameId), 0); }
function award(gameId, n){
  if (n > stars(gameId)) set("stars", K(gameId), n);   // keep his best, never demote
}
function totalStars(){
  return (week.games ? GAMES : []).reduce((sum, g) => sum + stars(g.id), 0);
}

function renderPlayHome(){
  $("playHome").hidden = false;
  $("playGame").hidden = true;
  $("gameStage").innerHTML = "";
  hush();

  $("playHi").textContent = `Hi ${index.child}!`;
  const total = totalStars();
  $("jarCount").textContent = total;
  $("jarFill").style.height = Math.min(100, total / HONEY_TARGET * 100) + "%";

  const tiles = $("tiles");
  tiles.innerHTML = "";
  GAMES.forEach(g => {
    const t = el("button", "tile");
    t.append(
      el("div", "tile-emoji", typeof g.emoji === "function" ? g.emoji() : g.emoji),
      el("div", "tile-name", typeof g.name === "function" ? g.name() : g.name),
      el("div", "tile-sub", g.sub),
      el("div", "tile-stars", "⭐".repeat(Math.min(5, stars(g.id))))
    );
    t.onclick = () => openGame(g);
    tiles.appendChild(t);
  });
}

function openGame(g){
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
function setPrompt(node, text, spoken){
  node.innerHTML = "";
  node.append(text);
  const b = el("button", "say", "🔊");
  b.setAttribute("aria-label", "Say it again");
  b.onclick = () => say(spoken || text);
  node.appendChild(b);
  say(spoken || text);
}
function scoreDots(bar, got, total){
  bar.textContent = "⭐".repeat(got) + "·".repeat(Math.max(0, total - got));
}
function donePanel(host, gameId, got, total, again){
  hush();
  host.innerHTML = "";
  const d = el("div", "stage done-panel");
  const perfect = got === total;
  d.append(
    el("div", "big", perfect ? "🏆" : "🍯"),
    el("h2", null, perfect ? "All of them!" : "Nice work!"),
    el("p", null, `${got} out of ${total}.`)
  );
  const a = el("button", "btn", "Play again");
  a.onclick = again;
  const b = el("button", "btn ghost", "Pick another game");
  b.onclick = renderPlayHome;
  d.append(a, b);
  host.appendChild(d);
  award(gameId, got);
  say(perfect ? "You got all of them! Great job." : "Nice work!");
}

/* ── game 1: Feelings Faces ── */
function gameFaces(host){
  const pool = [...week.games.feelings.core, ...week.games.feelings.big];
  const rounds = sample(pool, Math.min(8, pool.length));
  let i = 0, got = 0;
  const { bar, prompt, opts, fb } = stageShell(host, "Feelings Faces");

  function round(){
    if (i >= rounds.length) return donePanel(host, "faces", got, rounds.length, () => { host.innerHTML = ""; gameFaces(host); });
    scoreDots(bar, got, rounds.length);
    fb.textContent = "";
    const target = rounds[i];
    const choices = shuffle([target, ...sample(pool.filter(f => f.id !== target.id), 3)]);
    setPrompt(prompt, `Find… ${target.label}`, `Find ${target.label}`);
    opts.innerHTML = "";
    choices.forEach(c => {
      const b = el("button", "opt");
      b.append(el("em", null, c.icon), c.label);
      b.onclick = () => {
        if (c.id === target.id){
          b.classList.add("right"); got++;
          fb.textContent = `Yes — that's ${target.label}!`; fb.className = "fb good";
          say(`Yes! ${target.label}.`);
          i++; setTimeout(round, 1100);
        } else {
          b.classList.add("wrong");
          fb.textContent = `That one is ${c.label}. Try again.`; fb.className = "fb soft";
          say(`That one is ${c.label}. Try again.`);
          setTimeout(() => b.classList.remove("wrong"), 400);
        }
      };
      opts.appendChild(b);
    });
  }
  round();
}

/* ── game 2: Number Hive ── */
function gameNumbers(host){
  const cfg = week.games.numbers;
  let max = Number(localStorage.getItem("hive:nummax")) || cfg.classMax;
  if (max !== cfg.classMax && max !== cfg.stretchMax) max = cfg.classMax;

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Number Hive"));
  const pick = el("div", "levelpick");
  [["Class", cfg.classMax], [`${index.child}'s level`, cfg.stretchMax]].forEach(([label, n]) => {
    const b = el("button", null, `${label} · to ${n}`);
    b.setAttribute("aria-pressed", String(max === n));
    b.onclick = () => { max = n; localStorage.setItem("hive:nummax", String(n)); host.innerHTML = ""; gameNumbers(host); };
    pick.appendChild(b);
  });
  const bar = el("div", "scorebar");
  const prompt = el("div", "prompt");
  const board = el("div");
  const fb = el("div", "fb");
  s.append(pick, bar, prompt, board, fb);
  host.appendChild(s);

  let stage = 0;   // 0 = count up, 1 = count back, 2 = how many
  let got = 0;
  const TOTAL = 3;

  function hexes(onTap){
    const hive = el("div", "hive");
    for (let n = 1; n <= max; n++){
      const b = el("button", "num");
      b.setAttribute("aria-label", "Number " + n);
      b.innerHTML = `<i></i><b>${n}</b>`;
      b.onclick = () => onTap(n, b, hive);
      hive.appendChild(b);
    }
    return hive;
  }

  function countUp(){
    scoreDots(bar, got, TOTAL);
    setPrompt(prompt, `Tap the numbers from 1 to ${max}`, `Count up to ${max}. Start at one.`);
    let next = 1;
    board.innerHTML = "";
    board.appendChild(hexes((n, b, hive) => {
      if (n === next){
        b.classList.add("lit"); say(String(n)); next++;
        if (next > max){ got++; fb.textContent = "All the way up! 🎉"; fb.className = "fb good"; stage = 1; setTimeout(countBack, 1200); }
      } else {
        b.classList.add("miss");
        setTimeout(() => b.classList.remove("miss"), 400);
        fb.textContent = `Find ${next}.`; fb.className = "fb soft";
        say(`Find ${next}`);
      }
    }));
    fb.textContent = "";
  }

  function countBack(){
    scoreDots(bar, got, TOTAL);
    setPrompt(prompt, `Now backwards — ${max} down to 1`, `Now count backwards. Start at ${max}.`);
    let next = max;
    board.innerHTML = "";
    board.appendChild(hexes((n, b) => {
      if (n === next){
        b.classList.add("lit"); say(String(n)); next--;
        if (next < 1){ got++; fb.textContent = "Backwards is the hard one. 🐝"; fb.className = "fb good"; stage = 2; setTimeout(howMany, 1200); }
      } else {
        b.classList.add("miss");
        setTimeout(() => b.classList.remove("miss"), 400);
        fb.textContent = `Find ${next}.`; fb.className = "fb soft";
        say(`Find ${next}`);
      }
    }));
    fb.textContent = "";
  }

  function howMany(){
    let q = 0, right = 0;
    const QS = 5;
    function ask(){
      if (q >= QS){
        if (right >= 3) got++;
        return donePanel(host, "numbers", got, TOTAL, () => { host.innerHTML = ""; gameNumbers(host); });
      }
      scoreDots(bar, got, TOTAL);
      // Counting a set is a different skill from reciting the sequence, and it
      // falls apart well before 20. Cap the pile at something he can actually
      // count one-to-one, even when the recite band is set to 20.
      const cap = Math.min(max, 12);
      const n = 1 + Math.floor(Math.random() * cap);
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
          if (v === n){
            b.classList.add("right"); right++; q++;
            fb.textContent = `${n} bees!`; fb.className = "fb good";
            say(`${n} bees. Yes!`);
            setTimeout(ask, 1100);
          } else {
            b.classList.add("wrong");
            fb.textContent = "Count them again."; fb.className = "fb soft";
            say("Count them again.");
            setTimeout(() => b.classList.remove("wrong"), 400);
          }
        };
        opts.appendChild(b);
      });
      board.append(bees, opts);
      fb.textContent = "";
    }
    ask();
  }

  countUp();
}

/* ── game 3: Letter Hunt ── */
function gameLetter(host){
  const L = week.games.letter;
  const yes = L.yes, no = sample(L.no, Math.max(0, 9 - yes.length));
  const items = shuffle([...yes.map(x => ({ ...x, hit: true })), ...no.map(x => ({ ...x, hit: false }))]);
  let found = 0;
  const { bar, prompt, opts, fb } = stageShell(host, `Letter ${L.letter} Hunt`);

  setPrompt(prompt, `Tap everything that starts with ${L.letter}`,
    `Tap everything that starts with the ${L.sound} sound. Like ${L.example}.`);
  scoreDots(bar, 0, yes.length);

  items.forEach(it => {
    const b = el("button", "opt");
    b.append(el("em", null, it.emoji), it.word);
    b.onclick = () => {
      if (it.hit){
        b.classList.add("right", "dim"); found++;
        scoreDots(bar, found, yes.length);
        fb.textContent = `${it.word} — yes!`; fb.className = "fb good";
        say(`${it.word}. ${it.word} starts with ${L.letter}.`);
        if (found === yes.length) setTimeout(() => donePanel(host, "letter", found, yes.length, () => { host.innerHTML = ""; gameLetter(host); }), 1300);
      } else {
        b.classList.add("wrong");
        fb.textContent = `${it.word} starts with ${it.word[0].toUpperCase()}.`; fb.className = "fb soft";
        say(`${it.word} starts with ${it.word[0].toUpperCase()}.`);
        setTimeout(() => b.classList.remove("wrong"), 400);
      }
    };
    opts.appendChild(b);
  });
}

/* ── game 4: Kind or Not Kind ── */
function gameKind(host){
  const rounds = sample(week.games.kindness, Math.min(8, week.games.kindness.length));
  let i = 0, got = 0;

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Kind or Not Kind?"));
  const bar = el("div", "scorebar");
  const scene = el("div", "scene");
  const two = el("div", "big2");
  const fb = el("div", "fb");
  s.append(bar, scene, two, fb);
  host.appendChild(s);

  const mk = (label, emoji, val) => {
    const b = el("button");
    b.append(el("em", null, emoji), label);
    b.onclick = () => answer(val, b);
    return b;
  };
  two.append(mk("Kind", "💛", true), mk("Not kind", "🚫", false));

  function answer(val, b){
    const r = rounds[i];
    if (val === r.kind){
      got++;
      fb.textContent = r.kind ? "That's kind. 💛" : "Right — that's not kind.";
      fb.className = "fb good";
      say(r.kind ? "That's kind." : "Right. That's not kind.");
      i++; setTimeout(round, 1300);
    } else {
      b.classList.add("wrong");
      fb.textContent = "Hmm — think about how the other kid feels."; fb.className = "fb soft";
      say("Hmm. Think about how the other kid feels.");
      setTimeout(() => b.classList.remove("wrong"), 400);
    }
  }

  function round(){
    if (i >= rounds.length) return donePanel(host, "kind", got, rounds.length, () => { host.innerHTML = ""; gameKind(host); });
    scoreDots(bar, got, rounds.length);
    fb.textContent = "";
    scene.textContent = rounds[i].text;
    say(rounds[i].text);
  }
  round();
}

/* ── game 5: Feelings Match ── */
function gameMatch(host){
  const set6 = sample(week.games.feelings.core, 6);
  const deck = shuffle([...set6, ...set6].map((f, n) => ({ ...f, n })));
  let open = [], locked = false, pairs = 0;

  const s = el("div", "stage");
  s.appendChild(el("h2", null, "Feelings Match"));
  const bar = el("div", "scorebar");
  const grid = el("div", "grid-match");
  const fb = el("div", "fb");
  s.append(bar, grid, fb);
  host.appendChild(s);
  scoreDots(bar, 0, 6);
  say("Find the two faces that match.");

  deck.forEach(card => {
    const c = el("div", "mcard");
    c.setAttribute("role", "button");
    c.setAttribute("tabindex", "0");
    c.appendChild(el("span", "face", card.icon));
    const flip = () => {
      if (locked || c.classList.contains("up") || c.classList.contains("got")) return;
      c.classList.add("up");
      say(card.label);
      open.push({ c, card });
      if (open.length === 2){
        locked = true;
        const [a, b] = open;
        if (a.card.id === b.card.id){
          setTimeout(() => {
            a.c.classList.add("got"); b.c.classList.add("got");
            pairs++; scoreDots(bar, pairs, 6);
            fb.textContent = `Two ${a.card.label} faces!`; fb.className = "fb good";
            open = []; locked = false;
            if (pairs === 6) setTimeout(() => donePanel(host, "match", 6, 6, () => { host.innerHTML = ""; gameMatch(host); }), 900);
          }, 450);
        } else {
          setTimeout(() => {
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
  const rounds = sample(hard, Math.min(4, hard.length));
  let i = 0;
  const { bar, prompt, opts, fb } = stageShell(host, "What Helps?");
  bar.remove();

  function round(){
    if (i >= rounds.length){
      hush();
      host.innerHTML = "";
      const d = el("div", "stage done-panel");
      d.append(el("div", "big", "🌬️"), el("h2", null, "You know what helps."),
        el("p", null, "Big feelings get smaller when you do something about them."));
      const a = el("button", "btn", "Again");
      a.onclick = () => { host.innerHTML = ""; gameHelps(host); };
      const b = el("button", "btn ghost", "Pick another game");
      b.onclick = renderPlayHome;
      d.append(a, b);
      host.appendChild(d);
      award("helps", 4);
      say("You know what helps. Great job.");
      return;
    }
    const f = rounds[i];
    fb.textContent = "";
    setPrompt(prompt, `${f.icon}  You feel ${f.label}. What helps?`, `You feel ${f.label}. What helps?`);
    opts.innerHTML = "";
    sample(helps, 4).forEach(h => {
      const b = el("button", "opt");
      b.append(el("em", null, h.icon), h.label);
      b.onclick = () => {
        b.classList.add("right");
        set("helps", K(f.id), h.id);           // parents can see what he picks
        fb.textContent = "Good idea. 💛"; fb.className = "fb good";
        say(`Good idea. When you feel ${f.label}, you can ${h.label.toLowerCase()}.`);
        i++; setTimeout(round, 2200);
      };
      opts.appendChild(b);
    });
  }
  round();
}

/* ── game 7: Story Time ── */
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

const GAMES = [
  { id: "faces",   emoji: "😀", name: "Feelings Faces", sub: "Find the feeling",     run: gameFaces },
  { id: "numbers", emoji: "🔢", name: "Number Hive",    sub: "Count up, count back", run: gameNumbers },
  { id: "letter",  emoji: "🔤", name: () => `Letter ${week.games.letter.letter} Hunt`, sub: "Find the sound", run: gameLetter },
  { id: "kind",    emoji: "💛", name: "Kind or Not?",   sub: "You be the judge",     run: gameKind },
  { id: "match",   emoji: "🃏", name: "Feelings Match", sub: "Find the pairs",       run: gameMatch },
  { id: "helps",   emoji: "🌬️", name: "What Helps?",    sub: "When it feels big",    run: gameHelps },
  { id: "story",   emoji: "📖", name: "Story Time",     sub: "This week's books",    run: gameStory },
];

/* ───────────────────────── YouTube ─────────────────────────
 * Deliberately the IFrame API and not a bare <iframe>. A plain embed drops
 * him onto a wall of tappable suggestions the second the story ends; with the
 * API we catch ENDED and cover the player before that grid ever renders. */
let ytReady = false, ytQueued = null, player = null, currentAsk = "";

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

function openVideo(v, title, ask){
  hush();
  currentAsk = ask || "";
  $("veil").hidden = false;
  $("veilTitle").textContent = `${title} — ${v.label}`;
  $("veilDone").hidden = true;
  $("veilDone").innerHTML = "";
  const wrap = document.querySelector(".player-wrap");
  wrap.hidden = false;
  wrap.innerHTML = '<div id="player"></div>';

  if (!ytReady){ ytQueued = { v, title, ask }; loadYT(); return; }

  player = new YT.Player("player", {
    host: "https://www.youtube-nocookie.com",
    videoId: v.id,
    playerVars: { rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3 },
    events: {
      onStateChange: e => { if (e.data === YT.PlayerState.ENDED) videoEnded(); },
      onError: () => videoBlocked(v),
    },
  });
}

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
  const again = el("button", "btn", "Watch it again");
  again.onclick = () => {
    try { player.seekTo(0); player.playVideo(); } catch {}
    $("veilDone").hidden = true;
    document.querySelector(".player-wrap").hidden = false;
  };
  const close = el("button", "btn ghost", "Done");
  close.onclick = closeVideo;
  renderDone([
    el("p", "veil-done-h", "That's the book. 📖"),
    el("p", null, currentAsk),
    again, close,
  ]);
  say("The end.");
}

/* Some uploaders disable off-site embedding. Say so plainly and hand over a
 * link rather than leaving a black rectangle. */
function videoBlocked(v){
  document.querySelector(".player-wrap").hidden = true;
  const a = el("a", "btn", "Open on YouTube");
  a.href = `https://www.youtube.com/watch?v=${v.id}`;
  a.target = "_blank"; a.rel = "noopener";
  a.style.textDecoration = "none";
  a.style.display = "inline-block";
  const c = el("button", "btn ghost", "Close");
  c.onclick = closeVideo;
  renderDone([
    el("p", "veil-done-h", "This one won't play here."),
    el("p", null, "The channel blocked playing it outside YouTube."),
    a, c,
  ]);
}

function closeVideo(){
  try { if (player && player.destroy) player.destroy(); } catch {}
  player = null;
  ytQueued = null;
  $("veil").hidden = true;
  const wrap = document.querySelector(".player-wrap");
  wrap.hidden = false;
  wrap.innerHTML = '<div id="player"></div>';
  $("veilDone").hidden = true;
  hush();
}
$("veilX").onclick = closeVideo;

/* ───────────────────────── chrome ───────────────────────── */
function setMode(m){
  mode = m;
  $("modePlan").setAttribute("aria-selected", String(m === "plan"));
  $("modePlay").setAttribute("aria-selected", String(m === "play"));
  $("planMode").hidden = m !== "plan";
  $("playMode").hidden = m !== "play";
  localStorage.setItem("hive:mode", m);
  hush();
  if (m === "play") renderPlayHome(); else renderPlan();
  window.scrollTo(0, 0);
}
$("modePlan").onclick = () => setMode("plan");
$("modePlay").onclick = () => setMode("play");

$("soundBtn").onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem("hive:sound", soundOn ? "on" : "off");
  $("soundBtn").setAttribute("aria-pressed", String(soundOn));
  $("soundBtn").textContent = soundOn ? "🔊" : "🔇";
  if (!soundOn) hush(); else say("Sound on.");
};

function renderWeekPicker(){
  const sel = $("weekSel");
  sel.innerHTML = "";
  index.weeks.forEach(w => {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = `${w.label} · ${w.theme}`;
    o.selected = w.id === weekId;
    sel.appendChild(o);
  });
  sel.onchange = async () => {
    await loadWeek(sel.value);
    dayKey = todayDayKey();
    setMode(mode);
  };
}

/* ───────────────────────── boot ───────────────────────── */
async function boot(){
  // Paint from the local mirror first so a cold cellular start isn't a blank
  // screen, then let the server's copy win.
  try { const m = localStorage.getItem(LS_KEY); if (m) adopt(JSON.parse(m)); } catch {}

  await loadIndex();
  const wanted = localStorage.getItem("hive:week");
  const id = index.weeks.some(w => w.id === wanted) ? wanted : currentWeekId();
  await loadWeek(id);
  dayKey = todayDayKey();

  renderWeekPicker();
  $("soundBtn").setAttribute("aria-pressed", String(soundOn));
  $("soundBtn").textContent = soundOn ? "🔊" : "🔇";
  setMode(localStorage.getItem("hive:mode") === "play" ? "play" : "plan");

  await pull();
  if (mode === "play") renderPlayHome(); else renderPlan();
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
  if (mode === "play") renderPlayHome(); else renderPlan();
});

if ("serviceWorker" in navigator){
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot().catch(fatal);
