// ============================================================================
//  background.js — фон расширения. Держит модель (через абстракцию бэкендов),
//  принимает команды ТОЛЬКО по внутреннему каналу расширения (browser.runtime),
//  куда скрипты страницы доступа не имеют. Это и есть «правильный» канал.
//  ВНИМАНИЕ: подключается обычным <script> (НЕ модулем). Абстракция бэкендов
//  доступна как глобаль self.LLMBackends (см. llm-backends.js, грузится раньше).
// ============================================================================
const B = self.LLMBackends;

const api = (typeof browser !== "undefined") ? browser : chrome;

console.log("[bg] background.js исполняется; LLMBackends=" + (B ? "есть" : "НЕТ!") + ", gpu=" + (typeof navigator.gpu));

// ── Обход CORS для CDN весов (huggingface/xethub отдают ACAO, не совпадающий с
//    origin расширения 'null'). Переписываем ответный заголовок на '*'. ───────
const CORS_HOSTS = [
  "https://cas-bridge.xethub.hf.co/*", "https://*.xethub.hf.co/*",
  "https://*.hf.co/*", "https://huggingface.co/*", "https://*.huggingface.co/*",
  "https://cdn-lfs.huggingface.co/*", "https://cdn-lfs-us-1.huggingface.co/*",
  "https://raw.githubusercontent.com/*",
];
try {
  api.webRequest.onHeadersReceived.addListener(
    (details) => {
      const headers = details.responseHeaders || [];
      let acao = false;
      for (const h of headers) {
        const n = h.name.toLowerCase();
        if (n === "access-control-allow-origin") { h.value = "*"; acao = true; }
      }
      if (!acao) headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
      return { responseHeaders: headers };
    },
    { urls: CORS_HOSTS },
    ["blocking", "responseHeaders"]
  );
  console.log("[bg] CORS-перехватчик установлен");
} catch (e) {
  console.log("[bg] не удалось поставить webRequest-перехватчик: " + (e?.message || e));
}

let backend = null;             // активный бэкенд (WebLLMBackend | OllamaBackend)
let stopFlag = false;           // запрос на остановку текущего прогона
let modelChain = Promise.resolve(); // цепочка сериализации запросов к модели (очередь)
let queueLen = 0;               // длина очереди (для информирования)
let cfg = {
  type: "webllm",               // 'webllm' | 'ollama'
  modelId: "gemma-2-9b-it-q4f16_1-MLC",
  ollamaHost: "http://localhost:11434",
  ollamaModel: "qwen2.5:7b",
  delayMs: 60, maxTokens: 200, reasoning: true,
  bridgeSecret: "CHANGE-ME-7b1f9c2e-set-the-same-in-userscript", // секрет моста (задаётся в UI)
};

// рассылка лога/прогресса всем открытым UI расширения (popup)
const LOG_BUF = [];                       // буфер лога живёт в фоне (постоянном)
const LOG_MAX = 500;
let lastReport = null;                     // последний результат диагностики (переживает закрытие попапа)
function emit(kind, payload) {
  api.runtime.sendMessage({ __from: "bg", kind, payload }).catch(() => {});
}
const log = (m) => {
  const line = "[" + new Date().toLocaleTimeString() + "] " + m;
  LOG_BUF.push(line);
  if (LOG_BUF.length > LOG_MAX) LOG_BUF.shift();
  console.log("[bg] " + m);
  emit("log", m);
};

function makeBackend() {
  const opts = {
    delayMs: cfg.delayMs, maxTokens: cfg.maxTokens, reasoning: cfg.reasoning,
    onLog: log,
    modelId: cfg.modelId,
    host: cfg.ollamaHost, model: cfg.ollamaModel,
  };
  return B.createBackend(cfg.type, opts);
}

async function ensureBackend() {
  if (!backend || backend.name !== cfg.type) {
    if (backend) { try { await backend.unload(); } catch {} }
    backend = makeBackend();
  }
  if (cfg.type === "webllm") backend.modelId = cfg.modelId;
  if (cfg.type === "ollama") { backend.host = cfg.ollamaHost.replace(/\/$/, ""); backend.model = cfg.ollamaModel; }
  Object.assign(backend.opts, { delayMs: cfg.delayMs, maxTokens: cfg.maxTokens, reasoning: cfg.reasoning });
  return backend;
}

// Единая точка инициализации модели. Защищает от ДВОЙНОЙ загрузки:
// если init уже идёт (например, нажали "Загрузить" и одновременно пришёл
// запрос adjudicate), второй вызов ждёт тот же промис, а не создаёт вторую
// модель в VRAM (это и вызывало out of memory).
let initInFlight = null;
async function ensureLoaded(onProgress) {
  const b = await ensureBackend();
  if (b.ready && (cfg.type !== "webllm" || b._loaded === cfg.modelId)) return b;
  if (initInFlight) { await initInFlight; return b; }
  initInFlight = (async () => {
    try { await b.init(onProgress); }
    finally { initInFlight = null; }
  })();
  await initInFlight;
  return b;
}

// ── Тестовые токены для проверки инференса ──────────────────────────────────
const TEST = [
  { token: "50р-р", title: "Пиджак Emporio Armani", context: "Пиджак emporio armani johnny line 50р-р", expect: "?" },
  { token: "500p",  title: "Чехлы оптом",            context: "За опт скидка 500p, осталось 10 штук",     expect: "cyr" },
  { token: "5B",    title: "Зарядное устройство USB", context: "Выход USB: 5B 2.1 A (Auto Max)",           expect: "cyr" },
  { token: "2.1A",  title: "Быстрая зарядка",         context: "Выход USB: 5B 2.1A быстрая зарядка",        expect: "cyr" },
  { token: "5T",    title: "Жёсткий диск Toshiba",    context: "Жёсткий диск 5T корпоративного класса",    expect: "lat" },
  { token: "5T",    title: "Прицеп бортовой",         context: "Прицеп грузоподъёмность 5T, аренда",       expect: "cyr" },
  { token: "C",     title: "Зарядка для телефона",    context: "Зарядка для штекера type C, быстрая",      expect: "lat" },
  { token: "5C",    title: "iPhone 5C",               context: "Продам iPhone 5C белый, оригинал",         expect: "lat" },
  { token: "5S",    title: "Apple iPhone 5S",         context: "iPhone 5S 16гб, состояние хорошее",        expect: "lat" },
  { token: "c",     title: "Магазин электроники",     context: "официально работаем c 2022 года",          expect: "cyr" },
  { token: "Yahoo", title: "Выкуп из Японии",         context: "Выкуп с Yahoo Auctions Japan",             expect: "lat" },
  { token: "ABC",   title: "Корпус для телефона",      context: "Материал корпуса: пластик ABC",            expect: "lat" },
];

// лёгкая сетевая проба: дошёл ли запрос и прочитался ли ответ (CSP/CORS)
async function probe(url, label) {
  try {
    const t = performance.now();
    const r = await fetch(url, { method: "GET" });
    const ms = Math.round(performance.now() - t);
    await r.text().catch(() => {});   // чтение тела проверяет доступ к ответу (CORS)
    return { label, ok: r.ok || r.status === 200, status: r.status, ms };
  } catch (e) {
    return { label, ok: false, status: 0, error: e?.message || String(e) };
  }
}

// ── Пошаговая самодиагностика ───────────────────────────────────────────────
async function diagnose() {
  const report = { steps: [], summary: {}, ts: new Date().toLocaleTimeString() };
  const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); log((ok ? "✓ " : "✗ ") + name + (detail ? " — " + detail : "")); return ok; };

  log("════ ДИАГНОСТИКА (" + cfg.type + ") ════");

  // 1. Окружение
  let envOk = true;
  if (cfg.type === "webllm") {
    const hasGpu = typeof navigator.gpu !== "undefined";
    step("WebGPU доступен", hasGpu, hasGpu ? "" : "navigator.gpu отсутствует");
    if (hasGpu) {
      try {
        const ad = await navigator.gpu.requestAdapter();
        const fb = ad.isFallbackAdapter;
        const wg = ad.limits.maxComputeWorkgroupStorageSize;
        const buf = Math.round(ad.limits.maxBufferSize / 1048576);
        step("GPU-адаптер аппаратный", fb !== true, "fallback=" + fb + ", workgroup=" + wg + ", buffer=" + buf + "МБ");
        step("Лимит workgroup ≥ 32768", wg >= 32768, wg >= 32768 ? String(wg) : "лимит " + wg + " (на части шейдеров не хватит)");
        envOk = (fb !== true);
      } catch (e) { step("Опрос GPU-адаптера", false, e?.message); envOk = false; }
    } else envOk = false;
    try {
      const est = await navigator.storage.estimate();
      const q = Math.round(est.quota / 1048576), u = Math.round(est.usage / 1048576);
      step("Хранилище (квота)", est.quota - est.usage > 2000 * 1048576, "quota=" + q + "МБ, занято=" + u + "МБ, свободно=" + (q - u) + "МБ");
    } catch {}
  } else {
    step("Бэкенд Ollama", true, "сетевой инференс, WebGPU не требуется");
  }
  report.summary.env = envOk;

  // 2. Сеть (пробы до загрузки)
  let netOk = true;
  if (cfg.type === "webllm") {
    const probes = await Promise.all([
      probe("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm", "Библиотека (jsdelivr)"),
      probe("https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/gemma-2-9b-it-q4f16_1_cs1k-webgpu.wasm", "WASM-модуль (github raw)"),
      probe("https://huggingface.co/mlc-ai/" + cfg.modelId + "/resolve/main/mlc-chat-config.json", "Конфиг модели (huggingface)"),
      probe("https://huggingface.co/mlc-ai/" + cfg.modelId + "/resolve/main/tokenizer.json", "Токенизатор (hf→xethub CDN)"),
    ]);
    for (const p of probes) { const ok = step(p.label, p.ok, p.ok ? ("HTTP " + p.status + ", " + p.ms + "мс") : ("заблокировано/ошибка: " + (p.error || ("HTTP " + p.status)))); if (!ok) netOk = false; }
  } else {
    const p = await probe(cfg.ollamaHost.replace(/\/$/, "") + "/api/tags", "Ollama сервер");
    netOk = step(p.label, p.ok, p.ok ? "HTTP " + p.status : "недоступен: " + (p.error || p.status) + " (запущен? OLLAMA_ORIGINS=*?)");
  }
  report.summary.net = netOk;

  if (!netOk) { log("Сеть не прошла — загрузку модели не начинаю."); lastReport = report; emit("report", report); return report; }

  // 3. Загрузка модели
  let loadOk = false;
  try {
    const t = performance.now();
    await ensureLoaded((p) => emit("progress", p.text || p));
    loadOk = step("Загрузка модели", true, "за " + Math.round((performance.now() - t) / 1000) + " с");
  } catch (e) { step("Загрузка модели", false, e?.message || String(e)); }
  report.summary.load = loadOk;
  if (!loadOk) { lastReport = report; emit("report", report); return report; }

  // 4. Инференс + точность + учёт TDR (+ возможность прерывания)
  let ok = 0, scored = 0, lost = 0, errs = 0;
  const rows = [];
  const t0 = performance.now();
  stopFlag = false;
  const results = await backend.adjudicate(TEST, (i, r) => {
    emit("item", { i, total: TEST.length, token: r.token, script: r.script, recovered: !!r.recovered });
    if (r.recovered) lost++;
    if (r.script === null) errs++;
  }, () => stopFlag);
  const aborted = !!results.aborted;
  results.forEach((r, i) => {
    const exp = TEST[i].expect;
    if (exp !== "?") { scored++; if (r.script === exp) ok++; }
    rows.push({ token: TEST[i].token, got: r.script, expect: exp, ok: exp === "?" ? null : r.script === exp });
  });
  const ms = Math.round(performance.now() - t0);
  step(aborted ? "Инференс прерван" : "Инференс", !aborted && errs === 0,
       "обработано " + results.length + "/" + TEST.length + ", точность " + ok + "/" + scored +
       ", " + ms + "мс" + (results.length ? " (~" + Math.round(ms / results.length) + "мс/токен)" : "") +
       (lost ? ", восстановлений после TDR: " + lost : "") + (errs ? ", без вердикта: " + errs : "") +
       (aborted ? " — остановлено пользователем" : ""));
  report.summary.infer = { ok, scored, ms, lost, errs, aborted, done: results.length, total: TEST.length };
  report.rows = rows;

  log("════ ИТОГ: окружение " + (report.summary.env ? "✓" : "✗") + ", сеть " + (netOk ? "✓" : "✗") +
      ", загрузка " + (loadOk ? "✓" : "✗") + ", точность " + ok + "/" + scored + " ════");
  lastReport = report;
  emit("report", report);
  return report;
}

// ── Роутер команд. Источник — popup или контент-скрипт расширения (оба
//    внутри расширения). Сообщения со страницы сюда НЕ приходят. ─────────────
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__from === "bg") return;          // игнорируем собственные бродкасты
  (async () => {
    try {
      switch (msg.cmd) {
        case "getConfig":
          sendResponse({ ok: true, cfg, status: backend ? (backend.ready ? "ready" : "idle") : "none", logLines: LOG_BUF.slice(), report: lastReport });
          break;

        case "listCaches": {
          // WebLLM держит ВСЕ модели в одном разделе (webllm/model); файлы различаем
          // по URL вида .../mlc-ai/<МОДЕЛЬ>/resolve/... — группируем по модели.
          const groups = {};   // model -> {count, bytes, urls:[]}
          const keyNames = await caches.keys();
          for (const cn of keyNames) {
            let c;
            try { c = await caches.open(cn); } catch { continue; }
            const reqs = await c.keys();
            for (const rq of reqs) {
              const m = rq.url.match(/mlc-ai\/([^/]+)/);
              const model = m ? m[1] : "(прочее: " + cn + ")";
              const g = groups[model] || (groups[model] = { count: 0, bytes: 0, cache: cn });
              g.count++;
              const resp = await c.match(rq);
              const len = resp && resp.headers.get("content-length");
              if (len) g.bytes += parseInt(len) || 0;
            }
          }
          const items = Object.entries(groups).map(([model, g]) => ({ model, count: g.count, mb: Math.round(g.bytes / 1048576), cache: g.cache }));
          items.sort((a, b) => b.mb - a.mb);
          sendResponse({ ok: true, caches: items });
          break;
        }

        case "listCachedModels": {
          // только идентификаторы скачанных моделей (для пометки в выпадашке)
          const set = new Set();
          const keyNames = await caches.keys();
          for (const cn of keyNames) {
            let c; try { c = await caches.open(cn); } catch { continue; }
            for (const rq of await c.keys()) {
              const m = rq.url.match(/mlc-ai\/([^/]+)/);
              if (m) set.add(m[1]);
            }
          }
          sendResponse({ ok: true, models: [...set] });
          break;
        }

        case "deleteCache": {
          // удаляем файлы КОНКРЕТНОЙ модели из общего раздела (по идентификатору в URL)
          const model = msg.model;
          if (!model) { sendResponse({ ok: false, error: "не указана модель" }); break; }
          let removed = 0;
          const keyNames = await caches.keys();
          for (const cn of keyNames) {
            let c; try { c = await caches.open(cn); } catch { continue; }
            for (const rq of await c.keys()) {
              if (rq.url.includes("mlc-ai/" + model + "/") || rq.url.includes("mlc-ai/" + model + "?")) {
                if (await c.delete(rq)) removed++;
              }
            }
          }
          if (backend && cfg.type === "webllm" && cfg.modelId === model) {
            try { await backend.unload(); } catch {} backend = null; emit("status", "idle");
          }
          const est = await navigator.storage.estimate().catch(() => null);
          log("удалена модель из кэша: " + model + " (" + removed + " файлов)");
          sendResponse({ ok: removed > 0, removed, usageMB: est ? Math.round(est.usage / 1048576) : "?" });
          break;
        }

        case "diagnose": {
          const rep = await diagnose();
          sendResponse({ ok: true, report: rep });
          break;
        }

        case "stop":
          stopFlag = true;
          log("получен запрос на остановку — прервусь между токенами");
          sendResponse({ ok: true });
          break;

        case "clearCache": {
          // Очистка скачанных весов: WebLLM хранит файлы в Cache Storage расширения.
          // Удаляем все кэши origin'а расширения. После этого модель придётся качать заново.
          log("очистка кэша моделей…");
          try {
            // выгрузим текущую модель из VRAM, чтобы не держать ссылки
            if (backend) { try { await backend.unload(); } catch {} backend = null; }
            const keys = await caches.keys();
            let removed = 0;
            for (const k of keys) { if (await caches.delete(k)) removed++; }
            // и опциональная очистка IndexedDB-кэшей WebLLM, если он их использует
            let idbRemoved = 0;
            if (indexedDB.databases) {
              try {
                const dbs = await indexedDB.databases();
                for (const d of dbs) {
                  if (d.name && /webllm|mlc/i.test(d.name)) {
                    await new Promise((res) => { const r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
                    idbRemoved++;
                  }
                }
              } catch {}
            }
            const est = await navigator.storage.estimate().catch(() => null);
            const usage = est ? Math.round(est.usage / 1048576) : "?";
            log("кэш очищен: Cache Storage снёс " + removed + " разделов" +
                (idbRemoved ? ", IndexedDB-баз: " + idbRemoved : "") +
                ", занято после: " + usage + " МБ");
            emit("status", "idle");
            sendResponse({ ok: true, removed, idbRemoved, usageMB: usage });
          } catch (e) {
            log("ошибка очистки кэша: " + (e?.message || e));
            sendResponse({ ok: false, error: e?.message || String(e) });
          }
          break;
        }

        case "setConfig":
          cfg = Object.assign(cfg, msg.cfg || {});
          await api.storage.local.set({ cfg });
          log("конфиг обновлён: " + JSON.stringify(cfg));
          sendResponse({ ok: true, cfg });
          break;

        case "load": {
          log("загрузка бэкенда «" + cfg.type + "»" + (cfg.type === "webllm" ? " модель " + cfg.modelId : " " + cfg.ollamaModel));
          await ensureLoaded((p) => emit("progress", p.text || p));
          log("готово к работе");
          emit("status", "ready");
          sendResponse({ ok: true });
          break;
        }

        case "unload":
          if (backend) { await backend.unload(); log("модель выгружена"); }
          emit("status", "idle");
          sendResponse({ ok: true });
          break;

        case "listModels": {
          const b = await ensureBackend();
          const ids = await b.listModels();
          sendResponse({ ok: true, models: ids });
          break;
        }

        case "adjudicate": {
          // ОЧЕРЕДЬ: запросы к модели сериализуются (движок не любит параллельные
          // генерации). Разные скрипты/вкладки встают в очередь и ждут ответа.
          const items = msg.items || [];
          const pos = queueLen++;
          if (pos > 0) { log("запрос в очереди (позиция " + pos + ")"); emit("queued", { pos }); }
          const job = modelChain.then(async () => {
            const b = await ensureLoaded((p) => emit("progress", p.text || p));
            // per-request переключение рассуждения (сериализовано очередью, без гонок)
            if (typeof msg.reasoning === "boolean") b.opts.reasoning = msg.reasoning;
            return b.adjudicate(items, (i, r) =>
              emit("item", { i, total: items.length, token: r.token, script: r.script, recovered: !!r.recovered })
            );
          });
          modelChain = job.then(() => {}, () => {}); // цепочка не рвётся на ошибке
          try {
            const results = await job;
            sendResponse({ ok: true, results });
          } finally {
            queueLen--;
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: "unknown cmd: " + msg.cmd });
      }
    } catch (e) {
      log("ОШИБКА: " + (e?.message || e));
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // ответ асинхронный
});

// восстановить конфиг при старте
api.storage.local.get("cfg").then((o) => { if (o && o.cfg) cfg = Object.assign(cfg, o.cfg); log("фон запущен"); });
