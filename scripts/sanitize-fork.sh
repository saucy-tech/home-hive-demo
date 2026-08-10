#!/usr/bin/env bash
# Turn a clone of this repository into the sanitized copy that backs the public demo.
#
# Run this in a SCRATCH CLONE, never in the working repository — it deletes tracked files and,
# with --fresh-history, discards every commit. The intended flow is in docs/demo-deployment.md.
#
#   git clone <this repo> /tmp/home-hive-demo && cd /tmp/home-hive-demo
#   ./scripts/sanitize-fork.sh --fresh-history
#   git remote add origin <the new demo repo> && git push -u origin main
#
# Two things this script cannot do for you, both covered in the runbook:
#   · decide whether the demo repo should be private (it should start private)
#   · read the diff — the scan is a backstop for what it knows to look for, not a substitute
#
# The scan is written as PATTERNS rather than literal identifiers on purpose: a denylist naming
# the child it is meant to protect would itself ship in the fork.
set -euo pipefail
cd "$(dirname "$0")/.."

FRESH_HISTORY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --fresh-history) FRESH_HISTORY=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "ERROR: $*" >&2; exit 1; }

# The identity stamped on the sanitized root commit. Deliberately impersonal: commit metadata is
# published alongside the tree and no content scan reads it, so inheriting the publisher's git
# config would leak their address through the one channel this script does not otherwise check.
COMMIT_NAME="Home Hive Demo"
COMMIT_EMAIL="demo@users.noreply.github.com"

# Read the terms BEFORE anything is removed — the file holding them is itself one of the paths
# this script deletes. Missing file is fatal rather than skippable: a scan that silently drops a
# whole category is worse than no scan, because it reports "clean".
TERMS_FILE="scripts/sanitize-terms.txt"
[ -f "$TERMS_FILE" ] || fail "$TERMS_FILE is missing — run this in a clone of the private repository."
TERMS_PATTERN="$(grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" | paste -sd '|' -)"
[ -n "$TERMS_PATTERN" ] || fail "$TERMS_FILE contains no terms."

# ---------------------------------------------------------------- guards

[ -d .git ] || fail "not a git checkout — run this in a clone, not an exported tarball."
ORIGINAL_HEAD="$(git rev-parse HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is dirty. Commit or stash first so the sanitization is reviewable as a diff."
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  echo "This DELETES tracked files in $(pwd)"
  [ "$FRESH_HISTORY" -eq 1 ] && echo "and DISCARDS ALL GIT HISTORY (--fresh-history)."
  printf 'Type "sanitize" to continue: '
  read -r reply
  [ "$reply" = "sanitize" ] || fail "aborted."
fi

# ---------------------------------------------------------------- removals

# Everything that is about this household rather than about the software.
REMOVE=(
  # The real lesson plans. His school's curriculum is their work and his week is his; the demo
  # ships an invented week instead. Removed by DIRECTORY, which is what makes it durable — next
  # month's week lands in the same place and is dropped without anyone remembering a list.
  "public/weeks"
  # Account id, KV namespace id, and the gated hostname.
  "wrangler.jsonc"
  # Both household email addresses and the account id.
  "setup-access.sh"
  # Names the hostname, the emails, and the child's iPad.
  "DEPLOY.md"
  # The weekly ritual, written for the person who lives it.
  "AUTHORING.md"
  # Written for the household — names the child and the private hostname. The
  # fork gets demo/README.md, which is the public-facing one.
  "README.md"
)

for path in "${REMOVE[@]}"; do
  if [ -e "$path" ]; then
    git rm -r --quiet "$path"
    echo "removed  $path"
  fi
done

# The invented week takes the real one's place, and the demo config becomes the only config — so
# `wrangler deploy` inside the fork cannot target production even if someone omits -c.
if [ -d demo/weeks ]; then
  git mv demo/weeks public/weeks
  echo "promoted demo/weeks -> public/weeks"
fi
if [ -f demo/README.md ]; then
  git mv demo/README.md README.md
  echo "promoted demo/README.md -> README.md"
fi
rmdir demo 2>/dev/null || true
if [ -f wrangler.demo.jsonc ]; then
  git mv wrangler.demo.jsonc wrangler.jsonc
  echo "promoted wrangler.demo.jsonc -> wrangler.jsonc"
fi

# The production hostname is compiled into two constants. Rewrite both to a reserved-invalid name
# rather than deleting the mechanism: the demo should still SHOW that sync is host-gated, since
# that gate is a thing worth demonstrating. Any occurrence these two misses is caught by the scan
# below, because the hostname is also a term.
if [ -f src/index.js ]; then
  sed -i.bak 's/^const DATA_HOSTNAME = ".*";/const DATA_HOSTNAME = "app.example.invalid";/' src/index.js
  rm -f src/index.js.bak
fi
if [ -f public/app.js ]; then
  sed -i.bak 's/^const SYNC_HOSTS = \[.*\];/const SYNC_HOSTS = ["app.example.invalid", "localhost", "127.0.0.1"];/' public/app.js
  rm -f public/app.js.bak
fi
git add -A src/index.js public/app.js 2>/dev/null || true
echo "rewrote  production hostname -> app.example.invalid"

# ---------------------------------------------------------------- scan

echo
echo "Scanning for identifiers and household terms..."

SCAN_STATUS=0

# This script necessarily contains every pattern it searches for, so it cannot scan itself.
SELF="scripts/sanitize-fork.sh"

# RFC 2606 placeholders and the impersonal commit identity. Every alternative describes the WHOLE
# extracted match and is anchored, because an unanchored allowance matches as a substring:
# `@example\.com` would otherwise pardon `attacker@example.com.evil.net`.
#
# Exported rather than passed with `awk -v`: -v runs escape processing over the value, and gawk
# turns an unrecognized `\.` into a bare `.`, quietly widening the allowance to any character.
#
# The demo's own workers.dev host is allowed because it is in every visitor's address bar the
# moment the demo is public — allowing it costs nothing. It is allowed by WORKER NAME with the
# account label left as a wildcard, so the account is not written into a script that ships in the
# fork, and any other workers.dev host still gets flagged.
export SANITIZE_ALLOW="^([A-Za-z0-9._%+-]+@example\.com|[A-Za-z0-9._%+-]+@users\.noreply\.github\.com|git@github\.com|app\.example\.invalid|[A-Za-z0-9-]+\.example\.workers\.dev|home-hive-demo\.[A-Za-z0-9-]+\.workers\.dev)$"

# A malformed pattern makes grep exit 2 with a message on stderr — which, swallowed by `|| true`,
# is indistinguishable from "no matches". The scan would print `clean` having examined nothing.
# sanitize-terms.txt is hand-edited, so every pattern is proved to compile before it is used.
assert_valid_pattern() {
  local pattern="$1" label="$2" message status
  if message="$(printf '' | grep -E "$pattern" 2>&1 >/dev/null)"; then status=0; else status=$?; fi
  [ "$status" -le 1 ] || fail "the $label pattern does not compile: ${message:-grep exited $status}"
}

scan() {
  local label="$1" pattern="$2"
  local hits errors errfile content_hits path_hits
  assert_valid_pattern "$pattern" "$label"
  errfile="$(mktemp)"

  # Tracked files only — an untracked scratch file is not going to be published.
  #
  # Every MATCH is judged on its own, not the line it sits on: a line-level `grep -v` would drop
  # the whole line, so a line carrying both a fixture and a real value passes entirely. -o splits
  # the line into one match per record before anything is excluded.
  #
  # -a, not -I. PNG metadata is text, and icons routinely carry XMP with a live address in it —
  # exactly the category a binary-skipping scan misses while reporting clean.
  content_hits="$(git ls-files -z | grep -zFxv "$SELF" | grep -zFxv "$TERMS_FILE" | xargs -0 grep -HaoniE "$pattern" 2>"$errfile" \
    | awk '
        BEGIN { allow = ENVIRON["SANITIZE_ALLOW"] }
        { i = index($0, ":"); rest = substr($0, i + 1);
          j = index(rest, ":"); loc = substr($0, 1, i + j - 1); m = substr(rest, j + 1);
          if (tolower(m) !~ allow) print loc ": " m }' || true)"

  # A path is published in the tree whether or not the bytes under it are clean: a filename like
  # weeks/<the-kid>-august.json discloses just as loudly as its contents would.
  #
  # Note this script is excluded from its own scan (it necessarily contains every pattern it
  # searches for), so nothing here is checked automatically. Keep the comments generic by hand —
  # an illustrative example using a real name would publish that name.
  path_hits="$(git ls-files | grep -Fxv "$SELF" | grep -Fxv "$TERMS_FILE" | while IFS= read -r path; do
        printf '%s\n' "$path" | grep -aoiE "$pattern" | while IFS= read -r match; do
          printf '(tracked path) %s\t%s\n' "$path" "$match"
        done
      done | awk -F'\t' '
        BEGIN { allow = ENVIRON["SANITIZE_ALLOW"] }
        NF == 2 && tolower($2) !~ allow { print $1 ": " $2 }' || true)"

  hits="$(printf '%s\n%s\n' "$content_hits" "$path_hits" | sed '/^[[:space:]]*$/d')"

  errors="$(cat "$errfile")"; rm -f "$errfile"
  [ -z "$errors" ] || fail "the $label scan reported errors and cannot be trusted:
$errors"

  if [ -n "$hits" ]; then
    echo
    echo "  [$label]"
    printf '%s\n' "$hits" | sed '/^$/d; s/^/    /'
    SCAN_STATUS=1
  fi
}

scan "email address"      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
scan "Access team domain" '[A-Za-z0-9-]+\.cloudflareaccess\.com'
# workers.dev preview hosts are <worker>.<account-subdomain>.workers.dev, so the middle label
# names the Cloudflare account.
scan "workers.dev account" '[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.workers\.dev'
scan "32/64-hex id"       '\b[0-9a-f]{32}([0-9a-f]{32})?\b'
scan "household terms"    "($TERMS_PATTERN)"

# Dangling references are a warning, not a failure. A link to a removed runbook is a broken link,
# not a disclosure, and the fix is prose that belongs to the author.
DANGLING=0
for path in "${REMOVE[@]}"; do
  [ -e "$path" ] && continue
  refs="$(git ls-files -z | grep -zFxv "$SELF" | xargs -0 grep -InF "$path" 2>/dev/null \
    | grep -v '^docs/demo-deployment.md:' || true)"
  if [ -n "$refs" ]; then
    [ "$DANGLING" -eq 0 ] && echo && echo "  Note — references to removed paths (broken links in the fork):"
    DANGLING=1
    echo "$refs" | sed 's/^/    /'
  fi
done

if [ "$SCAN_STATUS" -ne 0 ]; then
  # Put the clone back exactly as it was found. A half-sanitized tree makes the advice below
  # impossible to follow: the dirty-tree guard would reject the re-run, and the terms file the
  # startup check needs may already be gone.
  git reset --hard --quiet "$ORIGINAL_HEAD"
  git clean -fdq
  echo
  echo "Sanitization is INCOMPLETE — resolve every hit above, then re-run."
  echo "The clone has been restored to $(git rev-parse --short HEAD); nothing was left half-done."
  exit 1
fi

echo "  clean."

# Only now, once the scan has passed. Held back this far because the terms are needed at startup
# on every run including a re-run.
if [ -e "$TERMS_FILE" ]; then
  git rm -r --quiet "$TERMS_FILE"
  echo "removed  $TERMS_FILE"
fi

# ---------------------------------------------------------------- history

# Deleting a file in a new commit leaves it in every earlier one, so a fork that keeps history
# publishes exactly what was just removed. An orphan commit is the only reliable answer.
if [ "$FRESH_HISTORY" -eq 1 ]; then
  # An orphan commit plus ref deletion plus `gc --prune=now` is the usual recipe and it does not
  # actually erase anything reliably. gc's guarantees are about REACHABILITY, not erasure: the
  # original commits sat in the clone's pack afterwards every time, still readable by hash, and a
  # same-filesystem clone may be borrowing them from the source repository outright.
  #
  # So don't negotiate with gc. Throw the repository away and build a new one around the
  # sanitized working tree. An object store that never contained the original history cannot
  # publish it, and that is a property worth having rather than a sequence worth trusting.
  #
  # Safe because the working tree at this point is exactly the sanitized set: a fresh clone has
  # no untracked files, the removals above deleted their files from disk, and .gitignore is
  # itself tracked and still in place.
  [ -n "$(git ls-files)" ] || fail "no tracked files left — refusing to publish an empty tree."

  rm -rf .git
  git init --quiet
  git checkout --quiet -b main 2>/dev/null || git branch -M main
  git add -A
  git -c user.name="$COMMIT_NAME" -c user.email="$COMMIT_EMAIL" \
      commit --quiet -m "The Home Hive — public demo

Sanitized copy of a private repository. Invented sample week; no real child,
school, lesson plan, hostname or account identifier. Rebuilt from scratch on
every publish rather than accumulating history, so the published tree is only
ever the output of a scan that passed."

  # Prove it, rather than trusting the sequence above.
  if git cat-file -e "$ORIGINAL_HEAD" 2>/dev/null; then
    fail "the original history is still reachable in this clone — do NOT push it."
  fi
  [ "$(git rev-list --count HEAD)" = "1" ] || fail "expected exactly one commit after --fresh-history."
  [ -z "$(git remote)" ] || fail "a remote survived the rewrite."
  [ ! -f .git/objects/info/alternates ] || fail "the fork is still borrowing objects from another repository."

  echo
  echo "History rebuilt: new object store, 1 commit, no remotes."
fi

echo
echo "Done. Read the diff before publishing anything:"
echo "  git show --stat"
echo "Create the demo repository PRIVATE first, then flip it public once you've read it."
