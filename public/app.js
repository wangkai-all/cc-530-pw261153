'use strict';
/* 数据产品发布台 SPA */

// ---------- 基础工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error ? json.error.message : `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json.error && json.error.code;
    err.details = json.error && json.error.details;
    throw err;
  }
  return json;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

// ---------- 状态徽章（图标+文字，不单独依赖颜色） ----------
const VERSION_STATUS = {
  PUBLISHED: ['good', '✓ 已发布'],
  PUBLISHING: ['warning', '◐ 发布中'],
  FAILED: ['critical', '✗ 失败'],
  DEPRECATED: ['serious', '↓ 已下线'],
  ROLLED_BACK: ['serious', '↩ 已回滚'],
};
const SUB_STATUS = {
  ACTIVE: ['good', '✓ 正常'],
  PENDING: ['warning', '⏳ 待处理'],
};
const EVENT_TYPE = {
  VERSION_PUBLISHED: ['info', '新版本发布'],
  VERSION_DEPRECATED: ['serious', '版本下线'],
  ROLLBACK: ['serious', '版本回滚'],
  PERMISSION_NARROWED: ['warning', '权限收窄'],
};
const badge = (map, key) => {
  const [cls, label] = map[key] || ['neutral', key];
  return `<span class="badge ${cls}">${label}</span>`;
};
const versionBadge = (s) => badge(VERSION_STATUS, s);
const subBadge = (s) => badge(SUB_STATUS, s);

// ---------- 差异渲染 ----------
function diffHtml(diff) {
  if (!diff) return '';
  const lines = [];
  if (diff.message) lines.push(`<div class="diff-msg">${esc(diff.message)}</div>`);
  const push = (tag, cls, text) => lines.push(`<div class="diff-line"><span class="tag ${cls}">${tag}</span><span>${esc(text)}</span></div>`);
  (diff.metrics?.added || []).forEach((m) => push('新增指标', 'add', m.name));
  (diff.metrics?.removed || []).forEach((m) => push('移除指标', 'remove', m.name));
  (diff.metrics?.changed || []).forEach((m) => push('变更指标', 'change', `${m.name}: ${m.from} → ${m.to}`));
  (diff.datasets?.version_changed || []).forEach((d) => push('数据变更', 'change', `${d.name}: v${d.from_version} → v${d.to_version}`));
  (diff.datasets?.added || []).forEach((d) => push('新增数据集', 'add', d.name));
  (diff.datasets?.removed || []).forEach((d) => push('移除数据集', 'remove', d.name));
  (diff.removed_permissions || []).forEach((p) => push('移除权限', 'remove', p));
  (diff.missing_metrics || []).forEach((m) => push('缺失指标', 'remove', m));
  (diff.lost_metrics || []).forEach((m) => push('下线涉及指标', 'remove', m));
  if (!lines.length) lines.push('<div class="hint">无差异明细</div>');
  return `<div class="diff-block">${lines.join('')}</div>`;
}

// ============================================================
// 页面 1：产品总览
// ============================================================
async function renderOverview(root) {
  const [overview, products, datasets] = await Promise.all([
    api('GET', '/api/overview'),
    api('GET', '/api/products'),
    api('GET', '/api/datasets'),
  ]);

  root.innerHTML = `
    <div class="kpi-row">
      ${kpi('数据产品', overview.products, `${datasets.length} 个数据集 · ${overview.metrics} 个指标`)}
      ${kpi('已发布版本', overview.published, `共 ${overview.versions} 个版本`, 'accent-good')}
      ${kpi('失败发布', overview.failed, '质量门禁 / 依赖 / 崩溃', overview.failed ? 'accent-critical' : '')}
      ${kpi('订阅方', overview.subscribers, '', '')}
      ${kpi('待处理订阅方', overview.pending_subscribers, '需确认变更', overview.pending_subscribers ? 'accent-warn' : '')}
      ${kpi('回滚次数', overview.rollbacks, '', '')}
    </div>
    <h2 class="section-title">产品与版本</h2>
    <div id="product-list"></div>
    <h2 class="section-title">数据集（模拟上游变更）</h2>
    <div id="dataset-list"></div>`;

  $('#product-list', root).innerHTML = products.map(productCard).join('');
  $('#dataset-list', root).innerHTML = datasets.map(datasetCard).join('');
  bindOverviewActions(root, products, datasets);
}

const kpi = (label, value, sub, cls = '') =>
  `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub || ''}</div></div>`;

function productCard(p) {
  const rows = p.versions.map((v) => `
    <tr>
      <td class="mono">v${esc(v.version)}</td>
      <td>${versionBadge(v.status)}</td>
      <td>${v.fail_reason ? `<span class="hint">${esc(v.fail_reason)}</span>` : ''}</td>
      <td class="num">${fmtTime(v.published_at || v.created_at)}</td>
      <td class="row-actions">
        ${v.status === 'PUBLISHED' ? `<button class="btn small warn" data-act="deprecate" data-version-id="${v.id}" data-version="${esc(v.version)}">下线</button>` : ''}
        ${v.status === 'PUBLISHED' && p.current_version && v.id !== p.current_version.id ? `<button class="btn small" data-act="rollback" data-version-id="${v.id}" data-version="${esc(v.version)}">回滚到此</button>` : ''}
      </td>
    </tr>`).join('');
  return `
  <div class="card" data-product="${p.id}">
    <div class="card-head">
      <h3>${esc(p.name)}</h3>
      <span class="hint">${esc(p.description)}</span>
      <span class="spacer"></span>
      <span class="hint">当前版本：</span>
      ${p.current_version ? `<span class="mono">v${esc(p.current_version.version)}</span> ${versionBadge(p.current_version.status)}` : '<span class="badge neutral">无</span>'}
      <span class="hint">订阅方 ${p.subscriber_count}</span>
    </div>
    <div class="card-head">
      <label class="field">新版本号 <input type="text" class="inp-version" placeholder="如 1.1.0" size="10"></label>
      <label class="field">故障注入
        <select class="inp-chaos">
          <option value="">无</option>
          <option value="CRASH_BEFORE_FREEZE">冻结前崩溃</option>
          <option value="CRASH_BEFORE_PUBLISH">发布前崩溃</option>
          <option value="CRASH_BEFORE_NOTIFY">通知前崩溃</option>
        </select>
      </label>
      <button class="btn primary small" data-act="publish">发布（冻结快照）</button>
      <span class="hint">重复发布同版本号会被拒绝；幂等键自动生成，重试安全</span>
    </div>
    <table class="grid">
      <thead><tr><th>版本</th><th>状态</th><th>失败原因</th><th class="num">时间</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="hint">暂无版本</td></tr>'}</tbody>
    </table>
  </div>`;
}

function datasetCard(d) {
  const latest = d.versions[0];
  return `
  <div class="card" data-dataset="${d.id}">
    <div class="card-head">
      <h3>${esc(d.name)}</h3>
      <span class="hint">owner: ${esc(d.owner)} · 当前数据版本 v${latest ? latest.version : '—'}</span>
      <span class="spacer"></span>
      <label class="field">行数 <input type="text" class="inp-rows" size="8" value="${latest ? latest.row_count : 10000}"></label>
      <label class="field">空值率 <input type="text" class="inp-null" size="6" value="${latest ? latest.null_rate : 0.001}"></label>
      <button class="btn small" data-act="bump">+ 新数据版本</button>
    </div>
  </div>`;
}

function bindOverviewActions(root, products, datasets) {
  // 用 onclick 赋值而非 addEventListener：section 元素常驻，避免重复渲染时处理器叠加
  root.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'publish') {
        const card = btn.closest('[data-product]');
        const productId = card.dataset.product;
        const version = $('.inp-version', card).value.trim();
        const chaos = $('.inp-chaos', card).value || null;
        if (!version) return toast('请输入版本号', true);
        const r = await api('POST', `/api/products/${productId}/publish`, {
          version, chaos, idempotencyKey: `ui-${productId}-${version}`,
        });
        if (r.failed) toast(`发布失败（${r.version.fail_stage}）：${r.version.fail_reason}`, true);
        else toast(`版本 ${version} 发布成功，快照已冻结`);
        refresh();
      } else if (act === 'deprecate') {
        const reason = prompt(`下线版本 v${btn.dataset.version} 的原因：`, '版本下线');
        if (reason === null) return;
        const r = await api('POST', `/api/versions/${btn.dataset.versionId}/deprecate`, { reason });
        toast(`版本已下线，${r.affected_subscribers} 个订阅方转入待处理`);
        refresh();
      } else if (act === 'rollback') {
        const card = btn.closest('[data-product]');
        const reason = prompt(`回滚到 v${btn.dataset.version} 的原因：`, '人工回滚');
        if (reason === null) return;
        const r = await api('POST', `/api/products/${card.dataset.product}/rollback`, {
          toVersionId: Number(btn.dataset.versionId), reason, operator: 'console',
        });
        toast(`已回滚，${r.affected_subscribers} 个订阅方收到差异并转入待处理`);
        refresh();
      } else if (act === 'bump') {
        const card = btn.closest('[data-dataset]');
        const rowCount = Number($('.inp-rows', card).value);
        const nullRate = Number($('.inp-null', card).value);
        const ds = datasets.find((d) => String(d.id) === card.dataset.dataset);
        const schema = ds && ds.versions[0] ? ds.versions[0].schema : [];
        const r = await api('POST', `/api/datasets/${card.dataset.datasetId}/versions`, {
          row_count: rowCount, null_rate: nullRate, schema,
        });
        toast(`数据集新版本 v${r.version} 已登记（hash ${r.data_hash}），可到「依赖影响」查看波及面`);
        refresh();
      }
    } catch (err) {
      toast(`${err.code || '错误'}: ${err.message}`, true);
      refresh();
    }
  };
}

// ============================================================
// 页面 2：发布流水线
// ============================================================
const STAGE_LABEL = {
  VALIDATE: '参数校验', FREEZE_SNAPSHOT: '冻结快照', QUALITY_GATE: '质量门禁',
  DEPENDENCY_CHECK: '依赖检查', PUBLISH: '正式发布', NOTIFY: '通知订阅方',
};
const STAGE_STATUS = {
  OK: ['ok', '✓ 通过'], FAILED: ['failed', '✗ 失败'], SKIPPED: ['skipped', '⊘ 跳过'],
};

async function renderPipelines(root) {
  const runs = await api('GET', '/api/pipelines');
  root.innerHTML = `
    <h2 class="section-title">发布流水线 <span class="hint">每次发布六个阶段：校验 → 冻结快照 → 质量门禁 → 依赖检查 → 发布 → 通知；中途失败整体回滚或标记失败，不产生半成品</span></h2>
    <div id="run-list">${runs.map(runCard).join('') || '<div class="card hint">暂无发布记录</div>'}</div>`;
  $$('.run-head', root).forEach((el) => el.addEventListener('click', () => {
    el.nextElementSibling.classList.toggle('hidden');
  }));
}

function runCard(v) {
  const stages = v.stages.map((s) => {
    const [cls, label] = STAGE_STATUS[s.status] || ['skipped', s.status];
    return `<div class="stage ${cls}">
      <div class="stage-name">${STAGE_LABEL[s.stage] || s.stage}</div>
      <div class="stage-status">${label}</div>
      <div class="stage-detail">${esc(s.detail)}</div>
    </div>`;
  }).join('');
  return `
  <div class="card">
    <div class="card-head run-head" style="cursor:pointer">
      <span class="mono">#${v.id}</span>
      <h3>${esc(v.product_name)}</h3>
      <span class="mono">v${esc(v.version)}</span>
      ${versionBadge(v.status)}
      ${v.fail_reason ? `<span class="hint">✗ ${esc(v.fail_reason)}</span>` : ''}
      <span class="spacer"></span>
      <span class="hint">${fmtTime(v.created_at)}</span>
    </div>
    <div class="hidden">
      <div class="stage-flow">${stages}</div>
      <div class="hint mono">幂等键: ${esc(v.idempotency_key || '—')}</div>
    </div>
  </div>`;
}

// ============================================================
// 页面 3：依赖影响
// ============================================================
async function renderImpact(root) {
  const datasets = await api('GET', '/api/datasets');
  root.innerHTML = `
    <h2 class="section-title">依赖影响分析
      <span class="hint">选择数据集，查看其变更波及的产品、冻结版本与订阅方</span>
    </h2>
    <div class="card">
      <label class="field">数据集
        <select id="impact-dataset">
          ${datasets.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="impact-result"></div>`;
  const sel = $('#impact-dataset', root);
  sel.addEventListener('change', () => loadImpact(sel.value));
  await loadImpact(sel.value);
}

const NODE_TYPE_COLOR = { dataset: 'var(--c1)', product: 'var(--c2)', version: 'var(--c3)', subscriber: 'var(--muted)' };
const STATUS_COLOR = { good: 'var(--good)', warning: 'var(--warning)', critical: 'var(--critical)', serious: 'var(--serious)', neutral: 'var(--muted)' };

async function loadImpact(datasetId) {
  const box = $('#impact-result');
  const data = await api('GET', `/api/datasets/${datasetId}/impact`);
  box.innerHTML = `
    <div class="graph-wrap">
      <svg id="impact-graph" width="100%" height="0" role="img" aria-label="依赖影响图"></svg>
      <div class="graph-legend">
        <span class="legend-item"><span class="legend-swatch" style="background:var(--c1)"></span>数据集</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--c2)"></span>产品</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--c3)"></span>版本</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--muted)"></span>订阅方</span>
        <span class="legend-item">状态：</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--good)"></span>正常/已发布</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--warning)"></span>待处理</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--critical)"></span>失败</span>
        <span class="legend-item"><span class="legend-swatch" style="background:var(--serious)"></span>已下线/已回滚</span>
      </div>
    </div>
    <h3 class="section-title">受影响产品与冻结版本（表视图）</h3>
    <div id="impact-tables">${impactTables(data)}</div>`;
  drawImpactGraph(data);
}

function impactTables(data) {
  return data.products.map((p) => `
    <div class="card">
      <div class="card-head"><h3>${esc(p.product_name)}</h3>
        ${data.downstream_products.length ? `<span class="hint">下游产品：${data.downstream_products.map((d) => esc(d.name)).join('、')}</span>` : ''}
      </div>
      <table class="grid">
        <thead><tr><th>版本</th><th>状态</th><th>冻结的数据版本</th><th>内容指纹</th></tr></thead>
        <tbody>${p.versions.map((v) => `
          <tr><td class="mono">v${esc(v.version)}</td><td>${versionBadge(v.status)}</td>
          <td class="num">v${v.frozen_dataset_version}</td><td class="mono">${esc(v.frozen_data_hash)}</td></tr>`).join('')}
        </tbody>
      </table>
      <table class="grid" style="margin-top:8px">
        <thead><tr><th>订阅方</th><th>状态</th></tr></thead>
        <tbody>${p.subscribers.map((s) => `
          <tr><td>${esc(s.name)}</td><td>${subBadge(s.status)}</td></tr>`).join('') || '<tr><td colspan="2" class="hint">无订阅方</td></tr>'}
        </tbody>
      </table>
    </div>`).join('') || '<div class="card hint">该数据集未被任何产品使用</div>';
}

function drawImpactGraph(data) {
  const svg = $('#impact-graph');
  if (!svg) return;
  // 构建四层节点：数据集 → 产品 → 版本 → 订阅方
  const layers = [[], [], [], []];
  layers[0].push({ type: 'dataset', label: data.dataset.name, sub: `owner ${data.dataset.owner}`, status: null, tip: `数据集 ${data.dataset.name}` });
  const edges = [];
  data.products.forEach((p, pi) => {
    const pNode = { type: 'product', label: p.product_name, sub: `${p.versions.length} 个相关版本`, status: null, tip: `产品 ${p.product_name}` };
    layers[1].push(pNode);
    edges.push([layers[0][0], pNode]);
    p.versions.forEach((v) => {
      const st = v.status === 'PUBLISHED' ? 'good' : v.status === 'FAILED' ? 'critical' : v.status === 'PUBLISHING' ? 'warning' : 'serious';
      const vNode = { type: 'version', label: `v${v.version}`, sub: `冻结数据 v${v.frozen_dataset_version}`, status: st, statusLabel: (VERSION_STATUS[v.status] || ['', v.status])[1], tip: `版本 v${v.version} · ${v.status} · 冻结 ${data.dataset.name}#v${v.frozen_dataset_version} (${v.frozen_data_hash})` };
      layers[2].push(vNode);
      edges.push([pNode, vNode]);
    });
    p.subscribers.forEach((s) => {
      const st = s.status === 'ACTIVE' ? 'good' : 'warning';
      const sNode = { type: 'subscriber', label: s.name, sub: s.status === 'ACTIVE' ? '消费中' : '待处理', status: st, statusLabel: (SUB_STATUS[s.status] || ['', s.status])[1], tip: `订阅方 ${s.name} · ${s.status}` };
      layers[3].push(sNode);
      edges.push([pNode, sNode]);
    });
  });

  const W = 1060, NODE_W = 170, NODE_H = 46, GAP_Y = 14;
  const layerX = [0, 300, 590, 860];
  const heights = layers.map((l) => l.length * (NODE_H + GAP_Y) - GAP_Y);
  const H = Math.max(...heights, 80) + 20;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.height = `${H}px`;

  layers.forEach((layer, li) => {
    const offsetY = (H - heights[li]) / 2;
    layer.forEach((n, i) => {
      n.x = layerX[li];
      n.y = offsetY + i * (NODE_H + GAP_Y);
    });
  });

  const edgePath = edges.map(([a, b]) =>
    `<path class="edge" d="M ${a.x + NODE_W} ${a.y + NODE_H / 2} C ${a.x + NODE_W + 60} ${a.y + NODE_H / 2}, ${b.x - 60} ${b.y + NODE_H / 2}, ${b.x} ${b.y + NODE_H / 2}"/>`
  ).join('');

  const nodeSvg = (n) => {
    const typeColor = NODE_TYPE_COLOR[n.type];
    const statusColor = n.status ? STATUS_COLOR[n.status] : null;
    return `<g class="node" data-tip="${esc(n.tip)}" transform="translate(${n.x},${n.y})">
      <rect width="${NODE_W}" height="${NODE_H}" fill="var(--surface-2, var(--surface))" stroke="var(--border)" rx="8"/>
      <rect width="4" height="${NODE_H}" fill="${typeColor}" rx="2"/>
      ${statusColor ? `<circle cx="${NODE_W - 12}" cy="12" r="4" fill="${statusColor}"/>` : ''}
      <text x="12" y="18" font-weight="650">${esc(n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label)}</text>
      <text x="12" y="34" fill="var(--muted)" font-size="10">${esc(n.statusLabel || n.sub)}</text>
    </g>`;
  };
  svg.innerHTML = edgePath + layers.flat().map(nodeSvg).join('');

  // 悬浮提示
  const tip = $('#tooltip');
  $$('.node', svg).forEach((g) => {
    g.addEventListener('mouseenter', (e) => {
      tip.innerHTML = `<div class="tt-title">${esc(g.dataset.tip)}</div>`;
      tip.classList.remove('hidden');
    });
    g.addEventListener('mousemove', (e) => {
      tip.style.left = `${e.clientX + 12}px`;
      tip.style.top = `${e.clientY + 12}px`;
    });
    g.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}

// ============================================================
// 页面 4：订阅状态
// ============================================================
async function renderSubscribers(root) {
  const subs = await api('GET', '/api/subscribers');
  root.innerHTML = `
    <h2 class="section-title">订阅状态 <span class="hint">版本下线 / 回滚 / 权限收窄 / 不完整版本 → 订阅方转入待处理，确认前禁止消费</span></h2>
    <div id="sub-list"></div>`;
  const list = $('#sub-list', root);
  list.innerHTML = await Promise.all(subs.map(async (s) => {
    const detail = await api('GET', `/api/subscribers/${s.id}`);
    return subscriberCard(detail);
  })).then((cards) => cards.join(''));
  bindSubscriberActions(list);
}

function subscriberCard(s) {
  const pending = s.events.filter((e) => e.status === 'PENDING');
  const history = s.events.filter((e) => e.status !== 'PENDING').slice(0, 5);
  const eventHtml = (e) => {
    const [cls, label] = EVENT_TYPE[e.type] || ['neutral', e.type];
    return `<div class="event-card ${e.status === 'ACKED' ? 'acked' : ''}">
      <div class="card-head" style="margin-bottom:2px">
        <span class="badge ${cls}">${label}</span>
        <span class="hint">${fmtTime(e.created_at)}</span>
        ${e.status === 'PENDING' ? '<span class="badge warning">⏳ 待确认</span>' : '<span class="badge neutral">已确认</span>'}
      </div>
      ${diffHtml(e.diff)}
    </div>`;
  };
  return `
  <div class="card" data-sub="${s.id}">
    <div class="card-head">
      <h3>${esc(s.name)}</h3>
      ${subBadge(s.status)}
      <span class="hint">产品 ${esc(s.product_name)}</span>
      <span class="hint">钉住版本：${s.pinned_version ? `v${esc(s.pinned_version.version)}` : '—'} ${s.pinned_version ? versionBadge(s.pinned_version.status) : ''}</span>
      <span class="spacer"></span>
      <button class="btn small" data-act="consume">试消费</button>
      ${pending.length ? `<button class="btn primary small" data-act="ack">确认变更（${pending.length}）</button>` : ''}
    </div>
    <div class="card-head">
      <span class="hint">权限指标：</span>
      ${s.permissions.map((p) => `<span class="badge info">${esc(p)}</span>`).join('') || '<span class="hint">（无权限）</span>'}
      <button class="btn small ghost" data-act="edit-perms">调整权限</button>
    </div>
    <div class="perms-editor hidden">
      <div class="row-actions" style="align-items:center">
        <input type="text" class="inp-perms" value="${esc(s.permissions.join(','))}" size="40" placeholder="逗号分隔的指标名">
        <button class="btn small primary" data-act="save-perms">保存</button>
        <span class="hint">移除权限即收窄，需订阅方确认后才能继续消费</span>
      </div>
    </div>
    <div class="consume-result hidden"></div>
    ${pending.length ? `<div><div class="hint" style="margin:6px 0 2px">待处理事件：</div>${pending.map(eventHtml).join('')}</div>` : ''}
    ${history.length ? `<details style="margin-top:6px"><summary class="hint">历史事件（${s.events.length}）</summary>${history.map(eventHtml).join('')}</details>` : ''}
  </div>`;
}

function bindSubscriberActions(list) {
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-sub]');
    const id = card.dataset.sub;
    const act = btn.dataset.act;
    try {
      if (act === 'consume') {
        const box = $('.consume-result', card);
        box.classList.remove('hidden');
        try {
          const r = await api('GET', `/api/subscribers/${id}/consume`);
          box.innerHTML = `<div class="diff-block"><div class="diff-msg">✓ 消费成功 · 版本 v${esc(r.version.version)} · 快照冻结于 ${fmtTime(r.version.frozen_at)}</div>
            ${r.metrics.map((m) => `<div class="diff-line"><span class="tag add">指标</span><span>${esc(m.name)} = ${esc(m.definition)}</span></div>`).join('')}
            <div class="hint">数据集：${r.datasets.map((d) => `${esc(d.name)}#v${d.dataset_version}(${d.data_hash})`).join('、')}</div></div>`;
        } catch (err2) {
          const evs = err2.details && err2.details.pending_events
            ? err2.details.pending_events.map((ev) => diffHtml(ev.diff)).join('') : '';
          box.innerHTML = `<div class="diff-block"><div class="diff-msg">✗ 消费被拦截 [${esc(err2.code)}] ${esc(err2.message)}</div>${evs}</div>`;
        }
      } else if (act === 'ack') {
        try {
          await api('POST', `/api/subscribers/${id}/ack`, {});
          toast('已确认全部变更，订阅方恢复消费');
        } catch (err2) {
          if (err2.code === 'INCOMPLETE_TARGET') {
            if (confirm(`${err2.message}\n\n是否接受权限缩减并继续？`)) {
              await api('POST', `/api/subscribers/${id}/ack`, { acceptReduced: true });
              toast('已接受权限缩减并确认');
            }
          } else throw err2;
        }
        refresh();
      } else if (act === 'edit-perms') {
        $('.perms-editor', card).classList.toggle('hidden');
      } else if (act === 'save-perms') {
        const perms = $('.inp-perms', card).value.split(',').map((x) => x.trim()).filter(Boolean);
        const r = await api('PATCH', `/api/subscribers/${id}/permissions`, { permissions: perms });
        toast(r.narrowed ? `权限已收窄（移除 ${r.removed.join('、')}），订阅方转入待处理` : '权限已更新');
        refresh();
      }
    } catch (err) {
      toast(`${err.code || '错误'}: ${err.message}`, true);
      refresh();
    }
  });
}

// ============================================================
// 页面 5：回滚记录
// ============================================================
async function renderRollbacks(root) {
  const rows = await api('GET', '/api/rollbacks');
  root.innerHTML = `
    <h2 class="section-title">回滚记录</h2>
    <div class="card">
      <table class="grid">
        <thead><tr><th>#</th><th>产品</th><th>从版本</th><th>回滚到</th><th>原因</th><th>操作人</th><th class="num">受影响订阅方</th><th class="num">时间</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td class="mono">#${r.id}</td>
            <td>${esc(r.product_name)}</td>
            <td class="mono">v${esc(r.from_version)}</td>
            <td class="mono">v${esc(r.to_version)}</td>
            <td>${esc(r.reason)}</td>
            <td>${esc(r.operator)}</td>
            <td class="num">${r.affected_subscribers}</td>
            <td class="num">${fmtTime(r.created_at)}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="hint">暂无回滚记录</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// ============================================================
// 路由与全局
// ============================================================
const PAGES = {
  overview: renderOverview,
  pipelines: renderPipelines,
  impact: renderImpact,
  subscribers: renderSubscribers,
  rollbacks: renderRollbacks,
};
let currentPage = 'overview';

async function refresh() {
  const fn = PAGES[currentPage];
  const root = $(`#page-${currentPage}`);
  try {
    await fn(root);
  } catch (e) {
    root.innerHTML = `<div class="card">加载失败：${esc(e.message)}</div>`;
  }
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  currentPage = btn.dataset.page;
  $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${currentPage}`));
  refresh();
});

$('#btn-recover').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/maintenance/recover');
    toast(`恢复扫描完成：标记失败 ${r.recovered_failed} 个，补齐通知 ${r.recovered_notify_versions} 个版本（${r.events_sent} 条事件）`);
    refresh();
  } catch (e) { toast(e.message, true); }
});

$('#btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? '' : 'dark';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('theme', cur);
});
document.documentElement.dataset.theme = localStorage.getItem('theme') || '';

refresh();
