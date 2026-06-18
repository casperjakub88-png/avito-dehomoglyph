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

// ── Приоритетная очередь задач ───────────────────────────────────────────────
// priority: 1 = высший, 9 = низший (по умолчанию 5).
// Каждый job: { jobId, priority, meta, aborted, run(), resolve(), reject() }
class PriorityQueue {
  constructor() { this._q = []; }
  push(job) {
    const i = this._q.findIndex(j => j.priority > job.priority);
    if (i === -1) this._q.push(job); else this._q.splice(i, 0, job);
  }
  remove(jobId) {
    const i = this._q.findIndex(j => j.jobId === jobId);
    if (i !== -1) { this._q.splice(i, 1); return true; }
    return false;
  }
  shift() { return this._q.shift(); }
  get length() { return this._q.length; }
  snapshot() { return this._q.map(j => ({ jobId: j.jobId, priority: j.priority, client: j.meta && j.meta.client })); }
}
const jobQueue = new PriorityQueue();
const activeJobs = new Map();   // jobId -> job (в очереди или выполняется прямо сейчас)
let runnerBusy = false;

function emitQueueState() {
  emit("queue", { len: jobQueue.length + (runnerBusy ? 1 : 0), jobs: jobQueue.snapshot() });
}
async function runQueue() {
  if (runnerBusy) return;
  while (jobQueue.length > 0) {
    runnerBusy = true;
    const job = jobQueue.shift();
    emitQueueState();
    try { await job.run(); } catch (e) {
      try { job.resolve({ ok: false, error: e?.message || String(e) }); } catch {}
    }
    runnerBusy = false;
  }
  emitQueueState();
}
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

// ── Бенчмарк скорости: один и тот же запрос с контекстом РАЗНОЙ длины ────────
// Проверка точности (латиница/кириллица) перенесена в userscript; здесь —
// только производительность: обработка ввода (prefill), генерация (decode),
// полный цикл (end-to-end) на коротком/среднем/длинном промпте.
const BENCH_SET = [
  { label: "короткий (~15 слов)",  words: 15,  maxTokens: 80 },
  { label: "средний (~120 слов)",  words: 120, maxTokens: 80 },
  { label: "длинный (~400 слов)",  words: 400, maxTokens: 80 },
];
// Промпт фиксированной длины генерации (перечисление чисел) + контекст-нагрузка
// заданного объёма. Так decode-метрика стабильна, а prefill растёт с длиной ввода.
function buildBenchMessages(approxWords) {
  const unit = "Сетевой фильтр удлинитель розетки порты зарядка кабель адаптер питание устройство корпус ";
  const filler = unit.repeat(Math.ceil(approxWords / 10)).trim().split(/\s+/).slice(0, approxWords).join(" ");
  return [
    { role: "system", content: "Ты ассистент. Выполняй задание строго и кратко." },
    { role: "user", content: "Контекст (это нагрузка, смысл игнорируй): " + filler +
        "\n\nЗадание: перечисли через запятую целые числа от 1 до 40." },
  ];
}

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

  // 4. Бенчмарк скорости: prefill (обработка ввода), decode (генерация), e2e
  const prompts = BENCH_SET.map((b) => ({ label: b.label, messages: buildBenchMessages(b.words), maxTokens: b.maxTokens }));
  const t0 = performance.now();
  const rows = await backend.bench(prompts, (i, row) => {
    emit("item", {
      i, total: prompts.length, token: row.label,
      script: row.ok ? (row.decodeTps != null ? Math.round(row.decodeTps) + " ток/с" : Math.round(row.totalMs) + " мс") : "ERR",
    });
    if (row.ok) {
      log("· " + row.label + ": ввод " + row.promptTokens + " ток" +
          (row.prefillTps != null ? " @ " + Math.round(row.prefillTps) + " ток/с" : "") +
          ", генерация " + row.genTokens + " ток" +
          (row.decodeTps != null ? " @ " + Math.round(row.decodeTps) + " ток/с" : "") +
          ", e2e " + Math.round(row.totalMs) + " мс");
    } else {
      log("· " + row.label + ": ОШИБКА — " + row.error);
    }
  });
  const ms = Math.round(performance.now() - t0);
  const okRows = rows.filter((r) => r.ok);
  const errs = rows.length - okRows.length;
  const avg = (sel) => { const v = okRows.map(sel).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const avgPrefill = avg((r) => r.prefillTps), avgDecode = avg((r) => r.decodeTps);
  step("Бенчмарк скорости", errs === 0,
       (avgDecode != null ? "генерация ~" + Math.round(avgDecode) + " ток/с" : "") +
       (avgPrefill != null ? ", обработка ввода ~" + Math.round(avgPrefill) + " ток/с" : "") +
       ", всего " + ms + " мс" + (errs ? ", ошибок: " + errs : ""));
  report.summary.bench = { rows, ms, avgPrefill, avgDecode, errs };

  log("════ ИТОГ: окружение " + (report.summary.env ? "✓" : "✗") + ", сеть " + (netOk ? "✓" : "✗") +
      ", загрузка " + (loadOk ? "✓" : "✗") +
      (avgDecode != null ? ", генерация ~" + Math.round(avgDecode) + " ток/с" : "") + " ════");
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
          sendResponse({ ok: true, cfg, status: backend ? (backend.ready ? "ready" : "idle") : "none", logLines: LOG_BUF.slice(), report: lastReport, queue: { len: jobQueue.length + (runnerBusy ? 1 : 0), jobs: jobQueue.snapshot() } });
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

        case "chat": {
          // Универсальный вызов LLM. Клиент строит messages сам; мост только транспорт.
          // priority 1..9 (1 = первый); jobId — клиентский UUID (≤64 симв).
          const { jobId, messages, options = {}, meta = {} } = msg;
          const priority = Math.max(1, Math.min(9, (msg.priority | 0) || 5));
          if (!jobId || typeof jobId !== "string" || jobId.length > 64) {
            sendResponse({ ok: false, error: "jobId: непустая строка ≤64 симв" }); break;
          }
          if (activeJobs.has(jobId)) {
            sendResponse({ ok: false, error: "jobId уже в очереди: " + jobId }); break;
          }
          if (!Array.isArray(messages) || !messages.length) {
            sendResponse({ ok: false, error: "messages: непустой массив" }); break;
          }
          const client = (meta.client || "unknown").slice(0, 40);
          const task   = (meta.task   || "").slice(0, 40);

          const job = { jobId, priority, meta, aborted: false, resolve: null };
          const promise = new Promise(res => { job.resolve = res; });
          job.run = async () => {
            activeJobs.delete(jobId);
            if (job.aborted) { job.resolve({ ok: false, cancelled: true }); return; }
            log("[chat] client=" + client + (task ? " task=" + task : "") + " msgs=" + messages.length + " prio=" + priority);
            const b = await ensureLoaded((p) => emit("progress", p.text || p));
            try {
              const raw = await b.chat(messages, options);
              log("[chat] ← " + client + " " + raw.length + " симв");
              job.resolve({ ok: true, raw });
            } catch (e) {
              log("[chat] ERR " + client + ": " + (e?.message || e));
              job.resolve({ ok: false, error: e?.message || String(e) });
            }
          };

          activeJobs.set(jobId, job);
          jobQueue.push(job);
          const pos = jobQueue.length + (runnerBusy ? 1 : 0) - 1;
          if (pos > 0) log("[chat] " + jobId.slice(0, 8) + " в очереди (поз. " + pos + ")");
          emitQueueState();
          runQueue();

          sendResponse(await promise);
          break;
        }

        case "cancel": {
          // Отмена по массиву jobId. Ждущие в очереди — удаляем немедленно.
          // Выполняющийся в данный момент — помечаем: завершится с {cancelled:true}.
          const ids = Array.isArray(msg.jobIds) ? msg.jobIds : [];
          let cancelled = 0;
          for (const id of ids) {
            const job = activeJobs.get(id);
            if (!job) continue;
            job.aborted = true;
            if (jobQueue.remove(id)) {
              activeJobs.delete(id);
              job.resolve({ ok: false, cancelled: true });
            }
            // если уже выполняется — aborted=true; job.run() вернёт cancelled:true
            cancelled++;
          }
          emitQueueState();
          log("[cancel] отменено: " + cancelled + "/" + ids.length);
          sendResponse({ ok: true, cancelled });
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
