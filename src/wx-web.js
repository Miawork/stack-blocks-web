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
