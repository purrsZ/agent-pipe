import * as path from 'node:path';

/**
 * PreToolUse path guard for the write permission profile (D-04). This is the REAL
 * constraint behind the write profile: `--add-dir` only widens scope, it never narrows
 * writes, so a hook that vets every Write/Edit/Bash target path against the allowed
 * directories is the only thing that actually keeps an agent inside its worktree.
 *
 * `decideWriteGuard` is the single source of truth — it is unit-tested directly AND
 * embedded verbatim (via Function.prototype.toString) into the standalone hook script the
 * runner materialises, so the tested logic is exactly the logic Claude executes.
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
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
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
  return [
    `import * as path from 'node:path';`,
    `const WRITABLE_DIRS = ${JSON.stringify(dirs)};`,
    decideWriteGuard.toString(),
    `let raw = '';`,
    `process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', (c) => { raw += c; });`,
    `process.stdin.on('end', () => {`,
    `  let input = {};`,
    `  try { input = JSON.parse(raw) || {}; } catch {}`,
    `  const verdict = decideWriteGuard(input.tool_name, input.tool_input, WRITABLE_DIRS);`,
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
          matcher: 'Write|Edit|NotebookEdit|Bash',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(scriptPath)}` }],
        },
      ],
    },
  };
}
