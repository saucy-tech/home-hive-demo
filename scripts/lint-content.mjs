#!/usr/bin/env node
/* Check every week doc against what the game engines actually need at level 3.
 *
 *   node scripts/lint-content.mjs
 *
 * Every levelled game deals a fixed number of rounds from the bank it is given,
 * and every deal is a `Math.min` against what the bank actually holds. So a
 * short bank never fails loudly — it quietly makes the TOP level easier than
 * the one below it, which is the failure the levels exist to prevent. This
 * walks every week of every topic and says which bank is under which floor.
 * It reports and never edits; fixing the content is somebody's judgement.
 *
 * The floors, and where each one comes from — line refs into public/app.js:
 *
 *  naming  advanced >= 8   NAME_TIERS[3] (:1481-1485) is `{ from: "advanced",
 *                          choices: 6, rounds: 8 }`, and a short list is topped
 *                          up from `basic` (gameName). Seven advanced items make
 *                          level 3 an eight-round board with an easy word in it.
 *          basic >= 6      Level 1 keeps its wrong answers inside `basic` only
 *                          while `basic.length >= choices` (:1499); six also
 *                          fills a six-choice board off the easy list alone,
 *                          and AUTHORING step 4 asks for six to eight per list.
 *          spoken word     Every item is read out as `it.say || it.label`
 *                          (spokenOf, :1486). A label that isn't plain words
 *                          needs a `say` or the prompt reads wrong out loud.
 *          …and `feelings`  Feelings Faces is this same engine wearing another
 *                          name: feelingsBank() (:1551) hands gameName a config
 *                          whose `basic` is `feelings.core` and whose `advanced`
 *                          is `feelings.big`, so both lists answer to the floors
 *                          above: six core, eight big, as AUTHORING now says.
 *  sort    items >= 14     SORT_TIERS[3] (:2036) deals 10 rounds, and
 *                          freshSample (:38) can only avoid last play's when
 *                          there are unseen items left to reach for.
 *          hard >= 5       The same tier wants five hard ones, capped by what
 *                          exists: `Math.min(tier.hard, hard.length, want)`
 *                          (:2044). Four hard items IS a level-2 board.
 *          note on each    The note is the lesson (AUTHORING step 4). A
 *                          scenario without one is a coin flip he can win.
 *  order   >= 5 sets       ORDER_SETS deals three a board, and freshSample can
 *                          only avoid last play's when unseen sets are left.
 *          three boards    The cap is derived, not tabled: level 3 is the
 *                          longest set the block carries and each level under
 *                          it is one step shorter, and a cap that fits fewer
 *                          than three sets is topped up with the next-shortest
 *                          (gameOrder). Each level deals a prefix of the sets
 *                          sorted by length, so two levels whose prefixes are
 *                          the same length deal the same rounds — all-four-step
 *                          banks, and 3/3/3/5/5, which a bare spread lets by.
 *          icon on each    He can't read the step buttons, and two steps in one
 *          distinct per set  set wearing the same icon are one button to him.
 *  letter  yes >= 10       LETTER_TIERS[3] (:1957) takes 5 yes, 7 no, 4 hard.
 *          no >= 12        Ten and twelve are what make two plays in a row
 *          hard >= 4       different boards rather than the same one reshuffled
 *                          (:1963); `hard` is the level-3 knob and is capped by
 *                          what the bank holds (:1966).
 *          easy no >= 3    the remaining three of the seven no-words are drawn
 *                          only from the ones NOT marked hard (:1967), so an
 *                          all-hard `no` list deals a four-word board.
 *  trace   6 to 8 items    TRACE_TIERS[3] (:3142) deals six (:3230). Fewer and
 *                          level 3 is level 2 with a tighter tolerance; more
 *                          than eight and a glyph goes weeks without coming up.
 *  pattern pool >= 4       Either its own `items` or the naming bank `use`
 *                          names, looked up by id in the SAME doc (:3036).
 *                          Under two the game drops him back to the home screen
 *                          (:3041); under four, level 3 cannot fill its
 *                          four-choice board, because the distractor sample is
 *                          capped at what the pool holds (:3096), and a
 *                          three-kind A-B-C unit has nothing to build from.
 *  songs   8 to 14 lines   The read-along lights the line being sung (:2525)
 *                          across a default sixty-second ask (:329). Under
 *                          eight there is nothing to follow; over fourteen the
 *                          lines go by faster than a four-year-old can track.
 *
 * Two checks that are not floors:
 *
 *  · Week ids must be globally unique. Ticks and stars are stored under
 *    `<week id>:…`, so two topics sharing an id share his honey jar. The id
 *    that matters is the one in the track INDEX, because that is what `goTo`
 *    assigns to `weekId` (:710, :718) and what `K()` keys off (:601) — the doc's
 *    own `id` is never read for storage. A doc whose `id` disagrees with its
 *    index entry — or carries no `id` at all — is flagged too, since the two
 *    being the same is what makes the rule checkable at all. Fails.
 *  · Game ids repeated across docs. A LEVEL is stored under the bare game id,
 *    so the same id carrying different content carries his level with it —
 *    promoted on one week's bank, he opens another week's at level 3. Listed
 *    rather than failed: whether two banks should share an id is a content
 *    decision, and byte-identical reuse is legitimate. The key is the BARE id,
 *    because that is the whole of it: setLevel writes `lvl:<id>` with nothing
 *    in front (:1254), so a naming bank and a sort that happen to share a name
 *    share one level as surely as two naming banks do. Only the authored banks
 *    (naming, sort, order) are compared with each other — `letter`, `trace`,
 *    `pattern`, `more` and `code` are deliberately global ids, which AUTHORING
 *    says outright. But an authored bank may not TAKE one of those five names:
 *    the engines pass them to levelOf as bare literals (:1960, :2802, :2960,
 *    :3042, :3227), so a sort called `trace` and Trace It are one level. That
 *    one is an error rather than a listing — nobody means it.
 */

import { createLibraryResolver, libraryEntries } from "../public/library.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FLOORS = {
  nameAdvanced: 8,
  nameBasic: 6,
  sortItems: 14,
  sortHard: 5,
  sortEasy: 5,
  orderSets: 5,
  letterYes: 10,
  letterNo: 12,
  letterHard: 4,
  letterEasyNo: 3,
  patternPool: 4,
  traceMin: 6,
  traceMax: 8,
  songMin: 8,
  songMax: 14,
};

/* Every week of every topic, walked the way the audio generator walks it: the
 * topic registry lives in weeks/index.json alongside the school's own week
 * list, and each track folder holds its own index. */
function allWeekDocs() {
  const read = p => {
    try { return JSON.parse(readFileSync(p, "utf8")); }
    catch (e) { fail(`${relative(ROOT, p)}: ${e.message}`); }
  };
  const index = read(join(ROOT, "public", "weeks", "index.json"));
  const topics = (index.topics || []).length ? index.topics : [{ id: "school", dir: "/weeks" }];
  const docs = [];

  for (const topic of topics) {
    // dir is an app-facing URL path; strip the leading slash to walk it on disk.
    const dir = join(ROOT, "public", topic.dir.replace(/^\//, ""));
    const trackIndex = topic.dir === "/weeks" ? index : read(join(dir, "index.json"));
    for (const w of trackIndex.weeks || []) {
      const path = join(dir, `${w.id}.json`);
      docs.push({ topic: topic.id, listedId: w.id, path, name: relative(ROOT, path), doc: read(path) });
    }
  }
  return { topics, docs };
}

const plural = n => (n === 1 ? "" : "s");

function fail(message) {
  console.error(`lint-content: ${message}`);
  process.exit(2);
}

/* A label is only safe to read out on its own when it is plain words. Digits,
 * symbols and acronyms all come out of a speech synthesiser as something other
 * than what is on the button, and those are the items that need an explicit
 * `say`. */
const PLAIN_WORDS = /^[A-Za-z][A-Za-z'’-]*(?: [A-Za-z'’-]+)*$/;
const speakable = it => {
  if (typeof it.say === "string" && it.say.trim()) return true;
  const label = typeof it.label === "string" ? it.label : "";
  return PLAIN_WORDS.test(label) && !/\b[A-Z]{2,}\b/.test(label);
};

const breaches = [];
const add = (doc, game, check, found, floor) => breaches.push({ doc: doc.name, game, check, found, floor });

/* Name the offenders rather than counting them — a count sends whoever is
 * fixing it back to the file to work out which ones. */
const idsOf = (list, cap = 4) => {
  const ids = list.map(x => x.id || x.label || x.text || "?");
  return ids.length > cap ? `${ids.slice(0, cap).join(", ")} +${ids.length - cap}` : ids.join(", ");
};

function checkDoc(entry) {
  const { doc } = entry;
  const games = doc.games || {};

  // Feelings Faces is the naming engine reading `feelings`, so its two lists
  // are measured against the naming floors like any other bank's.
  const namingBanks = [...(games.naming || [])];
  if (games.feelings) {
    const F = games.feelings;
    namingBanks.push({ id: "faces", basic: F.core || [], advanced: F.big || [] });
  }

  for (const bank of namingBanks) {
    const basic = bank.basic || [], advanced = bank.advanced || [];
    const label = `naming:${bank.id}`;
    if (advanced.length < FLOORS.nameAdvanced) add(entry, label, "advanced items", advanced.length, `>= ${FLOORS.nameAdvanced}`);
    if (basic.length < FLOORS.nameBasic) add(entry, label, "basic items", basic.length, `>= ${FLOORS.nameBasic}`);
    const mute = [...basic, ...advanced].filter(it => !speakable(it));
    if (mute.length) add(entry, label, "spoken word", idsOf(mute), "say, or a plain label");
  }

  for (const bank of games.sort || []) {
    const items = bank.items || [];
    const label = `sort:${bank.id}`;
    if (items.length < FLOORS.sortItems) add(entry, label, "items", items.length, `>= ${FLOORS.sortItems}`);
    const hard = items.filter(x => x.hard);
    if (hard.length < FLOORS.sortHard) add(entry, label, "hard items", hard.length, `>= ${FLOORS.sortHard}`);
    const easy = items.length - hard.length;
    if (easy < FLOORS.sortEasy) add(entry, label, "easy items", easy, `>= ${FLOORS.sortEasy}`);
    const bare = items.filter(x => !(typeof x.note === "string" && x.note.trim()));
    if (bare.length) add(entry, label, "missing note", idsOf(bare), "every item");
  }

  for (const bank of games.order || []) {
    const sets = bank.sets || [];
    const label = `order:${bank.id}`;
    const lens = sets.map(s => (s.steps || []).length);
    if (lens.length < FLOORS.orderSets) add(entry, label, "sets", lens.length, `>= ${FLOORS.orderSets}`);
    // gameOrder's deal, level by level: sets are sorted by length, the cap is
    // the longest minus (3 - level), and a cap fitting fewer than three sets
    // is topped up to three. Every level therefore deals a prefix, and two
    // prefixes of the same length are the same board.
    const sorted = lens.slice().sort((a, b) => a - b);
    const longest = sorted[sorted.length - 1] || 0;
    const dealt = lvl => {
      const fits = sorted.filter(n => n <= longest - (3 - lvl)).length;
      return fits >= 3 ? fits : Math.min(3, sorted.length);
    };
    const same = [[1, 2], [2, 3]].filter(([a, b]) => dealt(a) === dealt(b)).map(([a, b]) => `L${a}=L${b}`);
    if (same.length) add(entry, label, "levels dealing the same sets", same.join(" "), "three boards");
    const iconless = sets.flatMap(s => (s.steps || []).filter(st => !st.icon).map(st => ({ id: `${s.goal}: ${st.text}` })));
    if (iconless.length) add(entry, label, "missing icon", idsOf(iconless, 2), "every step");
    // Two steps wearing the same icon are one button to a pre-reader.
    const twins = sets.filter(s => new Set((s.steps || []).map(st => st.icon)).size < (s.steps || []).length).map(s => ({ id: s.goal }));
    if (twins.length) add(entry, label, "steps sharing an icon", idsOf(twins, 2), "distinct per set");
  }

  if (games.letter) {
    const L = games.letter;
    const yes = L.yes || [], no = L.no || [];
    const label = `letter:${L.letter || "?"}`;
    if (yes.length < FLOORS.letterYes) add(entry, label, "yes words", yes.length, `>= ${FLOORS.letterYes}`);
    if (no.length < FLOORS.letterNo) add(entry, label, "no words", no.length, `>= ${FLOORS.letterNo}`);
    const hard = no.filter(w => w.hard);
    if (hard.length < FLOORS.letterHard) add(entry, label, "hard no-words", hard.length, `>= ${FLOORS.letterHard}`);
    const easyNo = no.length - hard.length;
    if (easyNo < FLOORS.letterEasyNo) add(entry, label, "easy no-words", easyNo, `>= ${FLOORS.letterEasyNo}`);
  }

  if (games.trace) {
    const items = (games.trace.items || []).map(String).filter(Boolean);
    if (items.length < FLOORS.traceMin || items.length > FLOORS.traceMax) {
      add(entry, "trace", "glyphs", items.length, `${FLOORS.traceMin} to ${FLOORS.traceMax}`);
    }
  }

  if (games.pattern) {
    // Resolved the way gamePattern resolves it: own items win, then the bank
    // `use` names, and the count that matters is whichever one it lands on.
    const own = games.pattern.items || [];
    const bank = own.length ? null : (games.naming || []).find(n => n.id === games.pattern.use);
    if (!own.length && !bank) {
      add(entry, "pattern", "pool", games.pattern.use ? `no bank "${games.pattern.use}"` : "no items, no use",
          "own items, or a naming bank in this doc");
    } else {
      const pool = own.length ? own.length : [...(bank.basic || []), ...(bank.advanced || [])].length;
      if (pool < FLOORS.patternPool) {
        add(entry, "pattern", "pool", own.length ? `${pool} inline` : `"${games.pattern.use}" holds ${pool}`, `>= ${FLOORS.patternPool}`);
      }
    }
  }

  for (const song of doc.songs || []) {
    const lines = (song.lyrics || []).length;
    if (lines < FLOORS.songMin || lines > FLOORS.songMax) {
      add(entry, `song:${song.id}`, "lyric lines", lines, `${FLOORS.songMin} to ${FLOORS.songMax}`);
    }
  }
}

/* ── the two id checks ───────────────────────────────────────────────────── */

function weekIdCollisions(docs) {
  const seen = new Map();
  for (const e of docs) {
    // listedId, not doc.id: goTo picks the id out of the track index and that
    // is what becomes weekId, so it is the one his progress is filed under.
    if (!seen.has(e.listedId)) seen.set(e.listedId, []);
    seen.get(e.listedId).push(e.name);
  }
  return [...seen].filter(([, where]) => where.length > 1);
}

/* The doc's own `id` is never read for storage, but it is what AUTHORING asks
 * to match the filename — and while the two agree, "which id" is not a question
 * anyone has to hold in their head. */
function weekIdMismatches(docs) {
  return docs.filter(e => e.doc.id !== e.listedId)
             .map(e => [e.name, `doc ${e.doc.id ? `"${e.doc.id}"` : "(none)"} vs index "${e.listedId}"`]);
}

const AUTHORED_KINDS = ["naming", "sort", "order"];

/* The engines that exist once per track name their own level, as literals, in
 * the call to levelOf. An authored bank answering to one of these shares that
 * engine's ladder — promoted in Trace It, his sort opens at level 3. `faces`
 * is the sixth and the one that doesn't look like the others: Feelings Faces
 * is the naming engine reading `feelings`, and feelingsBank() hands it a config
 * with that id baked in (:1553), which gameName then passes to levelOf.
 *
 * A bank with NO id is the same fault wearing a different hat. `lvl:undefined`
 * is a key like any other, so two id-less banks share one ladder and one star. */
const RESERVED_IDS = ["letter", "trace", "pattern", "more", "code", "faces", "review"];

function badBankIds(docs) {
  const hits = [];
  for (const e of docs) {
    for (const kind of AUTHORED_KINDS) {
      for (const bank of e.doc.games?.[kind] || []) {
        if (!bank.id) hits.push(["(none)", kind, e.name]);
        else if (RESERVED_IDS.includes(bank.id)) hits.push([bank.id, kind, e.name]);
      }
    }
  }
  return hits;
}

function sharedGameIds(docs) {
  const seen = new Map();
  for (const e of docs) {
    for (const kind of AUTHORED_KINDS) {
      for (const bank of e.doc.games?.[kind] || []) {
        if (!seen.has(bank.id)) seen.set(bank.id, []);
        // JSON.stringify preserves the authored key order, so two banks match
        // here exactly when the bytes of that subtree match.
        seen.get(bank.id).push({ doc: e.name, kind, json: JSON.stringify(bank) });
      }
    }
  }
  const bleed = [], reuse = [];
  for (const [id, uses] of seen) {
    if (uses.length < 2) continue;
    const variants = new Set(uses.map(u => u.json));
    const row = { id, kinds: [...new Set(uses.map(u => u.kind))].join(", "),
                  docs: uses.map(u => u.doc), variants: variants.size };
    (variants.size > 1 ? bleed : reuse).push(row);
  }
  return { bleed, reuse };
}

/* ── output ──────────────────────────────────────────────────────────────── */

function table(headers, rows) {
  if (!rows.length) return;
  const all = [headers, ...rows].map(r => r.map(c => String(c)));
  const width = headers.map((_, i) => Math.max(...all.map(r => (r[i] || "").length)));
  const line = r => "  " + r.map((c, i) => (c || "").padEnd(width[i])).join("  ").trimEnd();
  console.log(line(all[0]));
  console.log("  " + width.map(w => "─".repeat(w)).join("  "));
  for (const r of all.slice(1)) console.log(line(r));
}

const { topics, docs } = allWeekDocs();
const readLibraryJSON = path => JSON.parse(readFileSync(join(ROOT, "public", path), "utf8"));
const resolveLibraryDoc = createLibraryResolver(readLibraryJSON);
const libraryDocs = [];
try {
  const entries = libraryEntries(readLibraryJSON("/library/index.json"));
  const listed = new Set(entries.map(e => `${e.id}.json`));
  for (const file of readdirSync(join(ROOT, "public/library"))) {
    if (file.endsWith(".json") && file !== "index.json" && !listed.has(file)) fail(`Unlisted library bank: ${file}`);
  }
  for (const { id, kind } of entries) {
    const own = { use: `lib:${id}` };
    const doc = await resolveLibraryDoc({ games: { [kind]: AUTHORED_KINDS.includes(kind) ? [own] : own } });
    libraryDocs.push({ name: `public/library/${id}.json`, doc });
  }
  for (const entry of docs) {
    try { entry.doc = await resolveLibraryDoc(entry.doc); }
    catch (error) { fail(`${entry.name}: ${error.message}`); }
  }
} catch (error) { fail(error.message); }
[...docs, ...libraryDocs].forEach(checkDoc);

console.log(`Home Hive content lint — ${docs.length} doc${plural(docs.length)} across ${topics.length} topic${plural(topics.length)}; ${libraryDocs.length} library banks\n`);

console.log("FLOORS — banks under what the engines deal at level 3");
if (breaches.length) {
  // Blank the repeated doc name so the eye groups by doc without a second table.
  let last = null;
  const rows = breaches.map(b => {
    const doc = b.doc === last ? "" : b.doc;
    last = b.doc;
    return [doc, b.game, b.check, b.found, b.floor];
  });
  table(["Doc", "Game", "Check", "Found", "Floor"], rows);
} else {
  console.log("  every bank clears its floor.");
}

const collisions = weekIdCollisions(docs);
const mismatches = weekIdMismatches(docs);
console.log("\nWEEK IDS — must be globally unique; ticks and stars key off them");
if (collisions.length) table(["Id", "Docs"], collisions.map(([id, where]) => [id, where.join("  ")]));
else console.log(`  ${docs.length} id${plural(docs.length)}, no collisions.`);
if (mismatches.length) {
  console.log("\n  Doc id disagrees with the index entry it is loaded by:");
  table(["Doc", "Ids"], mismatches);
}

const { bleed, reuse } = sharedGameIds(docs);
const reserved = badBankIds([...docs, ...libraryDocs]);
console.log("\nSHARED GAME IDS — a level is stored under the bare id");
if (reserved.length) {
  console.log("  An authored bank has no id, or has taken an engine's own level id:");
  table(["Id", "Game", "Doc"], reserved);
  console.log("");
}
if (bleed.length) {
  console.log("  Level bleed — same id, different content:");
  table(["Id", "Game", "Variants", "Docs"], bleed.map(r => [r.id, r.kinds, r.variants, r.docs.join("  ")]));
} else {
  console.log("  No id carries different content in two docs.");
}
if (reuse.length) {
  console.log("\n  Identical reuse — same id, same bytes; sharing a level is the intent:");
  table(["Id", "Game", "Docs"], reuse.map(r => [r.id, r.kinds, r.docs.join("  ")]));
}

const bad = breaches.length + collisions.length + mismatches.length + reserved.length;
console.log(`\n${breaches.length} floor breach${breaches.length === 1 ? "" : "es"}, ` +
            `${collisions.length} week-id collision${plural(collisions.length)}, ` +
            `${mismatches.length} id mismatch${mismatches.length === 1 ? "" : "es"}, ` +
            `${reserved.length} bad bank id${plural(reserved.length)}, ` +
            `${bleed.length} id${plural(bleed.length)} bleeding level.`);
process.exit(bad ? 1 : 0);
