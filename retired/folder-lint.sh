#!/usr/bin/env bash
# 奏折体例检查（input model v1）。在奏折仓的工作树里跑，检查本分支相对 origin/main 的新增/修改文档。
#
#   folder-lint.sh [工作树路径]
#
# 退出码 0 = 合体例，1 = 有硬伤（open-folder.sh 据此拒绝呈折）。
# 立此闸的原因：体例写在 SKILL.md 里靠自觉执行，实测八折漏了三折的「回奏对」标记、
# 十一篇缺双语对、四个分支没从最新 main 切。文档提醒治不了漏执行，只有闸门能。
#
# 注意：macOS 自带 bash 是 3.2，没有 mapfile 也没有关联数组——本脚本刻意只用可移植写法。
#
# **变量名后紧跟非 ASCII 字符时必须加花括号**（`${ZH}（` 不能写成 `$ZH（`）。
# UTF-8 locale 下 bash 把全角括号的字节算进标识符 → 未绑定变量 → set -u 让子 shell
# 当场死掉，`FAIL` 保持 0，于是**整个脚本打印「体例合格」并 exit 0**。
# 2026-07-30 实测：第 58 行栽在这上面，所以「缺中文版」这一整类从上线起就没拦住过，
# 而呈折闸门正是以本脚本为准。LC_ALL=C 下不复现 —— 这大概就是它一直没被发现的原因。
set -uo pipefail

WT="${1:-.}"
cd "$WT" || { echo "进不去工作树：$WT" >&2; exit 1; }

FAIL=0
bad() { printf '  ✗ %s\n' "$1"; FAIL=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

git rev-parse --git-dir >/dev/null 2>&1 || { echo "不是 git 工作树" >&2; exit 1; }
git fetch -q origin 2>/dev/null || true

# ── 1. 分支基点（警告，不阻断）────────────────────────────────
# squash merge 只应用三点 diff，所以「落后 main」本身无害，不当硬伤——
# 阻断会把人逼向绕过闸门（pre-push 那次的教训）。真正的病是「从别的未合分支切」，
# 它的症状是下面第 2 条：本折 diff 里冒出别人的文档。
BASE=$(git merge-base origin/main HEAD)
HEADMAIN=$(git rev-parse origin/main)
echo "分支基点"
if [ "$BASE" = "$HEADMAIN" ]; then
  ok "从最新 main 切出"
else
  printf '  ⚠ 落后 main %s 个提交（不阻断；但下面文档清单里若有不属于本折的，就是从别的分支切的）\n' \
    "$(git rev-list --count "$BASE".."$HEADMAIN")"
fi

# ── 2. 本分支动过的文档 ──────────────────────────────────────
CHANGED=$(git diff --name-only "origin/main...HEAD" -- 'docs/*.md' | sort)
N=$(printf '%s\n' "$CHANGED" | grep -c . || true)
echo "本折文档（$N 个）"
if [ "$N" -eq 0 ]; then bad "相对 main 没有任何 docs/*.md 改动"; echo; echo "体例不合格。"; exit 1; fi

# 改动 main 上已有文档 = 要么是修订，要么是从别人未合分支切来的夹带。让 agent 必须看见。
for f in $CHANGED; do
  git cat-file -e "origin/main:$f" 2>/dev/null && \
    printf '  ⚠ %s 已在 main 上——若不是本折要修订的，说明分支切错了地方\n' "$(basename "$f")"
done

SLUGS=$(printf '%s\n' "$CHANGED" | sed 's/\.zh-CN\.md$//; s/\.md$//' | sort -u)

printf '%s\n' "$SLUGS" | while IFS= read -r s; do
  [ -z "$s" ] && continue
  EN="$s.md"; ZH="$s.zh-CN.md"; base=$(basename "$s")
  # ── 3. 双语对必须齐 ──
  if [ -f "$EN" ] && [ -f "$ZH" ]; then
    ok "$base 双语齐"
  elif [ -f "$EN" ]; then
    bad "$base 缺中文版 ${ZH}（.md 放英文，.zh-CN.md 放中文）"; continue
  else
    bad "$base 缺英文版 $EN"; continue
  fi
  # ── 4. 互链头（zhupi 的语言切页按它认对子）──
  # 例外：docs/.payload 里登记的「文件即待发正文」，加互链头会把那行一起贴进 issue，
  # 所以英文版保持纯净；代价是它在 zhupi 里切不了语言，由中文版的横幅兜底。
  if grep -qxF "$EN" docs/.payload 2>/dev/null || grep -qxF "$EN" .payload 2>/dev/null; then
    ok "$base 英文版登记为待发正文，免互链头"
    grep -q "不要从本页复制" "$ZH" || bad "$base 中文版缺「勿从本页复制」横幅（待发正文的双语必须有）"
  else
    head -1 "$EN" | grep -q "^\*\*English\*\* · \[中文\]($base\.zh-CN\.md)$" \
      || bad "$base 英文版首行互链头不对，应为：**English** · [中文]($base.zh-CN.md)"
  fi
  head -1 "$ZH" | grep -q "^\[English\]($base\.md) · \*\*中文\*\*$" \
    || bad "$base 中文版首行互链头不对，应为：[English]($base.md) · **中文**"
done > /tmp/folder-lint-docs.$$ 2>&1
cat /tmp/folder-lint-docs.$$
grep -q '✗' /tmp/folder-lint-docs.$$ && FAIL=1
rm -f /tmp/folder-lint-docs.$$

# ── 5. 引用的图必须真在仓里（他读到断图栽过一次）──
echo "图片引用"
MISS=0
for f in $CHANGED; do
  [ -f "$f" ] || continue
  grep -oE '\]\(assets/[^)]+\)' "$f" 2>/dev/null | sed 's/^](//; s/)$//' | sort -u | while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    [ -f "docs/$ref" ] || echo "MISSING $ref"
  done
done > /tmp/folder-lint-img.$$
if [ -s /tmp/folder-lint-img.$$ ]; then
  sort -u /tmp/folder-lint-img.$$ | while IFS= read -r m; do printf '  ✗ 断图：%s\n' "${m#MISSING }"; done
  MISS=1; FAIL=1
fi
rm -f /tmp/folder-lint-img.$$
[ $MISS -eq 0 ] && ok "无断图"

echo
if [ $FAIL -eq 0 ]; then echo "体例合格。"; else echo "体例不合格 —— 按上面的 ✗ 修完再呈。"; fi
exit $FAIL
