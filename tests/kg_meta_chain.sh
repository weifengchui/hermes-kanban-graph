#!/usr/bin/env bash
# kg_meta_chain.sh — Board+ 全链 headless 元校验（15 件，2026-10-21 v23 收尾重建）
# 输出与 /tmp/kg_meta_final*.log 同型：每支一行 "== 名称 <结果>"，FAIL 明细内联。
# 纪律：跑链期间禁改产品/探针；本轮日志头部带活体 dist 的 md5 字节证物。
set -u
S=/home/yxf/.hermes/profiles/liteguard/scripts
D=/home/yxf/.hermes/profiles/liteguard/plugins/kanban-graph/dashboard
PY=/home/yxf/.venvs/imgtools/bin/python
export HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright
LOG=${1:-/tmp/kg_meta_v20.log}
{
  echo "META-CHAIN start $(date '+%F %T')"
  echo "dist md5: $(md5sum $D/dist/index.js)"
  echo "live==dist: $($PY $S/kg_live_check.py 2>&1 | tail -1)"
} > "$LOG"
run1() {
  local name=$1
  local out=/tmp/kgmc_${name}.out
  if $PY "$S/$name" > "$out" 2>&1; then
    line=$(grep -E "ALL PASS" "$out" | tail -1)
    echo "== $name ${line:-EXIT-0 (no ALL PASS line!)}" >> "$LOG"
  else
    echo "== $name FAILURES:" >> "$LOG"
    grep -E "^FAIL" "$out" | head -8 >> "$LOG"
    tail -3 "$out" | grep -vE "^FAIL" >> "$LOG" || true
  fi
  # probe died without printing any verdict = early-death, flag loudly
  grep -qE "ALL PASS|^FAIL" "$out" || echo "   !! $name produced no verdict (early death?)" >> "$LOG"
}
for p in kg_multi_hl.py kg_v7_hl.py kg_v8_hl.py kg_v9_hl.py kg_v10_hl.py kg_v12_hl.py kg_v13_hl.py kg_v14_hl.py kg_v15_hl.py kg_v16_hl.py kg_v17_hl.py kg_v18_hl.py _kg_compat_probe.py kg_v20_hl.py kg_v23_hl.py; do
  run1 "$p"
done
# [14] text/measure probe — known exit glitch: one retry, judge by conclusions
tout=/tmp/kgmc_text.out
$PY "$S/_kg_text_probe.py" > "$tout" 2>&1 || $PY "$S/_kg_text_probe.py" > "$tout" 2>&1
if grep -qE "OVERFLOW|FAIL" "$tout"; then
  echo "== _kg_text_probe.py FAILURES:" >> "$LOG"; grep -E "OVERFLOW|FAIL" "$tout" | head -6 >> "$LOG"
else
  echo "== _kg_text_probe.py OK $(grep -E 'fill|PASS' "$tout" | tail -1)" >> "$LOG"
fi
echo "META-CHAIN done $(date '+%F %T')" >> "$LOG"
echo DONE-META-V20 >> "$LOG"
tail -40 "$LOG"
