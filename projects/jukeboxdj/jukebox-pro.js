/* ═══════════════════════════════════════════════════════════════════════════
   JukeboxDJ · Pro (SaaS layer)
   Free tier: the full rig — decks, scratching, mixer, jukebox, your own music —
   with mix recordings capped at 90 seconds. Pro: unlimited recording length at
   a higher bitrate.

   Unlock (web): crypto, honor-based — same trust model as DJ-Photon's web VIP
   (no backend watches the chains yet; a future upgrade can verify on-chain).

   Android app: Pro is INCLUDED. Google Play requires in-app digital goods to
   use Play Billing, so the crypto flow must never appear inside the app — the
   shell tags its UA with "JukeboxDJApp" and this module auto-unlocks instead.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Idempotence: a double include (SW cache quirk, extension re-injection)
  // must not register a second #btn-pro handler → two stacked panels.
  if (window.JBPro) return;

  var KEY = "jbdj.pro.v1";
  var FREE_REC_SEC = 90;

  /* localStorage can throw (private mode, WebView quirks) — never let that
     take the decks down. */
  function loadState () {
    try { return JSON.parse(localStorage.getItem(KEY)) || { pro: false }; }
    catch (e) { return { pro: false }; }
  }
  function saveState (s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }

  var state = loadState();
  if (typeof state.pro !== "boolean") state = { pro: false }; // tampered/garbage → free

  function isApp () { return /JukeboxDJApp/.test(navigator.userAgent); }
  function isPro () { return isApp() || state.pro === true; }

  /* ── crypto wallets (shared Photon Bounce wallets, same as DJ-Photon) ── */
  var EVM = "0x75B30d0dE751D9628510f3cb273F09f7137f9E3F";
  var CHAINS = [
    { key: "evm",  icon: "⟠", name: "Ethereum & EVM", sub: "ETH · BNB · Polygon · Base · Arbitrum · Optimism · Linea", addr: EVM, uri: "ethereum:" + EVM },
    { key: "btc",  icon: "₿", name: "Bitcoin",  sub: "BTC · native segwit", addr: "bc1qn67f2d50wng6h83cxsk7kc55yux7kv4l6dugrx", uri: "bitcoin:bc1qn67f2d50wng6h83cxsk7kc55yux7kv4l6dugrx" },
    { key: "sol",  icon: "◎", name: "Solana",   sub: "SOL · SPL", addr: "5i6AY6jYFhGj2KThPQZiWtSV7jAQRZjtSvv2vfHmuQiU", uri: "solana:5i6AY6jYFhGj2KThPQZiWtSV7jAQRZjtSvv2vfHmuQiU" },
    { key: "tron", icon: "▟", name: "Tron",     sub: "TRX · USDT-TRC20", addr: "TGRDDVFkCD88qtAyjrHz5UhjjGoArhzwfK", uri: "tron:TGRDDVFkCD88qtAyjrHz5UhjjGoArhzwfK" }
  ];

  function el (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function toast (m) { if (window.JBToast) window.JBToast(m); }
  function copy (text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; } } catch (e) {}
    try {
      var t = document.createElement("textarea");
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand("copy"); document.body.removeChild(t);
    } catch (e) {}
  }
  function renderQR (box, text) {
    box.innerHTML = "";
    if (typeof window.QRCode === "undefined") return;
    try {
      new window.QRCode(box, { text: text, width: 140, height: 140, colorDark: "#0B0B1E", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
    } catch (e) {}
  }

  function unlock (via) {
    state = { pro: true, via: via || "crypto", t: Date.now() };
    saveState(state);
    reflect();
    toast("★ JukeboxDJ Pro unlocked on this device — unlimited recording. Thank you!");
  }

  /* ── panel ── */
  var overlay = null;

  function closePanel () { if (overlay) { overlay.remove(); overlay = null; } }

  function openPanel () {
    closePanel();
    overlay = el("div", "pro-overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closePanel(); });
    var card = el("div", "pro-card");
    overlay.appendChild(card);

    card.appendChild(el("button", "pro-close", "✕")).addEventListener("click", closePanel);
    card.appendChild(el("div", "pro-title", "★ Jukebox<i>DJ</i> Pro"));

    var feats = el("ul", "pro-feats");
    [ "<b>Unlimited</b> mix recording (free tier caps each take at " + FREE_REC_SEC + "s)",
      "<b>High-bitrate</b> (256 kbps) recordings",
      "Everything else stays free — decks, scratching, mixer, the Jukebox, your own music",
      "One-time unlock for this device. No account, no subscription, no tracking"
    ].forEach(function (f) { feats.appendChild(el("li", null, f)); });
    card.appendChild(feats);

    if (isPro()) {
      card.appendChild(el("div", "pro-active",
        isApp() ? "★ Pro is <b>included with the Android app</b>. Enjoy the booth."
                : "★ Pro is <b>active on this device</b>. Thank you for the support!"));
      document.body.appendChild(overlay);
      return;
    }

    /* Play policy: never show crypto payment inside the Android app.
       (Unreachable today since the app is auto-Pro, but belt & braces.) */
    if (isApp()) { document.body.appendChild(overlay); return; }

    card.appendChild(el("div", "pro-sub",
      "Support JukeboxDJ with <b>any amount of crypto</b> to any wallet below, then tap " +
      "<b>I've sent it</b> to unlock Pro on this device. Honor-based for now — no on-chain verification yet."));

    var chips = el("div", "pro-chips");
    var pay = el("div", "pro-pay");
    card.appendChild(chips);
    card.appendChild(pay);

    function show (chain) {
      Array.prototype.forEach.call(chips.children, function (c) { c.classList.toggle("on", c.dataset.k === chain.key); });
      pay.innerHTML = "";
      var qr = el("div", "pro-qr");
      pay.appendChild(qr);
      renderQR(qr, chain.addr);
      var meta = el("div", "pro-pay-meta");
      meta.appendChild(el("div", "pro-chain-name", chain.icon + " " + chain.name + " <small>" + chain.sub + "</small>"));
      var addr = el("code", "pro-addr", chain.addr);
      meta.appendChild(addr);
      var row = el("div", "pro-pay-row");
      var cp = el("button", "pro-btn ghost", "Copy address");
      cp.addEventListener("click", function () { copy(chain.addr); toast("Address copied"); });
      row.appendChild(cp);
      var link = el("a", "pro-btn ghost", "Open in wallet");
      link.href = chain.uri;
      row.appendChild(link);
      meta.appendChild(row);
      pay.appendChild(meta);
    }
    CHAINS.forEach(function (chain) {
      var chip = el("button", "pro-chip", chain.icon + " " + chain.name.split(" ")[0]);
      chip.dataset.k = chain.key;
      chip.addEventListener("click", function () { show(chain); });
      chips.appendChild(chip);
    });
    show(CHAINS[0]);

    var sent = el("button", "pro-btn primary", "I've sent it — unlock Pro");
    sent.addEventListener("click", function () { unlock("crypto"); closePanel(); });
    card.appendChild(sent);
    card.appendChild(el("div", "pro-fine", "Already unlocked here before? Pro is remembered per device/browser. Clearing site data clears it — just tap through again."));

    document.body.appendChild(overlay);
  }

  /* ── topbar chip ── */
  function reflect () {
    var btn = document.getElementById("btn-pro");
    if (!btn) return;
    if (isPro()) {
      btn.classList.add("pro-on");
      btn.innerHTML = "★ PRO";
      btn.title = isApp() ? "Pro — included with the Android app" : "Pro is active on this device";
    } else {
      btn.classList.remove("pro-on");
      btn.innerHTML = "★ GO PRO";
      btn.title = "Unlock unlimited high-bitrate recording";
    }
  }

  function boot () {
    var btn = document.getElementById("btn-pro");
    if (btn) btn.addEventListener("click", openPanel);
    reflect();
    if (location.hash === "#pro") openPanel(); // landing's "Unlock Pro" deep-link
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.JBPro = {
    isPro: isPro,
    isApp: isApp,
    unlock: unlock,
    openPanel: openPanel,
    closePanel: closePanel,
    recLimitSec: function () { return isPro() ? Infinity : FREE_REC_SEC; },
    recBitsPerSecond: function () { return isPro() ? 256000 : 128000; }
  };
})();
