#!/usr/bin/env bash
# publish.sh — writes the built site into the gh-pages branch without replacing anything but its own slot (run by pages.yml).
#   publish.sh main       the live site at the root; also a copy at v/<the CHANGELOG's last version, else the date and commit>/, written once and never overwritten
#   publish.sh pr <n>     a preview at preview/<n>/, replaced on each push to the pull request
#   publish.sh close <n>  the preview removed when the pull request closes
# The root's sync leaves preview/ and v/ alone; every write is a new commit on gh-pages, so nothing is lost from its history either.
set -euo pipefail
mode=$1;n=${2:-}
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
rm -rf _gh
if git ls-remote --exit-code --heads origin gh-pages >/dev/null;then
  git fetch -q --depth 1 origin gh-pages
  git worktree add -q -B gh-pages _gh FETCH_HEAD
else
  git worktree add -q --detach _gh
  (cd _gh && git checkout -q --orphan gh-pages && git rm -rfq . && git clean -fdq)
fi
touch _gh/.nojekyll
case $mode in
  main)
    rsync -a --delete --exclude .git --exclude .nojekyll --exclude preview/ --exclude v/ _site/ _gh/
    ver=$(grep -so '^## v[0-9.]*' CHANGELOG.md | tail -1 | cut -c4- || true)
    [ -n "$ver" ] || ver=$(date -u +%Y-%m-%d)-$(git rev-parse --short HEAD)
    if [ -n "$ver" ] && [ ! -d "_gh/v/$ver" ];then mkdir -p "_gh/v/$ver";cp -r _site/. "_gh/v/$ver/";fi
    msg="live: ${GITHUB_SHA:-local}${ver:+ ($ver)}";;
  pr)
    mkdir -p "_gh/preview/$n";rsync -a --delete _site/ "_gh/preview/$n/";msg="preview $n: ${GITHUB_SHA:-local}";;
  close)
    rm -rf "_gh/preview/$n";msg="preview $n removed";;
  *) echo "publish.sh: unknown mode $mode";exit 1;;
esac
cd _gh
git add -A
if git diff --cached --quiet;then echo "nothing to publish";exit 0;fi
git commit -qm "$msg"
git push -q origin gh-pages
