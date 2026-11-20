'use strict';
// 领域层：发布流水线 / 快照冻结 / 质量门禁 / 依赖检查 / 下线 / 回滚 / 权限收窄 / 消费拦截 / 崩溃恢复
const crypto = require('node:crypto');
const { now } = require('./db');

const STAGES = ['VALIDATE', 'FREEZE_SNAPSHOT', 'QUALITY_GATE', 'DEPENDENCY_CHECK', 'PUBLISH', 'NOTIFY'];

class DomainError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class ChaosError extends Error {} // 模拟发布中途进程崩溃

// ---------- 基础查询 ----------
function getProduct(db, productId) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) throw new DomainError('PRODUCT_NOT_FOUND', `产品 #${productId} 不存在`, 404);
  return p;
}

function getVersion(db, versionId) {
  const v = db.prepare('SELECT * FROM product_versions WHERE id = ?').get(versionId);
  if (!v) throw new DomainError('VERSION_NOT_FOUND', `版本 #${versionId} 不存在`, 404);
  return v;
}

function getSubscriber(db, subscriberId) {
  const s = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId);
  if (!s) throw new DomainError('SUBSCRIBER_NOT_FOUND', `订阅方 #${subscriberId} 不存在`, 404);
  return s;
}

function stagesOf(db, versionId) {
  return db.prepare('SELECT * FROM publish_stages WHERE version_id = ? ORDER BY seq').all(versionId);
}

function recordStage(db, versionId, stage, status, detail) {
  const seq = STAGES.indexOf(stage) + 1;
  db.prepare(
    'INSERT INTO publish_stages (version_id, seq, stage, status, detail, created_at) VALUES (?,?,?,?,?,?)'
  ).run(versionId, seq, stage, status, detail, now());
}

function skipStagesFrom(db, versionId, fromStage) {
  const from = STAGES.indexOf(fromStage);
  for (let i = from; i < STAGES.length; i++) {
    recordStage(db, versionId, STAGES[i], 'SKIPPED', '前置阶段未通过，跳过');
  }
}

function parseSnapshot(versionRow) {
  return versionRow && versionRow.snapshot_json ? JSON.parse(versionRow.snapshot_json) : null;
}

// ---------- 快照冻结 ----------
// 冻结产品当前所有输入：数据集版本(含内容指纹)、指标定义、门禁规则
function buildSnapshot(db, product) {
  const datasets = db.prepare(
    `SELECT d.id AS dataset_id, d.name, d.owner FROM product_datasets pd
     JOIN datasets d ON d.id = pd.dataset_id WHERE pd.product_id = ? ORDER BY d.id`
  ).all(product.id);

  const frozenDatasets = datasets.map((d) => {
    const dv = db.prepare(
      'SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version DESC LIMIT 1'
    ).get(d.dataset_id);
    if (!dv) {
      throw new DomainError(
        'SNAPSHOT_INCOMPLETE',
        `数据集「${d.name}」没有任何数据版本，无法冻结快照`,
        422,
        { dataset: d.name }
      );
    }
    return {
      dataset_id: d.dataset_id,
      name: d.name,
      dataset_version: dv.version,
      row_count: dv.row_count,
      null_rate: dv.null_rate,
      schema: JSON.parse(dv.schema_json),
      data_hash: dv.data_hash,
    };
  });

  const metrics = db.prepare(
    `SELECT m.id AS metric_id, m.name, m.definition, d.name AS dataset
     FROM product_metrics pm JOIN metrics m ON m.id = pm.metric_id
     JOIN datasets d ON d.id = m.dataset_id
     WHERE pm.product_id = ? ORDER BY m.id`
  ).all(product.id);

  const gates = db.prepare(
    `SELECT g.id AS gate_id, g.name, g.dataset_id, g.rules_json
     FROM product_gates pg JOIN quality_gates g ON g.id = pg.gate_id
     WHERE pg.product_id = ? ORDER BY g.id`
  ).all(product.id).map((g) => ({ ...g, rules: JSON.parse(g.rules_json), rules_json: undefined }));

  return {
    product_id: product.id,
    product_name: product.name,
    frozen_at: now(),
    datasets: frozenDatasets,
    metrics,
    gates,
  };
}

// ---------- 质量门禁评估 ----------
function evaluateGates(snapshot) {
  const results = [];
  for (const gate of snapshot.gates) {
    const ds = snapshot.datasets.find((d) => d.dataset_id === gate.dataset_id);
    if (!ds) {
      results.push({ gate: gate.name, rule: 'dataset_present', expected: '数据集在产品内', actual: '缺失', pass: false });
      continue;
    }
    const r = gate.rules;
    if (r.max_null_rate != null) {
      results.push({
        gate: gate.name, dataset: ds.name, rule: 'max_null_rate',
        expected: `≤ ${r.max_null_rate}`, actual: ds.null_rate, pass: ds.null_rate <= r.max_null_rate,
      });
    }
    if (r.min_row_count != null) {
      results.push({
        gate: gate.name, dataset: ds.name, rule: 'min_row_count',
        expected: `≥ ${r.min_row_count}`, actual: ds.row_count, pass: ds.row_count >= r.min_row_count,
      });
    }
    if (Array.isArray(r.required_columns)) {
      const missing = r.required_columns.filter((c) => !ds.schema.includes(c));
      results.push({
        gate: gate.name, dataset: ds.name, rule: 'required_columns',
        expected: r.required_columns.join(','), actual: missing.length ? `缺失 ${missing.join(',')}` : '齐全',
        pass: missing.length === 0,
      });
    }
  }
  return results;
}

// ---------- 依赖检查 ----------
function checkDependencies(db, productId) {
  const deps = db.prepare(
    `SELECT p.id, p.name, p.current_version_id, v.status AS current_status
     FROM product_dependencies d
     JOIN products p ON p.id = d.depends_on_product_id
     LEFT JOIN product_versions v ON v.id = p.current_version_id
     WHERE d.product_id = ?`
  ).all(productId);
  return deps
    .filter((d) => d.current_status !== 'PUBLISHED')
    .map((d) => ({ product_id: d.id, name: d.name, current_status: d.current_status || '无已发布版本' }));
}

// ---------- 快照差异 ----------
function diffSnapshots(oldSnap, newSnap) {
  const byKey = (arr, k) => new Map((arr || []).map((x) => [x[k], x]));
  const om = byKey(oldSnap && oldSnap.metrics, 'metric_id');
  const nm = byKey(newSnap && newSnap.metrics, 'metric_id');
  const metrics = { added: [], removed: [], changed: [] };
  for (const [id, m] of nm) {
    if (!om.has(id)) metrics.added.push({ name: m.name, definition: m.definition });
    else if (om.get(id).definition !== m.definition) {
      metrics.changed.push({ name: m.name, from: om.get(id).definition, to: m.definition });
    }
  }
  for (const [id, m] of om) {
    if (!nm.has(id)) metrics.removed.push({ name: m.name, definition: m.definition });
  }
  const od = byKey(oldSnap && oldSnap.datasets, 'dataset_id');
  const nd = byKey(newSnap && newSnap.datasets, 'dataset_id');
  const datasets = { added: [], removed: [], version_changed: [] };
  for (const [id, d] of nd) {
    if (!od.has(id)) datasets.added.push({ name: d.name, dataset_version: d.dataset_version });
    else if (od.get(id).data_hash !== d.data_hash) {
      datasets.version_changed.push({
        name: d.name, from_version: od.get(id).dataset_version, to_version: d.dataset_version,
        from_hash: od.get(id).data_hash, to_hash: d.data_hash,
      });
    }
  }
  for (const [id, d] of od) {
    if (!nd.has(id)) datasets.removed.push({ name: d.name, dataset_version: d.dataset_version });
  }
  return { metrics, datasets };
}

function snapshotMetricNames(snap) {
  return new Set((snap ? snap.metrics : []).map((m) => m.name));
}

// ---------- 发布流水线 ----------
// 事务A：VALIDATE → FREEZE_SNAPSHOT → QUALITY_GATE → DEPENDENCY_CHECK → PUBLISH（原子）
// 事务B：NOTIFY（通知订阅方，可独立重试/恢复）
function publish(db, productId, { version, idempotencyKey, chaos = null } = {}) {
  if (!version || typeof version !== 'string') {
    throw new DomainError('INVALID_VERSION', '版本号不能为空', 400);
  }
  const product = getProduct(db, productId);

  // 幂等：同一幂等键重复提交 → 返回首次结果，不产生重复版本
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM product_versions WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      if (existing.product_id !== productId || existing.version !== version) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', '该幂等键已用于其他发布请求，请更换', 409);
      }
      return { version: existing, stages: stagesOf(db, existing.id), idempotent: true };
    }
  }

  // 重复发布校验：同产品同版本号 → 拒绝
  const dup = db.prepare(
    'SELECT * FROM product_versions WHERE product_id = ? AND version = ?'
  ).get(productId, version);
  if (dup) {
    throw new DomainError(
      'DUPLICATE_VERSION',
      `版本 ${version} 已存在（状态 ${dup.status}），禁止重复发布`,
      409,
      { existing_version_id: dup.id, existing_status: dup.status }
    );
  }

  const key = idempotencyKey || crypto.randomUUID();
  let versionId;

  // ---- 事务A ----
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO product_versions (product_id, version, status, idempotency_key, created_at)
       VALUES (?,?, 'PUBLISHING', ?, ?)`
    ).run(productId, version, key, now());
    versionId = Number(r.lastInsertRowid);
    recordStage(db, versionId, 'VALIDATE', 'OK', '参数、重复发布与幂等性校验通过');

    if (chaos === 'CRASH_BEFORE_FREEZE') throw new ChaosError('模拟崩溃：冻结快照前进程退出');

    // 冻结输入快照
    const snapshot = buildSnapshot(db, product);
    db.prepare('UPDATE product_versions SET snapshot_json = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), versionId);
    recordStage(db, versionId, 'FREEZE_SNAPSHOT', 'OK',
      `冻结 ${snapshot.datasets.length} 个数据集、${snapshot.metrics.length} 个指标、${snapshot.gates.length} 个门禁`);

    // 质量门禁
    const gateResults = evaluateGates(snapshot);
    const failedGates = gateResults.filter((g) => !g.pass);
    if (failedGates.length) {
      const detail = failedGates.map((g) => `${g.gate}/${g.rule}: 期望${g.expected} 实际${g.actual}`).join('；');
      recordStage(db, versionId, 'QUALITY_GATE', 'FAILED', `门禁未通过：${detail}`);
      skipStagesFrom(db, versionId, 'DEPENDENCY_CHECK');
      db.prepare(`UPDATE product_versions SET status='FAILED', fail_stage='QUALITY_GATE', fail_reason=? WHERE id=?`)
        .run(detail, versionId);
      db.exec('COMMIT');
      return { version: getVersion(db, versionId), stages: stagesOf(db, versionId), failed: true, gate_results: gateResults };
    }
    recordStage(db, versionId, 'QUALITY_GATE', 'OK', `${gateResults.length} 项门禁检查全部通过`);

    // 依赖检查
    const missingDeps = checkDependencies(db, productId);
    if (missingDeps.length) {
      const detail = missingDeps.map((d) => `上游产品「${d.name}」状态 ${d.current_status}`).join('；');
      recordStage(db, versionId, 'DEPENDENCY_CHECK', 'FAILED', `依赖未就绪：${detail}`);
      skipStagesFrom(db, versionId, 'PUBLISH');
      db.prepare(`UPDATE product_versions SET status='FAILED', fail_stage='DEPENDENCY_CHECK', fail_reason=? WHERE id=?`)
        .run(detail, versionId);
      db.exec('COMMIT');
      return { version: getVersion(db, versionId), stages: stagesOf(db, versionId), failed: true, missing_deps: missingDeps };
    }
    recordStage(db, versionId, 'DEPENDENCY_CHECK', 'OK', '上游依赖产品均有已发布版本');

    if (chaos === 'CRASH_BEFORE_PUBLISH') throw new ChaosError('模拟崩溃：正式发布前进程退出');

    db.prepare(`UPDATE product_versions SET status='PUBLISHED', published_at=? WHERE id=?`).run(now(), versionId);
    db.prepare('UPDATE products SET current_version_id=? WHERE id=?').run(versionId, productId);
    recordStage(db, versionId, 'PUBLISH', 'OK', '版本已发布并设为当前版本');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK'); // 崩溃或异常 → 整体回滚，不留半成品
    if (e instanceof ChaosError) {
      throw new DomainError('PUBLISH_CRASHED', `${e.message}；事务已回滚，无残留状态`, 500, { crashed: true });
    }
    throw e;
  }

  // ---- 事务B：通知订阅方（崩溃可恢复，幂等） ----
  if (chaos === 'CRASH_BEFORE_NOTIFY') {
    throw new DomainError('PUBLISH_CRASHED', '模拟崩溃：通知订阅方前进程退出；版本已发布，待恢复扫描补齐通知', 500, { crashed: true, version_id: versionId });
  }
  notifySubscribers(db, productId, versionId);
  return { version: getVersion(db, versionId), stages: stagesOf(db, versionId), failed: false };
}

// 通知订阅方新版本：计算差异；若新快照缺失订阅方权限内指标 → 订阅方转待处理，禁止继续消费
function notifySubscribers(db, productId, versionId) {
  const version = getVersion(db, versionId);
  const snap = parseSnapshot(version);
  const metricNames = snapshotMetricNames(snap);
  const subs = db.prepare('SELECT * FROM subscribers WHERE product_id = ?').all(productId);
  let notified = 0;

  db.exec('BEGIN');
  try {
    for (const s of subs) {
      const existing = db.prepare(
        `SELECT id FROM subscriber_events WHERE subscriber_id=? AND type='VERSION_PUBLISHED' AND version_id=?`
      ).get(s.id, versionId);
      if (existing) continue; // 幂等：恢复扫描重复执行不产生重复事件

      const prevSnap = s.pinned_version_id ? parseSnapshot(getVersion(db, s.pinned_version_id)) : null;
      const diff = diffSnapshots(prevSnap, snap);
      const perms = JSON.parse(s.permissions_json);
      const missing = perms.filter((m) => !metricNames.has(m));
      let status = 'ACKED';
      let message = `新版本 ${version.version} 已发布，已自动切换`;
      if (missing.length > 0) {
        // 新版本对该订阅方而言是"不完整版本" → 待处理，不自动切换
        status = 'PENDING';
        message = `新版本 ${version.version} 缺少订阅方权限内指标：${missing.join('、')}，需确认后切换`;
        db.prepare(`UPDATE subscribers SET status='PENDING' WHERE id=?`).run(s.id);
      } else if (s.status === 'PENDING') {
        // 已有待处理事项的订阅方不自动切换，确认时统一迁移
        status = 'PENDING';
        message = `新版本 ${version.version} 已发布，订阅方有待处理事项，确认后切换`;
      } else {
        db.prepare('UPDATE subscribers SET pinned_version_id=? WHERE id=?').run(versionId, s.id);
      }
      db.prepare(
        `INSERT INTO subscriber_events (subscriber_id, version_id, type, diff_json, status, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(s.id, versionId, 'VERSION_PUBLISHED',
        JSON.stringify({ ...diff, version: version.version, version_id: versionId, missing_metrics: missing, message }),
        status, now());
      notified++;
    }
    recordStage(db, versionId, 'NOTIFY', 'OK', `已通知 ${notified} 个订阅方`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return notified;
}

// ---------- 版本下线 ----------
function deprecateVersion(db, versionId, { reason = '版本下线' } = {}) {
  const v = getVersion(db, versionId);
  if (v.status !== 'PUBLISHED') {
    throw new DomainError('INVALID_STATE', `仅已发布版本可下线，当前状态 ${v.status}`, 409);
  }
  const product = getProduct(db, v.product_id);
  const snap = parseSnapshot(v);

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE product_versions SET status='DEPRECATED' WHERE id=?`).run(versionId);
    // 当前指针回退到最近的其他已发布版本
    let target = null;
    if (product.current_version_id === versionId) {
      target = db.prepare(
        `SELECT * FROM product_versions WHERE product_id=? AND status='PUBLISHED' AND id<>?
         ORDER BY published_at DESC LIMIT 1`
      ).get(v.product_id, versionId) || null;
      db.prepare('UPDATE products SET current_version_id=? WHERE id=?')
        .run(target ? target.id : null, v.product_id);
    } else {
      target = product.current_version_id ? getVersion(db, product.current_version_id) : null;
    }

    const subs = db.prepare('SELECT * FROM subscribers WHERE pinned_version_id = ?').all(versionId);
    for (const s of subs) {
      const perms = JSON.parse(s.permissions_json);
      const targetSnap = target ? parseSnapshot(target) : null;
      const missing = targetSnap ? perms.filter((m) => !snapshotMetricNames(targetSnap).has(m)) : perms;
      const diff = {
        type: 'VERSION_DEPRECATED', reason,
        deprecated_version: v.version, version_id: v.id,
        lost_metrics: snap.metrics.map((m) => m.name),
        target_version_id: target ? target.id : null,
        target_version: target ? target.version : null,
        missing_metrics: missing,
        message: target
          ? `版本 ${v.version} 已下线（${reason}），建议迁移到 ${target.version}`
          : `版本 ${v.version} 已下线（${reason}），当前无可迁移版本`,
      };
      db.prepare(
        `INSERT INTO subscriber_events (subscriber_id, version_id, type, diff_json, status, created_at)
         VALUES (?,?,?,?, 'PENDING', ?)`
      ).run(s.id, v.id, 'VERSION_DEPRECATED', JSON.stringify(diff), now());
      db.prepare(`UPDATE subscribers SET status='PENDING' WHERE id=?`).run(s.id);
    }
    db.exec('COMMIT');
    return { version: getVersion(db, versionId), affected_subscribers: subs.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 回滚 ----------
function rollback(db, productId, { toVersionId, reason = '人工回滚', operator = 'system' } = {}) {
  const product = getProduct(db, productId);
  if (!product.current_version_id) {
    throw new DomainError('NO_ACTIVE_VERSION', '产品当前没有已发布版本，无法回滚', 409);
  }
  const from = getVersion(db, product.current_version_id);
  if (from.status !== 'PUBLISHED') {
    throw new DomainError('INVALID_STATE', `当前版本状态 ${from.status}，不可回滚`, 409);
  }
  const to = getVersion(db, toVersionId);
  if (to.product_id !== productId) throw new DomainError('VERSION_MISMATCH', '目标版本不属于该产品', 400);
  if (to.id === from.id) throw new DomainError('VERSION_MISMATCH', '目标版本即当前版本', 400);
  if (to.status !== 'PUBLISHED') {
    throw new DomainError('INVALID_STATE', `回滚目标版本状态须为 PUBLISHED，当前 ${to.status}`, 409);
  }

  const fromSnap = parseSnapshot(from);
  const toSnap = parseSnapshot(to);
  const diff = diffSnapshots(fromSnap, toSnap);

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE product_versions SET status='ROLLED_BACK' WHERE id=?`).run(from.id);
    db.prepare('UPDATE products SET current_version_id=? WHERE id=?').run(to.id, productId);

    const subs = db.prepare('SELECT * FROM subscribers WHERE pinned_version_id = ?').all(from.id);
    for (const s of subs) {
      const perms = JSON.parse(s.permissions_json);
      const missing = perms.filter((m) => !snapshotMetricNames(toSnap).has(m));
      const eventDiff = {
        ...diff,
        type: 'ROLLBACK', reason, operator,
        from_version: from.version, from_version_id: from.id,
        to_version: to.version, to_version_id: to.id,
        missing_metrics: missing,
        message: `版本 ${from.version} 已回滚至 ${to.version}（${reason}）` +
          (missing.length ? `，目标版本缺少权限内指标：${missing.join('、')}` : ''),
      };
      db.prepare(
        `INSERT INTO subscriber_events (subscriber_id, version_id, type, diff_json, status, created_at)
         VALUES (?,?,?,?, 'PENDING', ?)`
      ).run(s.id, from.id, 'ROLLBACK', JSON.stringify(eventDiff), now());
      db.prepare(`UPDATE subscribers SET status='PENDING' WHERE id=?`).run(s.id);
    }
    db.prepare(
      `INSERT INTO rollback_records (product_id, from_version_id, to_version_id, reason, operator, affected_subscribers, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(productId, from.id, to.id, reason, operator, subs.length, now());
    db.exec('COMMIT');
    return { from, to, affected_subscribers: subs.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 权限收窄 / 放宽 ----------
function updatePermissions(db, subscriberId, newPerms) {
  const s = getSubscriber(db, subscriberId);
  const productMetrics = db.prepare(
    `SELECT m.name FROM product_metrics pm JOIN metrics m ON m.id=pm.metric_id WHERE pm.product_id=?`
  ).all(s.product_id).map((r) => r.name);
  const unknown = newPerms.filter((p) => !productMetrics.includes(p));
  if (unknown.length) {
    throw new DomainError('UNKNOWN_METRICS', `产品内不存在指标：${unknown.join('、')}`, 400, { unknown });
  }
  const oldPerms = JSON.parse(s.permissions_json);
  const removed = oldPerms.filter((p) => !newPerms.includes(p));
  const added = newPerms.filter((p) => !oldPerms.includes(p));

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE subscribers SET permissions_json=? WHERE id=?').run(JSON.stringify(newPerms), subscriberId);
    if (removed.length > 0) {
      // 收窄：立即生效 + 待处理事件，确认前禁止消费
      const diff = {
        type: 'PERMISSION_NARROWED',
        removed_permissions: removed,
        kept_permissions: newPerms,
        message: `权限收窄，移除指标：${removed.join('、')}`,
      };
      db.prepare(
        `INSERT INTO subscriber_events (subscriber_id, version_id, type, diff_json, status, created_at)
         VALUES (?, NULL, 'PERMISSION_NARROWED', ?, 'PENDING', ?)`
      ).run(subscriberId, JSON.stringify(diff), now());
      db.prepare(`UPDATE subscribers SET status='PENDING' WHERE id=?`).run(subscriberId);
    }
    db.exec('COMMIT');
    return { subscriber: getSubscriber(db, subscriberId), removed, added, narrowed: removed.length > 0 };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 订阅方确认（ack）----------
function ackSubscriber(db, subscriberId, { eventIds = null, targetVersionId = null, acceptReduced = false } = {}) {
  const s0 = getSubscriber(db, subscriberId);
  let pending = db.prepare(
    `SELECT * FROM subscriber_events WHERE subscriber_id=? AND status='PENDING' ORDER BY id`
  ).all(subscriberId);
  if (eventIds && eventIds.length) {
    const set = new Set(eventIds);
    pending = pending.filter((e) => set.has(e.id));
  }
  if (!pending.length) {
    return { subscriber: getSubscriber(db, subscriberId), acked: [] };
  }
  const product = getProduct(db, s0.product_id);
  const publishedVersion = (id) => {
    if (!id) return null;
    const v = db.prepare('SELECT * FROM product_versions WHERE id=?').get(id);
    return v && v.status === 'PUBLISHED' ? v : null;
  };

  db.exec('BEGIN');
  try {
    const acked = [];
    let cur = getSubscriber(db, subscriberId); // 循环内跟踪最新钉版/权限
    for (const ev of pending) {
      const diff = JSON.parse(ev.diff_json);
      const pinned = cur.pinned_version_id
        ? db.prepare('SELECT * FROM product_versions WHERE id=?').get(cur.pinned_version_id) : null;
      const pinnedConsumable = pinned && pinned.status === 'PUBLISHED';
      const needMigration =
        ev.type === 'VERSION_DEPRECATED' || ev.type === 'ROLLBACK' ||
        (ev.type === 'VERSION_PUBLISHED' && ((diff.missing_metrics || []).length > 0 || !pinnedConsumable));

      if (needMigration) {
        // 目标版本候选链：显式指定 → 事件建议 → 事件对应版本 → 产品当前版本，取第一个可消费的
        const candidates = [targetVersionId, diff.to_version_id, diff.target_version_id, diff.version_id, product.current_version_id];
        let target = null;
        for (const cid of candidates) {
          target = publishedVersion(cid);
          if (target) break;
        }
        if (!target) {
          throw new DomainError('NO_CONSUMABLE_TARGET', '没有可迁移的已发布版本', 409);
        }
        const names = snapshotMetricNames(parseSnapshot(target));
        let perms = JSON.parse(cur.permissions_json);
        const missing = perms.filter((m) => !names.has(m));
        if (missing.length && !acceptReduced) {
          throw new DomainError(
            'INCOMPLETE_TARGET',
            `目标版本 ${target.version} 缺少权限内指标：${missing.join('、')}；如需继续请确认接受权限缩减`,
            409,
            { missing_metrics: missing, target_version_id: target.id }
          );
        }
        if (missing.length && acceptReduced) {
          perms = perms.filter((m) => names.has(m));
          db.prepare('UPDATE subscribers SET permissions_json=? WHERE id=?').run(JSON.stringify(perms), subscriberId);
        }
        db.prepare('UPDATE subscribers SET pinned_version_id=? WHERE id=?').run(target.id, subscriberId);
        cur = getSubscriber(db, subscriberId);
      }
      db.prepare(`UPDATE subscriber_events SET status='ACKED', acked_at=? WHERE id=?`).run(now(), ev.id);
      acked.push(ev.id);
    }
    const remaining = db.prepare(
      `SELECT COUNT(*) AS c FROM subscriber_events WHERE subscriber_id=? AND status='PENDING'`
    ).get(subscriberId).c;
    if (remaining === 0) {
      db.prepare(`UPDATE subscribers SET status='ACTIVE' WHERE id=?`).run(subscriberId);
    }
    db.exec('COMMIT');
    return { subscriber: getSubscriber(db, subscriberId), acked };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 消费拦截 ----------
function consume(db, subscriberId) {
  const s = getSubscriber(db, subscriberId);
  if (s.status === 'PENDING') {
    const events = db.prepare(
      `SELECT * FROM subscriber_events WHERE subscriber_id=? AND status='PENDING' ORDER BY id`
    ).all(subscriberId).map((e) => ({ ...e, diff: JSON.parse(e.diff_json), diff_json: undefined }));
    throw new DomainError(
      'SUBSCRIBER_PENDING',
      '订阅方有待处理变更（下线/回滚/权限收窄/不完整版本），确认前禁止消费',
      423,
      { pending_events: events }
    );
  }
  if (!s.pinned_version_id) {
    throw new DomainError('NO_VERSION', '订阅方尚未绑定任何已发布版本', 409);
  }
  const v = getVersion(db, s.pinned_version_id);
  if (v.status !== 'PUBLISHED') {
    throw new DomainError(
      'VERSION_NOT_CONSUMABLE',
      `版本 ${v.version} 状态为 ${v.status}，属于不完整/不可用版本，禁止消费`,
      409,
      { version_id: v.id, version: v.version, version_status: v.status }
    );
  }
  const snap = parseSnapshot(v);
  const perms = JSON.parse(s.permissions_json);
  const names = snapshotMetricNames(snap);
  const missing = perms.filter((m) => !names.has(m));
  if (missing.length) {
    throw new DomainError(
      'VERSION_INCOMPLETE',
      `版本 ${v.version} 缺少权限内指标：${missing.join('、')}，属于不完整版本，禁止消费`,
      409,
      { version_id: v.id, missing_metrics: missing }
    );
  }
  return {
    subscriber: { id: s.id, name: s.name, permissions: perms },
    product_id: s.product_id,
    version: { id: v.id, version: v.version, frozen_at: snap.frozen_at },
    metrics: snap.metrics.filter((m) => perms.includes(m.name)),
    datasets: snap.datasets,
  };
}

// ---------- 崩溃恢复扫描 ----------
function recover(db) {
  // 1) 卡在 PUBLISHING 的版本 → 标记失败
  const stale = db.prepare(`SELECT * FROM product_versions WHERE status='PUBLISHING'`).all();
  for (const v of stale) {
    db.prepare(
      `UPDATE product_versions SET status='FAILED', fail_stage=COALESCE(fail_stage,'UNKNOWN'), fail_reason=? WHERE id=?`
    ).run('发布中途崩溃，恢复扫描标记为失败', v.id);
  }
  // 2) 已发布但 NOTIFY 阶段缺失的版本 → 补齐通知（幂等）
  const needNotify = db.prepare(
    `SELECT pv.* FROM product_versions pv
     WHERE pv.status='PUBLISHED'
       AND NOT EXISTS (SELECT 1 FROM publish_stages ps WHERE ps.version_id=pv.id AND ps.stage='NOTIFY')`
  ).all();
  let notified = 0;
  for (const v of needNotify) {
    notified += notifySubscribers(db, v.product_id, v.id);
  }
  return { recovered_failed: stale.length, recovered_notify_versions: needNotify.length, events_sent: notified };
}

// ---------- 依赖影响分析 ----------
function datasetImpact(db, datasetId) {
  const dataset = db.prepare('SELECT * FROM datasets WHERE id=?').get(datasetId);
  if (!dataset) throw new DomainError('DATASET_NOT_FOUND', `数据集 #${datasetId} 不存在`, 404);

  const products = db.prepare(
    `SELECT p.* FROM product_datasets pd JOIN products p ON p.id=pd.product_id WHERE pd.dataset_id=?`
  ).all(datasetId);

  const productImpacts = products.map((p) => {
    const versions = db.prepare(
      'SELECT * FROM product_versions WHERE product_id=? ORDER BY id DESC'
    ).all(p.id).filter((v) => {
      const snap = parseSnapshot(v);
      return snap && snap.datasets.some((d) => d.dataset_id === datasetId);
    }).map((v) => {
      const snap = parseSnapshot(v);
      const frozen = snap.datasets.find((d) => d.dataset_id === datasetId);
      return {
        version_id: v.id, version: v.version, status: v.status,
        frozen_dataset_version: frozen.dataset_version, frozen_data_hash: frozen.data_hash,
      };
    });
    const subscribers = db.prepare(
      'SELECT id, name, status, pinned_version_id FROM subscribers WHERE product_id=?'
    ).all(p.id);
    return { product_id: p.id, product_name: p.name, current_version_id: p.current_version_id, versions, subscribers };
  });

  // 下游产品闭包（依赖这些产品的产品）
  const downstream = [];
  const queue = products.map((p) => p.id);
  const seen = new Set(queue);
  while (queue.length) {
    const pid = queue.shift();
    const children = db.prepare(
      `SELECT p.id, p.name FROM product_dependencies d JOIN products p ON p.id=d.product_id
       WHERE d.depends_on_product_id=?`
    ).all(pid);
    for (const c of children) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        downstream.push(c);
        queue.push(c.id);
      }
    }
  }
  return { dataset, products: productImpacts, downstream_products: downstream };
}

module.exports = {
  STAGES, DomainError,
  getProduct, getVersion, getSubscriber, stagesOf, parseSnapshot,
  publish, deprecateVersion, rollback, updatePermissions, ackSubscriber,
  consume, recover, datasetImpact, diffSnapshots, notifySubscribers,
};
