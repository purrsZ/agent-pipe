import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ArchitectureViolation {
  file: string;
  rule:
    | 'kernel-imports-upper-layer'
    | 'kernel-business-vocabulary'
    | 'workitems-imports-worktypes'
    | 'phase-interpreted-by-container';
  detail: string;
}

type Layer = 'kernel' | 'kernel-exempt' | 'workitems' | 'worktypes';

const IMPORT_RE = /\bimport\b(?:[\s\S]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const KERNEL_BUSINESS_RE = /\b(workitem|workitems|assignment|worktype|phase)\b/i;
const PHASE_COMPARE_RE = /\bphase\b\s*(?:={2,3}|!={1,2})|(?:={2,3}|!={1,2})[^\n;]*\bphase\b/;
const PHASE_SWITCH_RE = /switch\s*\([^)]*\bphase\b[^)]*\)/;

export function scanArchitecture(srcRoot: string): ArchitectureViolation[] {
  const files = listTsFiles(srcRoot);
  const violations: ArchitectureViolation[] = [];

  for (const file of files) {
    const rel = normalizeRel(path.relative(srcRoot, file));
    const layer = layerFor(rel);
    const content = fs.readFileSync(file, 'utf8');

    for (const imported of importsFor(content)) {
      const target = resolveImport(srcRoot, file, imported);
      if (!target) continue;
      const targetLayer = layerFor(target);
      if (layer === 'kernel' && (targetLayer === 'workitems' || targetLayer === 'worktypes')) {
        violations.push({
          file: rel,
          rule: 'kernel-imports-upper-layer',
          detail: `${imported} -> ${target}`,
        });
      }
      if (layer === 'workitems' && targetLayer === 'worktypes') {
        violations.push({
          file: rel,
          rule: 'workitems-imports-worktypes',
          detail: `${imported} -> ${target}`,
        });
      }
    }

    if (layer === 'kernel' && KERNEL_BUSINESS_RE.test(content)) {
      violations.push({
        file: rel,
        rule: 'kernel-business-vocabulary',
        detail: 'kernel code must not contain workitem/assignment/worktype/phase vocabulary',
      });
    }

    if (
      layer === 'workitems' &&
      (PHASE_COMPARE_RE.test(content) || PHASE_SWITCH_RE.test(content))
    ) {
      violations.push({
        file: rel,
        rule: 'phase-interpreted-by-container',
        detail: 'workitems container may store phase but must not interpret phase values',
      });
    }
  }

  return violations;
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out.sort();
}

function importsFor(content: string): string[] {
  const imports: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) imports.push(specifier);
  }
  return imports;
}

function resolveImport(srcRoot: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates =
    path.extname(base) === ''
      ? [`${base}.ts`, path.join(base, 'index.ts')]
      : [base.replace(/\.js$/, '.ts')];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return normalizeRel(path.relative(srcRoot, candidates[0]!));
  const rel = path.relative(srcRoot, found);
  if (rel.startsWith('..')) return undefined;
  return normalizeRel(rel);
}

function layerFor(relPath: string): Layer {
  if (relPath.startsWith('workitems/')) return 'workitems';
  if (relPath.startsWith('worktypes/')) return 'worktypes';
  if (relPath === 'index.ts' || relPath === 'config.ts') return 'kernel-exempt';
  return 'kernel';
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join('/');
}
