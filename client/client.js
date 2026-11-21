// dsh-companion-heartbeat — client half.
//
// Renders the "keep in mind" list inside DeepSeek Harness as its own page in
// Settings (slot: settings.section, id "companion-heartbeat"). The list itself
// is served by the host half over http://127.0.0.1:<panel.port>, which keeps
// the standalone page working when no GUI is around.

window.__ModuleLoader__.load({
  id: "dsh-companion-heartbeat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const PLUGIN = "dsh-companion-heartbeat";
    const BASE = "http://127.0.0.1:43110";
    const ZH = String(navigator.language || "").toLowerCase().startsWith("zh");

    const text = {
      title: ZH ? "惦记名单" : "Keep in mind",
      lead: ZH
        ? "勾选想让这个角色主动惦记的聊天。没勾的聊天不会被主动打扰。"
        : "Tick the chats this persona may reach out to on its own. Unticked chats are left alone.",
      empty: ZH
        ? "还没有可选的聊天——先在微信里聊一句，或者手动添加一个 key。"
        : "No chats yet — say something in the app first, or add a key by hand.",
      save: ZH ? "保存" : "Save",
      saved: ZH ? "已保存，下一次心跳就按新名单来。" : "Saved. The next tick uses the new list.",
      saving: ZH ? "保存中…" : "Saving…",
      failed: (why) => (ZH ? "保存失败：" : "Save failed: ") + why,
      unreachable: ZH
        ? "连不上心跳（Host 侧没在跑？）。独立面板地址在 heartbeat.log 里。"
        : "Cannot reach the heartbeat host. The standalone page URL is in heartbeat.log.",
      justNow: ZH ? "刚刚有消息" : "active just now",
      minutes: (n) => (ZH ? n + " 分钟前有消息" : "active " + n + " min ago"),
      hours: (n) => (ZH ? n + " 小时前有消息" : "active " + n + " h ago"),
      days: (n) => (ZH ? n + " 天前有消息" : "active " + n + " d ago"),
      spoke: (s) => (ZH ? "上次主动 " + s : "last spoke " + s),
      add: ZH ? "添加" : "Add",
      placeholder: "wechat:private:123456",
      retry: ZH ? "重试" : "Retry",
    };

    function ago(t) {
      if (!t) return "";
      const minutes = Math.round((Date.now() - t) / 60000);
      if (minutes < 1) return text.justNow;
      if (minutes < 60) return text.minutes(minutes);
      if (minutes < 1440) return text.hours(Math.round(minutes / 60));
      return text.days(Math.round(minutes / 1440));
    }

    function useChats() {
      const [state, setState] = react.useState({ status: "loading", chats: [] });
      const load = react.useCallback(async () => {
        try {
          const res = await fetch(BASE + "/api/state", { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          setState({ status: "ready", chats: Array.isArray(data.chats) ? data.chats : [] });
        } catch (error) {
          setState({ status: "unreachable", chats: [], reason: String(error && error.message) });
        }
      }, []);
      react.useEffect(() => { load(); }, [load]);
      return [state, setState, load];
    }

    function MindList() {
      const [state, setState, reload] = useChats();
      const [busy, setBusy] = react.useState(false);
      const [note, setNote] = react.useState("");
      const [draft, setDraft] = react.useState("");

      if (state.status === "loading") {
        return h("div", { style: { padding: "12px 0", opacity: 0.7 } }, "…");
      }
      if (state.status === "unreachable") {
        return h("div", { style: { padding: "12px 0" } }, [
          h("p", { key: "m", style: { margin: 0, opacity: 0.8 } }, text.unreachable),
          h(
            "p",
            { key: "d", style: { margin: "6px 0 0", fontSize: 12, opacity: 0.55 } },
            [state.reason, "origin=" + String(location.origin || "?")].filter(Boolean).join(" · "),
          ),
          h("button", { key: "r", type: "button", onClick: reload, style: { marginTop: 8 } }, text.retry),
        ]);
      }

      function toggle(key, checked) {
        setState((prev) => ({
          ...prev,
          chats: prev.chats.map((chat) => (chat.key === key ? { ...chat, selected: checked } : chat)),
        }));
      }

      async function save() {
        setBusy(true);
        setNote(text.saving);
        try {
          const keys = state.chats.filter((chat) => chat.selected).map((chat) => chat.key);
          const res = await fetch(BASE + "/api/selection", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ keys }),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setNote(text.saved);
        } catch (error) {
          setNote(text.failed(String(error && error.message)));
        } finally {
          setBusy(false);
        }
      }

      function add() {
        const key = draft.trim();
        if (!key) return;
        setState((prev) =>
          prev.chats.some((chat) => chat.key === key)
            ? prev
            : {
                ...prev,
                chats: [
                  { key, kind: key.split(":")[1] || "", id: key.split(":").slice(2).join(":"), label: key, selected: true, lastMessageAt: 0, lastSpokeAt: 0 },
                  ...prev.chats,
                ],
              },
        );
        setDraft("");
      }

      const rows = state.chats.length
        ? state.chats.map((chat) =>
            h(
              "label",
              {
                key: chat.key,
                style: {
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "10px 0",
                  borderTop: "1px solid rgba(128,128,128,.25)",
                  cursor: "pointer",
                },
              },
              [
                h("input", {
                  key: "b",
                  type: "checkbox",
                  checked: !!chat.selected,
                  onChange: (event) => toggle(chat.key, event.target.checked),
                  style: { marginTop: 3 },
                }),
                h("span", { key: "t", style: { display: "block" } }, [
                  h("span", { key: "n", style: { fontWeight: 600 } }, chat.label || chat.key),
                  h(
                    "span",
                    { key: "m", style: { display: "block", fontSize: 12, opacity: 0.65 } },
                    [chat.key, ago(chat.lastMessageAt), chat.lastSpokeAt ? text.spoke(new Date(chat.lastSpokeAt).toLocaleTimeString()) : ""]
                      .filter(Boolean)
                      .join(" · "),
                  ),
                ]),
              ],
            ),
          )
        : [h("p", { key: "e", style: { opacity: 0.7, margin: "10px 0" } }, text.empty)];

      return h("div", { style: { padding: "4px 0 8px" } }, [
        h("h3", { key: "h", style: { margin: "0 0 4px", fontSize: 15 } }, text.title),
        h("p", { key: "l", style: { margin: "0 0 8px", opacity: 0.75, fontSize: 13 } }, text.lead),
        h("div", { key: "list" }, rows),
        h("div", { key: "foot", style: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 } }, [
          h("button", { key: "s", type: "button", disabled: busy, onClick: save }, text.save),
          h("span", { key: "n", style: { fontSize: 12, opacity: 0.7 } }, note),
        ]),
        h("div", { key: "add", style: { display: "flex", gap: 8, marginTop: 10 } }, [
          h("input", {
            key: "i",
            value: draft,
            placeholder: text.placeholder,
            onChange: (event) => setDraft(event.target.value),
            style: { flex: 1, minWidth: 0 },
          }),
          h("button", { key: "a", type: "button", onClick: add }, text.add),
        ]),
      ]);
    }

    const NS = PLUGIN;

    exports.name = PLUGIN;
    exports.inject = ["slots", "locale"];
    exports.apply = function apply(ctx) {
      const t = ctx.locale.bind(NS);
      // Own page in Settings. A section is a nav row plus a panel; the panel is
      // rendered with `{ only: <id> }`, so the label and the body stay together.
      ctx.effect(
        () => ctx.locale.register(NS, { zh: { nav: "惦记名单" }, en: { nav: "Keep in mind" } }),
        "dsh-companion-heartbeat: settings dictionaries",
      );
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "companion-heartbeat",
            order: 45,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ t }),
          },
          (props) => h(MindList, { t: props && props.t }),
        ),
      );
    };
    return module.exports;
  },
});
