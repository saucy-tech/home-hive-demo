# The Home Hive

A weekly preschool lesson plan, folded into the evening a family is already
having — and a set of games the kid can play on an iPad by themselves.

**[Open the demo →](https://home-hive-demo.brandonsauceda.workers.dev)**

This is a sanitized public copy. The week in it is invented. The real one runs
privately behind Cloudflare Access for one family.

## What it does

Preschools send home a lesson-plan poster every week. It's useful and it
usually goes on the fridge and stays there, because nothing on it tells a tired
parent what to actually do at 6:40pm on a Tuesday.

This turns that poster into two things.

**A plan.** The week as five evenings — after school, dinner, bath, bedtime.
Four short activities a day, each tied to what the class is doing, each with a
line explaining what it's training, plus whatever the teacher asked to be
practised *every* day sitting above them and ticked per day. Both parents tick
the same list from whatever device is in hand.

**A game mode.** Games on big touch targets, every prompt read aloud, so a child
who cannot read yet can play without an adult sitting next to them.

**Topics.** The school's lesson plan is one track among several — a body-and-
doctor track with the real names for real parts, a code track, a smart-machines
track, money, robots. A track is a folder of week docs and a line in an index;
which games appear is decided by which config blocks the loaded week carries, so
adding a whole subject is data rather than code. The topic picker sits above the
week picker, and the week picker always opens on the current week, falling back
to the newest unit that has already started — which is what lets a track written
in August still be there in October instead of going blank.

## The part worth stealing

Every activity carries **two levels**.

Preschool rooms are mixed-age. A class labelled for three-year-olds will have
four-year-olds in it who are a full developmental year ahead — and the lesson
plan is written for the middle. So each activity shows the class version *and*
a harder version of the same activity:

| The class version | The stretch |
| --- | --- |
| Count to 11 | Count to 20, then backwards, then count on from 7 |
| Name happy and sad | Name frustrated and proud, and say what to *do* about it |
| "What should he do next?" | "How does the *other* character feel?" |
| Trace the letter | Write the first letter of a word you chose |

The older child stays in the conversation their classmates are having instead
of being pulled out of it, and still gets asked something hard. Perspective-
taking, cause-and-effect, counting on from a number, letters attached to
something they care about, and knowing where a day sits in the week are the
levers that actually separate five from three.

## The games

Three of these are engines rather than single games: naming, two-pile sorting and
sequencing each read a list out of the week doc, so one of them can be Feelings
Faces on a school week and body parts, code words or robot parts on a track.

| Game | What it trains |
| --- | --- |
| Feelings Faces / Name It | The real word for a thing, and one true sentence about what it does |
| Number Hive | Finding a numeral by name, counting a set, matching numeral to quantity both ways |
| Count the Hive | Counting up and **backwards** — chosen, never a gate in front of another game |
| Which is More? | Comparing two amounts by counting them, not by eyeballing them |
| Day by Day | Yesterday, today, tomorrow, and what comes before and after a day |
| Letter Hunt | The week's letter sound |
| Two-pile sort | Judgement, one scenario at a time — kind or not, inside or outside, alive or machine |
| Step by Step | Sequencing: first, then, last |
| Code the Bee | Programming. Build the whole program, run it, and fix it when it bumps a wall |
| What Comes Next? | Patterns, which is the first idea that behaves like a loop |
| Match | Memory, with the card spoken aloud on every flip — nine pairs or twelve |
| What Helps? | Self-regulation — deliberately unscored |
| Story Time | The week's books |

Number Hive, Count the Hive, Match and Day by Day each have two bands the child
can switch between. Most of the rest instead keep a level that moves on its own —
a clean round takes the child up, a rough one puts them back — which changes how
much of the week's word bank is dealt, how many wrong answers there are to rule
out, whether the deliberately tricky items are on the board at all, and how long
a program Code the Bee asks for. It can be set by hand too, for the evenings the
app reads wrong.

Code the Bee is the one that is really about failing well. The program is built
whole before anything runs, and a run that ends in a wall leaves the program on
screen — so the next tap is a correction rather than a fresh guess.
Day by Day is built entirely from the calendar and the week already loaded, so
it needs no content of its own — and a correct answer about a real date comes
back with what that day actually holds. "What Helps?" keeps no score on
purpose: there is no wrong way to calm down, and making it something a child
can fail would defeat the point.

## How it's built

Static assets and a small Worker on Cloudflare. Shared household state in KV —
one document, both parents, any device; the API merges per-key deltas so two
phones editing different activities never overwrite each other. Installable
PWA. No framework, no build step, no dependencies.

Content is data. A week is one JSON file; adding one touches no code. That
includes the notes that come home mid-week — the reminders card and the
every-day strip are both just arrays in that file, and a week without them
renders as if they had never existed.

Two decisions that came out of building it rather than planning it:

- **YouTube goes through the IFrame API, not an `<iframe>`.** A plain embed
  drops a four-year-old onto a grid of tappable suggestions the moment a story
  ends. Catching the `ENDED` state and covering the player with your own card
  is the entire reason for the extra work — but it is only the first half of
  it. End screens, the channel link in the player chrome and the pause overlay
  all put another video one tap away *while the state is still `PLAYING`*, and
  none of them fire an event you can catch. `rel=0` has not meant "no related
  videos" since 2018. The frame has to be treated as hostile: controls off, and
  a transparent shield over it so nothing inside is reachable by touch.
- **The service worker is network-first.** Cache-first meant every deploy
  served one stale load to whoever opened it next — a genuinely miserable bug
  to chase from a phone.

## Running it

```sh
npx wrangler dev
```

There is no KV binding and no sync in this copy: the demo's API answers 404 by
design, and anything you tap is stored in your own browser and goes nowhere.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Read it, learn from it, run it
yourself; commercial use stays with the author.
