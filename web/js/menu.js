// menu.js -- global Menu.
//
// The home screen of Clobi's Arena. The realtime PvP gamemodes (Tux Smash /
// Distro Royale) are retired and chained up behind a dramatic W.I.P. placeholder;
// the menu now leads to the creative tools:
//   - [Create] the texture paint tool (draw your own grayscale cosmetics),
//   - [Marketplace] the open-source, always-free cosmetic marketplace,
//   - [Edit Character] the universal Tux / Humanoid editor.
//   - A SUBTLE top-right corner: language switcher, sound toggle, About (lore),
//     and a Sign in button (account modal: register / login / logout via Store).
//   - Menu.showLanguagePopup(): the first-visit / on-demand language chooser.
//
// A respectful TRIBUTE to Clobi delivered through comedy: vim, Fisherman's Friend,
// Linux, and a militant NO to Windows (the "Activate Windows" gag lives on as an
// About-modal easter egg). ZERO forced-signup nags. All user-facing text flows
// through I18n.t(key, fallbackEn) and re-renders when the language changes.
//
// Exposes exactly one global: window.Menu
// Depends on globals: Store, Sprites, I18n, App, Editor (and optionally Paint, Market).

const Menu = (function () {
  'use strict';

  // ---- internal state ----------------------------------------------------
  let rootEl = null;          // #screen-menu
  let built = false;          // DOM built once
  let i18nWired = false;      // I18n.onChange attached once

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
    svg.style.imageRendering = 'pixelated';
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
    lock: ['M5 11 H19 V21 H5 Z', 'M8 11 V7 A4 4 0 0 1 16 7 V11'],
    plus: ['M12 5 V19', 'M5 12 H19'],
    check: ['M5 13 L10 18 L19 6'],
    x: ['M6 6 L18 18', 'M18 6 L6 18'],
    logout: ['M14 4 H6 V20 H14', 'M10 12 H21', 'M17 8 L21 12 L17 16'],
    globe: ['M3 12 A9 9 0 1 0 21 12 A9 9 0 1 0 3 12', 'M3 12 H21', 'M12 3 C8 7 8 17 12 21', 'M12 3 C16 7 16 17 12 21'],
    code: ['M9 8 L5 12 L9 16', 'M15 8 L19 12 L15 16'],
    info: ['M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3', 'M12 11 V16', 'M12 7 H12.01'],
    volume: ['M4 9 H7 L11 5 V19 L7 15 H4 Z', 'M15 9 A4 4 0 0 1 15 15'],
    mute: ['M4 9 H7 L11 5 V19 L7 15 H4 Z', 'M15 9 L20 15', 'M20 9 L15 15'],
    // creative tools
    brush: ['M4 20 C7 20 8 18 10 16', 'M10 16 L18 8', 'M14 4 L20 10 L17 13 L11 7 Z'],
    palette: ['M12 4 A8 8 0 1 0 13 20 C14 20 13.5 18 15 17 C16.5 16 18 17 18 15 A4 4 0 0 0 18 12 A8 8 0 0 0 12 4 Z', 'M8 11 H8.01', 'M12 8 H12.01', 'M16 11 H16.01'],
    store: ['M4 9 L5 5 H19 L20 9', 'M4 9 H20 V20 H4 Z', 'M9 20 V14 H15 V20'],
    chain: ['M8 9 A3 3 0 0 0 8 15 H10', 'M16 9 A3 3 0 0 1 16 15 H14', 'M9 12 H15'],
    edit: ['M5 19 H9 L18 10 L14 6 L5 15 Z', 'M13 7 L17 11']
  };

  // ---- screen build ------------------------------------------------------
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

    // ---------- Top-right corner: about + sound + language + sign-in ----------
    const aboutBtn = el('button', {
      id: 'menu-about-btn', class: 'corner-btn pixbtn-ghost', type: 'button',
      title: t('nav.about', 'About'),
      onclick: function () { if (window.Sound) Sound.play('click'); showAbout(); }
    }, [icon('info', 13), el('span', { class: 'corner-lang-label', text: t('nav.about', 'About') })]);

    const muteBtn = el('button', {
      id: 'menu-mute-btn', class: 'corner-btn pixbtn-ghost', type: 'button',
      title: t('nav.sound', 'Sound'),
      onclick: function () { if (window.Sound) Sound.toggleMute(); updateMuteBtn(); }
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

    // ---------- Title ----------
    const title = el('div', { class: 'menu-title' }, [
      el('h1', { class: 'title-main', text: 'TUX SMASH' }),
      el('h2', { class: 'title-sub', text: 'ROYALE' }),
      el('p', { id: 'menu-tagline', class: 'title-tag', text: t('app.tagline', "Clobi's Arena — forge your fighter.") })
    ]);

    // ---------- Identity: display name ----------
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

    // ---------- Primary actions: Create / Marketplace / Edit ----------
    const createBtn = el('button', {
      id: 'menu-create-btn', class: 'pixbtn pixbtn-primary', type: 'button', onclick: onClickCreate
    }, [icon('brush', 16), el('span', { text: t('nav.create', 'Create') })]);

    const marketBtn = el('button', {
      id: 'menu-market-btn', class: 'pixbtn', type: 'button', onclick: onClickMarketplace
    }, [icon('store', 16), el('span', { text: t('nav.marketplace', 'Marketplace') })]);

    const editBtn = el('button', {
      id: 'menu-edit-btn', class: 'pixbtn', type: 'button', onclick: onClickEditCharacter
    }, [icon('edit', 16), el('span', { text: t('nav.editChar', 'Edit Character') })]);

    const actionRow = el('div', { class: 'menu-actions' }, [createBtn, marketBtn, editBtn]);

    // ---------- Chained-up W.I.P. arena placeholder ----------
    const wip = buildWipArena();

    // ---------- Footer tribute (comedy, respectful) ----------
    const footer = el('div', { id: 'menu-footer', class: 'menu-footer' }, footerNodes());

    rootEl.appendChild(corner);
    rootEl.appendChild(el('div', { class: 'menu-inner' }, [title, nickRow, actionRow, wip, footer]));

    injectStyles();
    built = true;
  }

  // The dramatic, chained-up arena: Tux Smash & Distro Royale are locked away.
  function buildWipArena() {
    const stamp = el('div', { class: 'wip-stamp', text: 'W.I.P.' });
    const inner = el('div', { class: 'wip-inner' }, [
      el('div', { class: 'wip-badge' }, [icon('lock', 26)]),
      el('h3', { id: 'wip-title', class: 'wip-title', text: t('wip.title', 'The Arena') }),
      stamp,
      el('p', { id: 'wip-desc', class: 'wip-desc', text: t('wip.desc', 'Tux Smash & Distro Royale are chained up while Clobi forges something new. The belly-bashing returns soon™.') })
    ]);
    // Two crossing chains + a padlock, drawn in pure CSS over the panel.
    return el('div', { class: 'wip-arena' }, [
      el('div', { class: 'wip-chain wip-chain-a' }),
      el('div', { class: 'wip-chain wip-chain-b' }),
      inner
    ]);
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
    setText('menu-tagline', t('app.tagline', "Clobi's Arena — forge your fighter."));
    setText('menu-nick-label', t('menu.nickname', 'Display name'));
    setPlaceholder('menu-nickname', t('menu.nicknamePh', 'Your penguin name'));
    setBtnLabel('menu-create-btn', t('nav.create', 'Create'));
    setBtnLabel('menu-market-btn', t('nav.marketplace', 'Marketplace'));
    setBtnLabel('menu-edit-btn', t('nav.editChar', 'Edit Character'));
    setText('wip-title', t('wip.title', 'The Arena'));
    setText('wip-desc', t('wip.desc', 'Tux Smash & Distro Royale are chained up while Clobi forges something new. The belly-bashing returns soon™.'));

    const langLabel = rootEl && rootEl.querySelector('#menu-lang-btn .corner-lang-label');
    if (langLabel) langLabel.textContent = currentLangName();
    const aboutLabel = rootEl && rootEl.querySelector('#menu-about-btn .corner-lang-label');
    if (aboutLabel) aboutLabel.textContent = t('nav.about', 'About');
    refreshAccountUi();
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
    syncFromApp();
    refreshAccountUi();

    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu');
    else { rootEl.classList.add('active'); rootEl.style.display = ''; }

    if (window.Sound) { window.Sound.unlock(); window.Sound.music('menu'); }
    updateMuteBtn();
  }

  function hide() { /* nothing to tear down anymore */ }

  function wireI18n() {
    if (i18nWired || typeof I18n === 'undefined' || !I18n.onChange) return;
    I18n.onChange(function () { rebuildStaticText(); });
    i18nWired = true;
  }

  // A stale token was dropped by Store (e.g. after a server restart): reflect the
  // signed-out state and let the player know so nothing fails silently.
  let authWired = false;
  function wireAuthExpiry() {
    if (authWired || typeof window === 'undefined') return;
    window.addEventListener('clobi:auth-expired', function () {
      refreshAccountUi();
      toast(t('account.sessionExpired', 'Your session expired — please sign in again.'), 'warn');
    });
    authWired = true;
  }

  // ---- App / Store sync --------------------------------------------------
  function getNickname() {
    if (typeof App !== 'undefined' && App.nickname) return App.nickname;
    if (typeof Store !== 'undefined' && Store.getNickname) return Store.getNickname() || '';
    return '';
  }
  function setNickname(n) {
    n = (n || '').slice(0, 16);
    if (typeof App !== 'undefined') { try { App.nickname = n; } catch (e) { /* read-only */ } }
    else if (typeof Store !== 'undefined' && Store.setNickname) Store.setNickname(n);
  }
  function syncFromApp() { const input = byId('menu-nickname'); if (input) input.value = getNickname(); }
  function onNicknameInput(e) { setNickname(e.target.value); }

  // ---- primary actions ---------------------------------------------------
  function onClickCreate() {
    if (window.Sound) Sound.play('click');
    if (window.Paint && Paint.open) {
      Paint.open();
      if (typeof App !== 'undefined' && App.showScreen) App.showScreen('create');
    } else {
      toast(t('soon.create', 'The paint studio is warming up — coming soon!'), 'info');
    }
  }

  function onClickMarketplace() {
    if (window.Sound) Sound.play('click');
    if (window.Market && Market.open) {
      Market.open();
      if (typeof App !== 'undefined' && App.showScreen) App.showScreen('marketplace');
    } else {
      toast(t('soon.market', 'The marketplace is opening its doors — coming soon!'), 'info');
    }
  }

  function onClickEditCharacter() {
    if (window.Sound) Sound.play('click');
    if (typeof Editor !== 'undefined' && Editor.open) Editor.open();
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('editor');
  }

  // ---- Modal infrastructure ---------------------------------------------
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

  // ---- About / lore modal (with the Activate Windows easter egg) ---------
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
      p(t('about.l2', 'This is his arena: build penguins and people, paint your own cosmetics, and share them in an always-free, open-source marketplace. The brawling modes are chained up for now — but the workshop is wide open.')),
      el('div', { class: 'about-egg-wrap' }, [
        el('span', { class: 'about-egg-lead', text: t('about.eggLead', 'Whatever you do, do not press this:') }),
        eggBtn
      ])
    ];
    openModal(modalShell(t('nav.about', 'About Clobi'), body, { wide: true }));
  }

  // ---- Account modal (register / login / logout) ------------------------
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
      if (!window.confirm(t('account.deleteConfirm', 'Permanently delete your account and ALL its data? This cannot be undone.'))) return;
      Store.deleteAccount().then(function () {
        if (typeof App !== 'undefined' && App.updateCharacter && typeof Sprites !== 'undefined' && Sprites.defaultCharacter) {
          try { App.updateCharacter(Sprites.defaultCharacter()); } catch (e) { /* ignore */ }
        }
        refreshAccountUi(); closeAnyModal();
      }).catch(function () { /* ignore */ });
    }

    const body = [
      el('div', { class: 'account-status' }, [
        icon('user', 16),
        el('span', { class: 'account-user', text: t('account.loggedInAs', 'Signed in as') + ' ' + name + (isAdmin ? ' ★' : '') })
      ]),
      el('p', { class: 'modal-lead', text: t('account.cloudHint', 'Your character syncs to your account.') }),
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

  // Privacy & data notice (GDPR transparency).
  function openPrivacyModal() {
    const head = function (txt) { return el('div', { class: 'privacy-h', text: txt }); };
    const para = function (txt) { return el('p', { class: 'privacy-p', text: txt }); };
    const P = el('div', { class: 'privacy-body' }, [
      para(t('privacy.intro', 'Playing is fully anonymous — an account is optional and only saves your penguin and your published cosmetics across devices. Here is exactly what that involves.')),
      head(t('privacy.collectH', 'What we store')),
      para(t('privacy.collect', 'Only the username you choose, your password as a one-way bcrypt hash (never in plaintext), your character configuration, and any textures/characters you publish. No email, no real name, no IP logs, no analytics, no tracking.')),
      head(t('privacy.whyH', 'Why & legal basis')),
      para(t('privacy.why', 'Solely to provide the features you ask for: saving your penguin and crediting your marketplace creations. Legal basis: your consent. We never share your data with third parties.')),
      head(t('privacy.storeH', 'Where & how long')),
      para(t('privacy.store', 'In an embedded database on the game server, kept until you delete your account. Local storage / cookies are used only for functional things (name, session, settings) — never for tracking.')),
      head(t('privacy.rightsH', 'Your rights (GDPR)')),
      para(t('privacy.rights', 'Access & portability: download everything via "Export my data". Erasure: "Delete account" wipes it all immediately. Rectification: change your name and character anytime in the editor.')),
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

  function openAccountAuth() {
    const userInput = el('input', { class: 'pixinput', type: 'text', maxlength: '24', autocomplete: 'username', spellcheck: 'false', placeholder: t('account.username', 'username') });
    const passInput = el('input', { class: 'pixinput', type: 'password', maxlength: '64', autocomplete: 'current-password', placeholder: t('account.password', 'password') });
    const errLine = el('div', { class: 'form-err', text: '' });

    const consentCheck = el('input', { type: 'checkbox', class: 'consent-check' });
    const consentRow = el('label', { class: 'consent-row' }, [
      consentCheck,
      el('span', { class: 'consent-text' }, [
        document.createTextNode(t('account.consent', 'I agree to my username, hashed password and character being stored. ')),
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
      submitBtn.disabled = on ? 'disabled' : null;
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
        .then(function (res) {
          syncCharacterFromStore(res);
          // The account's painted cosmetics are now in the cache — register them.
          if (typeof App !== 'undefined' && App.refreshTextures) { try { App.refreshTextures(); } catch (e) { /* ignore */ } }
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
      el('p', { class: 'account-lead', text: t('account.cloudHint', 'Optional. Sign in to sync your penguin and credit your creations.') }),
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

  function syncCharacterFromStore(res) {
    let character = null;
    if (res && res.character) character = res.character;
    else if (res && res.bodyType) character = res; // store.register/login resolve with the character
    else if (typeof Store !== 'undefined' && Store.getCharacter) character = Store.getCharacter();
    if (character && typeof App !== 'undefined') {
      if (App.updateCharacter) App.updateCharacter(character);
      else { try { App.character = character; } catch (e) { /* ignore */ } }
    }
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

  // ---- form + toast helpers ---------------------------------------------
  function formRow(labelText, control, hintText) {
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'form-label', text: labelText }), control,
      hintText ? el('div', { class: 'form-hint', text: hintText }) : null
    ]);
  }

  let toastTimer = null;
  function toast(msg, kind) {
    let host = byId('menu-toast');
    if (!host) { host = el('div', { id: 'menu-toast' }); document.body.appendChild(host); }
    host.className = 'toast toast-' + (kind || 'info') + ' toast-show';
    host.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.classList.remove('toast-show'); }, 2800);
  }

  // ---- styles (8-bit; self-injected) -------------------------------------
  function injectStyles() {
    if (byId('menu-styles')) return;
    const css = [
      '#screen-menu{font-family:"Press Start 2P",monospace;color:#e8ecf5;position:relative;min-height:100%;}',
      '.menu-inner{max-width:740px;margin:0 auto;padding:28px 16px 40px;}',
      // title
      '.menu-title{text-align:center;margin:14px 0 22px;}',
      '.title-main{margin:0;font-size:30px;line-height:1.1;color:#ff9e2c;letter-spacing:2px;text-shadow:4px 4px 0 #1a1d2e,6px 6px 0 #2b5fff;}',
      '.title-sub{margin:6px 0 0;font-size:22px;color:#7ff9e0;letter-spacing:6px;text-shadow:3px 3px 0 #1a1d2e;}',
      '.title-tag{margin:14px auto 0;max-width:560px;font-size:9px;line-height:1.7;color:#9aa3bf;}',
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
      '.menu-actions{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin:0 0 28px;}',
      '.menu-actions .pixbtn{min-width:180px;padding:16px 18px;font-size:12px;}',
      // chained W.I.P. arena
      '.wip-arena{position:relative;overflow:hidden;background:#10121f;border:4px solid #3a3f5c;box-shadow:6px 6px 0 #0a0b14;padding:26px 18px;margin:0 0 22px;text-align:center;}',
      '.wip-inner{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:10px;}',
      '.wip-badge{width:54px;height:54px;display:flex;align-items:center;justify-content:center;color:#ffe34d;background:#1a1d2e;border:3px solid #ffe34d;box-shadow:3px 3px 0 #0a0b14;animation:wip-sway 3.2s ease-in-out infinite;}',
      '.wip-title{margin:4px 0 0;font-size:16px;color:#cfd5e8;letter-spacing:2px;text-shadow:3px 3px 0 #0a0b14;}',
      '.wip-stamp{font-size:30px;color:#ff4d5e;letter-spacing:4px;border:4px solid #ff4d5e;padding:4px 14px;transform:rotate(-7deg);text-shadow:3px 3px 0 #0a0b14;box-shadow:4px 4px 0 #0a0b14;background:#1a1d2e;}',
      '.wip-desc{max-width:480px;font-size:9px;line-height:1.8;color:#9aa3bf;margin:6px 0 0;}',
      // two crossing chains drawn in CSS (chunky metallic links)
      '.wip-chain{position:absolute;left:-20%;width:140%;height:26px;top:50%;z-index:1;opacity:.85;',
      '  background:repeating-linear-gradient(90deg,#2e3457 0 5px,#565c84 5px 9px,#8a90b8 9px 13px,#565c84 13px 17px,#2e3457 17px 22px);',
      '  border-top:3px solid #0a0b14;border-bottom:3px solid #0a0b14;}',
      '.wip-chain-a{transform:translateY(-50%) rotate(11deg);}',
      '.wip-chain-b{transform:translateY(-50%) rotate(-11deg);}',
      '@keyframes wip-sway{0%,100%{transform:rotate(-5deg);}50%{transform:rotate(5deg);}}',
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
      // footer (clickable! the old pointer-events:none bug is gone)
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
      '.modal-lead{font-size:9px;line-height:1.7;color:#cfd5e8;display:flex;align-items:center;gap:6px;}',
      '.modal-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px;}',
      // account tabs
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
      // toast
      '#menu-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);font-family:"Press Start 2P",monospace;font-size:9px;line-height:1.6;color:#1a1d2e;padding:12px 16px;border:3px solid #1a1d2e;box-shadow:5px 5px 0 #0a0b14;opacity:0;pointer-events:none;z-index:9500;max-width:90vw;text-align:center;transition:opacity .15s,transform .15s;}',
      '#menu-toast.toast-show{opacity:1;transform:translateX(-50%) translateY(0);}',
      '.toast-info{background:#7ff9e0;}',
      '.toast-warn{background:#ff9e2c;}',
      '.toast-danger{background:#ff6b6b;color:#1a1d2e;}',
      // responsive
      '@media (max-width:560px){.title-main{font-size:22px;}.title-sub{font-size:16px;}.menu-actions .pixbtn{min-width:140px;}.wip-stamp{font-size:22px;}}'
    ].join('\n');
    const style = el('style', { id: 'menu-styles' });
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- public API --------------------------------------------------------
  const Menu = {
    show: show,
    hide: hide,
    showLanguagePopup: showLanguagePopup,
    openSignIn: openAccountModal,
    showAbout: showAbout,
    toast: toast
  };
  return Menu;
})();

window.Menu = Menu;
