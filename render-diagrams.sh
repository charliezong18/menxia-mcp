#!/usr/bin/env bash
# 把 assets/*.mmd 渲染成同名 .png。
#
# 为什么要提交渲染结果而不是只留源：**朱批台不渲染 mermaid**。
# 它的渲染器是裸 markdown-it 且 html:false——mermaid 代码块会显示成源码，
# 内嵌 <svg>/<img> 会被转义。图片是唯一两边都能看的形态
# （zhupi 的 hydrateRelativeImages 走 Contents API 换 blob URL，私有仓专门做的）。
#
# 代价要知道：**图片不能划句批注**。所以只有本质是视觉的结构才画图，
# 需要逐句拍板的内容仍然用文字和表格。
set -euo pipefail
cd "$(dirname "$0")"

MMDC=node_modules/.bin/mmdc
[ -x "$MMDC" ] || { echo "缺 mermaid-cli：npm i -D @mermaid-js/mermaid-cli" >&2; exit 1; }

shopt -s nullglob
n=0
for f in assets/*.mmd; do
  out="${f%.mmd}.png"
  printf '  %s → %s ... ' "$f" "$out"
  "$MMDC" -i "$f" -o "$out" -b white -s 3 --quiet
  printf 'ok (%s)\n' "$(du -h "$out" | cut -f1 | tr -d ' ')"
  n=$((n+1))
done
[ "$n" -gt 0 ] && echo "渲染 $n 张。" || echo "assets/ 下没有 .mmd。"
