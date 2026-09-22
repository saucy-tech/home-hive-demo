#!/usr/bin/env node
/* Build the audio pack: narration in a parent's voice, the game noises, and the
 * loop under the picker. Writes into public/audio/, which IS committed — the
 * app has no build step and Cloudflare serves those files straight out.
 *
 *   node scripts/audio/generate.mjs --dry-run     what it would cost, no calls
 *   node scripts/audio/generate.mjs               make whatever is missing
 *   node scripts/audio/generate.mjs --force       remake everything
 *   node scripts/audio/generate.mjs --only=sfx    vo | sfx | music | songs
 *   node scripts/audio/generate.mjs --polish      re-trim what's on disk, no calls
 *
 * Incremental by default. A voice clip is named after a hash of its sentence,
 * so an unchanged line is already on disk and costs nothing; adding a week
 * regenerates only that week's new lines. --force is for when the voice or the
 * settings change and every file has to be redone.
 *
 * Needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID, from the environment or
 * from scripts/audio/.env (gitignored).
 *
 * That file is NOT at the repo root, and the location is the point: wrangler
 * reads root .env/.env.local into the Worker's own environment, so a key left
 * there shows up as a Worker variable in `wrangler dev` and is a candidate for
 * being pushed on deploy. This key belongs to a build step that runs on a
 * laptop; the Worker has no business seeing it.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLibraryResolver } from "../../public/library.mjs";
import { phrasesFor, packPhrases, SFX, MUSIC } from "./phrases.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUDIO = join(ROOT, "public", "audio");
const VO_DIR = join(AUDIO, "vo");
const MANIFEST = join(VO_DIR, "index.json");

const args = process.argv.slice(2);
const has = f => args.includes(f);
const only = (args.find(a => a.startsWith("--only=")) || "").split("=")[1] || "";
const DRY = has("--dry-run");
const FORCE = has("--force");
const wants = kind => !only || only === kind;

/* ── env ─────────────────────────────────────────────────────────────────── */
function loadEnv() {
  const file = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID;

/* Checked against the work actually asked for, not up front. --polish is
 * ffmpeg on files already on disk and --only=sfx / --only=music hit endpoints
 * that take no voice, so demanding both credentials for all of them turns a
 * documented command into an error on a machine that has no key. */
function needCredentials({ voice }) {
  if (DRY) return;
  const missing = [];
  if (!KEY) missing.push("ELEVENLABS_API_KEY");
  if (voice && !VOICE) missing.push("ELEVENLABS_VOICE_ID");
  if (missing.length) {
    console.error(`Missing ${missing.join(" / ")} (environment or scripts/audio/.env).`);
    process.exit(1);
  }
}

/* ── what to say ─────────────────────────────────────────────────────────── */
/* Every week of every TOPIC, not just the current one: he can flip back to an
 * old week or over to another track from the pickers, and both have to keep
 * talking. The topic registry lives in weeks/index.json alongside the school's
 * own week list, and each track's folder holds its own index. */
async function allWeekDocs() {
  const read = p => JSON.parse(readFileSync(p, "utf8"));
  const index = read(join(ROOT, "public", "weeks", "index.json"));
  const docs = [];
  const resolve = createLibraryResolver(path => read(join(ROOT, "public", path)));

  const topics = (index.topics || []).length
    ? index.topics
    : [{ id: "school", dir: "/weeks" }];

  for (const topic of topics) {
    // dir is an app-facing URL path; strip the leading slash to walk it on disk.
    const dir = join(ROOT, "public", topic.dir.replace(/^\//, ""));
    const trackIndex = topic.dir === "/weeks" ? index : read(join(dir, "index.json"));
    for (const w of trackIndex.weeks || []) docs.push(await resolve(read(join(dir, `${w.id}.json`))));
  }
  return { index, docs };
}

async function allPhrases() {
  const { index, docs } = await allWeekDocs();
  const set = new Set();
  for (const doc of docs)
    for (const p of phrasesFor(doc, index)) set.add(p);
  // The Match decks, if this checkout has any. Their names are read out as the
  // cards turn over, and they are the ones he says back — a robot named in a
  // robot voice is the one place in the app that would really show.
  const packIndex = join(ROOT, "public", "packs", "index.json");
  if (existsSync(packIndex)) {
    for (const p of JSON.parse(readFileSync(packIndex, "utf8")).packs || []) {
      const doc = JSON.parse(readFileSync(join(ROOT, "public", "packs", `${p.id}.json`), "utf8"));
      for (const line of packPhrases(doc)) set.add(line);
    }
  }
  return [...set].sort();
}

const clipName = text => createHash("sha1").update(text).digest("hex").slice(0, 12) + ".mp3";

/* ── ElevenLabs ──────────────────────────────────────────────────────────── */
/* Raw fetch rather than the SDK: this repo has no package.json and no build
 * step, and three endpoints don't justify introducing either. */
async function el(path, body, label) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.elevenlabs.io" + path, {
      method: "POST",
      headers: { "xi-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const detail = await res.text().catch(() => "");
    // 429 is a rate limit and 5xx is their end having a moment; both are worth
    // waiting out. A 4xx is our request being wrong and retrying won't fix it.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = attempt * 2000;
      console.warn(`  ${label}: ${res.status}, retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${label}: ${res.status} ${detail.slice(0, 300)}`);
  }
}

/* Lines the multilingual model garbles. A one-word line gives it nothing to
 * detect a language from — "Dime" alone came back as Spanish-ish "DEE-meh" —
 * and the very shortest words can come back as mumbling ("Pet" was "but, uh").
 * These go through the turbo model instead, which is the one that accepts an
 * explicit language. Add a line here, delete its mp3, re-run.
 * scripts/audio/verify.mjs is the audit that finds candidates. */
const ENGLISH_ONLY = new Set([
  "Dime", "Pet", "A", "H", "I", "M", "N", "U", "V", "W", "Y", "Z",
  "Car", "Eat", "Jar", "Lever", "Up",
]);
const PRONUNCIATION = { I: "Eye.", M: "Em.", N: "En.", W: "Double you.", Y: "Why.", Z: "Zee." };
const recordingText = text => PRONUNCIATION[text] || text;

const tts = (text) => el(
  `/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`,
  {
    text: recordingText(text),
    ...(ENGLISH_ONLY.has(text)
      ? { model_id: "eleven_turbo_v2_5", language_code: "en" }
      : { model_id: "eleven_multilingual_v2" }),
    // Warmer and a little more expressive than the podcast settings: this is
    // a dad talking to a four-year-old, not a devotion being narrated.
    voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
  },
  JSON.stringify(text),
);

const sound = (prompt, seconds) => el(
  "/v1/sound-generation",
  { text: prompt, duration_seconds: seconds, prompt_influence: 0.45 },
  "sfx",
);

const music = (prompt, ms) => el("/v1/music", { prompt, music_length_ms: ms }, "music");

/* When each lyric line starts, measured off the finished recording. The app
 * highlights the line being sung, and pacing the lines evenly across the file
 * is only right until the song has an intro or an instrumental bar — so ask
 * ElevenLabs' forced alignment to find every word, then keep the start of each
 * line's first word. Multipart rather than JSON, hence not going through el().
 * Best-effort: sung words over instruments align worse than speech, and a song
 * this can't place still plays — the app falls back to the even spread. */
async function alignLines(file, lyrics) {
  const fd = new FormData();
  fd.append("file", new Blob([readFileSync(file)], { type: "audio/mpeg" }), "song.mp3");
  fd.append("text", lyrics.join("\n"));
  const res = await fetch("https://api.elevenlabs.io/v1/forced-alignment", {
    method: "POST",
    headers: { "xi-api-key": KEY },
    body: fd,
  });
  if (!res.ok) throw new Error(`alignment: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const doc = await res.json();
  const words = (doc.words || []).filter(w => /\S/.test(w.text));
  const starts = [];
  let at = 0;
  for (const line of lyrics) {
    const w = words[at];
    if (!w) throw new Error("alignment: fewer words than the lyrics");
    // A beat early, so the line lights as the word starts rather than mid-vowel.
    starts.push(Math.max(0, Math.round((w.start - 0.15) * 100) / 100));
    at += line.split(/\s+/).filter(Boolean).length;
  }
  return starts;
}

/* ── polish ──────────────────────────────────────────────────────────────── */
/* Two things, both about how the clips sound joined together.
 *
 * Every generated clip arrives padded with a beat of silence at each end. Play
 * one and it's imperceptible; play "That one is 5." straight into "Find the
 * number 7." and the two pads stack into a hole in the middle of the sentence.
 * Trimming to a 50ms margin puts them back in one breath. The threshold is
 * deliberately low (-50dB) — trimming harder eats the first consonant, and a
 * clipped "seven" is worse than a slightly long pause.
 *
 * Then down to 64kbps mono. This is speech through a tablet speaker; 128kbps
 * stereo was three hundred files of nothing, and the whole pack gets pulled
 * over the network on a cold start.
 *
 * Skipped, with a warning, if ffmpeg isn't installed — an unpolished pack
 * sounds slightly loose, which is a long way from broken. */
const TRIM = "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:detection=peak";
let ffmpegOk = null;
function haveFfmpeg() {
  if (ffmpegOk === null) {
    try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); ffmpegOk = true; }
    catch { ffmpegOk = false; }
  }
  return ffmpegOk;
}

function polish(file) {
  if (!haveFfmpeg()) return false;
  const tmp = file + ".tmp.mp3";
  try {
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-i", file,
      // Trim the head, reverse and trim what is now the head, reverse back.
      "-af", `${TRIM},areverse,${TRIM},areverse`,
      "-ac", "1", "-b:a", "64k", tmp,
    ], { stdio: "ignore" });
    renameSync(tmp, file);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch {}
    return false;
  }
}

/* Re-polish everything already on disk, without calling the API — for the
 * pack that was generated before this step existed, or after changing it. */
function polishAll() {
  if (!haveFfmpeg()) {
    console.error("ffmpeg not found — nothing to do.");
    return;
  }
  if (!existsSync(VO_DIR)) {
    console.error("no voice pack on disk yet — run without --polish first.");
    return;
  }
  const files = readdirSync(VO_DIR).filter(f => f.endsWith(".mp3") && !f.endsWith(".tmp.mp3"));
  let ok = 0;
  for (const f of files) if (polish(join(VO_DIR, f))) ok++;
  console.log(`polished ${ok}/${files.length} clips`);
}

/* ── run ─────────────────────────────────────────────────────────────────── */
/* A few at a time. Sequential is slow at three hundred clips and unbounded
 * parallelism just earns 429s. */
async function pool(items, size, worker) {
  let i = 0, done = 0;
  const next = async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
      done++;
      if (done % 25 === 0) console.log(`  … ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
}

async function doVoice() {
  mkdirSync(VO_DIR, { recursive: true });
  const phrases = await allPhrases();
  const clips = {};
  phrases.forEach(t => { clips[t] = clipName(t); });

  const onDisk = new Set(existsSync(VO_DIR) ? readdirSync(VO_DIR) : []);
  const todo = FORCE ? phrases : phrases.filter(t => !onDisk.has(clips[t]));
  const chars = todo.reduce((n, t) => n + recordingText(t).length, 0);

  console.log(`voice: ${phrases.length} lines, ${todo.length} to record (${chars} characters)`);
  if (DRY || !todo.length) {
    if (!DRY) writeManifest(clips, phrases.length);
    return;
  }

  if (!haveFfmpeg()) console.warn("  ffmpeg not found — clips will keep their padding and full bitrate");
  await pool(todo, 4, async text => {
    const file = join(VO_DIR, clips[text]);
    writeFileSync(file, await tts(text));
    polish(file);
  });
  writeManifest(clips, phrases.length);

  /* Files for lines nobody says any more. Left alone deliberately — deleting
   * them would break a browser still holding the previous manifest, and a few
   * stale kilobytes are cheaper than that. */
  const live = new Set(Object.values(clips));
  const stale = [...onDisk].filter(f => f.endsWith(".mp3") && !live.has(f));
  if (stale.length) console.log(`  (${stale.length} clip(s) no longer referenced — safe to delete by hand)`);
}

function writeManifest(clips, count) {
  writeFileSync(MANIFEST, JSON.stringify({
    voice: VOICE || null,
    lines: count,
    clips,
  }, null, 1) + "\n");
}

async function doSfx() {
  const dir = join(AUDIO, "sfx");
  mkdirSync(dir, { recursive: true });
  const todo = SFX.filter(s => FORCE || !existsSync(join(dir, `${s.name}.mp3`)));
  console.log(`sfx: ${todo.length} to make`);
  if (DRY) return;
  for (const s of todo) {
    writeFileSync(join(dir, `${s.name}.mp3`), await sound(s.prompt, s.seconds));
    console.log(`  ${s.name}.mp3`);
  }
}

async function doMusic() {
  const dir = join(AUDIO, "music");
  mkdirSync(dir, { recursive: true });
  const todo = MUSIC.filter(m => FORCE || !existsSync(join(dir, `${m.name}.mp3`)));
  console.log(`music: ${todo.length} to make`);
  if (DRY) return;
  for (const m of todo) {
    writeFileSync(join(dir, `${m.name}.mp3`), await music(m.prompt, m.ms));
    console.log(`  ${m.name}.mp3`);
  }
}

/* ── sing-along songs ────────────────────────────────────────────────────────
 * A `songs` entry in a week doc is a real song: a style, the lyrics, and how
 * long it should run. The file is named after a hash of all three — the same
 * scheme as the voice clips, and for the same reason: an unchanged song is
 * already on disk and costs nothing, a reworded one is a new file, and the
 * service worker's cache-by-name never goes stale. The manifest maps song id →
 * file plus each lyric line's start time, which is what the read-along
 * highlighting runs on. */
const SONGS_DIR = join(AUDIO, "songs");
const SONG_MANIFEST = join(SONGS_DIR, "index.json");

function songPrompt(sg) {
  return `${sg.style} Sing exactly these lyrics, word for word, nothing added:\n${sg.lyrics.join("\n")}`;
}

async function doSongs() {
  mkdirSync(SONGS_DIR, { recursive: true });

  /* By id, first one wins: the same song legitimately rides more than one week
   * — the feelings song is on both school weeks — and a flattened list would
   * pay the music endpoint once per copy under --force. */
  const seen = new Map();
  for (const sg of (await allWeekDocs()).docs.flatMap(doc => doc.songs || [])) {
    if (!sg.id || !sg.style || !(sg.lyrics || []).length) continue;
    if (!seen.has(sg.id)) seen.set(sg.id, sg);
    else if (JSON.stringify(seen.get(sg.id)) !== JSON.stringify(sg))
      console.warn(`  ${sg.id}: defined differently in two weeks — keeping the first`);
  }
  const songs = [...seen.values()];

  let prev = {};
  try { prev = JSON.parse(readFileSync(SONG_MANIFEST, "utf8")).songs || {}; } catch {}

  const cfgHash = sg => createHash("sha1")
    .update(JSON.stringify({ style: sg.style, lyrics: sg.lyrics, ms: sg.ms || 60000 }))
    .digest("hex").slice(0, 12);

  /* A manifest entry still stands when it was made from this same config and
   * its file is on disk. Entries from before `hash` was recorded used the
   * config hash AS the filename, which is the same statement said older. */
  const current = sg => {
    const p = prev[sg.id], h = cfgHash(sg);
    return p && (p.hash === h || p.file === h + ".mp3") && existsSync(join(SONGS_DIR, p.file))
      ? p : null;
  };

  const todo = songs.filter(sg => FORCE || !current(sg));
  console.log(`songs: ${songs.length} in the week docs, ${todo.length} to generate`);
  if (DRY) return;

  const save = map => writeFileSync(SONG_MANIFEST, JSON.stringify({ songs: map }, null, 1) + "\n");
  const out = {};
  for (const sg of songs) {
    const kept = !FORCE && current(sg);
    if (kept) {
      // Kept recordings keep their measured times too — unless alignment
      // failed last time, in which case it's worth another try on its own.
      let lines = kept.lines || null;
      if (!lines) {
        try { lines = await alignLines(join(SONGS_DIR, kept.file), sg.lyrics); }
        catch (e) { console.warn(`  ${sg.id}: no line times (${e.message}) — app will pace the lyrics evenly`); }
      }
      out[sg.id] = { file: kept.file, hash: cfgHash(sg), lines };
      continue;
    }
    /* Named after the AUDIO, not the config: the service worker serves songs
     * cache-first by name, so a --force remake under its old name would leave
     * installed apps playing the old recording against the new line times.
     * A new performance is a new file; the manifest is what points at it. */
    const buf = await music(songPrompt(sg), sg.ms || 60000);
    const file = createHash("sha1").update(buf).digest("hex").slice(0, 12) + ".mp3";
    writeFileSync(join(SONGS_DIR, file), buf);
    console.log(`  ${sg.id} → ${file}`);
    let lines = null;
    try { lines = await alignLines(join(SONGS_DIR, file), sg.lyrics); }
    catch (e) { console.warn(`  ${sg.id}: no line times (${e.message}) — app will pace the lyrics evenly`); }
    out[sg.id] = { file, hash: cfgHash(sg), lines };
    /* Persisted per song, not at the end: a failure on song five must not
     * orphan four content-hash-named files already paid for — without their
     * manifest rows, current() can never recognize them on the rerun. Songs
     * the loop hasn't reached keep their previous entries meanwhile. */
    save({ ...prev, ...out });
  }
  // The clean final write is the one that retires ids no week carries any more.
  save(out);

  /* Files no longer pointed at — the old performance after a --force. Left on
   * disk deliberately, same as the voice clips: a browser holding the previous
   * manifest can still play them, and stale kilobytes are cheaper than that. */
  const live = new Set(Object.values(out).map(s => s.file));
  const stale = readdirSync(SONGS_DIR).filter(f => f.endsWith(".mp3") && !live.has(f));
  if (stale.length) console.log(`  (${stale.length} song file(s) no longer referenced — safe to delete by hand)`);
}

if (has("--polish")) {
  polishAll();
  process.exit(0);
}

needCredentials({ voice: wants("vo") });

if (wants("vo")) await doVoice();
if (wants("sfx")) await doSfx();
if (wants("music")) await doMusic();
if (wants("songs")) await doSongs();

/* The sound effects and the loop have fixed filenames, and a --force re-records
 * voice clips under their unchanged sentence-hash names; the service worker
 * caches /audio/ by name, so replacing any of those and deploying isn't enough
 * on a device that already has the old copy — CACHE in public/sw.js has to
 * move too. Songs are the exception: they're named after their audio, so a
 * remade one is a new file and needs no bump. */
if (!DRY && (only === "sfx" || only === "music" || (FORCE && only !== "songs"))) {
  console.log("\nRemade same-name files — bump CACHE in public/sw.js or installed apps keep the old ones.");
}
