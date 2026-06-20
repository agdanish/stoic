/* ============================================================
   Stoic — App Shell (sidebar + topbar) renderer
   Ported from Stoic's stoic-shell.js; rewritten for the crypto
   trading-signal product. RWA / Mantle / on-chain-underwriting copy
   dropped. Chain object swapped to BNB Smart Chain (chainId 0x38).

   Usage on a page:
     <body data-page="signal" data-mode="sample" data-theme="dark">
       <aside class="stx-side" id="stxSide"></aside>
       <div class="stx-content">
         <header class="stx-top" id="stxTop"></header>
         <main class="stx-main"> ...page content... </main>
       </div>
       <script src="signal-shell.js"></script>
   Exposes window.Stoic: { mode, setMode(), onMode(cb), config, short }.
   Mode bus: 'sample' (offline, no CMC key) | 'live' (needs a free CMC key).
   ============================================================ */
(function () {
  var CFG = window.STOIC_CONFIG || {};
  // BNB Smart Chain mainnet. Track 2 (Strategy Skills) needs NO chain writes —
  // this is only the network the OPTIONAL wallet picker offers to switch to so
  // the dashboard sits on-chain-correct for the BNB Hack. Nothing is signed.
  var BSC = {
    chainId: '0x38', // 56
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    blockExplorerUrls: ['https://bscscan.com']
  };

  // Single-page dashboard. Extra entries point at the actual repo artifacts so
  // a judge can jump from the desk to the Skill / backtest source.
  var NAV = [
    { id: 'signal',   label: 'Signal Desk',     href: 'index.html', icon: 'cpu' },
    { id: 'capsule',  label: 'Strategy Capsule', href: '#capsule',  icon: 'file' },
    { id: 'diverge',  label: 'Divergence',       href: '#diverge',  icon: 'activity' },
    { id: 'backtest', label: 'Backtest',         href: '#backtest', icon: 'bars' },
    { id: 'skill',    label: 'SKILL.md ↗',       href: '../skills/sentiment-divergence-regime/SKILL.md', icon: 'file' }
  ];

  var ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    bars: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    bolt: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>'
  };
  function svg(name, cls) {
    return '<svg viewBox="0 0 24 24" ' + (cls ? 'class="' + cls + '" ' : '') +
      'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || '') + '</svg>';
  }
  function short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }

  // ---------- global mode bus ----------
  // 'sample' = offline render from pinned fixtures (no CMC key); 'live' = would
  // read a live CMC MCP key (none present in this static build → stays sample).
  var listeners = [];
  var body = document.body;
  var Stoic = {
    config: CFG,
    short: short,
    get mode() { return body.getAttribute('data-mode') || 'sample'; },
    setMode: function (m) {
      if (m !== 'live' && m !== 'sample') return;
      body.setAttribute('data-mode', m);
      syncModeUI();
      listeners.forEach(function (cb) { try { cb(m); } catch (e) {} });
    },
    onMode: function (cb) { listeners.push(cb); return cb; }
  };
  window.Stoic = Stoic;

  // ---------- render sidebar ----------
  function renderSide() {
    var side = document.getElementById('stxSide');
    if (!side) return;
    var page = body.getAttribute('data-page') || '';
    // BNB-gold + blue + green stacked-bars mark (kept from Stoic; accent already BNB-gold).
    var logo = '<svg class="lg" viewBox="0 0 32 32"><rect x="5" y="20" width="22" height="4" rx="1" fill="#F0B90B"/>' +
      '<rect x="7" y="14" width="18" height="4" rx="1" fill="#5B8DEF"/><rect x="9" y="8" width="14" height="4" rx="1" fill="#16C784"/></svg>';
    var items = NAV.map(function (n) {
      var active = n.id === page ? ' class="active"' : '';
      var ext = n.href.indexOf('http') === 0 || (n.href.indexOf('#') !== 0 && n.href.indexOf('.html') > -1 && n.id === 'skill');
      var attr = ext ? ' target="_blank" rel="noopener"' : '';
      return '<a href="' + n.href + '"' + active + attr + '>' + svg(n.icon) +
        '<span>' + n.label + '</span></a>';
    }).join('');
    side.innerHTML =
      '<div class="stx-brand">' + logo + '<div>Stoic<small>Strategy Skill</small></div></div>' +
      '<nav class="stx-nav"><div class="sec">Desk</div>' + items + '</nav>' +
      '<div class="stx-side-foot"><div class="stx-agent"><span class="dot" id="stxAgentDot"></span>' +
      '<span>Skill <b>sentiment-divergence-regime</b></span></div></div>';
  }

  // ---------- render topbar ----------
  function pageTitle() {
    var page = body.getAttribute('data-page') || '';
    var n = NAV.filter(function (x) { return x.id === page; })[0];
    return n ? n.label : (document.title || 'Stoic');
  }
  function renderTop() {
    var top = document.getElementById('stxTop');
    if (!top) return;
    top.innerHTML =
      '<button class="stx-burger" id="stxBurger">' + svg('menu') + '</button>' +
      '<div class="crumb">Stoic <i>/</i>' + pageTitle() + '</div>' +
      '<div class="stx-search" id="stxSearch">' + svg('search') + '<span>BTC · ETH · BNB · jump to a section…</span><kbd>⌘K</kbd></div>' +
      '<div class="stx-top-r">' +
        '<div class="stx-prov" title="Data provenance"><span><i class="c1"></i>Live CMC</span><span><i class="c2"></i>Engine</span><span><i class="c3"></i>Sample</span></div>' +
        '<div class="stx-mode" id="stxMode"><button data-m="live">LIVE</button><button data-m="sample">SAMPLE</button></div>' +
        '<button class="stx-ic" id="stxBell" title="Notices">' + svg('bell') + '<span class="n">1</span></button>' +
        '<button class="stx-wallet" id="stxWallet"><span class="dot"></span><span id="stxWalletTxt">Connect wallet</span></button>' +
      '</div>';
    // inject the sample-mode banner right after the topbar if not present
    var content = top.parentNode;
    if (content && !content.querySelector('.stx-replay-banner')) {
      var b = document.createElement('div');
      b.className = 'stx-replay-banner';
      b.innerHTML = '<span class="rb-ic">' + svg('bolt') + '</span>' +
        '<b>SAMPLE</b>' +
        '<span class="rb-txt">Live regime / signal fields are rendered from pinned CMC fixtures — needs your free CMC key for live reads. Backtest KPIs below are REAL Binance data.</span>' +
        '<span class="rb-hint">Add a CMC key for LIVE ↑</span>';
      top.insertAdjacentElement('afterend', b);
    }
  }

  // ---------- mode UI sync ----------
  function syncModeUI() {
    var m = Stoic.mode;
    var wrap = document.getElementById('stxMode');
    if (wrap) wrap.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-m') === m);
    });
  }

  // ---------- wallet (OPTIONAL — purely cosmetic for Track 2; no tx is signed) ----------
  var wallet = { addr: null, connected: false, wrongNet: false };
  var activeProvider = null;
  var eip6963 = []; // discovered { info:{uuid,name,icon,rdns}, provider }

  function discoverWallets() {
    try {
      window.addEventListener('eip6963:announceProvider', function (e) {
        var d = e.detail;
        if (d && d.info && d.provider && !eip6963.some(function (p) { return p.info.uuid === d.info.uuid; })) {
          eip6963.push(d);
          var m = document.getElementById('stxWalletModal');
          if (m && m.classList.contains('open')) renderWalletList();
        }
      });
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch (e) {}
  }

  function paintWallet() {
    var el = document.getElementById('stxWallet');
    var txt = document.getElementById('stxWalletTxt');
    if (!el || !txt) return;
    el.classList.toggle('connected', wallet.connected && !wallet.wrongNet);
    el.classList.toggle('wrongnet', wallet.wrongNet);
    txt.textContent = wallet.wrongNet ? 'Wrong network' : (wallet.connected ? short(wallet.addr) : 'Connect wallet');
  }

  async function connectWithProvider(provider, label) {
    provider = provider || window.ethereum;
    if (!provider) { window.open('https://ethereum.org/en/wallets/find-wallet/', '_blank', 'noopener'); return; }
    try {
      var accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts.length) return;
      activeProvider = provider;
      wallet.addr = accounts[0]; wallet.connected = true; wallet.label = label || '';
      var chainId = await provider.request({ method: 'eth_chainId' });
      if (chainId !== BSC.chainId) {
        try {
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BSC.chainId }] });
          wallet.wrongNet = false;
        } catch (switchErr) {
          if (switchErr && switchErr.code === 4902) {
            await provider.request({ method: 'wallet_addEthereumChain', params: [BSC] });
            wallet.wrongNet = false;
          } else { wallet.wrongNet = true; }
        }
      } else { wallet.wrongNet = false; }
      watchProvider(provider);
      closeWalletModal();
      paintWallet();
    } catch (err) { /* user rejected */ }
  }

  function watchProvider(p) {
    if (!p || !p.on) return;
    p.on('chainChanged', function (cid) { wallet.wrongNet = wallet.connected && cid !== BSC.chainId; paintWallet(); });
    p.on('accountsChanged', function (a) {
      if (!a || !a.length) { wallet.connected = false; wallet.addr = null; }
      else wallet.addr = a[0];
      paintWallet();
    });
  }

  var RECOMMENDED = [
    { name: 'MetaMask',        rdns: 'io.metamask',        url: 'https://metamask.io/download',     color: '#F6851B', glyph: 'M' },
    { name: 'Trust Wallet',    rdns: 'com.trustwallet.app', url: 'https://trustwallet.com/download', color: '#3375BB', glyph: 'T' },
    { name: 'OKX Wallet',      rdns: 'com.okex.wallet',    url: 'https://www.okx.com/web3',         color: '#111111', glyph: 'O' },
    { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet', url: 'https://www.coinbase.com/wallet',  color: '#0052FF', glyph: 'C' },
    { name: 'Rabby',           rdns: 'io.rabby',           url: 'https://rabby.io',                 color: '#7084FF', glyph: 'R' }
  ];
  function glyphAvatar(g, c) { return '<span class="stx-wglyph" style="background:' + c + '">' + g + '</span>'; }
  var WALLET_ICONS = {
    'io.metamask': '<svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#F6851B"/><path d="M16 7l-6 4 2 5 4 2 4-2 2-5z" fill="#fff" opacity=".95"/><path d="M10 11l-3 9 4 2 1-4zm12 0l3 9-4 2-1-4z" fill="#fff" opacity=".7"/></svg>',
    'com.trustwallet.app': '<svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3375BB"/><path d="M16 7l7 3v6c0 5-4 8-7 9-3-1-7-4-7-9v-6z" fill="#fff" opacity=".95"/></svg>',
    'com.okex.wallet': '<svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111"/><g fill="#fff"><rect x="7" y="7" width="6" height="6"/><rect x="19" y="7" width="6" height="6"/><rect x="13" y="13" width="6" height="6"/><rect x="7" y="19" width="6" height="6"/><rect x="19" y="19" width="6" height="6"/></g></svg>',
    'com.coinbase.wallet': '<svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0052FF"/><circle cx="16" cy="16" r="9" fill="none" stroke="#fff" stroke-width="3.4"/><rect x="13" y="13" width="6" height="6" rx="1.5" fill="#fff"/></svg>',
    'io.rabby': '<svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7084FF"/><path d="M8 20c0-7 5-10 10-9 6 1 8 5 6 8s-12 4-16 1z" fill="#fff" opacity=".92"/><circle cx="13" cy="16" r="1.5" fill="#7084FF"/></svg>'
  };
  function brandIcon(r) { return WALLET_ICONS[r.rdns] || glyphAvatar(r.glyph, r.color); }

  function renderWalletList() {
    var el = document.getElementById('stxWalletList'); if (!el) return;
    var html = '', installed = {};
    if (eip6963.length) {
      html += '<div class="stx-wsec">Installed</div>';
      eip6963.forEach(function (p) {
        installed[p.info.rdns] = true;
        html += '<button class="stx-wrow" data-act="connect" data-uuid="' + p.info.uuid + '">' +
          '<span class="stx-wicon"><img src="' + p.info.icon + '" alt=""/></span>' +
          '<span class="stx-wname">' + p.info.name + '</span></button>';
      });
    } else if (window.ethereum) {
      html += '<div class="stx-wsec">Installed</div>' +
        '<button class="stx-wrow" data-act="injected"><span class="stx-wicon">' + glyphAvatar('◆', 'var(--ai)') +
        '</span><span class="stx-wname">Browser Wallet</span></button>';
    }
    var rec = RECOMMENDED.filter(function (r) { return !installed[r.rdns]; });
    if (rec.length) {
      html += '<div class="stx-wsec">Recommended</div>';
      rec.forEach(function (r) {
        html += '<button class="stx-wrow" data-act="install" data-url="' + r.url + '">' +
          '<span class="stx-wicon">' + brandIcon(r) + '</span>' +
          '<span class="stx-wname">' + r.name + '</span><span class="stx-wtag">Get ↗</span></button>';
      });
    }
    el.innerHTML = html;
  }

  function buildWalletModal() {
    if (document.getElementById('stxWalletModal')) { renderWalletList(); return; }
    var m = document.createElement('div');
    m.className = 'stx-wmodal'; m.id = 'stxWalletModal';
    m.innerHTML =
      '<div class="stx-wpanel">' +
        '<div class="stx-wleft">' +
          '<div class="stx-whead">Connect a Wallet</div>' +
          '<div class="stx-wlist" id="stxWalletList"></div>' +
          '<div class="stx-wnote">Optional — sits the desk on <b>BNB Smart Chain</b>. Track 2 is a strategy Skill; <b>no transaction is ever signed</b>.</div>' +
        '</div>' +
        '<div class="stx-wright">' +
          '<button class="stx-wclose" id="stxWalletClose" aria-label="Close">×</button>' +
          '<div class="stx-wq">What is a Wallet?</div>' +
          '<div class="stx-winfo"><span class="ic">' + svg('layers') + '</span>' +
            '<div><b>A home for your assets</b><p>A wallet holds the keys you use to sign on-chain actions. Stoic emits a strategy spec only — it never trades for you.</p></div></div>' +
          '<div class="stx-winfo"><span class="ic">' + svg('shield') + '</span>' +
            '<div><b>A new way to log in</b><p>No accounts or passwords — just connect your wallet.</p></div></div>' +
          '<a class="stx-btn gold stx-wget" href="https://ethereum.org/en/wallets/find-wallet/" target="_blank" rel="noopener">Get a Wallet</a>' +
          '<a class="stx-wlearn" href="https://ethereum.org/en/wallets/" target="_blank" rel="noopener">Learn More</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      if (e.target === m || e.target.closest('#stxWalletClose')) { closeWalletModal(); return; }
      var row = e.target.closest('.stx-wrow'); if (!row) return;
      var act = row.getAttribute('data-act');
      if (act === 'connect') {
        var found = eip6963.filter(function (p) { return p.info.uuid === row.getAttribute('data-uuid'); })[0];
        if (found) connectWithProvider(found.provider, found.info.name);
      } else if (act === 'injected') {
        connectWithProvider(window.ethereum, 'Browser Wallet');
      } else if (act === 'install') {
        window.open(row.getAttribute('data-url'), '_blank', 'noopener');
      }
    });
    renderWalletList();
  }
  function openWalletModal() { buildWalletModal(); document.getElementById('stxWalletModal').classList.add('open'); }
  function closeWalletModal() { var m = document.getElementById('stxWalletModal'); if (m) m.classList.remove('open'); }

  // ---------- sidebar drawer (burger) ----------
  function ensureBackdrop() {
    var bd = document.getElementById('stxSideBd');
    if (!bd) { bd = document.createElement('div'); bd.className = 'stx-side-bd'; bd.id = 'stxSideBd'; bd.addEventListener('click', closeSide); document.body.appendChild(bd); }
    return bd;
  }
  function toggleSide() { var s = document.getElementById('stxSide'); if (!s) return; var open = s.classList.toggle('open'); ensureBackdrop().classList.toggle('open', open); }
  function closeSide() { var s = document.getElementById('stxSide'); if (s) s.classList.remove('open'); var bd = document.getElementById('stxSideBd'); if (bd) bd.classList.remove('open'); }

  // ---------- command palette (search / ⌘K) — jumps to in-page sections ----------
  var PAL_TARGETS = [
    { label: 'Strategy Capsule', href: '#capsule', icon: 'file', tag: 'Section' },
    { label: 'Divergence signal', href: '#diverge', icon: 'activity', tag: 'Section' },
    { label: 'Backtest KPIs', href: '#backtest', icon: 'bars', tag: 'Section' },
    { label: 'Engine constants', href: '#constants', icon: 'cpu', tag: 'Section' },
    { label: 'SKILL.md', href: '../skills/sentiment-divergence-regime/SKILL.md', icon: 'file', tag: 'File ↗' },
    { label: 'report.json', href: '../backtest/report.json', icon: 'bars', tag: 'File ↗' }
  ];
  function buildPalette() {
    if (document.getElementById('stxPal')) return;
    var p = document.createElement('div'); p.className = 'stx-pal'; p.id = 'stxPal';
    p.innerHTML = '<div class="stx-pal-box">' +
      '<div class="stx-pal-in">' + svg('search') + '<input id="stxPalInput" type="text" placeholder="Jump to a section…" autocomplete="off"/><kbd>esc</kbd></div>' +
      '<div class="stx-pal-list" id="stxPalList"></div></div>';
    document.body.appendChild(p);
    p.addEventListener('click', function (e) {
      if (e.target === p) { closePalette(); return; }
      var row = e.target.closest('.stx-pal-row'); if (row) goTo(row.getAttribute('data-href'));
    });
    var input = document.getElementById('stxPalInput');
    input.addEventListener('input', function () { renderPalette(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var first = document.querySelector('.stx-pal-row'); if (first) goTo(first.getAttribute('data-href')); }
    });
  }
  function goTo(href) {
    if (!href) return;
    closePalette();
    if (href.indexOf('#') === 0) {
      var el = document.querySelector(href);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    if (href.indexOf('.html') > -1 || href.indexOf('.json') > -1 || href.indexOf('.md') > -1) {
      window.open(href, '_blank', 'noopener'); return;
    }
    window.location.href = href;
  }
  function renderPalette(q) {
    q = (q || '').toLowerCase().trim();
    var hits = PAL_TARGETS.filter(function (n) { return !q || n.label.toLowerCase().indexOf(q) > -1; });
    var html = '';
    if (hits.length) {
      html += '<div class="stx-pal-sec">Go to</div>';
      hits.forEach(function (n) {
        html += '<button class="stx-pal-row" data-href="' + n.href + '"><span class="ic">' + svg(n.icon) + '</span><span class="nm">' + n.label + '</span><span class="tag">' + n.tag + '</span></button>';
      });
    }
    document.getElementById('stxPalList').innerHTML = html || '<div class="stx-pal-empty">No matches</div>';
  }
  function openPalette() {
    buildPalette();
    document.getElementById('stxPal').classList.add('open');
    renderPalette('');
    var i = document.getElementById('stxPalInput'); i.value = ''; setTimeout(function () { i.focus(); }, 30);
  }
  function closePalette() { var p = document.getElementById('stxPal'); if (p) p.classList.remove('open'); }

  // ---------- in-app toast ----------
  function showToast(title, items, opts) {
    opts = opts || {};
    var host = document.getElementById('stxToastHost');
    if (!host) {
      host = document.createElement('div'); host.id = 'stxToastHost';
      host.style.cssText = 'position:fixed;top:66px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:10px;max-width:340px';
      document.body.appendChild(host);
    }
    var t = document.createElement('div');
    t.style.cssText = 'background:var(--bg2,#15171c);border:1px solid var(--border,#2a2d35);border-left:3px solid ' + (opts.accent || 'var(--c4,#F0B90B)') + ';border-radius:10px;padding:11px 13px;box-shadow:0 10px 28px rgba(0,0,0,.4);color:var(--text,#e8eaed);font-size:.82rem;opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease';
    var head = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:' + (items && items.length ? '6px' : '0') + '"><strong style="font-size:.84rem">' + title + '</strong><span style="cursor:pointer;color:var(--muted,#8b8f98);font-size:1.05rem;line-height:1" data-close>&times;</span></div>';
    var bodyHtml = (items && items.length) ? '<ul style="margin:0;padding-left:16px;color:var(--text2,#c3c6cc);display:flex;flex-direction:column;gap:3px">' + items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>' : '';
    t.innerHTML = head + bodyHtml;
    t.querySelector('[data-close]').addEventListener('click', function () { t.remove(); });
    host.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    if (opts.ttl !== 0) setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(-6px)'; setTimeout(function () { t.remove(); }, 250); }, opts.ttl || 6000);
  }
  window.StoicToast = showToast;

  // ---------- wire ----------
  function wire() {
    var modeWrap = document.getElementById('stxMode');
    if (modeWrap) modeWrap.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (b) Stoic.setMode(b.getAttribute('data-m'));
    });
    var w = document.getElementById('stxWallet');
    if (w) w.addEventListener('click', openWalletModal);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeWalletModal(); closeSide(); closePalette(); } });
    var burger = document.getElementById('stxBurger');
    if (burger) burger.addEventListener('click', toggleSide);
    var side = document.getElementById('stxSide');
    if (side) side.addEventListener('click', function (e) {
      var a = e.target.closest('a'); if (!a) return;
      var href = a.getAttribute('href');
      if (href && href.indexOf('#') === 0) { e.preventDefault(); goTo(href); }
      closeSide();
    });
    var bell = document.getElementById('stxBell');
    if (bell) bell.addEventListener('click', function () {
      showToast('Notices · 1', [
        'SAMPLE mode — live CMC regime/signal needs your free CMC key (pro.coinmarketcap.com). Backtest KPIs are REAL Binance data.'
      ], { accent: 'var(--c4,#F0B90B)' });
    });
    var search = document.getElementById('stxSearch');
    if (search) search.addEventListener('click', openPalette);
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
    });
  }

  function init() {
    try { if (new URLSearchParams(location.search).has('embed')) { document.documentElement.classList.add('stx-embed'); return; } } catch (e) {}
    renderSide();
    renderTop();
    syncModeUI();
    paintWallet();
    discoverWallets();
    wire();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
