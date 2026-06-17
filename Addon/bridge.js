// ============================================================================
//  bridge.js — БЕЗОПАСНЫЙ МОСТ между userscript'ом (в песочнице Tampermonkey)
//  и фоном расширения (где живёт модель). Контент-скрипт расширения работает в
//  ИЗОЛИРОВАННОМ мире; скрипты страницы Avito его кода не видят.
//
//  Защита от того, чтобы скрипты сайта дёргали твою модель:
//  HMAC challenge-response. Userscript и расширение знают общий СЕКРЕТ (нигде не
//  передаётся через страницу). На каждый запрос мост выдаёт одноразовый
//  challenge; userscript присылает HMAC(секрет, challenge+запрос) — доказательство,
//  что он знает секрет, не раскрывая его. Скрипт сайта секрета не знает →
//  валидный запрос подделать не может; challenge одноразовый → реплей невозможен.
//
//  ⚠ ВАЖНО: замени BRIDGE_SECRET на свою случайную строку И поставь ТАКУЮ ЖЕ
//  в userscript'е. Значение по умолчанию небезопасно (общеизвестно).
// ============================================================================
(function () {
  "use strict";
  const api = (typeof browser !== "undefined") ? browser : chrome;

  const DEFAULT_SECRET = "CHANGE-ME-7b1f9c2e-set-the-same-in-userscript";
  let BRIDGE_SECRET = DEFAULT_SECRET;       // подтянется из storage (задаётся в попапе расширения)

  // читаем секрет из настроек расширения и следим за изменением
  function loadSecret() {
    try {
      api.storage.local.get("cfg").then((o) => {
        if (o && o.cfg && o.cfg.bridgeSecret) BRIDGE_SECRET = o.cfg.bridgeSecret;
      });
    } catch {}
  }
  loadSecret();
  try {
    api.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.cfg && ch.cfg.newValue && ch.cfg.newValue.bridgeSecret)
        BRIDGE_SECRET = ch.cfg.newValue.bridgeSecret;
    });
  } catch {}

  const TAG = "__avitoLLMBridge";           // маркер наших сообщений
  const CHALLENGE_TTL = 15000;              // мс жизни challenge
  const issued = new Map();                 // challenge -> timestamp (одноразовые)

  // HMAC-SHA256 hex
  async function hmac(secret, msg) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function randId() {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function post(obj) { window.postMessage(Object.assign({ [TAG]: true }, obj), location.origin); }

  function cleanupChallenges() {
    const now = Date.now();
    for (const [c, t] of issued) if (now - t > CHALLENGE_TTL) issued.delete(c);
  }

  window.addEventListener("message", async (ev) => {
    // принимаем только из этого же окна и нашего origin
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[TAG] !== true || !d.dir || d.dir !== "to-ext") return;

    try {
      // 1) запрос challenge
      if (d.type === "hello") {
        cleanupChallenges();
        const challenge = randId();
        issued.set(challenge, Date.now());
        post({ dir: "to-page", type: "challenge", nonce: d.nonce, challenge });
        return;
      }

      // 2) собственно запрос с доказательством
      if (d.type === "request") {
        const { requestId, challenge, proof, payload } = d;
        // challenge должен быть выдан нами и не использован
        if (!issued.has(challenge)) { post({ dir: "to-page", type: "response", requestId, error: "bad/used challenge" }); return; }
        issued.delete(challenge); // одноразовый
        // проверяем HMAC
        const expect = await hmac(BRIDGE_SECRET, challenge + "|" + requestId + "|" + JSON.stringify(payload));
        if (proof !== expect) { post({ dir: "to-page", type: "response", requestId, error: "auth failed" }); return; }

        // запрос подлинный → форвардим фону по ВНУТРЕННЕМУ каналу (сайт сюда не лезет)
        const ALLOWED_CMDS = new Set(["chat", "cancel"]);
        const cmd = typeof payload.cmd === "string" && ALLOWED_CMDS.has(payload.cmd) ? payload.cmd : null;
        if (!cmd) { post({ dir: "to-page", type: "response", requestId, error: "неизвестная команда: " + payload.cmd }); return; }
        const resp = await api.runtime.sendMessage({ cmd, ...payload });
        post({ dir: "to-page", type: "response", requestId, result: resp });
        return;
      }
    } catch (e) {
      if (d && d.requestId) post({ dir: "to-page", type: "response", requestId: d.requestId, error: e?.message || String(e) });
    }
  });

  // сообщаем странице (нашему userscript'у), что мост готов — он может слать hello
  post({ dir: "to-page", type: "ready" });
  console.log("[bridge] безопасный мост активен на", location.host);
})();
