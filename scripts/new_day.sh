#!/usr/bin/env bash
# ─────────────────────────────────────────────
# 日誌ページ手動生成スクリプト
# 使い方:
#   bash scripts/new_day.sh            # 今日のページを生成
#   bash scripts/new_day.sh 20260410   # 指定日を生成
# ─────────────────────────────────────────────
set -euo pipefail

TEMPLATE="nissi/_template.html"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 引数があればその日付、なければ今日(JST)
if [ -n "${1:-}" ]; then
  DATE_KEY="$1"
  # YYYYMMDD → YYYY-MM-DD
  DATE_LABEL="${DATE_KEY:0:4}-${DATE_KEY:4:2}-${DATE_KEY:6:2}"
  Y="${DATE_KEY:0:4}"; M="${DATE_KEY:4:2}"; D="${DATE_KEY:6:2}"
  # macOS / Linux 両対応
  if date --version &>/dev/null 2>&1; then
    DOW_NUM=$(date -d "${Y}-${M}-${D}" +%u)
    PREV_KEY=$(date -d "${Y}-${M}-${D} -1 day" +%Y%m%d)
    NEXT_KEY=$(date -d "${Y}-${M}-${D} +1 day" +%Y%m%d)
  else
    DOW_NUM=$(date -jf "%Y-%m-%d" "${Y}-${M}-${D}" +%u)
    PREV_KEY=$(date -jf "%Y-%m-%d" -v-1d "${Y}-${M}-${D}" +%Y%m%d)
    NEXT_KEY=$(date -jf "%Y-%m-%d" -v+1d "${Y}-${M}-${D}" +%Y%m%d)
  fi
else
  DATE_KEY=$(TZ=Asia/Tokyo date +%Y%m%d)
  DATE_LABEL=$(TZ=Asia/Tokyo date +%Y-%m-%d)
  if date --version &>/dev/null 2>&1; then
    DOW_NUM=$(TZ=Asia/Tokyo date +%u)
    PREV_KEY=$(TZ=Asia/Tokyo date -d "yesterday" +%Y%m%d)
    NEXT_KEY=$(TZ=Asia/Tokyo date -d "tomorrow"  +%Y%m%d)
  else
    DOW_NUM=$(TZ=Asia/Tokyo date +%u)
    PREV_KEY=$(TZ=Asia/Tokyo date -v-1d +%Y%m%d)
    NEXT_KEY=$(TZ=Asia/Tokyo date -v+1d +%Y%m%d)
  fi
fi

DOW_NAMES=("" "月曜日" "火曜日" "水曜日" "木曜日" "金曜日" "土曜日" "日曜日")
DOW_JP="${DOW_NAMES[$DOW_NUM]}"

TARGET="$ROOT/nissi/${DATE_KEY}.html"

if [ -f "$TARGET" ]; then
  echo "⚠️  すでに存在します: nissi/${DATE_KEY}.html"
  exit 0
fi

sed \
  -e "s/{{DATE_KEY}}/${DATE_KEY}/g"     \
  -e "s/{{DATE_LABEL}}/${DATE_LABEL}/g" \
  -e "s/{{DOW}}/${DOW_JP}/g"            \
  -e "s/{{PREV_KEY}}/${PREV_KEY}/g"     \
  -e "s/{{NEXT_KEY}}/${NEXT_KEY}/g"     \
  "$ROOT/$TEMPLATE" > "$TARGET"

echo "✅ 生成しました: nissi/${DATE_KEY}.html"
echo "   日付: $DATE_LABEL ($DOW_JP)"
