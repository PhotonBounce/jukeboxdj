/* ═══════════════════════════════════════════════════════════════════════════
   JukeboxDJ · Pro / monetization
   Free: a 1-day trial of the full rig (per device — no account, no registration).
   After the trial, unlock Pro to keep playing. One-time unlock, this device.

   Payment: crypto, Cash App, bank wire, or check — HONOR-BASED (no backend
   watches the chains/rails yet). Nothing sensitive (wallet address, Cash App
   cashtag) is shown until the visitor taps that method to pay.

   Android app: Pro is INCLUDED (the shell tags its UA "JukeboxDJApp"). Google
   Play forbids alt-billing for digital goods, so NO payment UI ever appears in
   the app — it auto-unlocks and the paywall never shows.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.JBPro) return;   // idempotence: never wire two panels

  var KEY = "jbdj.pro.v2";
  var FREE_REC_SEC = 90;
  var TRIAL_MS = 24 * 60 * 60 * 1000;   // 1 day
  var PRICE = "$6.99";                    // one-time unlock, per device

  function loadState () {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function saveState (s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }

  var state = loadState();
  if (typeof state !== "object" || state === null) state = {};
  if (typeof state.pro !== "boolean") state.pro = false;

  function isApp () { return /JukeboxDJApp/.test(navigator.userAgent); }

  /* start the free trial clock on first ever visit */
  function ensureTrial () {
    if (!state.trialStart) { state.trialStart = Date.now(); saveState(state); }
  }
  function trialMsLeft () {
    if (!state.trialStart) return TRIAL_MS;
    return Math.max(0, state.trialStart + TRIAL_MS - Date.now());
  }
  function trialActive () { return trialMsLeft() > 0; }
  function isPro () { return isApp() || state.pro === true; }
  /* full access = paid, in the app, or still inside the free day */
  function hasAccess () { return isPro() || trialActive(); }

  /* ── payment rails (Photon Bounce) ── */
  var EVM = "0x75B30d0dE751D9628510f3cb273F09f7137f9E3F";
  var CHAINS = [
    { key: "evm",  icon: "⟠", name: "Ethereum & EVM", sub: "ETH · BNB · Polygon · Base · Arbitrum · Optimism", addr: EVM, uri: "ethereum:" + EVM },
    { key: "btc",  icon: "₿", name: "Bitcoin",  sub: "BTC · native segwit", addr: "bc1qn67f2d50wng6h83cxsk7kc55yux7kv4l6dugrx", uri: "bitcoin:bc1qn67f2d50wng6h83cxsk7kc55yux7kv4l6dugrx" },
    { key: "sol",  icon: "◎", name: "Solana",   sub: "SOL · SPL", addr: "5i6AY6jYFhGj2KThPQZiWtSV7jAQRZjtSvv2vfHmuQiU", uri: "solana:5i6AY6jYFhGj2KThPQZiWtSV7jAQRZjtSvv2vfHmuQiU" },
    { key: "tron", icon: "▟", name: "Tron",     sub: "TRX · USDT-TRC20", addr: "TGRDDVFkCD88qtAyjrHz5UhjjGoArhzwfK", uri: "tron:TGRDDVFkCD88qtAyjrHz5UhjjGoArhzwfK" }
  ];
  var CASHTAG = "$photonbounce";

  function el (tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function toast (m) { if (window.JBToast) window.JBToast(m); }
  function copy (text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; } } catch (e) {}
    try { var t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); } catch (e) {}
  }
  function renderQR (box, text) {
    box.innerHTML = "";
    if (typeof window.QRCode === "undefined") return;
    try { new window.QRCode(box, { text: text, width: 132, height: 132, colorDark: "#0B0B1E", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M }); } catch (e) {}
  }

  function unlock (via) {
    state.pro = true; state.via = via || "unlock"; state.t = Date.now();
    saveState(state); reflect(); closePanel();
    toast("★ JukeboxDJ Pro unlocked on this device. Thank you for supporting Photon Bounce!");
  }

  /* ── panel ── */
  var overlay = null;
  function closePanel () { if (overlay) { overlay.remove(); overlay = null; } }

  function fmtLeft () {
    var ms = trialMsLeft(), h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? (h + "h " + m + "m") : (m + "m");
  }

  /* Each method reveals its pay details ONLY when tapped (nothing sensitive
     shown up front). */
  function renderMethod (key, body) {
    body.innerHTML = "";
    if (key === "crypto") {
      var chips = el("div", "pro-chips");
      var pay = el("div", "pro-pay");
      body.appendChild(chips); body.appendChild(pay);
      function showChain (chain) {
        Array.prototype.forEach.call(chips.children, function (c) { c.classList.toggle("on", c.dataset.k === chain.key); });
        pay.innerHTML = "";
        var qr = el("div", "pro-qr"); pay.appendChild(qr); renderQR(qr, chain.addr);
        var meta = el("div", "pro-pay-meta");
        meta.appendChild(el("div", "pro-chain-name", chain.icon + " " + chain.name + " <small>" + chain.sub + "</small>"));
        meta.appendChild(el("code", "pro-addr", chain.addr));
        var row = el("div", "pro-pay-row");
        var cp = el("button", "pro-btn ghost", "Copy address"); cp.addEventListener("click", function () { copy(chain.addr); toast("Address copied"); }); row.appendChild(cp);
        var lk = el("a", "pro-btn ghost", "Open in wallet"); lk.href = chain.uri; row.appendChild(lk);
        meta.appendChild(row); pay.appendChild(meta);
      }
      CHAINS.forEach(function (chain) { var c = el("button", "pro-chip", chain.icon + " " + chain.name.split(" ")[0]); c.dataset.k = chain.key; c.addEventListener("click", function () { showChain(chain); }); chips.appendChild(c); });
      showChain(CHAINS[0]);
    } else if (key === "cashapp") {
      var pay2 = el("div", "pro-pay");
      var qr2 = el("div", "pro-qr"); pay2.appendChild(qr2); renderQR(qr2, "https://cash.app/" + CASHTAG);
      var m2 = el("div", "pro-pay-meta");
      m2.appendChild(el("div", "pro-chain-name", "💵 Cash App"));
      m2.appendChild(el("code", "pro-addr", CASHTAG));
      var r2 = el("div", "pro-pay-row");
      var cp2 = el("button", "pro-btn ghost", "Copy cashtag"); cp2.addEventListener("click", function () { copy(CASHTAG); toast("Cashtag copied"); }); r2.appendChild(cp2);
      var lk2 = el("a", "pro-btn ghost", "Open Cash App"); lk2.href = "https://cash.app/" + CASHTAG; lk2.target = "_blank"; lk2.rel = "noopener"; r2.appendChild(lk2);
      m2.appendChild(r2); pay2.appendChild(m2); body.appendChild(pay2);
    } else if (key === "wire" || key === "check") {
      var label = key === "wire" ? "Bank wire" : "Check / money order";
      body.appendChild(el("div", "pro-chain-name", (key === "wire" ? "🏦 " : "✉️ ") + label));
      body.appendChild(el("p", "pro-sub", "Email <b>photon-bounce.com</b> for secure " + label.toLowerCase() +
        " instructions — mention <b>JukeboxDJ Pro</b> and the device you're unlocking."));
      var r3 = el("div", "pro-pay-row");
      var lk3 = el("a", "pro-btn ghost", "Contact photon-bounce.com"); lk3.href = "https://www.photon-bounce.com"; lk3.target = "_blank"; lk3.rel = "noopener"; r3.appendChild(lk3);
      body.appendChild(r3);
    }
  }

  function openPanel () {
    closePanel();
    ensureTrial();
    overlay = el("div", "pro-overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
    var card = el("div", "pro-card");
    overlay.appendChild(card);
    card.appendChild(el("button", "pro-close", "✕")).addEventListener("click", closePanel);
    card.appendChild(el("div", "pro-title", "★ Jukebox<i>DJ</i> Pro"));

    if (isApp()) {
      card.appendChild(el("div", "pro-active", "★ Pro is <b>included with the Android app</b>. Enjoy the booth."));
      document.body.appendChild(overlay); return;
    }
    if (isPro()) {
      card.appendChild(el("div", "pro-active", "★ Pro is <b>active on this device</b>. Thank you for the support!"));
      document.body.appendChild(overlay); return;
    }

    /* trial banner */
    if (trialActive()) {
      card.appendChild(el("div", "pro-trial ok", "🎁 <b>Free day in progress</b> — " + fmtLeft() + " left. Unlock now to keep playing after it ends."));
    } else {
      card.appendChild(el("div", "pro-trial end", "⏳ <b>Your free day has ended.</b> Unlock JukeboxDJ Pro to keep spinning."));
    }
    card.appendChild(el("div", "pro-price", PRICE + " <small>· one-time unlock · this device · no account, no subscription</small>"));

    var feats = el("ul", "pro-feats");
    ["<b>Keep the whole booth</b> — decks, scratching, FULL AUTO, the Jukebox, your own music",
     "<b>Unlimited</b> high-bitrate mix recording",
     "One-time unlock, remembered on this device. No login, no tracking"].forEach(function (f) { feats.appendChild(el("li", null, f)); });
    card.appendChild(feats);

    card.appendChild(el("div", "pro-sub", "Pick how you'd like to pay — details appear only when you tap a method:"));

    /* payment-method selector — reveals details on click */
    var methods = el("div", "pro-chips pay-methods");
    var body = el("div", "pro-method-body");
    card.appendChild(methods); card.appendChild(body);
    var METHODS = [
      { key: "crypto",  label: "⟠ Crypto" },
      { key: "cashapp", label: "💵 Cash App" },
      { key: "wire",    label: "🏦 Bank wire" },
      { key: "check",   label: "✉️ Check" }
    ];
    METHODS.forEach(function (mth) {
      var c = el("button", "pro-chip", mth.label); c.dataset.k = mth.key;
      c.addEventListener("click", function () {
        Array.prototype.forEach.call(methods.children, function (x) { x.classList.toggle("on", x === c); });
        renderMethod(mth.key, body);
      });
      methods.appendChild(c);
    });
    body.appendChild(el("p", "pro-hint", "↑ Tap a payment method above to reveal where to send it."));

    var sent = el("button", "pro-btn primary", "I've paid — unlock Pro");
    sent.addEventListener("click", function () { unlock("paid"); });
    card.appendChild(sent);
    card.appendChild(el("div", "pro-fine", "Honor-based for now (no on-chain / rail verification yet). Pro is remembered per device; clearing site data resets it. Questions? <a href='https://www.photon-bounce.com' target='_blank' rel='noopener'>photon-bounce.com</a>"));
    document.body.appendChild(overlay);
  }

  /* ── topbar chip ── */
  function reflect () {
    var btn = document.getElementById("btn-pro");
    if (!btn) return;
    if (isPro()) { btn.classList.add("pro-on"); btn.innerHTML = "★ PRO"; btn.title = isApp() ? "Pro — included with the app" : "Pro is active on this device"; }
    else if (trialActive()) { btn.classList.remove("pro-on"); btn.innerHTML = "★ GO PRO"; btn.title = "Free day: " + fmtLeft() + " left — unlock Pro"; }
    else { btn.classList.remove("pro-on"); btn.innerHTML = "★ GO PRO"; btn.title = "Free day ended — unlock Pro"; }
  }

  function boot () {
    ensureTrial();
    var btn = document.getElementById("btn-pro");
    if (btn) btn.addEventListener("click", openPanel);
    reflect();
    // gentle gate: after the free day, greet returning visitors with the paywall
    if (!isApp() && !isPro() && !trialActive()) setTimeout(openPanel, 900);
    if (location.hash === "#pro") openPanel();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.JBPro = {
    isPro: isPro, isApp: isApp, hasAccess: hasAccess,
    trialActive: trialActive, trialMsLeft: trialMsLeft,
    unlock: unlock, openPanel: openPanel, closePanel: closePanel,
    recLimitSec: function () { return hasAccess() ? Infinity : FREE_REC_SEC; },
    recBitsPerSecond: function () { return isPro() ? 256000 : 128000; }
  };
})();
