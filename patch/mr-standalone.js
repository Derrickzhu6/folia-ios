/*!
 * Mineradio iOS 独立版 · 本地桥接层
 * ---------------------------------------------------------------
 * 作用：没有 Node 后端的情况下，把 H5 发出的 /api/* 请求在应用内部实现：
 *   1. 通过原生插件（URLSession）直连网易云公开接口 —— 无 CORS、带 Cookie 会话
 *   2. 浏览器调试环境自动退化为普通 fetch（配合 --disable-web-security）
 *   3. 音频/封面直连 CDN（CDN 自带 CORS，可视化不受影响）
 *
 * 版权：逻辑参考 Mineradio-Android (GPL-3.0) 与 Mineradio 桌面版的服务端响应格式。
 */
(function () {
  'use strict';

  if (window.__MR_STANDALONE__) return;
  window.__MR_STANDALONE__ = true;

  // ---------- 资源直连（独立版无需本地代理） ----------
  window.MRAudioProxy = function (u) { return u ? String(u) : ''; };
  window.MRCoverProxy = function (u) { return u ? String(u) : ''; };

  // 登录面板的彩蛋门槛：独立版首次启动直接放行（口令「世界和平」等价）
  try { localStorage.setItem('mineradio-login-easter-egg-browser-preview-v1', '1'); } catch (e) { }

  // ---------- 基础 ----------
  var NE = 'https://music.163.com';
  var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  var BASE_HEADERS = {
    'Referer': NE + '/',
    'Origin': NE,
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };

  function httpsify(u) {
    if (!u) return '';
    return String(u).replace(/^http:\/\//i, 'https://');
  }

  function nativePlugin() {
    var cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.Mineradio) || null;
  }

  function cookiesPlugin() {
    var cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.CapacitorCookies) || null;
  }

  // 写入登录 Cookie：优先自定义原生插件（URLSession 会话），其次官方 CapacitorCookies
  function cookieStoreSet(cookieStr, domain) {
    domain = domain || '.music.163.com';
    var siteUrl = 'https://music.163.com';
    if (domain.indexOf('qq.com') >= 0) siteUrl = 'https://y.qq.com';
    else if (domain.indexOf('kugou.com') >= 0) siteUrl = 'https://www.kugou.com';
    // 同步写进 JS cookie jar：原生 cookie storage 的写入时机不可控，jar 才是请求真正带上的那份
    jarSet(siteUrl, cookieStr);
    var plugin = nativePlugin();
    if (plugin && typeof plugin.setCookies === 'function') {
      return plugin.setCookies({ cookie: cookieStr, domain: domain }).catch(function () { });
    }
    var cp = cookiesPlugin();
    if (!cp || typeof cp.setCookie !== 'function') return Promise.resolve();
    var tasks = [];
    String(cookieStr || '').split(';').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv.length < 2) return;
      var k = kv[0].trim();
      var v = kv.slice(1).join('=').trim();
      if (!k) return;
      tasks.push(cp.setCookie({ url: siteUrl, key: k, value: v }).catch(function () { }));
    });
    return Promise.all(tasks);
  }

  function cookieStoreClear(domain) {
    domain = domain || 'music.163.com';
    delete COOKIE_JAR[jarBaseHost(domain)];
    var plugin = nativePlugin();
    if (plugin && typeof plugin.clearCookies === 'function') {
      return plugin.clearCookies({ domain: domain }).catch(function () { });
    }
    var cp = cookiesPlugin();
    if (cp && typeof cp.clearAllCookies === 'function') {
      return cp.clearAllCookies().catch(function () { });
    }
    return Promise.resolve();
  }

  // 原生 HTTP（App 内）或普通 fetch（浏览器调试）
  // ---------- Cookie jar ----------
  // 扫码登录要靠连续的会话：unikey 的 Set-Cookie 必须被后面的 check 带上。
  // 系统 cookie storage 的同步不可靠，这里在 JS 侧自己维护一份，请求时显式带上。
  var COOKIE_JAR = {};

  // 统一按「基础域」归并：music.163.com / m.kugou.com / u.y.qq.com 各自域内的子域共享同一份 cookie。
  // 读写用同一个 key，避免出现「存进去了但读的是另一个域」的情况。
  function jarBaseHost(name) {
    var h = String(name || '').replace(/^\./, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    var parts = h.split('.');
    if (parts.length <= 2) return h;
    var last2 = parts.slice(-2).join('.');
    // com.cn / co.jp 这类双后缀要多留一级
    if (/^(com|co|org|net|gov|edu|ac)\.(cn|jp|uk|au|hk|tw|kr)$/.test(last2) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return last2;
  }

  function jarHostOf(url) {
    try { return jarBaseHost(new URL(url).hostname); } catch (e) { return ''; }
  }

  function jarMerge(host, cookieStr) {
    if (!host || !cookieStr) return;
    var jar = COOKIE_JAR[host] || {};
    String(cookieStr).split(/;\s*|\s*,\s*(?=[A-Za-z0-9_\-]+=)/).forEach(function (seg) {
      var i = seg.indexOf('=');
      if (i <= 0) return;
      var k = seg.slice(0, i).trim();
      var v = seg.slice(i + 1).trim();
      if (!k) return;
      // 跳过 cookie 属性段（expires / path / domain / secure / httponly ...）
      if (/^(expires|path|domain|secure|httponly|max-age|samesite|version|priority)$/i.test(k)) return;
      if (v === '' || /^(EXPIRED|deleted)$/i.test(v)) delete jar[k];
      else jar[k] = v;
    });
    COOKIE_JAR[host] = jar;
  }

  function jarGet(url) {
    var jar = COOKIE_JAR[jarHostOf(url)];
    if (!jar) return '';
    return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
  }

  function jarSet(url, cookieStr) {
    jarMerge(jarHostOf(url), cookieStr);
  }

  function nativeHttp(url, opts) {
    opts = opts || {};
    var plugin = nativePlugin();
    // 必须复制一份：直接改 BASE_HEADERS 会把某个站点的 cookie 污染给后续所有请求
    var headers = {};
    var srcHeaders = opts.headers || BASE_HEADERS;
    for (var hk in srcHeaders) headers[hk] = srcHeaders[hk];
    // 带上自己维护的会话 cookie（与 cookieStoreSet 写入的共用一份）
    var jarCookie = jarGet(url);
    if (jarCookie) headers['Cookie'] = jarCookie;
    if (plugin && typeof plugin.httpRequest === 'function') {
      return plugin.httpRequest({
        url: url,
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body || null,
        binary: !!opts.binary
      }).then(function (res) {
        // 回传的 cookies 并入 jar，保证下一次请求带上同一个会话
        if (res && res.cookies) jarSet(url, res.cookies);
        return {
          status: (res && res.status) || 0,
          text: (res && res.body) || '',
          headers: (res && res.headers) || {},
          base64: (res && res.bodyBase64) || ''
        };
      });
    }
    var init = { method: opts.method || 'GET', headers: headers, credentials: 'omit' };
    if (opts.body && init.method !== 'GET') init.body = opts.body;
    return fetch(url, init).then(function (r) {
      var hdrs = {};
      try { r.headers && r.headers.forEach(function (v, k) { hdrs[k] = v; }); } catch (e) { }
      if (opts.binary && typeof r.arrayBuffer === 'function') {
        return r.arrayBuffer().then(function (ab) {
          var bytes = new Uint8Array(ab);
          var s = '';
          for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
          var b64 = '';
          try { b64 = btoa(s); } catch (e) { }
          return { status: r.status, text: '', headers: hdrs, base64: b64 };
        });
      }
      return r.text().then(function (t) {
        return { status: r.status, text: t, headers: hdrs, base64: '' };
      });
    });
  }

  function httpJson(url, opts) {
    return nativeHttp(url, opts).then(function (r) {
      if (!r.text) throw new Error('empty response (' + r.status + ')');
      try { return JSON.parse(r.text); } catch (e) { throw new Error('bad json: ' + String(r.text).slice(0, 80)); }
    });
  }

  function neGet(path) { return httpJson(NE + path); }
  function nePost(path) { return httpJson(NE + path, { method: 'POST', body: '' }); }

  // ---------- 数据映射（与桌面/安卓版服务端输出字段保持一致） ----------
  function mapSong(s) {
    s = s || {};
    var artists = (s.artists || s.ar || []).map(function (a) { return { id: a && a.id, name: (a && a.name) || '' }; });
    var album = s.album || s.al || {};
    var cover = album.picUrl || album.coverUrl || (album.artist && album.artist.picUrl) || '';
    return {
      provider: 'netease',
      source: 'netease',
      type: 'song',
      id: s.id,
      name: s.name || '',
      artist: artists.map(function (a) { return a.name; }).join(' / '),
      artists: artists,
      artistId: artists[0] && artists[0].id,
      album: album.name || '',
      albumId: album.id || '',
      cover: httpsify(cover),
      duration: s.duration || s.dt || 0,
      popularity: Number(s.pop || s.popularity || s.score || s.hotScore) || 100,
      searchRank: null,
      fee: (s.fee === undefined || s.fee === null) ? 0 : s.fee
    };
  }

  function qualityToBr(q) {
    if (q === 'jymaster' || q === 'hires') return 999000;
    if (q === 'lossless') return 999000;
    if (q === 'exhigh') return 320000;
    if (q === 'higher') return 192000;
    return 128000;
  }
  function brToLevel(br) {
    if (br >= 900000) return 'lossless';
    if (br >= 320000) return 'exhigh';
    if (br >= 192000) return 'higher';
    return 'standard';
  }

  // ================================================================
  //  QQ 音乐（公开接口 + 官方签名算法，参考 Mineradio/Mineradio-Android 实现）
  // ================================================================

  var QQ_UA = 'QQMusic 14090508(android 12)';
  var QQ_HEADERS = { 'Referer': 'https://y.qq.com/', 'User-Agent': QQ_UA, 'Content-Type': 'application/json;charset=UTF-8' };
  var QQ_COMM = {
    ct: '11', cv: '14090508', v: '14090508', tmeAppID: 'qqmusic', phonetype: 'EBG-AN10', os_ver: '12',
    OpenUDID: '0', QIMEI36: '0', udid: '0', chid: '0', aid: '0', oaid: '0', taid: '0', tid: '0', wid: '0',
    uid: '0', sid: '0', modeSwitch: '6', teenMode: '0', ui_mode: '2', nettype: '1020'
  };
  var QQ_QUALITY_FILES = [
    { prefix: 'M800', ext: '.mp3', level: 'exhigh' },
    { prefix: 'M500', ext: '.mp3', level: 'standard' },
    { prefix: 'C400', ext: '.m4a', level: 'aac' },
    { prefix: 'F000', ext: '.flac', level: 'lossless' }
  ];

  var qqState = { uin: '', key: '' };

  function qqStateFromCookie(cookie) {
    var st = { uin: '', key: '' };
    String(cookie || '').split(';').forEach(function (pair) {
      var kv = pair.split('=');
      var k = (kv[0] || '').trim();
      var v = kv.slice(1).join('=').trim();
      if (k === 'uin' || k === 'qqmusic_uin') st.uin = v.replace(/^o0*/, '').replace(/\D/g, '') || v;
      if (k === 'qqmusic_key' || k === 'qm_keyst') st.key = v;
    });
    return st;
  }

  // ---- SHA-1（纯 JS，避免依赖 crypto.subtle 的安全上下文限制） ----
  function sha1Hex(str) {
    function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
    var utf8 = unescape(encodeURIComponent(str));
    var bytes = [];
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 255);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Array(80);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var i2 = 0; i2 < 16; i2++) {
        w[i2] = (bytes[off + i2 * 4] << 24) | (bytes[off + i2 * 4 + 1] << 16) | (bytes[off + i2 * 4 + 2] << 8) | bytes[off + i2 * 4 + 3];
      }
      for (var i3 = 16; i3 < 80; i3++) w[i3] = rotl(w[i3 - 3] ^ w[i3 - 8] ^ w[i3 - 14] ^ w[i3 - 16], 1);
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (var i4 = 0; i4 < 80; i4++) {
        var f, k;
        if (i4 < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (i4 < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i4 < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var tmp = (rotl(a, 5) + f + e + k + w[i4]) >>> 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    function hex(n) { var s = (n >>> 0).toString(16); while (s.length < 8) s = '0' + s; return s; }
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
  }

  // ---- QQ 官方签名（与 Mineradio 服务端 qqSearchSign 等价） ----
  function qqSign(text) {
    var h = sha1Hex(text);
    function ch(i) { return (i >= 0 && i < h.length) ? h.charAt(i) : ''; }
    var part1 = [23, 14, 6, 36, 16, 40, 7, 19].map(ch).join('');
    var part2 = [16, 1, 32, 12, 19, 27, 8, 5].map(ch).join('');
    var scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
    var bins = '';
    for (var i = 0; i < scramble.length; i++) {
      bins += String.fromCharCode(scramble[i] ^ parseInt(h.substr(i * 2, 2), 16));
    }
    var middle = '';
    try { middle = btoa(bins).replace(/[\/+=]/g, ''); } catch (e) { middle = ''; }
    return ('zzc' + part1 + middle + part2).toLowerCase();
  }

  function qqPostJson(url, payload) {
    var bodyText = JSON.stringify(payload);
    var headers = {};
    for (var k in QQ_HEADERS) headers[k] = QQ_HEADERS[k];
    headers['Content-Length'] = String(bodyText.length);
    return nativeHttp(url, { method: 'POST', headers: headers, body: bodyText })
      .then(function (r) { return JSON.parse(r.text); });
  }

  function qqCover(albumMid, size) {
    if (!albumMid) return '';
    var px = size || 300;
    return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
  }

  function mapQQTrack(track) {
    track = track || {};
    var album = track.album || {};
    var artists = (track.singer || []).map(function (a) {
      return { id: a && a.id, mid: a && a.mid, name: (a && a.name) || '' };
    }).filter(function (a) { return a.name; });
    var mid = track.mid || '';
    var albumMid = album.mid || album.pmid || '';
    return {
      provider: 'qq', source: 'qq', type: 'qq',
      id: mid, qqId: track.id || '', mid: mid, songmid: mid,
      mediaMid: (track.file && track.file.media_mid) || '',
      name: track.name || track.title || '',
      artist: artists.map(function (a) { return a.name; }).join(' / '),
      artists: artists,
      artistId: artists[0] && artists[0].id,
      artistMid: artists[0] && artists[0].mid,
      album: album.name || album.title || '',
      albumMid: albumMid,
      cover: qqCover(albumMid, 300),
      duration: (Number(track.interval) || 0) * 1000,
      popularity: 60,
      fee: (track.pay && Number(track.pay.pay_play)) ? 1 : 0,
      playable: false
    };
  }

  function qqSearchSongs(kw, limit, offset) {
    var pageNumber = Math.floor(offset / limit) + 1;
    var payload = {
      comm: QQ_COMM,
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicMobile',
        param: {
          search_type: 0,
          searchid: String(Date.now()) + String(Math.random()).slice(2, 8),
          query: kw, page_num: pageNumber, num_per_page: limit,
          highlight: 0, nqc_flag: 0, multi_zhida: 0, cat: 2, grp: 1, sin: offset, sem: 0
        }
      }
    };
    var bodyText = JSON.stringify(payload);
    var url = 'https://u.y.qq.com/cgi-bin/musics.fcg?sign=' + qqSign(bodyText);
    var headers = {};
    for (var k in QQ_HEADERS) headers[k] = QQ_HEADERS[k];
    headers['Content-Length'] = String(bodyText.length);
    return nativeHttp(url, { method: 'POST', headers: headers, body: bodyText }).then(function (r) {
      var d = JSON.parse(r.text);
      var data = (d.req && d.req.data) || {};
      var b = data.body || data;
      var items = b.item_song || (b.song && b.song.list) || b.list || [];
      return items.map(function (it) {
        return mapQQTrack(it.track_info || it.songInfo || it.song || it);
      }).filter(function (s) { return s.name && s.mid; });
    });
  }

  // vkey 的 filename 必须用 file.media_mid 拼（用歌曲 mid 一律返回 104003）
  function qqMediaMid(mid) {
    if (!mid) return Promise.resolve({ mediaMid: '' });
    var u = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' +
      encodeURIComponent(mid) + '&platform=yqq&format=json';
    return nativeHttp(u, { headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': QQ_UA } })
      .then(function (r) {
        var d = JSON.parse(r.text || '{}');
        var s = (d.data && d.data[0]) || {};
        var f = s.file || {};
        return {
          mediaMid: f.media_mid || '', id: s.id || 0, name: s.title || '',
          payPlay: (s.pay && s.pay.pay_play) || 0
        };
      })
      .catch(function () { return { mediaMid: '' }; });
  }

  // 自动解析 media_mid 后再取播放地址（VIP 曲目会得到 104003，属正常）
  function qqSongUrlAuto(mid) {
    return qqMediaMid(mid).then(function (info) {
      return qqSongUrl(mid, info.mediaMid).then(function (r) {
        r.mediaMid = info.mediaMid;
        r.songId = info.id;
        r.payPlay = info.payPlay;
        return r;
      });
    });
  }

  function qqSongUrl(mid, mediaMid) {
    var guid = String(10000000 + Math.floor(Math.random() * 90000000));
    var filenames = [];
    [mediaMid, mid].forEach(function (m) {
      if (!m) return;
      QQ_QUALITY_FILES.forEach(function (q) { filenames.push(q.prefix + m + q.ext); });
    });
    if (!filenames.length) return Promise.resolve({ url: '' });
    var uin = qqState.uin || '0';
    var comm = { uin: uin, format: 'json', ct: qqState.key ? 19 : 24, cv: 0 };
    if (qqState.key) comm.authst = qqState.key;
    var payload = {
      comm: comm,
      req_0: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: {
          guid: guid, songmid: filenames.map(function () { return mid; }),
          songtype: filenames.map(function () { return 0; }),
          uin: uin, loginflag: 1, platform: '20', filename: filenames
        }
      }
    };
    return qqPostJson('https://u.y.qq.com/cgi-bin/musicu.fcg', payload).then(function (d) {
      var r0 = (d.req_0 && d.req_0.data) || {};
      var sip = (r0.sip && r0.sip.length) ? r0.sip[0] : 'https://ws.stream.qqmusic.qq.com/';
      var infos = r0.midurlinfo || [];
      var lastCode = 0;
      for (var i = 0; i < infos.length; i++) {
        var info = infos[i];
        if (info && info.purl) {
          var level = 'standard';
          var fn = String(info.filename || '');
          for (var j = 0; j < QQ_QUALITY_FILES.length; j++) {
            if (fn.indexOf(QQ_QUALITY_FILES[j].prefix) === 0) { level = QQ_QUALITY_FILES[j].level; break; }
          }
          return { url: sip + info.purl, level: level, filename: fn };
        }
        lastCode = (info && info.result) || lastCode;
      }
      return { url: '', result: lastCode };
    });
  }

  // ================================================================
  //  酷狗音乐（搜索/歌词用公开接口；播放走移动端点，key = md5(hash + "kgcloud")）
  // ================================================================

  var KG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  var KG_HEADERS = { 'Referer': 'https://www.kugou.com/', 'User-Agent': KG_UA };
  var kgState = { mid: '', dfid: '-', userid: '', token: '' };

  // ---- MD5（纯 JS，供酷狗 key / mid 使用） ----
  function md5Hex(input) {
    var utf8 = unescape(encodeURIComponent(String(input)));
    var bytes = [];
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 255);
    var words = [];
    for (var j = 0; j < bytes.length; j++) {
      words[j >> 2] = (words[j >> 2] || 0) | (bytes[j] << ((j % 4) * 8));
    }
    var bitLen = bytes.length * 8;
    words[bitLen >> 5] = (words[bitLen >> 5] || 0) | (0x80 << (bitLen % 32));
    words[(((bitLen + 64) >>> 9) << 4) + 14] = bitLen;

    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) {
      var l = (x & 0xFFFF) + (y & 0xFFFF);
      var m = (x >> 16) + (y >> 16) + (l >> 16);
      return (m << 16) | (l & 0xFFFF);
    }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var k = 0; k < words.length; k += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, words[k] || 0, 7, -680876936); d = ff(d, a, b, c, words[k + 1] || 0, 12, -389564586);
      c = ff(c, d, a, b, words[k + 2] || 0, 17, 606105819); b = ff(b, c, d, a, words[k + 3] || 0, 22, -1044525330);
      a = ff(a, b, c, d, words[k + 4] || 0, 7, -176418897); d = ff(d, a, b, c, words[k + 5] || 0, 12, 1200080426);
      c = ff(c, d, a, b, words[k + 6] || 0, 17, -1473231341); b = ff(b, c, d, a, words[k + 7] || 0, 22, -45705983);
      a = ff(a, b, c, d, words[k + 8] || 0, 7, 1770035416); d = ff(d, a, b, c, words[k + 9] || 0, 12, -1958414417);
      c = ff(c, d, a, b, words[k + 10] || 0, 17, -42063); b = ff(b, c, d, a, words[k + 11] || 0, 22, -1990404162);
      a = ff(a, b, c, d, words[k + 12] || 0, 7, 1804603682); d = ff(d, a, b, c, words[k + 13] || 0, 12, -40341101);
      c = ff(c, d, a, b, words[k + 14] || 0, 17, -1502002290); b = ff(b, c, d, a, words[k + 15] || 0, 22, 1236535329);
      a = gg(a, b, c, d, words[k + 1] || 0, 5, -165796510); d = gg(d, a, b, c, words[k + 6] || 0, 9, -1069501632);
      c = gg(c, d, a, b, words[k + 11] || 0, 14, 643717713); b = gg(b, c, d, a, words[k] || 0, 20, -373897302);
      a = gg(a, b, c, d, words[k + 5] || 0, 5, -701558691); d = gg(d, a, b, c, words[k + 10] || 0, 9, 38016083);
      c = gg(c, d, a, b, words[k + 15] || 0, 14, -660478335); b = gg(b, c, d, a, words[k + 4] || 0, 20, -405537848);
      a = gg(a, b, c, d, words[k + 9] || 0, 5, 568446438); d = gg(d, a, b, c, words[k + 14] || 0, 9, -1019803690);
      c = gg(c, d, a, b, words[k + 3] || 0, 14, -187363961); b = gg(b, c, d, a, words[k + 8] || 0, 20, 1163531501);
      a = gg(a, b, c, d, words[k + 13] || 0, 5, -1444681467); d = gg(d, a, b, c, words[k + 2] || 0, 9, -51403784);
      c = gg(c, d, a, b, words[k + 7] || 0, 14, 1735328473); b = gg(b, c, d, a, words[k + 12] || 0, 20, -1926607734);
      a = hh(a, b, c, d, words[k + 5] || 0, 4, -378558); d = hh(d, a, b, c, words[k + 8] || 0, 11, -2022574463);
      c = hh(c, d, a, b, words[k + 11] || 0, 16, 1839030562); b = hh(b, c, d, a, words[k + 14] || 0, 23, -35309556);
      a = hh(a, b, c, d, words[k + 1] || 0, 4, -1530992060); d = hh(d, a, b, c, words[k + 4] || 0, 11, 1272893353);
      c = hh(c, d, a, b, words[k + 7] || 0, 16, -155497632); b = hh(b, c, d, a, words[k + 10] || 0, 23, -1094730640);
      a = hh(a, b, c, d, words[k + 13] || 0, 4, 681279174); d = hh(d, a, b, c, words[k] || 0, 11, -358537222);
      c = hh(c, d, a, b, words[k + 3] || 0, 16, -722521979); b = hh(b, c, d, a, words[k + 6] || 0, 23, 76029189);
      a = hh(a, b, c, d, words[k + 9] || 0, 4, -640364487); d = hh(d, a, b, c, words[k + 12] || 0, 11, -421815835);
      c = hh(c, d, a, b, words[k + 15] || 0, 16, 530742520); b = hh(b, c, d, a, words[k + 2] || 0, 23, -995338651);
      a = ii(a, b, c, d, words[k] || 0, 6, -198630844); d = ii(d, a, b, c, words[k + 7] || 0, 10, 1126891415);
      c = ii(c, d, a, b, words[k + 14] || 0, 15, -1416354905); b = ii(b, c, d, a, words[k + 5] || 0, 21, -57434055);
      a = ii(a, b, c, d, words[k + 12] || 0, 6, 1700485571); d = ii(d, a, b, c, words[k + 3] || 0, 10, -1894986606);
      c = ii(c, d, a, b, words[k + 10] || 0, 15, -1051523); b = ii(b, c, d, a, words[k + 1] || 0, 21, -2054922799);
      a = ii(a, b, c, d, words[k + 8] || 0, 6, 1873313359); d = ii(d, a, b, c, words[k + 15] || 0, 10, -30611744);
      c = ii(c, d, a, b, words[k + 6] || 0, 15, -1560198380); b = ii(b, c, d, a, words[k + 13] || 0, 21, 1309151649);
      a = ii(a, b, c, d, words[k + 4] || 0, 6, -145523070); d = ii(d, a, b, c, words[k + 11] || 0, 10, -1120210379);
      c = ii(c, d, a, b, words[k + 2] || 0, 15, 718787259); b = ii(b, c, d, a, words[k + 9] || 0, 21, -343485551);
      a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
    }
    function hex(n) {
      var s = '';
      for (var i = 0; i < 4; i++) s += ('0' + ((n >> (i * 8)) & 255).toString(16)).slice(-2);
      return s;
    }
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  function kugouCloudKey(hash) { return md5Hex(String(hash || '') + 'kgcloud'); }

  function kgMid() {
    if (!kgState.mid) kgState.mid = md5Hex(String(Date.now()) + String(Math.random()));
    return kgState.mid;
  }

  function kgCookie() {
    return 'kg_mid=' + kgMid() + '; kg_dfid=' + (kgState.dfid || '-');
  }

  function kugouCover(raw, size) {
    var u = String(raw || '').trim();
    if (!u) return '';
    return u.replace(/\{size\}/g, String(size || 240));
  }

  function stripKgHtml(text) {
    return String(text || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }

  function mapKugouArtists(item) {
    item = item || {};
    if (Array.isArray(item.Singers)) {
      return item.Singers.map(function (s) {
        s = s || {};
        return { id: s.id, name: stripKgHtml(s.name || s.SingerName || '') };
      }).filter(function (a) { return a.name; });
    }
    var names = String(item.SingerName || '').split(/、|\/|,| feat\.? /i).map(stripKgHtml).filter(Boolean);
    var ids = Array.isArray(item.SingerId) ? item.SingerId : [];
    return names.map(function (name, i) { return { id: ids[i] || '', name: name }; });
  }

  function mapKugouTrack(item) {
    item = item || {};
    var artists = mapKugouArtists(item);
    var hash = item.FileHash || item.hash || '';
    var albumId = item.AlbumID != null ? String(item.AlbumID) : '';
    var mixSongId = item.MixSongID != null ? String(item.MixSongID) : '';
    var albumAudioId = /^\d+$/.test(mixSongId) ? mixSongId : String(item.EMixSongID || item.AlbumAudioID || item.album_audio_id || mixSongId || '');
    return {
      provider: 'kugou', source: 'kugou', type: 'kugou',
      id: hash || mixSongId || albumAudioId,
      hash: hash, fileHash: hash,
      albumId: albumId, album_id: albumId,
      mixSongId: mixSongId, albumAudioId: albumAudioId, album_audio_id: albumAudioId,
      audioId: item.Audioid || item.Scid || '',
      hqHash: item.HQFileHash || '',
      sqHash: item.SQFileHash || '',
      resHash: item.ResFileHash || '',
      name: stripKgHtml(item.SongName || item.FileName || item.OriSongName || ''),
      artist: artists.map(function (a) { return a.name; }).join(' / ') || stripKgHtml(item.SingerName || ''),
      artists: artists,
      artistId: artists[0] && artists[0].id,
      album: stripKgHtml(item.AlbumName || ''),
      cover: kugouCover(item.Image || item.AlbumImage || '', 240),
      duration: (Number(item.Duration) || 0) * 1000,
      popularity: Number(item.HeatLevel) || 60,
      fee: (Number(item.Privilege) || 0) >= 8 ? 1 : 0,
      privilege: Number(item.Privilege) || 0,
      playable: false
    };
  }

  function kugouSearchRaw(kw, limit, offset) {
    var page = Math.floor(offset / limit) + 1;
    var url = 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(kw) +
      '&page=' + page + '&pagesize=' + limit + '&format=json&platform=WebFilter';
    return nativeHttp(url, { headers: KG_HEADERS }).then(function (r) {
      var d = JSON.parse(r.text);
      return (d.data && d.data.lists) || [];
    });
  }

  function kugouSearchSongs(kw, limit, offset) {
    return kugouSearchRaw(kw, limit, offset).then(function (lists) {
      return lists.map(mapKugouTrack).filter(function (s) { return s.name && (s.hash || s.mixSongId); });
    });
  }

  function kugouSongUrl(hash, albumId) {
    var url = 'https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=' + encodeURIComponent(hash) +
      '&key=' + kugouCloudKey(hash) +
      '&album_id=' + encodeURIComponent(albumId || '0') +
      '&pid=1&forceDown=0&vip=65530';
    var headers = { 'Referer': 'https://m.kugou.com/', 'User-Agent': KG_UA, 'Cookie': kgCookie() };
    if (kgState.userid) { url += '&userid=' + encodeURIComponent(kgState.userid); }
    if (kgState.token) { url += '&token=' + encodeURIComponent(kgState.token); }
    return nativeHttp(url, { headers: headers }).then(function (r) {
      var d = JSON.parse(r.text);
      var link = String(d.url || d.backup_url || '').replace(/\\\//g, '/').trim();
      if (Number(d.status) === 1 && link) {
        return { url: link.replace(/^http:\/\//i, 'https://'), level: 'standard', quality: '标准' };
      }
      var err = String(d.error || d.errmsg || '');
      return { url: '', error: err, vipRequired: /付费|会员|vip/i.test(err) };
    });
  }

  function kugouLyric(hash) {
    var searchUrl = 'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=' + encodeURIComponent(hash);
    return nativeHttp(searchUrl, { headers: KG_HEADERS }).then(function (r) {
      var d = JSON.parse(r.text);
      var cands = d.candidates || [];
      if (!cands.length) return { provider: 'kugou', lyric: '', tlyric: '' };
      var c = cands[0];
      var dl = 'https://lyrics.kugou.com/download?ver=1&client=pc&id=' + encodeURIComponent(c.id) +
        '&accesskey=' + encodeURIComponent(c.accesskey) + '&fmt=lrc&charset=utf8';
      return nativeHttp(dl, { headers: KG_HEADERS }).then(function (r2) {
        var d2 = JSON.parse(r2.text);
        var content = '';
        try { content = decodeURIComponent(escape(atob(d2.content || ''))); } catch (e) { content = ''; }
        return {
          provider: 'kugou', lyric: content, tlyric: '',
          yrc: '', ytlrc: '', romalrc: '', yromalrc: '', source: 'kugou'
        };
      });
    });
  }

  // ---------- 酷狗扫码登录 ----------
  // 上游：login-user.kugou.com，web 端签名 = md5(盐 + 参数按 key 排序拼接 + 盐)
  var KG_APPID = 1005, KG_SRCAPPID = 2919, KG_APIVER = 20, KG_CLIENTVER = 11309;
  var KG_WEB_SIGN_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  var kgQrImgCache = {};

  function kgWebSign(params) {
    var s = Object.keys(params).map(function (k) { return k + '=' + params[k]; }).sort().join('');
    return md5Hex(KG_WEB_SIGN_SALT + s + KG_WEB_SIGN_SALT);
  }

  function kgLoginParams(extra) {
    var dfid = kgState.dfid || '-';
    var mid = md5Hex(dfid);
    var p = {
      dfid: dfid, mid: mid, uuid: md5Hex(dfid + mid),
      appid: KG_APPID, apiver: KG_APIVER, clientver: KG_CLIENTVER,
      userid: kgState.userid || 0, clienttime: Date.now()
    };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    p.signature = kgWebSign(p);
    return p;
  }

  function kgLoginGet(path, extra) {
    var p = kgLoginParams(extra);
    var qs = Object.keys(p).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]));
    }).join('&');
    var headers = {};
    for (var hk in KG_HEADERS) headers[hk] = KG_HEADERS[hk];
    headers['dfid'] = p.dfid;
    headers['mid'] = p.mid;
    headers['clienttime'] = String(p.clienttime);
    return nativeHttp('https://login-user.kugou.com' + path + '?' + qs, { headers: headers })
      .then(function (r) { return JSON.parse(r.text || '{}'); });
  }

  // 生成二维码 key；上游会直接回一张 base64 二维码图，优先用它（不依赖本地 qrcode 库）
  function kugouQrKey() {
    return kgLoginGet('/v2/qrcode', {
      appid: 1001, type: 1, plat: 4, srcappid: KG_SRCAPPID,
      qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&'
    }).then(function (d) {
      var data = d.data || {};
      var key = String(data.qrcode || '');
      if (!key) throw new Error('酷狗二维码 key 获取失败: ' + JSON.stringify(d).slice(0, 120));
      if (data.qrcode_img) kgQrImgCache[key] = String(data.qrcode_img);
      return { key: key, code: 200 };
    });
  }

  function kugouQrCreate(key) {
    var img = kgQrImgCache[key] || '';
    var content = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + key;
    if (!img) {
      try {
        if (typeof qrcode === 'function') {
          var qr = qrcode(0, 'M');
          qr.addData(content);
          qr.make();
          img = qr.createDataURL(6, 12);
        }
      } catch (e) { img = ''; }
    }
    return Promise.resolve({ img: img, qrurl: content, code: 200 });
  }

  // 0 过期 / 1 等待扫码 / 2 待确认 / 4 授权成功（带 token、userid）
  // 同时映射成网易云那套 800/801/802/803，前端无论认哪套都能用
  function kugouQrCheck(key) {
    return kgLoginGet('/v2/get_userinfo_qrcode', {
      plat: 4, appid: KG_APPID, srcappid: KG_SRCAPPID, qrcode: key
    }).then(function (d) {
      var data = d.data || {};
      var st = Number(data.status);
      var mapped = st === 0 ? 800 : st === 1 ? 801 : st === 2 ? 802 : st === 4 ? 803 : 801;
      var out = { code: mapped, status: st, loggedIn: false, ok: false };
      if (st === 4) {
        var token = String(data.token || '');
        var userid = String(data.userid || '');
        kgState.token = token;
        kgState.userid = userid;
        if (token) {
          cookieStoreSet('token=' + token + '; userid=' + userid, '.kugou.com');
        }
        delete kgQrImgCache[key];
        out.loggedIn = true;
        out.ok = true;
        out.userId = userid;
        out.userid = userid;
        out.nickname = data.nickname || '酷狗用户';
        out.token = 'set';
        out.playbackReady = true;
      }
      return out;
    });
  }

  function qqLyric(mid) {
    var url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(mid) + '&format=json&nobase64=1';
    // 注意：歌词接口要浏览器 UA，QQMusic 客户端 UA 会被拒（返回空）
    var headers = {
      'Referer': 'https://y.qq.com/portal/player.html',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    };
    return nativeHttp(url, { headers: headers })
      .then(function (r) {
        var d = JSON.parse(r.text);
        return {
          provider: 'qq',
          lyric: d.lyric || '',
          tlyric: d.trans || '',
          yrc: '', ytlrc: '', romalrc: '', yromalrc: '',
          source: 'qq'
        };
      });
  }

  // ---------- 登录态缓存 ----------
  var accountState = { loggedIn: false, checkedAt: 0, profile: null };

  function vipFields(p) {
    var vipType = (p && p.vipType) || 0;
    return {
      vipType: vipType,
      vipLevel: vipType >= 10 ? 'svip' : (vipType > 0 ? 'vip' : 'none'),
      isVip: vipType > 0,
      isSvip: vipType >= 10,
      vipLabel: vipType >= 10 ? 'SVIP' : (vipType > 0 ? 'VIP' : '无VIP')
    };
  }

  // ---------- API 实现 ----------
  var HANDLERS = {
    '/api/search': function (p) {
      var kw = p.get('keywords') || '';
      var limit = parseInt(p.get('limit') || '20', 10) || 20;
      var offset = parseInt(p.get('offset') || '0', 10) || 0;
      var provider = p.get('provider') || 'netease';
      if (provider !== 'netease') return Promise.resolve({ songs: [], offset: offset, limit: limit, nextOffset: offset, hasMore: false });
      return neGet('/api/search/get/web?s=' + encodeURIComponent(kw) + '&type=1&limit=' + limit + '&offset=' + offset)
        .then(function (d) {
          var raw = (d.result && d.result.songs) || [];
          var songs = raw.map(mapSong);
          return { songs: songs, offset: offset, limit: limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit };
        });
    },

    '/api/song/url': function (p) {
      var id = p.get('id');
      var quality = p.get('quality') || 'exhigh';
      var br = qualityToBr(quality);
      return neGet('/api/song/enhance/player/url?ids=%5B' + encodeURIComponent(id) + '%5D&br=' + br)
        .then(function (d) {
          var item = (d.data || [])[0] || {};
          var url = httpsify(item.url || '');
          return {
            provider: 'netease',
            source: 'netease',
            url: url,
            trial: !!item.freeTrialInfo,
            playable: !!url,
            level: brToLevel(item.br || br),
            quality: brToLevel(item.br || br),
            br: item.br || br,
            requestedQuality: quality,
            size: item.size || 0,
            md5: item.md5 || '',
            code: item.code || 200,
            loggedIn: accountState.loggedIn
          };
        });
    },

    '/api/lyric': function (p) {
      var id = p.get('id');
      return neGet('/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&kv=-1&tv=-1&rv=-1')
        .then(function (d) {
          return {
            lyric: (d.lrc && d.lrc.lyric) || '',
            tlyric: (d.tlyric && d.tlyric.lyric) || '',
            klyric: (d.klyric && d.klyric.lyric) || '',
            romalrc: (d.romalrc && d.romalrc.lyric) || '',
            yrc: '',
            ytlrc: '',
            yromalrc: '',
            source: 'lyric'
          };
        });
    },

    '/api/song/detail': function (p) {
      var id = p.get('id') || p.get('ids');
      return neGet('/api/song/detail?ids=%5B' + encodeURIComponent(String(id).replace(/[\[\]]/g, '')) + '%5D')
        .then(function (d) { return { songs: (d.songs || []).map(mapSong) }; });
    },

    // ---------- 登录 ----------
    '/api/login/status': function () {
      if (Date.now() - accountState.checkedAt < 5000 && accountState.profile) {
        return Promise.resolve(accountState.profile);
      }
      return neGet('/api/nuser/account/get').then(function (d) {
        var p = d.profile || null;
        var out;
        if (p && p.userId) {
          out = Object.assign({
            loggedIn: true,
            userId: p.userId,
            nickname: p.nickname,
            avatarUrl: httpsify(p.avatarUrl),
            hasCookie: true
          }, vipFields(p));
        } else {
          out = Object.assign({ loggedIn: false, hasCookie: false, userId: 0, nickname: '', avatarUrl: '' }, vipFields(null));
        }
        accountState.loggedIn = out.loggedIn;
        accountState.profile = out;
        accountState.checkedAt = Date.now();
        return out;
      });
    },

    '/api/login/qr/key': function () {
      return nePost('/api/login/qrcode/unikey?type=1').then(function (d) {
        if (!d.unikey) throw new Error('unikey failed: ' + JSON.stringify(d).slice(0, 120));
        return { key: d.unikey, code: 200 };
      });
    },

    '/api/login/qr/create': function (p) {
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
      } catch (e) { img = ''; }
      return Promise.resolve({ img: img, qrurl: content, code: 200 });
    },

    '/api/login/qr/check': function (p) {
      var key = p.get('key') || '';
      return nePost('/api/login/qrcode/client/login?type=1&key=' + encodeURIComponent(key)).then(function (d) {
        var out = { code: d.code };
        if (d.code === 803) {
          out.loggedIn = true;
          out.hasCookie = true;
          out.nickname = d.nickname || '';
          out.avatarUrl = httpsify(d.avatarUrl || '');
          accountState.checkedAt = 0; // 下次强制刷新
          // 登录成功：把返回的 cookie 写入原生会话（VIP 曲目播放需要）
          if (d.cookie) cookieStoreSet(d.cookie);
        }
        return out;
      });
    },

    '/api/login/cookie': function (p, init) {
      var cookie = '';
      try {
        if (init && init.body) {
          var b = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          cookie = b.cookie || b.ck || '';
        }
      } catch (e) { }
      if (!cookie) cookie = p.get('cookie') || '';
      if (!cookie) return Promise.resolve({ ok: false, error: 'cookie_unavailable' });
      return cookieStoreSet(cookie).then(function () {
        accountState.checkedAt = 0;
        return HANDLERS['/api/login/status'](new URLSearchParams());
      });
    },

    '/api/logout': function () {
      return cookieStoreClear().then(function () {
        accountState = { loggedIn: false, checkedAt: 0, profile: null };
        return { ok: true, loggedIn: false };
      });
    },

    // ---------- QQ 音乐 ----------
    '/api/qq/search': function (p) {
      var kw = p.get('keywords') || '';
      var limit = Math.max(4, Math.min(30, parseInt(p.get('limit') || '12', 10) || 12));
      var offset = Math.max(0, parseInt(p.get('offset') || '0', 10) || 0);
      if (!kw) return Promise.resolve({ provider: 'qq', songs: [], offset: offset, limit: limit, nextOffset: offset, hasMore: false });
      return qqSearchSongs(kw, limit, offset).then(function (songs) {
        return { provider: 'qq', songs: songs, offset: offset, limit: limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit };
      });
    },

    '/api/qq/song/url': function (p) {
      var mid = p.get('mid') || p.get('songmid') || p.get('id') || '';
      var mediaMid = p.get('mediaMid') || p.get('media_mid') || '';
      if (!mid) return Promise.resolve({ provider: 'qq', url: '', playable: false, error: 'MISSING_MID', message: '缺少歌曲 mid' });
      // 没带 media_mid 时先解析（只给歌曲 mid 会一律 104003）
      var urlTask = mediaMid ? qqSongUrl(mid, mediaMid) : qqSongUrlAuto(mid);
      return urlTask.then(function (r) {
        if (r.url) {
          return {
            provider: 'qq', url: r.url, trial: false, playable: true, playbackReady: true,
            level: r.level || 'standard', quality: r.level || 'standard',
            loggedIn: !!qqState.uin, userId: qqState.uin || '',
            playbackKeyReady: !!qqState.key, vipRequired: false
          };
        }
        var loggedIn = !!qqState.uin;
        return {
          provider: 'qq', url: '', playable: false, trial: false,
          reason: loggedIn ? 'vip_required' : 'login_required',
          message: loggedIn
            ? 'QQ 音乐：该歌曲需要会员权限（当前账号未识别到会员状态）'
            : 'QQ 音乐：该歌曲需要登录后播放，可在登录面板粘贴 QQ 音乐 Cookie',
          loggedIn: loggedIn, userId: qqState.uin || '', result: r.result || 0
        };
      });
    },

    '/api/qq/lyric': function (p) {
      var mid = p.get('mid') || p.get('songmid') || p.get('id') || '';
      if (!mid) return Promise.resolve({ provider: 'qq', lyric: '', tlyric: '' });
      return qqLyric(mid);
    },

    '/api/qq/login/cookie': function (p, init) {
      var cookie = '';
      try {
        if (init && init.body) {
          var b = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          cookie = b.cookie || b.data || b.text || '';
        }
      } catch (e) { }
      if (!cookie) cookie = p.get('cookie') || '';
      if (!cookie) return Promise.resolve({ code: -1, ok: false, loggedIn: false, message: 'cookie 为空' });
      return cookieStoreSet(cookie, '.qq.com').then(function () {
        var st = qqStateFromCookie(cookie);
        qqState.uin = st.uin || qqState.uin;
        qqState.key = st.key || qqState.key;
        var loggedIn = !!(qqState.uin && qqState.key);
        return {
          code: 0, ok: loggedIn, loggedIn: loggedIn, hasCookie: loggedIn,
          uin: qqState.uin, nickname: 'QQ 音乐用户',
          playbackKeyReady: !!qqState.key,
          vipType: 0, vipLevel: 'unknown', isVip: false, isSvip: false, vipLabel: '会员状态待验证',
          message: loggedIn ? '' : 'cookie 里没找到 uin / qqmusic_key，请粘贴完整 Cookie'
        };
      });
    },

    '/api/qq/login/status': function () {
      var loggedIn = !!(qqState.uin && qqState.key);
      return Promise.resolve({
        code: 0, ok: true, loggedIn: loggedIn, hasCookie: loggedIn,
        uin: qqState.uin || '', nickname: loggedIn ? 'QQ 音乐用户' : '',
        playbackKeyReady: !!qqState.key,
        vipType: 0, vipLevel: 'unknown', isVip: false, isSvip: false, vipLabel: '会员状态待验证'
      });
    },

    '/api/qq/logout': function () {
      var uin = qqState.uin;
      qqState.uin = ''; qqState.key = '';
      var done = uin ? cookieStoreClear('qq.com') : Promise.resolve();
      return done.then(function () { return { code: 0, ok: true, loggedIn: false }; });
    },

    // ---------- 酷狗音乐 ----------
    '/api/kugou/search': function (p) {
      var kw = p.get('keywords') || '';
      var limit = Math.max(4, Math.min(20, parseInt(p.get('limit') || '12', 10) || 12));
      var offset = Math.max(0, parseInt(p.get('offset') || '0', 10) || 0);
      if (!kw) return Promise.resolve({ provider: 'kugou', songs: [], offset: offset, limit: limit, nextOffset: offset, hasMore: false });
      return kugouSearchSongs(kw, limit, offset).then(function (songs) {
        return { provider: 'kugou', songs: songs, offset: offset, limit: limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit };
      });
    },

    '/api/kugou/song/url': function (p) {
      var hash = p.get('hash') || p.get('fileHash') || p.get('id') || '';
      var albumId = p.get('albumId') || p.get('album_id') || '';
      if (!hash) return Promise.resolve({ provider: 'kugou', url: '', playable: false, error: 'MISSING_HASH', message: '缺少歌曲 hash' });
      return kugouSongUrl(hash, albumId).then(function (r) {
        if (r.url) {
          return {
            provider: 'kugou', url: r.url, trial: false, playable: true, playbackReady: true,
            level: r.level || 'standard', quality: r.quality || '标准',
            loggedIn: !!kgState.userid, userId: kgState.userid || ''
          };
        }
        return {
          provider: 'kugou', url: '', playable: false, trial: false,
          reason: r.vipRequired ? 'vip_required' : 'login_required',
          message: r.vipRequired
            ? '酷狗音乐：该歌曲需要会员/付费权限，可在登录面板粘贴酷狗 Cookie'
            : ('酷狗音乐：未能获取播放地址' + (r.error ? '（' + r.error + '）' : '')),
          loggedIn: !!kgState.userid, userId: kgState.userid || ''
        };
      });
    },

    '/api/kugou/lyric': function (p) {
      var hash = p.get('hash') || p.get('fileHash') || p.get('id') || '';
      if (!hash) return Promise.resolve({ provider: 'kugou', lyric: '', tlyric: '' });
      return kugouLyric(hash);
    },

    '/api/kugou/login/cookie': function (p, init) {
      var cookie = '';
      try {
        if (init && init.body) {
          var b = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          cookie = b.cookie || b.data || b.text || '';
        }
      } catch (e) { }
      if (!cookie) cookie = p.get('cookie') || '';
      if (!cookie) return Promise.resolve({ ok: false, logged_in: false, message: 'cookie 为空' });
      return cookieStoreSet(cookie, '.kugou.com').then(function () {
        String(cookie).split(';').forEach(function (pair) {
          var kv = pair.split('=');
          var k = (kv[0] || '').trim().toLowerCase();
          var v = kv.slice(1).join('=').trim();
          if (k === 'kg_mid') kgState.mid = v;
          if (k === 'kg_dfid') kgState.dfid = v;
          if (k === 'userid' || k === 'user_id') kgState.userid = v;
          if (k === 'token') kgState.token = v;
        });
        var loggedIn = !!(kgState.userid && kgState.token);
        return {
          ok: loggedIn, logged_in: loggedIn, loggedIn: loggedIn,
          userid: kgState.userid, token: kgState.token ? 'set' : '',
          nickname: '酷狗用户', playbackReady: loggedIn,
          message: loggedIn ? '' : 'cookie 里缺少 userid/token（需包含登录后的完整 Cookie）'
        };
      });
    },

    '/api/kugou/login/qr/key': function () {
      return kugouQrKey();
    },
    '/api/kugou/login/qr/create': function (p) {
      var key = p.get('key') || '';
      if (!key) return Promise.resolve({ img: '', qrurl: '', code: 400 });
      return kugouQrCreate(key);
    },
    '/api/kugou/login/qr/check': function (p) {
      var key = p.get('key') || '';
      if (!key) return Promise.resolve({ code: 800, status: 0, loggedIn: false });
      return kugouQrCheck(key);
    },

    '/api/kugou/login/status': function () {
      var loggedIn = !!(kgState.userid && kgState.token);
      return Promise.resolve({ ok: true, logged_in: loggedIn, loggedIn: loggedIn, userid: kgState.userid || '', playbackReady: loggedIn });
    },

    '/api/kugou/logout': function () {
      kgState.userid = ''; kgState.token = '';
      return cookieStoreClear('kugou.com').then(function () { return { ok: true, logged_in: false }; });
    },

    // ---------- 静态能力声明 ----------
    '/api/platform/capabilities': function () {
      return Promise.resolve({
        platform: 'ios-standalone',
        serverReady: true,
        netease: { playlists: true, likeRead: true, likeWrite: false, albumRead: true, albumCollect: false, commentsRead: true, commentsWrite: false, listenReport: false },
        qq: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false },
        kugou: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false },
        qishui: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false },
        spotify: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false }
      });
    },

    '/api/app/version': function () {
      return Promise.resolve({ version: '2.1.0-ios', platform: 'ios', code: 200 });
    },

    '/api/plugins/list': function () {
      return Promise.resolve({ ok: true, plugins: [] });
    },

    // ---------- 安全降级（保持界面可用） ----------
    '/api/user/playlists': function () { return Promise.resolve({ playlist: [], more: false }); },
    '/api/playlist/tracks': function () { return Promise.resolve({ playlist: { tracks: [] } }); },
    '/api/qishui/status': function () { return Promise.resolve({ ok: false, logged_in: false }); },
    '/api/spotify/status': function () { return Promise.resolve({ ok: false, logged_in: false }); },
    '/api/discover/home': function () { return Promise.resolve({ blocks: [] }); },
    '/api/listen/total': function () { return Promise.resolve({ total: 0 }); },
    '/api/cache/storage-stats': function () { return Promise.resolve({ ok: true, totalBytes: 0 }); },
    '/api/weather/ip-location': function () { return Promise.resolve({ ok: false, city: '' }); },
    '/api/weather/radio': function () { return Promise.resolve({ ok: false }); }
  };

  var DEFAULT_503 = { code: 503, message: 'service_unavailable', error: 'not implemented in ios standalone build' };

  function jsonResponse(obj, status) {
    return Promise.resolve({ status: status || 200, body: JSON.stringify(obj) });
  }

  /**
   * 路由解析：先精确匹配，再逐级去掉尾部路径段做前缀匹配，
   * 从而支持 /qqapi/getMusicPlay/{songmid} 这类路径参数式路由。
   * 命中时返回 { fn, rest }，rest 即被吃掉的路径参数。
   */
  function resolveHandler(pathname) {
    if (Object.prototype.hasOwnProperty.call(HANDLERS, pathname)) {
      return { fn: HANDLERS[pathname], rest: '' };
    }
    var cut = pathname.length;
    while (cut > 1) {
      cut = pathname.lastIndexOf('/', cut - 1);
      if (cut <= 0) break;
      var base = pathname.slice(0, cut);
      if (Object.prototype.hasOwnProperty.call(HANDLERS, base)) {
        return { fn: HANDLERS[base], rest: pathname.slice(cut + 1) };
      }
    }
    return null;
  }

  function handleApi(pathname, params, init) {
    var hit = resolveHandler(pathname);
    if (!hit) {
      // 未实现：返回 503，让前端走 try/catch 优雅降级
      console.log('[MR-API] 503 (unimplemented):', pathname);
      return jsonResponse(DEFAULT_503, 503);
    }
    return Promise.resolve()
      .then(function () { return hit.fn(params, init, hit.rest); })
      .then(function (data) {
        // __MR_RAW__：原样回传上游响应体（代理场景，需保留 Content-Type 与原始字节）
        if (data && data.__MR_RAW__) {
          return {
            status: data.status || 200,
            body: data.body || '',
            bytes: data.bytes || null,
            contentType: data.contentType || 'text/plain; charset=utf-8'
          };
        }
        console.log('[MR-API] 200', pathname, JSON.stringify(data).slice(0, 220));
        return { status: 200, body: JSON.stringify(data) };
      })
      .catch(function (err) {
        console.log('[MR-API] 500', pathname, String((err && err.message) || err).slice(0, 220));
        return { status: 500, body: JSON.stringify({ code: 500, error: String((err && err.message) || err) }) };
      });
  }

  // ---------- fetch 拦截 ----------
  var originalFetch = window.fetch;

  window.fetch = function (input, init) {
    var u = '';
    try { u = (typeof input === 'string') ? input : ((input && input.url) || ''); } catch (e) { }
    if (u && u.charAt(0) === '/') {
      var qi = u.indexOf('?');
      var pathname = qi >= 0 ? u.slice(0, qi) : u;
      var known = pathname.indexOf('/api/') === 0 || pathname.indexOf('/neapi/') === 0 ||
        pathname.indexOf('/qqapi/') === 0 || pathname.indexOf('/kgapi/') === 0 ||
        Object.prototype.hasOwnProperty.call(HANDLERS, pathname);
      if (known) {
        var params = new URLSearchParams(qi >= 0 ? u.slice(qi + 1) : '');
        return handleApi(pathname, params, init).then(function (r) {
          var ct = r.contentType || 'application/json; charset=utf-8';
          return new Response(r.bytes || r.body, {
            status: r.status,
            headers: { 'Content-Type': ct }
          });
        });
      }
    }
    return originalFetch.apply(window, arguments);
  };

  // 供其他前端（如 Folia）复用：暴露基础设施与路由注册
  window.__MR_BRIDGE__ = {
    handlers: HANDLERS,
    nativeHttp: nativeHttp,
    cookieStoreSet: cookieStoreSet,
    cookieStoreClear: cookieStoreClear,
    md5Hex: md5Hex,
    sha1Hex: sha1Hex,
    qqSign: qqSign,
    nativePlugin: nativePlugin,
    httpsify: httpsify,
    qqSongUrl: qqSongUrl,
    qqMediaMid: qqMediaMid,
    qqSongUrlAuto: qqSongUrlAuto,
    qqLyric: qqLyric,
    qqSearchSongs: qqSearchSongs,
    kugouSongUrl: kugouSongUrl,
    kugouLyric: kugouLyric,
    kugouQrKey: kugouQrKey,
    kugouQrCreate: kugouQrCreate,
    kugouQrCheck: kugouQrCheck,
    kugouSearchRaw: kugouSearchRaw,
    nat: { UA: UA, QQ_UA: QQ_UA, KG_UA: KG_UA },
    // 原样回传上游响应（代理用）：text 文本或 bytes 二进制
    rawResponse: function (status, body, contentType, bytes) {
      return { __MR_RAW__: true, status: status, body: body || '', contentType: contentType || '', bytes: bytes || null };
    },
    base64ToBytes: function (b64) {
      try {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      } catch (e) { return null; }
    },
    registerRoutes: function (routes) {
      Object.keys(routes).forEach(function (path) { HANDLERS[path] = routes[path]; });
    }
  };

  // ---------- 移动端画面适配 ----------
  // 这些 H5 是按桌面/大屏的固定像素排的（720/760/1180px），手机横屏只有 ~430px 高，
  // 直接铺上去会被裁掉。这里按「内容实际尺寸 vs 视口」等比缩放，保证整屏完整可见且不变形；
  // 若自动判断不符合口味，左上角 ⛶ 按钮可手动切换档位。
  var FIT_KEY = 'mr_ios_screen_fit_v1';
  var FIT_MODES = [
    { id: 'auto', label: '自动', zoom: 0 },
    { id: '100', label: '100%', zoom: 1 },
    { id: '110', label: '110%', zoom: 1.1 },
    { id: '90', label: '90%', zoom: 0.9 },
    { id: '80', label: '80%', zoom: 0.8 }
  ];
  var fitState = { mode: 'auto', measured: 0 };

  function fitRead() {
    try { return localStorage.getItem(FIT_KEY) || 'auto'; } catch (e) { return 'auto'; }
  }

  // 在 zoom=1 的前提下量一次内容真实尺寸，之后缩放不再重复测量
  function measureContent() {
    var de = document.documentElement;
    var b = document.body;
    var cw = Math.max(de.scrollWidth || 0, (b && b.scrollWidth) || 0);
    var ch = Math.max(de.scrollHeight || 0, (b && b.scrollHeight) || 0);
    if (!cw || !ch) return 0;
    var s = Math.min(window.innerWidth / cw, window.innerHeight / ch);
    if (s > 1) s = 1;
    if (s < 0.5) s = 0.5;
    return Math.round(s * 1000) / 1000;
  }

  function applyZoom(z) {
    var de = document.documentElement;
    if (!z || Math.abs(z - 1) < 0.004) {
      de.style.zoom = '';
      return;
    }
    de.style.zoom = String(z);
  }

  function applyFit(mode) {
    fitState.mode = mode || 'auto';
    var m = null;
    for (var i = 0; i < FIT_MODES.length; i++) if (FIT_MODES[i].id === fitState.mode) m = FIT_MODES[i];
    if (!m) m = FIT_MODES[0];
    if (m.zoom) { applyZoom(m.zoom); return; }
    // 自动：先还原再量，避免上一次缩放污染测量结果
    applyZoom(0);
    var z = fitState.measured || measureContent();
    applyZoom(z);
  }

  function mountFitButton() {
    if (document.getElementById('mr-fit-btn')) return;
    var btn = document.createElement('div');
    btn.id = 'mr-fit-btn';
    btn.textContent = '⛶';
    var left = 8;
    // Folia 的 ⚡ 面板也在左上角，错开
    if (document.getElementById('folia-perf-btn') || document.querySelector('#mr-perf-btn')) left = 44;
    var s = btn.style;
    s.position = 'fixed'; s.top = '8px'; s.left = left + 'px'; s.zIndex = '2147483001';
    s.width = '30px'; s.height = '30px'; s.lineHeight = '30px'; s.textAlign = 'center';
    s.fontSize = '16px'; s.borderRadius = '8px'; s.cursor = 'pointer';
    s.background = 'rgba(20,20,24,.72)'; s.color = '#fff'; s.border = '1px solid rgba(255,255,255,.18)';
    s.backdropFilter = 'blur(6px)'; s.webkitBackdropFilter = 'blur(6px)';
    s.userSelect = 'none'; s.webkitUserSelect = 'none';
    document.body.appendChild(btn);

    var taps = 0, timer = null;
    btn.addEventListener('click', function () {
      taps++;
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (taps >= 2) {           // 双击：隐藏按钮（再重载页面恢复）
          btn.style.display = 'none';
          try { localStorage.setItem('mr_ios_fit_hidden', '1'); } catch (e) { }
        } else {                   // 单击：切下一档
          var ids = FIT_MODES.map(function (m) { return m.id; });
          var next = ids[(ids.indexOf(fitState.mode) + 1) % ids.length];
          try { localStorage.setItem(FIT_KEY, next); } catch (e) { }
          var label = (FIT_MODES.filter(function (m) { return m.id === next; })[0] || {}).label || next;
          btn.textContent = '⛶';
          btn.title = '画面：' + label;
          applyFit(next);
        }
        taps = 0;
      }, 260);
    });
  }

  function initScreenFit() {
    try {
      // 允许延伸到安全区；缩放范围放宽，配合下面的自动 zoom
      var vp = document.querySelector('meta[name="viewport"]');
      if (vp) {
        vp.setAttribute('content',
          'width=device-width, initial-scale=1.0, minimum-scale=0.5, maximum-scale=2.0, user-scalable=yes, viewport-fit=cover');
      }
      var st = document.createElement('style');
      st.textContent =
        'html{-webkit-text-size-adjust:100%;}' +
        'body{overscroll-behavior:none;}';
      document.head.appendChild(st);
    } catch (e) { }

    if (fitRead() === 'auto') fitState.measured = measureContent();
    applyFit(fitRead());

    // 布局稳定后再量一次（图片/字体加载完尺寸会变）
    [400, 1200, 3000].forEach(function (t) {
      setTimeout(function () {
        if (fitState.mode !== 'auto') return;
        var z = measureContent();
        if (z && Math.abs(z - (fitState.measured || 0)) > 0.02) {
          fitState.measured = z;
          applyZoom(z);
        }
      }, t);
    });

    var ro = window.addEventListener.bind(window);
    ro('resize', function () { if (fitState.mode === 'auto') applyFit('auto'); });
    ro('orientationchange', function () {
      setTimeout(function () { if (fitState.mode === 'auto') applyFit('auto'); }, 500);
    });

    try {
      if (localStorage.getItem('mr_ios_fit_hidden') === '1') return;
    } catch (e) { }
    mountFitButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScreenFit);
  } else {
    initScreenFit();
  }

  console.log('[Mineradio] standalone bridge ready (ios build)');
})();
