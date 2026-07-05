// commands.js — chat + /command registry for CLOBI CRAFT (contract §5.13).
// Exactly one global: window.Commands.
//
// Consumes: Game (via ctx.game), HUD (via ctx.hud — chatPrint), I18n (guarded),
//           Blocks (for /give lookup), Store (guarded, for the chat echo name).
//
// API (pinned):
//   Commands.init(ctx)                 // ctx: {game, hud}
//   Commands.exec(line)                // "/gamemode creative" or plain chat text
//   Commands.register(name, {usage, help, aliases?, exec(args, ctx)})
//   Commands.list() -> [{name, usage, help}]
//
// Parsing: whitespace split, no quoting. `~` relative coordinates in /tp.
// Unknown command -> red 'vox.cmd.unknown' line. /regen requires an explicit
// confirm flag (/regen confirm [seed]) instead of a modal.

var Commands = (function () {
  'use strict';

  // ---- tiny helpers -------------------------------------------------------

  function t(key, en) {
    return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, en) : en;
  }

  // "{k}" template substitution on an i18n'd string.
  function fmt(str, vars) {
    if (!vars) return str;
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return (k in vars) ? String(vars[k]) : m;
    });
  }

  function tf(key, en, vars) { return fmt(t(key, en), vars); }

  // ---- registry -----------------------------------------------------------

  var ctx = null;            // {game, hud} set by init()
  var reg = {};              // name -> def
  var aliasMap = {};         // alias -> canonical name
  var builtinsDone = false;

  function register(name, def) {
    name = String(name).toLowerCase();
    reg[name] = {
      name: name,
      usage: def.usage || ('/' + name),
      help: def.help || '',
      aliases: def.aliases || [],
      exec: def.exec
    };
    (def.aliases || []).forEach(function (a) {
      aliasMap[String(a).toLowerCase()] = name;
    });
  }

  // Built-in help texts are stored as {key, en} so they re-localize at display
  // time (list/detail resolve them live); external registrants pass strings.
  function helpText(def) {
    var h = def.help;
    return (h && typeof h === 'object') ? t(h.key, h.en) : (h || '');
  }

  function find(name) {
    name = String(name).toLowerCase();
    return reg[name] || (aliasMap[name] ? reg[aliasMap[name]] : null);
  }

  function listAll() {
    return Object.keys(reg).sort().map(function (n) {
      var d = reg[n];
      return { name: d.name, usage: d.usage, help: helpText(d) };
    });
  }

  // ---- output helpers -----------------------------------------------------

  function say(text) { if (ctx && ctx.hud && ctx.hud.chatPrint) ctx.hud.chatPrint(text, 'sys'); }
  function err(text) { if (ctx && ctx.hud && ctx.hud.chatPrint) ctx.hud.chatPrint(text, 'err'); }

  function usageErr(def) {
    err(tf('vox.cmd.err.args', 'Invalid arguments. Usage: {usage}', { usage: def.usage }));
  }

  // ---- argument parsers ---------------------------------------------------

  // `~`, `~5`, `~-2.5` relative coordinate, or an absolute number.
  function relCoord(str, cur) {
    if (str.charAt(0) === '~') {
      var rest = str.substring(1);
      if (rest === '') return cur;
      var d = parseFloat(rest);
      return isFinite(d) ? cur + d : NaN;
    }
    var v = parseFloat(str);
    return isFinite(v) ? v : NaN;
  }

  // Numeric argument with range check; prints the range error itself.
  function numArg(str, min, max, isInt) {
    var v = isInt ? parseInt(str, 10) : parseFloat(str);
    if (!isFinite(v)) return null;
    if (v < min || v > max) {
      err(tf('vox.cmd.num.range', 'Value must be between {min} and {max}', { min: min, max: max }));
      return null;
    }
    return v;
  }

  function modeName(m) {
    return m === 'creative'
      ? t('vox.mode.creative', 'Creative')
      : t('vox.mode.survival', 'Survival');
  }

  // ---- built-in commands (registered lazily on first init, so I18n is up) --

  var HELP_PAGE_SIZE = 8;

  function registerBuiltins() {
    if (builtinsDone) return;
    builtinsDone = true;

    // -- /help [cmd|page] --
    register('help', {
      usage: '/help [command|page]',
      help: { key: 'vox.cmd.help.help', en: 'List commands or show one command’s usage' },
      exec: function (args) {
        var arg = args[0];
        if (arg && find(arg)) {
          var d = find(arg);
          say(d.usage + ' — ' + helpText(d));
          return;
        }
        if (arg && !/^\d+$/.test(arg)) {
          err(tf('vox.cmd.help.noSuch', 'No such command: {cmd}', { cmd: arg }));
          return;
        }
        var all = listAll();
        var pages = Math.max(1, Math.ceil(all.length / HELP_PAGE_SIZE));
        var page = Math.min(pages, Math.max(1, parseInt(arg || '1', 10) || 1));
        say(tf('vox.cmd.help.page', 'Commands ({page}/{pages}) — /help <page|command>',
          { page: page, pages: pages }));
        all.slice((page - 1) * HELP_PAGE_SIZE, page * HELP_PAGE_SIZE).forEach(function (d) {
          say(d.usage + ' — ' + d.help);
        });
      }
    });

    // -- /gamemode (alias /gm) --
    register('gamemode', {
      usage: '/gamemode <survival|creative|s|c|0|1>',
      help: { key: 'vox.cmd.gamemode.help', en: 'Switch between survival and creative' },
      aliases: ['gm'],
      exec: function (args, c) {
        var map = {
          survival: 'survival', s: 'survival', '0': 'survival',
          creative: 'creative', c: 'creative', '1': 'creative'
        };
        var m = map[(args[0] || '').toLowerCase()];
        if (!m) { usageErr(this); return; }
        if (c.game.mode === m) {
          say(tf('vox.cmd.gamemode.already', 'Already in {mode} mode', { mode: modeName(m) }));
          return;
        }
        c.game.setMode(m);   // Game prints the confirmation toast + chat line
      }
    });

    // -- /tp with ~ relatives --
    register('tp', {
      usage: '/tp <x> <y> <z>',
      help: { key: 'vox.cmd.tp.help', en: 'Teleport to coordinates (~ = relative)' },
      exec: function (args, c) {
        if (args.length < 3) { usageErr(this); return; }
        var p = c.game.debugSnapshot().pos;
        var x = relCoord(args[0], p[0]);
        var y = relCoord(args[1], p[1]);
        var z = relCoord(args[2], p[2]);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { usageErr(this); return; }
        c.game.teleport(x, y, z);
        say(tf('vox.cmd.tp.done', 'Teleported to {x} {y} {z}',
          { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, z: Math.round(z * 10) / 10 }));
      }
    });

    // -- /time --
    register('time', {
      usage: '/time <set day|noon|night|midnight|N> | <add N>',
      help: { key: 'vox.cmd.time.help', en: 'Set or advance the world time' },
      exec: function (args, c) {
        var sub = (args[0] || '').toLowerCase();
        var NAMED = { day: 0, noon: 6000, night: 13000, midnight: 18000 };
        if (sub === 'set') {
          var w = (args[1] || '').toLowerCase();
          var tv = (w in NAMED) ? NAMED[w] : parseInt(w, 10);
          if (!isFinite(tv)) { usageErr(this); return; }
          c.game.setTime(tv);
          say(tf('vox.cmd.time.set', 'Time set to {t}', { t: ((tv % 24000) + 24000) % 24000 }));
        } else if (sub === 'add') {
          var dv = parseInt(args[1], 10);
          if (!isFinite(dv)) { usageErr(this); return; }
          c.game.addTime(dv);
          say(tf('vox.cmd.time.added', 'Added {t} ticks', { t: dv }));
        } else {
          usageErr(this);
        }
      }
    });

    // -- /give --
    register('give', {
      usage: '/give <blockKey|id> [count]',
      help: { key: 'vox.cmd.give.help', en: 'Add blocks to your inventory' },
      exec: function (args, c) {
        if (!args[0]) { usageErr(this); return; }
        var def = null;
        if (typeof Blocks !== 'undefined') {
          def = Blocks.byKey(args[0].toLowerCase());
          if (!def && /^\d+$/.test(args[0])) def = Blocks.byId(parseInt(args[0], 10));
        }
        if (!def || !def.placeable) {
          err(tf('vox.cmd.give.noBlock', 'Unknown block: {b}', { b: args[0] }));
          return;
        }
        var n = Math.max(1, Math.min(576, parseInt(args[1], 10) || 1));
        var left = c.game.inventory ? c.game.inventory.add(def.id, n) : n;
        var name = t(def.i18nKey, def.name);
        if (left > 0) {
          err(tf('vox.cmd.give.full', 'Inventory full ({n} left over)', { n: left }));
        }
        if (left < n) {
          say(tf('vox.cmd.give.done', 'Gave {n} × {name}', { n: n - left, name: name }));
        }
      }
    });

    // -- /clear --
    register('clear', {
      usage: '/clear',
      help: { key: 'vox.cmd.clear.help', en: 'Empty your inventory' },
      exec: function (args, c) {
        var inv = c.game.inventory;
        if (!inv) return;
        if (typeof inv.clear === 'function') {
          inv.clear();
        } else {
          var i;
          for (i = 0; i < inv.hotbar.length; i++) inv.hotbar[i] = null;
          if (inv.backpack) for (i = 0; i < inv.backpack.length; i++) inv.backpack[i] = null;
          inv.select(inv.selected);   // poke onChange listeners
        }
        say(t('vox.cmd.clear.done', 'Inventory cleared'));
      }
    });

    // -- /seed --
    register('seed', {
      usage: '/seed',
      help: { key: 'vox.cmd.seed.help', en: 'Show the world seed' },
      exec: function (args, c) {
        say(tf('vox.cmd.seed.msg', 'Seed: {seed}', { seed: c.game.debugSnapshot().seed }));
      }
    });

    // -- /setspawn --
    register('setspawn', {
      usage: '/setspawn',
      help: { key: 'vox.cmd.setspawn.help', en: 'Set your spawn point to where you stand' },
      exec: function (args, c) {
        var p = c.game.debugSnapshot().pos;
        c.game.setSpawn(p[0], p[1], p[2]);
        say(tf('vox.cmd.setspawn.done', 'Spawn point set to {x} {y} {z}',
          { x: Math.floor(p[0]), y: Math.floor(p[1]), z: Math.floor(p[2]) }));
      }
    });

    // -- /spawn --
    register('spawn', {
      usage: '/spawn',
      help: { key: 'vox.cmd.spawn.help', en: 'Teleport back to your spawn point' },
      exec: function (args, c) {
        var s = c.game.player.spawn;
        c.game.teleport(s[0], s[1], s[2]);
        say(t('vox.cmd.spawn.done', 'Teleported to spawn'));
      }
    });

    // -- /kill --
    register('kill', {
      usage: '/kill',
      help: { key: 'vox.cmd.kill.help', en: 'Take the easy way out' },
      exec: function (args, c) {
        if (c.game.mode === 'creative') {
          c.game.respawn();
        } else {
          c.game.player.health = 0;   // the survival tick handles the death screen
        }
        say(t('vox.cmd.kill.done', 'Ouch.'));
      }
    });

    // -- /fly --
    register('fly', {
      usage: '/fly',
      help: { key: 'vox.cmd.fly.help', en: 'Toggle flying (creative only)' },
      exec: function (args, c) {
        if (c.game.mode !== 'creative') {
          err(t('vox.cmd.fly.creativeOnly', 'Flying needs creative mode (/gamemode creative)'));
          return;
        }
        c.game.player.flying = !c.game.player.flying;
        say(c.game.player.flying
          ? t('vox.cmd.fly.on', 'Flying enabled')
          : t('vox.cmd.fly.off', 'Flying disabled'));
      }
    });

    // -- /speed --
    register('speed', {
      usage: '/speed <0.5..10>',
      help: { key: 'vox.cmd.speed.help', en: 'Set your movement speed multiplier' },
      exec: function (args, c) {
        var v = numArg(args[0], 0.5, 10, false);
        if (v === null) { if (!isFinite(parseFloat(args[0]))) usageErr(this); return; }
        c.game.setSpeed(v);
        say(tf('vox.cmd.speed.done', 'Speed set to ×{n}', { n: v }));
      }
    });

    // -- /fov --
    register('fov', {
      usage: '/fov <30..110>',
      help: { key: 'vox.cmd.fov.help', en: 'Set the camera field of view' },
      exec: function (args, c) {
        var v = numArg(args[0], 30, 110, true);
        if (v === null) { if (!isFinite(parseInt(args[0], 10))) usageErr(this); return; }
        c.game.setFov(v);
        say(tf('vox.cmd.fov.done', 'FOV set to {n}', { n: v }));
      }
    });

    // -- /dist --
    register('dist', {
      usage: '/dist <2..10>',
      help: { key: 'vox.cmd.dist.help', en: 'Set the render distance in chunks' },
      exec: function (args, c) {
        var v = numArg(args[0], 2, 10, true);
        if (v === null) { if (!isFinite(parseInt(args[0], 10))) usageErr(this); return; }
        c.game.setRenderDist(v);
        say(tf('vox.cmd.dist.done', 'Render distance set to {n}', { n: v }));
      }
    });

    // -- /lut --
    register('lut', {
      usage: '/lut <0..100>',
      help: { key: 'vox.cmd.lut.help', en: 'Set the CLOBI POP color grade strength' },
      exec: function (args, c) {
        var v = numArg(args[0], 0, 100, true);
        if (v === null) { if (!isFinite(parseInt(args[0], 10))) usageErr(this); return; }
        c.game.setLutAmount(v / 100);
        say(tf('vox.cmd.lut.done', 'Color grade set to {n}%', { n: v }));
      }
    });

    // -- /skin --
    register('skin', {
      usage: '/skin <classic|slim>',
      help: { key: 'vox.cmd.skin.help', en: 'Switch your skin model live' },
      exec: function (args, c) {
        var m = (args[0] || '').toLowerCase();
        if (m !== 'classic' && m !== 'slim') { usageErr(this); return; }
        if (typeof c.game.setSkinModel === 'function') {
          c.game.setSkinModel(m);
          say(tf('vox.cmd.skin.done', 'Skin model: {m}', { m: m }));
        } else {
          err(t('vox.cmd.skin.unavailable', 'Skin model switching is unavailable'));
        }
      }
    });

    // -- /regen (confirm-flag instead of a modal) --
    register('regen', {
      usage: '/regen confirm [seed]',
      help: { key: 'vox.cmd.regen.help', en: 'Erase the world and generate a fresh one' },
      exec: function (args, c) {
        if ((args[0] || '').toLowerCase() !== 'confirm') {
          err(t('vox.cmd.regen.confirm',
            'This erases the world! Type /regen confirm [seed] to proceed.'));
          return;
        }
        var seed = /^-?\d+$/.test(args[1] || '') ? parseInt(args[1], 10) : undefined;
        say(t('vox.cmd.regen.working', 'Regenerating world…'));
        c.game.regen(seed).then(function () {
          say(tf('vox.cmd.regen.done', 'World regenerated (seed {seed})',
            { seed: c.game.debugSnapshot().seed }));
        }).catch(function (e) {
          err(tf('vox.cmd.regen.fail', 'Regeneration failed: {msg}',
            { msg: (e && e.message) || 'error' }));
        });
      }
    });

    // -- /save --
    register('save', {
      usage: '/save',
      help: { key: 'vox.cmd.save.help', en: 'Save the world now' },
      exec: function (args, c) {
        var p = (typeof c.game.saveNow === 'function')
          ? c.game.saveNow()
          : (c.game.world ? c.game.world.save() : Promise.resolve());
        Promise.resolve(p).then(function () {
          say(t('vox.cmd.save.done', 'World saved'));
        }).catch(function (e) {
          err(tf('vox.cmd.save.fail', 'Save failed: {msg}', { msg: (e && e.message) || 'error' }));
        });
      }
    });
  }

  // ---- chat echo (non-command lines) ---------------------------------------

  function chatName() {
    try {
      if (typeof Store !== 'undefined') {
        var n = (Store.getUsername && Store.getUsername()) ||
                (Store.getNickname && Store.getNickname());
        if (n) return n;
      }
    } catch (e) { /* ignore */ }
    return t('vox.chat.you', 'You');
  }

  // ---- public API -----------------------------------------------------------

  var api = {
    init: function (context) {
      ctx = context || ctx;
      registerBuiltins();
    },

    exec: function (line) {
      line = String(line == null ? '' : line).trim();
      if (!line) return;
      if (!ctx) return;   // not initialized — nothing sensible to do

      if (line.charAt(0) !== '/') {
        // plain chat: echoed locally as <name> text
        if (ctx.hud && ctx.hud.chatPrint) ctx.hud.chatPrint('<' + chatName() + '> ' + line);
        return;
      }

      var parts = line.substring(1).split(/\s+/).filter(function (s) { return s.length > 0; });
      var name = (parts[0] || '').toLowerCase();
      var def = name ? find(name) : null;
      if (!def) {
        err(tf('vox.cmd.unknown', 'Unknown command: /{cmd} — try /help', { cmd: name || '' }));
        return;
      }
      try {
        def.exec.call(def, parts.slice(1), ctx);
      } catch (e) {
        err(tf('vox.cmd.crashed', 'Command failed: {msg}', { msg: (e && e.message) || 'error' }));
      }
    },

    register: register,
    list: listAll
  };

  return api;
})();

window.Commands = Commands;
