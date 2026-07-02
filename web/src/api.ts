import type { BoardData } from './types.js';

// 需求管控台数据接入：从后端 console 服务拉看板 / 回灌拍板。
// dev 经 vite proxy 打到 127.0.0.1:7090；生产由 console 服务自身静态托管 + 同源 /api。
export async function fetchBoard(): Promise<BoardData> {
  const res = await fetch('/api/requirement-board', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`board ${res.status}`);
  return (await res.json()) as BoardData;
}

export async function postResolve(
  waitId: string,
  approved: boolean,
  reason: string,
): Promise<void> {
  const res = await fetch('/api/requirement/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ waitId, approved, reason }),
  });
  if (!res.ok) throw new Error(`resolve ${res.status}`);
}
