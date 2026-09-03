#!/usr/bin/env bash
# 打包成可發佈到 GitHub Releases 的 zip。
# 只收錄執行時真正需要的檔案,manifest.json 位於 zip 根目錄,解壓後可直接載入。
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/ghost-job-detector-${VERSION}.zip"

rm -rf dist && mkdir -p dist
zip -r -q "$OUT" manifest.json icons src -x '*.DS_Store'

echo "已產生 $OUT"
unzip -l "$OUT"
