import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePathFor } from '../../src/agents/worktree.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { createRequirementRunStrategy } from '../../src/worktypes/requirement/worker-handler.js';
import { makeAssignment, makeWorkItem } from '../helpers/workitems.js';

let tmpDir: string;
let repoPath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-req-worker-'));
  repoPath = path.join(tmpDir, 'backend-repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t']);
  git(repoPath, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'base']);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('requirement worker run strategy (write profile + worktree)', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const strategy = () => createRequirementRunStrategy({ worktreesDir: worktreesDir() });
  const item = () => makeWorkItem('wi-1', { type: 'requirement', repos: [repoPath] });
  const worker = () => makeAssignment('as-w1', 'wi-1', { role: 'worker', repo: repoPath });
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('worker: cwd is its own worktree, options are WRITE (never full), prompt has no readonly句', () => {
    const s = strategy();
    const cwd = s.resolveCwd({ workitem: item(), assignment: worker(), defaultCwd: '/x' });
    expect(cwd).toBe(worktreePathFor(worktreesDir(), 'wi-1', 'as-w1', repoPath));

    const opts = s.runOptions({ workitem: item(), assignment: worker(), cwd });
    expect(opts.permission).toEqual({ mode: 'write' });
    expect(opts.writableDirs).toEqual([cwd]);

    const prompt = s.composePrompt({
      title: '加下单接口',
      followups: [],
      workitem: item(),
      assignment: worker(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).not.toContain('只读');
    expect(prompt).toContain('加下单接口');
  });

  it('owner: readonly, cwd falls back to repo, prompt is the coordinator句', () => {
    const s = strategy();
    const opts = s.runOptions({ workitem: item(), assignment: owner(), cwd: repoPath });
    expect(opts.permission).toEqual({ mode: 'readonly' });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('包工头');
  });

  it('owner readonly run can READ every involved repo (--add-dir 全仓), not just cwd=repos[0]', () => {
    const s = strategy();
    const multi = makeWorkItem('wi-1', {
      type: 'requirement',
      repos: ['/repos/pos', '/repos/portal', '   '],
    });
    const opts = s.runOptions({ workitem: multi, assignment: owner(), cwd: '/repos/pos' });
    expect(opts.permission).toEqual({ mode: 'readonly' });
    // 真机暴露：理解 run 只看了第一个仓。readableDirs 把每个非空仓都列进去（去空白）。
    expect(opts.readableDirs).toEqual(['/repos/pos', '/repos/portal']);
  });

  it('owner 协调(assess) prompt 接上立项书 + 多仓清单（修「立项后还问 PRD」「只看一个仓」）', () => {
    const s = strategy();
    const multi = makeWorkItem('wi-1', {
      type: 'requirement',
      phase: PHASE.implement, // 实现批次 assess = 通用包工头 prompt
      repos: ['/repos/pos', '/repos/portal'],
    });
    const brief =
      '# 立项书\n\n## PRD 摘要\n扩展 reopen 支持 QSR\n\n## 验收标准 / 完成定义\n人工验收无误';
    const prompt = s.composePrompt({
      title: '扩展reopen支持场景',
      followups: [],
      workitem: multi,
      assignment: owner(),
      batch: [],
      readArtifact: (rel) => (rel === 'intake/intake.md' ? brief : undefined),
    });
    expect(prompt).toContain('包工头');
    expect(prompt).toContain('立项书'); // 立项收的料喂进 assess，不再向用户索要
    expect(prompt).toContain('扩展 reopen 支持 QSR'); // PRD 摘要在场
    expect(prompt).toContain('人工验收无误'); // 验收在场
    expect(prompt).toContain('- /repos/pos'); // 两个仓都列出
    expect(prompt).toContain('- /repos/portal');
  });

  it('owner 协调 prompt 把人类反馈(followups)作为最高优先级喂进去', () => {
    const s = strategy();
    const assessItem = makeWorkItem('wi-1', {
      type: 'requirement',
      phase: PHASE.implement,
      repos: [repoPath],
    });
    const prompt = s.composePrompt({
      title: 't',
      followups: ['主线不是 QSR，是已结算卡单', '后端接口先不动'],
      workitem: assessItem,
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('反馈');
    expect(prompt).toContain('主线不是 QSR，是已结算卡单');
    expect(prompt).toContain('后端接口先不动');
  });

  it('prepareWorkspace creates the worktree off base; canResume tracks dirty + session', () => {
    const s = strategy();
    const wi = item();
    const w = worker();
    const cwd = s.resolveCwd({ workitem: wi, assignment: w, defaultCwd: '/x' });

    s.prepareWorkspace({ workitem: wi, assignment: w, cwd });
    expect(fs.existsSync(path.join(cwd, 'README.md'))).toBe(true); // worktree checked out

    // no session yet → cannot resume.
    expect(s.canResume({}, w, wi)).toBe(false);

    // session present + clean worktree → resume OK.
    const withSession = makeAssignment('as-w1', 'wi-1', {
      role: 'worker',
      repo: repoPath,
      agentSessionId: 'sess-1',
    });
    expect(s.canResume({}, withSession, wi)).toBe(true);

    // dirty worktree → must reset+redispatch, not resume.
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'x');
    expect(s.canResume({}, withSession, wi)).toBe(false);
  });

  it('composePrompt renders the frozen contract slice from the artifact repo', () => {
    const s = strategy();
    const contract = JSON.stringify({
      version: 'v1',
      fingerprint: 'fp',
      interfaces: [
        {
          id: 'getOrder',
          signature: 'GET /orders/:id',
          providerRepo: repoPath,
          consumerRepos: [],
          fields: [{ name: 'id', type: 'string', optional: false }],
        },
      ],
    });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(),
      assignment: worker(),
      batch: [],
      readArtifact: (rel) => (rel === 'contract/contract.json' ? contract : undefined),
    });
    expect(prompt).toContain('GET /orders/:id');
    expect(prompt).toContain('冻结的对接合同');
  });

  it('worker prompt injects the repo knowledge block from knowledgeFor (Stage 5 选择性注入)', () => {
    const s = createRequirementRunStrategy({
      worktreesDir: worktreesDir(),
      knowledgeFor: (repo) => (repo === repoPath ? '## runbook\nnpm test' : undefined),
    });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(),
      assignment: worker(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('该仓知识'); // the knowledge section header in composeWorkerPrompt
    expect(prompt).toContain('npm test');
  });

  it('the owner prompt never consults knowledgeFor (only workers get repo knowledge)', () => {
    const seen: string[] = [];
    const s = createRequirementRunStrategy({
      worktreesDir: worktreesDir(),
      knowledgeFor: (repo) => {
        seen.push(repo);
        return 'X';
      },
    });
    s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(), // default phase → assess/coordinator branch, not the reconcile run
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(seen).toEqual([]); // owner branch returns before touching knowledgeFor
  });
});

// PIVOT §3.1：「拆解」phase 的 owner run = 跨仓对账 run（替代被砍的 spec-design 合同 run）。
describe('requirement 跨仓对账 run (拆解 phase owner)', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const splitItem = () =>
    makeWorkItem('wi-1', {
      type: 'requirement',
      phase: PHASE.split,
      repos: ['/repos/backend', '/repos/frontend'],
    });
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('composePrompt for an owner in the 拆解 phase is the reconcile run (对账, 不 consult knowledgeFor)', () => {
    const seen: string[] = [];
    const s = createRequirementRunStrategy({
      worktreesDir: worktreesDir(),
      knowledgeFor: (repo) => {
        seen.push(repo);
        return '## map\nNestJS';
      },
    });
    const prompt = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: splitItem(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('对账'); // 跨仓对账，不是产设计、不是 assess
    expect(prompt).toContain('```json'); // structured 跨仓契约 + unresolved instruction
    expect(prompt).toContain('- /repos/backend');
    expect(prompt).toContain('- /repos/frontend');
    expect(prompt).not.toContain('批次评估'); // 不是 assess 协调 prompt
    expect(seen).toEqual([]); // 对账 run 不读各仓知识 map（只有 worker 读）
  });

  it('the reconcile run weaves in 立项书 from intake/intake.md (优雅降级 when absent)', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const brief = '# 立项书：下单\n\n## 验收标准 / 完成定义\n下单成功返回单号';
    const withBrief = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: splitItem(),
      assignment: owner(),
      batch: [],
      readArtifact: (rel) => (rel === 'intake/intake.md' ? brief : undefined),
    });
    expect(withBrief).toContain('立项书'); // 立项书定位各仓设计目录
    expect(withBrief).toContain('下单成功返回单号');

    const without = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: splitItem(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(without).not.toContain('立项书');
  });

  it('the reconcile run also weaves in 人类反馈(followups)（人改单仓设计后重对账）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const prompt = s.composePrompt({
      title: '加跨端下单接口',
      followups: ['B 仓接口已改名为 createOrderV2，重新对账'],
      workitem: splitItem(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('B 仓接口已改名为 createOrderV2，重新对账');
  });

  it('afterRun 升格 the report block → contract/reconcile.json + contract/contract.json (only owner + 拆解)', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const report = [
      '对账结论……',
      '```json',
      JSON.stringify({
        interfaces: [
          {
            id: 'createOrder',
            signature: 'POST /orders',
            providerRepo: '/repos/backend',
            consumerRepos: ['/repos/frontend'],
            fields: [{ name: 'amount', type: 'number', optional: false }],
          },
        ],
        unresolved: [
          {
            kind: 'dangling',
            interfaceId: 'getCoupon',
            detail: 'frontend 调用但无人提供',
            repos: ['/repos/frontend'],
          },
        ],
      }),
      '```',
    ].join('\n');
    const writes: Array<{ relPath: string; content: string }> = [];
    s.afterRun?.({
      report,
      workitem: splitItem(),
      assignment: owner(),
      writeArtifact: (relPath, content) => writes.push({ relPath, content }),
    });
    const byPath = new Map(writes.map((w) => [w.relPath, w.content]));
    // 两份产物：完整对账结果 + 升格的跨仓契约快照。
    const reconcile = JSON.parse(byPath.get('contract/reconcile.json') ?? '{}');
    expect(reconcile.interfaces).toHaveLength(1);
    expect(reconcile.unresolved).toHaveLength(1);
    expect(reconcile.unresolved[0]).toMatchObject({ kind: 'dangling', interfaceId: 'getCoupon' });
    const snap = JSON.parse(byPath.get('contract/contract.json') ?? '{}');
    expect(snap.interfaces).toHaveLength(1);
    expect(snap.interfaces[0]).toMatchObject({ id: 'createOrder', providerRepo: '/repos/backend' });
    expect(typeof snap.fingerprint).toBe('string'); // reconcileToContract→promoteToContract computed it
  });

  it('afterRun is inert for a worker, or for an owner outside the 拆解 phase', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const report =
      '```json\n{"interfaces":[{"id":"x","signature":"s","providerRepo":"/repos/backend"}]}\n```';
    const writes: string[] = [];
    const sink = (relPath: string) => writes.push(relPath);
    // worker in 拆解 phase → no 对账升格
    s.afterRun?.({
      report,
      workitem: splitItem(),
      assignment: makeAssignment('as-w', 'wi-1', { role: 'worker', repo: '/repos/backend' }),
      writeArtifact: sink,
    });
    // owner in 集成验证 phase（既非拆解对账、也非实现 assess）→ 无 afterRun 产物
    s.afterRun?.({
      report,
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.integrate,
        repos: ['/repos/backend'],
      }),
      assignment: owner(),
      writeArtifact: sink,
    });
    expect(writes).toEqual([]);
  });

  it('afterRun on a report with no block writes EMPTY reconcile + EMPTY contract (never throws)', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const writes: Array<{ relPath: string; content: string }> = [];
    s.afterRun?.({
      report: '对账结论，但忘了输出 json 块',
      workitem: splitItem(),
      assignment: owner(),
      writeArtifact: (relPath, content) => writes.push({ relPath, content }),
    });
    const byPath = new Map(writes.map((w) => [w.relPath, w.content]));
    expect(JSON.parse(byPath.get('contract/reconcile.json') ?? '{}').interfaces).toEqual([]);
    expect(JSON.parse(byPath.get('contract/contract.json') ?? '{}').interfaces).toEqual([]);
  });
});

// PIVOT 灯③ 实现侧：owner assess（并行实现 phase）登记实际实现的接口 → contract/impl-claims.json。
describe('requirement assess 实现登记 (并行实现 phase owner → impl-claims.json)', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const implItem = () =>
    makeWorkItem('wi-1', {
      type: 'requirement',
      phase: PHASE.implement,
      repos: ['/repos/backend'],
    });
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('assess 报告末尾的实现接口块 → contract/impl-claims.json（灯③ 对账的实现侧输入）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const report = [
      '批次评估：三仓均已实现、自测绿。',
      '```json',
      JSON.stringify({
        interfaces: [
          {
            id: 'createOrder',
            signature: 'POST /orders',
            providerRepo: '/repos/backend',
            consumerRepos: ['/repos/frontend'],
          },
        ],
      }),
      '```',
    ].join('\n');
    const writes: Array<{ relPath: string; content: string }> = [];
    s.afterRun?.({
      report,
      workitem: implItem(),
      assignment: owner(),
      writeArtifact: (relPath, content) => writes.push({ relPath, content }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.relPath).toBe('contract/impl-claims.json');
    const claims = JSON.parse(writes[0]?.content ?? '{}');
    expect(claims.interfaces).toHaveLength(1);
    expect(claims.interfaces[0]).toMatchObject({
      id: 'createOrder',
      providerRepo: '/repos/backend',
    });
  });

  it('assess 报告无实现块 → 不写 impl-claims.json（让集成 no_claims 优雅放行，不强判失败）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const writes: string[] = [];
    s.afterRun?.({
      report: '批次评估，但没登记接口块',
      workitem: implItem(),
      assignment: owner(),
      writeArtifact: (relPath) => writes.push(relPath),
    });
    expect(writes).toEqual([]);
  });

  it('assess prompt 末尾要求登记实现接口的 json 块', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: implItem(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('实际已实现');
    expect(prompt).toContain('```json');
  });

  it('assess 聚合各仓工人完成回执（priorReportPaths → 读 report.md → 喂进 prompt）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const reports: Record<string, string> = {
      'assignments/as-w1/report.md': '后端：实现 POST /orders，依据契约 createOrder，自测 12/12 绿',
      'assignments/as-w2/report.md': '前端：接 createOrder，自测 8/8 绿',
    };
    const prompt = s.composePrompt({
      title: '加跨端下单',
      followups: [],
      priorReportPaths: ['assignments/as-w1/report.md', 'assignments/as-w2/report.md'],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.implement,
        repos: ['/repos/backend', '/repos/frontend'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: (rel) => reports[rel],
    });
    expect(prompt).toContain('各仓工人完成回执');
    expect(prompt).toContain('实现 POST /orders，依据契约 createOrder，自测 12/12 绿');
    expect(prompt).toContain('前端：接 createOrder');
  });

  it('assess 织入监工裁决回写图纸（gatekeeper-log.md），让回写真被消费（C rule #2）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      priorReportPaths: [],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.implement,
        repos: ['/repos/backend'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: (rel) =>
        rel === 'contract/gatekeeper-log.md'
          ? '# 监工裁决 · 回写图纸\n判小（自治放行）: 本仓重构了缓存层'
          : undefined,
    });
    expect(prompt).toContain('监工裁决');
    expect(prompt).toContain('本仓重构了缓存层');
  });
});

// ENHANCE E1：参谋 run（owner, stage=advise）——composePrompt 路由到 composeAdvisePrompt（事故单 + 全景 + 只出建议）。
describe('requirement 事故参谋 run (stage=advise owner → composeAdvisePrompt)', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('composePrompt 参谋分支：织入事故单(incident) + 参谋角色 + 仅供参考结尾；不产 steer 块', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const prompt = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.implement,
        repos: ['/repos/backend'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
      effectPayload: { stage: 'advise', incident: '事故类型：监工判大——要给 createOrder 加字段' },
    });
    expect(prompt).toContain('参谋'); // 参谋角色（非包工头）
    expect(prompt).toContain('要给 createOrder 加字段'); // incident 织入
    expect(prompt).toContain('以上仅供参考'); // 固定结尾提示
    expect(prompt).not.toContain('```steer'); // 参谋零行动权，不产 steer 块
  });

  it('E2：参谋 prompt 织入大事记（events → renderEventDigest → 大事记标题 + 内容）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.implement,
        repos: ['/repos/backend'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
      effectPayload: { stage: 'advise', incident: 'x' },
      events: [
        {
          id: 1,
          workitemId: 'wi-1',
          seq: 1,
          kind: 'gatekeeper_big',
          payload: { raises: [{ interfaceId: 'createOrder', repo: '/repos/backend' }] },
          createdAt: 1000,
        },
      ],
    });
    expect(prompt).toContain('本单大事记'); // 大事记标题织入
    expect(prompt).toContain('监工判大'); // digest 内容织入
  });
});

// ENHANCE E2：包工头(steer) prompt 同样织入大事记（reconcile/assess 不织，见 E2.3）。
describe('requirement steer run 织入大事记 (stage=steer)', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('steer prompt 含大事记标题 + phase 变迁行', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const prompt = s.composePrompt({
      title: 't',
      followups: ['随手一句'],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.implement,
        repos: ['/repos/backend'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
      effectPayload: { stage: 'steer' },
      events: [
        {
          id: 1,
          workitemId: 'wi-1',
          seq: 1,
          kind: 'phase_changed',
          payload: { to: 'requirement:并行实现', reason: 'reconcile_passed' },
          createdAt: 1000,
        },
      ],
    });
    expect(prompt).toContain('包工头');
    expect(prompt).toContain('本单大事记');
    expect(prompt).toContain('对账通过'); // digest reason 人话织入
  });

  it('reconcile / assess prompt 不织大事记（E2.3：窄上下文防膨胀）', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const events = [
      {
        id: 1,
        workitemId: 'wi-1',
        seq: 1,
        kind: 'phase_changed',
        payload: { to: 'requirement:并行实现', reason: 'reconcile_passed' },
        createdAt: 1000,
      },
    ];
    // 拆解 phase owner → reconcile prompt
    const reconcile = s.composePrompt({
      title: 't',
      followups: [],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.split,
        repos: ['/a', '/b'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
      events,
    });
    expect(reconcile).not.toContain('本单大事记');
    // 实现 phase owner → assess prompt
    const assess = s.composePrompt({
      title: 't',
      followups: [],
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.implement,
        repos: ['/repos/backend'],
      }),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
      events,
    });
    expect(assess).not.toContain('本单大事记');
  });
});
