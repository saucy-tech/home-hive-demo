#!/usr/bin/env bash
# Rebuild the public demo from this repository's HEAD and push it.
#
#   ./scripts/publish-demo.sh git@github.com:you/home-hive-demo.git [--deploy]
#
# Every publish rebuilds from scratch and force-pushes over the previous one. The demo repository
# is a published artifact, not a place work happens. A sanitized copy must not accumulate history:
# each new commit would have to be sanitized on its own, and a single miss would be permanent in
# exactly the way this arrangement exists to prevent. Rebuilt from scratch, the published tree is
# only ever the output of a scan that passed — which is also why this is a force push and not a
# merge: the two repositories share no history by construction, so nothing can fast-forward.
set -euo pipefail

REMOTE="${1:-}"
DEPLOY=0
ASSUME_YES=0
for arg in "${@:2}"; do
  case "$arg" in
    --deploy) DEPLOY=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
[ -n "$REMOTE" ] || { echo "usage: $0 <demo-repo-remote> [--deploy] [--yes]" >&2; exit 2; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --no-local forces a real object copy instead of the alternates/hardlink shortcut a
# same-filesystem clone would take. The sanitizer detaches from a borrowed object store anyway,
# but starting without one means the fork never shares storage with the private repository.
echo "Cloning $SRC at HEAD into $WORK/fork"
git clone --quiet --no-local "$SRC" "$WORK/fork"
cd "$WORK/fork"

./scripts/sanitize-fork.sh --fresh-history --yes

echo
echo "──────── what will be published ────────"
git show --stat --oneline HEAD | sed 's/^/  /'
echo "────────────────────────────────────────"
echo

# The scan is a backstop for the categories it knows. A new file that quotes something real
# matches no pattern and passes clean, so the diff gets read by a person before it goes anywhere.
#
# What is required is a deliberate human act, not a TTY. Demanding an interactive terminal made
# this unusable from the place it actually gets run — an agent session, where the diff above is
# printed on screen for a person to read just the same. So: prompt when there is somewhere to
# prompt, accept --yes when there is not, and refuse only when neither is true.
if [ "$ASSUME_YES" -eq 1 ]; then
  echo "--yes given: publishing the tree shown above."
elif [ -t 0 ]; then
  printf 'Push this to %s (force)? Type "publish": ' "$REMOTE"
  read -r reply
  [ "$reply" = "publish" ] || { echo "aborted."; exit 1; }
else
  echo
  echo "No terminal to ask in, and --yes was not given, so nothing was pushed." >&2
  echo "Read the file list above. If it is what you want published, re-run with --yes:" >&2
  echo "  $0 $REMOTE${DEPLOY:+ --deploy} --yes" >&2
  exit 1
fi

git remote add origin "$REMOTE"
git push --force -u origin HEAD:main

if [ "$DEPLOY" -eq 1 ]; then
  echo
  echo "Deploying the demo worker…"
  npx wrangler deploy
fi

echo
echo "Published. Verify before sharing:"
echo "  · the demo opens on the sample week, not an empty one"
echo "  · the sync indicator says it saves on this device"
echo "  · curl -sI https://<demo-host>/api/state  →  404, not 200"
