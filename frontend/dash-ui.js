/* ════════════════════════════════════════════════════════════════════════
   signal-ui.js · Stoic — cursor (Pass-3) + scroll (Pass-4) enhancement layer
   ----------------------------------------------------------------------------
   PURE progressive enhancement. Never changes a datum or a layout box — only
   chrome. With JS disabled, no scroll-timeline support, or motion off, the
   dense Pass-1 layout stays fully visible and legible.

   • POINTER block — hard-gated pointer:fine + no-reduced-motion (touch users skip).
   • SCROLL block  — runs for everyone (touch scrolls too); the only motion that
     could matter is killed by the global prefers-reduced-motion safety net, and
     each effect degrades to the static layout when unsupported.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // init() in index.html calls window.StoicUI.enhance(M) behind a guard — keep a no-op.
  window.StoicUI = { enhance: function () {} };

  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
  var fine = window.matchMedia &&
    matchMedia("(pointer:fine)").matches && !reduce;

  var root = document.documentElement;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ─────────── shared pointer bus (one passive listener; rAF writes vars) ─────────── */
  var pX = 0, pY = 0, seen = false;
  // pointer coords are only needed by the POINTER block; the rAF loop below is shared.
  if (fine) {
    document.addEventListener("pointermove", function (e) {
      pX = e.clientX; pY = e.clientY; seen = true;   // NO setProperty in the raw event
    }, { passive: true });

    // A · group spotlight (one delegated handler on the bento, not per-card)
    var bento = document.querySelector(".bento");
    if (bento) {
      bento.addEventListener("pointermove", function (e) {
        var card = e.target.closest && e.target.closest(".card");
        if (!card || !bento.contains(card)) return;
        var r = card.getBoundingClientRect();
        card.style.setProperty("--px", ((e.clientX - r.left) / r.width * 100).toFixed(2) + "%");
        card.style.setProperty("--py", ((e.clientY - r.top) / r.height * 100).toFixed(2) + "%");
      }, { passive: true });
    }

    // B · 3D tilt — hero north-star tile ONLY (own --rx/--ry so it never clobbers spotlight)
    var hero = document.querySelector(".c-hero");
    var heroInner = hero && hero.querySelector(".hero-inner");
    if (hero && heroInner) {
      hero.addEventListener("pointermove", function (e) {
        var r = hero.getBoundingClientRect();
        hero.style.setProperty("--rx", clamp((e.clientX - r.left) / r.width, 0, 1).toFixed(4));
        hero.style.setProperty("--ry", clamp((e.clientY - r.top) / r.height, 0, 1).toFixed(4));
      }, { passive: true });
      hero.addEventListener("pointerenter", function () { heroInner.style.willChange = "transform"; });
      hero.addEventListener("pointerleave", function () {
        hero.style.removeProperty("--rx"); hero.style.removeProperty("--ry");
        heroInner.style.willChange = "";
      });
    }

    // C · magnetic CTA — #copy-btn ONLY (≤10px throw, lerped in the shared rAF)
    var cta = document.querySelector("#copy-btn");
    var tx = 0, ty = 0, mx = 0, my = 0, ctaActive = false;
    if (cta) {
      cta.addEventListener("pointermove", function (e) {
        var r = cta.getBoundingClientRect();
        tx = clamp((e.clientX - (r.left + r.width / 2)) * 0.2, -10, 10);
        ty = clamp((e.clientY - (r.top + r.height / 2)) * 0.2, -10, 10);
      }, { passive: true });
      cta.addEventListener("pointerenter", function () { ctaActive = true; cta.style.willChange = "transform"; });
      cta.addEventListener("pointerleave", function () { ctaActive = false; tx = 0; ty = 0; });
    }

    var lastX = null, lastY = null;
    (function loop() {
      if (seen && (pX !== lastX || pY !== lastY)) {
        root.style.setProperty("--mx", pX + "px");
        root.style.setProperty("--my", pY + "px");
        lastX = pX; lastY = pY;
      }
      if (cta) {
        mx += (tx - mx) * 0.18; my += (ty - my) * 0.18;
        if (!ctaActive && Math.abs(mx) < 0.05 && Math.abs(my) < 0.05) {
          if (cta.style.transform) { cta.style.transform = ""; cta.style.willChange = ""; }
          mx = 0; my = 0;
        } else {
          cta.style.transform = "translate(" + mx.toFixed(2) + "px," + my.toFixed(2) + "px)";
        }
      }
      requestAnimationFrame(loop);
    })();
  }

  /* ════════════ SCROLL block (Pass-4) — runs for everyone ════════════ */
  function supportsTimeline(fn) {
    return window.CSS && CSS.supports && CSS.supports("animation-timeline", fn);
  }

  // 1 + 4 · reading-progress meter + sticky condensed north-star.
  //   Driven by ONE rAF-throttled scroll handler, attached unconditionally. The pure-CSS
  //   scroll() timeline (in index.html) remains the no-JS path and, where a browser genuinely
  //   runs it, an active CSS animation cascades over this inline transform with no visible
  //   conflict (both track the same scroll). Where the timeline is unsupported OR present-but-
  //   inert, this handler keeps both elements live. Both are information chrome (not flourish),
  //   so they run for touch + reduced-motion too — the north-star slide is the only motion and
  //   the global reduced-motion safety net neutralises that transition.
  (function () {
    var prog = document.querySelector("#readprog");
    var bar = document.querySelector("#northstar");
    var heroCard = document.querySelector(".c-hero");
    if (!prog && !bar) return;
    var pending = false;
    function paint() {
      pending = false;
      var sy = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (prog) {
        var max = (document.documentElement.scrollHeight - document.documentElement.clientHeight) || 1;
        prog.style.transform = "scaleX(" + clamp(sy / max, 0, 1).toFixed(4) + ")";
      }
      if (bar && heroCard) {
        // show once the hero card's bottom edge has passed under the sticky top strip (~58px)
        bar.classList.toggle("show", heroCard.getBoundingClientRect().bottom < 58);
      }
    }
    window.addEventListener("scroll", function () {
      if (!pending) { pending = true; requestAnimationFrame(paint); }
    }, { passive: true });
    window.addEventListener("resize", function () {
      if (!pending) { pending = true; requestAnimationFrame(paint); }
    }, { passive: true });
    paint();
  })();

  // 2 · reveal-panel fallback — only when view() timelines are unsupported AND motion is allowed.
  //     When motion is reduced, panels stay visible (no .io added). When view() IS supported,
  //     CSS already handles it, so JS must NOT also animate (would double-fire).
  if (!reduce && !supportsTimeline("view()") && "IntersectionObserver" in window) {
    var panels = Array.prototype.slice.call(document.querySelectorAll(".reveal-panel"));
    panels.forEach(function (p, i) {
      p.classList.add("io");
      p.style.transitionDelay = ((i % 3) * 0.07).toFixed(2) + "s";   // stagger ≤ 80ms within a run
    });
    var rio = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("io-in"); rio.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    panels.forEach(function (p) { rio.observe(p); });
  }
})();
