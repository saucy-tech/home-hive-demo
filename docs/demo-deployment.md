# Publishing a sanitized demo

This repository stays private. What gets shown to other people is a separate, sanitized copy
deployed to `home-hive-demo.<account>.workers.dev` — same code, an invented week, no child, no
school, no hostname, no account identifier. It lives on Cloudflare's own workers.dev rather than a
custom domain: the demo is a showcase, not a service, so there is no DNS record to create and no
zone to touch.

The reason for a fork rather than making this repository public is history. Deleting a file only
removes it going forward; every earlier commit still contains it, and a public commit should be
assumed cloned and indexed within hours. Sanitizing forward and republishing the same history
would publish exactly what the sanitization removed.

The thing being protected here is not a credential. It is a four-year-old — his name, his school,
his class, and a written record of what happens in his house between five and eight every
weeknight. None of that is recoverable once it is public, and none of it is his to have published.

## What the demo cannot reach

Four independent barriers separate the demo deployment from the real household record. None of
them depends on the others, so no single misconfiguration exposes anything:

| Barrier | Where | Effect |
| --- | --- | --- |
| No KV binding | `wrangler.demo.jsonc` | `env.HIVE` is undefined; `/api/*` answers 404 with no store behind it |
| Hostname pin | `src/index.js` (`DATA_HOSTNAME`) | The API 404s on any host but production, binding or not |
| Sync gate | `public/app.js` (`SYNC_HOSTS`) | The page runs pure-localStorage anywhere but production |
| No route | `wrangler.demo.jsonc` | Nothing the demo deploys can answer on the gated hostname |

The sync gate is an **allowlist**, not a denylist — sync has to be switched on for a host, so a
new deployment somewhere unexpected is local-only by default rather than by remembering to
exclude it. A demo visitor's taps live in their own browser and go nowhere. Nothing in the demo
deployment holds a second person's data, which is what keeps it a showcase rather than a service
with privacy obligations attached.

## Sample data

`demo/` holds everything the fork substitutes in: an invented week — the Sunflower Room, a kid
called Sam, a weather theme no real class was doing — and the public-facing `README.md`. The
sanitizer promotes them over `public/weeks/` and the household README, so the demo opens on a
populated week with working games instead of an empty shell, and the real lesson plans never enter
the fork at all.

The two books in the demo week are real published picture books with read-aloud videos verified
to embed. That is worth re-checking whenever the demo is rebuilt: uploads get taken down, and a
demo whose Story Time is broken is worse than one without it.

## Producing the fork

Work in a scratch clone. The script deletes tracked files and, with `--fresh-history`, discards
every commit — neither is something to run in the working repository.

```bash
git clone <this repo> /tmp/home-hive-demo
cd /tmp/home-hive-demo
./scripts/sanitize-fork.sh --fresh-history
```

It removes `public/weeks/` (the school's real lesson plans and his real evenings), `wrangler.jsonc`,
`setup-access.sh`, `DEPLOY.md` and `AUTHORING.md`; promotes the invented week and the demo wrangler
config into their places; rewrites the production hostname in both constants that carry it; then
scans every tracked file for email addresses, Access team domains, 32- and 64-hex ids, workers.dev
account subdomains, and the household terms — and **exits nonzero if any survive**. A failing scan
restores the clone to where it started, so a failed run costs nothing but the time.

The scan avoids naming what it looks for, in two different ways, for one reason: a denylist is a
disclosure of everything on it. Identifiers are matched by generic pattern — any email address, any
`*.cloudflareaccess.com`, any 32- or 64-hex id — so no literal address appears in the script. The
household terms cannot be generalized that way, so they live in `scripts/sanitize-terms.txt`, which
the script reads into memory at startup and then deletes from the fork. A published script whose
pattern list spelled out a child's name and his school would tell every reader exactly who had been
scrubbed — the disclosure the scan exists to prevent, restated as a tool.

That file is also why the script must be run from a clone of the private repository: without the
terms it exits rather than reporting a clean scan it did not actually perform.

Then:

```bash
git remote add origin <the new demo repo>
git push -u origin main
npx wrangler deploy
```

## Keeping it current

```bash
./scripts/publish-demo.sh git@github.com:saucy-tech/home-hive-demo.git --deploy
```

It clones this repository at `HEAD`, sanitizes, shows what will be published, and asks before
pushing anything. `--deploy` runs `wrangler deploy` afterward.

Without a terminal to prompt in it stops and prints the file list; re-run with `--yes` to push
what you just read. What the control requires is a deliberate human act, not an interactive
shell — the first version demanded a TTY and was therefore unusable from an agent session, which
is where it actually gets run.

`--fresh-history` does more than write an orphan commit, and the difference matters. A clone also
carries `refs/remotes/origin/*` pointing at the entire original history: leave those in place and
the removed files stay readable through `git log origin/main` and publishable by a stray
`git push --mirror`. The script drops every remaining ref, removes the `origin` remote so the demo
remote has to be added on purpose, then expires the reflog and prunes — and afterward *verifies*
that the original commit is unreachable, rather than trusting that the sequence worked.

## Before each publish

- [ ] `git log` shows one commit, not the original history, and `git remote` is empty
- [ ] the sanitizer's scan section prints `clean.` — that *is* the term check, and re-stating the
      terms here as a second grep would put them back in a published file
- [ ] the diff has been read by a person — the scan cannot recognize a category it has never seen
- [ ] `LICENSE` is present — PolyForm Noncommercial 1.0.0 reserves commercial use
- [ ] the deployed demo opens on the sample week and the games play
- [ ] `curl -sI https://<demo-host>/api/state` returns 404, not 200
- [ ] the demo repository was created **private**, and is only flipped public after the above

## What stays private regardless

`public/weeks/` is the reason this whole flow exists. Those files are a specific preschool's
lesson plan and a specific child's week, written for two parents. They are also the most
interesting thing in the repository, which is precisely the pressure this arrangement exists to
resist. They stay in the private repository.
