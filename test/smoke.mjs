// Run with: node test/smoke.mjs
//
// Covers the decision engine, config resolution, both built-in adapters, the
// life block writer, and one end-to-end tick against a temporary directory.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../index.js';
import { readActivity } from '../lib/activity.js';
import { createAdapter } from '../lib/adapters.js';
import { TUNING_DEFAULTS, resolveConfig } from '../lib/config.js';
import { createState, tick } from '../lib/engine.js';
import { NOW_START, pickLife, writeLife } from '../lib/life.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `heartbeat-${label}-`));
}

const at = (hour, minute = 0) => new Date(2026, 0, 5, hour, minute, 0).getTime();

// ---------------------------------------------------------------- engine ---
{
  const t0 = at(12);
  const tuning = { ...TUNING_DEFAULTS };
  // Deterministic random source: no bursts, no lucky follow-ups, high threshold.
  const rand = () => 0.99;
  const state = createState();

  // The other person spoke a while ago: needs start satisfied, so no speaking.
  const settled = tick({
    state,
    activity: { demo: { lastIncomingAt: t0 - 30 * 60000, lastProactiveAt: 0 } },
    keys: ['demo'],
    tuning,
    rand,
    now: t0,
  });
  assert.equal(settled.demo.speak, false, 'a chat that was just answered should stay quiet');

  // Three hours later the needs have grown enough to speak.
  const t1 = t0 + 3 * 3600 * 1000;
  const grown = tick({ state, activity: null, keys: ['demo'], tuning, rand, now: t1 });
  assert.equal(grown.demo.speak, true, 'a lonely, idle chat should speak');
  assert.equal(grown.demo.intervalMinutes, 2);

  // Same chat, but the persona just spoke: suppression wins.
  const second = tick({
    state,
    activity: { demo: { lastIncomingAt: t0 - 30 * 60000, lastProactiveAt: t1 } },
    keys: ['demo'],
    tuning,
    rand,
    now: t1,
  });
  assert.equal(second.demo.speak, false, 'speaking twice in a row must be suppressed');

  // Daily cap.
  state.chats.demo.dailyCount = tuning.dailyCap;
  const capped = tick({ state, activity: null, keys: ['demo'], tuning, rand, now: t1 + 3600 * 1000 });
  assert.equal(capped.demo.speak, false, 'daily cap must stop speaking');

  // Quiet hours.
  const deepNight = at(3);
  const quiet = tick({ state: createState(), activity: null, keys: ['new'], tuning, rand, now: deepNight });
  assert.equal(quiet.new.speak, false, 'quiet hours must suppress speaking');

  // Unreadable buffer: idle is treated as very long, decisions still made.
  const idle = tick({ state: createState(), activity: null, keys: ['new'], tuning, rand, now: at(14) });
  assert.ok(['speak', 'follow', 'quiet'].includes(idle.new.decision));
  console.log('ok engine');
}

// ---------------------------------------------------------------- config ---
{
  const config = resolveConfig({});
  assert.equal(config.adapter.type, 'json');
  assert.ok(config.dataDir.endsWith('heartbeat'));
  assert.equal(config.tuning.speakIntervalMinutes, 2);
  assert.ok(config.tickSeconds >= 1);

  const home = resolveConfig({ dataDir: '~/heartbeat-test' });
  assert.ok(home.dataDir.startsWith(os.homedir()));

  const padded = resolveConfig({ tuning: { dailyCap: 3 }, chats: ['a', 'b'] });
  assert.equal(padded.tuning.dailyCap, 3);
  assert.equal(padded.tuning.threshold, TUNING_DEFAULTS.threshold);

  // Tuning keys may sit at the top level too; explicit tuning wins over them.
  const flat = resolveConfig({ dailyCap: 5, threshold: 0.3, tuning: { threshold: 0.1 } });
  assert.equal(flat.tuning.dailyCap, 5);
  assert.equal(flat.tuning.threshold, 0.1);

  // Hand-edited garbage must not break the engine or the timer.
  const broken = resolveConfig({
    tickSeconds: 'soon',
    dataDir: '',
    tuning: {
      threshold: 'high',
      missRate: null,
      followUp: 'nope',
      burstWindowMin: [3],
      silentHours: 12,
    },
    life: { minMinutes: 300, maxMinutes: 60 },
  });
  assert.equal(broken.tickSeconds, 10);
  assert.ok(broken.dataDir.endsWith('heartbeat'));
  assert.equal(broken.tuning.threshold, TUNING_DEFAULTS.threshold);
  assert.equal(broken.tuning.missRate, TUNING_DEFAULTS.missRate);
  assert.deepEqual(broken.tuning.followUp, TUNING_DEFAULTS.followUp);
  assert.deepEqual(broken.tuning.burstWindowMin, TUNING_DEFAULTS.burstWindowMin);
  assert.equal(broken.life.maxMinutes, 300, 'maxMinutes must not fall below minMinutes');
  console.log('ok config');
}

// -------------------------------------------------------------- activity ---
{
  const dir = tmpDir('activity');
  const file = path.join(dir, 'messages.json');
  const nowSeconds = Math.floor(at(12) / 1000);
  fs.writeFileSync(file, JSON.stringify({
    chats: {
      one: [{ timestamp: nowSeconds - 60, outgoing: false, text: 'hello' }],
      two: { messages: [{ timestamp: nowSeconds - 30, outgoing: true, proactive: true, text: 'hi' }] },
    },
  }));

  const activity = readActivity(file, 'auto');
  assert.ok(activity.one.lastIncomingAt > 0);
  assert.equal(activity.one.lastProactiveAt, 0);
  assert.ok(activity.two.lastProactiveAt > 0);
  assert.equal(readActivity(path.join(dir, 'missing.json')), null);
  console.log('ok activity');
}

// -------------------------------------------------------------- adapters ---
{
  const dir = tmpDir('adapter-json');
  const config = resolveConfig({ dataDir: dir, chats: ['demo'] });
  const adapter = createAdapter(config);
  const result = adapter.apply({ demo: { interval: 3, speaking: true } }, { demo: { decision: 'speak' } });
  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'proactive.json'), 'utf8'));
  assert.equal(written.chats.demo.intervalMinutes, 3);
  assert.equal(written.chats.demo.decision, 'speak');

  const hostFile = path.join(dir, 'host.json');
  fs.writeFileSync(hostFile, JSON.stringify({
    unrelated: { keep: true },
    wechat: { token: 'should-survive', proactive: {}, whitelist: { private: ['u1'], groups: [] } },
  }));

  const hostConfig = resolveConfig({
    dataDir: dir,
    adapter: { type: 'wechatagent', configPath: hostFile },
  });
  const hostAdapter = createAdapter(hostConfig);
  assert.deepEqual(hostAdapter.keys(), ['wechat:private:u1']);

  const hostResult = hostAdapter.apply(
    { 'wechat:private:u1': { interval: 4, speaking: true } },
    { 'wechat:private:u1': { decision: 'speak' } },
  );
  assert.equal(hostResult.ok, true);

  const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  assert.equal(host.unrelated.keep, true, 'unrelated config must survive');
  assert.equal(host.wechat.token, 'should-survive');
  assert.equal(host.wechat.proactive.enabled, true);
  // The host validates its own config (30..1440 minutes, idle >= 5), so the
  // adapter clamps rather than writing a value the host would reject.
  assert.equal(host.wechat.proactive.intervalMinutes, 30);
  assert.equal(host.wechat.proactive.idleMinutes, 5);
  assert.equal(host.wechat.proactive.chats['wechat:private:u1'], true);
  console.log('ok adapters');
}

// ------------------------------------------------------------------ life ---
{
  const dir = tmpDir('life');
  const role = path.join(dir, 'persona.md');
  fs.writeFileSync(role, '# Persona\n\nSome personality text.\n');

  const life = { enabled: true, template: 'Now: {text}\nMood: {tag}', minMinutes: 0, maxMinutes: 0 };
  const scene = pickLife({ wanderingChance: 0 }, [{ from: 0, to: 24, items: [['calm', 'sitting by the window']] }], at(12));
  assert.deepEqual(scene, { tag: 'calm', text: 'sitting by the window' });

  assert.equal(writeLife(role, life, scene), true);
  const once = fs.readFileSync(role, 'utf8');
  assert.ok(once.includes(NOW_START));
  assert.ok(once.includes('Some personality text.'));

  writeLife(role, life, { tag: 'tired', text: 'lying on the floor' });
  const twice = fs.readFileSync(role, 'utf8');
  assert.equal(twice.split(NOW_START).length - 1, 1, 'the block must be replaced, not duplicated');
  assert.ok(twice.includes('lying on the floor'));
  assert.ok(twice.includes('Some personality text.'));
  console.log('ok life');
}

// ----------------------------------------------------------- integration ---
{
  const dir = tmpDir('run');
  const bufferFile = path.join(dir, 'messages.json');
  const nowSeconds = Math.floor(Date.now() / 1000);
  fs.writeFileSync(bufferFile, JSON.stringify({
    chats: { demo: [{ timestamp: nowSeconds - 3600, outgoing: false, text: 'hey' }] },
  }));

  const ctx = { on() {}, effect(fn) { fn(); }, get() { return undefined; } };
  const dispose = apply(ctx, {
    dataDir: dir,
    chats: ['demo'],
    tickSeconds: 1,
    bufferPath: bufferFile,
    adapter: { type: 'json', path: path.join(dir, 'proactive.json') },
  });

  await new Promise((resolve) => setTimeout(resolve, 1400));
  dispose();

  assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'state must be persisted');
  assert.ok(fs.existsSync(path.join(dir, 'heartbeat.log')), 'log must exist');
  const proactive = JSON.parse(fs.readFileSync(path.join(dir, 'proactive.json'), 'utf8'));
  assert.ok(proactive.chats.demo, 'adapter output must contain the chat');
  assert.ok(['speak', 'follow', 'quiet'].includes(proactive.chats.demo.decision));
  console.log('ok integration');
}

// ------------------------------------------------------------ client half ---
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['./client'];
  assert.equal(typeof entry, 'string', 'package.json must export ./client');
  const clientFile = path.join(root, String(entry).replace(/^\.\//, ''));
  assert.ok(fs.existsSync(clientFile), `${entry} must exist`);
  assert.ok(manifest.files?.includes('client'), 'the client directory must ship in the package');
  assert.equal(manifest.dsh?.client?.platform, 'web', 'the client half targets the web app');

  const source = fs.readFileSync(clientFile, 'utf8');
  assert.ok(source.includes('window.__ModuleLoader__.load'), 'client must register through the module loader');
  assert.ok(source.includes('settings.plugin.item'), 'client must render into the plugin settings page');
  assert.ok(source.includes(manifest.name), 'client module id must match the package name');

  const vm = await import('node:vm');
  new vm.Script(source, { filename: clientFile });
  console.log('ok client entry');
}

// ------------------------------------------------------------ no secrets ---
{
  // Machine-specific absolute paths must never be committed. Extra private
  // strings (a persona name, a machine name) can be checked locally without
  // publishing them: HEARTBEAT_FORBIDDEN="name1,name2" node test/smoke.mjs
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extra = (process.env.HEARTBEAT_FORBIDDEN ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => new RegExp(escapeRegExp(entry), 'i'));

  const forbidden = [/\b[A-Za-z]:\\/, /\/(?:home|Users)\/[A-Za-z]/, ...extra];
  const skipDirs = new Set(['node_modules', '.git', 'dist']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipDirs.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

  for (const file of walk(root)) {
    const label = path.relative(root, file);
    const bytes = fs.readFileSync(file);

    // Editors on Windows like to add a BOM and to mangle a UTF-8 em dash when
    // they read a file as ANSI. Neither belongs in a published package.
    assert.ok(!(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF), `${label}: UTF-8 BOM`);
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('\uFFFD'), `${label}: replacement character, file is not valid UTF-8`);

    if (!/\.(js|mjs|json|yml|md|svg)$/.test(file)) continue;
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${label} contains ${pattern}`);
    }
  }
  console.log('ok no personal paths, names or encoding damage');
}

console.log('\nall checks passed');
