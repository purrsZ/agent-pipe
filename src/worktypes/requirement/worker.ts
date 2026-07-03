import type { PermissionProfile } from '../../workitems/types.js';
import type { ContractSnapshot } from './contract.js';

// worker-runtime pure helpers (worktypes layer; pure — the effect handler that uses these
// lives in the async effects layer). These are the testable cores of R11/R12: the write
// prompt (去 probe 的"只读不改"), the workitems→agents write mapping, and the two-class
// self-test gate.

export interface WorkerPromptInput {
  title: string; // the requirement / task-card brief
  repo: string; // the repo this worker owns (one repo = one worker)
  contract?: ContractSnapshot; // frozen对接合同 — the worker codes against it
  knowledge?: string; // selective repo knowledge injection (R16, Stage 5)
  reworkNote?: string; // when this is a replacement: 原活 + 接口改了哪 + 为何
  steeringNote?: string; // WS-2.5：用户中途经 steer 给本仓的指示（steering/<repo>.md），最高优先级
}

// D-23: the system句 must be rewritten — probe says "只读、不要修改任何文件", which contradicts
// a write worker. This composes a self-contained write prompt (works after a单飞 wake / batch
// re-dispatch, no reliance on session memory).
export function composeWorkerPrompt(input: WorkerPromptInput): string {
  const lines: string[] = [
    '你是一名全栈工程师，负责在当前工作目录（一个独立 worktree）内实现下面这一仓的改动。',
    '你可以读写当前 worktree 内的文件、运行构建与测试；但不要触碰 worktree 以外的路径。',
    '完成后跑绿本端单测 + 类型/编译 + 跨端契约测试，并产出结构化报告（改了什么 / 依据合同哪几条 / 自测结果）。',
    '',
    `# 任务（仓库：${input.repo || '(未指定)'}）`,
    input.title,
  ];
  const slice = input.contract ? renderContractForRepo(input.contract, input.repo) : '';
  if (slice) {
    lines.push('', '# 冻结的对接合同（按本仓相关接口）', slice);
  }
  if (input.knowledge && input.knowledge.trim()) {
    lines.push('', '# 该仓知识（架构/约定/构建测试命令/坑）', input.knowledge.trim());
  }
  if (input.reworkNote && input.reworkNote.trim()) {
    lines.push(
      '',
      '# 定向施工指令（在本仓现有产出基础上执行，不要从零重来）',
      input.reworkNote.trim(),
    );
  }
  // WS-2.5：用户在推进中途经 steer 给本仓的指示（steer_apply 落 steering/<repo>.md）——优先级最高，按此调整。
  if (input.steeringNote?.trim()) {
    lines.push('', '# 用户中途给本仓的指示（最高优先级，按此调整）', input.steeringNote.trim());
  }
  // 监工科层（C，rule #5 疑则上报）：冻结的跨仓契约由系统冻结、**不可擅改**。如你必须偏离契约、或你的
  // 改动会外溢到别仓依赖的接口、或你拿不准是否碰了跨仓约束——别自己拍板改契约，在报告**最末尾**输出一个
  // ```gatekeeper 块上报，交独立监工裁决（疑则就报、只会多报，安全）：
  lines.push(
    '',
    '# 图纸疑问上报（冻结契约不可擅改 · 疑则上报，交监工裁决）',
    '若需偏离冻结的跨仓契约 / 改动可能外溢到别仓依赖的接口 / 拿不准是否碰了跨仓约束，请在报告最末尾输出',
    '且仅输出一个 ```gatekeeper 块（没有就别输出）。碰到跨仓契约接口时**务必**填它的 interfaceId：',
    '```gatekeeper',
    '{ "raises": [ { "interfaceId": "碰到的跨仓契约接口 id（纯本仓内部疑问则留空）", "question": "要偏离/协调什么", "repo": "本仓路径" } ] }',
    '```',
  );
  return lines.join('\n');
}

// Render the contract interfaces relevant to a repo: the ones it provides + the ones it
// consumes (so a worker sees both its obligations and its upstream dependencies).
export function renderContractForRepo(contract: ContractSnapshot, repo: string): string {
  const relevant = contract.interfaces.filter(
    (i) => i.providerRepo === repo || i.consumerRepos.includes(repo),
  );
  if (relevant.length === 0) return '';
  return relevant
    .map((i) => {
      const role = i.providerRepo === repo ? '提供' : '调用';
      const fields = i.fields.map((f) => `${f.name}: ${f.type}${f.optional ? '?' : ''}`).join(', ');
      return `- [${role}] ${i.signature}  字段: { ${fields} }`;
    })
    .join('\n');
}

// R04.AC-1/AC-6: workitems {mode:'write', repos} → agents {mode:'write', writableDirs}. The
// agents layer knows only paths. NEVER map to 'full' (that drops the dir limit). cwd +
// writableDirs share the same worktree path (R05.AC-7) — the caller passes the resolved path.
export function mapWritePermission(worktreePath: string): {
  permission: PermissionProfile;
  writableDirs: string[];
} {
  return { permission: { mode: 'write' }, writableDirs: [worktreePath] };
}

// R11.AC-3/AC-6/AC-7: the self-test gate. Two classes of "not green":
//   - assertion-failed → retry/返工 (the code is wrong).
//   - cannot-execute (command missing / env / build infra / runbook stale) → 不进 retry,直接
//     举手 + 病历标根因 (otherwise it burns the retry budget forever).
export interface TestOutcome {
  ran: boolean; // did the test command actually execute to a verdict?
  passed: boolean; // (only meaningful if ran)
  hasResultArtifact?: boolean; // produced a result file (junit etc.) — distinguishes真跑过
  reason?: string; // root cause for the病历 when cannot-execute
}

export type TestVerdict = 'pass' | 'assertion-failed' | 'cannot-execute';

export function classifyTestResult(o: TestOutcome): TestVerdict {
  if (o.ran && o.passed) return 'pass';
  // ran to a verdict (or produced a result artifact) but red → genuine assertion failure.
  if (o.ran || o.hasResultArtifact) return 'assertion-failed';
  // never executed: command missing / compile broke / no result → infra problem, not the code.
  return 'cannot-execute';
}

// Whether a verdict should consume a retry (assertion) vs raise-hand immediately (infra).
export function shouldRetry(verdict: TestVerdict): boolean {
  return verdict === 'assertion-failed';
}
