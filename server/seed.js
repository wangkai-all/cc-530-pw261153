'use strict';
// 种子数据：数据集/数据版本/指标/门禁/产品/订阅方，并执行初始发布（含一次注定失败的发布用于演示）
const crypto = require('node:crypto');
const { now } = require('./db');
const domain = require('./domain');

function dataHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM datasets').get().c;
  if (count > 0) return false;

  const insDataset = db.prepare('INSERT INTO datasets (name, owner, created_at) VALUES (?,?,?)');
  const insDv = db.prepare(
    'INSERT INTO dataset_versions (dataset_id, version, row_count, null_rate, schema_json, data_hash, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const insMetric = db.prepare('INSERT INTO metrics (name, definition, dataset_id, created_at) VALUES (?,?,?,?)');
  const insGate = db.prepare('INSERT INTO quality_gates (name, dataset_id, rules_json, created_at) VALUES (?,?,?,?)');
  const insProduct = db.prepare('INSERT INTO products (name, description, owner, created_at) VALUES (?,?,?,?)');
  const insPd = db.prepare('INSERT INTO product_datasets (product_id, dataset_id) VALUES (?,?)');
  const insPm = db.prepare('INSERT INTO product_metrics (product_id, metric_id) VALUES (?,?)');
  const insPg = db.prepare('INSERT INTO product_gates (product_id, gate_id) VALUES (?,?)');
  const insDep = db.prepare('INSERT INTO product_dependencies (product_id, depends_on_product_id) VALUES (?,?)');
  const insSub = db.prepare(
    `INSERT INTO subscribers (name, product_id, status, permissions_json, created_at) VALUES (?,?, 'ACTIVE', ?, ?)`
  );

  db.exec('BEGIN');
  try {
    // 数据集与数据版本
    const orders = Number(insDataset.run('orders', '交易团队', now()).lastInsertRowid);
    const users = Number(insDataset.run('users', '用户团队', now()).lastInsertRowid);
    const payments = Number(insDataset.run('payments', '支付团队', now()).lastInsertRowid);
    const inventory = Number(insDataset.run('inventory', '供应链团队', now()).lastInsertRowid);

    const addDv = (datasetId, version, rows, nullRate, schema) => {
      const hash = dataHash({ datasetId, version, rows, nullRate, schema });
      insDv.run(datasetId, version, rows, nullRate, JSON.stringify(schema), hash, now());
    };
    addDv(orders, 1, 128000, 0.003, ['order_id', 'user_id', 'amount', 'status', 'created_at']);
    addDv(orders, 2, 132500, 0.004, ['order_id', 'user_id', 'amount', 'status', 'created_at']);
    addDv(users, 1, 46000, 0.001, ['user_id', 'region', 'level', 'created_at']);
    addDv(payments, 1, 98000, 0.15, ['pay_id', 'order_id', 'channel', 'amount', 'paid_at']); // 空值率超标
    addDv(inventory, 1, 8200, 0.004, ['sku', 'warehouse', 'stock', 'updated_at']);

    // 指标
    const mDailyOrders = Number(insMetric.run('daily_orders', 'count(distinct order_id) / day', orders, now()).lastInsertRowid);
    const mAov = Number(insMetric.run('avg_order_value', 'sum(amount) / count(order_id)', orders, now()).lastInsertRowid);
    const mActiveUsers = Number(insMetric.run('active_users', 'count(distinct user_id) where active', users, now()).lastInsertRowid);
    const mPaySuccess = Number(insMetric.run('payment_success_rate', 'success_pays / total_pays', payments, now()).lastInsertRowid);
    const mInvTurn = Number(insMetric.run('inventory_turnover', 'sales / avg_stock', inventory, now()).lastInsertRowid);

    // 质量门禁
    const gOrders = Number(insGate.run('订单数据门禁', orders,
      JSON.stringify({ max_null_rate: 0.01, min_row_count: 100000, required_columns: ['order_id', 'amount'] }), now()).lastInsertRowid);
    const gUsers = Number(insGate.run('用户数据门禁', users,
      JSON.stringify({ max_null_rate: 0.01, min_row_count: 10000, required_columns: ['user_id'] }), now()).lastInsertRowid);
    const gPayments = Number(insGate.run('支付数据门禁', payments,
      JSON.stringify({ max_null_rate: 0.05, min_row_count: 50000, required_columns: ['pay_id', 'amount'] }), now()).lastInsertRowid);

    // 产品
    const pTrade = Number(insProduct.run('trade-analytics', '交易分析产品：订单与用户分析指标', '数据平台组', now()).lastInsertRowid);
    const pPay = Number(insProduct.run('payment-monitor', '支付监控产品：支付链路成功率监控', '数据平台组', now()).lastInsertRowid);
    const pDash = Number(insProduct.run('biz-dashboard', '经营大盘：依赖交易分析的下游经营指标', '数据平台组', now()).lastInsertRowid);

    // 产品组成
    [[pTrade, orders], [pTrade, users], [pPay, payments], [pDash, inventory]].forEach(([p, d]) => insPd.run(p, d));
    [[pTrade, mDailyOrders], [pTrade, mAov], [pTrade, mActiveUsers], [pPay, mPaySuccess], [pDash, mInvTurn]]
      .forEach(([p, m]) => insPm.run(p, m));
    [[pTrade, gOrders], [pTrade, gUsers], [pPay, gPayments]].forEach(([p, g]) => insPg.run(p, g));

    // 产品依赖：经营大盘依赖交易分析
    insDep.run(pDash, pTrade);

    // 订阅方
    insSub.run('风控团队', pTrade, JSON.stringify(['daily_orders', 'avg_order_value']), now());
    insSub.run('财务团队', pTrade, JSON.stringify(['avg_order_value']), now());
    insSub.run('运营团队', pDash, JSON.stringify(['inventory_turnover']), now());
    insSub.run('支付SRE', pPay, JSON.stringify(['payment_success_rate']), now());

    db.exec('COMMIT');

    // 初始发布（在事务外走完整流水线）
    domain.publish(db, pTrade, { version: '1.0.0', idempotencyKey: 'seed-trade-1.0.0' }); // 成功
    domain.publish(db, pPay, { version: '1.0.0', idempotencyKey: 'seed-pay-1.0.0' });     // 质量门禁失败（payments 空值率 0.15 > 0.05）
    domain.publish(db, pDash, { version: '1.0.0', idempotencyKey: 'seed-dash-1.0.0' });   // 成功（依赖已就绪）
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 已提交则忽略 */ }
    throw e;
  }
}

module.exports = { seed, dataHash };
