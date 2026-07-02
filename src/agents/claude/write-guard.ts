import { execFile } from 'node:child_process';
import * as path from 'node:path';

/**
 * PreToolUse path guard for the write permission profile (D-04). This is the REAL
 * constraint behind the write profile: `--add-dir` only widens scope, it never narrows
 * writes, so a hook that vets every Write/Edit/Bash target path against the allowed
 * directories is the only thing that actually keeps an agent inside its worktree.
 *
 * `decideWriteGuard` is the unit-tested pure core. The standalone hook script the runner
 * materialises embeds the SAME logic as a HAND-WRITTEN, transpiler-independent string (NOT
 * `Function.prototype.toString`): a `.toString()` of the in-process function is rewritten by
 * the bundler — esbuild/tsx wrap inner functions as `__name(fn,…)`, vitest's SSR transform
 * rewrites `path.resolve` → `__vite_ssr_import_1__.resolve` — and the standalone script then
 * crashes with `ReferenceError` → the hook errors → Claude treats it as ALLOW → the write agent
 * runs UNGUARDED. (This was a live bug: `npm start` runs via tsx.) The hand-written string has
 * no such references, so it runs under plain `node` regardless of how agent-pipe was bundled.
 * A parity test (run the rendered script via node, compare verdicts to decideWriteGuard) keeps
 * the two in lockstep; the D-04 pre-flight probe (probeWriteGuard) is the runtime backstop.
 *
 * Known residual (DEFER-1, intentionally not chased to 100%): Bash path extraction is
 * best-effort. A literal `echo x > /etc/evil` is denied; an indirected `VAR=/etc/evil;
 * echo x > $VAR` is not detected. The write profile explicitly does not depend on an OS
 * sandbox — that is a Codex/investigation concern.
 */
export function decideWriteGuard(
  toolName: string,
  toolInput: unknown,
  writableDirs: string[],
): { allow: boolean; reason?: string } {
  const isInsideAny = (target: string): boolean => {
    const resolved = path.resolve(target);
    return writableDirs.some((d) => {
      const parent = path.resolve(d);
      const rel = path.relative(parent, resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  };
  const input = (toolInput ?? {}) as Record<string, unknown>;
  // MultiEdit 与 Edit 同形（file_path + edits[]）。即便 D-22 认定它已并入 Edit、可能不存在，把它一并纳入
  // 也零成本消除假设风险（deny 一个不存在的工具无副作用，且 readonly profile 也显式 deny 它，保持一致）。
  if (
    toolName === 'Write' ||
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'NotebookEdit'
  ) {
    const fp =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : undefined;
    if (!fp) return { allow: true };
    return isInsideAny(fp)
      ? { allow: true }
      : { allow: false, reason: `write to ${fp} is outside the writable worktree` };
  }
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    const redirects = [...cmd.matchAll(/>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)].map((m) =>
      (m[1] ?? '').replace(/^['"]|['"]$/g, ''),
    );
    for (const t of redirects) {
      if (t && path.isAbsolute(t) && !isInsideAny(t)) {
        return { allow: false, reason: `bash redirect to ${t} is outside the writable worktree` };
      }
    }
    return { allow: true };
  }
  return { allow: true };
}

/**
 * Render the standalone PreToolUse hook script for a fixed writable-dir set. The script is
 * self-contained (only node:path) — it bakes the dirs + embeds decideWriteGuard verbatim,
 * reads the PreToolUse JSON on stdin, and emits Claude's permissionDecision envelope.
 */
export function renderWriteGuardScript(writableDirs: string[]): string {
  const dirs = writableDirs.map((d) => path.resolve(d));
  // Hand-written, transpiler-independent. Mirrors decideWriteGuard exactly (parity-tested). Only
  // references `path` (imported here) — no closure over bundler helpers, so it runs under node
  // no matter how agent-pipe itself was bundled.
  return [
    `import * as path from 'node:path';`,
    `const WRITABLE_DIRS = ${JSON.stringify(dirs)};`,
    `function isInsideAny(target) {`,
    `  const resolved = path.resolve(target);`,
    `  return WRITABLE_DIRS.some((d) => {`,
    `    const parent = path.resolve(d);`,
    `    const rel = path.relative(parent, resolved);`,
    `    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));`,
    `  });`,
    `}`,
    `function decide(toolName, toolInput) {`,
    `  const input = toolInput || {};`,
    `  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {`,
    `    const fp = typeof input.file_path === 'string' ? input.file_path`,
    `      : (typeof input.notebook_path === 'string' ? input.notebook_path : undefined);`,
    `    if (!fp) return { allow: true };`,
    `    return isInsideAny(fp) ? { allow: true }`,
    `      : { allow: false, reason: 'write to ' + fp + ' is outside the writable worktree' };`,
    `  }`,
    `  if (toolName === 'Bash') {`,
    `    const cmd = typeof input.command === 'string' ? input.command : '';`,
    `    const redirects = [...cmd.matchAll(/>>?\\s*("[^"]+"|'[^']+'|[^\\s;|&]+)/g)]`,
    `      .map((m) => (m[1] || '').replace(/^['"]|['"]$/g, ''));`,
    `    for (const t of redirects) {`,
    `      if (t && path.isAbsolute(t) && !isInsideAny(t))`,
    `        return { allow: false, reason: 'bash redirect to ' + t + ' is outside the writable worktree' };`,
    `    }`,
    `    return { allow: true };`,
    `  }`,
    `  return { allow: true };`,
    `}`,
    `let raw = '';`,
    `process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', (c) => { raw += c; });`,
    `process.stdin.on('end', () => {`,
    `  let input = {};`,
    `  try { input = JSON.parse(raw) || {}; } catch {}`,
    `  const verdict = decide(input.tool_name, input.tool_input);`,
    `  const out = verdict.allow`,
    `    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }`,
    `    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };`,
    `  process.stdout.write(JSON.stringify(out));`,
    `});`,
  ].join('\n');
}

/**
 * Claude `--settings` payload that wires the rendered hook for the write-relevant tools.
 * The matcher covers the path-bearing tools; everything else falls through to Claude's
 * default (read tools are auto-allowed in -p mode, same as the readonly profile relies on).
 */
export function buildWriteSettings(scriptPath: string): {
  hooks: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
  };
} {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(scriptPath)}` }],
        },
      ],
    },
  };
}

/**
 * D-04 fail-closed pre-flight probe (B 阶段). The write profile's ONLY real constraint is the
 * PreToolUse guard hook actually running and denying out-of-worktree writes. If the hook does
 * NOT fire (node missing from PATH, the script crashed/garbled, Claude didn't honour --settings,
 * a logic regression), the write agent would run completely unguarded and could write anywhere.
 *
 * Before letting a write run proceed, this probe invokes the SAME `node <script>` the hook uses,
 * feeding it two synthetic PreToolUse payloads, and asserts the verdicts:
 *   - a write to a path OUTSIDE every writable dir → MUST be `deny` (the guard has teeth);
 *   - a write INSIDE the worktree → MUST be `allow` (the guard isn't over-killing).
 * Any deviation (or node failing to run the script) ⇒ `ok:false` ⇒ the runner fails closed
 * (aborts the run → run_failed → 病历), rather than running an unguarded write agent.
 */
export async function probeWriteGuard(
  scriptPath: string,
  writableDirs: string[],
): Promise<{ ok: boolean; reason?: string }> {
  // A path guaranteed outside any conceivable worktree (absolute, top-level sentinel dir).
  const outside = path.join(path.sep, '__agent_pipe_guard_probe_DENY__', 'x.txt');
  const denied = await runGuardHook(scriptPath, {
    tool_name: 'Write',
    tool_input: { file_path: outside },
  });
  if (denied.decision !== 'deny') {
    return {
      ok: false,
      reason: `PreToolUse 写权限 hook 未拦截越界写（期望 deny，实得 ${denied.decision ?? denied.error ?? 'no-decision'}）`,
    };
  }
  const dir = writableDirs.find((d) => typeof d === 'string' && d.trim().length > 0);
  if (dir) {
    const allowed = await runGuardHook(scriptPath, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(path.resolve(dir), '__guard_probe_ALLOW__.txt') },
    });
    if (allowed.decision !== 'allow') {
      return {
        ok: false,
        reason: `PreToolUse 写权限 hook 误杀 worktree 内写（期望 allow，实得 ${allowed.decision ?? allowed.error ?? 'no-decision'}）`,
      };
    }
  }
  return { ok: true };
}

// Run the materialised guard script exactly as Claude would (`node <script>`, PreToolUse JSON on
// stdin) and read back its permissionDecision. Never throws — a node failure / unparseable output
// surfaces as { error } so the caller treats it as a probe failure (fail-closed).
function runGuardHook(
  scriptPath: string,
  payload: unknown,
): Promise<{ decision?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [scriptPath],
      { timeout: 5000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          resolve({ error: String(err.message ?? err).slice(0, 160) });
          return;
        }
        try {
          const out = JSON.parse(stdout) as {
            hookSpecificOutput?: { permissionDecision?: unknown };
          };
          const decision = out?.hookSpecificOutput?.permissionDecision;
          resolve({ decision: typeof decision === 'string' ? decision : undefined });
        } catch {
          resolve({ error: 'unparseable hook output' });
        }
      },
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}
