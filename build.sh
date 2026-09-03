#!/usr/bin/env bash
# 打包成 zip,同時供兩個用途:
#   1. 發佈到 GitHub Releases,使用者解壓後以「載入未封裝項目」手動安裝
#   2. 上傳到 Chrome Web Store 送審
# 只收錄執行時真正需要的檔案,manifest.json 位於 zip 根目錄。
# store/(商店文案與大圖)、docs/(GitHub Pages)、README 等都不會被打包。
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/ghost-job-detector-${VERSION}.zip"

rm -rf dist && mkdir -p dist
zip -r -q "$OUT" manifest.json icons src -x '*.DS_Store'

echo "已產生 $OUT"
unzip -l "$OUT"
