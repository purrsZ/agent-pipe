import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandHandler } from '../../src/bridge/commands.js';
import type { IncomingMessage } from '../../src/feishu/types.js';
import { Store } from '../../src/store.js';

// /repo 命令组 + /new 仓库寻址（别名/线索/路径）。真 Store + 真目录——解析必须过
// allowedCwdPrefixes + 存在性校验，假件测不出安全门。

function makeMsg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'm-1',
    chatId: 'c-1',
    chatType: 'p2p',
    userId: 'u-1',
    text,
    isMentioned: false,
    mentions: [],
    attachments: [],
    createTime: 1,
    ...over,
  };
}

let tmpDir: string;
let store: Store;
let reposRoot: string;
let sessionsDir: string;
let replies: string[];
let cards: object[];
let handler: CommandHandler;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cmd-repo-'));
  store = new Store(path.join(tmpDir, 'db.sqlite'));
  reposRoot = path.join(tmpDir, 'code');
  sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(reposRoot, { recursive: true });
  replies = [];
  cards = [];
  const sender = {
    reply: async (_id: string, text: string) => {
      replies.push(text);
      return null;
    },
    sendCard: async (_chatId: string, card: object) => {
      cards.push(card);
      return `card-${cards.length}`;
    },
  };
  const config = {
    allowedOpenIds: new Set<string>(),
    allowedCwdPrefixes: [reposRoot],
    sessionsDir,
    defaultAgent: 'claude',
  };
  handler = new CommandHandler(
    store,
    sender as never,
    config as never,
    { error: () => {}, info: () => {}, warn: () => {} } as never, // logger
    {} as never, // pool
    () => {}, // onCompact
    () => ({ aborted: false, dropped: 0 }), // onStop
    () => {}, // onDiagMcp
    () => {}, // onDiagReadonly
    () => {}, // onProbe
    () => {}, // onDone
    () => {}, // onRequirement
    () => {}, // onCancelUnit
    () => {}, // onScout
    () => {}, // onDelegate
  );
});
afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 造一个（可选带 .git 的）目录当测试仓。 */
function mkRepo(rel: string, git = true): string {
  const p = path.join(reposRoot, rel);
  fs.mkdirSync(p, { recursive: true });
  if (git) fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  return p;
}

describe('/repo list', () => {
  it('空表 → 引导提示', async () => {
    await handler.dispatch(makeMsg('/repo'));
    expect(replies[0]).toContain('登记表为空');
  });

  it('有登记 → 列出（别名标 [x]，无别名标 ·，路径缩 ~）', async () => {
    store.upsertRepoRegistry('/a/noalias', 'noalias', 100, 'unit');
    store.setRepoAlias(mkRepo('alaeatposapp'), 'pos', 200);
    await handler.dispatch(makeMsg('/repo list'));
    expect(replies[0]).toContain('[pos] alaeatposapp');
    expect(replies[0]).toContain('· noalias');
  });
});

describe('/repo alias', () => {
  it('绝对路径起别名：登记 + 绑定（回执带 /new 用法）', async () => {
    const p = mkRepo('alaeatposapp');
    await handler.dispatch(makeMsg(`/repo alias pos ${p}`));
    expect(replies[0]).toContain('别名已设置: pos');
    expect(store.getRepoByAlias('pos')?.path).toBe(p);
  });

  it('线索起别名：登记表唯一命中即绑定', async () => {
    const p = mkRepo('alaeatposapp');
    store.upsertRepoRegistry(p, 'alaeatposapp', 100, 'unit');
    await handler.dispatch(makeMsg('/repo alias pos posapp'));
    expect(store.getRepoByAlias('pos')?.path).toBe(p);
  });

  it('别名被占 → 提示先解绑，不覆盖', async () => {
    const p1 = mkRepo('repo-a');
    const p2 = mkRepo('repo-b');
    store.setRepoAlias(p1, 'pos', 100);
    await handler.dispatch(makeMsg(`/repo alias pos ${p2}`));
    expect(replies[0]).toContain('已指向');
    expect(store.getRepoByAlias('pos')?.path).toBe(p1);
  });

  it('同仓重复起同名别名 → 幂等成功（不报占用）', async () => {
    const p = mkRepo('repo-a');
    store.setRepoAlias(p, 'pos', 100);
    await handler.dispatch(makeMsg(`/repo alias pos ${p}`));
    expect(replies[0]).toContain('别名已设置');
  });

  it('/repo alias <别名> - 删除；不存在 → 如实说', async () => {
    store.setRepoAlias(mkRepo('repo-a'), 'pos', 100);
    await handler.dispatch(makeMsg('/repo alias pos -'));
    expect(replies[0]).toContain('已删除别名 pos');
    expect(store.getRepoByAlias('pos')).toBeUndefined();
    await handler.dispatch(makeMsg('/repo alias pos -'));
    expect(replies[1]).toContain('别名不存在');
  });

  it('非法别名（SLUG 外字符）→ 拒绝', async () => {
    await handler.dispatch(makeMsg(`/repo alias 好名字 ${mkRepo('x')}`));
    expect(replies[0]).toContain('别名只能用');
  });

  it('缺参 → 用法', async () => {
    await handler.dispatch(makeMsg('/repo alias pos'));
    expect(replies[0]).toContain('用法');
  });

  it('简写糖：/repo <别名> <路径> 等价 /repo alias …（真机第一反应写法）', async () => {
    const p = mkRepo('alaeatposapp');
    await handler.dispatch(makeMsg(`/repo pos3 ${p}`));
    expect(replies[0]).toContain('别名已设置: pos3');
    expect(store.getRepoByAlias('pos3')?.path).toBe(p);
  });

  it('简写糖删除：/repo <别名> -', async () => {
    store.setRepoAlias(mkRepo('repo-a'), 'pos3', 100);
    await handler.dispatch(makeMsg('/repo pos3 -'));
    expect(replies[0]).toContain('已删除别名 pos3');
  });

  it('单个未知词不当简写 → 回用法（防手滑）', async () => {
    await handler.dispatch(makeMsg('/repo pos3'));
    expect(replies[0]).toContain('用法');
    expect(store.getRepoByAlias('pos3')).toBeUndefined();
  });

  it('别名放开点号：pos2.0 可绑可用；任务名规则不动', async () => {
    const p = mkRepo('pos-2.0');
    await handler.dispatch(makeMsg(`/repo pos2.0 ${p}`));
    expect(store.getRepoByAlias('pos2.0')?.path).toBe(p);
    await handler.dispatch(makeMsg('/new t8 pos2.0'));
    expect(store.getTask('t8')?.cwd).toBe(p);
    await handler.dispatch(makeMsg('/new bad.name pos2.0'));
    expect(replies[replies.length - 1]).toContain('name 只能用');
  });
});

describe('/new 仓库寻址', () => {
  it('别名精确命中 → project 任务开在对应目录，别名进主帖卡，登记表 last_used_at 被触碰', async () => {
    const p = mkRepo('alaeatposapp');
    store.setRepoAlias(p, 'pos', 100);
    await handler.dispatch(makeMsg('/new t1 pos'));
    const task = store.getTask('t1');
    expect(task?.mode).toBe('project');
    expect(task?.cwd).toBe(p);
    expect(JSON.stringify(cards[0])).toContain('别名 pos');
    expect(store.getRepoByPath(p)!.last_used_at).toBeGreaterThan(100);
  });

  it('线索多命中 → 列候选不建任务', async () => {
    store.upsertRepoRegistry(mkRepo('shop-app'), 'shop-app', 100, 'unit');
    store.upsertRepoRegistry(mkRepo('pos-app'), 'pos-app', 200, 'unit');
    await handler.dispatch(makeMsg('/new t2 app'));
    expect(replies[0]).toContain('匹配到多个');
    expect(store.getTask('t2')).toBeUndefined();
  });

  it('线索不在登记表 → 退回一级目录扫描；git 仓自动登记（source=task）', async () => {
    const p = mkRepo('fresh-repo');
    await handler.dispatch(makeMsg('/new t3 fresh'));
    expect(store.getTask('t3')?.cwd).toBe(p);
    expect(store.getRepoByPath(p)?.source).toBe('task');
  });

  it('非 git 目录可开任务但不进登记表', async () => {
    const p = mkRepo('docs-dir', false);
    await handler.dispatch(makeMsg('/new t4 docs-dir'));
    expect(store.getTask('t4')?.cwd).toBe(p);
    expect(store.getRepoByPath(p)).toBeUndefined();
  });

  it('别名指向已删除目录 → 存在性校验拦下（别名不绕安全门）', async () => {
    const p = mkRepo('gone');
    store.setRepoAlias(p, 'gone', 100);
    fs.rmSync(p, { recursive: true, force: true });
    await handler.dispatch(makeMsg('/new t5 gone'));
    expect(replies[0]).toContain('不存在或不是目录');
    expect(store.getTask('t5')).toBeUndefined();
  });

  it('仓库参数与 --cwd 同给 → 拒收', async () => {
    mkRepo('x');
    await handler.dispatch(makeMsg(`/new t6 x --cwd ${reposRoot}/x`));
    expect(replies[0]).toContain('只能给一个');
    expect(store.getTask('t6')).toBeUndefined();
  });

  it('不给仓库 → sandbox 目录自动 git init', async () => {
    await handler.dispatch(makeMsg('/new t7'));
    const task = store.getTask('t7');
    expect(task?.mode).toBe('sandbox');
    expect(fs.existsSync(path.join(task!.cwd, '.git'))).toBe(true);
  });
});

describe('/list 别名显示', () => {
  it('有别名的项目任务显示「别名 (~路径)」', async () => {
    const p = mkRepo('alaeatposapp');
    store.setRepoAlias(p, 'pos', 100);
    await handler.dispatch(makeMsg('/new t1 pos'));
    await handler.dispatch(makeMsg('/list'));
    const list = replies[replies.length - 1]!;
    expect(list).toContain('pos (');
    expect(list).not.toContain(`\n    ${p}\n`); // 全路径不再裸奔
  });
});
