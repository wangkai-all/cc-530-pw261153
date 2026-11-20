'use strict';
// HTTP API 层：REST 路由 + 统一错误格式
const domain = require('./domain');
const { now } = require('./db');
const { dataHash } = require('./seed');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// 路由表：[method, 正则, 参数名, handler]
function buildRoutes(db) {
  const q = (sql) => db.prepare(sql);
  const withEvents = (s) => ({
    ...s,
    permissions: JSON.parse(s.permissions_json),
    permissions_json: undefined,
    pending_events: q(
      `SELECT COUNT(*) AS c FROM subscriber_events WHERE subscriber_id=? AND status='PENDING'`
    ).get(s.id).c,
  });

  return [
    ['GET', /^\/api\/overview$/, [], () => {
      const count = (t) => q(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      return {
        products: count('products'),
        datasets: count('datasets'),
        metrics: count('metrics'),
        versions: count('product_versions'),
        published: q(`SELECT COUNT(*) AS c FROM product_versions WHERE status='PUBLISHED'`).get().c,
        failed: q(`SELECT COUNT(*) AS c FROM product_versions WHERE status='FAILED'`).get().c,
        subscribers: count('subscribers'),
        pending_subscribers: q(`SELECT COUNT(*) AS c FROM subscribers WHERE status='PENDING'`).get().c,
        rollbacks: count('rollback_records'),
      };
    }],

    ['GET', /^\/api\/products$/, [], () =>
      q('SELECT * FROM products ORDER BY id').all().map((p) => ({
        ...p,
        current_version: p.current_version_id
          ? q('SELECT id, version, status FROM product_versions WHERE id=?').get(p.current_version_id) : null,
        versions: q('SELECT id, version, status, fail_reason, created_at, published_at FROM product_versions WHERE product_id=? ORDER BY id DESC').all(p.id),
        subscriber_count: q('SELECT COUNT(*) AS c FROM subscribers WHERE product_id=?').get(p.id).c,
      }))],

    ['GET', /^\/api\/products\/(\d+)$/, ['id'], ({ id }) => {
      const p = domain.getProduct(db, Number(id));
      return {
        ...p,
        datasets: q('SELECT d.* FROM product_datasets pd JOIN datasets d ON d.id=pd.dataset_id WHERE pd.product_id=?').all(p.id),
        metrics: q('SELECT m.* FROM product_metrics pm JOIN metrics m ON m.id=pm.metric_id WHERE pm.product_id=?').all(p.id),
        gates: q('SELECT g.* FROM product_gates pg JOIN quality_gates g ON g.id=pg.gate_id WHERE pg.product_id=?').all(p.id)
          .map((g) => ({ ...g, rules: JSON.parse(g.rules_json), rules_json: undefined })),
        dependencies: q('SELECT p.id, p.name FROM product_dependencies d JOIN products p ON p.id=d.depends_on_product_id WHERE d.product_id=?').all(p.id),
        dependents: q('SELECT p.id, p.name FROM product_dependencies d JOIN products p ON p.id=d.product_id WHERE d.depends_on_product_id=?').all(p.id),
        versions: q('SELECT * FROM product_versions WHERE product_id=? ORDER BY id DESC').all(p.id)
          .map((v) => ({ ...v, snapshot: v.snapshot_json ? JSON.parse(v.snapshot_json) : null, snapshot_json: undefined })),
      };
    }],

    ['POST', /^\/api\/products\/(\d+)\/publish$/, ['id'], async ({ id }, body) =>
      domain.publish(db, Number(id), {
        version: body.version,
        idempotencyKey: body.idempotencyKey || null,
        chaos: body.chaos || null,
      })],

    ['POST', /^\/api\/products\/(\d+)\/rollback$/, ['id'], async ({ id }, body) =>
      domain.rollback(db, Number(id), {
        toVersionId: Number(body.toVersionId),
        reason: body.reason || '人工回滚',
        operator: body.operator || 'console',
      })],

    ['POST', /^\/api\/products\/(\d+)\/metrics$/, ['id'], async ({ id }, body) => {
      // 调整产品指标组成（用于演示版本间指标增删）
      const p = domain.getProduct(db, Number(id));
      const add = body.add || [];
      const remove = body.remove || [];
      db.exec('BEGIN');
      try {
        for (const name of add) {
          const m = q('SELECT * FROM metrics WHERE name=?').get(name);
          if (!m) throw new domain.DomainError('METRIC_NOT_FOUND', `指标 ${name} 不存在`, 404);
          q('INSERT OR IGNORE INTO product_metrics (product_id, metric_id) VALUES (?,?)').run(p.id, m.id);
        }
        for (const name of remove) {
          const m = q('SELECT * FROM metrics WHERE name=?').get(name);
          if (m) q('DELETE FROM product_metrics WHERE product_id=? AND metric_id=?').run(p.id, m.id);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { ok: true };
    }],

    ['GET', /^\/api\/products\/(\d+)\/dependencies$/, ['id'], ({ id }) => {
      const p = domain.getProduct(db, Number(id));
      const upstream = q(
        `SELECT p.id, p.name, p.current_version_id, v.status AS current_status, v.version AS current_version
         FROM product_dependencies d JOIN products p ON p.id=d.depends_on_product_id
         LEFT JOIN product_versions v ON v.id=p.current_version_id WHERE d.product_id=?`
      ).all(p.id);
      const downstream = q(
        'SELECT p.id, p.name FROM product_dependencies d JOIN products p ON p.id=d.product_id WHERE d.depends_on_product_id=?'
      ).all(p.id);
      return { product: { id: p.id, name: p.name }, upstream, downstream };
    }],

    ['POST', /^\/api\/versions\/(\d+)\/deprecate$/, ['id'], async ({ id }, body) =>
      domain.deprecateVersion(db, Number(id), { reason: body.reason || '版本下线' })],

    ['GET', /^\/api\/pipelines$/, [], () =>
      q('SELECT pv.*, p.name AS product_name FROM product_versions pv JOIN products p ON p.id=pv.product_id ORDER BY pv.id DESC').all()
        .map((v) => ({ ...v, snapshot_json: undefined, stages: domain.stagesOf(db, v.id) }))],

    ['GET', /^\/api\/pipelines\/(\d+)$/, ['id'], ({ id }) => {
      const v = domain.getVersion(db, Number(id));
      return {
        ...v,
        snapshot: v.snapshot_json ? JSON.parse(v.snapshot_json) : null,
        snapshot_json: undefined,
        stages: domain.stagesOf(db, v.id),
      };
    }],

    ['GET', /^\/api\/datasets$/, [], () =>
      q('SELECT * FROM datasets ORDER BY id').all().map((d) => ({
        ...d,
        versions: q('SELECT * FROM dataset_versions WHERE dataset_id=? ORDER BY version DESC').all(d.id)
          .map((dv) => ({ ...dv, schema: JSON.parse(dv.schema_json), schema_json: undefined })),
      }))],

    ['POST', /^\/api\/datasets\/(\d+)\/versions$/, ['id'], async ({ id }, body) => {
      const d = q('SELECT * FROM datasets WHERE id=?').get(Number(id));
      if (!d) throw new domain.DomainError('DATASET_NOT_FOUND', `数据集 #${id} 不存在`, 404);
      const latest = q('SELECT MAX(version) AS v FROM dataset_versions WHERE dataset_id=?').get(d.id).v || 0;
      const rowCount = Number(body.row_count);
      const nullRate = Number(body.null_rate);
      const schema = body.schema || [];
      if (!Number.isFinite(rowCount) || !Number.isFinite(nullRate) || !Array.isArray(schema)) {
        throw new domain.DomainError('INVALID_INPUT', 'row_count / null_rate / schema 参数不合法', 400);
      }
      const version = latest + 1;
      const hash = dataHash({ datasetId: d.id, version, rows: rowCount, nullRate, schema });
      q('INSERT INTO dataset_versions (dataset_id, version, row_count, null_rate, schema_json, data_hash, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(d.id, version, rowCount, nullRate, JSON.stringify(schema), hash, now());
      return q('SELECT * FROM dataset_versions WHERE dataset_id=? AND version=?').get(d.id, version);
    }],

    ['GET', /^\/api\/datasets\/(\d+)\/impact$/, ['id'], ({ id }) => domain.datasetImpact(db, Number(id))],

    ['GET', /^\/api\/subscribers$/, [], () =>
      q('SELECT s.*, p.name AS product_name FROM subscribers s JOIN products p ON p.id=s.product_id ORDER BY s.id').all()
        .map(withEvents)],

    ['GET', /^\/api\/subscribers\/(\d+)$/, ['id'], ({ id }) => {
      const s = domain.getSubscriber(db, Number(id));
      const product = q('SELECT name FROM products WHERE id=?').get(s.product_id);
      const events = q('SELECT * FROM subscriber_events WHERE subscriber_id=? ORDER BY id DESC').all(s.id)
        .map((e) => ({ ...e, diff: JSON.parse(e.diff_json), diff_json: undefined }));
      const pinned = s.pinned_version_id ? domain.getVersion(db, s.pinned_version_id) : null;
      return { ...withEvents(s), product_name: product ? product.name : '', events, pinned_version: pinned ? { id: pinned.id, version: pinned.version, status: pinned.status } : null };
    }],

    ['POST', /^\/api\/subscribers\/(\d+)\/ack$/, ['id'], async ({ id }, body) =>
      domain.ackSubscriber(db, Number(id), {
        eventIds: body.eventIds || null,
        targetVersionId: body.targetVersionId ? Number(body.targetVersionId) : null,
        acceptReduced: !!body.acceptReduced,
      })],

    ['PATCH', /^\/api\/subscribers\/(\d+)\/permissions$/, ['id'], async ({ id }, body) => {
      if (!Array.isArray(body.permissions)) {
        throw new domain.DomainError('INVALID_INPUT', 'permissions 必须是数组', 400);
      }
      return domain.updatePermissions(db, Number(id), body.permissions);
    }],

    ['GET', /^\/api\/subscribers\/(\d+)\/consume$/, ['id'], ({ id }) =>
      domain.consume(db, Number(id))],

    ['GET', /^\/api\/rollbacks$/, [], () =>
      q(`SELECT r.*, p.name AS product_name,
                fv.version AS from_version, tv.version AS to_version
         FROM rollback_records r
         JOIN products p ON p.id=r.product_id
         JOIN product_versions fv ON fv.id=r.from_version_id
         JOIN product_versions tv ON tv.id=r.to_version_id
         ORDER BY r.id DESC`).all()],

    ['POST', /^\/api\/maintenance\/recover$/, [], async () => domain.recover(db)],
  ];
}

async function handleApi(db, req, res, routes) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  for (const [method, re, params, handler] of routes) {
    if (req.method !== method) continue;
    const m = re.exec(path);
    if (!m) continue;
    const args = {};
    params.forEach((name, i) => { args[name] = m[i + 1]; });
    try {
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = await handler(args, body, url);
      json(res, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      if (e instanceof domain.DomainError) {
        json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
      } else {
        json(res, 500, { error: { code: 'INTERNAL', message: e.message } });
      }
    }
    return true;
  }
  return false;
}

module.exports = { buildRoutes, handleApi };
