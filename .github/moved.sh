#!/usr/bin/env bash
# moved.sh — the old site after the move (run by pages.yml on main): every old address sends you to the same place on
# the new site.
#   moved.sh <old path> <new url>     e.g. moved.sh /Tethys/ https://william-are-buzbee.github.io/Game-Template-and-Library/games/tethys/
# index.html and 404.html (which Pages serves for any address that is not a file) are .github/moved.html. Everything
# else at the root goes; the kept copies (v/) and old previews (preview/, pr-preview/) stay as they were. Every write is a
# new commit on gh-pages, so the old site is still in its history.
set -euo pipefail
old=$1;new=$2
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
rm -rf _gh
git fetch -q --depth 1 origin gh-pages
git worktree add -q -B gh-pages _gh FETCH_HEAD
page=$(sed -e "s#__OLD__#$old#g" -e "s#__NEW__#$new#g" .github/moved.html)
cd _gh
git ls-files -z | grep -zvE '^(\.nojekyll|v/|preview/|pr-preview/)' | xargs -0 -r git rm -q --
printf '%s\n' "$page" > index.html
printf '%s\n' "$page" > 404.html
touch .nojekyll
git add -A
if git diff --cached --quiet;then echo "nothing to publish";exit 0;fi
git commit -qm "moved: every address now goes to $new"
git push -q origin gh-pages
