#!/usr/bin/env bash
# 呈折：开 PR 并**强制**埋好「回奏对」标记，返回朱批台深链。
# 存在的理由：标记这一步以前是"开完 PR 再记得 append 一行"，八折漏了三折（#11 #16 #17）。
# 文档写了照样能跳过，所以把它焊进创建动作本身。
#
#   open-folder.sh "<标题>" <body 文件>
#
# body 文件里按五段模板写，别自己加 happy-session 标记——本脚本负责。
set -euo pipefail

REPO=charliezong18/review
TITLE="${1:?用法: open-folder.sh 标题 body文件}"
BODY_FILE="${2:?缺 body 文件}"
[ -r "$BODY_FILE" ] || { echo "读不到 body 文件：$BODY_FILE" >&2; exit 1; }

LINT_CLI="$HOME/Developer/zhupi-mcp/dist/lint-cli.js"
PARITY="$HOME/Developer/zhupi-mcp/PARITY.md"

# 对账结果先攒着，**等 gh pr create 成功之后**再落盘。
# 第一轮评审抓到：原来每次 lint 调用就写一行，于是被拒的折、gh 失败后的重试
# 都进台账 —— 「连续 10 次呈折一致」变成「连续 10 行台账一致」，
# 实测 2 个折 0 个真 PR 能攒出 6 行。而那个计数支撑的是「删掉老脚本」这个不可逆决定。
PARITY_ROW=""
PARITY_NOTE=""

# 落盘。**写失败必须说出来** —— 原来是静默 return 0，而播报无条件说「已记进 PARITY.md」，
# 于是「闸门被关 + 台账不存在 + 声称已记录」三件事同时发生（评审实测）。
parity_flush() {
  [ -n "$PARITY_ROW" ] || return 0
  # `|| true` 是必须的：本脚本 set -e，而 parity_log 是 if 分支的最后一条命令，
  # 记账失败会传播成脚本退出 —— 体例已判合格却在记账这步中止，
  # 那正是「拦太死把人逼向绕过」那条教训的形状（评审实测 chmod 444 后复现）。
  # 台账末尾没有换行就先补一个 —— 上一版留下的文件正是这个状态，
  # 不补的话新行照样粘上去，等于 bug 修了但下一行还是坏的。
  # 判据用命令替换会剥尾换行这件事本身：末字节是换行 → 替换结果为空串。
  LEAD=""
  [ -s "$PARITY" ] && [ -n "$(tail -c 1 "$PARITY")" ] && LEAD=$'\n'
  if printf '%s%s\n' "$LEAD" "$PARITY_ROW" >> "$PARITY" 2>/dev/null; then
    [ -n "$PARITY_NOTE" ] && echo "$PARITY_NOTE" >&2
  else
    echo "⚠️  对账结果**没记上**（写不了 ${PARITY}）—— 退休计数会停在原地，不是虚增" >&2
  fi
  return 0
}
parity_row() {
  # **换行必须在 flush 时补，不能指望这里的 `\n` 活下来** ——
  # `$(...)` 命令替换会剥掉尾部换行，而 parity_flush 用的是 `printf '%s'`（不补换行），
  # 于是第二行起全部粘到上一行末尾。实测后果：#34 #35 两次真呈折在台账上是一行，
  # `parity.ts` 的 `/^\|\s*\d{4}-/` 只认行首那条 → 「连续一致」少算一半，
  # 而这个计数支撑的是「删掉 folder-lint.sh」这个不可逆决定（2026-07-30 查出）。
  PARITY_ROW="$(printf '| %s | %s | %s | %s | %s |' "$(date -u +%Y-%m-%dT%H:%MZ)" "${3:-?}" "${1:-?}" "${2:-?}" "$4")"
}

# 中止路径也要 flush —— 但记成「呈折中止」，不进连续计数。
# 不记的话「老 lint 拦了我 5 次」这件事在台账上完全看不见。
abort_flush() {
  [ -n "$PARITY_ROW" ] || return 0
  # **重新拼一整行**，别拿 ${PARITY_ROW%%|*} 去截 —— 行首就是 `|`，
  # 那个前缀是空串，写出来是 4 格无时间戳的畸形行，`parity.ts` 的
  # `/^\|\s*\d{4}-/` 永远匹配不到 → 这行对唯一的读者完全不可见，
  # 而 abort_flush 声称要解决的正是「老 lint 拦了我 5 次在台账上看不见」（第二轮评审实测）。
  parity_row "-" "-" "中止" "呈折中止（不计入）"
  parity_flush
}

# 体例闸门：不合格不许呈。SKIP_LINT=1 可强开，但那等于自愿放弃这道保险。
if [ "${SKIP_LINT:-0}" != "1" ]; then
  echo "── 体例检查 ──"
  # 闸门脚本本身不见了要单独说。bash 3.2 在 set -e 下把 127/126 折成 1，
  # 与「体例不合格」完全同形，而提示语是「修完再来」（评审实测）。
  OLDLINT="$(dirname "$0")/folder-lint.sh"
  [ -x "$OLDLINT" ] || { echo "闸门脚本不见了或不可执行：$OLDLINT" >&2; exit 2; }

  # Phase 2 起新旧并行跑对账（design D1）。**必须用 `|| OLD=$?` 而不是 `; OLD=$?`**：
  # 本脚本是 set -euo pipefail，后者会在老 lint 失败时直接掐死呈折、新 lint 一个字都不出
  # —— 一个 fail-closed 且静默的漏执行，正是这个项目反复栽的那一类（设计评审抓到）。
  OLD=0; "$OLDLINT" . || OLD=$?

  if [ -f "$LINT_CLI" ]; then
    echo "── 新 lint（对账用，暂不作准）──"
    NEW=0; node "$LINT_CLI" . --body-file "$BODY_FILE" || NEW=$?
    # **花括号是必须的。** `${NEW}）` 里的全角括号会被 bash 当成变量名的一部分，
    # 于是未绑定 + set -u = 当场退出，那句警告一个字都不打（评审实测）。
    # 老脚本 folder-lint.sh:58 正栽在同一个坑上，导致「缺中文版」这条规则从未生效过。
    if [ "$NEW" -ge 2 ]; then
      # 2 = 工具跑不起来，127 = 没有 node。**这不是「结论分歧」** ——
      # 把环境故障记成分歧会白白重置退休计数，还会让人去追一个不存在的规则差异。
      echo "  ⚠ 新 lint 没跑起来（退出码 ${NEW}）—— 不计入对账" >&2
      parity_row "$OLD" "$NEW" "-" "新 lint 未成功（不计入）"
    elif [ "$OLD" -eq "$NEW" ]; then
      parity_row "$OLD" "$NEW" "-" "退出码一致"
    else
      echo "  ⚠ 新旧 lint 退出码不一致（旧 ${OLD} / 新 ${NEW}）—— 请看上面两段输出" >&2
      parity_row "$OLD" "$NEW" "-" "**不一致**"
    fi
    # 这里只记退出码。**退出码一致 ≠ 结论一致**（都报错但报的是不同的错），
    # 集合级对账在 `npm run differential`（zhupi-mcp）里做 —— 归一化逻辑只许有一份，
    # 在这儿再写一遍就是「又造一个会漂的副本」，那正是这个项目反复反对的。
    echo
  else
    # 静默消失也要说。原来 -f 为假时整段新 lint 无声无息，
    # 于是对账窗口可能是 0 长度而人以为在攒数据（git clean / 新 clone 未 build 都会触发）。
    echo "  ⚠ 新 lint 没构建（$LINT_CLI 不存在）—— 本折不进对账" >&2
    parity_row "$OLD" "-" "-" "新 lint 未构建（不计入）"
  fi

  # **对账窗口内以老的为准。** 并行的全部理由是观察新实现的回归，而观察收益两个方向
  # 都拿得到；把新的设为权威只是单方面加风险（设计评审指出 v1 写反了）。
  #
  # 已知例外（第一轮评审）：老脚本 folder-lint.sh:58 的 `${ZH}（` 是 bash 未绑定变量，
  # set -u 下让子 shell 当场死掉 —— 所以它对「缺中文版」这一类**从来没生效过**。
  # 这类折现在照样呈得上去。以老为准在这一条上是错的，但改老脚本属于动闸门本身，
  # 已记进 zhupi-mcp/BACKLOG。
  [ "$OLD" -eq 0 ] || {
    abort_flush
    echo "呈折已中止（旧 lint 判不合格）。修完再来，或 SKIP_LINT=1 强开（不建议）。" >&2; exit 1; }
  echo
else
  # SKIP_LINT 是个无条件、无日志的完整关闸开关。留着它（「拦太死把人逼向绕过」那条教训），
  # 但**让它可见**：记一行 + 播报一句（design D8）。
  PARITY_NOTE="⚠️  SKIP_LINT=1 —— 这一折跳过了体例检查，已记进 PARITY.md"
  parity_row "-" "-" "-" "SKIP_LINT 跳过"
fi

TMP=$(mktemp) && trap 'rm -f "$TMP"' EXIT
cat "$BODY_FILE" > "$TMP"

# body 五段模板缺项也拦（缺「待你拍板」他就不知道要拍什么）
for sec in 目的地 直达链 TLDR 待你拍板 怎么用; do
  grep -q "$sec" "$TMP" || echo "⚠️  body 里没找到「${sec}」段" >&2
done

# 标记拿不到就省掉（没跑在 Happy 里），按钮不出现而已——绝不编一个 id
if SID=$("$(dirname "$0")/happy-session-id.sh" 2>/dev/null) && [ -n "$SID" ]; then
  printf '\n<!-- happy-session: %s -->\n' "$SID" >> "$TMP"
else
  echo "⚠️  拿不到 happy session id，本折不埋「回奏对」标记" >&2
fi

URL=$(gh pr create -R "$REPO" --title "$TITLE" --body-file "$TMP")
N=${URL##*/}

# **台账在这里落盘，不在 lint 之后。** 判据是「连续 10 次呈折一致」，
# 而被拒的折、gh 失败后的重试都不是「一次呈折」——
# 原来在 lint 那步就写，实测 2 个折 0 个真 PR 能攒出 6 行（第一轮评审）。
# 折号也写进去：不带折号的台账事后无法辨认是哪一折。
PARITY_ROW=${PARITY_ROW/| - |/| #$N |}
parity_flush

# 自核：标记真的落进去了才算数（gh 有过静默吞 body 的先例）
if [ -n "${SID:-}" ] && ! gh api "repos/$REPO/pulls/$N" --jq .body | grep -q "happy-session: $SID"; then
  echo "⚠️  标记没落进 #$N 的 body，手动补：gh pr edit $N -R $REPO --body-file <(...)" >&2
fi

echo "$URL"
echo "朱批台深链：https://charliezong18.github.io/zhupi/?pr=$N"
