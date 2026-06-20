/* ============================================================
   Stoic — UI components (window.StoicUI)
   Shared, reference-style ("OnlyGenius") building blocks so every page
   renders identical KPI cards, card headers, and pills → uniform look.
   Dependency-free; returns HTML strings. Load after stoic-charts.js.
   ============================================================ */
(function () {
  var ICONS = {
    dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="M16.71 13.88l.7.71-2.82 2.82"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    award: '<circle cx="12" cy="8" r="7"/><path d="M8.21 13.89L7 23l5-3 5 3-1.21-9.12"/>',
    trendingUp: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    trendingDown: '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    bars: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    gauge: '<path d="M12 13l4-4"/><circle cx="12" cy="13" r="9"/><path d="M3.3 9h2M18.7 9h2M12 4v0"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>'
  };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || ICONS.activity) + '</svg>';
  }
  // items: [{icon,label,value|valueHtml,delta,dir:'up'|'down',sub,accent,accentDim}]
  function kpiCards(items) {
    return items.map(function (t) {
      var acc = t.accent || 'var(--ai)';
      var accDim = t.accentDim || 'var(--surface2)';
      var dl;
      if (t.delta != null) dl = '<div class="dl ' + (t.dir || 'up') + '"><b>' + esc(t.delta) + '</b> ' + esc(t.sub || '') + '</div>';
      else dl = '<div class="dl">' + esc(t.sub || '') + '</div>';
      return '<div class="stx-kpi2" style="--accent:' + acc + ';--accent-dim:' + accDim + '">' +
        '<div class="top"><span class="ic">' + icon(t.icon || 'activity') + '</span><span class="lbl">' + esc(t.label) + '</span></div>' +
        '<div class="val">' + (t.valueHtml || esc(t.value)) + '</div>' + dl + '</div>';
    }).join('');
  }
  function period(label) {
    return '<span class="stx-period">' + esc(label || 'Last 6 months') + icon('chevronDown') + '</span>';
  }
  function statusPill(text, kind) {
    return '<span class="stx-badge ' + (kind || 'ok') + '">' + esc(text) + '</span>';
  }
  window.StoicUI = { ICONS: ICONS, icon: icon, kpiCards: kpiCards, period: period, statusPill: statusPill };
})();
