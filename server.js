/**
 * 一个不依赖任何第三方包的静态文件服务器：把 public/ 目录发给浏览器。
 * Railway 会通过环境变量 PORT 告诉我们该监听哪个端口。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};
const gzipCache = new Map(); // 文字类文件压缩一次后留着，下次直接用

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { Allow: 'GET, HEAD' }, 'Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    return send(res, 400, {}, 'Bad Request');
  }
  if (pathname === '/health') return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok'); // 给平台做健康检查用
  if (pathname.endsWith('/')) pathname += 'index.html';

  // 只允许访问 public/ 里面的文件
  const file = path.join(ROOT, path.normalize(pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, {}, 'Forbidden');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, '404 找不到这个文件');

    const ext = path.extname(file).toLowerCase();
    const isText = ext === '.html' || ext === '.js' || ext === '.json';
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // 网页本身每次都重新确认；脚本地址带版本号，声音和图片很少变，都可以缓存久一点
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      'Last-Modified': stat.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff'
    };
    const head = req.method === 'HEAD';

    // 文字类文件：压缩后发送
    if (isText && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const key = file + ':' + stat.mtimeMs;
      let zipped = gzipCache.get(key);
      if (!zipped) {
        zipped = zlib.gzipSync(fs.readFileSync(file));
        gzipCache.set(key, zipped);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = zipped.length;
      return send(res, 200, headers, head ? undefined : zipped);
    }

    // 声音文件：支持"只要其中一段"的请求（iPhone 的浏览器播放声音时会这样请求）
    headers['Accept-Ranges'] = 'bytes';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : Math.max(0, stat.size - parseInt(m[2], 10));
      let end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        return send(res, 416, { 'Content-Range': 'bytes */' + stat.size }, '');
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (head) return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (head) return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log('叠积木网页版已启动，端口 ' + PORT);
});
