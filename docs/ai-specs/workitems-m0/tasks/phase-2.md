# Phase 2: 生命周期、投影与创建路径

> 输入：S2-lifecycle-projection.md、Phase 1 输出。
> 目标：落 WorkType 注册表、rollup 纯函数、createWorkItem 编程入口的最小事务骨架。
> 统一验证：每个 Task 完成后运行 `npm run typecheck && npm run lint && npm test`。

## Task T8: WorkTypeRegistry

**AC**：AC-2.13 注册表面  
**依赖**：T1  
**文件**：
- Create: `src/workitems/registry.ts`
- Test: `tests/workitems/registry.test.ts`

**RED**
- 测试注册完整 WorkType 后可按 id 查回同一对象。
- 测试重复注册同 id 抛 `WorkTypeAlreadyRegisteredError`。
- 测试 `get('missing')` 返回 undefined。

**GREEN**
- 实现小型 Map 注册表，错误类型导出给 api 测试断言。
- 不 import worktypes，注册表只认识 WorkType 接口。

**完成判据**
- registry 是纯内存组件，无 DB 副作用。

## Task T9: rollup 投影纯函数

**AC**：AC-2.8、AC-2.10 纯函数面  
**依赖**：T1  
**文件**：
- Create: `src/workitems/projection.ts`
- Test: `tests/workitems/projection.test.ts`

**RED**
- 覆盖优先级矩阵：human wait > running assignment > agent wait > timer wait > active/open 空活动边界。
- 覆盖终态冻结：current 为 done/failed/cancelled 时原样返回。
- 覆盖空活动：仅创建事件为 open；有 seq>1 但无 wait/assignment 为 active。

**GREEN**
- 实现 `computeRollup(input)` 与 `recomputeRollup(store,itemId)`。
- `recomputeRollup` 只读权威表并写 status/statusDetail，不执行任何副作用。

**完成判据**
- 投影测试不启动 reducer/effects。
- statusDetail 对应 human/agent/timer/null。

## Task T10: createWorkItem 与 bootstrapApply 骨架

**AC**：AC-2.1~2.6、FLOW-2.2  
**依赖**：T2、T3、T8、T9  
**文件**：
- Create: `src/workitems/api.ts`
- Create: `src/workitems/errors.ts`
- Create or Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/create-workitem.test.ts`

**RED**
- 测试未注册 type 抛 `TypeNotRegisteredError` 且零落库。
- 测试创建成功：status=open、phase=initialPhase、source 原样写入、追加 `workitem_created` 事件。
- 测试 dedupe 命中返回 `{created:false,item}`，不新增事件、不占上限。
- 测试 NULL dedupe 两次创建得到不同 id。
- 测试 3 个非终态后第 4 个抛 `OpenLimitError`；一个进入终态后可再创建。
- 测试 maxOpen=4 配置下第 5 个才拒绝。

**GREEN**
- `WorkitemsApi.createWorkItem` 做 registry 校验、dedupe 先查、非终态计数、事务内插入 item 与创建事件。
- 先落 `ReducerRuntime.bootstrapApply` 最小骨架：创建事务可调用 WorkType.onEvent 并写入初始 dispatch/wait/effect 的最小行；完整单飞/结构检查在 Phase 3 补齐。
- 事务提交后初始化 artifact repo；若 repo 初始化失败，记录错误并交 S4 startup reconcile 重建，不回滚已提交状态。

**完成判据**
- FLOW-2.2 集成通过。
- `api.ts` 与 `reducer.ts` 共享的 CreateInput/CreateResult 均从 `types.ts` import，避免文件环。

