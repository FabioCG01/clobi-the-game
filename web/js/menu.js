// menu.js -- global Menu.
//
// The home screen of CLOBI CRAFT (TUX SMASH ROYALE's fully-3D voxel era) plus
// the WARDROBE screen (the player's Minecraft-compatible skin library):
//   - Hero: game logo + a large live 3D turntable of the currently-worn skin
//     (PlayerModel.attachTurntable; falls back to a friendly message when the
//     browser has no WebGL2).
//   - [PLAY] continues the saved world ('Continue' + a 'New world' seed/mode
//     modal when a save exists, plain 'Play' otherwise) via Game.start.
//   - [WARDROBE] / [SKIN STUDIO] / [MARKETPLACE] routed through App.showScreen.
//   - Wardrobe (#screen-wardrobe, owned by this module): grid of the skin
//     library with 3D thumbnails (PlayerModel.preview), per-skin actions
//     (Wear / Edit / Duplicate / Export / Publish / Delete, admin: set global
//     default), Import PNG (file picker + drag-drop, any Minecraft skin,
//     model auto-detect with manual override), New skin (-> Skin Studio).
//   - A SUBTLE top-right corner: language switcher, sound toggle, About (lore,
//     with the "Activate Windows" gag easter egg wired to Gag), and Sign in
//     (account modal: register / login / logout via Store; on login the cloud
//     skin library + active skin are pulled).
//   - Menu.showLanguagePopup(): the first-visit / on-demand language chooser.
//
// A respectful TRIBUTE to Clobi delivered through comedy: vim, Fisherman's
// Friend, Linux, and a militant NO to Windows. ZERO forced-signup nags. All
// user-facing text flows through I18n.t(key, fallbackEn) and re-renders when
// the language changes.
//
// Exposes exactly one global: window.Menu
// Depends on globals (all typeof-guarded): I18n, Store, App, Skins,
// PlayerModel, World, Game, SkinStudio, Market, Sound, Gag.

const Menu = (function () {
  'use strict';

  // ---- internal state ----------------------------------------------------
  let rootEl = null;          // #screen-menu
  let wardEl = null;          // #screen-wardrobe
  let built = false;          // menu DOM built once
  let wardBuilt = false;      // wardrobe DOM built once
  let i18nWired = false;      // I18n.onChange attached once
  let authWired = false;      // auth-expired listener attached once
  let skinWired = false;      // App/Store skin-change listener attached once

  let heroTT = null;          // PlayerModel.attachTurntable handle
  let hasSave = false;        // a saved world exists (World.load('default'))
  let saveMeta = null;        // its meta (for continuing in the saved mode)
  let inWardShow = false;     // re-entrancy guard for showWardrobe()

  const skinCache = {};       // rec.id|png -> Promise<skin> (thumbnail loads)

  // ---- i18n shortcut -----------------------------------------------------
  function t(key, fallback) {
    if (typeof I18n !== 'undefined' && I18n.t) return I18n.t(key, fallback);
    return fallback != null ? fallback : key;
  }

  // ---- tiny DOM helpers --------------------------------------------------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'dataset') {
          for (const dk in v) node.dataset[dk] = v[dk];
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) {
      children.forEach(function (c) { appendChildren(node, c); });
    } else if (typeof children === 'string' || typeof children === 'number') {
      node.appendChild(document.createTextNode(String(children)));
    } else if (children instanceof Node) {
      node.appendChild(children);
    }
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function byId(id) { return document.getElementById(id); }
  function click() { if (window.Sound && Sound.play) { try { Sound.play('click'); } catch (e) { /* ignore */ } } }

  // SVG icon factory (real vector icons, NO emoji). Returns an <svg> scaled to px.
  function icon(name, size) {
    const s = size || 14;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.4');
    svg.setAttribute('stroke-linecap', 'square');
    svg.setAttribute('stroke-linejoin', 'miter');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'inline-block';
    svg.style.verticalAlign = 'middle';
    const paths = ICONS[name] || [];
    paths.forEach(function (d) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // Blocky, low-detail SVG glyphs to match the chunky 8-bit aesthetic.
  const ICONS = {
    user: ['M4 21 L4 18 Q4 14 12 14 Q20 14 20 18 L20 21', 'M8 7 A4 4 0 1 0 16 7 A4 4 0 1 0 8 7'],
    plus: ['M12 5 V19', 'M5 12 H19'],
    check: ['M5 13 L10 18 L19 6'],
    x: ['M6 6 L18 18', 'M18 6 L6 18'],
    logout: ['M14 4 H6 V20 H14', 'M10 12 H21', 'M17 8 L21 12 L17 16'],
    globe: ['M3 12 A9 9 0 1 0 21 12 A9 9 0 1 0 3 12', 'M3 12 H21', 'M12 3 C8 7 8 17 12 21', 'M12 3 C16 7 16 17 12 21'],
    code: ['M9 8 L5 12 L9 16', 'M15 8 L19 12 L15 16'],
    info: ['M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3', 'M12 11 V16', 'M12 7 H12.01'],
    volume: ['M4 9 H7 L11 5 V19 L7 15 H4 Z', 'M15 9 A4 4 0 0 1 15 15'],
    mute: ['M4 9 H7 L11 5 V19 L7 15 H4 Z', 'M15 9 L20 15', 'M20 9 L15 15'],
    // 3D-era glyphs
    play: ['M8 5 L19 12 L8 19 Z'],
    cube: ['M12 3 L21 8 V16 L12 21 L3 16 V8 Z', 'M3 8 L12 13 L21 8', 'M12 13 V21'],
    shirt: ['M8 3 L4 6 L6 11 L8 10 V21 H16 V10 L18 11 L20 6 L16 3 L14 5 H10 Z'],
    brush: ['M4 20 C7 20 8 18 10 16', 'M10 16 L18 8', 'M14 4 L20 10 L17 13 L11 7 Z'],
    store: ['M4 9 L5 5 H19 L20 9', 'M4 9 H20 V20 H4 Z', 'M9 20 V14 H15 V20'],
    edit: ['M5 19 H9 L18 10 L14 6 L5 15 Z', 'M13 7 L17 11'],
    copy: ['M8 8 H20 V20 H8 Z', 'M4 16 V4 H16'],
    download: ['M12 4 V15', 'M7 10 L12 15 L17 10', 'M4 19 H20'],
    upload: ['M12 15 V4', 'M7 9 L12 4 L17 9', 'M4 19 H20'],
    trash: ['M5 7 H19', 'M9 7 V4 H15 V7', 'M7 7 L8 20 H16 L17 7'],
    star: ['M12 3 L14.6 9 L21 9.6 L16 13.8 L17.6 20.4 L12 16.8 L6.4 20.4 L8 13.8 L3 9.6 L9.4 9 Z']
  };

  // ---- WebGL2 availability (for the hero turntable + thumbnails) ---------
  let glOk = null;
  function webgl2Ok() {
    if (glOk === null) {
      try { glOk = !!document.createElement('canvas').getContext('webgl2'); }
      catch (e) { glOk = false; }
    }
    return glOk;
  }

  // =========================================================================
  // MAIN MENU SCREEN
  // =========================================================================
  function ensureRoot() {
    rootEl = byId('screen-menu');
    if (!rootEl) {
      rootEl = el('div', { id: 'screen-menu', class: 'screen' });
      document.body.appendChild(rootEl);
    }
    return rootEl;
  }

  function build() {
    if (built) { rebuildStaticText(); return; }
    ensureRoot();
    clear(rootEl);

    // ---------- Top-right corner: about + sound + language + sign-in ------
    const aboutBtn = el('button', {
      id: 'menu-about-btn', class: 'corner-btn pixbtn-ghost', type: 'button',
      title: t('nav.about', 'About'),
      onclick: function () { click(); showAbout(); }
    }, [icon('info', 13), el('span', { class: 'corner-lang-label', text: t('nav.about', 'About') })]);

    const muteBtn = el('button', {
      id: 'menu-mute-btn', class: 'corner-btn pixbtn-ghost', type: 'button',
      title: t('nav.sound', 'Sound'),
      onclick: function () { if (window.Sound && Sound.toggleMute) Sound.toggleMute(); updateMuteBtn(); }
    }, [icon('volume', 13)]);

    const langBtn = el('button', {
      id: 'menu-lang-btn', class: 'corner-btn pixbtn-ghost', type: 'button',
      title: t('nav.language', 'Language'),
      onclick: showLanguagePopup
    }, [icon('globe', 13), el('span', { class: 'corner-lang-label', text: currentLangName() })]);

    const signLabel = el('span', { class: 'signin-label', text: t('nav.signIn', 'Sign in') });
    const signBtn = el('button', {
      id: 'menu-signin-btn', class: 'corner-btn signin-btn pixbtn-ghost', type: 'button',
      title: t('nav.signIn', 'Sign in'),
      onclick: openAccountModal
    }, [icon('user', 13), signLabel]);

    const corner = el('div', { class: 'menu-corner' }, [aboutBtn, muteBtn, langBtn, signBtn]);

    // ---------- Title ------------------------------------------------------
    const title = el('div', { class: 'menu-title' }, [
      el('div', { class: 'title-eyebrow', text: 'TUX SMASH ROYALE' }),
      el('h1', { class: 'title-main', text: 'CLOBI' }),
      el('h2', { class: 'title-sub', text: 'CRAFT' }),
      el('p', {
        id: 'menu-tagline', class: 'title-tag',
        text: t('menu.tagline3d', "Clobi's Arena went full 3D — mine, build, and dress your blocky self.")
      })
    ]);

    // ---------- Hero: live 3D turntable of the worn skin -------------------
    const hero = el('div', { class: 'menu-hero' }, [
      el('div', { id: 'menu-hero-stage', class: 'hero-stage' }),
      el('div', { id: 'menu-hero-caption', class: 'hero-caption' })
    ]);

    // ---------- Identity: display name (used by in-game chat) --------------
    const nickInput = el('input', {
      id: 'menu-nickname', class: 'kahoot-nick pixinput', type: 'text',
      maxlength: '16', autocomplete: 'off', spellcheck: 'false',
      placeholder: t('menu.nicknamePh', 'Your penguin name'),
      oninput: onNicknameInput
    });
    const nickRow = el('div', { class: 'menu-nick-row' }, [
      el('label', { id: 'menu-nick-label', class: 'nick-label', for: 'menu-nickname', text: t('menu.nickname', 'Display name') }),
      nickInput
    ]);

    // ---------- PLAY (Continue / Play) + New world -------------------------
    const playBtn = el('button', {
      id: 'menu-play-btn', class: 'pixbtn pixbtn-primary', type: 'button', onclick: onClickPlay
    }, [icon('play', 18), el('span', { text: t('menu.play', 'Play') })]);

    const newWorldBtn = el('button', {
      id: 'menu-newworld-btn', class: 'pixbtn-ghost', type: 'button', style: 'display:none',
      onclick: function () { click(); openNewWorldModal(); }
    }, [icon('plus', 12), el('span', { text: t('menu.newWorld', 'New world') })]);

    const playRow = el('div', { class: 'menu-play-row' }, [playBtn, newWorldBtn]);

    // ---------- Secondary actions: Wardrobe / Studio / Market --------------
    const wardBtn = el('button', {
      id: 'menu-ward-btn', class: 'pixbtn', type: 'button', onclick: onClickWardrobe
    }, [icon('shirt', 16), el('span', { text: t('menu.wardrobe', 'Wardrobe') })]);

    const studioBtn = el('button', {
      id: 'menu-studio-btn', class: 'pixbtn', type: 'button', onclick: onClickStudio
    }, [icon('brush', 16), el('span', { text: t('menu.skinStudio', 'Skin Studio') })]);

    const marketBtn = el('button', {
      id: 'menu-market-btn', class: 'pixbtn', type: 'button', onclick: onClickMarketplace
    }, [icon('store', 16), el('span', { text: t('nav.marketplace', 'Marketplace') })]);

    const actionRow = el('div', { class: 'menu-actions' }, [wardBtn, studioBtn, marketBtn]);

    // ---------- Footer tribute (comedy, respectful) -------------------------
    const footer = el('div', { id: 'menu-footer', class: 'menu-footer' }, footerNodes());

    rootEl.appendChild(corner);
    rootEl.appendChild(el('div', { class: 'menu-inner' }, [title, hero, playRow, nickRow, actionRow, footer]));

    injectStyles();
    built = true;
  }

  function footerNodes() {
    const tribute = el('div', { class: 'footer-line' }, [
      'In honor of Clobi — vim, ',
      el('span', { class: 'accent-mint', text: "Fisherman's Friend" }),
      ', and a militant ',
      el('span', { class: 'accent-blue', text: 'NO' }),
      ' to Windows.'
    ]);
    const oss = el('a', {
      id: 'menu-oss', class: 'menu-oss',
      href: 'https://github.com/FabioCG01/clobi-the-game',
      target: '_blank', rel: 'noopener noreferrer', title: 'Open source on GitHub'
    }, [icon('code', 12), el('span', { text: t('footer.openSource', 'Open source on GitHub') })]);
    const privacy = el('a', {
      id: 'menu-privacy', class: 'menu-oss', href: '#', title: 'Privacy & your data',
      onclick: function (e) { e.preventDefault(); openPrivacyModal(); }
    }, [el('span', { text: t('footer.privacy', 'Privacy & data') })]);
    return [tribute, el('div', { class: 'footer-links' }, [oss, privacy])];
  }

  // Recompute all static labels after a language switch.
  function rebuildStaticText() {
    setText('menu-tagline', t('menu.tagline3d', "Clobi's Arena went full 3D — mine, build, and dress your blocky self."));
    setText('menu-nick-label', t('menu.nickname', 'Display name'));
    setPlaceholder('menu-nickname', t('menu.nicknamePh', 'Your penguin name'));
    setBtnLabel('menu-ward-btn', t('menu.wardrobe', 'Wardrobe'));
    setBtnLabel('menu-studio-btn', t('menu.skinStudio', 'Skin Studio'));
    setBtnLabel('menu-market-btn', t('nav.marketplace', 'Marketplace'));
    setBtnLabel('menu-newworld-btn', t('menu.newWorld', 'New world'));
    updatePlayRow();
    updateHeroCaption();

    const langLabel = rootEl && rootEl.querySelector('#menu-lang-btn .corner-lang-label');
    if (langLabel) langLabel.textContent = currentLangName();
    const aboutLabel = rootEl && rootEl.querySelector('#menu-about-btn .corner-lang-label');
    if (aboutLabel) aboutLabel.textContent = t('nav.about', 'About');
    refreshAccountUi();

    if (wardBuilt) rebuildWardrobeStaticText();
  }

  function setText(id, text) { const n = byId(id); if (n) n.textContent = text; }
  function setPlaceholder(id, text) { const n = byId(id); if (n) n.setAttribute('placeholder', text); }
  function setBtnLabel(id, text) {
    const n = byId(id); if (!n) return;
    const span = n.querySelector('span'); if (span) span.textContent = text; n.title = text;
  }

  // ---- public: show / hide ----------------------------------------------
  function show() {
    build();
    wireI18n();
    wireAuthExpiry();
    wireSkinSync();
    syncNickname();
    refreshAccountUi();
    probeSave();
    mountHero();

    // Ensure visibility when called directly (no-op when routed by App).
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu');
    else { rootEl.classList.add('active'); }

    if (window.Sound) {
      try { Sound.unlock && Sound.unlock(); Sound.music && Sound.music('menu'); } catch (e) { /* ignore */ }
    }
    updateMuteBtn();
  }

  function hide() {
    // Stop the hero turntable's rAF loop while another screen is up.
    unmountHero();
  }

  function wireI18n() {
    if (i18nWired || typeof I18n === 'undefined' || !I18n.onChange) return;
    I18n.onChange(function () { rebuildStaticText(); });
    i18nWired = true;
  }

  // A stale token was dropped by Store (e.g. after a server restart): reflect
  // the signed-out state and let the player know so nothing fails silently.
  function wireAuthExpiry() {
    if (authWired || typeof window === 'undefined') return;
    window.addEventListener('clobi:auth-expired', function () {
      refreshAccountUi();
      toast(t('account.sessionExpired', 'Your session expired — please sign in again.'), 'warn');
    });
    authWired = true;
  }

  // Refresh the hero turntable + wardrobe highlight whenever the worn skin
  // changes (boot resolution, Wear, market try-on, studio save…).
  function wireSkinSync() {
    if (skinWired) return;
    const handler = function () { onActiveSkinChanged(); };
    if (typeof App !== 'undefined' && App.onSkinChange) { App.onSkinChange(handler); skinWired = true; }
    else if (typeof Store !== 'undefined' && Store.onSkinChange) {
      try { Store.onSkinChange(handler); skinWired = true; } catch (e) { /* ignore */ }
    }
  }

  function onActiveSkinChanged() {
    const menuActive = rootEl && rootEl.classList.contains('active');
    if (menuActive) {
      const sk = (typeof App !== 'undefined') ? App.skin : null;
      if (heroTT && sk) {
        try {
          heroTT.setSkin && heroTT.setSkin(sk);
          heroTT.setModel && sk.model && heroTT.setModel(sk.model);
        } catch (e) { mountHero(); }
      } else {
        mountHero();
      }
      updateHeroCaption();
    }
    if (wardEl && wardEl.classList.contains('active')) refreshWardrobe();
  }

  // ---- hero turntable ------------------------------------------------------
  function mountHero() {
    const stage = byId('menu-hero-stage');
    if (!stage) return;
    unmountHero();
    clear(stage);

    if (!webgl2Ok() || typeof PlayerModel === 'undefined' || !PlayerModel.attachTurntable) {
      stage.appendChild(el('div', {
        class: 'hero-fallback',
        text: t('menu.noWebgl', 'This 3D preview needs WebGL2 — and so does the game. Try a current browser!')
      }));
      updateHeroCaption();
      return;
    }

    const sk = (typeof App !== 'undefined') ? App.skin : null;
    if (!sk) {
      // Boot is still resolving the skin; onActiveSkinChanged() remounts.
      stage.appendChild(el('div', { class: 'hero-fallback', text: t('menu.skinLoading', 'Summoning your skin…') }));
      updateHeroCaption();
      return;
    }

    const canvas = el('canvas', { class: 'hero-canvas', width: '320', height: '400' });
    stage.appendChild(canvas);
    try {
      heroTT = PlayerModel.attachTurntable(canvas, sk, {});
    } catch (e) {
      heroTT = null;
      clear(stage);
      stage.appendChild(el('div', {
        class: 'hero-fallback',
        text: t('menu.noWebgl', 'This 3D preview needs WebGL2 — and so does the game. Try a current browser!')
      }));
    }
    updateHeroCaption();
  }

  function unmountHero() {
    if (heroTT && heroTT.destroy) { try { heroTT.destroy(); } catch (e) { /* ignore */ } }
    heroTT = null;
  }

  function updateHeroCaption() {
    const cap = byId('menu-hero-caption');
    if (!cap) return;
    clear(cap);
    let rec = null;
    if (typeof Store !== 'undefined' && Store.getActiveSkin) {
      try { rec = Store.getActiveSkin(); } catch (e) { rec = null; }
    }
    const sk = (typeof App !== 'undefined') ? App.skin : null;
    const name = (rec && rec.name) || 'Clobi';
    const model = (sk && sk.model) || (rec && rec.model) || 'classic';
    cap.appendChild(el('span', { class: 'hero-skin-name', text: name }));
    cap.appendChild(el('span', {
      class: 'hero-model-badge' + (model === 'slim' ? ' slim' : ''),
      text: model === 'slim' ? t('wardrobe.slim', 'Slim') : t('wardrobe.classic', 'Classic')
    }));
  }

  // ---- App / Store sync (display name) ------------------------------------
  function getNickname() {
    if (typeof Store !== 'undefined' && Store.getNickname) {
      try { return Store.getNickname() || ''; } catch (e) { return ''; }
    }
    return '';
  }
  function setNickname(n) {
    n = (n || '').slice(0, 16);
    if (typeof Store !== 'undefined' && Store.setNickname) {
      try { Store.setNickname(n); } catch (e) { /* ignore */ }
    }
  }
  function syncNickname() { const input = byId('menu-nickname'); if (input) input.value = getNickname(); }
  function onNicknameInput(e) { setNickname(e.target.value); }

  // =========================================================================
  // PLAY — saved world probe, Continue/Play, New world modal
  // =========================================================================
  function probeSave() {
    if (typeof World === 'undefined' || !World.load) { hasSave = false; updatePlayRow(); return; }
    try {
      World.load('default').then(function (saved) {
        hasSave = !!saved;
        saveMeta = (saved && saved.meta) || null;
        updatePlayRow();
      }).catch(function () { hasSave = false; saveMeta = null; updatePlayRow(); });
    } catch (e) { hasSave = false; updatePlayRow(); }
  }

  function updatePlayRow() {
    const playBtn = byId('menu-play-btn');
    if (playBtn) {
      const span = playBtn.querySelector('span');
      if (span) span.textContent = hasSave ? t('menu.continue', 'Continue') : t('menu.play', 'Play');
      playBtn.title = span ? span.textContent : '';
    }
    const nw = byId('menu-newworld-btn');
    if (nw) nw.style.display = hasSave ? '' : 'none';
  }

  function startGame(opts) {
    if (typeof Game === 'undefined' || !Game.start) {
      toast(t('vox.err.noEngine', 'The voxel engine failed to load — check the console.'), 'warn');
      return;
    }
    try {
      Promise.resolve(Game.start(opts)).catch(function (err) {
        toast((err && err.message) || t('vox.err.startFail', 'Could not start the world.'), 'danger');
      });
    } catch (e) {
      toast(t('vox.err.startFail', 'Could not start the world.'), 'danger');
    }
  }

  function onClickPlay() {
    click();
    if (hasSave) startGame(saveMeta && saveMeta.mode ? { mode: saveMeta.mode } : {});
    else startGame({ mode: 'survival' });
  }

  // Seed input: plain integers pass through; any other text is FNV-1a hashed
  // so "clobi forever" is a perfectly good (and shareable) seed.
  function parseSeed(str) {
    str = (str || '').trim();
    if (!str) return undefined;
    if (/^[+-]?\d+$/.test(str)) {
      const n = parseInt(str, 10);
      if (isFinite(n)) return n | 0;
    }
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  }

  function openNewWorldModal() {
    let mode = 'survival';

    const seedInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '48', autocomplete: 'off', spellcheck: 'false',
      placeholder: t('menu.seedPh', 'a number, or any words')
    });

    function makeModeBtn(id, key, fallback) {
      return el('button', {
        class: 'tab-btn' + (mode === id ? ' tab-btn-active' : ''), type: 'button', dataset: { mode: id },
        onclick: function () { mode = id; syncTabs(); }
      }, [el('span', { text: t(key, fallback) })]);
    }
    const tabs = el('div', { class: 'tab-row' }, [
      makeModeBtn('survival', 'vox.mode.survival', 'Survival'),
      makeModeBtn('creative', 'vox.mode.creative', 'Creative')
    ]);
    function syncTabs() {
      const btns = tabs.querySelectorAll('.tab-btn');
      btns[0].classList.toggle('tab-btn-active', mode === 'survival');
      btns[1].classList.toggle('tab-btn-active', mode === 'creative');
    }

    const warn = hasSave
      ? el('p', { class: 'form-err', text: t('menu.newWorldWarn', 'Careful: this replaces your saved world!') })
      : null;

    const createBtn = el('button', {
      class: 'pixbtn pixbtn-primary', type: 'button',
      onclick: function () {
        click();
        const opts = { fresh: true, mode: mode };
        const seed = parseSeed(seedInput.value);
        if (seed !== undefined) opts.seed = seed;
        closeAnyModal();
        startGame(opts);
      }
    }, [icon('play', 14), el('span', { text: t('menu.createWorld', 'Create world') })]);

    const body = [
      formRow(t('menu.seed', 'Seed (optional)'), seedInput,
        t('menu.seedHint', 'Same seed = same world. Empty = random.')),
      formRow(t('menu.mode', 'Mode'), tabs),
      warn,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        createBtn
      ])
    ];
    openModal(modalShell(t('menu.newWorldTitle', 'New world'), body));
    setTimeout(function () { seedInput.focus(); }, 30);
  }

  // ---- secondary navigation -----------------------------------------------
  function onClickWardrobe() {
    click();
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('wardrobe');
    else showWardrobe();
  }

  function onClickStudio() {
    click();
    if (typeof SkinStudio === 'undefined' || !SkinStudio.show) {
      toast(t('studio.soon', 'The skin studio is warming up — coming soon!'), 'info');
      return;
    }
    const sk = (typeof App !== 'undefined') ? App.skin : null;
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('studio', sk ? { skin: sk } : undefined);
    else SkinStudio.show(sk ? { skin: sk } : undefined);
  }

  function onClickMarketplace() {
    click();
    if (typeof Market === 'undefined' || !Market.show) {
      toast(t('soon.market', 'The marketplace is opening its doors — coming soon!'), 'info');
      return;
    }
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('market');
    else Market.show();
  }

  // =========================================================================
  // WARDROBE SCREEN (#screen-wardrobe) — the player's skin library
  // =========================================================================
  function ensureWardRoot() {
    wardEl = byId('screen-wardrobe');
    if (!wardEl) {
      wardEl = el('div', { id: 'screen-wardrobe', class: 'screen' });
      document.body.appendChild(wardEl);
    }
    return wardEl;
  }

  function buildWardrobe() {
    if (wardBuilt) return;
    ensureWardRoot();
    clear(wardEl);

    const backBtn = el('button', {
      id: 'ward-back-btn', class: 'wd-btn', type: 'button',
      onclick: function () {
        click();
        if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu');
      }
    }, [icon('x', 12), el('span', { text: t('wardrobe.back', 'Back') })]);

    const fileInput = el('input', {
      id: 'ward-file', type: 'file', accept: 'image/png,.png', style: 'display:none',
      onchange: function (e) { onImportFiles(e.target.files); e.target.value = ''; }
    });

    const importBtn = el('button', {
      id: 'ward-import-btn', class: 'wd-btn', type: 'button',
      onclick: function () { click(); fileInput.click(); }
    }, [icon('upload', 12), el('span', { text: t('wardrobe.import', 'Import PNG') })]);

    const newBtn = el('button', {
      id: 'ward-new-btn', class: 'wd-btn wd-btn-primary', type: 'button',
      onclick: function () {
        click();
        if (typeof App !== 'undefined' && App.showScreen) App.showScreen('studio', { fresh: true });
        else if (typeof SkinStudio !== 'undefined' && SkinStudio.show) SkinStudio.show({ fresh: true });
      }
    }, [icon('plus', 12), el('span', { text: t('wardrobe.new', 'New skin') })]);

    const head = el('div', { class: 'wd-head' }, [
      backBtn,
      el('h2', { id: 'ward-title', class: 'wd-title', text: t('wardrobe.title', 'Wardrobe') }),
      el('div', { class: 'wd-actions' }, [importBtn, newBtn, fileInput])
    ]);

    const hint = el('p', {
      id: 'ward-hint', class: 'wd-hint',
      text: t('wardrobe.dropHint', 'Any real Minecraft skin PNG works — drop one anywhere on this screen to import it.')
    });

    const grid = el('div', { id: 'ward-grid', class: 'wd-grid' });

    wardEl.appendChild(el('div', { class: 'wd-inner' }, [head, hint, grid]));

    // Drag & drop import — anywhere on the wardrobe screen.
    wardEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      wardEl.classList.add('wd-dragging');
    });
    wardEl.addEventListener('dragleave', function (e) {
      if (e.target === wardEl) wardEl.classList.remove('wd-dragging');
    });
    wardEl.addEventListener('drop', function (e) {
      e.preventDefault();
      wardEl.classList.remove('wd-dragging');
      if (e.dataTransfer && e.dataTransfer.files) onImportFiles(e.dataTransfer.files);
    });

    wardBuilt = true;
  }

  function rebuildWardrobeStaticText() {
    setText('ward-title', t('wardrobe.title', 'Wardrobe'));
    setText('ward-hint', t('wardrobe.dropHint', 'Any real Minecraft skin PNG works — drop one anywhere on this screen to import it.'));
    setBtnLabel('ward-back-btn', t('wardrobe.back', 'Back'));
    setBtnLabel('ward-import-btn', t('wardrobe.import', 'Import PNG'));
    setBtnLabel('ward-new-btn', t('wardrobe.new', 'New skin'));
    if (wardEl && wardEl.classList.contains('active')) refreshWardrobe();
  }

  // Public entry, also invoked by App's router for App.showScreen('wardrobe').
  function showWardrobe() {
    if (inWardShow) return;
    inWardShow = true;
    try {
      buildWardrobe();
      wireI18n();
      wireSkinSync();
      refreshWardrobe();
      if (typeof App !== 'undefined' && App.showScreen) App.showScreen('wardrobe');
      else { ensureWardRoot().classList.add('active'); }
    } finally {
      inWardShow = false;
    }
  }

  function hideWardrobe() { /* nothing to tear down — thumbnails are cached */ }

  // ---- library helpers ------------------------------------------------------
  function listSkinRecs() {
    if (typeof Store === 'undefined' || !Store.listSkins) return [];
    try { return Store.listSkins() || []; } catch (e) { return []; }
  }

  function activeSkinRec() {
    if (typeof Store === 'undefined' || !Store.getActiveSkin) return null;
    try { return Store.getActiveSkin(); } catch (e) { return null; }
  }

  // Load (and cache) the Skins object for a library record.
  function loadSkinFor(rec) {
    if (typeof Skins === 'undefined' || !Skins.load) return Promise.reject(new Error('Skins unavailable'));
    const key = rec.id || rec.png;
    if (!skinCache[key]) {
      skinCache[key] = Skins.load(rec.png).then(function (sk) {
        if (rec.model === 'classic' || rec.model === 'slim') sk.model = rec.model;
        return sk;
      });
      // A failed load should not poison the cache forever.
      skinCache[key].catch(function () { delete skinCache[key]; });
    }
    return skinCache[key];
  }

  function refreshWardrobe() {
    const grid = byId('ward-grid');
    if (!grid) return;
    clear(grid);

    const recs = listSkinRecs();
    if (!recs.length) {
      grid.appendChild(el('div', {
        class: 'wd-empty',
        text: t('wardrobe.empty', 'No skins yet — import any Minecraft skin PNG, grab one in the marketplace, or craft one in the Skin Studio!')
      }));
      return;
    }

    const active = activeSkinRec();
    recs.forEach(function (rec) {
      if (rec && rec.png) grid.appendChild(buildSkinCard(rec, active));
    });
  }

  function isActiveRec(rec, active) {
    if (!active) return false;
    if (rec.id && active.id && rec.id === active.id) return true;
    return !!(active.png && rec.png === active.png);
  }

  function buildSkinCard(rec, active) {
    const activeNow = isActiveRec(rec, active);

    // 3D thumbnail (async — PlayerModel.preview once the skin is decoded).
    const thumb = el('div', { class: 'wd-thumb' });
    if (webgl2Ok() && typeof PlayerModel !== 'undefined' && PlayerModel.preview) {
      loadSkinFor(rec).then(function (sk) {
        try {
          const cv = PlayerModel.preview(sk, { width: 132, height: 165 });
          clear(thumb);
          if (cv) thumb.appendChild(cv);
        } catch (e) { thumbFallback(thumb, rec); }
      }).catch(function () { thumbFallback(thumb, rec); });
    } else {
      thumbFallback(thumb, rec);
    }

    const model = (rec.model === 'slim') ? 'slim' : 'classic';
    const nameRow = el('div', { class: 'wd-name-row' }, [
      el('div', { class: 'wd-name', text: rec.name || t('wardrobe.unnamed', 'Unnamed skin') }),
      el('span', {
        class: 'wd-model' + (model === 'slim' ? ' slim' : ''),
        text: model === 'slim' ? t('wardrobe.slim', 'Slim') : t('wardrobe.classic', 'Classic')
      }),
      activeNow ? el('span', { class: 'wd-worn' }, [icon('check', 10), el('span', { text: ' ' + t('wardrobe.worn', 'Wearing') })]) : null
    ]);

    // Actions: Wear + a compact icon toolbar.
    const wearBtn = el('button', {
      class: 'wd-btn wd-btn-primary', type: 'button',
      title: t('wardrobe.wear', 'Wear'),
      onclick: function () { click(); wearSkin(rec); }
    }, [icon('check', 12), el('span', { text: t('wardrobe.wear', 'Wear') })]);

    function iconBtn(name, titleText, handler, extraClass) {
      return el('button', {
        class: 'wd-btn wd-icon-btn' + (extraClass ? ' ' + extraClass : ''), type: 'button', title: titleText,
        onclick: function () { click(); handler(); }
      }, [icon(name, 13)]);
    }

    const tools = el('div', { class: 'wd-row' }, [
      iconBtn('edit', t('wardrobe.edit', 'Edit in Skin Studio'), function () { editSkin(rec); }),
      iconBtn('copy', t('wardrobe.duplicate', 'Duplicate'), function () { duplicateSkin(rec); }),
      iconBtn('download', t('wardrobe.export', 'Export PNG'), function () { exportSkin(rec); }),
      iconBtn('upload', t('wardrobe.publish', 'Publish to marketplace'), function () { openPublishModal(rec); }),
      iconBtn('trash', t('wardrobe.delete', 'Delete'), function () { confirmDeleteSkin(rec); }, 'wd-btn-danger'),
      (typeof Store !== 'undefined' && Store.isAdmin && Store.isAdmin())
        ? iconBtn('star', t('wardrobe.adminDefault', 'Set as global default skin'), function () { setAdminDefault(rec); }, 'wd-btn-admin')
        : null
    ]);

    return el('div', { class: 'wd-card' + (activeNow ? ' active' : '') }, [
      thumb, nameRow, el('div', { class: 'wd-card-actions' }, [wearBtn, tools])
    ]);
  }

  // Non-3D fallback: show the raw skin PNG (still informative).
  function thumbFallback(thumb, rec) {
    clear(thumb);
    const img = el('img', { class: 'wd-thumb-flat', alt: rec.name || 'skin' });
    img.src = rec.png;
    thumb.appendChild(img);
  }

  // ---- per-skin actions -----------------------------------------------------
  function wearSkin(rec) {
    if (typeof App === 'undefined' || !App.setSkin) {
      toast(t('vox.err.noEngine', 'The voxel engine failed to load — check the console.'), 'warn');
      return;
    }
    App.setSkin(rec).then(function () {
      toast(t('wardrobe.wornToast', 'Skin equipped!'), 'info');
      refreshWardrobe();
    }).catch(function () {
      toast(t('vox.err.badSkin', 'Not a valid Minecraft skin PNG (needs 64×64 or 64×32).'), 'danger');
    });
  }

  function editSkin(rec) {
    if (typeof SkinStudio === 'undefined' || !SkinStudio.show) {
      toast(t('studio.soon', 'The skin studio is warming up — coming soon!'), 'info');
      return;
    }
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('studio', { record: rec });
    else SkinStudio.show({ record: rec });
  }

  function duplicateSkin(rec) {
    if (typeof Store === 'undefined' || !Store.saveSkin) return;
    try {
      Store.saveSkin({
        name: ((rec.name || t('wardrobe.unnamed', 'Unnamed skin')) + ' ' + t('wardrobe.copySuffix', 'copy')).slice(0, 48),
        model: rec.model === 'slim' ? 'slim' : 'classic',
        png: rec.png,
        remixOf: rec.remixOf
      });
      toast(t('wardrobe.duplicated', 'Duplicated.'), 'info');
      refreshWardrobe();
    } catch (e) {
      toast(t('wardrobe.saveFail', 'Could not save the skin (storage full?).'), 'danger');
    }
  }

  function exportSkin(rec) {
    try {
      const a = document.createElement('a');
      a.href = rec.png;
      a.download = ((rec.name || 'skin').replace(/[^\w\- ]+/g, '').trim() || 'skin') + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      toast(t('wardrobe.exportFail', 'Export failed.'), 'danger');
    }
  }

  function confirmDeleteSkin(rec) {
    confirmModal(
      t('wardrobe.deleteConfirm', 'Delete this skin from your wardrobe? This cannot be undone.'),
      t('wardrobe.delete', 'Delete'),
      function () {
        if (typeof Store !== 'undefined' && Store.deleteSkin && rec.id) {
          try { Store.deleteSkin(rec.id); } catch (e) { /* ignore */ }
        }
        delete skinCache[rec.id || rec.png];
        toast(t('wardrobe.deleted', 'Skin deleted.'), 'info');
        refreshWardrobe();
      }
    );
  }

  function setAdminDefault(rec) {
    if (typeof Store === 'undefined' || !Store.setAdminDefaultSkin) return;
    Store.setAdminDefaultSkin({
      name: rec.name || 'Skin',
      model: rec.model === 'slim' ? 'slim' : 'classic',
      png: rec.png
    }).then(function () {
      toast(t('wardrobe.defaultSet', 'Global default skin updated.'), 'info');
    }).catch(function (err) {
      toast((err && err.message) || t('wardrobe.defaultFail', 'Could not set the default skin.'), 'danger');
    });
  }

  // ---- publish ---------------------------------------------------------------
  function openPublishModal(rec) {
    if (typeof Store === 'undefined' || !Store.marketPublishSkin) return;
    if (!(Store.isLoggedIn && Store.isLoggedIn())) {
      toast(t('wardrobe.needLogin', 'Sign in to publish skins.'), 'warn');
      openAccountModal();
      return;
    }

    const titleInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '48', spellcheck: 'false',
      placeholder: t('wardrobe.pubTitlePh', 'A name the world will see'),
      value: rec.name || ''
    });
    const tagsInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '120', spellcheck: 'false',
      placeholder: t('wardrobe.pubTagsPh', 'penguin, tux, mint …')
    });
    const errLine = el('div', { class: 'form-err', text: '' });

    const pubBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' },
      [icon('upload', 14), el('span', { text: t('wardrobe.publish', 'Publish') })]);

    pubBtn.addEventListener('click', function () {
      errLine.textContent = '';
      const title = titleInput.value.trim();
      if (!title) { errLine.textContent = t('wardrobe.pubTitleReq', 'A title is required.'); return; }
      const tags = tagsInput.value.split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return !!s; }).slice(0, 8);
      pubBtn.disabled = true;
      pubBtn.classList.add('pixbtn-disabled');
      Store.marketPublishSkin({
        title: title,
        tags: tags,
        model: rec.model === 'slim' ? 'slim' : 'classic',
        png: rec.png,
        remixOf: rec.remixOf
      }).then(function () {
        closeAnyModal();
        toast(t('wardrobe.published', 'Published! Find it in the marketplace.'), 'info');
      }).catch(function (err) {
        pubBtn.disabled = false;
        pubBtn.classList.remove('pixbtn-disabled');
        errLine.textContent = (err && err.message) || t('wardrobe.pubFail', 'Publishing failed — try again.');
      });
    });

    const body = [
      el('p', { class: 'modal-lead', text: t('wardrobe.pubLead', 'Skins are always free, community-moderated, and credit their whole remix lineage.') }),
      formRow(t('wardrobe.pubTitle', 'Title'), titleInput),
      formRow(t('wardrobe.pubTags', 'Tags (comma separated, max 8)'), tagsInput),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        pubBtn
      ])
    ];
    openModal(modalShell(t('wardrobe.publishTitle', 'Publish to marketplace'), body));
    setTimeout(function () { titleInput.focus(); }, 30);
  }

  // ---- import -----------------------------------------------------------------
  function onImportFiles(files) {
    if (!files || !files.length) return;
    const f = files[0];
    if (typeof Skins === 'undefined' || !Skins.load) {
      toast(t('vox.err.noEngine', 'The voxel engine failed to load — check the console.'), 'warn');
      return;
    }
    Skins.load(f).then(function (sk) {
      openImportModal(sk, f.name || '');
    }).catch(function () {
      toast(t('vox.err.badSkin', 'Not a valid Minecraft skin PNG (needs 64×64 or 64×32).'), 'danger');
    });
  }

  function openImportModal(sk, filename) {
    let model = (sk.model === 'slim') ? 'slim' : 'classic';

    const baseName = (filename || '').replace(/\.[Pp][Nn][Gg]$/, '').replace(/[_-]+/g, ' ').trim();
    const nameInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '48', spellcheck: 'false',
      value: (baseName || t('wardrobe.importedName', 'Imported skin')).slice(0, 48)
    });

    // Live preview (re-rendered when the model override toggles).
    const prevWrap = el('div', { class: 'wd-import-preview' });
    function renderPreview() {
      clear(prevWrap);
      if (webgl2Ok() && typeof PlayerModel !== 'undefined' && PlayerModel.preview) {
        try {
          sk.model = model;
          const cv = PlayerModel.preview(sk, { width: 120, height: 150 });
          if (cv) { prevWrap.appendChild(cv); return; }
        } catch (e) { /* fall through */ }
      }
      const img = el('img', { class: 'wd-thumb-flat', alt: 'skin' });
      try { img.src = sk.dataURL(); } catch (e) { /* ignore */ }
      prevWrap.appendChild(img);
    }

    // Model override toggle (auto-detect prefilled; §5.7: UI always allows it).
    function makeModelBtn(id, key, fallback) {
      return el('button', {
        class: 'tab-btn' + (model === id ? ' tab-btn-active' : ''), type: 'button',
        onclick: function () { model = id; syncTabs(); renderPreview(); }
      }, [el('span', { text: t(key, fallback) })]);
    }
    const tabs = el('div', { class: 'tab-row' }, [
      makeModelBtn('classic', 'wardrobe.classic', 'Classic'),
      makeModelBtn('slim', 'wardrobe.slim', 'Slim')
    ]);
    function syncTabs() {
      const btns = tabs.querySelectorAll('.tab-btn');
      btns[0].classList.toggle('tab-btn-active', model === 'classic');
      btns[1].classList.toggle('tab-btn-active', model === 'slim');
    }
    renderPreview();

    const saveBtn = el('button', {
      class: 'pixbtn pixbtn-primary', type: 'button',
      onclick: function () {
        click();
        if (typeof Store === 'undefined' || !Store.saveSkin) return;
        let png = null;
        try { png = sk.dataURL(); } catch (e) { png = null; }
        if (!png) { toast(t('wardrobe.saveFail', 'Could not save the skin (storage full?).'), 'danger'); return; }
        try {
          Store.saveSkin({
            name: (nameInput.value.trim() || t('wardrobe.importedName', 'Imported skin')).slice(0, 48),
            model: model,
            png: png
          });
        } catch (e) {
          toast(t('wardrobe.saveFail', 'Could not save the skin (storage full?).'), 'danger');
          return;
        }
        closeAnyModal();
        toast(t('wardrobe.saved', 'Saved to your wardrobe!'), 'info');
        refreshWardrobe();
      }
    }, [icon('check', 14), el('span', { text: t('wardrobe.importSave', 'Add to wardrobe') })]);

    const detected = (sk.model === 'slim')
      ? t('wardrobe.detectedSlim', 'Auto-detected: Slim (3 px arms)')
      : t('wardrobe.detectedClassic', 'Auto-detected: Classic (4 px arms)');

    const body = [
      el('div', { class: 'wd-import-row' }, [
        prevWrap,
        el('div', { class: 'wd-import-fields' }, [
          formRow(t('wardrobe.name', 'Name'), nameInput),
          formRow(t('wardrobe.model', 'Model'), tabs, detected)
        ])
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        saveBtn
      ])
    ];
    openModal(modalShell(t('wardrobe.importTitle', 'Import skin'), body));
  }

  // =========================================================================
  // Modal infrastructure (shared by menu + wardrobe)
  // =========================================================================
  function modalHost() {
    let host = byId('modal-root');
    if (!host) { host = el('div', { id: 'modal-root' }); document.body.appendChild(host); }
    return host;
  }
  function openModal(node) {
    closeAnyModal();
    const overlay = el('div', { class: 'modal-overlay', onclick: function (e) { if (e.target === overlay) closeAnyModal(); } }, [node]);
    const onKey = function (e) { if (e.key === 'Escape') closeAnyModal(); };
    overlay._onKey = onKey;
    document.addEventListener('keydown', onKey);
    modalHost().appendChild(overlay);
    return overlay;
  }
  function closeAnyModal() {
    const host = byId('modal-root'); if (!host) return;
    while (host.firstChild) {
      const ov = host.firstChild;
      if (ov._onKey) document.removeEventListener('keydown', ov._onKey);
      host.removeChild(ov);
    }
  }
  function modalShell(titleText, bodyNodes, opts) {
    opts = opts || {};
    const closeBtn = el('button', { class: 'modal-x', type: 'button', title: t('common.close', 'Close'), onclick: closeAnyModal }, [icon('x', 14)]);
    return el('div', { class: 'pixmodal' + (opts.wide ? ' pixmodal-wide' : '') }, [
      el('div', { class: 'pixmodal-head' }, [el('h3', { class: 'pixmodal-title', text: titleText }), closeBtn]),
      el('div', { class: 'pixmodal-body' }, bodyNodes)
    ]);
  }
  function formRow(labelText, control, hintText) {
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'form-label', text: labelText }), control,
      hintText ? el('div', { class: 'form-hint', text: hintText }) : null
    ]);
  }
  function confirmModal(msg, yesLabel, onYes) {
    openModal(modalShell(t('common.confirm', 'Are you sure?'), [
      el('p', { class: 'modal-lead', text: msg }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        el('button', {
          class: 'pixbtn pixbtn-danger', type: 'button',
          onclick: function () { closeAnyModal(); onYes(); }
        }, [el('span', { text: yesLabel })])
      ])
    ]));
  }

  // =========================================================================
  // About / lore modal (with the Activate Windows easter egg)
  // =========================================================================
  function showAbout() {
    const p = function (txt) { return el('p', { class: 'about-p', text: txt }); };
    const eggBtn = el('button', {
      class: 'pixbtn-ghost about-egg', type: 'button', title: 'Do NOT press',
      onclick: function () {
        closeAnyModal();
        if (window.Gag && Gag.activate) { try { Gag.activate(10000); } catch (e) { /* ignore */ } }
        else toast(t('about.eggFail', 'Freedom prevails. No Windows here.'), 'info');
      }
    }, [el('span', { text: t('about.egg', 'Activate Windows') })]);

    const body = [
      p(t('about.l1', 'Clobi taught a generation Linux, open source, vim, and LibreOffice — fuelled by Fisherman\'s Friend menthol lozenges and a militant distaste for Microsoft.')),
      p(t('about.vox2', 'This is his world, now in glorious 3D: mine and build in a voxel sandbox, paint Minecraft-compatible skins in the studio, and share them in an always-free, open-source marketplace. Real skin PNGs are plug-and-play.')),
      el('div', { class: 'about-egg-wrap' }, [
        el('span', { class: 'about-egg-lead', text: t('about.eggLead', 'Whatever you do, do not press this:') }),
        eggBtn
      ])
    ];
    openModal(modalShell(t('nav.about', 'About Clobi'), body, { wide: true }));
  }

  // ---- Privacy & data notice (GDPR transparency) ---------------------------
  function openPrivacyModal() {
    const head = function (txt) { return el('div', { class: 'privacy-h', text: txt }); };
    const para = function (txt) { return el('p', { class: 'privacy-p', text: txt }); };
    const P = el('div', { class: 'privacy-body' }, [
      para(t('privacy.intro', 'Playing is fully anonymous — an account is optional and only saves your skins across devices. Here is exactly what that involves.')),
      head(t('privacy.collectH', 'What we store')),
      para(t('privacy.collectSkins', 'Only the username you choose, your password as a one-way bcrypt hash (never in plaintext), your skins, and anything you publish. No email, no real name, no IP logs, no analytics, no tracking.')),
      head(t('privacy.whyH', 'Why & legal basis')),
      para(t('privacy.why', 'Solely to provide the features you ask for: saving your skins and crediting your marketplace creations. Legal basis: your consent. We never share your data with third parties.')),
      head(t('privacy.storeH', 'Where & how long')),
      para(t('privacy.store', 'In a database on the game server, kept until you delete your account. Local storage / cookies are used only for functional things (name, session, settings) — never for tracking. Your world lives in YOUR browser (IndexedDB), not on our server.')),
      head(t('privacy.rightsH', 'Your rights (GDPR)')),
      para(t('privacy.rights', 'Access & portability: download everything via "Export my data". Erasure: "Delete account" wipes it all immediately. Rectification: rename and repaint anything, anytime.')),
      head(t('privacy.contactH', 'Data controller')),
      para(t('privacy.contact', 'Contact: info@deltalux.lu'))
    ]);
    openModal(modalShell(t('privacy.title', 'Privacy & your data'), [
      P,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.close', 'Close') })])
      ])
    ]));
  }

  // =========================================================================
  // Account modal (register / login / logout)
  // =========================================================================
  let accountTab = 'login';

  function openAccountModal() {
    if (typeof Store !== 'undefined' && Store.isLoggedIn && Store.isLoggedIn()) openAccountLoggedIn();
    else openAccountAuth();
  }

  function openAccountLoggedIn() {
    const name = (Store.getUsername && Store.getUsername()) || 'penguin';
    const isAdmin = !!(Store.isAdmin && Store.isAdmin());

    function doExport() {
      if (!Store.exportAccountData) return;
      Store.exportAccountData().then(function (data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'clobi-my-data.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      }).catch(function () { /* ignore */ });
    }
    function doDelete() {
      confirmModal(
        t('account.deleteConfirm', 'Permanently delete your account and ALL its data? This cannot be undone.'),
        t('account.delete', 'Delete account'),
        function () {
          if (!Store.deleteAccount) return;
          Store.deleteAccount().then(function () {
            refreshAccountUi();
            if (wardEl && wardEl.classList.contains('active')) refreshWardrobe();
          }).catch(function () { /* ignore */ });
        }
      );
    }

    const body = [
      el('div', { class: 'account-status' }, [
        icon('user', 16),
        el('span', { class: 'account-user', text: t('account.loggedInAs', 'Signed in as') + ' ' + name + (isAdmin ? ' ★' : '') })
      ]),
      el('p', { class: 'modal-lead', text: t('account.skinCloudHint', 'Your skins sync to your account.') }),
      el('div', { class: 'gdpr-row' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: doExport }, [el('span', { text: t('account.export', 'Export my data') })]),
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: openPrivacyModal }, [el('span', { text: t('privacy.link', 'Privacy & data') })])
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.close', 'Close') })]),
        el('button', { class: 'pixbtn pixbtn-danger', type: 'button', onclick: doDelete }, [el('span', { text: t('account.delete', 'Delete account') })]),
        el('button', {
          class: 'pixbtn pixbtn-primary', type: 'button',
          onclick: function () { if (Store.logout) Store.logout(); refreshAccountUi(); closeAnyModal(); }
        }, [icon('logout', 14), el('span', { text: t('account.logout', 'Log out') })])
      ])
    ];
    openModal(modalShell(t('account.signIn', 'Account'), body));
  }

  function openAccountAuth() {
    const userInput = el('input', { class: 'pixinput', type: 'text', maxlength: '24', autocomplete: 'username', spellcheck: 'false', placeholder: t('account.username', 'username') });
    const passInput = el('input', { class: 'pixinput', type: 'password', maxlength: '64', autocomplete: 'current-password', placeholder: t('account.password', 'password') });
    const errLine = el('div', { class: 'form-err', text: '' });

    const consentCheck = el('input', { type: 'checkbox', class: 'consent-check' });
    const consentRow = el('label', { class: 'consent-row' }, [
      consentCheck,
      el('span', { class: 'consent-text' }, [
        document.createTextNode(t('account.consentSkins', 'I agree to my username, hashed password and skins being stored. ')),
        el('a', { class: 'link', href: '#', onclick: function (e) { e.preventDefault(); openPrivacyModal(); } }, [el('span', { text: t('privacy.link', 'Privacy & data') })])
      ])
    ]);

    function makeTabBtn(id, labelKey, labelEn) {
      return el('button', {
        class: 'tab-btn' + (accountTab === id ? ' tab-btn-active' : ''), type: 'button', dataset: { tab: id },
        onclick: function () { accountTab = id; rerender(); }
      }, [el('span', { text: t(labelKey, labelEn) })]);
    }

    const tabs = el('div', { class: 'tab-row' }, [makeTabBtn('login', 'account.login', 'Log in'), makeTabBtn('register', 'account.register', 'Register')]);
    const submitBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [el('span', { text: t('account.login', 'Log in') })]);

    function setBusy(on) {
      submitBtn.disabled = !!on;
      if (on) submitBtn.classList.add('pixbtn-disabled'); else submitBtn.classList.remove('pixbtn-disabled');
    }

    function doSubmit() {
      errLine.textContent = '';
      const u = userInput.value.trim(); const p = passInput.value;
      if (!u || !p) { errLine.textContent = t('account.error', 'Username and password required.'); return; }
      if (accountTab === 'register' && !consentCheck.checked) { errLine.textContent = t('account.mustConsent', 'Please agree to the data notice to register.'); return; }
      if (typeof Store === 'undefined') { errLine.textContent = t('account.error', 'Accounts unavailable.'); return; }
      const action = (accountTab === 'register') ? Store.register : Store.login;
      if (typeof action !== 'function') { errLine.textContent = t('account.error', 'Accounts unavailable.'); return; }
      setBusy(true);
      Promise.resolve(action.call(Store, u, p))
        .then(function () {
          // Pull the account's cloud skin library + its active skin so a fresh
          // device is hydrated immediately.
          if (Store.syncSkinLibrary) {
            try {
              Store.syncSkinLibrary().then(function () {
                if (wardEl && wardEl.classList.contains('active')) refreshWardrobe();
              }).catch(function () { /* offline is fine */ });
            } catch (e) { /* ignore */ }
          }
          if (Store.loadActiveSkinRemote) {
            try {
              Store.loadActiveSkinRemote().then(function (rec) {
                if (rec && rec.png && typeof App !== 'undefined' && App.setSkin) {
                  App.setSkin(rec).catch(function () { /* keep current */ });
                }
              }).catch(function () { /* no cloud skin yet */ });
            } catch (e) { /* ignore */ }
          }
          refreshAccountUi(); closeAnyModal();
        })
        .catch(function (err) { setBusy(false); errLine.textContent = humanizeAuthError(err); });
    }
    submitBtn.addEventListener('click', doSubmit);

    const switchHint = el('div', { class: 'auth-hint' });
    function rerender() {
      const tabBtns = tabs.querySelectorAll('.tab-btn');
      tabBtns[0].classList.toggle('tab-btn-active', accountTab === 'login');
      tabBtns[1].classList.toggle('tab-btn-active', accountTab === 'register');
      submitBtn.querySelector('span').textContent = accountTab === 'login' ? t('account.login', 'Log in') : t('account.register', 'Register');
      clear(switchHint);
      if (accountTab === 'login') {
        switchHint.appendChild(document.createTextNode(t('account.signUp', 'Need an account?') + ' '));
        switchHint.appendChild(el('a', { class: 'link', href: '#', onclick: function (e) { e.preventDefault(); accountTab = 'register'; rerender(); } }, [el('span', { text: t('account.register', 'Register') })]));
      } else {
        switchHint.appendChild(document.createTextNode(t('account.signIn', 'Have an account?') + ' '));
        switchHint.appendChild(el('a', { class: 'link', href: '#', onclick: function (e) { e.preventDefault(); accountTab = 'login'; rerender(); } }, [el('span', { text: t('account.login', 'Log in') })]));
      }
      consentRow.style.display = (accountTab === 'register') ? 'flex' : 'none';
      errLine.textContent = ''; setBusy(false);
    }

    const enterToSubmit = function (e) { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } };
    userInput.addEventListener('keydown', enterToSubmit);
    passInput.addEventListener('keydown', enterToSubmit);

    const body = [
      tabs,
      el('p', { class: 'account-lead', text: t('account.skinSyncHint', 'Optional. Sign in to sync your skins and credit your creations.') }),
      formRow(t('account.username', 'Username'), userInput),
      formRow(t('account.password', 'Password'), passInput),
      consentRow, errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        submitBtn
      ]),
      switchHint
    ];
    openModal(modalShell(t('account.signIn', 'Account'), body));
    rerender();
    setTimeout(function () { userInput.focus(); }, 30);
  }

  function humanizeAuthError(err) {
    let msg = '';
    if (err) { if (typeof err === 'string') msg = err; else if (err.error) msg = err.error; else if (err.message) msg = err.message; }
    if (!msg) msg = t('account.error', 'Something went wrong.');
    return msg;
  }

  // ---- Account UI (top-right button) ------------------------------------
  function refreshAccountUi() {
    const btn = byId('menu-signin-btn'); if (!btn) return;
    const label = btn.querySelector('.signin-label');
    const loggedIn = (typeof Store !== 'undefined' && Store.isLoggedIn && Store.isLoggedIn());
    if (loggedIn) {
      const name = (Store.getUsername && Store.getUsername()) || t('nav.signIn', 'Account');
      if (label) label.textContent = name;
      btn.classList.add('signed-in'); btn.title = name;
    } else {
      if (label) label.textContent = t('nav.signIn', 'Sign in');
      btn.classList.remove('signed-in'); btn.title = t('nav.signIn', 'Sign in');
    }
  }

  // ---- Language switcher / first-visit popup -----------------------------
  function currentLangCode() { if (typeof I18n !== 'undefined' && I18n.get) return I18n.get(); return 'en'; }
  function currentLangName() {
    const code = currentLangCode();
    const langs = (typeof I18n !== 'undefined' && I18n.LANGS) ? I18n.LANGS : [];
    for (let i = 0; i < langs.length; i++) if (langs[i].code === code) return langs[i].name;
    return code.toUpperCase();
  }

  function updateMuteBtn() {
    var b = byId('menu-mute-btn'); if (!b) return;
    var m = window.Sound && Sound.isMuted && Sound.isMuted();
    clear(b); b.appendChild(icon(m ? 'mute' : 'volume', 13));
  }

  function showLanguagePopup() {
    const langs = (typeof I18n !== 'undefined' && I18n.LANGS) ? I18n.LANGS : [{ code: 'en', name: 'English' }];
    const active = currentLangCode();
    const listWrap = el('div', { class: 'lang-list' });
    langs.forEach(function (lang) {
      const isDefault = (lang.code === 'en');
      const isActive = (lang.code === active);
      const row = el('button', {
        type: 'button',
        class: 'lang-row' + (isActive ? ' lang-row-active' : '') + (isDefault ? ' lang-row-default' : ''),
        dataset: { code: lang.code }, onclick: function () { chooseLanguage(lang.code); }
      }, [
        el('span', { class: 'lang-code', text: lang.code.toUpperCase() }),
        el('span', { class: 'lang-name', text: lang.name }),
        isDefault ? el('span', { class: 'lang-default-tag', text: '*' }) : null,
        isActive ? el('span', { class: 'lang-check' }, [icon('check', 12)]) : null
      ]);
      listWrap.appendChild(row);
    });
    openModal(modalShell(t('nav.language', 'Language'), [el('p', { class: 'lang-lead', text: t('lang.choose', 'Choose your language') }), listWrap]));
  }

  function chooseLanguage(code) {
    if (typeof I18n !== 'undefined' && I18n.set) I18n.set(code);
    const langLabel = rootEl && rootEl.querySelector('#menu-lang-btn .corner-lang-label');
    if (langLabel) langLabel.textContent = currentLangName();
    closeAnyModal();
  }

  // ---- toast ---------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, kind) {
    let host = byId('menu-toast');
    if (!host) { host = el('div', { id: 'menu-toast' }); document.body.appendChild(host); }
    host.className = 'toast toast-' + (kind || 'info') + ' toast-show';
    host.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.classList.remove('toast-show'); }, 2800);
  }

  // ---- styles (8-bit; self-injected layout — style.css reskins on top) -----
  function injectStyles() {
    if (byId('menu-styles')) return;
    const css = [
      '#screen-menu{font-family:"Press Start 2P",monospace;color:#e8ecf5;position:relative;min-height:100%;}',
      '.menu-inner{max-width:760px;margin:0 auto;padding:28px 16px 40px;}',
      // title
      '.menu-title{text-align:center;margin:10px 0 16px;}',
      '.title-eyebrow{font-size:8px;color:#646b8a;letter-spacing:4px;margin:0 0 12px;}',
      '.title-main{margin:0;font-size:34px;line-height:1.1;color:#ff9e2c;letter-spacing:2px;text-shadow:4px 4px 0 #1a1d2e,6px 6px 0 #2b5fff;}',
      '.title-sub{margin:6px 0 0;font-size:24px;color:#7ff9e0;letter-spacing:8px;text-shadow:3px 3px 0 #1a1d2e;}',
      '.title-tag{margin:14px auto 0;max-width:560px;font-size:9px;line-height:1.7;color:#9aa3bf;}',
      // hero turntable
      '.menu-hero{display:flex;flex-direction:column;align-items:center;gap:10px;margin:0 0 20px;}',
      '.hero-stage{width:min(300px,74vw);aspect-ratio:4/5;background:#10121f;border:4px solid #3a3f5c;box-shadow:6px 6px 0 #0a0b14;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;}',
      '.hero-canvas{width:100%;height:100%;display:block;touch-action:none;cursor:grab;}',
      '.hero-canvas:active{cursor:grabbing;}',
      '.hero-fallback{font-size:9px;line-height:1.9;color:#9aa3bf;padding:18px;text-align:center;}',
      '.hero-caption{display:flex;align-items:center;gap:10px;font-size:9px;color:#9aa3bf;flex-wrap:wrap;justify-content:center;}',
      '.hero-skin-name{color:#7ff9e0;}',
      '.hero-model-badge{font-size:7px;color:#1a1d2e;background:#7ff9e0;padding:3px 6px;border:2px solid #1a1d2e;text-transform:uppercase;letter-spacing:1px;}',
      '.hero-model-badge.slim{background:#b07aff;}',
      // play cluster
      '.menu-play-row{display:flex;flex-direction:column;align-items:center;gap:10px;margin:0 0 18px;}',
      '#menu-play-btn{min-width:260px;padding:18px 22px;font-size:14px;}',
      // nickname
      '.menu-nick-row{display:flex;flex-direction:column;align-items:center;gap:8px;margin:0 0 18px;}',
      '.nick-label{font-size:9px;color:#9aa3bf;letter-spacing:1px;}',
      '.kahoot-nick{width:100%;max-width:420px;text-align:center;font-size:14px;padding:14px 12px;}',
      // inputs
      '.pixinput{font-family:inherit;background:#10121f;color:#e8ecf5;border:3px solid #3a3f5c;box-shadow:4px 4px 0 #0a0b14;padding:12px;font-size:11px;outline:none;border-radius:0;width:100%;box-sizing:border-box;}',
      '.pixinput:focus{border-color:#7ff9e0;box-shadow:4px 4px 0 #0a0b14,0 0 0 2px #7ff9e0 inset;}',
      // buttons
      '.pixbtn{font-family:inherit;font-size:11px;color:#e8ecf5;background:#262a44;border:3px solid #e8ecf5;box-shadow:5px 5px 0 #0a0b14;padding:12px 16px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center;border-radius:0;}',
      '.pixbtn:hover{background:#e8ecf5;color:#1a1d2e;}',
      '.pixbtn:active{transform:translate(2px,2px);box-shadow:3px 3px 0 #0a0b14;}',
      '.pixbtn-primary{background:#ff9e2c;color:#1a1d2e;border-color:#1a1d2e;}',
      '.pixbtn-primary:hover{background:#ffd39e;color:#1a1d2e;}',
      '.pixbtn-danger{background:#2b5fff;color:#fff;border-color:#1a1d2e;}',
      '.pixbtn-danger:hover{background:#7ff9e0;color:#1a1d2e;}',
      '.pixbtn-ghost{font-family:inherit;font-size:10px;color:#9aa3bf;background:transparent;border:2px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;padding:8px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border-radius:0;}',
      '.pixbtn-ghost:hover{color:#1a1d2e;background:#7ff9e0;border-color:#1a1d2e;}',
      '.pixbtn-disabled,.pixbtn:disabled{opacity:.45;cursor:not-allowed;}',
      // actions row
      '.menu-actions{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin:0 0 26px;}',
      '.menu-actions .pixbtn{min-width:180px;padding:16px 18px;font-size:12px;}',
      // top-right corner
      '.menu-corner{position:absolute;top:12px;right:14px;z-index:30;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}',
      '.corner-btn{font-size:9px;padding:6px 10px;color:#9aa3bf;}',
      '.corner-lang-label,.signin-label{letter-spacing:1px;}',
      '.signin-btn.signed-in{color:#7ff9e0;border-color:#7ff9e0;}',
      // about
      '.about-p{font-size:9px;color:#cfd4e8;line-height:1.9;margin:0 0 10px;}',
      '.about-egg-wrap{margin-top:8px;display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;}',
      '.about-egg-lead{font-size:8px;color:#646b8a;}',
      '.about-egg{border-color:#2b5fff;color:#2b5fff;}',
      '.about-egg:hover{background:#2b5fff;color:#fff;border-color:#1a1d2e;}',
      // footer
      '.menu-footer{margin-top:18px;text-align:center;font-size:8px;line-height:1.9;color:#646b8a;pointer-events:auto;}',
      '.footer-line{margin-bottom:12px;}',
      '.menu-oss{display:inline-flex;align-items:center;gap:6px;color:#7ff9e0;text-decoration:none;border:2px solid #2a3350;background:#11131f;padding:6px 11px;font-size:8px;letter-spacing:1px;cursor:pointer;}',
      '.menu-oss:hover{background:#7ff9e0;color:#11131f;border-color:#7ff9e0;}',
      '.footer-links{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}',
      '.accent-mint{color:#7ff9e0;}',
      '.accent-blue{color:#2b5fff;}',
      // account / gdpr
      '.gdpr-row{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 2px;}',
      '.gdpr-row .pixbtn-ghost{font-size:8px;padding:9px 11px;}',
      '.consent-row{display:flex;align-items:flex-start;gap:9px;margin:10px 0 2px;cursor:pointer;}',
      '.consent-check{margin-top:2px;width:16px;height:16px;accent-color:#7ff9e0;flex:0 0 auto;}',
      '.consent-text{font-size:8px;color:#cfd4e8;line-height:1.7;}',
      '.privacy-body{max-height:54vh;overflow-y:auto;padding-right:6px;}',
      '.privacy-h{font-size:10px;color:#ff9e2c;margin:12px 0 4px;text-shadow:1px 1px 0 #000;}',
      '.privacy-p{font-size:9px;color:#cfd4e8;line-height:1.8;margin:0 0 4px;}',
      // modal
      '.modal-overlay{position:fixed;inset:0;background:rgba(8,9,16,.82);display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px;}',
      '.pixmodal{font-family:"Press Start 2P",monospace;background:#181b2c;border:4px solid #7ff9e0;box-shadow:8px 8px 0 #0a0b14;width:100%;max-width:400px;color:#e8ecf5;max-height:90vh;overflow-y:auto;}',
      '.pixmodal-wide{max-width:560px;}',
      '.pixmodal-head{display:flex;align-items:center;justify-content:space-between;padding:14px;border-bottom:3px solid #3a3f5c;background:#10121f;position:sticky;top:0;}',
      '.pixmodal-title{margin:0;font-size:13px;color:#7ff9e0;}',
      '.modal-x{font-family:inherit;background:transparent;border:2px solid #3a3f5c;color:#9aa3bf;cursor:pointer;padding:5px;display:inline-flex;}',
      '.modal-x:hover{color:#1a1d2e;background:#ff6b6b;border-color:#1a1d2e;}',
      '.pixmodal-body{padding:18px 16px;display:flex;flex-direction:column;gap:14px;}',
      '.form-row{display:flex;flex-direction:column;gap:7px;}',
      '.form-label{font-size:9px;color:#9aa3bf;letter-spacing:1px;}',
      '.form-hint{font-size:7px;color:#646b8a;line-height:1.6;}',
      '.form-err{font-size:8px;color:#ff6b6b;line-height:1.6;min-height:10px;}',
      '.modal-lead{font-size:9px;line-height:1.7;color:#cfd5e8;}',
      '.modal-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px;}',
      // account tabs (also reused as mode/model toggles)
      '.tab-row{display:flex;gap:0;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;}',
      '.tab-btn{flex:1;font-family:inherit;font-size:10px;background:#10121f;color:#9aa3bf;border:none;padding:10px;cursor:pointer;}',
      '.tab-btn+.tab-btn{border-left:3px solid #3a3f5c;}',
      '.tab-btn-active{background:#7ff9e0;color:#1a1d2e;}',
      '.account-lead{font-size:8px;color:#646b8a;line-height:1.7;margin:0;}',
      '.account-status{display:flex;align-items:center;gap:10px;font-size:11px;color:#7ff9e0;}',
      '.account-user{font-size:11px;line-height:1.5;}',
      '.auth-hint{font-size:8px;color:#9aa3bf;text-align:center;line-height:1.7;}',
      '.link{color:#7ff9e0;text-decoration:underline;cursor:pointer;}',
      '.link:hover{color:#ff9e2c;}',
      // language popup
      '.lang-lead{font-size:9px;color:#9aa3bf;line-height:1.7;margin:0;text-align:center;}',
      '.lang-list{display:flex;flex-direction:column;gap:8px;}',
      '.lang-row{font-family:inherit;display:flex;align-items:center;gap:10px;background:#10121f;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;color:#cfd5e8;padding:12px;cursor:pointer;text-align:left;border-radius:0;}',
      '.lang-row:hover{border-color:#7ff9e0;color:#fff;}',
      '.lang-row-active{border-color:#ff9e2c;color:#ff9e2c;}',
      '.lang-row-default{box-shadow:3px 3px 0 #0a0b14,0 0 0 2px #2b5fff inset;}',
      '.lang-code{font-size:9px;color:#7ff9e0;width:28px;flex:0 0 auto;}',
      '.lang-name{font-size:10px;flex:1;}',
      '.lang-default-tag{color:#2b5fff;font-size:10px;}',
      '.lang-check{color:#ff9e2c;display:inline-flex;}',
      // wardrobe import modal bits (grid/card styles live in style.css)
      '.wd-import-row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;}',
      '.wd-import-preview{flex:0 0 auto;width:120px;min-height:150px;background:#10121f;border:3px solid #3a3f5c;display:flex;align-items:center;justify-content:center;overflow:hidden;}',
      '.wd-import-fields{flex:1 1 180px;display:flex;flex-direction:column;gap:12px;}',
      // toast
      '#menu-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);font-family:"Press Start 2P",monospace;font-size:9px;line-height:1.6;color:#1a1d2e;padding:12px 16px;border:3px solid #1a1d2e;box-shadow:5px 5px 0 #0a0b14;opacity:0;pointer-events:none;z-index:9500;max-width:90vw;text-align:center;transition:opacity .15s,transform .15s;}',
      '#menu-toast.toast-show{opacity:1;transform:translateX(-50%) translateY(0);}',
      '.toast-info{background:#7ff9e0;}',
      '.toast-warn{background:#ff9e2c;}',
      '.toast-danger{background:#ff6b6b;color:#1a1d2e;}',
      // responsive
      '@media (max-width:560px){.title-main{font-size:24px;}.title-sub{font-size:17px;letter-spacing:5px;}.menu-actions .pixbtn{min-width:140px;}#menu-play-btn{min-width:0;width:100%;max-width:340px;}}'
    ].join('\n');
    const style = el('style', { id: 'menu-styles' });
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- public API --------------------------------------------------------
  const Menu = {
    show: show,
    hide: hide,
    showWardrobe: showWardrobe,
    hideWardrobe: hideWardrobe,
    showLanguagePopup: showLanguagePopup,
    openSignIn: openAccountModal,
    showAbout: showAbout,
    toast: toast
  };
  return Menu;
})();

window.Menu = Menu;
