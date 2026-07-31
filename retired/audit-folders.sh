#!/usr/bin/env bash
# 存量巡检：扫所有 open 的奏折，报体例缺口。
#
#   audit-folders.sh          只报告
#   audit-folders.sh --fix    顺手补能机械补的（回奏对标记、draft 转正）；体例问题只报不补
#
# 体例那部分**调 zhupi-mcp 的 lint-cli**，与呈折闸门共用同一个核（需求 R7）。
# 这里只保留它独有的两项：回奏对标记、draft 状态 —— 那两项要打网络，不在核里。
#
# 2026-07-28 立此：八折里三折缺「回奏对」标记、十一篇缺双语对，全是漏执行。
set -uo pipefail

REPO=charliezong18/review
LINT_CLI="$HOME/Developer/zhupi-mcp/dist/lint-cli.js"
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
SID=$("$(dirname "$0")/happy-session-id.sh" 2>/dev/null || true)

cd "$(git -C ~/Developer/review rev-parse --show-toplevel 2>/dev/null || echo ~/Developer/review)" || exit 1
git fetch -q origin 2>/dev/null || true

for n in $(gh pr list -R "$REPO" --state open --json number --jq '.[].number' | sort -n); do
  meta=$(gh pr view "$n" -R "$REPO" --json headRefName,isDraft,title,body)
  br=$(printf '%s' "$meta" | python3 -c 'import json,sys;print(json.load(sys.stdin)["headRefName"])')
  draft=$(printf '%s' "$meta" | python3 -c 'import json,sys;print(json.load(sys.stdin)["isDraft"])')
  title=$(printf '%s' "$meta" | python3 -c 'import json,sys;print(json.load(sys.stdin)["title"])')
  body=$(printf '%s' "$meta" | python3 -c 'import json,sys;print(json.load(sys.stdin)["body"] or "")')

  echo "── #$n $title"
  problems=0

  # 1. 回奏对标记
  if printf '%s' "$body" | grep -q 'happy-session:'; then
    echo "   ✓ 回奏对标记"
  else
    problems=1
    if [ $FIX -eq 1 ] && [ -n "$SID" ]; then
      printf '%s\n\n<!-- happy-session: %s -->\n' "$body" "$SID" > /tmp/audit-body.$$
      gh pr edit "$n" -R "$REPO" --body-file /tmp/audit-body.$$ >/dev/null && echo "   ✚ 已补回奏对标记（指向当前会话）"
      rm -f /tmp/audit-body.$$
    else
      echo "   ✗ 缺回奏对标记"
    fi
  fi

  # 2. draft
  if [ "$draft" = "True" ]; then
    problems=1
    if [ $FIX -eq 1 ]; then gh pr ready "$n" -R "$REPO" >/dev/null && echo "   ✚ 已转正（draft 挡住钦此）"
    else echo "   ✗ 还是 draft（挡住钦此的 squash merge）"; fi
  fi

  # 3. 体例：**调新核**，别手搓（需求 R7：同一个折两边判定必须一致）
  #
  # 上一版这里手搓双语检查，实测三个后果（第三轮评审）：
  #   ① 与呈折闸门给出不同结论 —— #12 巡检说「合体例」，lint 说两条硬伤
  #   ② 没带 core.quotePath=false，中文名文件拿到八进制转义路径，
  #      `grep -qx "$zh"` 里的 \345 被 grep 当反向引用直接报错 ——
  #      #31 那 22 条是**靠 grep 报错碰巧蒙对**的，不是查出来的，
  #      而且输出给人看的是 `guanzhi-00-\345\221\210...md"`，没法照着修
  #   ③ `case "$f" in *.zh-CN.md) continue` 直接跳过中文版，
  #      所以「有中文版、缺英文版」它永远发现不了
  if [ -f "$LINT_CLI" ]; then
    lint_out=$(node "$LINT_CLI" . --ref "origin/$br" --base origin/main 2>&1) && lint_rc=0 || lint_rc=$?
    if [ "$lint_rc" -ge 2 ]; then
      echo "   ⚠ 体例检查没跑起来：$lint_out"
    elif [ "$lint_rc" -eq 1 ]; then
      printf '%s\n' "$lint_out" | grep -E '✗|⚠' | sed 's/^/   /'
      problems=1
    else
      printf '%s\n' "$lint_out" | grep -E '⚠' | sed 's/^/   /' || true
      echo "   ✓ 体例"
    fi
  else
    echo "   ⚠ 体例检查跳过（$LINT_CLI 没构建）—— 巡检结果不完整"
  fi

  [ $problems -eq 0 ] && echo "   合体例。"
done
