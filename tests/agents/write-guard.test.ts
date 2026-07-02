import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWriteSettings,
  decideWriteGuard,
  probeWriteGuard,
  renderWriteGuardScript,
} from '../../src/agents/claude/write-guard.js';

const DIRS = ['/work/wt-a', '/work/wt-b'];

describe('decideWriteGuard (PreToolUse path guard, D-04)', () => {
  it('allows Write inside a writable dir', () => {
    expect(decideWriteGuard('Write', { file_path: '/work/wt-a/src/x.ts' }, DIRS).allow).toBe(true);
  });

  it('denies Write outside every writable dir', () => {
    const v = decideWriteGuard('Write', { file_path: '/etc/passwd' }, DIRS);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('/etc/passwd');
  });

  it('denies Edit just outside the dir boundary (no prefix-escape)', () => {
    // /work/wt-abc must NOT count as inside /work/wt-a
    expect(decideWriteGuard('Edit', { file_path: '/work/wt-abc/x' }, DIRS).allow).toBe(false);
  });

  it('handles NotebookEdit via notebook_path', () => {
    expect(
      decideWriteGuard('NotebookEdit', { notebook_path: '/work/wt-b/n.ipynb' }, DIRS).allow,
    ).toBe(true);
  });

  it('guards MultiEdit by file_path too (consistent with readonly deny, no假设漏洞)', () => {
    expect(decideWriteGuard('MultiEdit', { file_path: '/work/wt-a/x.ts' }, DIRS).allow).toBe(true);
    expect(decideWriteGuard('MultiEdit', { file_path: '/etc/evil' }, DIRS).allow).toBe(false);
  });

  it('denies a Bash redirect to an absolute path outside the dirs (DEFER-1 literal case)', () => {
    expect(decideWriteGuard('Bash', { command: 'echo x > /etc/evil' }, DIRS).allow).toBe(false);
  });

  it('allows a Bash redirect inside a writable dir', () => {
    expect(decideWriteGuard('Bash', { command: 'echo x > /work/wt-a/out.txt' }, DIRS).allow).toBe(
      true,
    );
  });

  it('allows relative-path commands (resolve against the worktree cwd)', () => {
    expect(decideWriteGuard('Bash', { command: 'echo x > out.txt' }, DIRS).allow).toBe(true);
  });

  it('allows read tools unconditionally', () => {
    expect(decideWriteGuard('Read', { file_path: '/etc/passwd' }, DIRS).allow).toBe(true);
    expect(decideWriteGuard('Grep', {}, DIRS).allow).toBe(true);
  });
});

describe('write-guard rendering', () => {
  it('bakes the dirs into a self-contained, transpiler-independent script', () => {
    const script = renderWriteGuardScript(DIRS);
    expect(script).toContain('WRITABLE_DIRS');
    expect(script).toContain('permissionDecision');
    expect(script).toContain('node:path');
    // 不靠 .toString() 嵌入 → 不得残留 bundler helper（否则独立脚本在 node 下 ReferenceError 崩溃）。
    expect(script).not.toContain('__name');
    expect(script).not.toContain('__vite_ssr_import');
  });

  it('settings wire the guard for the path-bearing tools', () => {
    const settings = buildWriteSettings('/tmp/guard.mjs');
    const hook = settings.hooks.PreToolUse[0]!;
    expect(hook.matcher).toContain('Write');
    expect(hook.matcher).toContain('Bash');
    expect(hook.hooks[0]!.command).toContain('/tmp/guard.mjs');
  });
});

// D-04 fail-closed pre-flight（B 阶段）：探针跑真 `node <script>`，验越界写被 deny / 界内写 allow。
describe('probeWriteGuard (D-04 fail-closed pre-flight)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-guard-probe-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const writeScript = (content: string): string => {
    const p = path.join(tmpDir, 'guard.mjs');
    fs.writeFileSync(p, content);
    return p;
  };
  // 一个直接写定 permissionDecision 的最小 hook（读完 stdin 即应答），用于模拟 hook 行为。
  const fixedDecisionScript = (decision: 'allow' | 'deny') =>
    `let r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'${decision}'}})));`;

  it('passes against the REAL rendered guard (denies outside, allows inside)', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(wt);
    const script = writeScript(renderWriteGuardScript([wt]));
    expect(await probeWriteGuard(script, [wt])).toEqual({ ok: true });
  });

  it('fails closed when the hook does NOT deny an out-of-worktree write (always-allow regression)', async () => {
    const script = writeScript(fixedDecisionScript('allow'));
    const r = await probeWriteGuard(script, [path.join(tmpDir, 'wt')]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('未拦截越界写');
  });

  it('fails closed when the hook over-kills an in-worktree write (always-deny)', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(wt);
    const script = writeScript(fixedDecisionScript('deny'));
    const r = await probeWriteGuard(script, [wt]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('误杀');
  });

  it('fails closed when node cannot run the script (missing file → no decision)', async () => {
    const r = await probeWriteGuard(path.join(tmpDir, 'nope.mjs'), [tmpDir]);
    expect(r.ok).toBe(false);
  });

  it('fails closed when the hook output is unparseable garbage', async () => {
    const script = writeScript(
      `process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.stdout.write('not json'));`,
    );
    const r = await probeWriteGuard(script, [tmpDir]);
    expect(r.ok).toBe(false);
  });
});

// 反漂移 + 真跑：渲染脚本经真 `node` 执行，逐例判定必须与 decideWriteGuard 一致（脚本是手写串、
// 与纯核心两套实现，靠这条锁同步；也证明脚本在 node 下真能跑、不被打包器污染）。
describe('rendered guard parity (node 执行 == decideWriteGuard)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-guard-parity-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const runHook = (scriptPath: string, payload: unknown): Promise<string | undefined> =>
    new Promise((resolve) => {
      const child = execFile('node', [scriptPath], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        try {
          resolve(JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision);
        } catch {
          resolve(undefined);
        }
      });
      child.stdin?.end(JSON.stringify(payload));
    });

  it('matches decideWriteGuard across Write/Edit/NotebookEdit/Bash/Read cases', async () => {
    const wt = path.join(tmpDir, 'wt');
    fs.mkdirSync(wt);
    const dirs = [wt];
    const scriptPath = path.join(tmpDir, 'guard.mjs');
    fs.writeFileSync(scriptPath, renderWriteGuardScript(dirs));
    const cases: Array<{ tool_name: string; tool_input: unknown }> = [
      { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'a.ts') } }, // inside → allow
      { tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } }, // outside → deny
      { tool_name: 'Edit', tool_input: { file_path: `${wt}abc/x` } }, // prefix-escape → deny
      { tool_name: 'MultiEdit', tool_input: { file_path: path.join(wt, 'm.ts') } }, // inside → allow
      { tool_name: 'MultiEdit', tool_input: { file_path: '/etc/evil' } }, // outside → deny
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(wt, 'n.ipynb') } }, // allow
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/etc/n.ipynb' } }, // outside → deny
      { tool_name: 'Bash', tool_input: { command: 'echo x > /etc/evil' } }, // outside redirect → deny
      { tool_name: 'Bash', tool_input: { command: `echo x > ${path.join(wt, 'o.txt')}` } }, // allow
      { tool_name: 'Bash', tool_input: { command: 'echo x > out.txt' } }, // relative redirect → allow
      { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }, // read → allow
    ];
    for (const c of cases) {
      const fromScript = await runHook(scriptPath, c);
      const expected = decideWriteGuard(c.tool_name, c.tool_input, dirs).allow ? 'allow' : 'deny';
      expect(fromScript, `${c.tool_name} ${JSON.stringify(c.tool_input)}`).toBe(expected);
    }
  });
});
