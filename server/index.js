'use strict';
// 服务入口：API + 静态文件
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./db');
const { seed } = require('./seed');
const { buildRoutes, handleApi } = require('./api');
const domain = require('./domain');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function createServer(dbPath = DB_PATH) {
  const db = createDb(dbPath);
  seed(db);
  domain.recover(db); // 启动时恢复扫描：清理上次可能残留的 PUBLISHING 状态
  const routes = buildRoutes(db);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(db, req, res, routes);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '接口不存在' } }));
      }
      return;
    }
    // 静态文件
    let filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(content);
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`数据产品发布台已启动: http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
