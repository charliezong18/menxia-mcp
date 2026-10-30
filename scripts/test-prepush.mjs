// pre-push 旧词闸门的增量基测试。运行：node --test scripts/test-prepush.mjs
//
// 病史：新分支首次推送时远端无对应 ref，hook 旧写法「算不出增量就扫全仓」，
// 把 main 上早就存在的旧词文件（docs/phase-1/tasks.zh-CN.md 等）报成本次新增而拦截。
// 修法：以 merge-base(本地sha, origin/main) 为基算增量；连 origin/main 都没有才全仓扫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-push');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// 远端（bare）+ 工作克隆；main 上已有一个含旧词的存量文件（用 --no-verify 推，模拟闸门立项前的历史）
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'prepush-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'init', '-b', 'main', work);
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  git(work, 'remote', 'add', 'origin', remote);
  mkdirSync(join(work, '.githooks'));
  copyFileSync(HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  git(work, 'config', 'core.hooksPath', '.githooks');
  mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'docs', 'old.md'), '存量文件里有个朱批\n'); // 旧词：测试夹具
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'init');
  git(work, 'push', '--no-verify', '-u', 'origin', 'main');
  return work;
}

const push = (work, branch) =>
  spawnSync('git', ['push', '-u', 'origin', branch], { cwd: work, encoding: 'utf8' });

test('新分支首次推送：main 上的存量旧词不被误拦', () => {
  const work = setup();
  git(work, 'checkout', '-b', 'feat');
  writeFileSync(join(work, 'new.md'), '干净的新内容\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'clean');
  const r = push(work, 'feat');
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /改扫全仓/);
  assert.match(out, /旧词闸门通过/);
});

test('新分支首次推送：本分支自己新增的旧词照样拦', () => {
  const work = setup();
  git(work, 'checkout', '-b', 'feat');
  writeFileSync(join(work, 'bad.md'), '新写的奏折\n'); // 旧词：测试夹具
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'bad');
  const r = push(work, 'feat');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /\+新写的奏折/); // 旧词：测试夹具
});

test('连 origin/main 都拿不到：退回全仓扫（只许往严的方向倒）', () => {
  const work = setup();
  git(work, 'checkout', '-b', 'feat');
  writeFileSync(join(work, 'new.md'), '干净的新内容\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'clean');
  git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
  const r = push(work, 'feat');
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /改扫全仓/);
  assert.match(out, /old\.md/);
});
