'use strict';
// 端到端验证：重复发布、中途失败（业务失败 + 崩溃恢复）、下线/回滚/权限收窄、不完整版本消费拦截
const assert = require('node:assert');
const { createServer } = require('../server/index');

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `断言失败: ${name} ${extra}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  const server = createServer(':memory:');
  await new Promise((r) => server.listen(PORT, r));
  console.log('验证开始：数据产品发布台\n');

  // ---------- 0. 初始状态 ----------
  console.log('[0] 初始种子状态');
  const products = (await api('GET', '/api/products')).body;
  const pTrade = products.find((p) => p.name === 'trade-analytics');
  const pPay = products.find((p) => p.name === 'payment-monitor');
  const pDash = products.find((p) => p.name === 'biz-dashboard');
  ok('种子产品存在', pTrade && pPay && pDash);
  ok('trade-analytics 1.0.0 已发布', pTrade.versions.some((v) => v.version === '1.0.0' && v.status === 'PUBLISHED'));
  ok('payment-monitor 1.0.0 质量门禁失败（种子中途失败样例）',
    pPay.versions.some((v) => v.version === '1.0.0' && v.status === 'FAILED' && v.fail_reason.includes('门禁')));
  ok('biz-dashboard 依赖就绪后发布成功', pDash.versions.some((v) => v.status === 'PUBLISHED'));

  // ---------- 1. 快照冻结 ----------
  console.log('[1] 发布冻结输入快照');
  const pipe = (await api('GET', `/api/pipelines/${pTrade.versions.find((v) => v.version === '1.0.0').id}`)).body;
  ok('快照已冻结', pipe.snapshot && pipe.snapshot.frozen_at);
  ok('快照记录数据集内容指纹', pipe.snapshot.datasets.every((d) => d.data_hash && d.dataset_version >= 1));
  const ordersFrozenHash = pipe.snapshot.datasets.find((d) => d.name === 'orders').data_hash;
  // 上游数据变更：新增 orders v3
  await api('POST', '/api/datasets/1/versions', {
    row_count: 140000, null_rate: 0.004,
    schema: ['order_id', 'user_id', 'amount', 'status', 'created_at'],
  });
  const pipeAgain = (await api('GET', `/api/pipelines/${pipe.id}`)).body;
  ok('上游数据变更后历史快照保持不变（冻结）',
    pipeAgain.snapshot.datasets.find((d) => d.name === 'orders').data_hash === ordersFrozenHash);

  // ---------- 2. 重复发布 ----------
  console.log('[2] 重复发布校验');
  const dup = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '1.0.0' });
  ok('同版本号重复发布 → 409 DUPLICATE_VERSION', dup.status === 409 && dup.body.error.code === 'DUPLICATE_VERSION');

  const idemKey = 'verify-idem-2.0.0';
  const first = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '2.0.0', idempotencyKey: idemKey });
  ok('带幂等键首次发布成功', first.status === 200 && first.body.version.status === 'PUBLISHED');
  const retry = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '2.0.0', idempotencyKey: idemKey });
  ok('同幂等键重试 → 返回首次结果，不产生重复版本',
    retry.status === 200 && retry.body.idempotent === true && retry.body.version.id === first.body.version.id);
  const conflict = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '2.0.1', idempotencyKey: idemKey });
  ok('同幂等键不同版本 → 409 IDEMPOTENCY_CONFLICT', conflict.status === 409 && conflict.body.error.code === 'IDEMPOTENCY_CONFLICT');
  const versionsAfter = (await api('GET', `/api/products/${pTrade.id}`)).body.versions.filter((v) => v.version === '2.0.0');
  ok('2.0.0 仅存在一条版本记录', versionsAfter.length === 1);

  // ---------- 3. 中途失败：质量门禁 ----------
  console.log('[3] 中途失败 - 质量门禁不通过');
  await api('POST', '/api/datasets/1/versions', {
    row_count: 141000, null_rate: 0.5, // 空值率严重超标
    schema: ['order_id', 'user_id', 'amount', 'status', 'created_at'],
  });
  const gateFail = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '2.1.0' });
  ok('质量门禁失败返回 failed 结果', gateFail.body.failed === true && gateFail.body.version.status === 'FAILED');
  const stages = gateFail.body.stages;
  const stageMap = Object.fromEntries(stages.map((s) => [s.stage, s.status]));
  ok('流水线阶段：VALIDATE/FREEZE 通过', stageMap.VALIDATE === 'OK' && stageMap.FREEZE_SNAPSHOT === 'OK');
  ok('流水线阶段：QUALITY_GATE 失败', stageMap.QUALITY_GATE === 'FAILED');
  ok('后续阶段被跳过（不继续执行）', stageMap.DEPENDENCY_CHECK === 'SKIPPED' && stageMap.PUBLISH === 'SKIPPED' && stageMap.NOTIFY === 'SKIPPED');
  const tradeAfterFail = (await api('GET', `/api/products/${pTrade.id}`)).body;
  ok('失败发布不影响当前版本指针', tradeAfterFail.current_version_id === first.body.version.id);
  const subsUnchanged = (await api('GET', '/api/subscribers')).body.filter((s) => s.product_name === 'trade-analytics');
  ok('失败发布不通知订阅方（无待处理事件）', subsUnchanged.every((s) => s.pending_events === 0));

  // ---------- 4. 中途失败：依赖未就绪 ----------
  console.log('[4] 中途失败 - 依赖检查不通过');
  // 新建一个无已发布版本的上游产品，并让新产品依赖它
  // 直接通过 SQL 不方便，这里用 payment-monitor（当前无 PUBLISHED 版本）作为上游
  // 构造：临时给 biz-dashboard 增加对 payment-monitor 的依赖不可行（无接口），
  // 改为验证种子中已有的场景：先下线 trade-analytics 全部版本会让 biz-dashboard 依赖失效。
  // 更简单：直接验证 payment-monitor 修复门禁前，biz-dashboard 若依赖它会失败。
  // 这里用维护接口验证依赖检查逻辑：下线 pTrade 全部已发布版本后，pDash 发布应失败。
  const tradePublished = (await api('GET', `/api/products/${pTrade.id}`)).body.versions.filter((v) => v.status === 'PUBLISHED');
  for (const v of tradePublished) {
    await api('POST', `/api/versions/${v.id}/deprecate`, { reason: '验证依赖检查：临时下线' });
  }
  const depFail = await api('POST', `/api/products/${pDash.id}/publish`, { version: '1.1.0' });
  ok('上游无已发布版本 → 依赖检查失败', depFail.body.failed === true && depFail.body.version.fail_stage === 'DEPENDENCY_CHECK');
  ok('依赖失败版本状态 FAILED', depFail.body.version.status === 'FAILED');

  // ---------- 5. 中途失败：崩溃原子性 ----------
  console.log('[5] 中途失败 - 崩溃原子性与恢复');
  const crashKey = 'verify-crash-3.0.0';
  const crash = await api('POST', `/api/products/${pTrade.id}/publish`, {
    version: '3.0.0', idempotencyKey: crashKey, chaos: 'CRASH_BEFORE_FREEZE',
  });
  ok('冻结前崩溃 → 500 PUBLISH_CRASHED', crash.status === 500 && crash.body.error.code === 'PUBLISH_CRASHED');
  const tradeAfterCrash = (await api('GET', `/api/products/${pTrade.id}`)).body;
  ok('崩溃后无残留版本记录（事务整体回滚）', !tradeAfterCrash.versions.some((v) => v.version === '3.0.0'));
  // 修复 orders 数据（v4 恢复正常），用同一幂等键重试 → 干净成功
  await api('POST', '/api/datasets/1/versions', {
    row_count: 142000, null_rate: 0.002,
    schema: ['order_id', 'user_id', 'amount', 'status', 'created_at'],
  });
  const retryCrash = await api('POST', `/api/products/${pTrade.id}/publish`, {
    version: '3.0.0', idempotencyKey: crashKey,
  });
  ok('同幂等键重试崩溃发布 → 干净成功', retryCrash.status === 200 && retryCrash.body.version.status === 'PUBLISHED');

  // 崩溃在 NOTIFY 前：版本已发布但订阅方未收到通知 → 恢复扫描补齐
  const crashNotify = await api('POST', `/api/products/${pTrade.id}/publish`, {
    version: '3.1.0', chaos: 'CRASH_BEFORE_NOTIFY',
  });
  ok('通知前崩溃 → 500 且版本已发布', crashNotify.status === 500);
  const v31 = (await api('GET', `/api/products/${pTrade.id}`)).body.versions.find((v) => v.version === '3.1.0');
  ok('崩溃版本状态为 PUBLISHED', v31 && v31.status === 'PUBLISHED');
  const stages31 = (await api('GET', `/api/pipelines/${v31.id}`)).body.stages;
  ok('NOTIFY 阶段缺失（通知未完成）', !stages31.some((s) => s.stage === 'NOTIFY'));
  const recover1 = await api('POST', '/api/maintenance/recover');
  ok('恢复扫描补齐通知', recover1.body.recovered_notify_versions >= 1);
  const stages31After = (await api('GET', `/api/pipelines/${v31.id}`)).body.stages;
  ok('恢复后 NOTIFY 阶段已补记', stages31After.some((s) => s.stage === 'NOTIFY' && s.status === 'OK'));
  const recover2 = await api('POST', '/api/maintenance/recover');
  ok('恢复扫描幂等（重复执行无新增）', recover2.body.recovered_notify_versions === 0 && recover2.body.events_sent === 0);

  // ---------- 6. 订阅方状态：下线 ----------
  console.log('[6] 版本下线 → 订阅方待处理 + 消费拦截');
  const subs = (await api('GET', '/api/subscribers')).body;
  const riskTeam = subs.find((s) => s.name === '风控团队');
  const finance = subs.find((s) => s.name === '财务团队');
  // 步骤4/5 产生的待处理事件：确认后迁移到当前版本（3.1.0）
  await api('POST', `/api/subscribers/${riskTeam.id}/ack`, {});
  await api('POST', `/api/subscribers/${finance.id}/ack`, {});
  const riskDetail = (await api('GET', `/api/subscribers/${riskTeam.id}`)).body;
  ok('风控团队确认后迁移到 3.1.0', riskDetail.pinned_version && riskDetail.pinned_version.version === '3.1.0');
  // 下线 3.1.0
  const dep = await api('POST', `/api/versions/${v31.id}/deprecate`, { reason: '发现数据口径问题，紧急下线' });
  ok('下线影响订阅方', dep.body.affected_subscribers >= 2);
  const riskAfterDep = (await api('GET', `/api/subscribers/${riskTeam.id}`)).body;
  ok('订阅方状态 → PENDING（待处理）', riskAfterDep.status === 'PENDING');
  const depEvent = riskAfterDep.events.find((e) => e.type === 'VERSION_DEPRECATED' && e.status === 'PENDING');
  ok('订阅方收到下线差异（含建议迁移版本）', depEvent && depEvent.diff.target_version);
  const consumeBlocked = await api('GET', `/api/subscribers/${riskTeam.id}/consume`);
  ok('待处理状态消费 → 423 拦截', consumeBlocked.status === 423 && consumeBlocked.body.error.code === 'SUBSCRIBER_PENDING');
  ok('拦截响应携带待处理差异', consumeBlocked.body.error.details.pending_events.length > 0);
  // 确认并迁移
  const ack = await api('POST', `/api/subscribers/${riskTeam.id}/ack`, {});
  ok('确认后恢复 ACTIVE', ack.body.subscriber.status === 'ACTIVE');
  const consumeOk = await api('GET', `/api/subscribers/${riskTeam.id}/consume`);
  ok('确认后可正常消费', consumeOk.status === 200 && consumeOk.body.metrics.length > 0);
  ok('消费内容按权限过滤', consumeOk.body.metrics.every((m) => ['daily_orders', 'avg_order_value'].includes(m.name)));

  // ---------- 7. 回滚 ----------
  console.log('[7] 回滚 → 差异通知 + 回滚记录');
  // 先调整产品组成：移除 active_users 指标，再发 4.0.0（对订阅方而言可能不完整）
  await api('POST', `/api/products/${pTrade.id}/metrics`, { remove: ['active_users'] });
  const v4 = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '4.0.0' });
  ok('4.0.0 发布成功', v4.body.version.status === 'PUBLISHED');
  // 财务团队权限仅 avg_order_value（仍在），风控权限 daily_orders+avg_order_value（仍在）→ 自动切换
  // 回滚 4.0.0 → 3.0.0（3.0.0 含 active_users，差异为指标新增方向）
  const rb = await api('POST', `/api/products/${pTrade.id}/rollback`, {
    toVersionId: (await api('GET', `/api/products/${pTrade.id}`)).body.versions.find((v) => v.version === '3.0.0').id,
    reason: '4.0.0 指标口径回归，回滚', operator: 'verify-script',
  });
  ok('回滚执行成功', rb.body.affected_subscribers >= 1);
  const rollbacks = (await api('GET', '/api/rollbacks')).body;
  ok('回滚记录已生成', rollbacks.some((r) => r.from_version === '4.0.0' && r.to_version === '3.0.0' && r.reason.includes('回滚')));
  const riskAfterRb = (await api('GET', `/api/subscribers/${riskTeam.id}`)).body;
  ok('回滚后订阅方 → PENDING', riskAfterRb.status === 'PENDING');
  const rbEvent = riskAfterRb.events.find((e) => e.type === 'ROLLBACK' && e.status === 'PENDING');
  ok('回滚差异包含版本变化信息', rbEvent && rbEvent.diff.from_version === '4.0.0' && rbEvent.diff.to_version === '3.0.0');
  const consumeRb = await api('GET', `/api/subscribers/${riskTeam.id}/consume`);
  ok('回滚待确认期间消费被拦截', consumeRb.status === 423);
  await api('POST', `/api/subscribers/${riskTeam.id}/ack`, {});
  ok('确认回滚后可消费', (await api('GET', `/api/subscribers/${riskTeam.id}/consume`)).status === 200);

  // ---------- 8. 权限收窄 ----------
  console.log('[8] 权限收窄 → 待处理 + 拦截');
  const narrow = await api('PATCH', `/api/subscribers/${finance.id}/permissions`, { permissions: [] });
  ok('权限收窄生效', narrow.body.narrowed === true && narrow.body.removed.includes('avg_order_value'));
  const finAfterNarrow = (await api('GET', `/api/subscribers/${finance.id}`)).body;
  ok('收窄后订阅方 → PENDING', finAfterNarrow.status === 'PENDING');
  const narrowEvent = finAfterNarrow.events.find((e) => e.type === 'PERMISSION_NARROWED' && e.status === 'PENDING');
  ok('收窄差异包含被移除权限', narrowEvent && narrowEvent.diff.removed_permissions.includes('avg_order_value'));
  ok('收窄待确认期间消费被拦截', (await api('GET', `/api/subscribers/${finance.id}/consume`)).status === 423);
  await api('POST', `/api/subscribers/${finance.id}/ack`, {});
  ok('确认收窄后恢复 ACTIVE', (await api('GET', `/api/subscribers/${finance.id}`)).body.status === 'ACTIVE');

  // ---------- 9. 不完整版本消费拦截 ----------
  console.log('[9] 不完整版本禁止消费');
  // 财务权限恢复 avg_order_value，但其 pinned 版本为 3.0.0（含该指标）→ 先验证正常
  await api('PATCH', `/api/subscribers/${finance.id}/permissions`, { permissions: ['avg_order_value'] });
  await api('POST', `/api/subscribers/${finance.id}/ack`, {});
  // 把 active_users 加回产品组成并授权风控，发布 4.1.0（完整）→ 风控自动切换
  await api('POST', `/api/products/${pTrade.id}/metrics`, { add: ['active_users'] });
  await api('PATCH', `/api/subscribers/${riskTeam.id}/permissions`, {
    permissions: ['daily_orders', 'avg_order_value', 'active_users'],
  });
  const v41 = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '4.1.0' });
  ok('4.1.0 发布成功（含 active_users）', v41.body.version.status === 'PUBLISHED');
  // 再从产品移除该指标，发布 5.0.0 → 对风控而言是不完整版本
  await api('POST', `/api/products/${pTrade.id}/metrics`, { remove: ['active_users'] });
  const v5 = await api('POST', `/api/products/${pTrade.id}/publish`, { version: '5.0.0' });
  ok('5.0.0 发布成功（不含 active_users）', v5.body.version.status === 'PUBLISHED');
  const riskAfterV5 = (await api('GET', `/api/subscribers/${riskTeam.id}`)).body;
  ok('新版本对风控不完整 → PENDING 且不自动切换', riskAfterV5.status === 'PENDING');
  const incompleteEvent = riskAfterV5.events.find((e) => e.type === 'VERSION_PUBLISHED' && e.status === 'PENDING');
  ok('差异标明缺失指标', incompleteEvent && incompleteEvent.diff.missing_metrics.includes('active_users'));
  ok('不完整版本待确认期间消费被拦截', (await api('GET', `/api/subscribers/${riskTeam.id}/consume`)).status === 423);
  // 直接确认（不接受缩减）→ 409 提示不完整
  const ackNoReduce = await api('POST', `/api/subscribers/${riskTeam.id}/ack`, {});
  ok('目标版本不完整且未接受缩减 → 409', ackNoReduce.status === 409 && ackNoReduce.body.error.code === 'INCOMPLETE_TARGET');
  // 接受缩减 → 权限去掉 active_users，切换到 5.0.0
  const ackReduce = await api('POST', `/api/subscribers/${riskTeam.id}/ack`, { acceptReduced: true });
  ok('接受缩减后确认成功', ackReduce.status === 200 && ackReduce.body.subscriber.status === 'ACTIVE');
  const riskFinal = (await api('GET', `/api/subscribers/${riskTeam.id}`)).body;
  ok('权限已缩减且切换到 5.0.0',
    !riskFinal.permissions.includes('active_users') && riskFinal.pinned_version.version === '5.0.0');
  ok('最终消费正常', (await api('GET', `/api/subscribers/${riskTeam.id}/consume`)).status === 200);

  // ---------- 10. 依赖影响 ----------
  console.log('[10] 依赖影响分析');
  const impact = (await api('GET', '/api/datasets/1/impact')).body;
  ok('orders 影响 trade-analytics', impact.products.some((p) => p.product_name === 'trade-analytics'));
  ok('影响面包含冻结了该数据集的版本', impact.products[0].versions.length > 0 &&
    impact.products[0].versions.every((v) => v.frozen_dataset_version >= 1));
  ok('下游产品闭包包含 biz-dashboard', impact.downstream_products.some((p) => p.name === 'biz-dashboard'));
  ok('影响面包含订阅方状态', impact.products[0].subscribers.length >= 2);

  console.log(`\n全部通过：${passed} 项断言 ✓`);
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n验证失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
