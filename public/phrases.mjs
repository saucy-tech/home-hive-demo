/* Every sentence the app can say for one week, built from the week JSON itself.
 *
 * Two callers, which is why this file sits under public/ rather than beside the
 * generator: scripts/audio/generate.mjs imports it to decide what to record,
 * and public/app.js imports it at run time to decide which of those recordings
 * to pull into the cache before he opens a game. One list, so what was recorded
 * and what is warmed cannot drift from each other.
 *
 * This list and the `say(...)` calls in public/app.js are still two halves of
 * one thing, and nothing enforces that they agree — a reworded prompt silently
 * falls back to the device voice, which sounds like a bug in the recording
 * rather than a stale list. Two habits keep it honest:
 *
 *   1. Reword a prompt, reword it here, re-run the generator.
 *   2. Play the game through once and check `hiveVoMisses` in the console.
 *      Anything the app said that wasn't in the pack is sitting in there.
 *
 * Every block below is guarded, because a week doc only carries the config for
 * the games it wants: a topic track has naming banks and no letter of the week,
 * and asking for `g.letter.yes` on one of those would take the whole generator
 * down rather than skipping a game.
 *
 * Where to split a sentence is the interesting decision. Anything with two
 * variables in it is a combinatorial trap: "That one is 5. Find the number 7."
 * as one recording needs one file per PAIR of numbers — four hundred of them,
 * and eight hundred at the stretch band. Said as two, it needs forty. The app
 * passes those as an array to `say`, which plays the clips back to back.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const range = n => Array.from({ length: n }, (_, i) => i + 1);
const HONEY_TARGET = 40;   // mirrors app.js — the jar line is recorded for every count below it

/* Mirrors the same two helpers in public/app.js — see the note there on why a
 * line that is nothing but a number is recorded as a word. */
const NUM_WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
  "Nineteen", "Twenty", "Twenty-one", "Twenty-two", "Twenty-three", "Twenty-four", "Twenty-five",
  "Twenty-six", "Twenty-seven", "Twenty-eight", "Twenty-nine", "Thirty"];
const numWord = n => (NUM_WORDS[n] || n) + ".";
const beeCount = n => `${n} ${n === 1 ? "bee" : "bees"}`;
/* And the naming engine's: an item may say how it should be SPOKEN, for the
 * words where the label alone reads wrong out loud — "the heart", not "Heart". */
const spokenOf = it => it.say || it.label;

export function phrasesFor(week, index) {
  const out = new Set();
  const add = (...lines) => lines.forEach(l => l && out.add(l));

  const g = week.games || {};

  /* The map says a stop's name when it's opened, and Old Honey leads every
   * round it deals from this week with where it came from. */
  add(`${week.theme || week.label}.`, `${week.theme || week.label}. All done!`,
      `From ${week.theme || week.label}.`);

  /* chrome, and the panels every game ends on. The praise pool has to match
   * `praiseLine` in app.js exactly — it rotates through these, so a line missing
   * here is the one night in four he gets the robot voice. */
  add(
    "Sound on.",
    // The last rung of the hint ladder — every engine that hands out choices
    // says this one on the third wrong tap of a round.
    "It is this one.",
    `Hi ${index.child}! Pick a game.`,
    "Pick a story.",
    // The honey jar, said on the way into Play: how far it is from full, one
    // recording per count, and the line the week's first full jar gets.
    "Your honey jar is full!",
    "1 more star fills your honey jar.",
    ...range(HONEY_TARGET).slice(1).map(n => `${n} more stars fill your honey jar.`),
    "Here is your road. Tap a stop.",
    "The end.",
    "You got all of them! Great job.",
    `Every single one, ${index.child}!`,
    "That was perfect. I am proud of you.",
    "All of them. You worked hard on that.",
    "Nice work!",
    `Nice work, ${index.child}.`,
    "That was good thinking.",
    "You kept going. That is the part that counts.",
    // The sing-along's own pool — `singPraise` in app.js rotates through these.
    `You sang the whole song, ${index.child}!`,
    "I love hearing you sing.",
    "That was beautiful singing.",
    "We can sing it again anytime.",
  );

  /* Levelling up, said after the round it happened on */
  for (let n = 2; n <= 3; n++) add(`Level ${n}!`);

  /* The naming engine — Feelings Faces and every naming bank the week carries.
   * The bare label is here too: Match says it as each card turns over, and
   * What Comes Next says it as the answer. */
  const banks = [];
  if (g.feelings) banks.push({ noun: "faces", basic: g.feelings.core, advanced: g.feelings.big });
  (g.naming || []).forEach(b => banks.push(b));
  banks.forEach(bank => {
    add(`Find the two ${bank.noun || "cards"} that match.`);
    [...(bank.basic || []), ...(bank.advanced || [])].forEach(it => add(
      it.label,
      `Find ${spokenOf(it)}`,
      `Yes! ${spokenOf(it)}.`,
      `That one is ${spokenOf(it)}. Try again.`,
      it.note,
    ));
  });

  /* Number Hive and Count the Hive */
  if (g.numbers) {
    const max = Math.max(g.numbers.classMax, g.numbers.stretchMax);
    const bands = [...new Set([g.numbers.classMax, g.numbers.stretchMax])];
    add("How many bees?", "Count them again.", "Yes!", "Yes.", "Count again.",
        "Find the bunch with that many.");
    range(max).forEach(n => add(
      `Find the number ${n}.`,
      `Yes. That is the number ${n}.`,
      `That one is ${n}.`,
      `${beeCount(n)}.`,
      `Give me ${beeCount(n)}.`,
      `That bunch has ${n}.`,
    ));
    /* A tap's whole read-aloud is the number, and a numeral on its own is not a
     * word — asked for "1" and "2" the voice model gave back a grunt and a
     * t-less "oo". Inside a sentence the digit is read correctly, so only these
     * standalone lines spell it out. */
    add("Which way do you want to count?",
        "All the way up! Great counting.",
        "Backwards is the hard one. You did it.");
    range(max).forEach(n => add(numWord(n)));
    bands.forEach(n => add(
      `Count up to ${n}. Start at one.`,
      `Now count backwards. Start at ${n}.`,
    ));
  }

  /* Which is More? — split so it needs one line per number rather than one per
   * PAIR of numbers, same trap as the hive. */
  if (g.compare) {
    add("Which one is more?", "Which one is less?", "Yes.", "Count them again.");
    range(g.compare.max || 12).forEach(n => add(`${n} is more.`, `${n} is less.`));
  }

  /* Trace It — one prompt per glyph, spoken as `traceSpoken` in app.js does. */
  if (g.trace) {
    add("You traced it!", "Okay. Next one.", "Try that one again.",
        "Go over the whole shape.", "Stay on the line.", "Draw on the lines first.");
    (g.trace.items || []).map(String).forEach(t => add(
      /^[A-Za-z]{2,}$/.test(t) ? `Trace the word ${t}.`
        : /^\d+$/.test(t) ? `Trace the number ${t}.`
        : t === t.toUpperCase() ? `Trace big ${t}.` : `Trace little ${t.toUpperCase()}.`));
  }

  /* Letter Hunt */
  if (g.letter) {
    const L = g.letter;
    const anywhere = L.match === "anywhere";
    add(anywhere ? `Tap everything with the ${L.sound} sound anywhere. Like ${L.example}.`
      : `Tap everything that starts with the ${L.sound} sound. Like ${L.example}.`);
    (L.yes || []).forEach(w => add(anywhere ? `${w.word}. Hear the ${L.sound} sound in ${w.word}.`
      : `${w.word}. ${w.word} starts with ${L.letter}.`));
    (L.no || []).forEach(w => add(anywhere ? `${w.word} does not have the ${L.sound} sound.`
      : `${w.word} starts with ${w.word[0].toUpperCase()}.`));
  }

  /* The sorting engine — Kind or Not Kind and every other two-pile game. The
   * confirmations and the retry are per-sort, so they come out of the data. */
  (g.sort || []).forEach(cfg => {
    add(cfg.yesSay, cfg.noSay, cfg.retry);
    (cfg.items || []).forEach(it => add(it.text, it.note));
  });

  /* Step by Step */
  if ((g.order || []).length) {
    add("That is the right order.",
        "Not that one next. What comes next?",
        "Something else comes first. What comes first?");
    (g.order || []).forEach(cfg => (cfg.sets || []).forEach(set => {
      add(`Put these in order. ${set.goal}.`);
      (set.steps || []).forEach(st => add(st.text));
    }));
  }

  /* Code the Bee. The four directions are said as he taps them, and the four
   * outcomes are per-track so the robot track can say robot. */
  if (g.code) {
    add("Up.", "Down.", "Left.", "Right.");
    const lines = g.code.lines || {};
    add(lines.start || "Tell the bee how to get to the flower.",
        lines.wall  || "The bee bumped the wall. Fix it and try again.",
        lines.stop  || "The bee stopped in the wrong place. Try again.",
        lines.win   || "Your bee found the flower!");
  }

  /* What Comes Next? A pattern built on a naming bank is already covered by that
   * bank above; one with its own items needs its own lines. */
  if (g.pattern) {
    add("What comes next?");
    (g.pattern.items || []).forEach(it => add(
      it.label,
      `Yes! ${spokenOf(it)}.`,
      `That one is ${spokenOf(it)}. Try again.`,
    ));
  }

  /* What Helps? Split three ways — one compliment, one per feeling, one per
   * strategy — because whole it would be every feeling times every strategy.
   * Twice over, since half the rounds ask what would help a FRIEND. */
  if (g.feelings && g.feelings.helps) {
    const feelings = [...g.feelings.core, ...g.feelings.big];
    add("Good idea.", "You know what helps. Great job.");
    feelings.forEach(f => add(
      `You feel ${f.label}. What helps?`,
      `Your friend feels ${f.label}. What helps?`,
      `When you feel ${f.label}`,
      `When your friend feels ${f.label}`,
    ));
    /* Two lines per strategy, because half the rounds ask about a friend and a
     * strategy written in the first person has to change hands: "use my words"
     * is "use their words" when it's somebody else's turn. */
    g.feelings.helps.forEach(h => add(
      `you can ${h.label.toLowerCase()}.`,
      `they can ${(h.friend || h.label).toLowerCase()}.`,
    ));
  }

  /* Day by Day */
  if (g.days) {
    add(
      "What day is it today?",
      "What day was yesterday?",
      "What day is tomorrow?",
      "What day comes after tomorrow?",
      "What day was it before yesterday?",
      "Is it",
    );
    WEEKDAYS.forEach(d => add(
      d,
      `or ${d}?`,
      `Yes. ${d}.`,
      `That one is ${d}. Try again.`,
      `What day comes after ${d}?`,
      `What day comes before ${d}?`,
      `What day comes two days after ${d}?`,
      `If yesterday was ${d}, what day is it today?`,
    ));
    /* The aside after a right answer about a real date. Day titles are written
     * to be read, not spoken — "I feel ___ because" is a run of underscores to
     * anything reading it out — so they go through the same swap the app does. */
    (week.days || []).forEach(d => add(`At school, ${d.title.replace(/_+/g, "blank")}.`));
  }

  return [...out];
}

