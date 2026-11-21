// Adapters: where the decision ends up.
//
// The engine decides "this chat may be spoken to in N minutes". An adapter
// translates that into whatever the host application understands:
//
//   json         write <dataDir>/proactive.json (default, no host app needed)
//   wechatagent  flip the wechat.proactive block of a WeChatAgent config file
//   module       import a user-supplied JS module and let it decide
//   dshim        compose a line and deliver it through @xmanrui/dsh-im

import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from './util.js';
import { compose, send } from './deliver.js';

function jsonAdapter(spec) {
  return {
    type: 'json',
    keys: () => [],
    apply(plans, decisions) {
      const chats = {};
      for (const [key, plan] of Object.entries(plans)) {
        chats[key] = {
          allowed: Boolean(plan.speaking),
          intervalMinutes: plan.interval,
          decision: decisions[key]?.decision ?? 'quiet',
        };
      }
      const ok = writeJson(spec.path, { updatedAt: Date.now(), chats });
      return { ok, reason: ok ? undefined : 'write-failed' };
    },
  };
}

function wechatAgentAdapter(spec) {
  function keys() {
    const cfg = readJson(spec.configPath, null);
    const whitelist = cfg?.wechat?.whitelist ?? {};
    const out = [];
    for (const id of whitelist.private ?? []) out.push(`wechat:private:${id}`);
    for (const id of whitelist.groups ?? []) out.push(`wechat:group:${id}`);
    return out;
  }

  return {
    type: 'wechatagent',
    keys,
    apply(plans) {
      const cfg = readJson(spec.configPath, null);
      if (!cfg || !cfg.wechat) return { ok: false, reason: 'host-config-missing' };
      const entries = Object.entries(plans);
      if (!entries.length) return { ok: false, reason: 'no-chats' };

      const proactive = cfg.wechat.proactive ?? {};
      // One gate for the whole account: the most eager chat sets the pace.
      const wantInterval = Math.min(...entries.map(([, plan]) => plan.interval));
      // Host apps validate their own config: WeChatAgent accepts intervals only
      // in 30..1440 minutes and an idle window of at least 5 minutes.
      const clampNumber = (value, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(value) || lo)));
      let changed = false;
      const set = (field, value) => {
        if (proactive[field] !== value) { proactive[field] = value; changed = true; }
      };

      set('enabled', spec.enabled);
      set('intervalMinutes', clampNumber(wantInterval, 30, 1440));
      set('jitterMinutes', clampNumber(spec.jitterMinutes, 0, 60));
      set('idleMinutes', clampNumber(spec.idleMinutes, 5, 1440));
      set('startTime', spec.startTime);
      set('endTime', spec.endTime);
      set('mode', spec.mode);

      proactive.chats ??= {};
      for (const [key] of entries) {
        if (proactive.chats[key] !== true) { proactive.chats[key] = true; changed = true; }
      }

      if (!changed) return { ok: true, reason: 'unchanged' };
      cfg.wechat.proactive = proactive;
      const ok = writeJson(spec.configPath, cfg);
      return { ok, reason: ok ? undefined : 'write-failed' };
    },
  };
}

function moduleAdapter(spec) {
  return {
    type: 'module',
    keys: () => [],
    async apply(plans, decisions) {
      if (!spec.module) return { ok: false, reason: 'module-not-configured' };
      const mod = await import(pathToFileURL(spec.module).href);
      if (typeof mod.apply !== 'function') return { ok: false, reason: 'module-has-no-apply' };
      await mod.apply(plans, decisions, spec.options);
      return { ok: true };
    },
  };
}

// dsh-im is a delivery pipe, not a scheduler: when the engine says "speak",
// the message has to be written here and posted to the host's delivery
// endpoint. `targets` maps a chat key to the dsh-im target id.
function dshimAdapter(spec, deps = {}) {
  const log = deps.log ?? (() => {});
  return {
    type: 'dshim',
    keys: () => Object.keys(spec.targets),
    async apply(plans, decisions) {
      const entries = Object.entries(spec.targets);
      if (!entries.length) return { ok: false, reason: 'no-targets' };
      if (!spec.botId) return { ok: false, reason: 'botId-not-configured' };

      const life = typeof deps.life === 'function' ? deps.life() : null;
      const saved = readJson(spec.sendLog, null) ?? {};
      const sentAt = { ...(saved.sentAt ?? {}) };
      const remember = () => writeJson(spec.sendLog, { ...saved, sentAt });

      let sent = 0;
      let skipped = 0;
      for (const [key, targetId] of entries) {
        if (decisions?.[key]?.speak !== true) continue;
        const last = Number(sentAt[key] ?? 0);
        if (last && Date.now() - last < spec.minGapMinutes * 60000) {
          skipped += 1;
          continue;
        }

        // Claim the slot before awaiting: two overlapping ticks must not both send.
        sentAt[key] = Date.now();
        remember();
        try {
          const text = await compose({
            ctx: deps.ctx,
            spec,
            config: deps.config,
            chatKey: key,
            life,
            log,
          });
          if (!text) {
            delete sentAt[key];
            remember();
            skipped += 1;
            continue;
          }
          await send({
            baseUrl: spec.baseUrl,
            botId: spec.botId,
            targetId,
            text,
            format: spec.format,
            fetchImpl: deps.fetch ?? fetch,
          });
          sent += 1;
          log(`dshim sent ${key} (${text.length} chars)`);
        } catch (error) {
          delete sentAt[key];
          remember();
          log(`dshim failed ${key}: ${String(error?.message ?? error).slice(0, 120)}`);
        }
      }
      return { ok: true, sent, skipped };
    },
  };
}

export function createAdapter(config, deps = {}) {
  const spec = config.adapter ?? {};
  if (spec.type === 'wechatagent') return wechatAgentAdapter(spec);
  if (spec.type === 'module') return moduleAdapter(spec);
  if (spec.type === 'dshim') return dshimAdapter(spec, { ...deps, config });
  return jsonAdapter(spec);
}
