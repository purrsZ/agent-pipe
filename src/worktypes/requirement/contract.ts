import type { Decision, WorkItemEvent } from '../../workitems/types.js';

// contract-engine (worktypes layer; PURE SYNC — no async/await/fs/child_process, CI-enforced
// red-line). Owns the cross-repo contract structure + the ONE structural-diff implementation
// shared by change判定 (R10), isDecisionStale (D-05), and integration对账 (R13). It never
// reads the artifact repo — inputs are already-frozen snapshots /固化 fingerprints.

export interface ContractField {
  name: string;
  type: string;
  optional: boolean;
}

export interface ContractInterface {
  id: string;
  signature: string;
  providerRepo: string; // repo key, never a business端名 (D-29)
  consumerRepos: string[];
  fields: ContractField[];
  // 人工标志: structurally identical but行为 changed (元→分, status 0=ok→fail, nullability,
  // ordering). The structural diff can't see it — the human declares it (D-31).
  semanticBreaking?: boolean;
}

export interface ContractSnapshot {
  version: string; // git hash / version — the "frozen" marker
  interfaces: ContractInterface[];
  fingerprint: string; // structural fingerprint, 固化 into decision.data for stale判定
}

export interface ContractDiff {
  added: Array<{ interfaceId: string; kind: 'field' | 'interface' | 'optional' }>;
  breaking: Array<{
    interfaceId: string;
    kind: 'removed-field' | 'type-changed' | 'semantic-removed' | 'interface-removed';
  }>;
  semanticFlagged: string[]; // interface ids the human marked semanticBreaking
  affectedRepos: string[]; // repos whose worker must返工 (breaking ∪ semantic)
}

// ── repoOf: 端/任务 → repo key归一 (§1.1, shared by impact/拆分/stale). ──────────────────
export function repoOf(x: { repo?: string | null } | null | undefined): string {
  return x?.repo ?? '';
}

// ── fingerprint: stable structural hash (内容等价 → 指纹相等; ignores comments/order). ────
export function contractFingerprint(interfaces: ContractInterface[]): string {
  const normalized = interfaces
    .map((i) => ({
      id: i.id,
      signature: i.signature,
      providerRepo: i.providerRepo,
      consumerRepos: [...i.consumerRepos].sort(),
      fields: [...i.fields]
        .map((f) => ({ name: f.name, type: f.type, optional: f.optional }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      semanticBreaking: i.semanticBreaking === true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return fnv1a(JSON.stringify(normalized));
}

export function makeSnapshot(version: string, interfaces: ContractInterface[]): ContractSnapshot {
  return { version, interfaces, fingerprint: contractFingerprint(interfaces) };
}

export const EMPTY_SNAPSHOT: ContractSnapshot = {
  version: '',
  interfaces: [],
  fingerprint: contractFingerprint([]),
};

// ── contractStructuralDiff: THE single implementation (§1.2). Pure, no fs. ───────────────
export function contractStructuralDiff(
  prev: ContractSnapshot,
  next: ContractSnapshot,
): ContractDiff {
  const added: ContractDiff['added'] = [];
  const breaking: ContractDiff['breaking'] = [];
  const semanticFlagged: string[] = [];
  const affected = new Set<string>();
  const addRepos = (i: ContractInterface) => {
    affected.add(i.providerRepo);
    for (const r of i.consumerRepos) affected.add(r);
  };

  const prevById = new Map(prev.interfaces.map((i) => [i.id, i]));
  const nextById = new Map(next.interfaces.map((i) => [i.id, i]));

  // removed interfaces — breaking.
  for (const [id, iface] of prevById) {
    if (!nextById.has(id)) {
      breaking.push({ interfaceId: id, kind: 'interface-removed' });
      addRepos(iface);
    }
  }

  for (const [id, nextIface] of nextById) {
    const prevIface = prevById.get(id);
    if (!prevIface) {
      // brand-new interface — purely additive.
      added.push({ interfaceId: id, kind: 'interface' });
      if (nextIface.semanticBreaking) {
        semanticFlagged.push(id);
        addRepos(nextIface);
      }
      continue;
    }
    let changed = false;
    const prevFields = new Map(prevIface.fields.map((f) => [f.name, f]));
    const nextFields = new Map(nextIface.fields.map((f) => [f.name, f]));
    for (const [name, pf] of prevFields) {
      const nf = nextFields.get(name);
      if (!nf) {
        breaking.push({ interfaceId: id, kind: 'removed-field' });
        changed = true;
      } else if (nf.type !== pf.type) {
        breaking.push({ interfaceId: id, kind: 'type-changed' });
        changed = true;
      } else if (pf.optional && !nf.optional) {
        // optional → required: consumers that omitted it now break.
        breaking.push({ interfaceId: id, kind: 'type-changed' });
        changed = true;
      } else if (!pf.optional && nf.optional) {
        // required → optional: relaxation, additive.
        added.push({ interfaceId: id, kind: 'optional' });
      }
    }
    for (const [name, _nf] of nextFields) {
      if (!prevFields.has(name)) added.push({ interfaceId: id, kind: 'field' }); // new field — additive
    }
    if (nextIface.semanticBreaking) {
      semanticFlagged.push(id);
      changed = true;
    }
    if (changed) addRepos(nextIface);
  }

  return { added, breaking, semanticFlagged, affectedRepos: [...affected].filter(Boolean) };
}

// 小改 (纯增, Owner 自治) ⟺ no breaking AND no semantic flag. Otherwise 大改 (回灯②). Mechanical
// — never an AI judgement (R10.AC-3).
export function isBreakingChange(diff: ContractDiff): boolean {
  return diff.breaking.length > 0 || diff.semanticFlagged.length > 0;
}

// computeImpact: affected repos → the workers that must返工 (one repo = one worker). 其它端照跑.
export function computeImpact(diff: ContractDiff): string[] {
  return diff.affectedRepos;
}

// ── isRequirementDecisionStale: pure sync, decision.data + eventsSince only (§4.3, D-05). ─
// A p板 carries the contract fingerprint it was based on (固化 into decision.data). If any
// contract change since then carries a DIFFERENT fingerprint, the p板 is stale → reject +
// re-pop the card (the reject/re-pop lives in checkpoint-gate; here we只判定).
//
// PIVOT 后：合同变更引擎已砍，contract_change_applied/contract_patched 不再 emit，故此判定对当前
// checkpoint（立项 gate / 灯③）实际恒返回 false（这两道关的 decision.data 也不固化 fingerprint）。保留为
// worktype.isDecisionStale 的防御实现——一旦未来重新引入会改契约的事件，这套 stale 兜底即复活，无需改接线。
export function isRequirementDecisionStale(
  decision: Decision,
  eventsSince: WorkItemEvent[],
): boolean {
  const baseFp = fingerprintField(decision.data);
  if (!baseFp) return false; // no contract fingerprint basis → never stale.
  for (const ev of eventsSince) {
    if (ev.kind === 'contract_change_applied' || ev.kind === 'contract_patched') {
      const newFp = fingerprintField(ev.payload);
      if (newFp && newFp !== baseFp) return true;
    }
  }
  return false;
}

function fingerprintField(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const fp = (value as { fingerprint?: unknown }).fingerprint;
  return typeof fp === 'string' && fp.length > 0 ? fp : undefined;
}

// FNV-1a 32-bit — tiny, dependency-free, deterministic. Good enough as a structural digest
// (we only need 内容等价→相等, not crypto strength).
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
