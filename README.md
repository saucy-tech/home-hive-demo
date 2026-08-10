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
line explaining what it's training. Both parents tick the same list from
whatever device is in hand.

**A game mode.** Seven games on big touch targets, every prompt read aloud, so
a child who cannot read yet can play without an adult sitting next to them.

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
taking, cause-and-effect, counting on from a number, and letters attached to
something they care about are the four levers that actually separate five from
three.

## The games

| Game | What it trains |
| --- | --- |
| Feelings Faces | Emotion vocabulary past happy and sad |
| Number Hive | Counting up, counting **back**, and matching a quantity to a numeral |
| Letter Hunt | The week's letter sound |
| Kind or Not? | Social judgement, one scenario at a time |
| Feelings Match | Memory, with the feeling spoken aloud on every flip |
| What Helps? | Self-regulation — deliberately unscored |
| Story Time | The week's books |

Number Hive has two bands the child can switch between. "What Helps?" keeps no
score on purpose: there is no wrong way to calm down, and making it something a
child can fail would defeat the point.

## How it's built

Static assets and a small Worker on Cloudflare. Shared household state in KV —
one document, both parents, any device; the API merges per-key deltas so two
phones editing different activities never overwrite each other. Installable
PWA. No framework, no build step, no dependencies.

Content is data. A week is one JSON file; adding one touches no code.

Two decisions that came out of building it rather than planning it:

- **YouTube goes through the IFrame API, not an `<iframe>`.** A plain embed
  drops a four-year-old onto a grid of tappable suggestions the moment a story
  ends. Catching the `ENDED` state and covering the player with your own card
  is the entire reason for the extra work.
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
