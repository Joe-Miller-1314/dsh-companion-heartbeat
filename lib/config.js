// Configuration: defaults, path resolution and normalisation.
//
// The plugin distinguishes two kinds of settings:
//   * runtime settings (paths, adapters, feature toggles) — read once in apply();
//   * tuning values (the numbers behind the decision engine) — read on every
//     tick from <dataDir>/config.json, so they can be adjusted live.

import os from 'node:os';
import path from 'node:path';
import { expandPath, num } from './util.js';

export const TUNING_DEFAULTS = {
  // How fast each need rises, per minute.
  missRate: 0.016,
  socialRate: 0.012,
  curiousRate: 0.008,

  // Chance per tick of a sudden spike, and how large that spike is.
  burstChance: 0.10,
  burstMiss: [0.08, 0.22],
  burstSocial: [0.03, 0.10],

  // Speak when impulse - suppression > threshold (threshold gets +-noise).
  threshold: 0.20,
  thresholdNoise: 0.05,

  // Do not speak while the other person spoke less than idleMin minutes ago.
  idleMin: 8,
  // Minimum gap between two proactive messages, in minutes.
  gapMin: 1,
  // Hard cap on proactive messages per calendar day, per chat.
  dailyCap: 14,

  // Hours [quietStart, quietEnd) where speaking is suppressed. Wraps midnight.
  quietStart: 0,
  quietEnd: 8,

  // After speaking, sometimes enter a chatty window.
  burstAfterSpeak: 0.40,
  burstWindowMin: [2, 20],

  // Follow-up probability by silence length: [[maxAgeMinutes, probability], ...].
  followUp: [[1.5, 0.55], [8, 0.30], [45, 0.05], [180, 0.12], [1e9, 0.45]],

  // Interval written to the host app, in minutes. Number or [min, max].
  speakIntervalMinutes: 2,
  holdIntervalMinutes: 1440,
};

const DEFAULT_INTERESTS = [
  'doc', 'documentary', 'music', 'science', 'book', 'cook', 'cat', 'rain',
  'star', 'night', 'animation', 'anime', 'handmade', 'piano', 'guitar', 'ocean',
];

function defaultHome() {
  const home = process.env.DSH_HOME;
  if (home && home.trim()) return expandPath(home);
  return path.join(os.homedir(), '.dsh');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const isPair = (value) => Array.isArray(value) && value.length === 2
  && value.every((entry) => Number.isFinite(Number(entry)));

/**
 * Coerce tuning values, keeping defaults when a value is missing or malformed.
 * Accepts a partial object; always returns the full set of keys.
 */
export function normaliseTuning(overrides = {}) {
  const source = asObject(overrides);
  const out = {};
  for (const [key, fallback] of Object.entries(TUNING_DEFAULTS)) {
    const value = source[key];
    if (typeof fallback === 'number') {
      out[key] = num(value, fallback);
    } else if (key === 'followUp') {
      const pairs = Array.isArray(value) && value.length && value.every(isPair)
        ? value.map(([age, probability]) => [Number(age), Number(probability)])
        : fallback;
      out[key] = [...pairs].sort((a, b) => a[0] - b[0]);
    } else if (key === 'burstMiss' || key === 'burstSocial' || key === 'burstWindowMin') {
      out[key] = isPair(value) ? value.map(Number) : fallback;
    } else if (Array.isArray(value)) {
      out[key] = value;
    } else {
      out[key] = fallback;
    }
  }
  return out;
}

function normaliseAdapter(raw, dataDir) {
  const spec = typeof raw === 'string' ? { type: raw } : asObject(raw);
  const type = String(spec.type ?? 'json').toLowerCase();

  if (type === 'wechatagent') {
    return {
      type,
      configPath: expandPath(spec.configPath ?? spec.path ?? ''),
      whitelist: spec.whitelist ?? null,
      mode: String(spec.mode ?? 'greeting'),
      idleMinutes: num(spec.idleMinutes, 0.1),
      jitterMinutes: num(spec.jitterMinutes, 0),
      startTime: String(spec.startTime ?? '08:00'),
      endTime: String(spec.endTime ?? '02:00'),
      enabled: spec.enabled !== false,
    };
  }

  if (type === 'module') {
    return {
      type,
      module: expandPath(spec.module ?? ''),
      options: asObject(spec.options),
    };
  }

  return {
    type: 'json',
    path: expandPath(spec.path ?? path.join(dataDir, 'proactive.json')),
  };
}

/**
 * Normalise a raw plugin config into the shape the runtime expects.
 * Every path becomes absolute; `~` and ${ENV_VAR} are expanded.
 */
export function resolveConfig(raw = {}) {
  const source = asObject(raw);
  const dataDir = expandPath(source.dataDir ?? '') || path.join(defaultHome(), 'heartbeat');

  // Tuning keys may also be written at the top level of the config row.
  const topLevel = {};
  for (const key of Object.keys(TUNING_DEFAULTS)) {
    if (source[key] !== undefined) topLevel[key] = source[key];
  }
  const tuning = normaliseTuning({ ...topLevel, ...asObject(source.tuning) });

  const life = asObject(source.life);
  const consolidate = asObject(source.consolidate);
  const watch = asObject(source.watch);
  const adapter = normaliseAdapter(source.adapter, dataDir);

  return {
    persona: String(source.persona ?? 'companion'),
    dataDir,
    statePath: path.join(dataDir, 'state.json'),
    tuningPath: path.join(dataDir, 'config.json'),
    logPath: path.join(dataDir, 'heartbeat.log'),
    memoryDir: expandPath(source.memoryDir ?? path.join(dataDir, 'memory')),
    rolePath: expandPath(source.rolePath ?? ''),
    bufferPath: expandPath(source.bufferPath ?? ''),
    bufferFormat: String(source.bufferFormat ?? 'auto'),
    chats: Array.isArray(source.chats) ? source.chats.map(String) : [],
    tickSeconds: Math.max(1, num(source.tickSeconds, 10)),
    tuning,
    adapter,
    life: {
      enabled: life.enabled !== false,
      file: expandPath(life.file ?? ''),
      slots: Array.isArray(life.slots) ? life.slots : null,
      minMinutes: num(life.minMinutes, 100),
      maxMinutes: Math.max(num(life.minMinutes, 100), num(life.maxMinutes, 180)),
      wanderingChance: num(life.wanderingChance, 0.15),
      template: String(life.template ?? 'Now: {text}\nMood: {tag}'),
    },
    consolidate: {
      enabled: consolidate.enabled !== false,
      intervalHours: num(consolidate.intervalHours, 168),
      sessionId: String(consolidate.sessionId ?? 'heartbeat-memory'),
      cwd: expandPath(consolidate.cwd ?? '') || process.cwd(),
      timeoutMs: num(consolidate.timeoutMs, 240000),
      promptFile: expandPath(consolidate.promptFile ?? ''),
      maxSaid: num(consolidate.maxSaid, 80),
      maxHeard: num(consolidate.maxHeard, 40),
      maxMemories: num(consolidate.maxMemories, 5),
    },
    watch: {
      enabled: watch.enabled === true,
      intervalMinutes: num(watch.intervalMinutes, 150),
      hours: Array.isArray(watch.hours) && watch.hours.length === 2
        ? watch.hours.map((entry) => Math.max(0, Math.min(24, num(entry, 0))))
        : [9, 1],
      interests: Array.isArray(watch.interests) && watch.interests.length
        ? watch.interests.map(String)
        : DEFAULT_INTERESTS,
      credentialPath: expandPath(watch.credentialPath ?? ''),
      timeoutMs: num(watch.timeoutMs, 15000),
      seenLimit: num(watch.seenLimit, 40),
    },
  };
}
