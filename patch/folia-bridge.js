/*!
 * Folia iOS 独立版 · 桥接层
 * ---------------------------------------------------------------
 * 依赖 mr-standalone.js 暴露的 window.__MR_BRIDGE__（原生 HTTP / Cookie / 加密工具）。
 * 作用：把 Folia 界面（Web 版）发出的 API 请求在应用内实现：
 *   /neapi/*  → 网易云（按 NeteaseCloudMusicApi 的响应格式）
 *   （后续：/kgapi/* 酷狗、/qqapi/* QQ）
 * 另含移动端省电优化：DPR 上限、默认帧率、后台暂停渲染。
 */
(function () {
  'use strict';

  var B = window.__MR_BRIDGE__;
  if (!B) {
    console.warn('[Folia] bridge infra missing (mr-standalone.js 未加载)');
    return;
  }

  var NE = 'https://music.163.com';
  var UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  var NE_HEADERS = { 'Referer': NE + '/', 'User-Agent': UA_MOBILE, 'Accept': 'application/json, text/plain, */*' };
  var httpsify = B.httpsify;

  function neGet(path, headers) {
    var h = {};
    Object.keys(NE_HEADERS).forEach(function (k) { h[k] = NE_HEADERS[k]; });
    if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    return B.nativeHttp(NE + path, { headers: h }).then(function (r) {
      try { return JSON.parse(r.text); } catch (e) { throw new Error('bad json: ' + String(r.text).slice(0, 80)); }
    });
  }
  function nePost(path, headers) {
    var h = {};
    Object.keys(NE_HEADERS).forEach(function (k) { h[k] = NE_HEADERS[k]; });
    if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    return B.nativeHttp(NE + path, { method: 'POST', headers: h, body: '' }).then(function (r) {
      try { return JSON.parse(r.text); } catch (e) { throw new Error('bad json: ' + String(r.text).slice(0, 80)); }
    });
  }

  // ================= 网易云原始接口 =================

  function levelToBr(level) {
    var l = String(level || '').toLowerCase();
    if (l === 'jymaster' || l === 'hires' || l === 'lossless') return 999000;
    if (l === 'exhigh') return 320000;
    if (l === 'higher') return 192000;
    return 128000;
  }
  function brToLevel(br) {
    if (br >= 900000) return 'lossless';
    if (br >= 320000) return 'exhigh';
    if (br >= 192000) return 'higher';
    return 'standard';
  }

  // 歌曲映射 → NeteaseCloudMusicApi 的 song 结构
  function mapNeSong(s) {
    s = s || {};
    var album = s.al || s.album || {};
    var artists = (s.ar || s.artists || []).map(function (a) {
      return { id: a && a.id, name: (a && a.name) || '' };
    });
    return {
      id: Number(s.id),
      name: s.name || '',
      ar: artists,
      artists: artists,
      al: {
        id: album.id || 0,
        name: album.name || '',
        picUrl: httpsify(album.picUrl || ''),
        pic: 0
      },
      album: {
        id: album.id || 0,
        name: album.name || '',
        picUrl: httpsify(album.picUrl || '')
      },
      dt: Number(s.duration || s.dt || 0),
      duration: Number(s.duration || s.dt || 0),
      alia: s.alias || s.alia || [],
      fee: Number(s.fee || 0),
      privilege: {
        id: Number(s.id),
        fee: Number(s.fee || 0),
        st: s.fee === 1 ? 0 : 0,
        pl: 320000,
        dl: 999000,
        sp: 7,
        cp: 1,
        subp: 1,
        flag: 0
      },
      t: 0
    };
  }

  function neSearchRaw(kw, limit, offset) {
    return neGet('/api/search/get/web?s=' + encodeURIComponent(kw) + '&type=1&limit=' + limit + '&offset=' + offset)
      .then(function (d) { return (d.result && d.result.songs) || []; });
  }

  function neSongUrlRaw(id, br) {
    return neGet('/api/song/enhance/player/url?ids=%5B' + encodeURIComponent(id) + '%5D&br=' + br)
      .then(function (d) { return (d.data || [])[0] || {}; });
  }

  function neLyricRaw(id) {
    return neGet('/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&kv=-1&tv=-1&rv=-1');
  }

  function neQrKey() {
    return nePost('/api/login/qrcode/unikey?type=1').then(function (d) {
      if (!d.unikey) throw new Error('unikey failed');
      return d.unikey;
    });
  }
  function neQrCheck(key) {
    return nePost('/api/login/qrcode/client/login?type=1&key=' + encodeURIComponent(key));
  }
  function neAccount() {
    return neGet('/api/nuser/account/get');
  }

  // ================= /neapi/* 路由（NeteaseCloudMusicApi 格式） =================

  var ORIGIN = 'https://music.163.com/';

  var NE_ROUTES = {

    '/neapi/register/anonimous': function () {
      return Promise.resolve({
        code: 200,
        cookie: 'MUSIC_A=' + Date.now().toString(36) + '; os=ios; appver=9.0.0',
        message: 'ok (standalone bridge)'
      });
    },

    '/neapi/cloudsearch': function (p) {
      var kw = p.get('keywords') || p.get('s') || '';
      var limit = Math.max(1, Math.min(100, parseInt(p.get('limit') || '30', 10) || 30));
      var offset = Math.max(0, parseInt(p.get('offset') || '0', 10) || 0);
      if (!kw) return Promise.resolve({ code: 200, result: { songs: [], songCount: 0 } });
      return neSearchRaw(kw, limit, offset).then(function (raw) {
        var songs = raw.map(mapNeSong);
        return { code: 200, result: { songs: songs, songCount: songs.length, hasMore: songs.length >= limit } };
      });
    },

    '/neapi/search': function (p) {
      return NE_ROUTES['/neapi/cloudsearch'](p);
    },

    '/neapi/song/url/v1': function (p) {
      var id = p.get('id') || '';
      var level = p.get('level') || 'exhigh';
      if (!id) return Promise.resolve({ code: 400, data: [] });
      return neSongUrlRaw(id, levelToBr(level)).then(function (item) {
        var url = httpsify(item.url || '');
        return {
          code: 200,
          data: [{
            id: Number(id),
            url: url,
            br: item.br || levelToBr(level),
            size: item.size || 0,
            md5: item.md5 || '',
            code: item.code === undefined ? (url ? 200 : 404) : item.code,
            type: (item.type || 'mp3'),
            level: brToLevel(item.br || levelToBr(level)),
            encodeType: (item.type || 'mp3'),
            fee: item.fee === undefined ? 0 : item.fee,
            time: item.time || 0,
            freeTrialInfo: item.freeTrialInfo || null
          }]
        };
      });
    },

    '/neapi/song/url': function (p) {
      return NE_ROUTES['/neapi/song/url/v1'](p);
    },

    '/neapi/song/detail': function (p) {
      var ids = String(p.get('ids') || p.get('id') || '').replace(/[\[\]]/g, '');
      return neGet('/api/song/detail?ids=%5B' + encodeURIComponent(ids) + '%5D').then(function (d) {
        var songs = (d.songs || []).map(mapNeSong);
        return { code: 200, songs: songs, privileges: songs.map(function (s) { return s.privilege; }) };
      });
    },

    '/neapi/lyric/new': function (p) {
      var id = p.get('id') || '';
      if (!id) return Promise.resolve({ code: 200, lrc: { lyric: '' }, tlyric: { lyric: '' }, yrc: { lyric: '' } });
      return neLyricRaw(id).then(function (d) {
        var lrc = (d.lrc && d.lrc.lyric) || '';
        var tl = (d.tlyric && d.tlyric.lyric) || '';
        return {
          code: 200,
          lrc: { version: 1, lyric: lrc },
          tlyric: { version: 1, lyric: tl },
          romalrc: { version: 1, lyric: (d.romalrc && d.romalrc.lyric) || '' },
          yrc: { version: 1, lyric: '' },
          ytlrc: { version: 1, lyric: '' },
          klyric: { version: 1, lyric: (d.klyric && d.klyric.lyric) || '' }
        };
      });
    },

    '/neapi/lyric': function (p) {
      return NE_ROUTES['/neapi/lyric/new'](p);
    },

    '/neapi/song/chorus': function () {
      return Promise.resolve({ code: 200, chorus: [] });
    },

    '/neapi/login/status': function () {
      return neAccount().then(function (d) {
        var profile = d.profile || null;
        if (!profile || !profile.userId) {
          return { code: 200, data: { code: 301, account: null, profile: null } };
        }
        return {
          code: 200,
          data: {
            code: 200,
            account: { id: profile.userId, userName: profile.nickname, status: 0, createTime: 0, vipType: profile.vipType || 0 },
            profile: {
              userId: profile.userId,
              nickname: profile.nickname,
              avatarUrl: httpsify(profile.avatarUrl || ''),
              backgroundUrl: httpsify(profile.backgroundUrl || ''),
              signature: profile.signature || '',
              vipType: profile.vipType || 0,
              followed: true
            }
          }
        };
      });
    },

    '/neapi/user/account': function () {
      return NE_ROUTES['/neapi/login/status']().then(function (r) {
        var d = r.data || {};
        return { code: 200, profile: d.profile || null, account: d.account || null };
      });
    },

    '/neapi/login/qr/key': function () {
      return neQrKey().then(function (key) {
        return { code: 200, data: { code: 200, unikey: key } };
      });
    },

    '/neapi/login/qr/create': function (p) {
      var key = p.get('key') || '';
      var content = NE + '/login?codekey=' + key;
      var img = '';
      try {
        if (typeof qrcode === 'function') {
          var qr = qrcode(0, 'M');
          qr.addData(content);
          qr.make();
          img = qr.createDataURL(6, 12);
        }
      } catch (e) { }
      return Promise.resolve({
        code: 200,
        data: { code: 200, qrurl: content, qrimg: img }
      });
    },

    '/neapi/login/qr/check': function (p) {
      var key = p.get('key') || '';
      return neQrCheck(key).then(function (d) {
        var out = { code: d.code, message: d.message || '' };
        if (d.code === 803) {
          out.code = 803;
          out.cookie = d.cookie || '';
          if (d.cookie) B.cookieStoreSet(d.cookie, '.music.163.com');
        }
        return out;
      });
    },

    '/neapi/logout': function () {
      return B.cookieStoreClear('music.163.com').then(function () {
        return { code: 200 };
      });
    },

    '/neapi/personalized': function (p) {
      var limit = Math.max(1, Math.min(50, parseInt(p.get('limit') || '12', 10) || 12));
      return neGet('/api/personalized/playlist?limit=' + limit).then(function (d) {
        return {
          code: 200,
          result: (d.result || []).map(function (x) {
            return {
              id: x.id, name: x.name, picUrl: httpsify(x.picUrl || ''),
              playCount: x.playCount || 0, trackCount: x.trackCount || 0,
              copywriter: x.copywriter || ''
            };
          })
        };
      });
    },

    // ---------- 安全空实现（保持界面可用） ----------
    '/neapi/user/playlist': function () { return Promise.resolve({ code: 200, playlist: [], more: false }); },
    '/neapi/playlist/detail': function (p) {
      var id = p.get('id') || '';
      return Promise.resolve({ code: 200, playlist: { id: Number(id) || 0, name: '', coverImgUrl: '', tracks: [], trackIds: [], trackCount: 0 } });
    },
    '/neapi/playlist/track/all': function () { return Promise.resolve({ code: 200, songs: [], privileges: [] }); },
    '/neapi/playlist/subscribe': function () { return Promise.resolve({ code: 200 }); },
    '/neapi/like': function () { return Promise.resolve({ code: 200 }); },
    '/neapi/likelist': function () { return Promise.resolve({ code: 200, ids: [] }); },
    '/neapi/personal_fm': function () { return Promise.resolve({ code: 200, data: [] }); },
    '/neapi/personal/fm/mode': function () { return Promise.resolve({ code: 200, data: [] }); },
    '/neapi/history/recommend/songs': function () { return Promise.resolve({ code: 200, data: { dailySongs: [] } }); },
    '/neapi/album/sublist': function () { return Promise.resolve({ code: 200, weekData: [], monthData: [] }); }
  };

  B.registerRoutes(NE_ROUTES);

  // ================= 性能档位：省电 / 均衡 / 极致 =================
  // 好设备自动拉满，弱设备自动省电，也可手动切换（切换后自动重载生效）。
  var PERF_KEY = 'folia_ios_perf_profile';
  var PROFILES = {
    eco: {
      label: '省电', dpr: 1.25, fps: '60',
      settings: {
        'visualizer_glow_blur_quantize': 'true',
        'disable_visualizer_vignette': 'true',
        'disable_visualizer_geometric_background': 'true'
      },
      desc: '低渲染分辨率 + 关暗角/几何背景，最省电'
    },
    balanced: {
      label: '均衡', dpr: 2, fps: '60',
      settings: {
        'visualizer_glow_blur_quantize': 'true',
        'disable_visualizer_vignette': '',
        'disable_visualizer_geometric_background': ''
      },
      desc: '2x 分辨率 + 60 帧（推荐）'
    },
    ultra: {
      label: '极致', dpr: 0, fps: '120',
      settings: {
        'visualizer_glow_blur_quantize': '',
        'disable_visualizer_vignette': '',
        'disable_visualizer_geometric_background': ''
      },
      desc: '满分辨率 + 120 帧 + 全部特效（发热耗电，好设备专享）'
    }
  };

  function detectProfile() {
    try {
      var saved = localStorage.getItem(PERF_KEY);
      if (saved && PROFILES[saved]) return saved;
    } catch (e) { }
    // 首次运行按设备能力自动选档
    var cores = navigator.hardwareConcurrency || 4;
    var dpr = window.devicePixelRatio || 2;
    var mem = navigator.deviceMemory || 0;
    if (cores >= 6 && dpr >= 3 && (mem === 0 || mem >= 4)) return 'ultra';
    if (cores <= 4 || dpr <= 2) return cores <= 4 ? 'eco' : 'balanced';
    return 'balanced';
  }

  var activeProfile = detectProfile();

  function applyDprCap() {
    var cap = PROFILES[activeProfile].dpr;
    if (!cap) return;                       // ultra：不限制
    try {
      var real = window.devicePixelRatio || 1;
      if (real > cap) {
        Object.defineProperty(window, 'devicePixelRatio', {
          configurable: true,
          get: function () { return cap; }
        });
        console.log('[Folia-iOS] 档位 ' + activeProfile + '：devicePixelRatio 限制为 ' + cap + '（原 ' + real + '）');
      }
    } catch (e) { }
  }

  function switchProfile(id, reloadNow) {
    if (!PROFILES[id]) return;
    activeProfile = id;
    try {
      localStorage.setItem(PERF_KEY, id);
      localStorage.setItem('visualizer_frame_rate', PROFILES[id].fps);
      var st = PROFILES[id].settings;
      Object.keys(st).forEach(function (k) {
        if (st[k] === '') localStorage.removeItem(k);
        else localStorage.setItem(k, st[k]);
      });
    } catch (e) { }
    if (reloadNow !== false) setTimeout(function () { location.reload(); }, 200);
  }

  // 首次运行写入推荐档位（不覆盖用户已保存的）
  try {
    if (localStorage.getItem(PERF_KEY) === null) {
      localStorage.setItem(PERF_KEY, activeProfile);
      localStorage.setItem('visualizer_frame_rate', PROFILES[activeProfile].fps);
      var initSt = PROFILES[activeProfile].settings;
      Object.keys(initSt).forEach(function (k) {
        if (initSt[k] !== '' && localStorage.getItem(k) === null) localStorage.setItem(k, initSt[k]);
      });
    }
  } catch (e) { }

  applyDprCap();

  // ---------- 性能档位小面板（左上角 ⚡） ----------
  function mountPerfPanel() {
    try {
      if (document.getElementById('folia-ios-perf')) return;
      var wrap = document.createElement('div');
      wrap.id = 'folia-ios-perf';
      wrap.setAttribute('data-profile', activeProfile);
      var buttons = Object.keys(PROFILES).map(function (k) {
        var p = PROFILES[k];
        return '<button type="button" class="fp-item' + (k === activeProfile ? ' fp-on' : '') + '" data-p="' + k + '">' +
          '<b>' + p.label + '</b><i>' + p.desc + '</i></button>';
      }).join('');
      wrap.innerHTML =
        '<style>' +
        '#folia-ios-perf{position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:calc(env(safe-area-inset-left,0px) + 8px);z-index:2147483000;font:12px/1.5 -apple-system,"PingFang SC",sans-serif;}' +
        '#folia-ios-perf .fp-btn{width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(20,20,24,.55);color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:.55;transition:opacity .2s;}' +
        '#folia-ios-perf .fp-btn:active{opacity:1;transform:scale(.94);}' +
        '#folia-ios-perf.fp-open .fp-btn{opacity:1;}' +
        '#folia-ios-perf .fp-panel{display:none;margin-top:8px;width:224px;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(16,16,20,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#eee;}' +
        '#folia-ios-perf.fp-open .fp-panel{display:block;}' +
        '#folia-ios-perf .fp-head{font-size:11px;color:#9aa;margin:0 2px 8px;}' +
        '#folia-ios-perf .fp-item{display:block;width:100%;text-align:left;padding:7px 9px;margin-bottom:6px;border-radius:9px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);color:#eee;}' +
        '#folia-ios-perf .fp-item.fp-on{border-color:rgba(120,200,255,.75);background:rgba(80,160,255,.16);}' +
        '#folia-ios-perf .fp-item b{font-size:12.5px;}' +
        '#folia-ios-perf .fp-item i{display:block;font-style:normal;font-size:10.5px;color:#9aa;margin-top:2px;}' +
        '#folia-ios-perf .fp-hide{width:100%;padding:6px;border-radius:9px;border:none;background:rgba(255,255,255,.06);color:#99a;font-size:11px;}' +
        '</style>' +
        '<button type="button" class="fp-btn" aria-label="性能档位">⚡</button>' +
        '<div class="fp-panel">' +
        '<div class="fp-head">性能档位（切换后自动重启界面）</div>' +
        buttons +
        '<button type="button" class="fp-hide">隐藏按钮（下次启动恢复）</button>' +
        '</div>';
      document.body.appendChild(wrap);

      wrap.querySelector('.fp-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        wrap.classList.toggle('fp-open');
      });
      wrap.querySelectorAll('.fp-item').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var p = btn.getAttribute('data-p');
          if (p === activeProfile) { wrap.classList.remove('fp-open'); return; }
          btn.querySelector('b').textContent = '切换中…';
          switchProfile(p, true);
        });
      });
      wrap.querySelector('.fp-hide').addEventListener('click', function (e) {
        e.stopPropagation();
        wrap.style.display = 'none';
      });
      document.addEventListener('click', function () { wrap.classList.remove('fp-open'); });
      console.log('[Folia-iOS] 性能档位面板已挂载，当前：' + PROFILES[activeProfile].label);
    } catch (e) { }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPerfPanel);
  } else {
    mountPerfPanel();
  }

  // ================= 移动端适配（触摸 / 安全区 / 惯性滚动） =================
  (function mobileShellTweaks() {
    try {
      var style = document.createElement('style');
      style.textContent =
        'html{-webkit-text-size-adjust:100%;}' +
        'body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent;}' +
        'body{-webkit-user-select:none;user-select:none;}' +
        'input,textarea{-webkit-user-select:text;user-select:text;}' +
        'canvas{touch-action:none;}';
      document.head.appendChild(style);
    } catch (e) { }
  })();

  console.log('[Folia] standalone bridge ready (neapi routes: ' + Object.keys(NE_ROUTES).length + ', profile: ' + activeProfile + ')');
})();
