# 数据产品发布台

数据产品的发布、版本治理与订阅方管理平台。零外部依赖（Node.js 内置 `http` + `node:sqlite`），前端为原生 SPA。

## 运行

```bash
npm start          # http://localhost:3000 （PORT 环境变量可改端口）
npm run verify     # 端到端验证：63 项断言（独立端口与内存库，不影响运行数据）
```

## 领域模型

| 实体 | 说明 |
|---|---|
| 数据集 Dataset | 上游表，含多个数据版本（行数、空值率、schema、内容指纹 hash） |
| 指标 Metric | 业务指标定义，归属于数据集 |
| 质量门禁 QualityGate | 规则：`max_null_rate` / `min_row_count` / `required_columns` |
| 产品 Product | 由数据集 + 指标 + 门禁组成，可依赖其他产品 |
| 版本 ProductVersion | 一次发布产物，冻结输入快照，状态机见下 |
| 订阅方 Subscriber | 钉住某个版本消费，持有指标级权限 |

版本状态机：`PUBLISHING → PUBLISHED → DEPRECATED / ROLLED_BACK`，中途失败为 `FAILED`。

## 发布流水线（六阶段）

`参数校验 → 冻结快照 → 质量门禁 → 依赖检查 → 正式发布 → 通知订阅方`

- **冻结快照**：发布时把产品所有输入（数据集版本+内容指纹、指标定义、门禁规则）固化进版本，上游数据后续变更不影响已发布版本。
- **重复发布**：同产品同版本号 → `409 DUPLICATE_VERSION`；携带幂等键的重试返回首次结果（`idempotent: true`），同键不同版本 → `409 IDEMPOTENCY_CONFLICT`。
- **中途失败**：
  - 业务失败（门禁/依赖不通过）→ 版本标记 `FAILED`，后续阶段跳过，不通知订阅方，当前版本指针不变；
  - 崩溃（故障注入 `chaos` 参数模拟）→ 事务整体回滚无残留，或已发布未通知时由**恢复扫描**（`POST /api/maintenance/recover`，启动时自动执行）幂等补齐。

## 订阅方保护

版本**下线**、**回滚**、**权限收窄**、或新版本对订阅方**不完整**（缺失其权限内指标）时：

1. 订阅方收到带**差异明细**的事件（增删指标、数据版本变化、被移除权限、缺失指标），状态转为 `PENDING`；
2. `PENDING` 期间消费接口返回 `423 SUBSCRIBER_PENDING` 并携带待处理差异；
3. 确认（ack）时迁移到目标版本；目标版本不完整需显式接受权限缩减（`acceptReduced`），否则 `409 INCOMPLETE_TARGET`；
4. 任何时刻钉住非 `PUBLISHED` 版本或版本缺失权限内指标 → 消费被拦截（`VERSION_NOT_CONSUMABLE` / `VERSION_INCOMPLETE`），即**不能继续消费不完整版本**。

## 页面

- **产品总览**：KPI、产品版本列表、发布（含故障注入）、下线、回滚、模拟上游数据变更
- **发布流水线**：每次发布的六阶段状态与失败原因
- **依赖影响**：数据集 → 产品 → 冻结版本 → 订阅方 的影响图（SVG）与表视图
- **订阅状态**：订阅方状态、待处理事件差异、确认、权限调整、试消费
- **回滚记录**：回滚时间线（从版本 → 目标版本、原因、操作人、受影响订阅方数）

## API 摘要

```
GET  /api/overview|products|pipelines|datasets|subscribers|rollbacks
POST /api/products/:id/publish        {version, idempotencyKey?, chaos?}
POST /api/products/:id/rollback       {toVersionId, reason, operator}
POST /api/versions/:id/deprecate      {reason}
GET  /api/datasets/:id/impact
POST /api/datasets/:id/versions       {row_count, null_rate, schema}
PATCH /api/subscribers/:id/permissions {permissions[]}
POST /api/subscribers/:id/ack         {targetVersionId?, acceptReduced?}
GET  /api/subscribers/:id/consume
POST /api/maintenance/recover
```

错误格式统一为 `{error: {code, message, details?}}`。

## 验证覆盖（test/verify.js，63 项断言）

- 快照冻结：上游变更后历史版本快照不变
- 重复发布：版本号冲突 409、幂等键重试安全、键冲突 409
- 中途失败：门禁失败 / 依赖未就绪 → FAILED 且阶段跳过、订阅方零打扰；崩溃 → 原子回滚、同键重试干净成功、恢复扫描幂等补齐通知
- 下线 / 回滚 / 权限收窄：订阅方收差异、转待处理、消费 423 拦截、确认后恢复
- 不完整版本：缺失权限指标的版本禁止消费，确认需显式接受缩减
- 依赖影响：产品、冻结版本、下游闭包、订阅方状态
