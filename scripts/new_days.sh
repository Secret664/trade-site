#!/usr/bin/env bash
# ─────────────────────────────────────────────
# 日誌ページ生成スクリプト【完全版】
#
# ■ 使い方
# 単日:
#   bash scripts/new_days.sh 20260413
#
# 範囲:
#   bash scripts/new_days.sh 20260413 20260417
#
# 今日:
#   bash scripts/new_days.sh
#
# Git自動化:
#   AUTO_GIT=1 bash scripts/new_days.sh 20260413 20260417
# ─────────────────────────────────────────────

set -euo pipefail

TEMPLATE="nissi/_template.html"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

generate_day() {
  DATE_KEY="$1"

  DATE_LABEL="${DATE_KEY:0:4}-${DATE_KEY:4:2}-${DATE_KEY:6:2}"
  Y="${DATE_KEY:0:4}"; M="${DATE_KEY:4:2}"; D="${DATE_KEY:6:2}"

  if date --version &>/dev/null 2>&1; then
    DOW_NUM=$(date -d "${Y}-${M}-${D}" +%u)
    PREV_KEY=$(date -d "${Y}-${M}-${D} -1 day" +%Y%m%d)
    NEXT_KEY=$(date -d "${Y}-${M}-${D} +1 day" +%Y%m%d)
  else
    DOW_NUM=$(date -jf "%Y-%m-%d" "${Y}-${M}-${D}" +%u)
    PREV_KEY=$(date -jf "%Y-%m-%d" -v-1d "${Y}-${M}-${D}" +%Y%m%d)
    NEXT_KEY=$(date -jf "%Y-%m-%d" -v+1d "${Y}-${M}-${D}" +%Y%m%d)
  fi

  DOW_NAMES=("" "月曜日" "火曜日" "水曜日" "木曜日" "金曜日" "土曜日" "日曜日")
  DOW_JP="${DOW_NAMES[$DOW_NUM]}"

  TARGET="$ROOT/nissi/${DATE_KEY}.html"

  if [ -f "$TARGET" ]; then
    echo "⚠️  スキップ（既存）: ${DATE_KEY}"
    return
  fi

  sed \
    -e "s/{{DATE_KEY}}/${DATE_KEY}/g" \
    -e "s/{{DATE_LABEL}}/${DATE_LABEL}/g" \
    -e "s/{{DOW}}/${DOW_JP}/g" \
    -e "s/{{PREV_KEY}}/${PREV_KEY}/g" \
    -e "s/{{NEXT_KEY}}/${NEXT_KEY}/g" \
    "$ROOT/$TEMPLATE" > "$TARGET"

  echo "✅ 生成: ${DATE_KEY} (${DOW_JP})"
}

# ─────────────────────────────────────────────
# メイン処理
# ─────────────────────────────────────────────

# 引数なし → 今日
if [ -z "${1:-}" ]; then
  TODAY=$(TZ=Asia/Tokyo date +%Y%m%d)
  generate_day "$TODAY"

# 単日
elif [ -z "${2:-}" ]; then
  generate_day "$1"

# 範囲
else
  START="$1"
  END="$2"

  CURRENT="$START"

  while [ "$CURRENT" -le "$END" ]; do
    generate_day "$CURRENT"

    if date --version &>/dev/null 2>&1; then
      CURRENT=$(date -d "${CURRENT:0:4}-${CURRENT:4:2}-${CURRENT:6:2} +1 day" +%Y%m%d)
    else
      CURRENT=$(date -jf "%Y%m%d" "$CURRENT" -v+1d +%Y%m%d)
    fi
  done
fi

# ─────────────────────────────────────────────
# Git自動化（任意）
# ─────────────────────────────────────────────
if [ "${AUTO_GIT:-0}" = "1" ]; then
  echo "🚀 Git自動実行..."

  cd "$ROOT"

  git add nissi/

  if git diff --cached --quiet; then
    echo "⚠️  変更なし（コミットスキップ）"
  else
    MSG="日誌追加: ${1:-today}"
    if [ -n "${2:-}" ]; then
      MSG="日誌追加: ${1}〜${2}"
    fi

    git commit -m "$MSG"
    git push

    echo "✅ Git push 完了"
  fi
fi
