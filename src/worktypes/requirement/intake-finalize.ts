import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import { buildIntakeBrief, foldIntake, INTAKE_FIELD_SET, intakeReposOf } from './intake.js';

// 立项收尾 effect（intake-phase）：立项 gate 通过、进「拆解」时由 worktype 发起（enterPhase）。两件事
// 都是从立项填项事件历史纯 fold 出来的派生产物（recovery:'rerun'，崩溃后重跑幂等）：
//   1) 落「立项书」intake/intake.md —— 拆解 phase 的 owner 跨仓对账 run 据它定位各仓设计目录（PRD 摘要/
//      验收/UI/边界/多仓），而非裸标题硬考古；
//   2) 把立项收齐的仓库提升为 workitem.repos —— owner 对账 / worker 拆分都读 workitem.repos，而 /req 不再
//      带 --repo（仓库走立项收齐）。effect 不能直接改 workitem 字段，故走中性 repos_set 容器事件
//      （reducer.containerTransition 落库）。
export function createIntakeFinalizeHandler(): EffectHandler {
  return {
    kind: 'intake_finalize',
    recovery: 'rerun',
    run: async (ctx: EffectContext) => {
      const inputs = ctx
        .eventsSince(0)
        .filter((e) => e.kind === INTAKE_FIELD_SET)
        .map((e) => e.payload);
      const state = foldIntake(inputs);
      ctx.writeArtifact('intake/intake.md', buildIntakeBrief(state), '立项书（立项 gate 通过）');
      const repos = intakeReposOf(state);
      if (repos.length > 0) ctx.emit('repos_set', { repos });
    },
  };
}
