// The decision core.
//
// Every chat owns three slowly rising needs — missing the other person (miss),
// wanting company (social) and curiosity (curious) — plus a burst state that
// occasionally makes the persona "suddenly think of you". A tick accumulates
// those needs, lets incoming messages satisfy them, then compares the combined
// impulse against a noisy threshold. Several conditions can suppress speaking:
// talking again too soon, the other person idling, quiet hours, or the daily cap.
//
// The engine is pure with respect to I/O: it mutates the state object it is
// given and returns per-chat decisions. Everything that touches files lives in
// the callers, which keeps this file testable.

import { clamp, pickRange } from './util.js';

export function createState() {
  return { version: 1, chats: {}, lastLifeAt: 0 };
}

export function chatState(state, key, now = Date.now()) {
  state.chats[key] ??= {
    // Starting values: already a little lonely, a little curious, but content.
    miss: 0.30,
    social: 0.22,
    curious: 0.32,
    updatedAt: now,
    lastIncomingAt: 0,
    lastSeenIncomingAt: 0,
    lastSpeakAt: 0,
    lastProactiveSeenAt: 0,
    day: '',
    dailyCount: 0,
    burstUntil: 0,
    lastDecision: 'idle',
  };
  return state.chats[key];
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// Follow-up table: how likely the persona is to add one more line, given how
// long the other person has been silent. [[maxAgeMinutes, probability], ...]
function followUpProb(table, ageMin) {
  for (const row of Array.isArray(table) ? table : []) {
    const [maxAge, probability] = row;
    if (ageMin <= Number(maxAge)) return Number(probability) || 0;
  }
  return 0;
}

function isQuietHour(now, tuning) {
  const hour = new Date(now).getHours();
  const { quietStart, quietEnd } = tuning;
  if (quietStart === quietEnd) return false;
  return quietStart < quietEnd
    ? hour >= quietStart && hour < quietEnd
    : hour >= quietStart || hour < quietEnd;
}

/**
 * Advance one tick.
 *
 * @param {object} input
 * @param {object} input.state      mutable state object (see createState)
 * @param {object} input.activity   per-chat activity from lib/activity.js, or null
 * @param {string[]} input.keys     chat keys to evaluate
 * @param {object} input.tuning     resolved tuning values (see lib/config.js)
 * @param {number} [input.now]      clock override, mainly for tests
 * @param {function} [input.rand]   random source override, mainly for tests
 * @returns {Record<string, object>} per-chat decision
 */
export function tick({ state, activity = null, keys = [], tuning, now = Date.now(), rand = Math.random }) {
  const decisions = {};

  for (const key of keys) {
    const chat = chatState(state, key, now);
    const minutes = clamp((now - chat.updatedAt) / 60000, 0, 180);

    // Needs grow with time, then a burst may add a sudden spike.
    chat.miss = clamp(chat.miss + minutes * tuning.missRate);
    chat.social = clamp(chat.social + minutes * tuning.socialRate);
    chat.curious = clamp(chat.curious + minutes * tuning.curiousRate);
    if (rand() < tuning.burstChance) {
      chat.miss = clamp(chat.miss + pickRange(tuning.burstMiss, rand));
      chat.social = clamp(chat.social + pickRange(tuning.burstSocial, rand));
    }

    const seen = activity?.[key] ?? { lastIncomingAt: 0, lastProactiveAt: 0 };

    // The other person spoke: needs are satisfied, curiosity is fed.
    if (seen.lastIncomingAt > chat.lastSeenIncomingAt) {
      chat.miss *= 0.25;
      chat.social *= 0.35;
      chat.curious = clamp(chat.curious - 0.2);
      chat.lastIncomingAt = seen.lastIncomingAt;
      chat.lastSeenIncomingAt = seen.lastIncomingAt;
      chat.burstUntil = 0;
    }

    // The persona spoke (observed in the host app's message buffer).
    if (seen.lastProactiveAt > chat.lastProactiveSeenAt) {
      chat.lastProactiveSeenAt = seen.lastProactiveAt;
      chat.lastSpeakAt = seen.lastProactiveAt;
      const day = dayKey(now);
      if (chat.day !== day) { chat.day = day; chat.dailyCount = 0; }
      chat.dailyCount += 1;
      chat.miss *= 0.4;
      chat.social *= 0.5;
      chat.burstUntil = rand() < tuning.burstAfterSpeak
        ? now + pickRange(tuning.burstWindowMin, rand) * 60000
        : 0;
    }

    const idleMin = chat.lastSeenIncomingAt ? (now - chat.lastSeenIncomingAt) / 60000 : 999;
    const sinceSpeakMin = chat.lastSpeakAt ? (now - chat.lastSpeakAt) / 60000 : 999;

    const impulse = clamp(0.5 * chat.miss + 0.3 * chat.social + 0.2 * chat.curious);
    const threshold = clamp(
      tuning.threshold + (rand() * 2 - 1) * tuning.thresholdNoise,
      0.05,
      0.9,
    );

    let suppress = 0;
    if (sinceSpeakMin < 3) suppress += 0.6;
    else if (sinceSpeakMin < 20) suppress += 0.25;
    // Spoke and got no answer: only start penalising after a long while.
    if (chat.lastSpeakAt && chat.lastSpeakAt > chat.lastIncomingAt && sinceSpeakMin > 90) suppress += 0.3;
    if (idleMin < tuning.idleMin) suppress += 0.5;
    if (isQuietHour(now, tuning)) suppress += 1;

    const day = dayKey(now);
    if (chat.day !== day) { chat.day = day; chat.dailyCount = 0; }

    const burst = chat.burstUntil > now;
    const net = impulse - suppress;

    const followRoll = rand() < followUpProb(tuning.followUp, idleMin);
    const follow = followRoll && !isQuietHour(now, tuning) && chat.dailyCount < tuning.dailyCap;
    const speak = (follow || burst || net > threshold)
      && idleMin >= Math.min(tuning.idleMin, 3)
      && sinceSpeakMin >= tuning.gapMin
      && chat.dailyCount < tuning.dailyCap;

    chat.lastDecision = speak ? (follow ? 'follow' : 'speak') : 'quiet';
    chat.updatedAt = now;
    chat.impulse = Number(impulse.toFixed(3));
    chat.suppress = Number(suppress.toFixed(3));
    chat.net = Number(net.toFixed(3));
    chat.burst = burst;

    decisions[key] = {
      speak,
      decision: chat.lastDecision,
      impulse: chat.impulse,
      suppress: chat.suppress,
      net: chat.net,
      burst,
      idleMinutes: Number(idleMin.toFixed(2)),
      sinceSpeakMinutes: Number(sinceSpeakMin.toFixed(2)),
      intervalMinutes: speak
        ? Number(pickRange(tuning.speakIntervalMinutes, rand).toFixed(2))
        : Number(pickRange(tuning.holdIntervalMinutes, rand).toFixed(2)),
    };
  }

  return decisions;
}

/** Flatten decisions into the shape adapters consume: key -> interval. */
export function plansFrom(decisions) {
  const plans = {};
  for (const [key, decision] of Object.entries(decisions)) {
    plans[key] = { interval: decision.intervalMinutes, speaking: decision.speak };
  }
  return plans;
}
