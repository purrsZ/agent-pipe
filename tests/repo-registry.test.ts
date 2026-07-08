import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillRepoRegistry, registryDisplayName } from '../src/index.js';
import { Store } from '../src/store.js';

// INTAKE L0：仓库登记表（kernel store 新表）+ 启动回填。抽取 prompt / 勘探搜索起点都读它。

describe('repo_registry store 方法', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-repo-reg-'));
    store = new Store(path.join(tmpDir, 'db.sqlite'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsert + list：name 小写化落库，按 last_used_at 降序', () => {
    store.upsertRepoRegistry('/a/AlaeatPosApp', 'AlaeatPosApp', 100, 'unit');
    store.upsertRepoRegistry('/b/other', 'other', 200, 'backfill');
    const rows = store.listRepoRegistry(20);
    expect(rows.map((r) => r.path)).toEqual(['/b/other', '/a/AlaeatPosApp']); // 200 > 100
    expect(rows[1]!.name).toBe('alaeatposapp'); // 小写化
    expect(rows[1]!.source).toBe('unit');
  });

  it('upsert 幂等：同 path 刷新 last_used_at / source（最后写为准）', () => {
    store.upsertRepoRegistry('/a/x', 'x', 100, 'backfill');
    store.upsertRepoRegistry('/a/x', 'x', 300, 'unit');
    const rows = store.listRepoRegistry(20);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_used_at).toBe(300);
    expect(rows[0]!.source).toBe('unit');
  });

  it('list limit 生效', () => {
    for (let i = 0; i < 5; i++) store.upsertRepoRegistry(`/r/${i}`, `r${i}`, i, 'unit');
    expect(store.listRepoRegistry(2)).toHaveLength(2);
  });

  it('match：大小写不敏感的包含匹配，返回全部命中（歧义交上层）', () => {
    store.upsertRepoRegistry('/a/alaeatposapp', 'alaeatposapp', 100, 'unit');
    store.upsertRepoRegistry('/b/alaeatposapp', 'alaeatposapp', 200, 'scout');
    store.upsertRepoRegistry('/c/unrelated', 'unrelated', 300, 'unit');
    const hits = store.matchRepoRegistry('AlaEatPosApp'); // 大写线索
    expect(hits.map((r) => r.path).sort()).toEqual(['/a/alaeatposapp', '/b/alaeatposapp']);
  });

  it('match：部分包含命中', () => {
    store.upsertRepoRegistry('/a/pos-terminal', 'pos-terminal', 100, 'unit');
    expect(store.matchRepoRegistry('terminal').map((r) => r.path)).toEqual(['/a/pos-terminal']);
  });

  it('match：空线索 / 无命中 → 空数组', () => {
    store.upsertRepoRegistry('/a/x', 'x', 100, 'unit');
    expect(store.matchRepoRegistry('')).toEqual([]);
    expect(store.matchRepoRegistry('   ')).toEqual([]);
    expect(store.matchRepoRegistry('nope')).toEqual([]);
  });

  it('match：下划线不被当 LIKE 通配（ESCAPE）', () => {
    store.upsertRepoRegistry('/a/pos_app', 'pos_app', 100, 'unit');
    store.upsertRepoRegistry('/b/posxapp', 'posxapp', 200, 'unit');
    // 线索 'pos_app' 只命中真的带下划线的，不误命中 posxapp
    expect(store.matchRepoRegistry('pos_app').map((r) => r.path)).toEqual(['/a/pos_app']);
  });
});

// 别名：用户起的短名（/repo alias → /new <name> <别名> 秒开项目任务）。只由 setRepoAlias/
// clearRepoAlias 写，自动登记（upsert）永不触碰——人起的名不被 backfill/scout 刷掉。
describe('repo_registry 别名 (alias)', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-repo-alias-'));
    store = new Store(path.join(tmpDir, 'db.sqlite'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('setRepoAlias：行不存在则顺手登记（source=manual，name=basename 小写，别名小写化）', () => {
    store.setRepoAlias('/a/AlaEatPosApp', 'POS', 100);
    const row = store.getRepoByAlias('pos');
    expect(row?.path).toBe('/a/AlaEatPosApp');
    expect(row?.name).toBe('alaeatposapp');
    expect(row?.source).toBe('manual');
    expect(row?.alias).toBe('pos');
  });

  it('setRepoAlias：已存在的行只写 alias + last_used_at，不碰 name/source', () => {
    store.upsertRepoRegistry('/a/x', 'x', 100, 'unit');
    store.setRepoAlias('/a/x', 'foo', 200);
    expect(store.getRepoByPath('/a/x')).toMatchObject({
      name: 'x',
      source: 'unit',
      alias: 'foo',
      last_used_at: 200,
    });
  });

  it('upsertRepoRegistry 不冲掉别名（自动登记与人起名隔离）', () => {
    store.setRepoAlias('/a/x', 'foo', 100);
    store.upsertRepoRegistry('/a/x', 'x', 300, 'backfill');
    const row = store.getRepoByAlias('foo');
    expect(row?.path).toBe('/a/x');
    expect(row?.source).toBe('backfill'); // upsert 语义照旧
  });

  it('别名唯一：同名别名绑到第二个仓 → 抛错（唯一部分索引兜底）', () => {
    store.setRepoAlias('/a/x', 'foo', 100);
    expect(() => store.setRepoAlias('/b/y', 'foo', 200)).toThrow();
  });

  it('未起名的多行（alias=NULL）互不冲突（部分索引不管 NULL）', () => {
    store.upsertRepoRegistry('/a/x', 'x', 100, 'unit');
    store.upsertRepoRegistry('/b/y', 'y', 100, 'unit');
    expect(store.listRepoRegistry(10)).toHaveLength(2);
  });

  it('clearRepoAlias：删除返回 true，再删返回 false', () => {
    store.setRepoAlias('/a/x', 'foo', 100);
    expect(store.clearRepoAlias('FOO')).toBe(true); // 大小写不敏感
    expect(store.clearRepoAlias('foo')).toBe(false);
    expect(store.getRepoByAlias('foo')).toBeUndefined();
  });

  it('matchRepoRegistry 按别名包含命中（与 name 同权）', () => {
    store.setRepoAlias('/a/alaeatposapp', 'pos', 100);
    store.upsertRepoRegistry('/b/unrelated', 'unrelated', 200, 'unit');
    expect(store.matchRepoRegistry('POS').map((r) => r.path)).toEqual(['/a/alaeatposapp']);
  });

  it('touchRepoRegistry：只刷 last_used_at（不动 alias/source）；未登记返回 false', () => {
    store.setRepoAlias('/a/x', 'foo', 100);
    expect(store.touchRepoRegistry('/a/x', 500)).toBe(true);
    expect(store.getRepoByPath('/a/x')).toMatchObject({
      last_used_at: 500,
      alias: 'foo',
      source: 'manual',
    });
    expect(store.touchRepoRegistry('/nope', 500)).toBe(false);
  });

  it('旧库迁移：无 alias 列的旧表打开后补列 + 唯一索引生效', () => {
    const dbPath = path.join(tmpDir, 'legacy.sqlite');
    const raw = new Database(dbPath);
    raw.exec(
      `CREATE TABLE repo_registry (
         path TEXT PRIMARY KEY, name TEXT NOT NULL,
         last_used_at INTEGER NOT NULL, source TEXT NOT NULL
       );`,
    );
    raw.prepare("INSERT INTO repo_registry VALUES ('/a/x', 'x', 100, 'unit')").run();
    raw.close();
    const migrated = new Store(dbPath);
    try {
      expect(migrated.getRepoByPath('/a/x')?.alias).toBeNull(); // 回填 NULL
      migrated.setRepoAlias('/a/x', 'foo', 200);
      expect(migrated.getRepoByAlias('foo')?.path).toBe('/a/x');
      expect(() => migrated.setRepoAlias('/b/y', 'foo', 300)).toThrow(); // 索引也建上了
    } finally {
      migrated.close();
    }
  });
});

describe('registryDisplayName（别名织入 AI 可见快照）', () => {
  it('有别名 → name（别名:xxx）；无别名 → name 原样', () => {
    expect(registryDisplayName({ name: 'x', alias: 'foo' })).toBe('x（别名:foo）');
    expect(registryDisplayName({ name: 'x', alias: null })).toBe('x');
    expect(registryDisplayName({ name: 'x' })).toBe('x');
  });
});

describe('backfillRepoRegistry (DI，先例 backfillClaimedChats)', () => {
  it('遍历全部单元 repos 逐仓 upsert（source=backfill），basename 作 name', () => {
    const upserts: Array<[string, string, number, string]> = [];
    const n = backfillRepoRegistry({
      listAllRepos: () => ['/x/foo', '/y/bar'],
      upsertRepoRegistry: (p, name, now, source) => upserts.push([p, name, now, source]),
      now: () => 999,
    });
    expect(n).toBe(2);
    expect(upserts).toEqual([
      ['/x/foo', 'foo', 999, 'backfill'],
      ['/y/bar', 'bar', 999, 'backfill'],
    ]);
  });

  it('回填幂等：重复回填同一批只 upsert 同值（store 层去重）', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-repo-reg-bf-'));
    const store = new Store(path.join(tmpDir, 'db.sqlite'));
    try {
      const deps = {
        listAllRepos: () => ['/x/foo', '/y/bar'],
        upsertRepoRegistry: (p: string, name: string, now: number, source: string) =>
          store.upsertRepoRegistry(p, name, now, source),
        now: () => 1000,
      };
      backfillRepoRegistry(deps);
      backfillRepoRegistry(deps);
      expect(store.listRepoRegistry(20)).toHaveLength(2); // 不翻倍
    } finally {
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('空仓列表 → 回填 0 条', () => {
    const n = backfillRepoRegistry({
      listAllRepos: () => [],
      upsertRepoRegistry: () => {
        throw new Error('should not be called');
      },
      now: () => 1,
    });
    expect(n).toBe(0);
  });
});
