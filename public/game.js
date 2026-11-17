/* 由 build.js 生成，请不要直接修改 */
/**
 * 浏览器版的 wx。
 *
 * 游戏代码是按微信小游戏的接口写的（wx.createCanvas、wx.onTouchStart、wx.createInnerAudioContext……）。
 * 这个文件用浏览器自己的能力把这些接口实现一遍，这样同一份游戏代码不用改就能在网页里跑。
 */
(function () {
  'use strict';

  /* ---------------- 舞台：一块竖屏比例的画布 ---------------- */

  var canvas = document.getElementById('stage');
  var handed = false; // 第一次 wx.createCanvas() 交出这块画布，之后再要就给新的离屏画布

  // 刘海屏 / 底部横条要让开的高度
  var probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
    'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  var cs = window.getComputedStyle(probe);
  var safeTop = parseFloat(cs.paddingTop) || 0;
  var safeBottom = parseFloat(cs.paddingBottom) || 0;
  document.body.removeChild(probe);

  // 手机竖屏：铺满整个窗口。电脑、平板、横屏：在中间放一块手机比例的舞台
  var vw = window.innerWidth, vh = window.innerHeight;
  var stageW = vw, stageH = vh;
  if (vw > vh * 0.62) stageW = Math.round(Math.min(vw, vh * 0.5625, 520));
  var framed = stageW < vw - 1;
  if (framed) { safeTop = 0; safeBottom = 0; document.body.className += ' framed'; }
  var dpr = Math.min(window.devicePixelRatio || 1, 3);

  // 窗口大小变了：画布按比例缩放（游戏内部的坐标不变）
  function fit() {
    var k = Math.min(window.innerWidth / stageW, window.innerHeight / stageH);
    canvas.style.width = Math.round(stageW * k) + 'px';
    canvas.style.height = Math.round(stageH * k) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);

  function info() {
    return {
      pixelRatio: dpr,
      windowWidth: stageW, windowHeight: stageH,
      screenWidth: stageW, screenHeight: stageH,
      safeArea: { top: safeTop, bottom: stageH - safeBottom, left: 0, right: stageW }
    };
  }

  /* ---------------- 触摸 / 前后台 ---------------- */

  var onTouch = [], onShow = [], onHide = [];

  canvas.addEventListener('pointerdown', function (e) {
    if (e.button) return; // 只认鼠标左键和手指
    e.preventDefault();
    unlockAudio();
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (stageW / rect.width);
    var y = (e.clientY - rect.top) * (stageH / rect.height);
    var ev = { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] };
    for (var i = 0; i < onTouch.length; i++) onTouch[i](ev);
  });
  // 禁止长按菜单、双指缩放、下拉刷新这些会打断游戏的浏览器手势
  ['contextmenu', 'gesturestart', 'dblclick'].forEach(function (n) {
    document.addEventListener(n, function (e) { e.preventDefault(); });
  });
  document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

  document.addEventListener('visibilitychange', function () {
    var list = document.hidden ? onHide : onShow;
    for (var i = 0; i < list.length; i++) list[i]();
  });

  /* ---------------- 提示条 ---------------- */

  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 1800);
  }

  /* ---------------- 声音：用 Web Audio，点下去立刻响，背景可以无缝循环 ---------------- */

  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null;
  var buffers = {}; // 地址 -> 解码好的声音（Promise）

  function audio() {
    if (!actx && AC) actx = new AC();
    return actx;
  }

  // 浏览器要求：玩家第一次操作之后才允许出声
  function unlockAudio() {
    var c = audio();
    if (c && c.state === 'suspended') c.resume();
  }
  document.addEventListener('keydown', unlockAudio);
  document.addEventListener('touchend', unlockAudio);

  function loadSound(url) {
    if (!buffers[url]) {
      buffers[url] = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.arrayBuffer();
      }).then(function (data) {
        return new Promise(function (resolve, reject) { audio().decodeAudioData(data, resolve, reject); });
      });
      buffers[url].catch(function () { delete buffers[url]; });
    }
    return buffers[url];
  }

  /** 和微信的 InnerAudioContext 同样用法的播放器 */
  function createInnerAudioContext() {
    var handlers = {};
    var src = '', volume = 1;
    var node = null, gain = null;
    var offset = 0, startedAt = 0, duration = 0;
    var token = 0;   // 每次 播放/暂停/停止 都加一，用来作废还在路上的旧"播放"
    var dead = false;

    function fire(name, arg) { if (handlers[name]) handlers[name](arg); }

    function dropNode() {
      if (!node) return;
      var n = node, g = gain;
      node = null; gain = null;
      n.onended = null;
      try { n.stop(); } catch (e) {}
      try { n.disconnect(); g.disconnect(); } catch (e) {}
    }

    var a = {
      loop: false,
      get src() { return src; },
      set src(v) {
        src = v;
        if (v && AC) loadSound(v).catch(function (e) { fire('error', { errCode: -1, errMsg: String(e && e.message || e) }); });
      },
      get volume() { return volume; },
      set volume(v) { volume = v; if (gain) gain.gain.value = v; },

      play: function () {
        if (dead || !src || !AC || node) return; // 已经在响就不重复开始
        var my = ++token;
        loadSound(src).then(function (buf) {
          if (dead || my !== token || node) return; // 这期间已经被暂停 / 停止 / 销毁了
          var c = audio();
          duration = buf.duration;
          var n = c.createBufferSource();
          n.buffer = buf;
          n.loop = !!a.loop;
          gain = c.createGain();
          gain.gain.value = volume;
          n.connect(gain);
          gain.connect(c.destination);
          n.onended = function () {
            if (node !== n) return;
            node = null; gain = null; offset = 0;
            fire('ended');
          };
          var from = duration ? offset % duration : 0;
          n.start(0, from);
          startedAt = c.currentTime - from;
          node = n;
          fire('play');
        }).catch(function () {});
      },
      pause: function () {
        token++;
        if (!node) return;
        offset = duration ? (audio().currentTime - startedAt) % duration : 0;
        dropNode();
        fire('pause');
      },
      stop: function () {
        token++;
        offset = 0;
        if (!node) return;
        dropNode();
        fire('stop');
      },
      seek: function (t) {
        offset = t || 0;
        if (node) { token++; dropNode(); } // 游戏里的用法是 seek(0) 之后马上 play()：从头再响
      },
      destroy: function () { dead = true; token++; dropNode(); },

      onPlay: function (f) { handlers.play = f; },
      onPause: function (f) { handlers.pause = f; },
      onStop: function (f) { handlers.stop = f; },
      onEnded: function (f) { handlers.ended = f; },
      onError: function (f) { handlers.error = f; }
    };
    return a;
  }

  /* ---------------- 其余接口 ---------------- */

  var shareHandler = null;

  window.wx = {
    // 画布和屏幕
    createCanvas: function () {
      if (!handed) { handed = true; return canvas; }
      return document.createElement('canvas');
    },
    getWindowInfo: info,
    getSystemInfoSync: info,
    getMenuButtonBoundingClientRect: function () { return { top: safeTop, bottom: safeTop + 6 }; }, // 网页上没有右上角胶囊，只让开刘海

    // 触摸和前后台
    onTouchStart: function (f) { onTouch.push(f); },
    onShow: function (f) { onShow.push(f); },
    onHide: function (f) { onHide.push(f); },

    // 存档：浏览器的本地存储（换浏览器、清缓存会丢）
    getStorageSync: function (key) {
      try { var v = window.localStorage.getItem(key); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; }
    },
    setStorageSync: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    },

    // 声音
    createInnerAudioContext: createInnerAudioContext,
    setInnerAudioOption: function () {},

    // 震动（只有部分安卓浏览器支持）
    vibrateShort: function () { if (navigator.vibrate) navigator.vibrate(12); },
    vibrateLong: function () { if (navigator.vibrate) navigator.vibrate(120); },

    // 提示
    showToast: function (o) { toast(o && o.title || ''); },
    showModal: function (o) {
      var ok = window.confirm((o.title ? o.title + '\n\n' : '') + (o.content || ''));
      if (o.success) o.success({ confirm: ok, cancel: !ok });
    },

    // 转发：手机上调起系统的分享面板，电脑上复制链接。
    // 返回 Promise<boolean>：true = 分享出去了 / 链接复制好了，false = 玩家取消了
    shareAppMessage: function (o) {
      var url = window.location.href.split('#')[0];
      var text = (o && o.title) || document.title;
      if (navigator.share) {
        return navigator.share({ title: document.title, text: text, url: url }).then(
          function () { return true; },
          function () { return false; }
        );
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text + ' ' + url).then(
          function () { toast('链接已复制，发给朋友吧'); return true; },
          function () { toast('复制失败，请手动复制地址栏里的链接'); return false; }
        );
      }
      toast('请复制地址栏里的链接发给朋友');
      return Promise.resolve(false);
    },
    onShareAppMessage: function (f) { shareHandler = f; },
    showShareMenu: function () {}
  };
})();

(function () {
"use strict";
var defs = {};
defs["app"] = function (module, exports, require) {
/**
 * 游戏的"总控"：存档、选关、触摸、声音、道具、结算。
 *
 * 入口是根目录的 game.js：它很薄，只负责拿到画布、把触摸和前后台事件转给这里。
 *
 * 界面状态放在 this.st 里，由 utils/ui.js 每帧读取并画到画布上。
 */
const { StackGame, LEVELS } = require('./game');
const { GameUI } = require('./ui');
const { Sound } = require('./audio');
const { REWARDS, RewardAd, describe } = require('./rewards');
const { DAILY_ID, buildDaily, buildLevel1, buildLevel2, todayKey } = require('./daily');
const { HELL_ID, HELL_TARGET, buildHell, checkpointOf } = require('./hell');

const SAVE_KEY = 'stack_blocks_save_v1';
// hellAt：地狱模式的存档点（0、100、200 … 900），不按天清零
const DEFAULT_SAVE = { cleared1: false, cleared2: false, best1: 0, best2: 0, deaths2: 0, sound: true, hellAt: 0 };

/** 第二关失败时：告诉玩家离通关多近、这一段该怎么练，而不是只说"你死了" */
function deathMessage(layers, target, best, isNewBest, cfg) {
  const left = target - layers;
  const head = isNewBest && layers > 0
    ? '今日新纪录！叠到 ' + layers + ' 层，离通关还差 ' + left + ' 层。'
    : '叠到 ' + layers + ' 层，今日最高 ' + best + ' 层。';
  // 第二关每天的花样顺序不同，所以按"倒下的那一层正在出什么花样"来给提示
  const feint = cfg.feintFrom >= 0 && layers >= cfg.feintFrom;
  const blink = cfg.blinkFrom >= 0 && layers >= cfg.blinkFrom;
  let tip;
  if (feint && blink) tip = '掉头和隐身一起来了：只盯下面那块的边。';
  else if (blink) tip = '它在忽隐忽现：看不清的时候别点。';
  else if (feint) tip = '它会突然掉头：别提前出手。';
  else tip = '它忽快忽慢：别追着它点，等它滑到正上方。';
  return head + tip;
}

function loadSave() {
  try {
    return Object.assign({}, DEFAULT_SAVE, wx.getStorageSync(SAVE_KEY) || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_SAVE);
  }
}

function writeSave(save) {
  try {
    wx.setStorageSync(SAVE_KEY, save);
  } catch (e) {}
}

/**
 * 每天换新的关卡的当日成绩：{ key 日期, best 今日最高层数, cleared 今日是否通关 }。
 * 存档里只留"某一天"的成绩；日期对不上（过了零点）就当作全新的一天。
 * @param {string} field  存在存档的哪一项里：'daily' 今日挑战，'level2day' 第二关，'level1day' 第一关
 */
function dailyRecord(save, key, field) {
  const d = save[field || 'daily'];
  if (d && d.key === key) return d;
  return { key: key, best: 0, cleared: false };
}

class GameApp {
  /**
   * @param {Object} platform  和运行环境有关的东西都从这里传进来（game.js 里填好了）
   * @param {string}   platform.assetPrefix  代码包根目录的写法，小游戏是 ""（空）
   * @param {boolean}  platform.canvasSheet  "获取道具"弹窗是否画在画布上，小游戏是 true
   * @param {Function} [platform.onSheet]    (sheet|null) 弹窗打开/关闭时的通知，小游戏用不到
   * @param {Function} [platform.share]      (内容) 主动拉起转发
   */
  constructor(platform) {
    this.platform = platform || {};
    this.prefix = this.platform.assetPrefix || '';
    this.canvasSheet = !!this.platform.canvasSheet;

    // 顶部信息放在右上角胶囊按钮下方，避免被遮挡
    this.hudTop = 52;
    try {
      const rect = wx.getMenuButtonBoundingClientRect();
      if (rect && rect.bottom) this.hudTop = rect.bottom + 10;
    } catch (e) {}

    // 全面屏底部横条的高度，道具按钮要让开它
    this.safeBottom = 0;
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      if (info && info.safeArea && info.screenHeight) this.safeBottom = Math.max(0, info.screenHeight - info.safeArea.bottom);
    } catch (e) {}

    this.game = null;
    this.ui = null;
    this.ads = new RewardAd();
    this.used = { life: 0, auto: 0, slow: 0 }; // 这一局每种道具用了几次
    this.sheet = null;      // 当前打开的"获取道具"弹窗
    this.share = null;      // 玩家点了"转发"之后，等他回来再发奖励
    this.shareTimer = null;
    this.adBusy = false;
    this.lockUntil = 0;

    this.st = {
      view: 'start',     // start 开始页 | menu 选关页 | play 游戏中 | result 结算
      unlocked: false,   // 今天的第一关是否已通关（通关后才能进第二关和今日挑战）
      level1Label: '',   // 第一关今日版本的日期
      level: 1,
      levelName: '',
      layers: 0,
      target: 0,
      lives: 0,
      hint: '',
      save: DEFAULT_SAVE,
      foot1: '',
      foot2: '',
      foot3: '',
      foot4: '',         // 地狱模式卡片底下那行字
      level2Label: '',   // 第二关今日版本的日期
      daily: null,       // 今日挑战的信息：{ label 日期, themeName 主题名, desc 一句话说明, ... }
      dark: false,       // 当前这一关是不是深色关卡（第二关、今日挑战）
      soundOn: true,
      items: [],         // 游戏中底部的道具按钮
      autoLeft: 0,
      slowLeft: 0,
      sheet: null,       // 画在画布上的弹窗（只有小游戏用）
      result: null
    };
    const save = loadSave();
    this.refreshMenu(save);
    this.st.view = this.st.unlocked ? 'menu' : 'start'; // 今天还没通关第一关：打开就是开始页

    this.st.soundOn = save.sound !== false;
    this.sound = new Sound(this.prefix);
    this.sound.setEnabled(this.st.soundOn);
    console.log('[声音] 开关：' + (this.st.soundOn ? '开' : '关'));
    this.sound.preload();
    this.sound.playBgm('calm');
  }

  /* ---------- 入口调用的几个方法 ---------- */

  /**
   * 画布准备好之后调用。
   * @param {Object} o  { ctx（已按 dpr 缩放）, width, height（逻辑像素）, raf, caf }
   */
  attachCanvas(o) {
    this.ui = new GameUI({
      ctx: o.ctx,
      width: o.width,
      height: o.height,
      hudTop: this.hudTop,
      safeBottom: this.safeBottom
    });
    this.game = new StackGame({
      ctx: o.ctx,
      width: o.width,
      height: o.height,
      raf: o.raf,
      caf: o.caf,
      onProgress: (p) => this.onProgress(p),
      onEnd: (r) => this.onGameEnd(r),
      onFeedback: (type) => this.onFeedback(type),
      onRender: (time) => this.ui.draw(this.st, time)
    });
    this.game.showIdle(this.level1); // 开始页 / 选关页的背景：今天的第一关，积木自己滑来滑去
  }

  /** 回到前台 */
  show() {
    if (this.sound) this.sound.onShow();
    // 玩家点了"转发"、离开过、现在回来了：离开得够久才算转发了
    if (this.share && this.share.hidden) {
      this.settleShare(Date.now() - this.share.at >= REWARDS.shareMinMs);
    }
    if (this.game) this.game.resume();
  }

  /** 进入后台 */
  hide() {
    if (this.game) this.game.pause();
    if (this.sound) this.sound.onHide();
    if (this.share) this.share.hidden = true;
  }

  destroy() {
    if (this.shareTimer) clearTimeout(this.shareTimer);
    if (this.ads) this.ads.destroy();
    if (this.game) this.game.destroy();
    this.game = null;
    if (this.sound) this.sound.destroy();
    this.sound = null;
  }

  /** 玩家按下屏幕。x、y 是逻辑像素坐标 */
  touch(x, y) {
    if (!this.game || !this.ui) return;
    const st = this.st;
    const hasPoint = typeof x === 'number' && typeof y === 'number';
    this.sound.nudge(); // 背景没放出来的话，借这次触摸再启动一次

    if (this.sheet) {
      // 弹窗开着：画在画布上的弹窗在这里处理按钮；WXML 弹窗有自己的按钮，画布不响应
      if (!this.canvasSheet || !hasPoint || Date.now() < this.lockUntil) return;
      const btn = this.ui.hit(x, y);
      if (btn === 'sheet-share') this.onSheetShare();
      else if (btn === 'sheet-ad') this.onSheetAd();
      else if (btn === 'sheet-cancel') this.onSheetCancel();
      return;
    }

    if (st.view === 'play') {
      // 游戏中：点到静音键或底部的道具按钮就做对应的事，其余任何位置都是放下积木
      const item = hasPoint && Date.now() >= this.lockUntil ? this.ui.hit(x, y) : null;
      if (item === 'sound') this.toggleSound(); // 左上角的静音键
      else if (item === 'item-auto') this.openSheet('auto');
      else if (item === 'item-slow') this.openSheet('slow');
      else this.game.tap();
      return;
    }
    if (Date.now() < this.lockUntil) return; // 结算刚弹出时短暂不响应，防止连点误触
    if (!hasPoint) return;

    const id = this.ui.hit(x, y);
    if (!id) return;

    if (id === 'start' || id === 'level1') {
      this.startLevel(1);
    } else if (id === 'level2' || id === 'level3' || id === 'level4') {
      // 其余模式都要先通关"今天的"第一关。停在选关页过了零点的话，这里会发现又锁上了
      if (!this.unlockedToday(loadSave())) {
        wx.showToast({ title: '先通关今天的第一关', icon: 'none' });
        this.backToMenu();
      } else {
        this.startLevel(id === 'level2' ? 2 : id === 'level3' ? DAILY_ID : HELL_ID);
      }
    } else if (id === 'primary') {
      const action = st.result && st.result.primaryAction;
      if (action === 'next') this.startLevel(2);
      else this.startLevel(st.level);
    } else if (id === 'secondary') {
      const action2 = st.result && st.result.secondaryAction;
      if (action2 === 'daily') this.startLevel(DAILY_ID);
      else this.startLevel(st.level);
    } else if (id === 'menu') {
      this.backToMenu();
    } else if (id === 'revive') {
      this.openSheet('life');
    } else if (id === 'sound') {
      this.toggleSound();
    }
  }

  /** 开 / 关所有声音（主页的「声音」按钮和游戏中左上角的静音键都走这里），选择会被记住 */
  toggleSound() {
    const st = this.st;
    st.soundOn = !st.soundOn;
    const save = loadSave();
    save.sound = st.soundOn;
    writeSave(save);
    st.save = save;
    this.sound.setEnabled(st.soundOn);
    if (st.soundOn) this.sound.play('click'); // 打开时响一声，让玩家确认有声音
  }

  /**
   * 转发卡片的内容。
   * @param {boolean} fromSheet  是不是从"获取道具"弹窗里的"转发给好友"发起的（只有这种转发才换道具）
   */
  shareContent(fromSheet) {
    const st = this.st;
    const save = st.save || DEFAULT_SAVE;
    let title = save.cleared2
      ? '我通关了叠积木的死亡难度，你行吗？'
      : '叠积木：第一关送分，第二关送命';
    if (st.level === DAILY_ID && st.view !== 'menu' && st.daily) {
      // 今日挑战：大家今天玩的是同一关，适合拿来比
      title = '今日挑战「' + st.daily.themeName + '」，我叠到第 ' + st.layers + ' 层，你呢？';
    }
    const inHell = st.level === HELL_ID && st.view !== 'menu';
    if (inHell) title = '是狠人就下 999 层地狱：我下到第 ' + st.layers + ' 层了，你敢来吗？';
    if (fromSheet && this.sheet && REWARDS.shareEnabled) {
      this.armShare();
      if (st.level !== DAILY_ID && !inHell && st.layers > 0) title = '我叠到第 ' + st.layers + ' 层了，你能叠几层？';
    }
    const content = {
      title: title,
      imageUrl: this.prefix + 'images/share.jpg' // 固定的分享图，5:4
    };
    if (REWARDS.shareImageId && REWARDS.shareImageUrl) { // 后台审核通过的转发图：编号和地址要一起传
      content.imageUrlId = REWARDS.shareImageId;
      content.imageUrl = REWARDS.shareImageUrl;
    }
    return content;
  }

  /* ---------- 选关 ---------- */

  /** 今天的第一关是否已经通关（每天零点清零） */
  unlockedToday(save) {
    return !!dailyRecord(save, todayKey(), 'level1day').cleared;
  }

  refreshMenu(save) {
    const st = this.st;
    st.save = save;

    // 第一关：每天一个版本，通关状态和最高层数只算当天
    this.level1 = buildLevel1();
    st.level1Label = this.level1.daily.label;
    const rec1 = dailyRecord(save, this.level1.daily.key, 'level1day');
    st.unlocked = !!rec1.cleared;
    st.foot1 = rec1.cleared ? '今日已通关 ✓' : '今日最高 ' + rec1.best + ' / ' + LEVELS[1].target + ' 层';

    // 今日挑战和第二关：每次回到主页都按当前日期重新算一遍，过了零点自动换成新的一关
    this.daily = buildDaily();
    st.daily = this.daily.daily;
    this.level2 = buildLevel2();
    st.level2Label = this.level2.daily.label;

    // 第二关的通关状态和最高层数只算当天（过零点清零）；阵亡次数是累计的
    const rec2 = dailyRecord(save, this.level2.daily.key, 'level2day');
    st.foot2 = !st.unlocked
      ? '通关今天的第一关后解锁'
      : rec2.cleared
        ? '今日已通关 ✓ 明天换新关'
        : '今日最高 ' + rec2.best + ' / ' + LEVELS[2].target + ' 层 · 累计阵亡 ' + save.deaths2 + ' 次';

    const rec = dailyRecord(save, this.daily.daily.key);
    st.foot3 = !st.unlocked
      ? '通关今天的第一关后解锁'
      : rec.cleared
        ? '今日已通关 ✓ 明天换新关'
        : '今日最高 ' + rec.best + ' / ' + this.daily.target + ' 层';

    // 地狱模式：进度不按天清零，存的是到过的存档点
    const at = checkpointOf(save.hellAt);
    st.foot4 = !st.unlocked
      ? '通关今天的第一关后解锁'
      : at > 0
        ? '已存档到第 ' + at + ' 层，接着往下 · 最深 ' + (save['best' + HELL_ID] || 0) + ' 层'
        : save['cleared' + HELL_ID]
          ? '已通关 ✓ 你是真狠人'
          : (save['best' + HELL_ID] || 0) > 0
            ? '最深到过第 ' + save['best' + HELL_ID] + ' 层 · 每 100 层存档'
            : '共 999 层 · 每 100 层存档';
  }

  /** 开始一关。level：1 第一关，2 第二关，3（DAILY_ID）今日挑战，4（HELL_ID）地狱模式 */
  startLevel(level) {
    const st = this.st;
    let cfg;
    if (level === HELL_ID) {
      cfg = this.hell = buildHell(loadSave().hellAt); // 从上次的存档点接着叠
    } else if (level === DAILY_ID) {
      cfg = this.daily = buildDaily(); // 开局时再按日期算一次：正好跨过零点的话，玩到的就是新的一天
      st.daily = cfg.daily;
    } else if (level === 2) {
      cfg = this.level2 = buildLevel2(); // 第二关也是每天一个版本
      st.level2Label = cfg.daily.label;
    } else {
      cfg = this.level1 = buildLevel1(); // 第一关每天换一套配色
      st.level1Label = cfg.daily.label;
    }
    st.view = 'play';
    st.level = level;
    st.dark = !!cfg.theme.dark;
    st.levelName = cfg.name;
    st.layers = cfg.startLayer || 0;
    st.target = cfg.target;
    st.lives = cfg.lives;
    st.hint = level === 1 ? '积木对齐时，点击屏幕放下'
      : level === DAILY_ID ? cfg.daily.desc
        : level === HELL_ID ? (cfg.startLayer ? '' : '每 100 层存档一次，道具不限次数') // 从存档点接着叠时不再提示，免得和飘字叠在一起
          : '只有一条命。祝你好运。';
    st.hintAt = cfg.startLayer || 0; // 开局提示在放下第一块之后消失
    st.result = null;
    st.autoLeft = 0;
    st.slowLeft = 0;
    this.used = { life: 0, auto: 0, slow: 0 };
    this.refreshItems();
    this.sound.playBgm(st.dark ? 'tense' : 'calm');
    this.sound.cycleNotes = level === HELL_ID; // 999 层：音符升到头再从低音往上爬
    this.sound.prepareNotes((cfg.startLayer || 0) + 1); // 提前备好第一块要用的音符，点下去立刻响
    this.game.start(cfg);
  }

  /** 回主页：今天的第一关通关了就是选关页，否则是开始页 */
  backToMenu() {
    const st = this.st;
    st.level = 1;
    st.dark = false;
    st.result = null;
    this.refreshMenu(loadSave());
    st.view = st.unlocked ? 'menu' : 'start';
    this.lockUntil = Date.now() + 250;
    this.sound.playBgm('calm');
    this.game.showIdle(this.level1);
  }

  /* ---------- 道具：转发 / 看广告 ---------- */

  /** 现在有没有任何一种获取方式可用 */
  rewardsOn() {
    return REWARDS.shareEnabled || this.ads.available();
  }

  /** 这一关里某种道具一局最多能用几次（地狱模式不限次数） */
  itemLimit(type, level) {
    if (!(REWARDS.perRun[type] > 0)) return 0;
    if ((REWARDS.unlimitedLevels || []).indexOf(level) >= 0) return Infinity;
    return REWARDS.perRun[type];
  }

  /** 更新游戏中底部两个道具按钮的文字和状态 */
  refreshItems() {
    const st = this.st;
    const items = [];
    if (this.rewardsOn() && REWARDS.levels.indexOf(st.level) >= 0) {
      const add = (type, name, activeName, left) => {
        const limit = this.itemLimit(type, st.level);
        if (!(limit > 0)) return;
        if (left > 0) items.push({ id: 'item-' + type, label: activeName + ' ×' + left, state: 'active' });
        else if (this.used[type] >= limit) items.push({ id: 'item-' + type, label: name + ' · 已用', state: 'used' });
        else items.push({ id: 'item-' + type, label: name, state: 'ready' });
      };
      add('auto', '自动放好', '自动中', st.autoLeft);
      add('slow', '慢速', '慢速中', st.slowLeft);
    }
    st.items = items;
  }

  setSheet(sheet) {
    this.sheet = sheet;
    this.st.sheet = this.canvasSheet ? sheet : null;
    if (this.platform.onSheet) this.platform.onSheet(sheet);
    this.lockUntil = Date.now() + 300; // 弹窗刚出现 / 刚消失的一瞬间不响应，防止误触
  }

  /** 打开"获取道具"弹窗。type: life | auto | slow */
  openSheet(type) {
    const st = this.st;
    if (this.sheet || !this.rewardsOn()) return;
    if (!(this.used[type] < this.itemLimit(type, st.level))) return;
    if (type !== 'life' && this.game.state !== 'playing') return;

    const d = describe(type, st.layers);
    if (type === 'life' && st.level === HELL_ID) d.desc = '保留已经叠好的 ' + st.layers + ' 层，多一条命接着叠，积木回满宽度。';
    this.game.freeze(); // 游戏停住，等玩家做完选择
    this.setSheet({
      type: type,
      level: st.dark ? 2 : 1, // 弹窗的配色：2 深色，1 浅色
      title: d.title,
      desc: d.desc,
      canShare: REWARDS.shareEnabled,
      canAd: this.ads.available(),
      adLabel: this.ads.isTest() ? '看广告（测试模式）' : '看 15 秒广告'
    });
  }

  closeSheet() {
    this.share = null;
    if (this.shareTimer) clearTimeout(this.shareTimer);
    this.shareTimer = null;
    this.setSheet(null);
  }

  /** 弹窗里点了"不用了" */
  onSheetCancel() {
    if (!this.sheet) return;
    this.closeSheet();
    this.game.respawn(); // 积木重新从边上出来，给玩家反应时间（只在游戏中有效）
    this.game.unfreeze();
  }

  /** 弹窗里点了"转发给好友"：主动拉起转发 */
  onSheetShare() {
    if (!this.sheet || !REWARDS.shareEnabled || !this.platform.share) return;
    const res = this.platform.share(this.shareContent(true));
    if (res && typeof res.then === 'function') {
      // 有的平台（网页版）能直接告诉我们玩家有没有分享出去：以它为准，不用"离开了多久"去估计
      this.share = null;
      if (this.shareTimer) clearTimeout(this.shareTimer);
      this.shareTimer = null;
      res.then((ok) => {
        if (!this.sheet) return;
        if (ok) this.grant();
        else wx.showToast({ title: '转发给好友后才能获得', icon: 'none' });
      });
    }
  }

  /** 弹窗里点了"看广告" */
  onSheetAd() {
    if (!this.sheet || this.adBusy) return;
    this.adBusy = true;
    this.sound.onHide(); // 广告播放时游戏不出声
    this.ads.show((ok) => {
      this.adBusy = false;
      if (this.sound) this.sound.onShow();
      if (!this.sheet) return;
      if (ok) this.grant();
      else wx.showToast({ title: '看完整段广告才能获得', icon: 'none' });
    });
  }

  /**
   * 玩家发起了"转发换道具"。
   * 平台不会告诉我们他最后有没有真的发出去，这里的判断方式是：
   * 进了后台（去选聊天了）并且过了一会儿才回来，就算转发了。
   */
  armShare() {
    this.share = { at: Date.now(), hidden: false };
    if (this.shareTimer) clearTimeout(this.shareTimer);
    // 开发者工具里转发不会进后台：等 1.5 秒还没进后台，就直接发奖励
    this.shareTimer = setTimeout(() => {
      this.shareTimer = null;
      if (this.share && !this.share.hidden) this.settleShare(true);
    }, 1500);
  }

  settleShare(ok) {
    this.share = null;
    if (this.shareTimer) clearTimeout(this.shareTimer);
    this.shareTimer = null;
    if (!this.sheet) return;
    if (ok) this.grant();
    else wx.showToast({ title: '转发给好友后才能获得', icon: 'none' });
  }

  /** 发放弹窗对应的道具，然后回到游戏 */
  grant() {
    const sheet = this.sheet;
    if (!sheet) return;
    const type = sheet.type;
    const st = this.st;
    this.used[type] = (this.used[type] || 0) + 1;
    this.closeSheet();
    this.game.unfreeze();

    if (type === 'life') {
      if (this.game.revive()) {
        if (st.level === 2) { // 这次不算阵亡了，把刚才记的那一次减回去
          const save = loadSave();
          save.deaths2 = Math.max(0, (save.deaths2 || 0) - 1);
          writeSave(save);
          st.save = save;
        }
        st.view = 'play';
        st.result = null;
        this.sound.playBgm(st.dark ? 'tense' : 'calm');
        this.sound.prepareNotes(this.game.layers + 1);
      }
    } else if (type === 'auto') {
      this.game.addAuto(REWARDS.autoBlocks);
      this.game.respawn();
    } else {
      this.game.addSlow(REWARDS.slowBlocks, REWARDS.slowFactor);
      this.game.respawn();
    }
    this.refreshItems();
    this.sound.play('click');
  }

  /* ---------- 引擎回调 ---------- */

  onProgress(p) {
    this.st.layers = p.layers;
    this.st.lives = p.lives;
    this.st.autoLeft = p.autoLeft || 0;
    this.st.slowLeft = p.slowLeft || 0;
    this.refreshItems();
  }

  onFeedback(type) {
    if (type === 'checkpoint') { // 地狱模式到了存档点：记下来，下次从这里接着叠
      const save = loadSave();
      save.hellAt = checkpointOf(this.game.layers);
      writeSave(save);
      this.st.save = save;
      return;
    }
    // 声音
    if (type === 'place' || type === 'perfect') {
      // 每叠上一层响一个音符，层数越高音越高；完美对齐是更亮的版本
      this.sound.playNote(this.game.layers, type === 'perfect');
    } else if (type === 'fail') {
      this.sound.pauseBgm(); // 失败的瞬间背景停下，重来时接着放
      this.sound.play('fail');
    } else {
      this.sound.play(type); // miss / win
    }

    // 震动
    try {
      if (type === 'fail') wx.vibrateLong();
      else if (type === 'perfect' || type === 'win') wx.vibrateShort({ type: 'medium' });
      else wx.vibrateShort({ type: 'light' });
    } catch (e) {}
  }

  onGameEnd(r) {
    const save = loadSave();
    const bestKey = 'best' + r.level;
    const isNewBest = r.layers > (save[bestKey] || 0);
    save[bestKey] = Math.max(save[bestKey] || 0, r.layers);
    if (r.win) save['cleared' + r.level] = true;
    if (!r.win && r.level === 2) save.deaths2 = (save.deaths2 || 0) + 1;

    // 第一关：通关状态只算当天。今天通关了，第二关和今日挑战才解锁
    if (r.level === 1) {
      const key1 = (this.level1 && this.level1.daily.key) || todayKey();
      const rec1 = dailyRecord(save, key1, 'level1day');
      rec1.best = Math.max(rec1.best, r.layers);
      if (r.win) rec1.cleared = true;
      if (key1 === todayKey()) save.level1day = rec1; // 玩到一半跨了零点：这局不算新的一天的
    }

    // 第二关：除了累计的 best2 / cleared2 / deaths2，再记一份"当天"的成绩，主页和结算都用这一份
    let rec2 = null, l2NewBest = false;
    if (r.level === 2) {
      const key2 = (this.level2 && this.level2.daily.key) || todayKey();
      rec2 = dailyRecord(save, key2, 'level2day');
      l2NewBest = r.layers > rec2.best;
      rec2.best = Math.max(rec2.best, r.layers);
      if (r.win) rec2.cleared = true;
      if (key2 === todayKey()) save.level2day = rec2; // 玩到一半跨了零点：这局不记到新的一天里
    }

    // 今日挑战的成绩单独记，只算在"开局那一天"头上
    let rec = null, dailyNewBest = false;
    if (r.level === DAILY_ID) {
      delete save['best' + DAILY_ID];
      delete save['cleared' + DAILY_ID];
      const key = this.daily.daily.key;
      rec = dailyRecord(save, key);
      dailyNewBest = r.layers > rec.best;
      rec.best = Math.max(rec.best, r.layers);
      if (r.win) rec.cleared = true;
      if (key === todayKey()) save.daily = rec; // 玩到一半跨了零点：这局不记到新的一天里
    }
    if (r.level === HELL_ID && r.win) save.hellAt = 0; // 通关了：存档点清零，下次从头再下一遍
    writeSave(save);

    let result;
    if (r.level === HELL_ID && r.win) {
      result = {
        emoji: '😈',
        title: '你是真狠人',
        desc: '999 层地狱，一层没少。这一趟复活了 ' + this.used.life + ' 次。',
        primary: '再下一次',
        primaryAction: 'retry',
        secondary: ''
      };
    } else if (r.level === HELL_ID) {
      const at = checkpointOf(save.hellAt);
      result = {
        emoji: '☠️',
        title: '倒在第 ' + (r.layers + 1) + ' 层',
        desc: '离地狱底还有 ' + (HELL_TARGET - r.layers) + ' 层，最深到过第 ' + save[bestKey] + ' 层。' +
          (at > 0 ? '不复活的话，从第 ' + at + ' 层的存档点重来。' : '不复活的话，从第 1 层重来。'),
        primary: at > 0 ? '从第 ' + at + ' 层重来' : '从头再来',
        primaryAction: 'retry',
        secondary: ''
      };
    } else if (r.level === DAILY_ID && r.win) {
      result = {
        emoji: '🏆',
        title: '今日挑战完成',
        desc: '「' + this.daily.daily.themeName + '」拿下了。明天零点换新关，记得再来。',
        primary: '再玩一遍',
        primaryAction: 'retry',
        secondary: ''
      };
    } else if (r.level === DAILY_ID) {
      const near = r.target - r.layers <= 3;
      result = {
        emoji: near ? '😤' : '☠️',
        title: near ? '就差 ' + (r.target - r.layers) + ' 层！' : '倒在第 ' + (r.layers + 1) + ' 层',
        desc: (dailyNewBest && r.layers > 0 ? '今日新纪录：' + r.layers + ' 层。' : '今日最高 ' + rec.best + ' 层。') + this.daily.daily.tip,
        primary: '再来一次',
        primaryAction: 'retry',
        secondary: ''
      };
    } else if (r.level === 1 && r.win) {
      result = {
        emoji: '🎉',
        title: '第一关通关',
        desc: '热身结束。接下来这关，不是给人玩的。',
        primary: '挑战死亡难度',
        primaryAction: 'next',
        secondary: '今日挑战',
        secondaryAction: 'daily'
      };
    } else if (r.level === 1) {
      result = {
        emoji: '😅',
        title: '塔倒了',
        desc: '没关系，这关很简单，等积木对齐再点就行。',
        primary: '再试一次',
        primaryAction: 'retry',
        secondary: ''
      };
    } else if (r.win) {
      result = {
        emoji: '👑',
        title: '你通关了死亡难度',
        desc: '累计阵亡 ' + save.deaths2 + ' 次后登顶，可以截图炫耀了。明天零点换新版本。',
        primary: '再来一遍',
        primaryAction: 'retry',
        secondary: ''
      };
    } else {
      result = {
        emoji: r.target - r.layers <= 3 ? '😤' : '☠️',
        title: r.target - r.layers <= 3 ? '就差 ' + (r.target - r.layers) + ' 层！' : '第 ' + save.deaths2 + ' 次阵亡',
        desc: deathMessage(r.layers, r.target, rec2.best, l2NewBest, this.level2 || LEVELS[2]),
        primary: '不服，再来',
        primaryAction: 'retry',
        secondary: ''
      };
    }
    // 失败了、这一局"加一条命"还没用完（地狱模式不限次数）、至少叠了一层：给一个接着叠的机会
    if (!r.win && r.layers >= 1 && this.rewardsOn() && REWARDS.levels.indexOf(r.level) >= 0 &&
        this.used.life < this.itemLimit('life', r.level)) {
      result.revive = '加一条命，接着叠';
    }
    result.layers = r.layers;
    result.target = r.target;
    result.perfects = r.perfects;
    result.maxCombo = r.maxCombo;

    const st = this.st;
    st.save = save;
    st.result = result;
    st.view = 'result';
    this.lockUntil = Date.now() + 400;
  }
}

module.exports = { GameApp: GameApp };

};
defs["audio"] = function (module, exports, require) {
/**
 * 声音：叠积木的音符、其他音效、背景律动。
 *
 * 思路：每叠上一层就响一个音符，层数越高音越高（n01~n15）；
 * 完美对齐时换成带一串上扬亮音的版本（p01~p15）。
 * 背景只有鼓点和贝斯，旋律由玩家叠出来的音符"演奏"。
 *
 * 所有声音文件都在 /audio 目录里，是用代码合成的原创音频（不涉及版权素材）。
 * 想换成自己的声音，用同名文件覆盖即可，代码不用改。
 */

const NOTE_COUNT = 15; // 音符文件的数量：n01~n15 / p01~p15

const SFX = {
  click: 'click.wav', // 按钮
  miss: 'miss.wav',   // 没叠上，丢一条命
  fail: 'fail.wav',   // 失败
  win: 'win.wav'      // 过关
};

const BGM = {
  calm: 'bgm-calm.mp3',  // 主页 + 第一关：轻松的律动
  tense: 'bgm-tense.mp3' // 第二关：紧张的律动
};

const SFX_VOLUME = 1.0;
const BGM_VOLUME = 0.35; // 背景压低一些，让叠积木的音符当主角

// iPhone 侧面的静音键打开时是否也不出声。
// false = 不管静音键，游戏照常有声音（玩家用主页的「声音」按钮开关）；true = 跟随静音键。
const OBEY_MUTE_SWITCH = false;

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

class Sound {
  /** @param {string} prefix 代码包根目录的写法，小游戏是 ""（空） */
  constructor(prefix) {
    this.base = (prefix || '') + 'audio/'; // 声音文件所在目录
    this.enabled = true; // 玩家的开关
    this.active = true;  // 游戏是否在前台
    this.sfx = {};       // 固定音效的播放器
    this.busy = {};      // 某个固定音效是否正在响
    this.notes = {};     // 音符播放器：只保留"刚响过的"和"下一层要用的"，不会越积越多
    this.cycleNotes = false; // 音符升到最高之后是否从头再来（层数很多的地狱模式用）
    this.bgm = {};       // 背景播放器
    this.bgmName = '';   // 当前应该播放哪段背景
    this.bgmWanted = false;  // 游戏此刻是否想要背景（失败暂停时为 false）
    this.bgmOn = {};         // 每一段此刻是否真的在响
    this.sweep = 0;          // 还要在几次触摸里顺手清理其他段
    try {
      // mixWithOther：不打断玩家正在听的其他音乐
      if (wx.setInnerAudioOption) wx.setInnerAudioOption({ obeyMuteSwitch: OBEY_MUTE_SWITCH, mixWithOther: true });
    } catch (e) {}
  }

  _create(src, volume) {
    const a = wx.createInnerAudioContext();
    a.src = src;
    a.volume = volume;
    // 播放出错时在 Console 里留一行，方便排查"没声音"
    a.onError((res) => {
      console.warn('[声音] 播放失败', src, res && res.errCode, res && res.errMsg);
    });
    return a;
  }

  _sfx(name) {
    if (this.sfx[name]) return this.sfx[name];
    const a = this._create(this.base + SFX[name], SFX_VOLUME);
    a.onPlay(() => { this.busy[name] = true; });
    a.onEnded(() => { this.busy[name] = false; });
    a.onStop(() => { this.busy[name] = false; });
    this.sfx[name] = a;
    return a;
  }

  _note(key) {
    if (!this.notes[key]) this.notes[key] = this._create(this.base + key + '.wav', SFX_VOLUME);
    return this.notes[key];
  }

  /** 提前创建固定音效的播放器，第一次用到时不会有加载延迟 */
  preload() {
    try {
      for (const name in SFX) this._sfx(name);
    } catch (e) {}
  }

  /**
   * 提前准备好某一层要用的两个音符（普通 + 完美），并清掉用不到的旧播放器。
   * 开局时调用 prepareNotes(1)；之后每叠一层会自动准备下一层。
   */
  prepareNotes(layer) {
    const idx = this._noteIdx(layer);
    try {
      const keep = {};
      [layer - 2, layer - 1, layer].forEach((l) => { // 前两层的音可能还没响完，先留着
        if (l >= 1) {
          const i = this._noteIdx(l);
          keep['n' + pad2(i)] = true;
          keep['p' + pad2(i)] = true;
        }
      });
      for (const key in this.notes) {
        if (!keep[key]) {
          this.notes[key].destroy();
          delete this.notes[key];
        }
      }
      this._note('n' + pad2(idx));
      this._note('p' + pad2(idx));
    } catch (e) {}
  }

  /** 叠上第 layer 层时响的音符；perfect = 是否完美对齐 */
  playNote(layer, perfect) {
    const idx = this._noteIdx(layer);
    if (this.enabled && this.active) {
      try {
        this._note((perfect ? 'p' : 'n') + pad2(idx)).play();
      } catch (e) {}
    }
    this.prepareNotes(Math.max(1, layer) + 1);
  }

  /**
   * 第 layer 层用第几个音符。音符一共 NOTE_COUNT 个：
   * 普通关卡叠到最高音就一直用最高音；层数很多的关卡（地狱模式，cycleNotes = true）升到头再从最低音重新往上爬。
   */
  _noteIdx(layer) {
    const l = Math.max(1, Math.floor(layer || 1));
    return this.cycleNotes ? ((l - 1) % NOTE_COUNT) + 1 : Math.min(NOTE_COUNT, l);
  }

  /** 播放一个固定音效 */
  play(name) {
    if (!this.enabled || !this.active || !SFX[name]) return;
    try {
      const a = this._sfx(name);
      if (this.busy[name]) a.seek(0); // 还没响完又触发：从头再响
      a.play();
    } catch (e) {}
  }

  /* ---------------- 背景音乐 ----------------
   *
   * 规则只有一条：任何时候最多只有"当前这一段"在响。进第二关时自动从轻松那段换成紧张那段。
   *
   * 为了保证不会两段叠在一起，换段时对旧的那段做三件事：音量归零、停止、销毁播放器
   * （下次用到再重新创建）。三件事里只要有一件生效，旧的那段就听不到了。
   * 另外每个播放器真正出声的那一刻（onPlay）还会再核对一次自己该不该响 ——
   * 播放器接到"播放"后要过一小会儿才出声，这期间发出的"停止"有可能不生效。
   */

  /** 这一段此刻是否应该在响 */
  _shouldPlay(name) {
    return this.enabled && this.active && this.bgmWanted && this.bgmName === name;
  }

  /** 让一个播放器彻底安静：音量归零 + 停止（+ 销毁） */
  _silence(a, destroy) {
    try { a.volume = 0; } catch (e) {}
    try { a.stop(); } catch (e) {}
    if (destroy) {
      try { a.destroy(); } catch (e) {}
    }
  }

  _bgm(name) {
    if (this.bgm[name]) return this.bgm[name];
    const a = this._create(this.base + BGM[name], BGM_VOLUME);
    a.loop = true;
    a.onPlay(() => {
      if (this.bgm[name] !== a) { this._silence(a, true); return; } // 这个播放器已经被换掉了，却还是响了起来
      this.bgmOn[name] = true;
      if (!this._shouldPlay(name)) { // 这一段现在不该响（失败暂停、静音、在后台）
        a.volume = 0;
        a.pause();
      }
    });
    a.onPause(() => { if (this.bgm[name] === a) this.bgmOn[name] = false; });
    a.onStop(() => { if (this.bgm[name] === a) this.bgmOn[name] = false; });
    this.bgm[name] = a;
    return a;
  }

  /** 把"当前这一段"以外的播放器全部关掉并销毁 */
  _stopOthers() {
    for (const k in this.bgm) {
      if (k === this.bgmName) continue;
      const a = this.bgm[k];
      delete this.bgm[k];
      this.bgmOn[k] = false;
      this._silence(a, true);
    }
  }

  /** 按当前状态对齐：其他段关掉；当前这一段该响就恢复音量并播放，不该响就音量归零并暂停 */
  _syncBgm(forcePlay) {
    try {
      this._stopOthers();
      const name = this.bgmName;
      if (!name) return;
      if (this._shouldPlay(name)) {
        const a = this._bgm(name);
        a.volume = BGM_VOLUME;
        if (forcePlay || !this.bgmOn[name]) a.play();
      } else if (this.bgm[name]) {
        this.bgm[name].volume = 0;
        this.bgm[name].pause();
      }
    } catch (e) {}
  }

  /** 切换/继续背景。同一段不会从头重播。 */
  playBgm(name) {
    if (!BGM[name]) return;
    this.bgmName = name;
    this.bgmWanted = true;
    this.sweep = 8; // 接下来几次触摸都再清一遍其他段，作为兜底
    this._syncBgm(true);
  }

  /**
   * 玩家每次触摸屏幕时调用：
   * - 如果背景本该在响却没响，再启动一次（有些环境不允许在玩家操作之前自动播放声音）
   * - 刚切换过背景的话，顺手再把其他段停一遍
   */
  nudge() {
    try {
      if (this.sweep > 0) {
        this.sweep--;
        this._stopOthers();
      }
      const name = this.bgmName;
      if (name && this._shouldPlay(name) && !this.bgmOn[name]) {
        const a = this._bgm(name);
        a.volume = BGM_VOLUME;
        a.play();
      }
    } catch (e) {}
  }

  /** 暂停背景（比如失败的瞬间），之后 playBgm 会接着放 */
  pauseBgm() {
    this.bgmWanted = false;
    this._syncBgm(false);
  }

  /** 玩家开关声音 */
  setEnabled(on) {
    this.enabled = !!on;
    this._syncBgm(true);
  }

  /** 切到后台 / 回到前台 */
  onHide() {
    this.active = false;
    this._syncBgm(false);
  }

  onShow() {
    this.active = true;
    this._syncBgm(true);
  }

  destroy() {
    try {
      for (const k in this.sfx) this.sfx[k].destroy();
      for (const k in this.notes) this.notes[k].destroy();
      for (const k in this.bgm) this.bgm[k].destroy();
    } catch (e) {}
    this.sfx = {};
    this.notes = {};
    this.bgm = {};
  }
}

module.exports = { Sound: Sound };

};
defs["daily"] = function (module, exports, require) {
/**
 * 每天换新的关卡：今日挑战（buildDaily）、第二关的今日版本（buildLevel2）、第一关的今日版本（buildLevel1）。
 * 同一天所有人玩到的是同一关。
 *
 * 做法：把"今天的日期"（按北京时间）当作随机种子。
 *   - 同一个日期永远算出同一关，所以不需要服务器，大家玩到的也都一样；
 *   - 过了零点日期变了，关卡自动换新。
 * 关卡里每一块积木的方向、快慢、掉头时机也由这个种子决定（见 game.js 的 _spawn），
 * 所以今天的第 7 块，对每个人、每一次重来都是同一块。
 *
 * 每天变的东西：当天的主题（下面 THEMES 里轮着来）、花样从第几层开始、整体速度的小浮动、配色。
 * 不变的东西：以第二关为底子（15 层、一条命；积木宽度单独定，见 DAILY_WIDTH），难度大致在同一档。
 */
const { LEVELS, hsl, seededRandom } = require('./game');

const DAILY_ID = 3; // 今日挑战在游戏里的关卡编号（第一关 1，第二关 2）

// 今日挑战的积木宽度（占屏幕宽度的比例）。单独定在这里，不跟着第二关的宽度走；
// 个别主题在自己的 set 里另外指定了宽度（急速日、细针日、混乱日）。
const DAILY_WIDTH = 0.42;

// 今日挑战固定用哪个主题（填下面 THEMES 里某一项的 key）。现在固定是「混乱日」：
// 主题不变，但每天的积木剧本、速度、花样出现的层数和配色照样换新。
// 改成 ''（空）就恢复成 7 个主题轮流出现、一周各一次。
const FIXED_THEME = 'chaos';

/**
 * 每日主题。每个主题在第二关的基础上改几项参数（参数含义见 game.js 顶部 LEVELS 的注释）。
 * FIXED_THEME 为空时：一周 7 天每个主题各出现一次，每周的顺序不同。想加主题就照着加一项，想改难度就改里面的数字。
 *   name 主题名   desc 主页卡片和开局提示里的一句话   tip 失败后给玩家的提示
 */
const THEMES = [
  {
    key: 'gale', name: '狂风日',
    desc: '变速特别猛，别追着它点。',
    tip: '它一会儿快一会儿慢：等它慢下来、滑到正上方再点。',
    set: { wobble: 0.65, wobbleFreq: 9, feintFrom: 9, blinkFrom: 12 }
  },
  {
    key: 'ghost', name: '幽灵日',
    desc: '隐身来得早，记住它的节奏。',
    tip: '看不清的时候别点：它还在按原来的速度走，等它亮起来。',
    set: { blinkFrom: 1, blinkMin: 0.05, wobble: 0.3, feintFrom: 10 }
  },
  {
    key: 'rush', name: '急速日',
    desc: '整体更快，但积木更宽。',
    tip: '速度快但不耍花样：提前半拍出手。',
    set: { speed: 500, maxSpeed: 940, baseWidthRatio: 0.46, wobble: 0.25, feintFrom: -1, blinkFrom: 11 }
  },
  {
    key: 'trick', name: '骗子日',
    desc: '从头到尾都在假动作。',
    tip: '它随时会掉头：别预判，对齐的那一瞬间再点。',
    set: { feintFrom: 1, wobble: 0.3, blinkFrom: 13 }
  },
  {
    key: 'needle', name: '细针日',
    desc: '积木更窄更慢，靠完美变宽撑住。',
    tip: '今天积木特别窄，放得完美才会变宽：前几块宁可多等一趟。',
    set: { baseWidthRatio: 0.33, speed: 330, speedGrow: 0.04, perfectTol: 3, wobble: 0.3, feintFrom: 9, blinkFrom: 12 }
  },
  {
    key: 'clock', name: '限时日',
    desc: '每块只有 2 秒，到点就落。',
    tip: '时间条走完它会自己落下：第一趟滑过来就要出手。',
    set: { timeLimit: 2, wobble: 0.35, feintFrom: -1, blinkFrom: 10 }
  },
  {
    key: 'chaos', name: '混乱日',
    desc: '三种花样很早就一起上。',
    tip: '变速、掉头、隐身一起来：只盯下面那块的边。',
    set: { baseWidthRatio: 0.52, wobble: 0.4, feintFrom: 3, blinkFrom: 6 }
  }
];

/** 今天的日期编号，按北京时间算，如 20261117。全世界的玩家在同一时刻换关 */
function todayKey(now) {
  const d = new Date((now == null ? Date.now() : now) + 8 * 3600 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** 日期编号 -> 从 1970-01-01 起的第几天 */
function dayNumber(key) {
  const y = Math.floor(key / 10000), m = Math.floor(key / 100) % 100, d = key % 100;
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** 这一周 7 个主题的出场顺序（每周洗一次牌） */
function weekOrder(week) {
  const rnd = seededRandom(week * 2654435761);
  const order = THEMES.map(function (_, i) { return i; });
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return order;
}

/** 这一天是哪个主题。保证相邻两天不重复 */
function themeIndex(key) {
  if (FIXED_THEME) {
    for (let i = 0; i < THEMES.length; i++) if (THEMES[i].key === FIXED_THEME) return i;
  }
  const day = dayNumber(key);
  const week = Math.floor(day / 7), pos = ((day % 7) + 7) % 7;
  const order = weekOrder(week);
  if (order.length > 1) {
    const prev = weekOrder(week - 1);
    if (order[0] === prev[prev.length - 1]) { // 上周最后一天和这周第一天撞了：这周前两天对调
      const t = order[0]; order[0] = order[1]; order[1] = t;
    }
  }
  return order[pos % order.length];
}

function rgba(rgb, alpha) {
  return rgb.replace('rgb(', 'rgba(').replace(')', ',' + alpha + ')');
}

/**
 * 生成某一天的关卡配置（格式和 game.js 里 LEVELS 的每一项相同，可以直接交给引擎）。
 * @param {number} [key] 日期编号，不传就是今天
 */
function buildDaily(key) {
  if (key == null) key = todayKey();
  const theme = THEMES[themeIndex(key)];
  const rnd = seededRandom(key);
  const base = LEVELS[2];

  const cfg = {};
  for (const k in base) cfg[k] = base[k];
  cfg.baseWidthRatio = DAILY_WIDTH;
  for (const k in theme.set) cfg[k] = theme.set[k];

  // 当天的小变化：整体速度浮动 ±4%，各种花样的起始层数前后挪一层
  const speedMul = 0.96 + rnd() * 0.08;
  cfg.speed = Math.round(cfg.speed * speedMul);
  cfg.maxSpeed = Math.round(cfg.maxSpeed * speedMul);
  const shift = function (from) {
    const s = Math.floor(rnd() * 3) - 1; // -1 / 0 / +1，每个花样都抽一次，保证后面的随机数位置固定
    return from >= 2 ? from + s : from;
  };
  cfg.wobbleFrom = shift(cfg.wobbleFrom);
  cfg.feintFrom = shift(cfg.feintFrom);
  cfg.blinkFrom = shift(cfg.blinkFrom);

  // 花样开始的那一层飘字提示
  const announce = {};
  const note = function (from, text) {
    if (from > 0 && from < cfg.target) announce[from] = announce[from] ? announce[from] + ' + ' + text : text;
  };
  if (cfg.wobble > 0) note(cfg.wobbleFrom, '开始变速');
  note(cfg.feintFrom, '开始假动作');
  note(cfg.blinkFrom, '开始隐身');
  cfg.announce = announce;

  // 当天的配色：背景一个色相，积木用和它拉开距离的色相
  const hue = Math.floor(rnd() * 360);
  const blockHue = hue + 140 + rnd() * 80;
  const step = (rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 5);
  cfg.theme = {
    dark: true,
    bgTop: hsl(hue, 0.55, 0.05),
    bgBottom: hsl(hue, 0.6, 0.2),
    ground: 'rgba(0,0,0,0.5)',
    hue0: blockHue, hueStep: step, sat: 0.85, light: 0.56,
    ambient: rgba(hsl(blockHue, 0.9, 0.62), 0.5), ambientSize: 2.2, ambientSpeed: 46,
    popup: '#ffd166', popupShadow: 'rgba(0,0,0,0.6)'
  };

  const month = Math.floor(key / 100) % 100, date = key % 100;
  cfg.id = DAILY_ID;
  cfg.seed = key; // 交给引擎：每一块积木的随机量都从这个种子来
  cfg.name = '今日挑战 · ' + theme.name;
  cfg.daily = {
    key: key,
    label: month + '月' + date + '日',
    themeKey: theme.key,
    themeName: theme.name,
    desc: theme.desc,
    tip: theme.tip
  };
  return cfg;
}

/**
 * 第二关的"今日版本"：难度参数还是 game.js 里 LEVELS[2] 那一套，但每天有这些不同——
 *   - 每一块积木的方向、快慢、掉头时机（同一天所有人一样）
 *   - 假动作和隐身谁先出现、各从第几层开始
 *   - 整体速度 ±4%
 *   - 配色（始终是偏红的暖色，一眼还是"死亡难度"）
 * @param {number} [key] 日期编号，不传就是今天
 */
function buildLevel2(key) {
  if (key == null) key = todayKey();
  const base = LEVELS[2];
  const rnd = seededRandom(key * 31 + 2); // 和今日挑战用不同的种子，两关互不相同

  const cfg = {};
  for (const k in base) cfg[k] = base[k];

  const speedMul = 0.96 + rnd() * 0.08;
  cfg.speed = Math.round(base.speed * speedMul);
  cfg.maxSpeed = Math.round(base.maxSpeed * speedMul);

  // 假动作、隐身：先后顺序每天抽一次，起始层数前后挪一层
  const first = base.feintFrom + Math.floor(rnd() * 3) - 1;
  const second = base.blinkFrom + Math.floor(rnd() * 3) - 1;
  const feintFirst = rnd() < 0.5;
  cfg.feintFrom = feintFirst ? first : second;
  cfg.blinkFrom = feintFirst ? second : first;

  const announce = {};
  announce[cfg.feintFrom] = '开始假动作';
  announce[cfg.blinkFrom] = announce[cfg.blinkFrom] ? announce[cfg.blinkFrom] + ' + 开始隐身' : '开始隐身';
  cfg.announce = announce;

  const hue = 330 + rnd() * 60; // 洋红 → 红 → 橙红
  const theme = {};
  for (const k in base.theme) theme[k] = base.theme[k];
  theme.bgTop = hsl(hue, 0.6, 0.04);
  theme.bgBottom = hsl(hue, 0.72, 0.17);
  theme.hue0 = hue - 15 + rnd() * 30;
  theme.hueStep = (rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 3);
  cfg.theme = theme;

  const month = Math.floor(key / 100) % 100, date = key % 100;
  cfg.seed = key * 31 + 2;
  cfg.daily = { key: key, label: month + '月' + date + '日' };
  return cfg;
}

/**
 * 第一关的"今日版本"：玩法和难度完全不变（它是热身关），每天换一套配色。
 * 色相限制在蓝 → 紫 → 粉这一段，保证上面的白字始终看得清。
 * @param {number} [key] 日期编号，不传就是今天
 */
function buildLevel1(key) {
  if (key == null) key = todayKey();
  const base = LEVELS[1];
  const rnd = seededRandom(key * 31 + 1);
  const cfg = {};
  for (const k in base) cfg[k] = base[k];

  const hue = 195 + rnd() * 95;
  const theme = {};
  for (const k in base.theme) theme[k] = base.theme[k];
  theme.bgTop = hsl(hue, 0.9, 0.76);
  theme.bgBottom = hsl(hue + 50, 0.88, 0.87);
  theme.hue0 = hue - 10 + rnd() * 20;
  theme.hueStep = (rnd() < 0.5 ? -1 : 1) * (9 + rnd() * 6);
  cfg.theme = theme;

  const month = Math.floor(key / 100) % 100, date = key % 100;
  cfg.daily = { key: key, label: month + '月' + date + '日' };
  return cfg;
}

module.exports = {
  DAILY_ID: DAILY_ID,
  THEMES: THEMES,
  FIXED_THEME: FIXED_THEME,
  todayKey: todayKey,
  buildDaily: buildDaily,
  buildLevel1: buildLevel1,
  buildLevel2: buildLevel2
};

};
defs["game"] = function (module, exports, require) {
/**
 * 叠积木 —— 游戏引擎
 *
 * 与页面解耦：只需要一个 2D 画布上下文和 requestAnimationFrame。
 * 玩法：积木在塔顶左右滑动，点击屏幕放下；没对齐的部分会被切掉，
 * 积木越叠越窄，叠到目标层数过关，完全没叠上就丢一条命。
 */

// 所有速度（px/秒）和像素数值都以 375 宽的屏幕为基准，运行时按屏幕宽度等比缩放。
// 想调难度，只改这里就够了。
const LEVELS = {
  1: {
    id: 1,
    name: '第一关 · 新手村',
    target: 10,            // 叠到多少层过关
    lives: 3,              // 完全没叠上时可以失误几次
    baseWidthRatio: 0.62,  // 底座宽度占屏幕宽度的比例
    speed: 115,            // 初始滑动速度
    speedGrow: 0.025,      // 每叠一层速度增长比例
    maxSpeed: 160,         // 速度上限
    perfectTol: 12,        // 偏差在这个范围内算"完美"，自动吸附对齐
    regrow: 10,            // 完美时积木变宽多少（回血）。变宽时有一段"向两边长出来"的动画和飘字
    minOverlap: 1,         // 重叠小于这个宽度算没叠上
    jitter: 0,             // 每块积木速度的随机浮动比例
    randomSide: false,     // 是否随机从左/右出现
    wobble: 0,             // 滑动中途变速的幅度（0 = 匀速）
    wobbleFreq: 0,         // 变速的快慢
    wobbleFrom: -1,        // 从第几层开始变速，-1 = 不出现
    feintFrom: -1,         // 从第几层开始出现"假动作"（中途突然掉头），-1 = 不出现
    blinkFrom: -1,         // 从第几层开始积木忽隐忽现，-1 = 不出现
    blinkMin: 1,           // 忽隐忽现时最淡的不透明度（越小越难看清）
    announce: {},          // 叠到第几层时飘字提示新阶段，如 { 5: '开始变速' }
    timeLimit: 0,          // 每块积木的限时（秒），超时自动落下，0 = 不限时
    shake: 0,              // 落下时屏幕震动强度
    theme: {
      bgTop: '#8EC5FC',
      bgBottom: '#E0C3FC',
      ground: 'rgba(255,255,255,0.55)',
      hue0: 205, hueStep: 13, sat: 0.72, light: 0.62,
      ambient: 'rgba(255,255,255,0.35)', ambientSize: 9, ambientSpeed: 14,
      popup: '#ffffff', popupShadow: 'rgba(60,40,170,0.75)'
    }
  },
  2: {
    id: 2,
    name: '第二关 · 死亡难度',
    // 最开始的那一版难度（只把积木稍微加宽了）：一条命、又窄又快、全程变速，第 5 层起假动作，第 9 层起隐身。
    target: 15,
    lives: 1,
    baseWidthRatio: 0.48,  // 最开始是 0.36，后来两次加宽：0.42 → 0.48
    speed: 360,
    speedGrow: 0.05,
    maxSpeed: 720,
    perfectTol: 2,
    regrow: 6,             // 第二关也有完美回血，但完美的判定窄得多（2 像素），很难触发
    minOverlap: 4,
    jitter: 0.22,
    randomSide: true,
    wobble: 0.5,
    wobbleFreq: 7,
    wobbleFrom: 0,         // 从第 1 层起就忽快忽慢
    feintFrom: 4,          // 第 5 层起：滑到一半突然掉头
    blinkFrom: 8,          // 第 9 层起：忽隐忽现
    blinkMin: 0.1,
    announce: {},
    timeLimit: 4,
    shake: 7,
    theme: {
      bgTop: '#090206',
      bgBottom: '#4d0c15',
      ground: 'rgba(0,0,0,0.55)',
      dark: true, // 深色关卡：界面用深色卡片，背景音乐用紧张那段
      hue0: 350, hueStep: 5, sat: 0.88, light: 0.52,
      ambient: 'rgba(255,140,60,0.55)', ambientSize: 2.2, ambientSpeed: 46,
      popup: '#ffd166', popupShadow: 'rgba(0,0,0,0.6)'
    }
  }
};

// 完美变宽动画：落稳后停一下再长出来，时长单位秒
const GROW_DELAY = 0.08;
const GROW_TIME = 0.34;

/** 过冲再回弹的缓动：0 → 约 1.1 → 1 */
function backOut(k) {
  const c = 1.70158;
  const t = k - 1;
  return 1 + (c + 1) * t * t * t + c * t * t;
}

function noop() {}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function rand(a, b) { return a + Math.random() * (b - a); }

/**
 * 带种子的随机数生成器：同一个种子永远产生同一串数。
 * 今日挑战靠它保证"同一天所有人遇到的每一块积木都一样"。
 */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 自己做 HSL -> RGB，避免个别机型画布不认 hsl() 写法
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = function (t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(f(h + 1 / 3) * 255);
  const g = Math.round(f(h) * 255);
  const b = Math.round(f(h - 1 / 3) * 255);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

class StackGame {
  /**
   * @param {Object} opts
   * @param {CanvasRenderingContext2D} opts.ctx  已按 dpr 缩放好的 2D 上下文
   * @param {number} opts.width   画布逻辑宽度（css px）
   * @param {number} opts.height  画布逻辑高度（css px）
   * @param {Function} opts.raf   requestAnimationFrame
   * @param {Function} opts.caf   cancelAnimationFrame
   * @param {Function} opts.onProgress  ({layers,target,lives,combo,autoLeft,slowLeft}) 层数/生命/道具变化时回调
   * @param {Function} opts.onEnd       ({win,level,layers,target,perfects,maxCombo}) 一局结束时回调
   * @param {Function} opts.onFeedback  ('place'|'perfect'|'miss'|'fail'|'win') 用于震动等反馈
   * @param {Function} opts.onRender    (time) 每帧画完游戏画面后回调，用来在上面画界面
   */
  constructor(opts) {
    this.ctx = opts.ctx;
    this.W = opts.width;
    this.H = opts.height;
    this.raf = opts.raf;
    this.caf = opts.caf || noop;
    this.onProgress = opts.onProgress || noop;
    this.onEnd = opts.onEnd || noop;
    this.onFeedback = opts.onFeedback || noop;
    this.onRender = opts.onRender || noop;

    this.scale = this.W / 375;
    this.bh = clamp(Math.round(this.H * 0.05), 28, 42);             // 每层积木高度
    this.groundY = this.H - Math.max(96, Math.round(this.H * 0.17)); // 地面位置

    this.state = 'idle'; // idle(主页演示) | playing | ending(结算动画) | over
    this._running = false;
    this._reset(1);
  }

  /* ---------------- 对外接口 ---------------- */

  /** 开始某一关。level 可以是关卡编号（1、2），也可以直接传一份关卡配置（今日挑战每天生成一份） */
  start(level) {
    this._reset(level);
    this.state = 'playing';
    this._spawn();
    this._emitProgress();
    this.resume();
  }

  /** 主页背景：积木自己滑来滑去，不响应点击 */
  showIdle(levelId) {
    this._reset(levelId || 1);
    this.state = 'idle';
    this._spawn();
    this.resume();
  }

  /** 玩家点击屏幕 */
  tap() {
    if (this.state !== 'playing' || !this.block) return;
    if (this.block.auto) return; // 这块由"自动放好"负责，点了也不算
    this._drop();
  }

  /* ---------------- 道具 ---------------- */

  /** 自动放好：接下来 n 块积木自己对齐落下 */
  addAuto(n) {
    this.autoLeft += n;
    if (this.block) this.block.auto = true;
    this._popup('自动放好 ×' + this.autoLeft, this.W / 2, this._layerY(this.stack.length) - 64, 1.4);
    this._emitProgress();
  }

  /** 慢速：接下来 n 块积木按 factor 倍的速度滑动（0.5 = 一半速度），限时也相应变长 */
  addSlow(n, factor) {
    this.slowLeft += n;
    this.slowFactor = factor > 0 ? factor : 0.5;
    if (this.block) this.block.slow = true;
    this._popup('慢速 ×' + this.slowLeft, this.W / 2, this._layerY(this.stack.length) - 64, 1.4);
    this._emitProgress();
  }

  /** 加一条命：失败之后调用，保留已经叠好的层数接着叠。成功返回 true */
  revive() {
    if (this.state !== 'over' && this.state !== 'ending') return false;
    if (!this._result || this._result.win) return false;
    this.state = 'playing';
    this.lives = 1;
    this.combo = 0;
    this.redFlash = 0;
    this.shake = 0;
    this._result = null;
    let refilled = false;
    if (this.cfg.reviveRefill) { // 地狱模式：复活时塔顶那块长回满宽度
      const top = this.stack[this.stack.length - 1];
      if (this.baseW - top.w > 0.5) {
        const mid = top.x + top.w / 2;
        top.grow = { x: top.x, w: top.w, t: this.time };
        top.w = this.baseW;
        top.x = clamp(mid - top.w / 2, 0, this.W - top.w);
        top.flash = 1;
        refilled = true;
      }
    }
    this._spawn();
    this._popup(refilled ? '多一条命，积木回满！' : '多一条命，接着叠！', this.W / 2, this._layerY(this.stack.length) - 64, 1.4);
    this._emitProgress();
    return true;
  }

  /** 冻结 / 解冻：冻结时游戏逻辑停住，但画面照常绘制（弹窗开着的时候用） */
  freeze() { this.frozen = true; }
  unfreeze() { this.frozen = false; }

  /** 把当前这块积木重新从边上放出来（从弹窗回到游戏时用，给玩家留出反应时间） */
  respawn() {
    if (this.state === 'playing') this._spawn();
  }

  pause() {
    this._running = false;
    if (this._rafId != null) this.caf(this._rafId);
    this._rafId = null;
  }

  resume() {
    if (this._running) return;
    this._running = true;
    this._last = 0;
    const tick = () => {
      if (!this._running) return;
      const now = Date.now();
      // 限制单帧步长：切后台回来或掉帧时积木不会"瞬移"
      const dt = this._last ? Math.min(0.034, (now - this._last) / 1000) : 0.016;
      this._last = now;
      this.update(dt);
      this.render();
      this._rafId = this.raf(tick);
    };
    this._rafId = this.raf(tick);
  }

  destroy() {
    this.pause();
    this.onProgress = this.onEnd = this.onFeedback = this.onRender = noop;
  }

  /* ---------------- 内部逻辑 ---------------- */

  _reset(level) {
    const cfg = (level && typeof level === 'object') ? level : (LEVELS[level] || LEVELS[1]);
    this.baseCfg = cfg;   // 整关的配置
    this.cfg = cfg;       // 当前生效的配置：分段的关卡（地狱模式）每进一段换一份
    this.stageIdx = -1;
    this.stageFrom = 0;   // 当前这一段从第几层开始（速度按段内层数增长）
    this.levelId = cfg.id;
    this.baseW = this.W * cfg.baseWidthRatio;
    this.stack = [{ x: (this.W - this.baseW) / 2, w: this.baseW, born: -1, flash: 0 }];
    // 从存档点接着叠：塔已经有这么多层（都按满宽度摆好）
    const startLayer = Math.max(0, Math.min(cfg.target - 1, cfg.startLayer || 0));
    for (let i = 0; i < startLayer; i++) {
      this.stack.push({ x: (this.W - this.baseW) / 2, w: this.baseW, born: -1, flash: 0 });
    }
    this.block = null;
    this.debris = [];
    this.particles = [];
    this.popups = [];
    this.layers = startLayer;
    this.lives = cfg.lives;
    this.combo = 0;
    this.maxCombo = 0;
    this.perfects = 0;
    this.camY = Math.max(0, this.H * 0.42 - this._layerY(this.stack.length)); // 镜头直接对准塔顶
    this.shake = 0;
    this.redFlash = 0;
    this.time = 0;
    this.endTimer = 0;
    this.frozen = false;
    this.autoLeft = 0;   // 还有几块积木会自动放好
    this.slowLeft = 0;   // 还有几块积木是慢速
    this.slowFactor = 0.5;
    this._result = null;
    this._bg = null;
    this._initAmbient();
  }

  _initAmbient() {
    const t = this.cfg.theme;
    this.ambient = [];
    const n = t.dark ? 26 : 12;
    for (let i = 0; i < n; i++) {
      this.ambient.push({
        x: rand(0, this.W),
        y: rand(0, this.H),
        r: t.ambientSize * rand(0.5, 1.6),
        v: t.ambientSpeed * rand(0.5, 1.5),
        a: rand(0.3, 1),
        sway: rand(0, 6.28)
      });
    }
  }

  _color(i) {
    const t = this.cfg.theme;
    if (t.hueSpan > 0) {
      // 层数很多的关卡：色相不绕整个色环，只在 hue0 ~ hue0+hueSpan 之间来回走（地狱模式一直是红橙黄）
      const p = (i * t.hueStep) % (2 * t.hueSpan);
      return hsl(t.hue0 + (p <= t.hueSpan ? p : 2 * t.hueSpan - p), t.sat, t.light);
    }
    return hsl(t.hue0 + i * t.hueStep, t.sat, t.light);
  }

  /** 第 i 层（0 = 底座）顶边的屏幕 y 坐标（未加镜头偏移） */
  _layerY(i) {
    return this.groundY - (i + 1) * this.bh;
  }

  /**
   * 分段的关卡：按"已经叠了几层"换到对应那一段的参数。刚进入一段时飘字提示。
   * 没有 stages 的关卡什么都不做。
   */
  _applyStage(n) {
    const stages = this.baseCfg.stages;
    if (!stages || !stages.length) return;
    let idx = 0;
    for (let i = 0; i < stages.length; i++) if (n >= stages[i].from) idx = i;
    if (idx === this.stageIdx) return;
    const st = stages[idx];
    this.stageIdx = idx;
    this.stageFrom = st.from;
    this.cfg = Object.assign({}, this.baseCfg, st.set || {});
    this.cfg.theme = Object.assign({}, this.baseCfg.theme, (st.set && st.set.theme) || {});
    this._bg = null; // 背景色换了，渐变要重建
    if (this.state === 'playing' && st.title && n === st.from) {
      this._popup(st.title, this.W / 2, this._layerY(this.stack.length) - 64, 2.2);
    }
  }

  _spawn() {
    const n = this.layers;
    this._applyStage(n);
    const cfg = this.cfg;
    const top = this.stack[this.stack.length - 1];
    const w = top.w;

    // 这块积木用到的随机量。关卡带种子（今日挑战）时，按"种子 + 第几层"生成：
    // 第 n 层那块的方向、快慢、掉头时机永远一样，不管是重来、复活还是从弹窗回来。
    const rnd = cfg.seed != null ? seededRandom(cfg.seed + (n + 1) * 7919) : Math.random;
    const pick = function (a, b) { return a + rnd() * (b - a); };

    let speed = Math.min(cfg.maxSpeed, cfg.speed * Math.pow(1 + cfg.speedGrow, n - this.stageFrom)) * this.scale;
    if (cfg.jitter) speed *= 1 + pick(-cfg.jitter, cfg.jitter);

    const fromLeft = cfg.randomSide ? rnd() < 0.5 : n % 2 === 0;
    const minX = -w * 0.3;
    const maxX = this.W - w * 0.7;

    this.block = {
      x: fromLeft ? minX : maxX,
      w: w,
      dir: fromLeft ? 1 : -1,
      speed: speed,
      v: speed,
      minX: minX,
      maxX: maxX,
      t: 0,
      phase: pick(0, 6.28),
      pick: pick,
      wobble: cfg.wobble > 0 && cfg.wobbleFrom >= 0 && n >= cfg.wobbleFrom,
      feint: cfg.feintFrom >= 0 && n >= cfg.feintFrom,
      feintIn: pick(0.5, 1.3),
      blink: cfg.blinkFrom >= 0 && n >= cfg.blinkFrom,
      auto: this.state === 'playing' && this.autoLeft > 0,
      slow: this.state === 'playing' && this.slowLeft > 0
    };

    // 进入新阶段时飘字提示，让玩家知道接下来变了什么
    if (this.state === 'playing' && cfg.announce && cfg.announce[n]) {
      this._popup(cfg.announce[n], this.W / 2, this._layerY(this.stack.length) - 64, 1.6);
    }
  }

  _drop() {
    const cfg = this.cfg;
    const s = this.scale;
    const b = this.block;
    const top = this.stack[this.stack.length - 1];
    const idx = this.stack.length;       // 这块积木落在第几层
    const y = this._layerY(idx);
    const color = this._color(idx);
    const dx = b.x - top.x;

    // 这块用掉了一次道具（不管最后叠没叠上）
    if (b.auto) this.autoLeft = Math.max(0, this.autoLeft - 1);
    if (b.slow) this.slowLeft = Math.max(0, this.slowLeft - 1);

    let x, w;
    let perfect = false;

    if (Math.abs(dx) <= cfg.perfectTol * s) {
      // 完美：自动吸附对齐，简单关还会把积木加宽一点
      perfect = true;
      w = Math.min(this.baseW, top.w + cfg.regrow * s);
      x = clamp(top.x - (w - top.w) / 2, 0, this.W - w);
    } else {
      const left = Math.max(b.x, top.x);
      const right = Math.min(b.x + b.w, top.x + top.w);
      const overlap = right - left;

      if (overlap < cfg.minOverlap * s) {
        this._miss(b, y, color);
        return;
      }
      x = left;
      w = overlap;
      // 被切掉的那一截掉下去
      if (dx > 0) this._addDebris(right, y, b.x + b.w - right, color, 1);
      else this._addDebris(b.x, y, top.x - b.x, color, -1);
    }

    // 完美并且真的变宽了：记下变宽前的位置，渲染时播一段"向两边长出来"的动画，
    // 让玩家看明白这是奖励，而不是积木画错了
    let grew = perfect && w - top.w > 0.5;
    let growFrom = grew ? { x: top.x, w: top.w, t: this.time } : null;

    // 存档点（地狱模式每 100 层）：这一块落稳后直接长回满宽度，生命也回满
    const every = cfg.checkpointEvery;
    const checkpoint = !!every && (this.layers + 1) % every === 0 && this.layers + 1 < cfg.target;
    if (checkpoint) {
      if (!growFrom) growFrom = { x: x, w: w, t: this.time };
      const mid = x + w / 2;
      w = this.baseW;
      x = clamp(mid - w / 2, 0, this.W - w);
      grew = w - growFrom.w > 0.5;
      if (!grew) growFrom = null;
      this.lives = Math.max(this.lives, cfg.lives);
    }

    this.stack.push({
      x: x, w: w, born: this.time, flash: perfect || checkpoint ? 1 : 0,
      grow: growFrom
    });
    this.layers++;
    this.shake = Math.max(this.shake, cfg.shake);

    if (perfect) {
      this.combo++;
      this.perfects++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      let text = this.combo > 1 ? '完美 ×' + this.combo : '完美！';
      if (grew && !checkpoint) text += this.combo > 1 ? ' · 变宽' : '积木变宽';
      if (!checkpoint) this._popup(text, x + w / 2, y - 14);
      this._burst(x + w / 2, y + this.bh / 2, w, 14, '#ffffff');
      if (grew) {
        this._sideBurst(x, y + this.bh / 2, -1);
        this._sideBurst(x + w, y + this.bh / 2, 1);
      }
      this.onFeedback('perfect');
    } else {
      this.combo = 0;
      this.onFeedback('place');
    }
    if (checkpoint) {
      this._popup('已存档 · 积木和生命回满', this.W / 2, this._layerY(this.stack.length) - 100, 2.2);
      this._burst(x + w / 2, y + this.bh / 2, w, 22, '#ffd166');
      if (grew) {
        this._sideBurst(x, y + this.bh / 2, -1);
        this._sideBurst(x + w, y + this.bh / 2, 1);
      }
      this.onFeedback('checkpoint');
    }

    this._emitProgress();

    if (this.layers >= cfg.target) {
      this.block = null;
      this._finish(true);
    } else {
      this._spawn();
    }
  }

  _miss(b, y, color) {
    // 整块没叠上：整块掉下去，扣一条命
    this._addDebris(b.x, y, b.w, color, b.dir);
    this.combo = 0;
    this.lives--;
    this.shake = Math.max(this.shake, 10);
    this._emitProgress();

    if (this.lives > 0) {
      this._popup('没叠上，还剩 ' + this.lives + ' 次机会', this.W / 2, y - 20);
      this.onFeedback('miss');
      this._spawn();
    } else {
      this.block = null;
      this.redFlash = 1;
      this.shake = 16;
      this._finish(false);
    }
  }

  _finish(win) {
    this.state = 'ending';
    this.endTimer = win ? 1.3 : 0.9;
    this._result = {
      win: win,
      level: this.levelId,
      layers: this.layers,
      target: this.cfg.target,
      perfects: this.perfects,
      maxCombo: this.maxCombo
    };
    if (win) {
      this._confetti();
      this.onFeedback('win');
    } else {
      this.onFeedback('fail');
    }
  }

  _emitProgress() {
    this.onProgress({
      layers: this.layers,
      target: this.cfg.target,
      lives: this.lives,
      combo: this.combo,
      autoLeft: this.autoLeft,
      slowLeft: this.slowLeft
    });
  }

  _addDebris(x, y, w, color, dir) {
    if (w <= 0.5) return;
    this.debris.push({
      x: x, y: y, w: w, h: this.bh, color: color,
      vx: dir * rand(30, 80) * this.scale,
      vy: -rand(20, 80),
      rot: 0,
      vr: dir * rand(1.5, 4)
    });
  }

  _popup(text, x, y, life) {
    // 普通飘字（完美、没叠上）同一时间只留最新的一条，避免叠在一起看不清；阶段提示不受影响
    const sticky = !!life;
    if (!sticky) this.popups = this.popups.filter(function (p) { return p.sticky; });
    life = life || 0.9;
    this.popups.push({ text: text, x: clamp(x, 70, this.W - 70), y: y, life: life, max: life, sticky: sticky });
  }

  _burst(cx, cy, w, n, color) {
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: cx + rand(-w / 2, w / 2), y: cy,
        vx: rand(-90, 90), vy: rand(-170, -40),
        g: 420, size: rand(2, 4.5), color: color,
        life: rand(0.4, 0.8), max: 0.8
      });
    }
  }

  /** 积木变宽时，从两端向外喷的一小撮火花 */
  _sideBurst(x, cy, dir) {
    for (let i = 0; i < 7; i++) {
      this.particles.push({
        x: x, y: cy + rand(-this.bh * 0.35, this.bh * 0.35),
        vx: dir * rand(60, 190), vy: rand(-60, 30),
        g: 160, size: rand(2, 4), color: '#fff3b0',
        life: rand(0.3, 0.6), max: 0.6
      });
    }
  }

  _confetti() {
    const top = this.stack[this.stack.length - 1];
    const cy = this._layerY(this.stack.length - 1);
    for (let i = 0; i < 70; i++) {
      this.particles.push({
        x: top.x + top.w / 2, y: cy,
        vx: rand(-240, 240), vy: rand(-520, -160),
        g: 520, size: rand(3, 7), color: hsl(rand(0, 360), 0.9, 0.62),
        life: rand(1.0, 1.9), max: 1.9
      });
    }
  }

  /** 推进一帧逻辑。dt 单位：秒 */
  update(dt) {
    if (this.frozen) return;
    const cfg = this.cfg;
    this.time += dt;

    // 滑动中的积木
    const b = this.block;
    if (b && (this.state === 'playing' || this.state === 'idle')) {
      // 慢速道具：这块积木的"时间"整体变慢，移动、变速、隐身的节奏和限时都跟着变慢
      const step = b.slow ? dt * this.slowFactor : dt;
      const top = this.stack[this.stack.length - 1];
      const before = b.x - top.x;

      b.t += step;
      let v = b.speed;
      if (b.wobble) v *= 1 + cfg.wobble * Math.sin(b.t * cfg.wobbleFreq + b.phase); // 忽快忽慢
      b.v = v;
      b.x += b.dir * v * step;
      if (b.x <= b.minX) { b.x = b.minX; b.dir = 1; }
      else if (b.x >= b.maxX) { b.x = b.maxX; b.dir = -1; }

      if (b.feint) { // 假动作：滑到一半突然掉头
        b.feintIn -= step;
        if (b.feintIn <= 0) {
          b.dir = -b.dir;
          b.feintIn = b.pick(0.45, 1.3);
        }
      }
      if (this.state === 'playing') {
        const after = b.x - top.x;
        if (b.auto && b.t > 0.3 && (before * after <= 0 || Math.abs(after) <= cfg.perfectTol * this.scale)) {
          b.x = top.x;  // 自动放好：滑到正上方的那一刻自己落下
          this._drop();
        } else if (cfg.timeLimit && b.t >= cfg.timeLimit) {
          this._drop(); // 超时：不管在哪都直接落下
        }
      }
    }

    // 镜头跟着塔顶往上走
    const topY = this._layerY(this.stack.length);
    const camTarget = Math.max(0, this.H * 0.42 - topY);
    this.camY += (camTarget - this.camY) * Math.min(1, dt * 6);

    // 刚落下的积木的高亮闪光
    for (let i = this.stack.length - 1; i >= 0 && i >= this.stack.length - 3; i--) {
      const sItem = this.stack[i];
      if (sItem.flash > 0) sItem.flash = Math.max(0, sItem.flash - dt * 3);
    }

    // 被切掉的碎块
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.vy += 1500 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.vr * dt;
      if (d.y + this.camY > this.H + 120) this.debris.splice(i, 1);
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= dt;
      p.y -= 34 * dt;
      if (p.life <= 0) this.popups.splice(i, 1);
    }

    for (let i = 0; i < this.ambient.length; i++) {
      const a = this.ambient[i];
      a.y -= a.v * dt;
      a.sway += dt;
      if (a.y < -20) { a.y = this.H + 20; a.x = rand(0, this.W); }
    }

    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 40);
    if (this.redFlash > 0) this.redFlash = Math.max(0, this.redFlash - dt * 1.6);

    // 结算动画播完后通知页面
    if (this.state === 'ending') {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.state = 'over';
        this.onEnd(this._result);
      }
    }
  }

  /* ---------------- 绘制 ---------------- */

  render() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const cfg = this.cfg;
    const theme = cfg.theme;
    const bh = this.bh;
    const cam = this.camY;

    // 背景
    if (!this._bg) {
      this._bg = ctx.createLinearGradient(0, 0, 0, H);
      this._bg.addColorStop(0, theme.bgTop);
      this._bg.addColorStop(1, theme.bgBottom);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = this._bg;
    ctx.fillRect(0, 0, W, H);

    // 氛围粒子：第一关是飘浮的泡泡，第二关是上升的火星
    ctx.fillStyle = theme.ambient;
    for (let i = 0; i < this.ambient.length; i++) {
      const a = this.ambient[i];
      ctx.globalAlpha = a.a;
      ctx.beginPath();
      ctx.arc(a.x + Math.sin(a.sway) * 8, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.save();
    if (this.shake > 0.3) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // 地面
    const gy = this.groundY + cam;
    if (gy < H + 20) {
      ctx.fillStyle = theme.ground;
      ctx.fillRect(-20, gy, W + 40, H - gy + 40);
    }

    // 已经叠好的积木
    for (let i = 0; i < this.stack.length; i++) {
      const sItem = this.stack[i];
      let y = this._layerY(i) + cam;
      if (y > H + 20 || y < -bh - 20) continue;
      if (sItem.born >= 0) { // 落下时的一小段下压动画
        const k = clamp((this.time - sItem.born) / 0.12, 0, 1);
        y -= (1 - k) * (1 - k) * 8;
      }
      // 完美变宽：先按变宽前的宽度落稳，再向两边弹出去（略微过冲再回弹）
      let bx = sItem.x;
      let bw = sItem.w;
      const g = sItem.grow;
      let gk = 1;
      if (g) {
        gk = clamp((this.time - g.t - GROW_DELAY) / GROW_TIME, 0, 1);
        const e = backOut(gk);
        bx = g.x + (sItem.x - g.x) * e;
        bw = g.w + (sItem.w - g.w) * e;
      }
      this._drawBlock(bx, y, bw, bh, this._color(i), 1);
      if (sItem.flash > 0) {
        ctx.globalAlpha = sItem.flash * 0.75;
        ctx.fillStyle = '#ffffff';
        roundRect(ctx, bx, y, bw, bh - 1, 6);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (g && gk > 0 && gk < 1) {
        // 新长出来的两截单独提亮，慢慢褪成积木本色
        ctx.save();
        ctx.beginPath();
        ctx.rect(bx - 1, y - 1, Math.max(0, g.x - bx) + 1, bh + 1);
        ctx.rect(g.x + g.w, y - 1, Math.max(0, bx + bw - g.x - g.w) + 1, bh + 1);
        ctx.clip();
        ctx.globalAlpha = 0.9 * (1 - gk);
        ctx.fillStyle = '#fff3b0';
        roundRect(ctx, bx, y, bw, bh - 1, 6);
        ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // 正在滑动的积木
    const b = this.block;
    if (b) {
      const idx = this.stack.length;
      const y = this._layerY(idx) + cam - 8;
      let alpha = 1;
      if (b.blink) alpha = clamp(0.5 + 0.85 * Math.sin(b.t * 6 + b.phase), cfg.blinkMin, 1); // 忽隐忽现
      this._drawBlock(b.x, y, b.w, bh, this._color(idx), alpha);
      if (b.auto || b.slow) { // 道具生效中的积木描一圈亮边：金色 = 自动放好，浅蓝 = 慢速
        ctx.strokeStyle = b.auto ? '#ffd166' : '#8fe3ff';
        ctx.lineWidth = 2;
        roundRect(ctx, b.x - 1, y - 1, b.w + 2, bh + 1, 7);
        ctx.stroke();
      }

      // 限时条
      if (cfg.timeLimit && this.state === 'playing') {
        const ratio = clamp(1 - b.t / cfg.timeLimit, 0, 1);
        ctx.fillStyle = ratio < 0.3 ? '#ff4d4f' : 'rgba(255,255,255,0.85)';
        ctx.fillRect(b.x + b.w * (1 - ratio) / 2, y - 8, b.w * ratio, 3);
      }
    }

    // 碎块
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      ctx.save();
      ctx.translate(d.x + d.w / 2, d.y + cam + d.h / 2);
      ctx.rotate(d.rot);
      this._drawBlock(-d.w / 2, -d.h / 2, d.w, d.h, d.color, 0.9);
      ctx.restore();
    }

    // 粒子
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      ctx.globalAlpha = clamp(p.life / p.max * 1.5, 0, 1);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y + cam - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // 飘字
    if (this.popups.length) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold ' + Math.round(20 * Math.min(1.2, this.scale)) + 'px sans-serif';
      for (let i = 0; i < this.popups.length; i++) {
        const p = this.popups[i];
        ctx.globalAlpha = clamp(p.life / p.max * 2, 0, 1);
        ctx.fillStyle = theme.popupShadow; // 先描一圈深色，浅色背景上也看得清
        ctx.fillText(p.text, p.x - 1, p.y + cam);
        ctx.fillText(p.text, p.x + 1, p.y + cam);
        ctx.fillText(p.text, p.x, p.y + cam + 2);
        ctx.fillStyle = theme.popup;
        ctx.fillText(p.text, p.x, p.y + cam);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // 死亡时的红色闪屏
    if (this.redFlash > 0) {
      ctx.globalAlpha = this.redFlash * 0.45;
      ctx.fillStyle = '#ff1a1a';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // 界面（菜单、层数、结算）画在最上面
    this.onRender(this.time);
  }

  _drawBlock(x, y, w, h, color, alpha) {
    if (w <= 0) return;
    const ctx = this.ctx;
    const bodyH = h - 1; // 留 1px 缝隙，层与层之间有分界线
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    roundRect(ctx, x, y, w, bodyH, 6);
    ctx.fill();
    if (w > 8) {
      // 顶部高光 + 底部阴影，做出一点立体感
      ctx.fillStyle = 'rgba(255,255,255,0.26)';
      roundRect(ctx, x + 2, y + 2, w - 4, bodyH * 0.32, 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.13)';
      roundRect(ctx, x + 2, y + bodyH * 0.78, w - 4, bodyH * 0.22 - 2, 3);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

module.exports = {
  StackGame: StackGame,
  LEVELS: LEVELS,
  roundRect: roundRect,
  hsl: hsl,
  seededRandom: seededRandom
};

};
defs["hell"] = function (module, exports, require) {
/**
 * 「是狠人就下999层地狱」—— 第四个模式。
 *
 * 和其他关卡的区别：
 *   - 要叠 999 层，每 100 层是一段，越往下越难（每一段的花样见下面的 STAGES）
 *   - 每过 100 层：积木回满宽度、生命回满，并且存档——下次进来从存档点接着叠
 *   - 道具不限次数（在 rewards.js 的 REWARDS.unlimitedLevels 里），复活时积木也回满宽度
 *   - 不按天刷新，进度一直留着，直到通关
 *
 * 想调难度，改 STAGES 里每一段的参数即可（参数含义见 game.js 顶部 LEVELS 的注释）。
 */
const HELL_ID = 4;
const HELL_TARGET = 999;
const HELL_CHECKPOINT = 100; // 每多少层存一次档

/**
 * 每 100 层一段。from = 这一段从叠好多少层之后开始；title = 进入这一段时飘的字；
 * set = 这一段覆盖的参数（没写的沿用 buildHell 里的基础参数）。
 * 速度在段内按 speedGrow 逐层变快，到 maxSpeed 为止。
 */
const STAGES = [
  {
    from: 0, title: '地狱第 1 层 · 先热个身',
    set: { speed: 150, speedGrow: 0.0028, maxSpeed: 198, perfectTol: 6,
      theme: { bgTop: '#1a0508', bgBottom: '#5a1410' } }
  },
  {
    from: 100, title: '第 101 层 · 忽快忽慢',
    set: { speed: 190, speedGrow: 0.0024, maxSpeed: 240, perfectTol: 6, wobble: 0.3, wobbleFreq: 5, wobbleFrom: 0,
      theme: { bgTop: '#1d0607', bgBottom: '#6a2408' } }
  },
  {
    from: 200, title: '第 201 层 · 左右乱来',
    set: { speed: 215, speedGrow: 0.0021, maxSpeed: 265, perfectTol: 5, wobble: 0.3, wobbleFreq: 5, wobbleFrom: 0,
      randomSide: true, jitter: 0.15,
      theme: { bgTop: '#1a0a02', bgBottom: '#6b3a05' } }
  },
  {
    from: 300, title: '第 301 层 · 假动作',
    set: { speed: 235, speedGrow: 0.0019, maxSpeed: 285, perfectTol: 5, wobble: 0.3, wobbleFreq: 5, wobbleFrom: 0,
      randomSide: true, jitter: 0.15, feintFrom: 0,
      theme: { bgTop: '#12060f', bgBottom: '#571046' } }
  },
  {
    from: 400, title: '第 401 层 · 忽隐忽现',
    set: { speed: 250, speedGrow: 0.0018, maxSpeed: 300, perfectTol: 5, wobble: 0.3, wobbleFreq: 5, wobbleFrom: 0,
      randomSide: true, jitter: 0.15, blinkFrom: 0, blinkMin: 0.3,
      theme: { bgTop: '#0b0718', bgBottom: '#3a1263' } }
  },
  {
    from: 500, title: '第 501 层 · 每块限时',
    set: { speed: 270, speedGrow: 0.0017, maxSpeed: 320, perfectTol: 5, wobble: 0.45, wobbleFreq: 6, wobbleFrom: 0,
      randomSide: true, jitter: 0.18, timeLimit: 3.5,
      theme: { bgTop: '#060a1c', bgBottom: '#12306a' } }
  },
  {
    from: 600, title: '第 601 层 · 掉头加隐身',
    set: { speed: 290, speedGrow: 0.0016, maxSpeed: 340, perfectTol: 4, wobble: 0.45, wobbleFreq: 6, wobbleFrom: 0,
      randomSide: true, jitter: 0.18, feintFrom: 0, blinkFrom: 0, blinkMin: 0.22,
      theme: { bgTop: '#04120f', bgBottom: '#0e4a3a' } }
  },
  {
    from: 700, title: '第 701 层 · 提速',
    set: { speed: 320, speedGrow: 0.0017, maxSpeed: 380, perfectTol: 4, wobble: 0.5, wobbleFreq: 7, wobbleFrom: 0,
      randomSide: true, jitter: 0.2, feintFrom: 0, timeLimit: 3.5,
      theme: { bgTop: '#101010', bgBottom: '#4a2a12' } }
  },
  {
    from: 800, title: '第 801 层 · 全都来',
    set: { speed: 350, speedGrow: 0.0016, maxSpeed: 410, perfectTol: 4, wobble: 0.5, wobbleFreq: 7, wobbleFrom: 0,
      randomSide: true, jitter: 0.2, feintFrom: 0, blinkFrom: 0, blinkMin: 0.15, timeLimit: 3,
      theme: { bgTop: '#140003', bgBottom: '#7a0010' } }
  },
  {
    from: 900, title: '第 901 层 · 最后一百层',
    set: { speed: 380, speedGrow: 0.0017, maxSpeed: 450, perfectTol: 3, wobble: 0.5, wobbleFreq: 7, wobbleFrom: 0,
      randomSide: true, jitter: 0.22, feintFrom: 0, blinkFrom: 0, blinkMin: 0.1, timeLimit: 2.5,
      theme: { bgTop: '#000000', bgBottom: '#3a0000' } }
  }
];

/**
 * 一路上飘出来的俏皮话：叠到第几层时飘哪一句（和每 100 层的阶段提示错开）。
 * 想加就照着加一行，想换词直接改；一句最好别超过 14 个字，太长小屏幕放不下。
 */
const QUIPS = {
  7: '才 7 层，别急着得意',
  18: '十八层地狱？这才刚开始',
  38: '下面的空气有点烫',
  66: '六六大顺，继续往下',
  88: '88 层：恭喜发烫',
  123: '1、2、3，木头人别抖',
  166: '手心开始出汗了吧',
  188: '想发发？先别发抖',
  233: '233，笑着下地狱',
  250: '第 250 层，说的不是你',
  288: '孟婆：喝碗汤再走？',
  333: '三三三，想散也散不了',
  366: '一整年都没这么努力过',
  404: '第 404 层：出口未找到',
  438: '阎王翻了翻你的档案',
  444: '四四四，稳住别慌',
  499: '再一层就到半地腰了',
  520: '520：地狱也爱你',
  555: '555，想哭就哭吧',
  588: '手指还是你自己的吗',
  618: '618 大促：复活不打折',
  648: '隔壁小鬼在偷看你叠',
  668: '感觉灵魂都烧热了',
  688: '恭喜，已烤到五分熟',
  720: '牛头马面给你点了个赞',
  748: '小鬼：这人怎么还没走',
  777: '777，手气不错，省着用',
  788: '七分熟，外焦里嫩',
  818: '阎王：给他加点难度',
  848: '回头？早就没有岸了',
  866: '空气都被你叠出花了',
  888: '发发发，一路发到地心',
  920: '快到底了，别手抖',
  950: '最后 49 层，深呼吸',
  966: '阎王已经在门口等你',
  980: '全熟了，可以出锅了',
  990: '最后 9 层，别在这翻车',
  996: '996 都没这么累',
  998: '最后一块，稳住'
};

/** 把任意层数对齐到它所在的存档点：0、100、200 … 900 */
function checkpointOf(layers) {
  const n = Math.max(0, Math.min(HELL_TARGET - 1, Math.floor(layers || 0)));
  return Math.floor(n / HELL_CHECKPOINT) * HELL_CHECKPOINT;
}

/**
 * 生成地狱模式的关卡配置。
 * @param {number} [startLayer]  从第几层的存档点接着叠（0 = 从头）
 */
function buildHell(startLayer) {
  return {
    id: HELL_ID,
    name: '999 层地狱',
    fullName: '是狠人就下999层地狱',
    target: HELL_TARGET,
    lives: 3,
    baseWidthRatio: 0.5,
    speed: 150,
    speedGrow: 0.0028,
    maxSpeed: 198,
    perfectTol: 6,
    regrow: 6,
    minOverlap: 2,
    jitter: 0,
    randomSide: false,
    wobble: 0,
    wobbleFreq: 0,
    wobbleFrom: -1,
    feintFrom: -1,
    blinkFrom: -1,
    blinkMin: 1,
    announce: QUIPS,   // 叠到这些层数时飘一句俏皮话
    timeLimit: 0,
    shake: 5,
    startLayer: checkpointOf(startLayer), // 开局时塔已经有这么多层
    checkpointEvery: HELL_CHECKPOINT,     // 每叠满这么多层：积木回满、生命回满，并通知页面存档
    reviveRefill: true,                   // 复活时积木回满宽度（不然又窄又只有一条命，复活了也是马上再死）
    stages: STAGES,
    theme: {
      bgTop: '#1a0508',
      bgBottom: '#5a1410',
      ground: 'rgba(0,0,0,0.55)',
      dark: true,
      hue0: -12, hueStep: 6, hueSpan: 60, sat: 0.88, light: 0.52, // 积木颜色在红 → 橙 → 黄之间来回
      ambient: 'rgba(255,120,40,0.55)', ambientSize: 2.2, ambientSpeed: 46,
      popup: '#ffd166', popupShadow: 'rgba(0,0,0,0.6)'
    }
  };
}

module.exports = {
  HELL_ID: HELL_ID,
  HELL_TARGET: HELL_TARGET,
  HELL_CHECKPOINT: HELL_CHECKPOINT,
  STAGES: STAGES,
  QUIPS: QUIPS,
  buildHell: buildHell,
  checkpointOf: checkpointOf
};

};
defs["rewards"] = function (module, exports, require) {
/**
 * 道具的获取方式：转发给好友 / 看激励视频广告。
 *
 * 三种道具：
 *   life  加一条命   —— 失败后在结算卡片上出现，保留已叠的层数接着叠
 *   auto  自动放好   —— 游戏中屏幕底部的按钮，接下来几块积木自己对齐落下
 *   slow  慢速       —— 游戏中屏幕底部的按钮，接下来几块积木速度变慢
 *
 * 所有开关和数值都在下面的 REWARDS 里，改这里就够了。
 */
const REWARDS = {
  // —— 获取方式 ——
  shareEnabled: true,  // 是否允许"转发给好友"换道具。注意：平台不允许用奖励诱导转发，正式提审前请看 README 的说明
  adEnabled: true,     // 是否允许"看广告"换道具
  adUnitId: '',        // 激励视频广告位 ID（形如 adunit-xxxxxxxxxxxxxxxx），开通流量主后在后台创建
  adTestGrant: true,   // 没填广告位 ID 时，点"看广告"弹一个测试框代替真广告。正式上线前改成 false
  // 转发卡片上的图。小游戏后台可以提交"自定义转发图片"审核，通过后会得到一个图片编号和一个图片地址，
  // 把两个都填到这里就会改用审核通过的图；两个都留空则用代码包里的 images/share.jpg
  shareImageId: '',
  shareImageUrl: '',
  shareMinMs: 2000,    // 点了转发之后，离开页面不到这么久就回来的，当作没转发（毫秒）。平台不告诉我们是否真的转发了，只能这样估计

  // —— 每一局最多能用几次（0 = 不提供这种道具）——
  perRun: { life: 1, auto: 1, slow: 1 },

  // —— 道具效果 ——
  autoBlocks: 3,       // 自动放好：接下来几块
  slowBlocks: 5,       // 慢速：接下来几块
  slowFactor: 0.5,     // 慢速时的速度倍数（0.5 = 一半）

  // —— 哪几关提供道具（1 第一关，2 第二关，3 今日挑战，4 地狱模式）——
  levels: [1, 2, 3, 4],

  // —— 哪几关的道具不限次数（上面 perRun 的次数限制对这些关不生效；每次仍然要转发或看广告）——
  unlimitedLevels: [4]
};

/** 每种道具在弹窗里的标题和说明 */
function describe(type, layers) {
  if (type === 'life') {
    return { title: '加一条命', desc: '保留已经叠好的 ' + layers + ' 层，多一条命接着叠。' };
  }
  if (type === 'auto') {
    return { title: '自动放好', desc: '接下来 ' + REWARDS.autoBlocks + ' 块积木自己对齐落下，都算完美。' };
  }
  return { title: '慢速', desc: '接下来 ' + REWARDS.slowBlocks + ' 块积木的速度降到平时的 ' + Math.round(REWARDS.slowFactor * 100) + '%。' };
}

/** 激励视频广告。整个页面只创建一个广告实例，反复使用。 */
class RewardAd {
  constructor() {
    this.ad = null;
    this.done = null;
  }

  /** "看广告"这个选项现在能不能用 */
  available() {
    return REWARDS.adEnabled && (!!REWARDS.adUnitId || REWARDS.adTestGrant);
  }

  /** 现在是不是用测试框代替真广告 */
  isTest() {
    return !REWARDS.adUnitId;
  }

  /**
   * 播放广告。done(true) = 完整看完，可以发奖励；done(false) = 中途关掉，或者广告没放出来。
   */
  show(done) {
    if (this.isTest()) {
      wx.showModal({
        title: '测试模式',
        content: '还没有填广告位 ID，这里用弹窗代替真广告。上线前请在 utils/rewards.js 里填好 adUnitId，并把 adTestGrant 改成 false。',
        confirmText: '算看完',
        cancelText: '没看完',
        success: (r) => done(!!(r && r.confirm)),
        fail: () => done(false)
      });
      return;
    }
    if (!wx.createRewardedVideoAd) {
      wx.showToast({ title: '当前微信版本不支持视频广告', icon: 'none' });
      done(false);
      return;
    }
    if (!this.ad) {
      this.ad = wx.createRewardedVideoAd({ adUnitId: REWARDS.adUnitId });
      this.ad.onError((err) => {
        console.warn('[广告] 出错', err && err.errCode, err && err.errMsg);
      });
      this.ad.onClose((res) => {
        // 玩家关掉广告时触发。res.isEnded 为 true 才是完整看完；很老的微信版本不带 res，按看完处理
        const cb = this.done;
        this.done = null;
        if (cb) cb(!res || !!res.isEnded);
      });
    }
    this.done = done;
    // 先直接放；放不出来就重新拉取一次再放
    this.ad.show()
      .catch(() => this.ad.load().then(() => this.ad.show()))
      .catch((err) => {
        console.warn('[广告] 没放出来', err && err.errCode, err && err.errMsg);
        this.done = null;
        wx.showToast({ title: '广告暂时没加载出来，稍后再试', icon: 'none' });
        done(false);
      });
  }

  destroy() {
    try {
      if (this.ad && this.ad.destroy) this.ad.destroy();
    } catch (e) {}
    this.ad = null;
    this.done = null;
  }
}

module.exports = { REWARDS: REWARDS, RewardAd: RewardAd, describe: describe };

};
defs["ui"] = function (module, exports, require) {
/**
 * 界面层：主页选关、游戏中的层数/生命/道具按钮、结算卡片。
 *
 * 全部直接画在游戏画布上，不用 WXML 元素叠在画布上面 ——
 * 这样不管画布在各端的层级怎么处理，界面都一定看得见。
 * 尺寸沿用 rpx 的习惯：r(750) = 屏幕宽度。
 */
const { roundRect } = require('./game');

const NO_BREAK_BEFORE = '，。、！？；：,.!?';

class GameUI {
  /**
   * @param {Object} opts
   * @param {CanvasRenderingContext2D} opts.ctx
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {number} opts.hudTop  顶部信息的起始 y（避开右上角胶囊按钮）
   * @param {number} opts.safeBottom  屏幕底部要让开的高度（全面屏底部的横条）
   */
  constructor(opts) {
    this.ctx = opts.ctx;
    this.W = opts.width;
    this.H = opts.height;
    this.hudTop = opts.hudTop || 52;
    this.safeBottom = opts.safeBottom || 0;
    // 1rpx 对应多少 px；屏幕很矮或很宽（平板）时按高度收缩，保证内容放得下
    this.u = Math.min(this.W / 750, this.H / 1340);
    this.buttons = []; // 当前画面上可点击的区域
  }

  /** 每帧调用：按当前状态画界面，并记录可点击区域 */
  draw(st, time) {
    this.buttons = [];
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    if (st.view === 'start') this._start(st);
    else if (st.view === 'menu') this._menu(st);
    else if (st.view === 'play') this._hud(st, time);
    else if (st.view === 'result' && st.result) this._result(st);
    if (st.sheet) {
      // 弹窗盖在最上面；它开着的时候，下面那些按钮都不能点
      this.buttons = [];
      this._sheet(st);
    }
    ctx.restore();
  }

  /** 点到了哪个按钮，没点到返回 null */
  hit(x, y) {
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
    }
    return null;
  }

  /* ---------------- 小工具 ---------------- */

  _font(size, bold) {
    this.ctx.font = (bold ? 'bold ' : '') + Math.max(8, Math.round(size)) + 'px sans-serif';
  }

  /** 画一行字，y 是这行字的垂直中心 */
  _text(text, x, y, size, color, bold, align) {
    const ctx = this.ctx;
    this._font(size, bold);
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  _wrap(text, maxW, size) {
    const ctx = this.ctx;
    this._font(size, false);
    const lines = [];
    let line = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (line && ctx.measureText(line + ch).width > maxW && NO_BREAK_BEFORE.indexOf(ch) < 0) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  _shadow(color, blur, offsetY) {
    const ctx = this.ctx;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = offsetY || 0;
  }

  _noShadow() {
    const ctx = this.ctx;
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  _heart(cx, cy, size, color) {
    const ctx = this.ctx;
    const t = size / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + t * 0.95);
    ctx.bezierCurveTo(cx - t * 1.75, cy - t * 0.1, cx - t * 0.85, cy - t * 1.3, cx, cy - t * 0.4);
    ctx.bezierCurveTo(cx + t * 0.85, cy - t * 1.3, cx + t * 1.75, cy - t * 0.1, cx, cy + t * 0.95);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /* ---------------- 主页 ---------------- */

  _menu(st) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, u = this.u;
    const r = function (n) { return n * u; };

    ctx.fillStyle = 'rgba(30,30,70,0.38)';
    ctx.fillRect(0, 0, W, H);

    const cw = Math.min(W - r(96), r(654));
    const cx = (W - cw) / 2;
    const pad = r(40);
    const locked = !st.unlocked; // 今天的第一关还没通关

    const d = st.daily || {};
    const cards = [
      {
        id: 'level1', no: '第一关', tag: '最简单', name: '新手村',
        foot: st.foot1, style: 'light', alpha: 1
      },
      {
        id: 'level2', no: '第二关 · ' + (st.level2Label || ''), tag: '死亡难度', name: '绝命塔',
        foot: st.foot2, style: 'death', alpha: locked ? 0.72 : 1
      },
      {
        id: 'level3', no: '今日主题 · ' + (d.label || ''), tag: '每天换新', name: '今日挑战 · ' + (d.themeName || ''),
        foot: st.foot3, style: 'daily', alpha: locked ? 0.72 : 1
      },
      {
        id: 'level4', no: '地狱模式 · 999 层', tag: '道具无限', name: '是狠人就下999层地狱',
        foot: st.foot4, style: 'hell', alpha: locked ? 0.72 : 1
      }
    ];
    // 四种卡片的配色：浅色（第一关）、暗红（第二关）、靛蓝配金色（今日挑战）、纯黑配火橙（地狱模式）
    const STYLES = {
      light: { bg: 'rgba(255,255,255,0.94)', shadow: 'rgba(40,40,120,0.18)', no: '#8a8fa8', name: '#2a2d43', desc: '#5d627a', tagBg: '#dcf7ea', tagText: '#1f9d6b' },
      death: { bg: '#1c0a0e', shadow: 'rgba(120,0,20,0.35)', no: '#a8797f', name: '#ff5a6e', desc: '#d9b8bc', tagBg: '#e5253b', tagText: '#ffffff' },
      daily: { bg: '#181a40', shadow: 'rgba(20,20,90,0.4)', no: '#9aa0d8', name: '#ffd166', desc: '#c9cdf2', tagBg: '#ffd166', tagText: '#3a2a00' },
      hell: { bg: '#0a0605', shadow: 'rgba(255,90,0,0.32)', no: '#b08a72', name: '#ff8a2a', desc: '#d9c2b0', tagBg: '#ff6a00', tagText: '#1a0800' }
    };
    let cardsH = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      c.h = r(28) + r(38) + r(8) + r(58) + r(12) + r(34) + r(26); // 小标签 + 关卡名 + 进度，不放文字简介
      cardsH += c.h;
    }
    const gap = r(24);
    const soundH = r(64);
    const total = r(108) + r(12) + r(40) + r(36) + cardsH + gap * (cards.length - 1) + r(32) + soundH;
    let y = Math.max(r(40), (H - total) / 2);

    this._title(y, 92);
    y += r(108) + r(12);

    this._text('每天北京时间0点更新', W / 2, y + r(20), r(28), 'rgba(255,255,255,0.92)', false, 'center');
    y += r(40) + r(36);

    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const k = STYLES[c.style];
      ctx.globalAlpha = c.alpha;

      this._shadow(k.shadow, r(40), r(16));
      ctx.fillStyle = k.bg;
      roundRect(ctx, cx, y, cw, c.h, r(32));
      ctx.fill();
      this._noShadow();

      let cy = y + r(28);
      // 第几关 + 标签
      this._text(c.no, cx + pad, cy + r(19), r(26), k.no, true, 'left');
      this._font(r(22), true);
      const tagW = ctx.measureText(c.tag).width + r(40);
      ctx.fillStyle = k.tagBg;
      roundRect(ctx, cx + cw - pad - tagW, cy, tagW, r(38), r(19));
      ctx.fill();
      this._text(c.tag, cx + cw - pad - tagW / 2, cy + r(20), r(22), k.tagText, true, 'center');
      cy += r(38) + r(8);

      // 关卡名太长（比如地狱模式那一串）就把字号缩到刚好放得下
      let nameSize = r(46);
      this._font(nameSize, true);
      const nameW = ctx.measureText(c.name).width;
      if (nameW > cw - pad * 2) nameSize *= (cw - pad * 2) / nameW;
      this._text(c.name, cx + pad, cy + r(30), nameSize, k.name, true, 'left');
      cy += r(58) + r(12);
      this._text(c.foot, cx + pad, cy + r(17), r(24), k.no, false, 'left');

      ctx.globalAlpha = 1;
      this.buttons.push({ id: c.id, x: cx, y: y, w: cw, h: c.h });
      y += c.h + gap;
    }

    // 声音开关
    y += r(32) - gap;
    this._soundPill(st, y);
  }

  /** 大标题"叠个空气"（逐字画，留出字间距）。y 是标题区域的顶边，size 是字号（rpx） */
  _title(y, size) {
    const ctx = this.ctx;
    const W = this.W, u = this.u;
    const r = function (n) { return n * u; };
    const title = '叠个空气';
    const spacing = r(14);
    this._font(r(size), true);
    let tw = spacing * (title.length - 1);
    for (let i = 0; i < title.length; i++) tw += ctx.measureText(title[i]).width;
    let tx = (W - tw) / 2;
    this._shadow('rgba(40,40,120,0.4)', r(24), r(8));
    for (let i = 0; i < title.length; i++) {
      this._text(title[i], tx, y + r(size * 0.59), r(size), '#ffffff', true, 'left');
      tx += ctx.measureText(title[i]).width + spacing;
    }
    this._noShadow();
  }

  /** 「声音：开 / 关」按钮。y 是按钮的顶边 */
  _soundPill(st, y) {
    const ctx = this.ctx;
    const W = this.W, u = this.u;
    const r = function (n) { return n * u; };
    const h = r(64);
    const label = st.soundOn ? '声音：开' : '声音：关';
    this._font(r(26), true);
    const sw = ctx.measureText(label).width + r(72);
    const sx = (W - sw) / 2;
    ctx.fillStyle = st.soundOn ? 'rgba(255,255,255,0.26)' : 'rgba(20,20,50,0.35)';
    roundRect(ctx, sx, y, sw, h, h / 2);
    ctx.fill();
    this._text(label, W / 2, y + h / 2, r(26), '#ffffff', true, 'center');
    // 点击区域比看到的按钮大一圈，手指更容易点中
    this.buttons.push({ id: 'sound', x: sx - r(24), y: y - r(16), w: sw + r(48), h: h + r(32) });
  }

  /* ---------------- 开始页 ----------------
   * 每天第一次打开看到的画面：背后是今天的第一关，中间一个「开始」按钮，点了就开始第一关。
   * 今天的第一关通关之后，主页才换成三张卡片的选关页。
   */
  _start(st) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, u = this.u;
    const r = function (n) { return n * u; };

    ctx.fillStyle = 'rgba(30,30,70,0.30)';
    ctx.fillRect(0, 0, W, H);

    const bw = r(400), bh = r(124);
    const total = r(140) + r(16) + r(44) + r(120) + bh + r(36) + r(36) + r(72) + r(64);
    let y = Math.max(r(60), (H - total) / 2);

    this._title(y, 116);
    y += r(140) + r(16);
    this._text('第一关 · 新手村 · ' + (st.level1Label || ''), W / 2, y + r(22), r(30), 'rgba(255,255,255,0.94)', true, 'center');
    y += r(44) + r(120);

    // 「开始」
    const bx = (W - bw) / 2;
    this._shadow('rgba(40,40,140,0.35)', r(36), r(14));
    const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, '#6a8dff');
    g.addColorStop(1, '#a56bff');
    ctx.fillStyle = g;
    roundRect(ctx, bx, y, bw, bh, bh / 2);
    ctx.fill();
    this._noShadow();
    this._text('开始', W / 2, y + bh / 2, r(52), '#ffffff', true, 'center');
    this.buttons.push({ id: 'start', x: bx, y: y, w: bw, h: bh });
    y += bh + r(36);

    this._text('通关后解锁其余三个模式', W / 2, y + r(18), r(26), 'rgba(255,255,255,0.88)', false, 'center');
    y += r(36) + r(72);

    this._soundPill(st, y);
  }

  /* ---------------- 游戏中 ---------------- */

  _hud(st, time) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, u = this.u;
    const r = function (n) { return n * u; };
    const death = !!st.dark; // 深色关卡（第二关、今日挑战）用深色样式
    const top = this.hudTop;
    const left = r(36);

    this._shadow('rgba(0,0,0,0.28)', r(8), r(2));

    // 左：关卡名 + 生命
    this._text(st.levelName, left, top + r(20), r(28), death ? '#ff8a8a' : '#ffffff', true, 'left');
    for (let i = 0; i < st.lives; i++) {
      this._heart(left + r(16) + i * r(42), top + r(66), r(32), '#ff5a6e');
    }

    // 右：当前层数 / 目标
    const tail = ' / ' + st.target + ' 层';
    this._font(r(28), false);
    const tailW = ctx.measureText(tail).width;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(tail, W - left, top + r(70));
    this._font(r(84), true);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(st.layers), W - left - tailW, top + r(70));

    // 开局提示（放下第一块后消失）
    if (st.layers === (st.hintAt || 0) && st.hint) {
      ctx.globalAlpha = 0.72 + 0.28 * Math.sin(time * 4.5);
      this._shadow(death ? 'rgba(0,0,0,0.6)' : 'rgba(40,40,130,0.65)', r(12), r(2));
      this._text(st.hint, W / 2, H * 0.3, r(34), death ? '#ffb3b3' : '#ffffff', true, 'center');
      ctx.globalAlpha = 1;
    }
    this._noShadow();

    this._soundKey(st);
    this._items(st);
  }

  /**
   * 游戏中和结算时左上角的静音键：一个小喇叭，点一下开 / 关所有声音。
   * 放在左上角生命值下面，离叠积木时手指常点的区域远，不容易误触。
   */
  _soundKey(st) {
    const ctx = this.ctx;
    const u = this.u;
    const r = function (n) { return n * u; };
    const rad = r(36);
    const cx = r(36) + rad;
    const cy = this.hudTop + r(102) + rad;
    const on = !!st.soundOn;

    ctx.fillStyle = 'rgba(20,20,50,0.45)';
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 喇叭
    const s = rad;
    const ox = cx - s * 0.08;
    ctx.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.moveTo(ox - s * 0.48, cy - s * 0.17);
    ctx.lineTo(ox - s * 0.24, cy - s * 0.17);
    ctx.lineTo(ox + s * 0.04, cy - s * 0.42);
    ctx.lineTo(ox + s * 0.04, cy + s * 0.42);
    ctx.lineTo(ox - s * 0.24, cy + s * 0.17);
    ctx.lineTo(ox - s * 0.48, cy + s * 0.17);
    ctx.closePath();
    ctx.fill();

    ctx.lineWidth = Math.max(1.5, s * 0.1);
    ctx.lineCap = 'round';
    if (on) { // 开：两道声波
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ox + s * 0.06, cy, s * 0.27, -0.85, 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ox + s * 0.06, cy, s * 0.5, -0.85, 0.85);
      ctx.stroke();
    } else { // 关：一个红色的叉
      ctx.strokeStyle = '#ff6b7a';
      ctx.beginPath();
      ctx.moveTo(ox + s * 0.24, cy - s * 0.2);
      ctx.lineTo(ox + s * 0.62, cy + s * 0.2);
      ctx.moveTo(ox + s * 0.62, cy - s * 0.2);
      ctx.lineTo(ox + s * 0.24, cy + s * 0.2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    this.buttons.push({ id: 'sound', x: cx - rad - r(8), y: cy - rad - r(8), w: rad * 2 + r(16), h: rad * 2 + r(16) });
  }

  /**
   * 屏幕底部的道具按钮（自动放好 / 慢速）。st.items 的每一项：
   *   { id, label, state }   state: 'ready' 可以点 | 'active' 生效中 | 'used' 这一局用完了
   */
  _items(st) {
    const items = st.items;
    if (!items || !items.length) return;
    const ctx = this.ctx;
    const W = this.W, H = this.H, u = this.u;
    const r = function (n) { return n * u; };

    const bw = r(232), bh = r(76), gap = r(24);
    const total = items.length * bw + gap * (items.length - 1);
    let x = (W - total) / 2;
    const y = H - this.safeBottom - r(28) - bh;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let fill, color;
      if (it.state === 'active') { fill = '#ffd166'; color = '#3a2a00'; }
      else if (it.state === 'used') { fill = 'rgba(30,30,70,0.30)'; color = 'rgba(255,255,255,0.62)'; }
      else { fill = 'rgba(30,30,70,0.62)'; color = '#ffffff'; }

      ctx.fillStyle = fill;
      roundRect(ctx, x, y, bw, bh, bh / 2);
      ctx.fill();
      if (it.state === 'ready') {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, bw, bh, bh / 2);
        ctx.stroke();
      }
      this._text(it.label, x + bw / 2, y + bh / 2, r(28), color, true, 'center');

      // 只有"可以点"的按钮才响应；点击区域只比按钮大一点点，避免叠积木时误触
      if (it.state === 'ready') this.buttons.push({ id: it.id, x: x, y: y - r(6), w: bw, h: bh + r(12) });
      x += bw + gap;
    }
  }

  /* ---------------- 获取道具的弹窗 ---------------- */

  /**
   * st.sheet: { level, title, desc, canShare, canAd, adLabel }
   * 弹窗直接画在画布上。
   */
  _sheet(st) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, u = this.u;
    const r = function (n) { return n * u; };
    const sh = st.sheet;
    const death = sh.level === 2; // 弹窗的 level：2 = 深色样式，1 = 浅色样式

    ctx.fillStyle = death ? 'rgba(14,0,3,0.74)' : 'rgba(22,22,56,0.62)';
    ctx.fillRect(0, 0, W, H);

    const cw = Math.min(W - r(96), r(654));
    const cx = (W - cw) / 2;
    const pad = r(48);
    const mid = W / 2;
    const lines = this._wrap(sh.desc, cw - pad * 2, r(28));
    const btns = [];
    if (sh.canShare) btns.push({ id: 'sheet-share', label: '转发给好友', share: true });
    if (sh.canAd) btns.push({ id: 'sheet-ad', label: sh.adLabel, share: false });

    const bh = r(96);
    const ch = r(64) + r(68) + r(20) + lines.length * r(44) + r(28) + btns.length * (bh + r(20)) + r(80) + r(28);
    let y = Math.max(r(40), (H - ch) / 2);

    this._shadow('rgba(0,0,0,0.3)', r(60), r(24));
    ctx.fillStyle = death ? '#1c0a0e' : 'rgba(255,255,255,0.97)';
    roundRect(ctx, cx, y, cw, ch, r(40));
    ctx.fill();
    this._noShadow();

    y += r(64);
    this._text(sh.title, mid, y + r(34), r(52), death ? '#ffe9eb' : '#2a2d43', true, 'center');
    y += r(68) + r(20);
    for (let i = 0; i < lines.length; i++) {
      this._text(lines[i], mid, y + r(22), r(28), death ? '#d9b8bc' : '#5d627a', false, 'center');
      y += r(44);
    }
    y += r(28);

    const bx = cx + pad, bw = cw - pad * 2;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.share) {
        ctx.fillStyle = '#048a45';
      } else {
        const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        g.addColorStop(0, death ? '#e5253b' : '#6a8dff');
        g.addColorStop(1, death ? '#ff7a3d' : '#a56bff');
        ctx.fillStyle = g;
      }
      roundRect(ctx, bx, y, bw, bh, bh / 2);
      ctx.fill();
      this._text(b.label, mid, y + bh / 2, r(32), '#ffffff', true, 'center');
      this.buttons.push({ id: b.id, x: bx, y: y, w: bw, h: bh });
      y += bh + r(20);
    }

    this._text('不用了', mid, y + r(40), r(28), '#8a8fa8', false, 'center');
    this.buttons.push({ id: 'sheet-cancel', x: bx, y: y, w: bw, h: r(80) });
  }

  /* ---------------- 结算 ---------------- */

  _result(st) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, u = this.u;
    const r = function (n) { return n * u; };
    const res = st.result;
    const death = !!st.dark; // 深色关卡（第二关、今日挑战）用深色样式

    ctx.fillStyle = death ? 'rgba(20,0,4,0.62)' : 'rgba(30,30,70,0.38)';
    ctx.fillRect(0, 0, W, H);

    const cw = Math.min(W - r(96), r(654));
    const cx = (W - cw) / 2;
    const pad = r(48);
    const mid = W / 2;
    const descLines = this._wrap(res.desc, cw - pad * 2, r(28));
    const hasSecond = !!res.secondary;
    const hasRevive = !!res.revive;

    const ch = r(56) + r(112) + r(12) + r(64) + r(14) + descLines.length * r(42) + r(40) +
      r(104) + r(40) + (hasRevive ? r(96) + r(20) : 0) + r(96) + (hasSecond ? r(20) + r(96) : 0) + r(12) + r(80) + r(28);
    let y = Math.max(r(40), (H - ch) / 2);

    this._shadow('rgba(0,0,0,0.28)', r(60), r(24));
    ctx.fillStyle = death ? '#1c0a0e' : 'rgba(255,255,255,0.96)';
    roundRect(ctx, cx, y, cw, ch, r(40));
    ctx.fill();
    this._noShadow();

    const cTitle = death ? '#ffe9eb' : '#2a2d43';
    const cDesc = death ? '#d9b8bc' : '#5d627a';
    const cSub = '#8a8fa8';

    y += r(56);
    this._text(res.emoji, mid, y + r(58), r(92), '#000000', false, 'center');
    y += r(112) + r(12);
    this._text(res.title, mid, y + r(32), r(48), cTitle, true, 'center');
    y += r(64) + r(14);
    for (let i = 0; i < descLines.length; i++) {
      this._text(descLines[i], mid, y + r(21), r(28), cDesc, false, 'center');
      y += r(42);
    }
    y += r(40);

    // 三项统计：层数 / 完美 / 最高连击
    const stats = [
      { num: String(res.layers), sub: '/' + res.target, label: '层数' },
      { num: String(res.perfects), sub: '', label: '完美' },
      { num: String(res.maxCombo), sub: '', label: '最高连击' }
    ];
    const colW = (cw - pad * 2) / 3;
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      const sx = cx + pad + colW * (i + 0.5);
      this._font(r(52), true);
      const nw = ctx.measureText(s.num).width;
      this._font(r(26), true);
      const sw = s.sub ? ctx.measureText(s.sub).width : 0;
      const x0 = sx - (nw + sw) / 2;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      this._font(r(52), true);
      ctx.fillStyle = cTitle;
      ctx.fillText(s.num, x0, y + r(54));
      if (s.sub) {
        this._font(r(26), true);
        ctx.fillStyle = cSub;
        ctx.fillText(s.sub, x0 + nw, y + r(54));
      }
      this._text(s.label, sx, y + r(86), r(24), cSub, false, 'center');
    }
    y += r(104) + r(40);

    const bx = cx + pad, bw = cw - pad * 2, bh = r(96);

    // 加一条命（只有失败、且这一局还没用过时才出现），放在最上面
    if (hasRevive) {
      const g2 = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g2.addColorStop(0, '#ffd166');
      g2.addColorStop(1, '#ffab2e');
      ctx.fillStyle = g2;
      roundRect(ctx, bx, y, bw, bh, bh / 2);
      ctx.fill();
      this._text(res.revive, mid, y + bh / 2, r(32), '#3a2300', true, 'center');
      this.buttons.push({ id: 'revive', x: bx, y: y, w: bw, h: bh });
      y += bh + r(20);
    }

    // 主按钮
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, death ? '#e5253b' : '#6a8dff');
    grad.addColorStop(1, death ? '#ff7a3d' : '#a56bff');
    ctx.fillStyle = grad;
    roundRect(ctx, bx, y, bw, bh, bh / 2);
    ctx.fill();
    this._text(res.primary, mid, y + bh / 2, r(32), '#ffffff', true, 'center');
    this.buttons.push({ id: 'primary', x: bx, y: y, w: bw, h: bh });
    y += bh;

    // 次按钮
    if (hasSecond) {
      y += r(20);
      ctx.fillStyle = death ? 'rgba(255,255,255,0.1)' : '#eef0ff';
      roundRect(ctx, bx, y, bw, bh, bh / 2);
      ctx.fill();
      this._text(res.secondary, mid, y + bh / 2, r(32), death ? '#ffb3b3' : '#5a6bd8', true, 'center');
      this.buttons.push({ id: 'secondary', x: bx, y: y, w: bw, h: bh });
      y += bh;
    }

    // 返回主页
    y += r(12);
    this._text('返回主页', mid, y + r(40), r(28), cSub, false, 'center');
    this.buttons.push({ id: 'menu', x: bx, y: y, w: bw, h: r(80) });

    this._soundKey(st);
  }
}

module.exports = { GameUI: GameUI };

};
defs["main"] = function (module, exports, require) {
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

};
var cache = {};
function load(name) {
  if (!cache[name]) {
    if (!defs[name]) throw new Error('找不到模块 ' + name);
    var m = { exports: {} };
    cache[name] = m;
    defs[name](m, m.exports, function (p) { return load(p.replace(/^.*\//, '').replace(/\.js$/, '')); });
  }
  return cache[name].exports;
}
load('main');
})();
