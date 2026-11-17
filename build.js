/**
 * 把游戏打包成网页：node build.js [小游戏工程目录]
 *
 * 游戏本体的代码在小游戏工程里（默认是旁边的 ../stack-blocks）。这个脚本把它的 utils/*.js、
 * 声音和图片，加上 src/ 里的两份网页专用代码，合成 public/ 目录——也就是最终放到服务器上的全部内容。
 * 游戏改动之后，重新运行一次这个脚本即可。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const gameDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'stack-blocks'));
const outDir = path.join(__dirname, 'public');
const read = (f) => fs.readFileSync(f, 'utf8');

if (!fs.existsSync(path.join(gameDir, 'utils', 'app.js'))) {
  // 服务器上（比如 Railway）只有这个文件夹，没有小游戏工程：public/ 里已经是打包好的成品，直接用它
  if (fs.existsSync(path.join(outDir, 'game.js')) && fs.existsSync(path.join(outDir, 'index.html'))) {
    console.log('没有找到小游戏工程（' + gameDir + '），沿用已经打包好的 public/。');
    process.exit(0);
  }
  console.error('找不到小游戏工程：' + gameDir + '\n用法：node build.js <小游戏工程目录>');
  process.exit(1);
}

// 1) 把各个模块合成一个文件。模块之间用 require('./xxx') 互相引用，这里配一个最小的 require
const modules = {};
for (const f of fs.readdirSync(path.join(gameDir, 'utils'))) {
  if (f.endsWith('.js')) modules[f.replace(/\.js$/, '')] = read(path.join(gameDir, 'utils', f));
}
modules.main = read(path.join(__dirname, 'src', 'web-main.js'));

let bundle = '/* 由 build.js 生成，请不要直接修改 */\n';
bundle += read(path.join(__dirname, 'src', 'wx-web.js')) + '\n';
bundle += '(function () {\n"use strict";\nvar defs = {};\n';
for (const name of Object.keys(modules)) {
  bundle += 'defs[' + JSON.stringify(name) + '] = function (module, exports, require) {\n' + modules[name] + '\n};\n';
}
bundle += `var cache = {};
function load(name) {
  if (!cache[name]) {
    if (!defs[name]) throw new Error('找不到模块 ' + name);
    var m = { exports: {} };
    cache[name] = m;
    defs[name](m, m.exports, function (p) { return load(p.replace(/^.*\\//, '').replace(/\\.js$/, '')); });
  }
  return cache[name].exports;
}
load('main');
})();
`;

// 2) 写出 public/
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const copyDir = (name) => {
  fs.mkdirSync(path.join(outDir, name), { recursive: true });
  for (const f of fs.readdirSync(path.join(gameDir, name))) {
    fs.copyFileSync(path.join(gameDir, name, f), path.join(outDir, name, f));
  }
};
copyDir('audio');
copyDir('images');
fs.copyFileSync(path.join(__dirname, 'src', 'icon.png'), path.join(outDir, 'icon.png'));
fs.writeFileSync(path.join(outDir, 'game.js'), bundle);

// 脚本地址后面带上内容的指纹：游戏更新后浏览器不会继续用旧缓存
const version = crypto.createHash('sha1').update(bundle).digest('hex').slice(0, 10);
fs.writeFileSync(path.join(outDir, 'index.html'), read(path.join(__dirname, 'src', 'index.html')).replace(/__VERSION__/g, version));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log('已生成 public/，共 ' + Math.round(size(outDir) / 1024) + ' KB，版本 ' + version);
