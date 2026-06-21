/* ============================================================
   Stoic — Landing motion controllers (vanilla)
   Adapted from the Strata landing kit (ld-* system). Motion patterns
   inspired by Skiper UI, ported to vanilla CSS/JS. No external data
   module: the hero / popover figures are hand-built static SVG so every
   number on the page is grounded and nothing is animated as a "live" claim.
   ============================================================ */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---------- nav: blur on scroll + mobile drawer ----------
  function initNav() {
    var nav = $('.ld-nav');
    if (!nav) return;
    var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 20); };
    onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
    var burger = $('.ld-burger'), drawer = $('.ld-drawer');
    if (burger && drawer) {
      burger.addEventListener('click', function () {
        var open = burger.classList.toggle('open'); drawer.classList.toggle('open', open);
      });
      $$('a', drawer).forEach(function (a) { a.addEventListener('click', function () { burger.classList.remove('open'); drawer.classList.remove('open'); }); });
    }
  }

  // ---------- scroll reveal ----------
  function inView(el, slack) { var r = el.getBoundingClientRect(); return r.top < (window.innerHeight * (slack || 0.92)) && r.bottom > 0; }
  function initReveal() {
    var els = $$('.ld-reveal, .ld-stagger');
    document.documentElement.classList.add('ld-js'); // enables the hidden->animate states (content is visible without this)
    if (!('IntersectionObserver' in window) || reduce) { els.forEach(function (e) { e.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e) { if (inView(e)) e.classList.add('in'); else io.observe(e); }); // above-the-fold reveals instantly
  }

  // ---------- count up ----------
  function initCounts() {
    var els = $$('[data-count]');
    if (reduce) { els.forEach(function (e) { e.textContent = (+e.getAttribute('data-count')).toFixed(e.getAttribute('data-dec') | 0) + (e.getAttribute('data-suffix') || ''); }); return; }
    var run = function (el) {
      if (el._ran) return; el._ran = true;
      var target = parseFloat(el.getAttribute('data-count')), suffix = el.getAttribute('data-suffix') || '';
      var dec = (el.getAttribute('data-dec') | 0), t0 = null, dur = 1200, fin = target.toFixed(dec) + suffix;
      var failsafe = setTimeout(function () { el.textContent = fin; }, 1400); // shows final even if rAF is throttled
      var step = function (ts) {
        if (!t0) t0 = ts; var p = Math.min((ts - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
        el.textContent = (target * e).toFixed(dec) + suffix;
        if (p < 1) requestAnimationFrame(step); else { clearTimeout(failsafe); el.textContent = fin; }
      };
      requestAnimationFrame(step);
    };
    if (!('IntersectionObserver' in window)) { els.forEach(run); return; }
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { run(e.target); io.unobserve(e.target); } }); }, { threshold: 0.6 });
    els.forEach(function (e) { if (inView(e, 1)) run(e); else io.observe(e); }); // in-view counters start immediately
  }

  // ---------- hero / popover: a STATIC, hand-built drawdown-equity figure ----------
  // Honest by construction: schematic shapes of the held-out 2026 bear — Stoic's
  // line stays shallow (max-DD 17.7%) while Buy & Hold collapses (max-DD 58.3%).
  // Not a live feed, not animated as a claim; only the draw-in is decorative.
  function drawdownSVG(w, h) {
    var P = { x0: 40, y0: 18, w: w - 58, h: h - 52 };
    var X = function (t) { return P.x0 + t * P.w; };                 // t in [0,1]
    var Y = function (v) { return P.y0 + (1 - v) * P.h; };           // v in [0,1] (1=top/peak, 0=floor)
    // Buy & Hold: rides up a touch then collapses through the bear to ~ -43.5% return / 58.3% DD.
    var bh = [[0,.62],[.10,.70],[.18,.66],[.27,.74],[.36,.55],[.46,.42],[.57,.30],[.68,.20],[.79,.16],[.90,.20],[1,.18]];
    // Stoic: rides early, then goes FLAT through the storm — shallow drawdown, ends roughly flat.
    var st = [[0,.62],[.10,.69],[.18,.66],[.27,.71],[.36,.62],[.46,.60],[.57,.585],[.68,.60],[.79,.595],[.90,.61],[1,.60]];
    var pts = function (a) { return a.map(function (d) { return X(d[0]).toFixed(1) + ',' + Y(d[1]).toFixed(1); }).join(' '); };
    var g = '';
    [0, .25, .5, .75, 1].forEach(function (v) { var y = Y(v); g += '<line x1="' + P.x0 + '" y1="' + y.toFixed(1) + '" x2="' + (P.x0 + P.w) + '" y2="' + y.toFixed(1) + '" stroke="var(--border)"/>'; });
    // peak reference line + the B&H drawdown band (peak -> trough)
    g += '<line x1="' + P.x0 + '" y1="' + Y(.74).toFixed(1) + '" x2="' + (P.x0 + P.w) + '" y2="' + Y(.74).toFixed(1) + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 4"/>';
    g += '<text x="' + (P.x0 + 4) + '" y="' + (Y(.74) - 5).toFixed(1) + '" fill="var(--muted)" font-family="var(--mono)" font-size="9">peak</text>';
    // red drawdown wedge under B&H
    var band = 'M ' + X(0).toFixed(1) + ' ' + Y(.74).toFixed(1) + ' L ' + bh.map(function (d) { return X(d[0]).toFixed(1) + ' ' + Y(d[1]).toFixed(1); }).join(' L ') + ' L ' + X(1).toFixed(1) + ' ' + Y(.74).toFixed(1) + ' Z';
    g += '<path d="' + band + '" fill="var(--red-dim)"/>';
    // lines
    g += '<polyline class="ld-pl ld-pl-st" points="' + pts(bh) + '" fill="none" stroke="var(--red)" stroke-width="2.4"/>';
    g += '<polyline class="ld-pl ld-pl-ai" points="' + pts(st) + '" fill="none" stroke="var(--ai)" stroke-width="2.8"/>';
    // end dots + DD callouts
    g += '<circle cx="' + X(1).toFixed(1) + '" cy="' + Y(.18).toFixed(1) + '" r="3.2" fill="var(--red)"/>';
    g += '<circle cx="' + X(1).toFixed(1) + '" cy="' + Y(.60).toFixed(1) + '" r="3.2" fill="var(--ai)"/>';
    g += '<text x="' + (X(.70)).toFixed(1) + '" y="' + (Y(.10)).toFixed(1) + '" fill="var(--red)" font-family="var(--mono)" font-size="10" font-weight="700">B&amp;H max-DD 58.3%</text>';
    g += '<text x="' + (X(.40)).toFixed(1) + '" y="' + (Y(.50)).toFixed(1) + '" fill="var(--ai)" font-family="var(--mono)" font-size="10" font-weight="700">Stoic max-DD 17.7%</text>';
    return g;
  }
  function drawLoop(svg) {
    if (!svg) return;
    var pls = $$('.ld-pl', svg);
    pls.forEach(function (pl, i) {
      var len = 0; try { len = pl.getTotalLength(); } catch (e) { len = 1200; }
      if (reduce) { pl.style.strokeDasharray = 'none'; return; }
      pl.style.strokeDasharray = len; pl.style.strokeDashoffset = len;
      pl.animate([
        { strokeDashoffset: len, offset: 0 },
        { strokeDashoffset: 0, offset: 0.7 },
        { strokeDashoffset: 0, offset: 1 }
      ], { duration: 2600, iterations: 1, delay: i * 260, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' });
    });
  }

  // ---------- hero figure + popover ----------
  function initHero() {
    var fig = $('#ldHeroChart');
    if (fig) { fig.innerHTML = drawdownSVG(560, 240); drawLoop(fig); }
    var herofig = $('#ldHerofig'), cursor = $('#ldCursor');
    if (herofig && cursor && !reduce) {
      herofig.addEventListener('pointermove', function (e) {
        var b = herofig.getBoundingClientRect();
        cursor.style.left = (e.clientX - b.left) + 'px'; cursor.style.top = (e.clientY - b.top) + 'px'; cursor.style.opacity = '1';
      });
      herofig.addEventListener('pointerleave', function () { cursor.style.opacity = '0'; });
    }
    var pop = $('#ldPop'), popChart = $('#ldPopChart');
    var open = function () { if (!pop) return; if (popChart && !popChart.innerHTML) { popChart.innerHTML = drawdownSVG(1040, 560); drawLoop(popChart); } pop.classList.add('open'); document.body.style.overflow = 'hidden'; };
    var close = function () { if (!pop) return; pop.classList.remove('open'); document.body.style.overflow = ''; };
    if (herofig) herofig.addEventListener('click', open);
    $$('[data-watch]').forEach(function (b) { b.addEventListener('click', function (e) { e.preventDefault(); open(); }); });
    if (pop) { $('.ld-pop-bg', pop) && $('.ld-pop-bg', pop).addEventListener('click', close); $('.ld-pop-close', pop) && $('.ld-pop-close', pop).addEventListener('click', close); }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  // ---------- spine: lime green scroll ribbon ----------
  var SVGNS = 'http://www.w3.org/2000/svg';
  function apexCount(H) { return Math.max(4, Math.round(H / 520)); }
  function ribbonPath(W, H) {
    var segs = apexCount(H), midX = W * 0.5, ya = H / segs, d = 'M ' + midX.toFixed(1) + ' 0';
    for (var i = 1; i <= segs; i++) {
      var nx = (i % 2 === 1) ? W * 0.76 : W * 0.24, y0 = ya * (i - 1), y1 = ya * i;
      d += ' C ' + nx.toFixed(1) + ' ' + (y0 + ya * 0.5).toFixed(1) + ', ' + nx.toFixed(1) + ' ' + (y1 - ya * 0.5).toFixed(1) + ', ' + midX.toFixed(1) + ' ' + y1.toFixed(1);
    }
    return d;
  }
  function initSpine() {
    var spine = $('#ldSpine'), svg = $('#ldSpineSvg'), ribbon = $('#ldRibbon'), bg = $('#ldRibbonBg');
    if (!spine || !ribbon || !svg) return;
    var len = 0, dots = [];
    function build() {
      var W = spine.clientWidth, H = spine.clientHeight;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      var d = ribbonPath(W, H);
      ribbon.setAttribute('d', d); bg.setAttribute('d', d);
      try { len = ribbon.getTotalLength(); } catch (e) { len = H * 1.4; }
      ribbon.style.strokeDasharray = len;
      ribbon.style.strokeDashoffset = reduce ? 0 : len;
      dots.forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); }); dots = [];
      var segs = apexCount(H);
      for (var i = 1; i < segs; i++) {
        var pt; try { pt = ribbon.getPointAtLength(len * (i / segs)); } catch (e) { pt = { x: W / 2, y: H * i / segs }; }
        var c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', 5);
        c.setAttribute('fill', '#C2F84F'); c.setAttribute('class', 'ld-wp');
        c.style.opacity = reduce ? 1 : 0.15; c._frac = i / segs;
        svg.appendChild(c); dots.push(c);
      }
    }
    function onScroll() {
      if (reduce) return;
      var r = spine.getBoundingClientRect(), vh = window.innerHeight;
      var total = r.height - vh * 0.5;
      var p = total > 0 ? Math.max(0, Math.min(1, (vh * 0.55 - r.top) / total)) : 0;
      ribbon.style.strokeDashoffset = len * (1 - p);
      dots.forEach(function (c) { c.style.opacity = p >= c._frac ? 1 : 0.15; });
    }
    build(); onScroll();
    var ticking = false;
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; onScroll(); }); } }, { passive: true });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { build(); onScroll(); }, 150); });
    setTimeout(function () { build(); onScroll(); }, 700); // recompute after fonts/iframes settle
  }

  // ---------- hover-expand gallery (live dashboard previews via ?embed=1) ----------
  function initGallery() {
    var strips = $$('.ld-strip');
    if (!strips.length) return;
    var activate = function (s) {
      strips.forEach(function (x) { x.classList.toggle('active', x === s); });
      var fr = $('iframe.frame', s);
      if (fr && !fr.src && fr.getAttribute('data-src')) {
        var sc = +(fr.getAttribute('data-scroll') || 0);
        if (sc) fr.addEventListener('load', function () { try { fr.contentWindow.scrollTo(0, sc); } catch (e) {} });
        fr.src = fr.getAttribute('data-src'); // lazy-load on first activation
      }
    };
    strips.forEach(function (s, i) {
      s.addEventListener('mouseenter', function () { if (!('ontouchstart' in window)) activate(s); });
      s.addEventListener('click', function () { activate(s); });
      if (i === 0) activate(s);
    });
  }

  // ---------- honesty method-log (scroll-fade list) ----------
  function initFeed() {
    var box = $('#ldFeed'); if (!box) return;
    var ev = [
      ['tests', '<b>498 tests passing</b> · deterministic engine, no flakes'],
      ['types', '<b>tsc --noEmit</b> exit 0 — strict mode, zero <code>any</code>'],
      ['repro', 'reports are <b>byte-reproducible</b> — same input, same bytes'],
      ['safe', '<b>look-ahead-safe</b> walk-forward · read &lt; t, hold into t+1'],
      ['data', 'real keyless data: Binance daily BTC/ETH/BNB <b>~2.74yr</b>'],
      ['fng', 'regime read from <b>alternative.me</b> Fear &amp; Greed history'],
      ['sel', 'params selected <b>in-sample only</b> — OOS reported as-is'],
      ['abl', 'ablation: the <b>trend core</b> is the OOS earner'],
      ['abl2', 'F&amp;G gate ≈ rounding on OOS; divergence filter <b>inert</b> (honest)'],
      ['stress', 'beat survives <b>15+15</b> &amp; <b>25+25 bps</b> cost stress']
    ];
    box.innerHTML = ev.map(function (e) { return '<div class="row"><span class="ts">' + e[0] + '</span><span class="msg">' + e[1] + '</span></div>'; }).join('');
  }

  // ---------- CMC MCP terminal: real round-trip log + rise-on-scroll ----------
  // The hardcoded values below are the committed 2026-06-17 capture; they are the
  // graceful fallback. initLiveRegime() overwrites them in place with the LATEST
  // committed capture (manifest, auto-refreshed every 6h) when the fetch succeeds.
  function fgLabel(v) {
    if (v <= 24) return 'Extreme Fear';
    if (v <= 44) return 'Fear';
    if (v <= 55) return 'Neutral';
    if (v <= 74) return 'Greed';
    return 'Extreme Greed';
  }
  function fgGate(v) {
    // contrarian gate: low F&G → favour longs; high F&G → trim
    return v <= 44 ? 'favour longs' : (v >= 75 ? 'trim greed' : 'hold / neutral');
  }
  function initTerm() {
    var body = $('#ldTermBody'); if (!body) return;
    var L = [
      '<span class="c-p">$</span> <span class="c-cmd">stoic skill run sentiment-divergence-regime --symbol BTC</span>',
      '<span class="c-mut">CMC Agent Hub · MCP round-trip · keyed capture <span id="ldTermDate">2026-06-17</span></span>',
      '',
      '<span class="c-ai">→ search_cryptos</span>                        <span class="c-mut">resolve BTC / ETH / BNB</span>',
      '<span class="c-ai">→ get_crypto_quotes_latest</span>             <span class="c-mut">spot + 24h</span>',
      '<span class="c-ai">→ get_crypto_technical_analysis</span>        RSI(14) <span class="c-amber" id="ldTermRsi">41.85</span>',
      '<span class="c-ai">→ get_global_metrics_latest</span>           BTC.D <span class="c-amber" id="ldTermBtcd">58.26%</span>',
      '<span class="c-ai">→ get_global_crypto_derivatives_metrics</span> <span class="c-mut">funding / OI</span>',
      '<span class="c-ai">→ trending_crypto_narratives</span>          <span class="c-mut">crowd narratives</span>',
      '<span class="c-ai">→ get_crypto_metrics</span>                   <span class="c-mut">on-chain / supply</span>',
      '',
      '<span class="c-amber">Fear &amp; Greed = <span id="ldTermFg">23</span>  →  "<span id="ldTermFgLabel">Fear</span>"</span>   <span class="c-mut">(keyed capture · <span id="ldTermDate2">2026-06-17</span>)</span>',
      '<span class="c-ok">✓ regime gate: <span id="ldTermGate">FEAR → favour longs</span></span>  <span class="c-mut">· 7 tools wired</span>'
    ];
    body.innerHTML = L.join('\n');
  }

  // ---------- LIVE regime hydration (graceful fallback) ----------
  // Reads the LATEST committed capture from the manifest (auto-refreshed every 6h)
  // and updates the gauge + terminal + lead/date text IN PLACE. This is still a
  // committed snapshot, NOT a per-visitor real-time feed — wording stays honest.
  function fetchManifest(paths, i) {
    i = i || 0;
    if (i >= paths.length) return Promise.reject(new Error('not found'));
    return fetch(paths[i], { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return fetchManifest(paths, i + 1); });
  }
  function leaf(obj, path) {
    // safe deep read; returns the {value, available} node or null
    var cur = obj;
    for (var k = 0; k < path.length; k++) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[path[k]];
    }
    return cur;
  }
  function num(node) {
    // returns a finite number only when the leaf is available, else null
    if (!node || node.available === false) return null;
    var v = (typeof node === 'object') ? node.value : node;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  function fmtDate(iso) {
    // e.g. "2026-06-17T19:36:35.175Z" -> "2026-06-17 19:36 UTC"
    if (typeof iso !== 'string') return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }
  function setText(el, txt) { if (el && txt != null) el.textContent = txt; }
  function initLiveRegime() {
    // paths verified against the dashboard (index.html): ../fixtures works from
    // frontend/landing.html on GitHub Pages; the bare path is the project-root fallback.
    fetchManifest(['../fixtures/cmc/live/_manifest.json', 'fixtures/cmc/live/_manifest.json'])
      .then(function (man) {
        if (!man || typeof man !== 'object') return;
        var np = man.normalizedParse || {};
        var fg = num(leaf(np, ['get_global_metrics_latest', 'fearGreed']));
        var btcd = num(leaf(np, ['get_global_metrics_latest', 'btcDominance']));
        var rsi = num(leaf(np, ['get_crypto_technical_analysis', 'rsi']));
        var when = fmtDate(man.capturedAt);          // "YYYY-MM-DD HH:MM UTC"
        var dateOnly = when ? when.split(' ')[0] : null; // "YYYY-MM-DD"

        // ----- gauge (regime section) -----
        if (fg != null) {
          var label = fgLabel(fg);
          setText($('#regime .gv'), String(fg));
          setText($('#regime .gl'), label);
          setText($('#regime .gact'), '● gate action → ' + fgGate(fg));
          // needle geometry: angle = -(180 - 1.8*value) degrees, pivot (100,104)
          var needle = $('#regime .ld-gauge svg g');
          if (needle) {
            var ang = -(180 - 1.8 * fg);
            needle.setAttribute('transform', 'rotate(' + ang.toFixed(1) + ' 100 104)');
          }
          // a11y label on the gauge svg
          var gsvg = $('#regime .ld-gauge svg');
          if (gsvg) gsvg.setAttribute('aria-label', 'Fear and Greed gauge at ' + fg + ', ' + label);
        }

        // ----- "RSI(14) X · BTC dominance Y%" + date line in gauge copy -----
        var gp = $('#regime .gtxt p');
        if (gp && (rsi != null || btcd != null || when)) {
          var rsiTxt = rsi != null ? rsi.toFixed(2) : '41.85';
          var btcdTxt = btcd != null ? btcd.toFixed(2) : '58.26';
          var whenTxt = when || '2026-06-17 19:36 UTC';
          var labelLow = (fg != null ? fgLabel(fg) : 'Fear');
          gp.innerHTML = 'This keyed capture (' + whenTxt + '): RSI(14) <b>' + rsiTxt +
            '</b> · BTC dominance <b>' + btcdTxt + '%</b>. In ' + labelLow +
            ', the contrarian gate leans into the directional core.';
        }

        // ----- lead paragraph "capture from <date>" + Fear/Greed read -----
        var lead = $('#regime .ld-lead');
        if (lead && (dateOnly || fg != null)) {
          var dTxt = dateOnly || '2026-06-17';
          var readTxt = fg != null ? fgLabel(fg) : 'Fear';
          var stance = (fg != null && fg > 55) ? 'trims into greed' : 'favours longs';
          lead.innerHTML = 'A real keyed MCP round-trip across 7 wired tools — a committed ' +
            '<b>capture from ' + dTxt + '</b> (a snapshot, not a real-time feed). ' +
            'This capture reads <b>' + readTxt + '</b>, so the contrarian gate ' + stance + '.';
        }

        // ----- terminal -----
        if (fg != null) {
          setText($('#ldTermFg'), String(fg));
          setText($('#ldTermFgLabel'), fgLabel(fg));
          var gateWord = (fg <= 44) ? 'FEAR → favour longs'
            : (fg >= 75 ? 'GREED → trim' : 'NEUTRAL → hold');
          // "✓ regime gate: " prefix lives in initTerm's static text; this span holds only the verdict
          setText($('#ldTermGate'), gateWord);
        }
        if (rsi != null) setText($('#ldTermRsi'), rsi.toFixed(2));
        if (btcd != null) setText($('#ldTermBtcd'), btcd.toFixed(2) + '%');
        if (dateOnly) { setText($('#ldTermDate'), dateOnly); setText($('#ldTermDate2'), dateOnly); }

        // ----- hero badge + chip + hero badge dot (Fear & Greed = N (Label)) -----
        if (fg != null) {
          var lbl = fgLabel(fg);
          var badge = $('.ld-badge');
          if (badge) {
            // preserve the leading dot span, replace the trailing text node
            var dot = badge.querySelector('.dot');
            badge.innerHTML = '';
            if (dot) badge.appendChild(dot);
            badge.appendChild(document.createTextNode(' BNB Hack · AI Trading Agent Edition · Fear & Greed = ' + fg + ' (' + lbl + ')'));
          }
          // hero chip counter "Fear & Greed N" — update the live target + shown text.
          // initCounts() may have already animated to the old value; assert the live
          // value now and once more on the next tick so we win any in-flight count-up.
          var chip = $('.ld-chips .ld-chip:last-child b[data-count]');
          if (chip) {
            chip.setAttribute('data-count', String(fg));
            chip.textContent = String(fg);
            setTimeout(function () { chip.textContent = String(fg); }, 1500);
          }
        }
      })
      .catch(function () { /* offline / missing → keep committed-snapshot fallback values */ });
  }
  function initTermRise() {
    var t = $('#ldTerm'); if (!t) return;
    if (reduce) { t.style.transform = 'none'; t.style.opacity = '1'; return; }
    var frame = function () {
      var r = t.getBoundingClientRect(), vh = window.innerHeight || 800;
      var p = (vh - r.top) / (vh * 0.72); p = Math.max(0, Math.min(1, p));
      t.style.transform = 'perspective(1400px) translateY(' + ((1 - p) * 90).toFixed(1) + 'px) scale(' + (0.92 + p * 0.08).toFixed(3) + ')';
      t.style.opacity = (0.3 + p * 0.7).toFixed(2);
    };
    var ticking = false;
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; frame(); }); } }, { passive: true });
    window.addEventListener('resize', frame);
    frame();
  }

  function init() { initNav(); initReveal(); initCounts(); initHero(); initTerm(); initLiveRegime(); initTermRise(); initSpine(); initGallery(); initFeed(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
