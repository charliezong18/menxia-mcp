#!/usr/bin/env bash
# 打印当前 agent 所在的 Happy 会话 id（拿不到就什么都不打印，退出码 1）。
# 原理：agent 进程是 happy CLI 的后代 —— 沿 ppid 往上爬，拿每一级 pid 去比
# ~/.happy/sessions.json 里各会话记的 hostPid，撞上的那个就是我。
# 用途：开朱批折时把 id 埋进 PR body（`<!-- happy-session: <id> -->`），
# 朱批的「回奏对」按钮据此把 Charlie 送回呈折的那次奏对。
exec python3 - "$$" <<'PY'
import json, os, subprocess, sys

pid = int(sys.argv[1])
try:
    sessions = json.load(open(os.path.expanduser('~/.happy/sessions.json')))['sessions']
except Exception:
    sys.exit(1)
by_pid = {s.get('metadata', {}).get('hostPid'): sid for sid, s in sessions.items()}


def ps(fmt, pid):
    try:
        return subprocess.check_output(['ps', '-o', fmt, '-p', str(pid)], text=True).strip()
    except Exception:
        return ''


# sessions.json 只累加不清理（实测 114 条全标 running，状态根本不更新），陈旧记录的 hostPid
# 早被 OS 回收给别的进程。撞上就会打印一个**错的**会话 id——静默指错比没有更糟，
# 所以命中后再验一句：这个 pid 现在跑的确实是 happy。
for _ in range(12):
    if pid in by_pid and 'happy' in ps('command=', pid):
        print(by_pid[pid])
        sys.exit(0)
    parent = ps('ppid=', pid)
    if not parent:
        break
    pid = int(parent)
    if pid <= 1:
        break
sys.exit(1)
PY
