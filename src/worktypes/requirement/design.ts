import {
  type ContractField,
  type ContractInterface,
  type ContractSnapshot,
  makeSnapshot,
} from './contract.js';

// design-phase (worktypes layer; pure). Two testable transforms (R15.AC-2/AC-3):
//   1. 升格: spec-design's single-repo internal-apis → the cross-repo 对接合同 (each §x.y → a
//      ContractInterface, with providerRepo/consumerRepos补全 — D-29).
//   2. 按端切片: split the frozen contract per repo so each worker领走 its slice (provides +
//      consumes). The spec-design run + the markdown extraction itself is the live half; these
//      operate on the already-structured draft the run produces.

export interface InternalApiEntry {
  id: string;
  signature: string;
  fields?: ContractField[];
  providerRepo: string; //补的 repo 维度 (spec-design internal-apis is single-repo)
  consumerRepos: string[];
  semanticBreaking?: boolean;
}

// 升格: build the待确认 ContractSnapshot草案 (灯②快拍 confirms it → contract-engine freezes it).
export function promoteToContract(version: string, entries: InternalApiEntry[]): ContractSnapshot {
  const interfaces: ContractInterface[] = entries.map((e) => ({
    id: e.id,
    signature: e.signature,
    providerRepo: e.providerRepo,
    consumerRepos: e.consumerRepos,
    fields: e.fields ?? [],
    ...(e.semanticBreaking ? { semanticBreaking: true } : {}),
  }));
  return makeSnapshot(version, interfaces);
}

export interface DesignSlice {
  repo: string;
  provides: ContractInterface[]; // interfaces this repo must implement
  consumes: ContractInterface[]; // upstream interfaces this repo depends on
}

// 按端切片 (D-29 repo维度, 不用业务端名). One repo = one worker's领活范围 (D-01).
export function sliceByRepo(contract: ContractSnapshot): DesignSlice[] {
  const repos = new Set<string>();
  for (const i of contract.interfaces) {
    if (i.providerRepo) repos.add(i.providerRepo);
    for (const c of i.consumerRepos) if (c) repos.add(c);
  }
  return [...repos].sort().map((repo) => ({
    repo,
    provides: contract.interfaces.filter((i) => i.providerRepo === repo),
    consumes: contract.interfaces.filter(
      (i) => i.providerRepo !== repo && i.consumerRepos.includes(repo),
    ),
  }));
}

// The repos a requirement must拆 workers for = every repo touched by the contract. Drives
// the拆解→并行实现 fan-out (one worker per repo).
export function reposFromContract(contract: ContractSnapshot): string[] {
  return sliceByRepo(contract).map((s) => s.repo);
}
