/* ============================================================
   Stoic — Charts (vanilla SVG chart library)
   window.StoicCharts: dependency-free SVG generators that return
   markup strings (el.innerHTML = StoicCharts.bar(...)), matching how
   the app already builds inline SVG. Colorful "OnlyGenius" vocabulary:
   gradient area, multi-color bars, donut rings, multi-line, sparkline.

   - Per-call gid() counter → unique <linearGradient>/<clipPath> ids so
     N charts on one page never collide (the old pool.html bug).
   - palette() lazily reads --c1..--c6 from the theme and caches.
   - prefers-reduced-motion: skips the grow/fade reveal, renders static.
   No dependencies. No data coupling. Load after stoic-data.js.
   ============================================================ */
(function () {
  // ---------- unique ids ----------
  var uid = 0;
  function gid(p) { return 'sg-' + (p || 'g') + '-' + (++uid); }

  // ---------- reduced motion ----------
  var RM = false;
  try { RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  function anim(cls, delayMs) {
    if (RM) return '';
    return ' class="' + cls + '" style="animation-delay:' + (delayMs || 0) + 'ms"';
  }

  // ---------- token + palette cache ----------
  var _tok = {};
  function tok(name, fb) {
    if (_tok[name] != null) return _tok[name];
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name); } catch (e) {}
    v = (v && v.trim()) || fb;
    _tok[name] = v; return v;
  }
  var _pal = null;
  function palette() {
    if (_pal) return _pal;
    _pal = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'].map(function (v, i) {
      return tok(v, ['#5B8DEF', '#16C784', '#A78BFA', '#F5A623', '#F6465D', '#2DD4BF'][i]);
    });
    return _pal;
  }

  // ---------- one-time animation keyframes ----------
  var injected = false;
  function ensureStyles() {
    if (injected || RM) return; injected = true;
    var css =
      '@keyframes sc-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}' +
      '@keyframes sc-fade{from{opacity:0}to{opacity:1}}' +
      '.sc-bar{transform-box:fill-box;transform-origin:bottom;animation:sc-grow .55s cubic-bezier(.2,.7,.3,1) both}' +
      '.sc-area{animation:sc-fade .7s ease both}' +
      '.sc-slice{transform-box:fill-box;transform-origin:center;animation:sc-fade .55s ease both}';
    try { var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); } catch (e) {}
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function svgWrap(w, h, inner, o) {
    o = o || {};
    return '<svg class="stx-chart2' + (o.cls ? ' ' + o.cls : '') + '" viewBox="0 0 ' + w + ' ' + h + '" ' +
      'preserveAspectRatio="' + (o.par || 'xMidYMid meet') + '"' +
      (o.height ? ' style="height:' + o.height + 'px"' : '') +
      ' role="img"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + '>' + inner + '</svg>';
  }
  function gridY(pad, iw, ih, max, min, ticks, fmt) {
    min = min || 0; ticks = ticks || 4; var g = '';
    for (var i = 0; i <= ticks; i++) {
      var t = i / ticks, v = min + (max - min) * (1 - t), y = pad.t + t * ih;
      g += '<line class="grid" x1="' + pad.l + '" y1="' + y.toFixed(1) + '" x2="' + (pad.l + iw) + '" y2="' + y.toFixed(1) + '"/>';
      g += '<text class="axl" x="' + (pad.l - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + esc(fmt ? fmt(v) : Math.round(v)) + '</text>';
    }
    return g;
  }

  // ---------- sparkline ----------
  function sparkline(arr, o) {
    o = o || {}; var w = o.w || 64, h = o.h || 18;
    if (!arr || !arr.length) return svgWrap(w, h, '', o);
    var max = Math.max.apply(null, arr), min = Math.min.apply(null, arr), rng = (max - min) || 1;
    var up = arr[arr.length - 1] >= arr[0];
    var col = o.color || (up ? tok('--green', '#16C784') : tok('--red', '#F6465D'));
    var pts = arr.map(function (v, i) {
      return (i / (arr.length - 1) * w).toFixed(1) + ',' + (h - ((v - min) / rng) * h).toFixed(1);
    }).join(' ');
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }

  // ---------- multi-line ----------
  function line(series, o) {
    o = o || {};
    var w = o.w || 720, h = o.h || 248, pad = o.pad || { t: 14, r: 16, b: 26, l: 42 };
    var pal = palette();
    var all = []; series.forEach(function (s) { (s.values || []).forEach(function (v) { all.push(v); }); });
    if (o.threshold != null) all.push(o.threshold);
    var max = o.yMax != null ? o.yMax : (Math.max.apply(null, all) * 1.08 || 1);
    var min = o.yMin != null ? o.yMin : 0;
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var len = series[0] ? series[0].values.length : 0;
    var X = function (i) { return pad.l + (len < 2 ? iw / 2 : i / (len - 1) * iw); };
    var Y = function (v) { return pad.t + (1 - (v - min) / ((max - min) || 1)) * ih; };
    var g = gridY(pad, iw, ih, max, min, 4, o.valueFmt);
    if (o.labels) o.labels.forEach(function (lb, i) {
      g += '<text class="axl" text-anchor="middle" x="' + X(i) + '" y="' + (pad.t + ih + 15) + '">' + esc(lb) + '</text>';
    });
    if (o.threshold != null) {
      var ty = Y(o.threshold);
      g += '<line x1="' + pad.l + '" y1="' + ty.toFixed(1) + '" x2="' + (pad.l + iw) + '" y2="' + ty.toFixed(1) +
        '" stroke="' + tok('--red', '#F6465D') + '" stroke-width="1.4" stroke-dasharray="5 4" opacity=".8"/>';
      if (o.thresholdLabel) g += '<text class="axl" x="' + (pad.l + iw) + '" y="' + (ty - 4).toFixed(1) +
        '" text-anchor="end" style="fill:' + tok('--red', '#F6465D') + '">' + esc(o.thresholdLabel) + '</text>';
    }
    series.forEach(function (s, si) {
      var col = s.color || pal[si % pal.length];
      var pts = s.values.map(function (v, i) { return X(i) + ',' + Y(v); }).join(' ');
      g += '<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="' + (s.width || 2.2) + '" ' +
        (s.dashed ? 'stroke-dasharray="6 5" ' : '') + 'stroke-linejoin="round" stroke-linecap="round" opacity="' + (s.opacity != null ? s.opacity : 1) + '"/>';
      if (s.dots !== false && !s.dashed) s.values.forEach(function (v, i) {
        g += '<circle cx="' + X(i) + '" cy="' + Y(v) + '" r="2.6" fill="' + col + '"/>';
      });
    });
    return svgWrap(w, h, g, o);
  }

  // ---------- single gradient area ----------
  function area(data, o) {
    o = o || {}; ensureStyles();
    var w = o.w || 640, h = o.h || 200, pad = o.pad || { t: 14, r: 14, b: 24, l: 40 };
    var vals = data.map(function (d) { return typeof d === 'number' ? d : d.y; });
    if (!vals.length) return svgWrap(w, h, '', o);
    var col = o.color || palette()[0];
    var max = o.yMax != null ? o.yMax : (Math.max.apply(null, vals) * 1.12 || 1);
    var min = o.yMin != null ? o.yMin : 0;
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var X = function (i) { return pad.l + (vals.length < 2 ? iw / 2 : i / (vals.length - 1) * iw); };
    var Y = function (v) { return pad.t + (1 - (v - min) / ((max - min) || 1)) * ih; };
    var id = gid('area');
    var line_ = vals.map(function (v, i) { return X(i) + ',' + Y(v); });
    var linePath = 'M' + line_.join(' L');
    var base = pad.t + ih;
    var fillPath = linePath + ' L' + X(vals.length - 1).toFixed(1) + ',' + base + ' L' + X(0).toFixed(1) + ',' + base + ' Z';
    var g = gridY(pad, iw, ih, max, min, 4, o.valueFmt);
    if (o.labels) o.labels.forEach(function (lb, i) {
      g += '<text class="axl" text-anchor="middle" x="' + X(i) + '" y="' + (base + 15) + '">' + esc(lb) + '</text>';
    });
    g += '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + col + '" stop-opacity="' + (o.fillTop != null ? o.fillTop : .45) + '"/>' +
      '<stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>';
    g += '<path' + anim('sc-area') + ' d="' + fillPath + '" fill="url(#' + id + ')"/>';
    g += '<path d="' + linePath + '" fill="none" stroke="' + col + '" stroke-width="' + (o.width || 2.4) + '" stroke-linejoin="round" stroke-linecap="round"/>';
    if (o.dots) vals.forEach(function (v, i) { g += '<circle cx="' + X(i) + '" cy="' + Y(v) + '" r="2.8" fill="' + col + '"/>'; });
    return svgWrap(w, h, g, o);
  }

  // ---------- stacked gradient area ----------
  function stackedArea(seriesArr, o) {
    o = o || {}; ensureStyles();
    var w = o.w || 720, h = o.h || 240, pad = o.pad || { t: 14, r: 14, b: 26, l: 46 };
    var pal = palette();
    var len = seriesArr[0] ? seriesArr[0].values.length : 0;
    var totals = []; for (var i = 0; i < len; i++) { var t = 0; seriesArr.forEach(function (s) { t += s.values[i] || 0; }); totals.push(t); }
    var max = o.yMax != null ? o.yMax : (Math.max.apply(null, totals) * 1.1 || 1);
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var X = function (j) { return pad.l + (len < 2 ? iw / 2 : j / (len - 1) * iw); };
    var Y = function (v) { return pad.t + (1 - v / max) * ih; };
    var g = gridY(pad, iw, ih, max, 0, 4, o.valueFmt), defs = '';
    if (o.labels) o.labels.forEach(function (lb, j) {
      g += '<text class="axl" text-anchor="middle" x="' + X(j) + '" y="' + (pad.t + ih + 15) + '">' + esc(lb) + '</text>';
    });
    var lower = []; for (var k = 0; k < len; k++) lower.push(0);
    seriesArr.forEach(function (s, si) {
      var col = s.color || pal[si % pal.length];
      var upper = lower.map(function (lo, j) { return lo + (s.values[j] || 0); });
      var topPts = upper.map(function (v, j) { return X(j) + ',' + Y(v); });
      var botPts = lower.map(function (v, j) { return X(j) + ',' + Y(v); }).reverse();
      var id = gid('sa');
      defs += '<linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + col + '" stop-opacity=".72"/>' +
        '<stop offset="1" stop-color="' + col + '" stop-opacity=".26"/></linearGradient>';
      g += '<path' + anim('sc-area', si * 90) + ' d="M' + topPts.join(' L') + ' L' + botPts.join(' L') +
        ' Z" fill="url(#' + id + ')" stroke="' + col + '" stroke-width="1.2"/>';
      lower = upper;
    });
    return svgWrap(w, h, '<defs>' + defs + '</defs>' + g, o);
  }

  // ---------- vertical multi-color bars ----------
  function bar(items, o) {
    o = o || {}; ensureStyles();
    var w = o.w || 420, h = o.h || 220, pad = o.pad || { t: 18, r: 10, b: 34, l: 42 };
    var pal = palette();
    var max = o.yMax != null ? o.yMax : (Math.max.apply(null, items.map(function (d) { return d.value; })) * 1.16 || 1);
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var n = items.length || 1, gap = o.gap != null ? o.gap : 0.4;
    var step = iw / n, bw = step * (1 - gap);
    var g = gridY(pad, iw, ih, max, 0, 4, o.valueFmt), defs = '';
    items.forEach(function (d, i) {
      var col = d.color || pal[i % pal.length];
      var bh = (d.value / max) * ih;
      var x = pad.l + i * step + (step - bw) / 2, y = pad.t + ih - bh;
      var id = gid('bar');
      defs += '<linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + col + '"/><stop offset="1" stop-color="' + col + '" stop-opacity=".55"/></linearGradient>';
      g += '<rect' + anim('sc-bar', i * 55) + ' x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(0, bh).toFixed(1) + '" rx="' + Math.min(6, bw / 3).toFixed(1) + '" fill="url(#' + id + ')"/>';
      if (o.showValues !== false) g += '<text class="axl" text-anchor="middle" x="' + (x + bw / 2).toFixed(1) + '" y="' +
        (y - 5).toFixed(1) + '" style="fill:var(--text2)">' + esc(o.valueFmt ? o.valueFmt(d.value) : d.value) + '</text>';
      g += '<text class="axl" text-anchor="middle" x="' + (x + bw / 2).toFixed(1) + '" y="' + (pad.t + ih + 15) + '">' + esc(d.label) + '</text>';
    });
    return svgWrap(w, h, '<defs>' + defs + '</defs>' + g, o);
  }

  // ---------- grouped bars ----------
  function groupedBar(groups, names, o) {
    o = o || {}; ensureStyles();
    var w = o.w || 520, h = o.h || 240, pad = o.pad || { t: 18, r: 12, b: 34, l: 44 };
    var pal = palette();
    var allVals = []; groups.forEach(function (gp) { gp.values.forEach(function (v) { allVals.push(v); }); });
    var max = o.yMax != null ? o.yMax : (Math.max.apply(null, allVals) * 1.16 || 1);
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var ng = groups.length || 1, ns = names.length || 1;
    var groupStep = iw / ng, groupW = groupStep * 0.68, barW = groupW / ns;
    var g = gridY(pad, iw, ih, max, 0, 4, o.valueFmt), defs = '';
    groups.forEach(function (gp, gi) {
      var gx = pad.l + gi * groupStep + (groupStep - groupW) / 2;
      gp.values.forEach(function (v, si) {
        var col = pal[si % pal.length];
        var bh = (v / max) * ih, x = gx + si * barW, y = pad.t + ih - bh;
        var id = gid('gb');
        defs += '<linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="' + col + '"/><stop offset="1" stop-color="' + col + '" stop-opacity=".55"/></linearGradient>';
        g += '<rect' + anim('sc-bar', (gi * ns + si) * 45) + ' x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + (barW * 0.86).toFixed(1) + '" height="' + Math.max(0, bh).toFixed(1) + '" rx="3" fill="url(#' + id + ')"/>';
      });
      g += '<text class="axl" text-anchor="middle" x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (pad.t + ih + 15) + '">' + esc(gp.label) + '</text>';
    });
    return svgWrap(w, h, '<defs>' + defs + '</defs>' + g, o);
  }

  // ---------- donut / allocation ring ----------
  function donut(slices, o) {
    o = o || {}; ensureStyles();
    var size = o.size || 200, thick = o.thickness || 26;
    var pal = palette();
    var total = slices.reduce(function (a, s) { return a + s.value; }, 0) || 1;
    var cx = size / 2, cy = size / 2, r = (size - thick) / 2 - 4;
    var gapA = o.gap != null ? o.gap : 0.045;
    var ang = -Math.PI / 2, g = '';
    slices.forEach(function (s, i) {
      var frac = s.value / total;
      var a1 = ang + gapA / 2, a2 = ang + frac * Math.PI * 2 - gapA / 2;
      if (a2 < a1) a2 = a1 + 0.001;
      var col = s.color || pal[i % pal.length];
      var large = (a2 - a1) > Math.PI ? 1 : 0;
      var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      var x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      g += '<path' + anim('sc-slice', i * 80) + ' d="M' + x1.toFixed(2) + ',' + y1.toFixed(2) +
        ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) +
        '" fill="none" stroke="' + col + '" stroke-width="' + thick + '"/>';
      ang += frac * Math.PI * 2;
    });
    var svg = svgWrap(size, size, g, { height: o.height || size, par: 'xMidYMid meet' });
    if (o.centerValue != null || o.centerLabel != null) {
      return '<div class="stx-donut-wrap" style="width:' + size + 'px;max-width:100%">' + svg +
        '<div class="stx-donut-center"><div class="dc-v">' + esc(o.centerValue || '') + '</div>' +
        '<div class="dc-k">' + esc(o.centerLabel || '') + '</div></div></div>';
    }
    return svg;
  }

  // ---------- deterministic avatar hue ----------
  function monogramColor(seed) {
    var pal = palette(), h = 0; seed = String(seed);
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return pal[h % pal.length];
  }

  // ---------- legend helper ----------
  function legend(items) {
    return '<div class="stx-legend2">' + items.map(function (it) {
      return '<span class="lg"><i style="background:' + it.color + '"></i>' + esc(it.label) +
        (it.value != null ? '<b>' + esc(it.value) + '</b>' : '') + '</span>';
    }).join('') + '</div>';
  }

  window.StoicCharts = {
    sparkline: sparkline, line: line, area: area, stackedArea: stackedArea,
    bar: bar, groupedBar: groupedBar, donut: donut,
    monogramColor: monogramColor, legend: legend, palette: palette
  };
})();
