/* What the narration generator records, beyond the week's own sentences.
 *
 * The week lines themselves live in public/phrases.mjs, because the app needs
 * the same list at run time to warm a week's clips into the cache. Re-exported
 * here so the generator keeps one import.
 */
export { phrasesFor } from "../../public/phrases.mjs";

/* The Match card decks under public/packs. Not week content — a deck outlives
 * the week it was added in — so it gets its own pass: the line the board opens
 * on, and the name of each card, which is said as it turns over. */
export function packPhrases(pack) {
  const out = new Set([`Find the two ${pack.noun} that match.`]);
  (pack.cards || []).forEach(c => out.add(c.label));
  return [...out];
}

/* Week-agnostic: the same six noises every week, so they're generated once and
 * only regenerated with --force. Short and soft on purpose — the voice is what
 * carries the game, and a buzzer on a wrong answer is the last thing a
 * four-year-old having a hard time needs to hear. */
export const SFX = [
  { name: "right", seconds: 1.0, prompt: "Short bright friendly xylophone ding, two ascending notes, warm and clean, children's game correct answer, no reverb tail" },
  { name: "wrong", seconds: 0.8, prompt: "Soft low wooden bloop, gentle and neutral, not harsh, not a buzzer, children's game gentle try again, very short" },
  { name: "star",  seconds: 1.2, prompt: "Light quick magic sparkle chime, twinkling bells, short and cheerful, children's game reward" },
  { name: "win",   seconds: 2.5, prompt: "Short cheerful celebration fanfare with marimba and soft bells, warm and playful, children's game level complete" },
  { name: "flip",  seconds: 0.6, prompt: "Soft quick paper card flip, light and clean, very short, no music" },
  { name: "tap",   seconds: 0.6, prompt: "Soft round honey bubble pop, warm and gentle, very short interface tap, no music" },
];

/* One loop, under the game picker only. Asked to begin and end on the same
 * chord because the music API makes a piece, not a loop, and the seam is
 * audible if it ends anywhere else. */
export const MUSIC = [
  {
    name: "hive",
    ms: 45000,
    prompt: "Gentle playful instrumental for a preschool app. Soft marimba and ukulele with a light shaker, warm and unhurried, simple major-key melody, quiet and non-distracting background music. No vocals, no drum build, no big finish — begin and end on the same soft sustained chord so it can loop seamlessly.",
  },
];
