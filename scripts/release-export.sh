#!/usr/bin/env bash
# 每日导出资产：把导出目录打成 community-export-<date>.tar.zst（没有 zstd 就 .tar.gz），
# `gh release create data-<date>` 挂上；release 已存在则 `gh release upload --clobber`。
# 用法：bash scripts/release-export.sh <export-dir>；环境 GH_TOKEN、GH_REPO（gh 自己读）。
set -euo pipefail
dir="${1:-export/v1}"
if [ ! -f "$dir/manifest.json" ]; then echo "❌ $dir 里没有 manifest.json" >&2; exit 1; fi
date="$(date -u +%Y-%m-%d)"
tag="data-$date"
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
notes="社区标注导出（CC0 1.0）· $date · $(basename "$asset") · sha256 $sha
Community annotation export (CC0 1.0). Read it with scholar-meta's readCommunityExport; verify shard hashes against manifest.json."
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$asset" "$asset.sha256" --clobber
else
  gh release create "$tag" "$asset" "$asset.sha256" --title "Community export $date" --notes "$notes"
fi
echo "✅ $tag ← $(basename "$asset")"
