// dsh-companion-heartbeat — a small impulse engine for AI companions.
//
// Every few seconds it asks one question: does the persona want to say
// something right now, and if so how soon may it speak again? The answer is
// written to an adapter, which either updates a host application or writes a
// plain JSON file. Optionally it also refreshes "what I am doing right now",
// consolidates the day into long-term memory, and lets the persona watch one
// video.
//
// All personal paths, names and host-app details come from configuration.

import fs from 'node:fs';
import path from 'node:path';
import { createAdapter } from './lib/adapters.js';
import { readActivity } from './lib/activity.js';
import { normaliseTuning, resolveConfig } from './lib/config.js';
import { createState, plansFrom, tick } from './lib/engine.js';
import { loadSlots, pickLife, writeLife } from './lib/life.js';
import { createMemory } from './lib/memory.js';
import { startPanel } from './lib/panel.js';
import { createWatch } from './lib/watch.js';
import { appendLog, ensureDir, readJson, writeJson } from './lib/util.js';

export const name = 'dsh-companion-heartbeat';
// No hard service dependencies: the decision loop runs in any profile. The
// optional weekly pass looks up `sessionController` at run time instead, so a
// profile without it never blocks activation.
export const inject = [];

const HOUR = 3600 * 1000;

function shortError(error) {
  return String(error?.message ?? error).slice(0, 160);
}

function withinHours(hour, range) {
  const [start, end] = range;
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig ?? {});
  const log = (text) => appendLog(config.logPath, text);

  ensureDir(config.dataDir);
  ensureDir(config.memoryDir);
  if (!fs.existsSync(config.tuningPath)) writeJson(config.tuningPath, config.tuning);
  if (!fs.existsSync(config.statePath)) writeJson(config.statePath, createState());

  const adapter = createAdapter(config);
  const memory = createMemory({ config, bufferPath: config.bufferPath, log });
  const watch = createWatch({ config, log });
  const slots = loadSlots(config.life);

  const consolidateFlag = path.join(config.dataDir, 'consolidate-now');
  const consolidateRecord = path.join(config.dataDir, 'consolidate.json');
  const watchFlag = path.join(config.dataDir, 'watch-now');

  let ticking = false;
  let consolidating = false;
  let watching = false;
  let warnedEmpty = false;
  let warnedKeys = false;

  const readState = () => {
    const state = readJson(config.statePath, null);
    return state && typeof state === 'object' && state.chats ? state : createState();
  };

  // Tuning lives in a file so it can be changed without restarting the plugin.
  const currentTuning = () => {
    const live = readJson(config.tuningPath, null);
    return live && typeof live === 'object' ? normaliseTuning({ ...config.tuning, ...live }) : { ...config.tuning };
  };

  // The panel stores the chosen chats in the tuning file, so an explicit list
  // (including an empty one) wins over whatever the adapter would guess.
  const liveChats = () => {
    const live = readJson(config.tuningPath, null);
    return Array.isArray(live?.chats) ? live.chats.map(String) : null;
  };

  const resolveKeys = () => {
    const chosen = liveChats();
    if (chosen) return chosen;
    if (config.chats.length) return config.chats;
    if (typeof adapter.keys === 'function') {
      try { return adapter.keys(); } catch { return []; }
    }
    return [];
  };

  // ---- "what I am doing right now" ----
  function rewriteLife(state, now) {
    const life = config.life;
    if (!life.enabled || !config.rolePath) return;
    const last = Number(state.lastLifeAt || 0);
    const wait = (life.minMinutes + Math.random() * (life.maxMinutes - life.minMinutes)) * 60000;
    if (last && now - last < wait) return;

    const scene = pickLife(life, slots, now);
    state.lastLifeAt = now;
    state.life = { tag: scene.tag, text: scene.text, at: now };
    const written = writeLife(config.rolePath, life, scene);
    if (!written && !warnedEmpty) {
      warnedEmpty = true;
      log('life block not written: check rolePath');
    }
  }

  // ---- one decision step ----
  function runTick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const state = readState();
      const keys = resolveKeys();
      if (!keys.length) {
        if (!warnedKeys) {
          warnedKeys = true;
          log('no chats: set config.chats, or use an adapter that knows its own chats');
        }
        return;
      }

      const tuning = currentTuning();
      const activity = config.bufferPath ? readActivity(config.bufferPath, config.bufferFormat) : null;
      const decisions = tick({ state, activity, keys, tuning, now });
      const plans = plansFrom(decisions);

      Promise.resolve(adapter.apply(plans, decisions))
        .then((result) => {
          if (result && result.ok === false) log(`adapter ${adapter.type}: ${result.reason ?? 'failed'}`);
        })
        .catch((error) => log(`adapter ${adapter.type} failed: ${shortError(error)}`));

      rewriteLife(state, now);
      writeJson(config.statePath, state);

      log(`tick ${keys.map((key) => {
        const decision = decisions[key];
        return `${key.split(':').at(-1)}=${decision.decision}(net ${decision.net}, next ${decision.intervalMinutes}m${decision.burst ? ', burst' : ''})`;
      }).join(' ')}`);
    } catch (error) {
      log(`tick failed: ${shortError(error)}`);
    } finally {
      ticking = false;
    }
  }

  // ---- periodic consolidation ----
  function maybeConsolidate(state, now) {
    if (!config.consolidate.enabled || consolidating) return;
    const flagged = fs.existsSync(consolidateFlag);
    const last = Number(readJson(consolidateRecord, null)?.lastRunAt ?? 0);
    // Missed runs (machine was off) are caught up on the next tick.
    if (!flagged && now - last < config.consolidate.intervalHours * HOUR) return;

    consolidating = true;
    if (flagged) { try { fs.unlinkSync(consolidateFlag); } catch {} }
    log('consolidation start');
    Promise.resolve()
      .then(() => memory.run(ctx, { life: state?.life ?? null, now }))
      .then((result) => {
        writeJson(consolidateRecord, { lastRunAt: now, result });
        log(`consolidation done ${JSON.stringify(result ?? {})}`);
      })
      .catch((error) => log(`consolidation failed: ${shortError(error)}`))
      .finally(() => { consolidating = false; });
  }

  // ---- occasional video ----
  function maybeWatch(now) {
    if (!config.watch.enabled || watching) return;
    const flagged = fs.existsSync(watchFlag);
    const last = Number(readJson(path.join(config.dataDir, 'watch.json'), null)?.lastRunAt ?? 0);
    const hour = new Date(now).getHours();
    if (!flagged && !withinHours(hour, config.watch.hours)) return;
    if (!flagged && now - last < config.watch.intervalMinutes * 60000) return;

    watching = true;
    if (flagged) { try { fs.unlinkSync(watchFlag); } catch {} }
    Promise.resolve()
      .then(() => watch.run(now))
      .then((result) => log(`watch done ${JSON.stringify(result ?? {})}`))
      .catch((error) => log(`watch failed: ${shortError(error)}`))
      .finally(() => { watching = false; });
  }

  try { memory.install(ctx); } catch (error) { log(`memory install failed: ${shortError(error)}`); }

  const timers = [];
  const loop = setInterval(() => {
    try {
      runTick();
      maybeConsolidate(readState(), Date.now());
      maybeWatch(Date.now());
    } catch (error) {
      log(`loop failed: ${shortError(error)}`);
    }
  }, config.tickSeconds * 1000);
  loop.unref?.();
  timers.push(loop);

  // First decision shortly after activation, so the host app sees a value soon.
  const first = setTimeout(() => { try { runTick(); } catch (error) { log(`first tick failed: ${shortError(error)}`); } }, 5000);
  first.unref?.();
  timers.push(first);

  const stopPanel = startPanel({ config, log });
  timers.push(stopPanel);

  const dispose = () => {
    for (const timer of timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
  };

  if (typeof ctx?.effect === 'function') {
    try { ctx.effect(() => dispose); } catch { /* fall through to dispose event */ }
  } else if (typeof ctx?.on === 'function') {
    ctx.on('dispose', dispose);
  }

  log(`heartbeat started (adapter=${adapter.type}, tick=${config.tickSeconds}s, chats=${config.chats.length || 'auto'}${config.panelEnabled ? `, panel=127.0.0.1:${config.panelPort}` : ''})`);
  return dispose;
}
