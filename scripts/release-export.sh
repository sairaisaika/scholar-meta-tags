#!/usr/bin/env bash
# 每日导出存档：把导出目录打成 community-export-<date>.tar.zst（没有 zstd 就 .tar.gz），`gh release create data-<date>` 挂上。
# 当天的存档已存在就跳过（每天第一次运行的那份留作当天的存档）；设了 ARCHIVE_FORCE 才覆盖。
# 发布说明里带账本摘要（ledger.json 的 digest 与断言条数）：任何一天的存档都能回答「那天的账本是什么」。
# 用法：bash scripts/release-export.sh <export-dir>；环境 GH_TOKEN、GH_REPO（gh 自己读），可选 ARCHIVE_FORCE=1。
set -euo pipefail
dir="${1:-export/v1}"
if [ ! -f "$dir/manifest.json" ]; then echo "❌ $dir 里没有 manifest.json" >&2; exit 1; fi
date="$(date -u +%Y-%m-%d)"
tag="data-$date"
if [ -z "${ARCHIVE_FORCE:-}" ] && gh release view "$tag" >/dev/null 2>&1; then
  echo "ℹ️ $tag 已有存档，跳过"; exit 0
fi
tmp="$(mktemp -d)"
if command -v zstd >/dev/null 2>&1; then
  asset="$tmp/community-export-$date.tar.zst"
  tar -C "$dir" -cf - . | zstd -19 -q -o "$asset"
else
  asset="$tmp/community-export-$date.tar.gz"
  tar -C "$dir" -czf "$asset" .
fi
sha="$(sha256sum "$asset" | cut -d' ' -f1)"
echo "$sha  $(basename "$asset")" > "$asset.sha256"
ledger="$(node -e "try{const l=require(require('path').resolve(process.argv[1],'ledger.json'));process.stdout.write(l.assertions+' assertions · ledger digest '+l.digest)}catch{process.stdout.write('ledger.json missing')}" "$dir")"
notes="社区标注导出（CC0 1.0）· $date · $(basename "$asset") · sha256 $sha
$ledger
Community annotation export (CC0 1.0). Read it with scholar-meta's readCommunityExport; verify shard hashes against manifest.json."
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$asset" "$asset.sha256" --clobber
  gh release edit "$tag" --notes "$notes"   # 覆盖时说明里的哈希与账本摘要也跟着换
else
  gh release create "$tag" "$asset" "$asset.sha256" --title "Community export $date" --notes "$notes"
fi
echo "✅ $tag ← $(basename "$asset")"
