import { describe, it, expect } from 'vitest';
import {
  KIND_VALUES,
  QIAN_VALUES,
  WAIT_VALUES,
  buildRelMarker,
  labelColor,
  labelDesc,
  labelsFor,
  parseRelMarker,
  trackAudit,
  unknownQian,
  validateTrack,
  type TrackFolderState,
} from '../src/track.js';
import { buildBody } from '../src/body.js';
import { ZhupiFailure } from '../src/errors.js';

const SID = 'cmszzzzzzzzzzzzzzzzzzzzzz';
const body = (decisions = '') => ({ destination: 'x', tldr: 'x', decisions, howto: 'x' });

describe('validateTrack：校验 + wait 推导', () => {
  it('proj 接受 string 并归一成数组；kind/wait 落地', () => {
    const t = validateTrack({ proj: 'menxia', kind: '评审' }, body(''));
    expect(t.proj).toEqual(['menxia']);
    expect(t.kind).toBe('评审');
  });

  it('wait 缺省按规则推：有待拍板段→你拍；读物→闲；其余→你读', () => {
    expect(validateTrack({ proj: 'a', kind: '评审' }, body('1) 批不批？')).wait).toBe('你拍');
    expect(validateTrack({ proj: 'a', kind: '读物' }, body('')).wait).toBe('闲');
    expect(validateTrack({ proj: 'a', kind: '评审' }, body('')).wait).toBe('你读');
  });

  it('显式 wait 永远赢过推导', () => {
    expect(validateTrack({ proj: 'a', kind: '评审', wait: 'agent' }, body('有拍板段')).wait).toBe('agent');
  });

  it('kind / wait 枚举外直接拒', () => {
    expect(() => validateTrack({ proj: 'a', kind: '提案' }, body())).toThrow(ZhupiFailure);
    expect(() => validateTrack({ proj: 'a', kind: '评审', wait: '他拍' }, body())).toThrow(ZhupiFailure);
  });

  it('proj slug 拒中文 / 大写 / 空数组 —— label 是裸字符串契约，同义词并存就是两个项目', () => {
    expect(() => validateTrack({ proj: '门下', kind: '评审' }, body())).toThrow(/slug/);
    expect(() => validateTrack({ proj: 'Menxia', kind: '评审' }, body())).toThrow(/slug/);
    expect(() => validateTrack({ proj: [], kind: '评审' }, body())).toThrow(ZhupiFailure);
  });

  it('needs / supersedes 拒字符串折号并去重', () => {
    expect(() => validateTrack({ proj: 'a', kind: '评审', needs: ['3'] }, body())).toThrow(/needs/);
    expect(validateTrack({ proj: 'a', kind: '评审', needs: [2, 2, 3] }, body()).needs).toEqual([2, 3]);
  });

  it('qian 缺省是空数组；string 归一成单元素数组', () => {
    expect(validateTrack({ proj: 'a', kind: '评审' }, body()).qian).toEqual([]);
    expect(validateTrack({ proj: 'a', kind: '评审', qian: '旅行' }, body()).qian).toEqual(['旅行']);
  });

  it('qian 是开放集：不校验取值，只 trim / 去空 / 去重', () => {
    expect(validateTrack({ proj: 'a', kind: '评审', qian: [' 旅行 ', '旅行', '', '  '] }, body()).qian).toEqual(['旅行']);
    // 没有白名单：从没见过的签也照收（软闸在 applyTrackLabels 出 warning，不在这里拦）
    expect(validateTrack({ proj: 'a', kind: '评审', qian: ['旅行', '玄学'] }, body()).qian).toEqual(['旅行', '玄学']);
  });

  it('qian 拒非字符串元素 —— label 是裸字符串契约', () => {
    expect(() => validateTrack({ proj: 'a', kind: '评审', qian: [1] }, body())).toThrow(/qian/);
    expect(() => validateTrack({ proj: 'a', kind: '评审', qian: 42 }, body())).toThrow(/qian/);
  });

  it('unblocks 拒分号 / --> / 超长 —— 分号是字段分隔符，--> 会把注释提前关掉', () => {
    expect(() => validateTrack({ proj: 'a', kind: '评审', unblocks: 'x; y' }, body())).toThrow(/unblocks/);
    expect(() => validateTrack({ proj: 'a', kind: '评审', unblocks: 'x --> y' }, body())).toThrow(/unblocks/);
    expect(() => validateTrack({ proj: 'a', kind: '评审', unblocks: 'x'.repeat(121) }, body())).toThrow(/unblocks/);
  });

  it('词表常量本身没漂：枚举与 T3 首用一致', () => {
    expect([...KIND_VALUES]).toEqual(['拍板', '评审', '设计', '读物', '交付', '参考']);
    expect([...WAIT_VALUES]).toEqual(['你拍', '你读', 'agent', '闲']);
    // 初始七签是协议常量（两个仓必须一致），改这行就是改契约。
    expect([...QIAN_VALUES]).toEqual(['旅行', '开发', '身份', '工作', '健康', '钱', '文史']);
    // 红绿灯色是阅读器直接消费的（零映射表）—— 改色就是改契约，必须被这条看见。
    expect(labelColor('wait:你拍')).toBe('D73A4A');
    expect(labelColor('proj:从没见过的')).toBe('BFD4F2');
    // 签家族统一一个紫，种子签与开放集的新签都落 5319E7（前缀兜底）。
    expect(labelColor('签:旅行')).toBe('5319E7');
    expect(labelColor('签:从没见过的')).toBe('5319E7');
    expect(labelDesc('签:旅行')).toBe('签：旅行（主题归堆）');
  });
});

describe('关系标记：build ↔ parse 往返', () => {
  const t = validateTrack(
    { proj: 'zhongshumenxia', kind: '拍板', needs: [49], supersedes: [48, 50], unblocks: 'T1.2 租机链' },
    body('批'),
  );

  it('labelsFor 产三类 label（无签时）', () => {
    expect(labelsFor(t)).toEqual(['proj:zhongshumenxia', 'kind:拍板', 'wait:你拍']);
  });

  it('labelsFor 把签接在三类之后（proj → kind → wait → 签）', () => {
    const withQian = validateTrack({ proj: 'menxia', kind: '评审', qian: ['旅行', '开发'] }, body());
    expect(labelsFor(withQian)).toEqual(['proj:menxia', 'kind:评审', 'wait:你读', '签:旅行', '签:开发']);
  });

  it('全字段往返', () => {
    const marker = buildRelMarker(t)!;
    expect(marker).toBe('<!-- menxia-rel: needs=#49; supersedes=#48,#50; unblocks=T1.2 租机链 -->');
    expect(parseRelMarker(marker)).toEqual({ needs: [49], supersedes: [48, 50], unblocks: 'T1.2 租机链' });
  });

  it('没有关系就不产行 —— 空标记只会让巡检白解析', () => {
    expect(buildRelMarker(validateTrack({ proj: 'a', kind: '评审' }, body()))).toBeNull();
  });

  it('解析宽容：没标记给空集；认不出的键跳过；与 happy-session 共存互不干扰', () => {
    expect(parseRelMarker(null)).toEqual({ needs: [], supersedes: [] });
    expect(parseRelMarker('<!-- menxia-rel: foo=bar; needs=#7 -->').needs).toEqual([7]);
    const built = buildBody(body('批'), SID, buildRelMarker(t));
    expect(built.text).toContain('menxia-rel: needs=#49');
    expect(built.text).toContain(`happy-session: ${SID}`);
    expect(parseRelMarker(built.text).supersedes).toEqual([48, 50]);
  });
});

describe('trackAudit：折务四检（纯函数）', () => {
  const open = (n: number, extra: Partial<TrackFolderState> = {}): TrackFolderState => ({
    number: n,
    labels: ['proj:menxia', 'kind:评审', 'wait:你读'],
    body: null,
    ...extra,
  });

  it('① 僵尸候选：已画可折声明盖掉的折还开着', () => {
    const notes = trackAudit(
      [open(58)],
      [{ number: 59, labels: [], body: '<!-- menxia-rel: supersedes=#58 -->' }],
      'o/r',
    );
    expect(notes.get(58)![0]).toContain('#59');
    expect(notes.get(58)![0]).toContain('僵尸候选');
  });

  it('② 依赖已解锁 / 依赖查不到；open 对 open 的 supersedes 报「将被盖」', () => {
    const notes = trackAudit(
      [
        open(10, { body: '<!-- menxia-rel: needs=#5,#99 -->' }),
        open(11, { body: '<!-- menxia-rel: supersedes=#10 -->' }),
      ],
      [{ number: 5, labels: [], body: null }],
      'o/r',
    );
    const n10 = notes.get(10)!.join('\n');
    expect(n10).toContain('#5 已画可');
    expect(n10).toContain('#99');
    expect(n10).toContain('将被 #11 盖掉');
  });

  it('③ wait 漂移：标着「等你」而 needsReply>0', () => {
    const notes = trackAudit(
      [open(7, { labels: ['proj:menxia', 'wait:你拍'], counts: { needsReply: 2, unclear: 0 }, engaged: true })],
      [],
      'o/r',
    );
    expect(notes.get(7)!.some((s) => s.includes('wait 漂移'))).toBe(true);
  });

  it('④ 可画可候选只发给 engaged（确证 fromDesk）的折 —— 没批过的折只是没读，不是可画可', () => {
    const settled = { counts: { needsReply: 0, unclear: 0 }, engaged: true };
    const untouched = { counts: { needsReply: 0, unclear: 0 }, engaged: false };
    const notes = trackAudit([open(1, settled), open(2, untouched)], [], 'o/r');
    expect(notes.get(1)!.some((s) => s.includes('可画可候选'))).toBe(true);
    expect(notes.get(2) ?? []).toEqual([]);
  });

  it('缺 proj: label 的折报补标命令（带词表出处 #61）', () => {
    const notes = trackAudit([open(3, { labels: [] })], [], 'charliezong18/review');
    expect(notes.get(3)![0]).toContain('gh pr edit 3 -R charliezong18/review');
    expect(notes.get(3)![0]).toContain('#61');
  });
});

describe('unknownQian：防漂移软闸的纯核', () => {
  it('初始七签一律不报', () => {
    expect(unknownQian([...QIAN_VALUES])).toEqual([]);
  });

  it('新签报出来（照建照贴不受影响，只算该不该 warn）', () => {
    expect(unknownQian(['旅行', '玄学'])).toEqual(['玄学']);
  });

  it('仓里已有同名 签: label 的不报 —— 已进过签集就不是新签', () => {
    expect(unknownQian(['玄学'], ['proj:menxia', '签:玄学'])).toEqual([]);
    // 只认精确的 签:<名>，别的前缀不算数
    expect(unknownQian(['玄学'], ['kind:玄学'])).toEqual(['玄学']);
  });

  it('existing 缺省为空集：退化成只对种子七签放行', () => {
    expect(unknownQian(['旅行', '玄学'])).toEqual(['玄学']);
  });
});
