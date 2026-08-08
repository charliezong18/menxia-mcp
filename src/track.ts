// 折务追踪（review #61 批定，2026-07-31）：词表常量 + 关系标记 + 巡检分析。
//
// **词表常量单点定义在这里。** 门下阅读器只认前缀（proj: / kind: / wait:），
// 不硬编码取值全集 —— 改名的教训（#54）：跨系统契约是裸字符串，两头写死必静默失效。
//
// 这个文件是**纯逻辑**：不碰网络、不碰 fs。贴 label 的编排在 submit.ts —— 与 body.ts
// 「body 是个字符串，直接交给 Octokit」同一个理由：纯的部分才测得动。

import { ZhupiFailure } from './errors.js';

export const PROJ_PREFIX = 'proj:';
export const KIND_PREFIX = 'kind:';
export const WAIT_PREFIX = 'wait:';
export const QIAN_PREFIX = '签:';

export const KIND_VALUES = ['拍板', '评审', '设计', '读物', '交付', '参考'] as const;
export const WAIT_VALUES = ['你拍', '你读', 'agent', '闲'] as const;
// 签 = 主题归堆（跨项目、跨状态同架）。**初始集不是枚举**：proj/kind/wait 三类值是封闭的，
// 签是开放的 —— 新签照建照贴，只在既不在初始七签、也不在仓里已有 签: label 时出 warning
// （unknownQian）。这七个是种子，防手滑打错字，不是白名单。
export const QIAN_VALUES = ['旅行', '开发', '身份', '工作', '健康', '钱', '文史'] as const;
export type Kind = (typeof KIND_VALUES)[number];
export type Wait = (typeof WAIT_VALUES)[number];

// T3 首用（2026-07-31）定的色。wait 是红绿灯（阅读器直接用 label 颜色，零映射表）；
// kind 全走一个淡蓝（区分靠字）；proj 一项目一色，新项目落 DEFAULT_PROJ_COLOR。
export const LABEL_COLORS: Readonly<Record<string, string>> = {
  'proj:zhongshumenxia': '5319E7',
  'proj:menxia': '006B75',
  'proj:niw': 'D93F0B',
  'proj:guanzhi': 'A2845E',
  'kind:拍板': 'C5DEF5',
  'kind:评审': 'C5DEF5',
  'kind:设计': 'C5DEF5',
  'kind:读物': 'C5DEF5',
  'kind:交付': 'C5DEF5',
  'kind:参考': 'C5DEF5',
  'wait:你拍': 'D73A4A',
  'wait:你读': 'FBCA04',
  'wait:agent': '0075CA',
  'wait:闲': 'EDEDED',
  // 签家族统一一个紫（区分靠字，与 kind 全走一个淡蓝同理）。种子七签列在这里；
  // 开放集里的新签靠下面 labelColor 的前缀兜底也落这个紫，全家族一个颜色。
  '签:旅行': '5319E7',
  '签:开发': '5319E7',
  '签:身份': '5319E7',
  '签:工作': '5319E7',
  '签:健康': '5319E7',
  '签:钱': '5319E7',
  '签:文史': '5319E7',
};
export const DEFAULT_PROJ_COLOR = 'BFD4F2';
export const QIAN_COLOR = '5319E7';

export const labelColor = (name: string): string =>
  LABEL_COLORS[name] ??
  (name.startsWith(PROJ_PREFIX) ? DEFAULT_PROJ_COLOR : name.startsWith(QIAN_PREFIX) ? QIAN_COLOR : 'EDEDED');

export const labelDesc = (name: string): string => {
  if (name.startsWith(PROJ_PREFIX)) return `项目：${name.slice(PROJ_PREFIX.length)}`;
  if (name.startsWith(KIND_PREFIX)) return `主用途：${name.slice(KIND_PREFIX.length)}`;
  if (name.startsWith(WAIT_PREFIX)) return `等：${name.slice(WAIT_PREFIX.length)}`;
  if (name.startsWith(QIAN_PREFIX)) return `签：${name.slice(QIAN_PREFIX.length)}（主题归堆）`;
  return '';
};

/** 校验后的 track。proj 恒为数组（≥1），wait 恒有值（缺省时按规则推出来），qian 恒为数组（可空）。 */
export interface TrackInput {
  proj: string[];
  kind: Kind;
  wait: Wait;
  qian: string[];
  needs: number[];
  supersedes: number[];
  unblocks?: string;
}

// proj slug 与分支名同一个字形世界：小写字母数字连字符。中文/大写直接拒 ——
// label 是跨系统裸字符串，「proj:门下」和「proj:menxia」并存就是两个项目。
const PROJ_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const intList = (raw: unknown, field: string): number[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.${field} 得是折号数组，收到 ${JSON.stringify(raw)}` });
  }
  const bad = raw.filter((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 1_000_000);
  if (bad.length > 0) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.${field} 得是正整数折号（≤ 1000000），收到 ${JSON.stringify(bad)}` });
  }
  return [...new Set(raw as number[])];
};

// 签值是**开放集**：不校验取值（没有白名单），只 trim、去空、去重。string 归一成单元素数组，
// 与 proj 同一个入参形状。非 string 元素直接拒 —— 与 proj 拒非法元素同一个理由（裸字符串契约）。
const qianList = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list)) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.qian 得是签名（string 或 string[]），收到 ${JSON.stringify(raw)}` });
  }
  const bad = list.filter((x) => typeof x !== 'string');
  if (bad.length > 0) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.qian 的每一项都得是字符串，收到 ${JSON.stringify(bad)}` });
  }
  return [...new Set((list as string[]).map((s) => s.trim()).filter((s) => s.length > 0))];
};

/**
 * 校验 + 补全。**wait 缺省不是恒定值，按折的内容推**（#61 §3.1）：
 * 有「待你拍板」段 → 你拍；读物 → 闲；其余 → 你读。显式给的 wait 永远赢。
 */
export function validateTrack(raw: Record<string, unknown>, body: { decisions?: string }): TrackInput {
  const projRaw = raw.proj;
  const projList = typeof projRaw === 'string' ? [projRaw] : projRaw;
  if (!Array.isArray(projList) || projList.length === 0) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.proj 得是项目 slug（string 或 string[]），收到 ${JSON.stringify(projRaw)}` });
  }
  for (const p of projList) {
    if (typeof p !== 'string' || !PROJ_SLUG_RE.test(p)) {
      throw new ZhupiFailure({
        kind: 'badInput',
        what: `track.proj 的 ${JSON.stringify(p)} 不是合法 slug（小写字母数字连字符，与分支名同规）`,
        hint: '起新项目词前先查现有 proj: labels（gh label list），别造同义词。',
      });
    }
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(KIND_VALUES as readonly string[]).includes(kind)) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.kind 只能是 ${KIND_VALUES.join(' / ')}，收到 ${JSON.stringify(kind)}` });
  }
  let wait = raw.wait;
  if (wait !== undefined && (typeof wait !== 'string' || !(WAIT_VALUES as readonly string[]).includes(wait))) {
    throw new ZhupiFailure({ kind: 'badInput', what: `track.wait 只能是 ${WAIT_VALUES.join(' / ')}，收到 ${JSON.stringify(wait)}` });
  }
  if (wait === undefined) {
    wait = (body.decisions ?? '').trim() ? '你拍' : kind === '读物' ? '闲' : '你读';
  }
  const unblocks = raw.unblocks;
  if (unblocks !== undefined) {
    if (typeof unblocks !== 'string' || !unblocks.trim()) {
      throw new ZhupiFailure({ kind: 'badInput', what: `track.unblocks 得是非空一句话，收到 ${JSON.stringify(unblocks)}` });
    }
    // 标记行的语法代价：分号是字段分隔符，`-->` 会把 HTML 注释提前关掉 ——
    // 后者不拦的话整行标记连同后面的 body 半截漏进渲染，他在门下会读到一行乱码。
    if (/[;\n]|-->/.test(unblocks) || unblocks.length > 120) {
      throw new ZhupiFailure({ kind: 'badInput', what: 'track.unblocks 要一句话：≤120 字，不能含分号、换行、-->' });
    }
  }
  return {
    proj: [...new Set(projList as string[])],
    kind: kind as Kind,
    wait: wait as Wait,
    qian: qianList(raw.qian),
    needs: intList(raw.needs, 'needs'),
    supersedes: intList(raw.supersedes, 'supersedes'),
    ...(unblocks !== undefined ? { unblocks: (unblocks as string).trim() } : {}),
  };
}

export const labelsFor = (t: TrackInput): string[] => [
  ...t.proj.map((p) => `${PROJ_PREFIX}${p}`),
  `${KIND_PREFIX}${t.kind}`,
  `${WAIT_PREFIX}${t.wait}`,
  ...t.qian.map((q) => `${QIAN_PREFIX}${q}`),
];

/**
 * 防漂移软闸的纯核：给定本折的签与仓里现有 label 名，返回**新签**（既不在初始七签、
 * 也不是仓里已存在的 `签:*` label）。照建照贴不受影响 —— 这只算「该不该 warn」。
 * existing 拿不到时（读 label 清单失败），调用方传空集，退化成只对种子七签放行。
 */
export function unknownQian(qian: readonly string[], existingLabelNames: readonly string[] = []): string[] {
  const seeded = new Set<string>(QIAN_VALUES);
  const existing = new Set(existingLabelNames);
  return qian.filter((q) => !seeded.has(q) && !existing.has(`${QIAN_PREFIX}${q}`));
}

// ── 关系标记：`<!-- menxia-rel: needs=#49; supersedes=#48,#50; unblocks=… -->` ──
// 与 `happy-session` 同族：机器可读、读者不可见、活在 PR body 尾部。
// label 装状态（可变），这行装关系（呈折时一次性声明）—— #61 §3.1 的双轨。

export const REL_MARKER_RE = /<!--\s*menxia-rel:\s*([^>]*?)\s*-->/i;

/** 没有任何关系就不产行 —— 空标记只会让巡检多解析一次空串。 */
export function buildRelMarker(t: TrackInput): string | null {
  const parts: string[] = [];
  if (t.needs.length > 0) parts.push(`needs=${t.needs.map((n) => `#${n}`).join(',')}`);
  if (t.supersedes.length > 0) parts.push(`supersedes=${t.supersedes.map((n) => `#${n}`).join(',')}`);
  if (t.unblocks) parts.push(`unblocks=${t.unblocks}`);
  if (parts.length === 0) return null;
  return `<!-- menxia-rel: ${parts.join('; ')} -->`;
}

export interface RelMarker {
  needs: number[];
  supersedes: number[];
  unblocks?: string;
}

/**
 * 解析要宽容：这行会被人手写、被从旧折复制 —— 认不出的键**跳过**而不是报错，
 * 巡检的职责是报告存量，不是拒收存量。
 */
export function parseRelMarker(body: string | null | undefined): RelMarker {
  const out: RelMarker = { needs: [], supersedes: [] };
  const m = REL_MARKER_RE.exec(body ?? '');
  if (!m) return out;
  for (const part of (m[1] ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 'needs' || key === 'supersedes') {
      out[key] = [...new Set([...(val.matchAll(/\d+/g))].map((x) => Number(x[0])))];
    } else if (key === 'unblocks' && val) {
      out.unblocks = val;
    }
  }
  return out;
}

// ── 巡检分析（audit_folders 的折务四检，#61 §3.4 + 涂归新增的「可画可候选」）──

export interface TrackFolderState {
  number: number;
  /** label 名字列表（GitHub 原文）。 */
  labels: string[];
  body: string | null;
  /** 只有 open 折有：list/read 那条路算出来的计数。 */
  counts?: { needsReply: number; unclear: number };
  /** 有**确证**是他的话（fromDesk 的涂归/判）。共用账号下这是唯一不多报的判据。 */
  engaged?: boolean;
}

/**
 * 四检，纯函数，返回 折号 → 备注[]。只报不动手：处置权在 Charlie（#61 §3.4）。
 *   ① 僵尸候选 —— 已画可折声明 supersedes 的折还开着
 *   ② 已解锁 —— open 折 needs 的折已画可（顺带报「将被盖」与「依赖查不到」）
 *   ③ wait 漂移 —— 标着「等你」，实际 needsReply>0（在等 agent）
 *   ④ 可画可候选 —— 他批过（engaged）且批注全处理完：「能不能合并」那条涂归要的就是这个
 */
export function trackAudit(open: TrackFolderState[], merged: TrackFolderState[], repoSlug: string): Map<number, string[]> {
  const notes = new Map<number, string[]>();
  const add = (pr: number, note: string): void => {
    if (!notes.has(pr)) notes.set(pr, []);
    notes.get(pr)!.push(note);
  };
  const openNums = new Set(open.map((o) => o.number));
  const mergedNums = new Set(merged.map((m) => m.number));

  for (const m of merged) {
    for (const target of parseRelMarker(m.body).supersedes) {
      if (openNums.has(target)) add(target, `已被 #${m.number}（已画可）声明盖掉 —— 僵尸候选，等 Charlie 一句话处置（画可归档 / 作废）`);
    }
  }

  for (const o of open) {
    if (!o.labels.some((l) => l.startsWith(PROJ_PREFIX))) {
      add(
        o.number,
        `缺折务追踪 label —— 补：gh pr edit ${o.number} -R ${repoSlug} --add-label "proj:<项目>" --add-label "kind:<主用途>" --add-label "wait:<等谁>"（词表见 #61）`,
      );
    }
    const rel = parseRelMarker(o.body);
    for (const target of rel.supersedes) {
      if (openNums.has(target)) add(target, `将被 #${o.number} 盖掉 —— #${o.number} 画可时随手处置本折`);
    }
    for (const dep of rel.needs) {
      if (mergedNums.has(dep)) add(o.number, `依赖已解锁：#${dep} 已画可，本折可动手`);
      else if (!openNums.has(dep)) add(o.number, `依赖 #${dep} 既不在 open 也不在近期已画可里（可能被作废关闭）—— 人工看一眼`);
    }
    if (o.counts) {
      const waitingOnHim = o.labels.includes('wait:你拍') || o.labels.includes('wait:你读');
      if (waitingOnHim && o.counts.needsReply > 0) {
        add(o.number, `wait 漂移：标着「等你」，实际有 ${o.counts.needsReply} 条待 agent 处理 —— 改挂 wait:agent`);
      }
      if (o.engaged && o.counts.needsReply === 0 && o.counts.unclear === 0) {
        add(o.number, '可画可候选：他批过、批注全处理完 —— 等 Charlie 一句「画可」');
      }
    }
  }
  return notes;
}
