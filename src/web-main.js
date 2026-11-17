/**
 * 网页版入口。和小游戏的 game.js 做的事一样：拿到画布、把触摸和前后台事件转给总控（utils/app.js）。
 * wx 这个对象在网页里由 wx-web.js 提供。
 */
const { GameApp } = require('./utils/app');
const { REWARDS } = require('./utils/rewards');

// 网页上没有微信的激励视频广告：道具只通过"转发给好友"获得
REWARDS.adEnabled = false;

const canvas = wx.createCanvas();
const info = wx.getWindowInfo();
const width = info.windowWidth;
const height = info.windowHeight;
const dpr = info.pixelRatio || 1;

canvas.width = Math.round(width * dpr);
canvas.height = Math.round(height * dpr);
const ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

const app = new GameApp({
  assetPrefix: '',     // 声音、图片和网页放在同一个目录下
  canvasSheet: true,   // "获取道具"弹窗画在画布上
  share: (content) => wx.shareAppMessage(content) // 浏览器能告诉我们玩家有没有分享出去
});

app.attachCanvas({
  ctx: ctx,
  width: width,
  height: height,
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id)
});

wx.onTouchStart((e) => {
  const t = e.touches[0];
  app.touch(t.clientX, t.clientY);
});
wx.onShow(() => app.show());
wx.onHide(() => app.hide());

// 电脑上可以用空格 / 回车：开始页是"开始"，游戏中是放下积木
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (e.repeat) return;
  e.preventDefault();
  if (app.sheet) return;
  if (app.st.view === 'start') app.startLevel(1);
  else if (app.st.view === 'play') app.touch(-1, -1); // 屏幕外的坐标：不会点到任何按钮，只会放下积木
});

window.__game = app; // 方便在浏览器控制台里查看状态
