// ============================================================================
//  llm-backends.js — абстракция бэкендов инференса (паттерн «стратегия»)
//  Один интерфейс LLMBackend, две реализации:
//    • WebLLMBackend  — модель в браузере через WebGPU (работает сейчас)
//    • OllamaBackend  — запрос на локальный/удалённый Ollama (каркас, дорабатывается)
//  Вызывающий код (background расширения) не знает, какой бэкенд активен.
// ============================================================================

// ── Общий промпт и разбор (одинаковы для всех бэкендов) ─────────────────────
const SYSTEM =
  "Определи, каким алфавитом ПО СМЫСЛУ записано выделенное слово в русском объявлении — кириллица или латиница.\n" +
  "Проверяй В ТАКОМ ПОРЯДКЕ:\n" +
  "ШАГ 1. Обозначает ли слово физическую величину или цену — напряжение, ток, мощность, частоту, вес, " +
  "размер, длину, объём, деньги? Если ДА → КИРИЛЛИЦА, даже если рядом стоят USB, зарядка, прицеп, диск. " +
  "Единица остаётся единицей независимо от технического окружения. " +
  "Примеры: 5B при USB = вольты → кириллица; 2.1A = амперы → кириллица; 500p = рубли → кириллица; 5T у прицепа = тонны → кириллица.\n" +
  "ШАГ 2. Только если это НЕ величина и НЕ цена: название/модель/стандарт/разъём/код/бренд или единица " +
  "цифровой памяти? Тогда → ЛАТИНИЦА. Примеры: iPhone 5C, 5S → латиница; type C, USB, HDMI → латиница; " +
  "5T у жёсткого диска = терабайты → латиница; Yahoo = бренд; ABC = латинское слово.\n" +
  "Русские слова и предлоги (с, в, о) — кириллица.";

function buildMessages(token, context, title, reasoning) {
  const tail = reasoning
    ? "Кратко (1 предложение) объясни смысл, затем последней строкой строго: ВЕРДИКТ: кириллица ИЛИ ВЕРДИКТ: латиница"
    : "Ответь одним словом: кириллица или латиница";
  const user =
    (title ? 'Объявление: "' + title + '"\n' : "") +
    'Фраза: "' + context + '"\nСлово: "' + token + '"';
  return [
    { role: "system", content: SYSTEM + "\n" + tail },
    { role: "user", content: user },
  ];
}

function parseVerdict(text) {
  const norm = (w) => (/кир/i.test(w) || /^cyr/i.test(w) ? "cyr" : "lat");
  const m = [...text.matchAll(/ВЕРДИКТ\s*:\s*(кириллиц\w*|латиниц\w*|cyr|lat)/gi)];
  if (m.length) return norm(m[m.length - 1][1]);
  const t = text.toLowerCase();
  const hasCyr = /кириллиц/.test(t) || /\bcyr\b/.test(t);
  const hasLat = /латиниц/.test(t) || /\blat\b/.test(t);
  if (hasCyr && !hasLat) return "cyr";
  if (hasLat && !hasCyr) return "lat";
  const lc = Math.max(t.lastIndexOf("кириллиц"), t.lastIndexOf("cyr"));
  const ll = Math.max(t.lastIndexOf("латиниц"), t.lastIndexOf("lat"));
  if (lc === -1 && ll === -1) return null;
  return lc > ll ? "cyr" : "lat";
}

// ── Базовый интерфейс ───────────────────────────────────────────────────────
class LLMBackend {
  constructor(opts = {}) {
    this.opts = Object.assign(
      { delayMs: 60, maxTokens: 200, reasoning: true },
      opts
    );
    this.ready = false;
  }
  get name() { return "base"; }
  async init(_onProgress) { throw new Error("not implemented"); }
  async unload() {}
  // единичный запрос -> сырой текст ответа модели
  async _complete(_messages) { throw new Error("not implemented"); }

  // публичный метод универсального моста: клиент передаёт готовые messages,
  // options временно перекрывают cfg-значения (сериализовано очередью bg — без гонок).
  async chat(messages, options = {}) {
    if (!this.ready) await this.init();
    const saved = { maxTokens: this.opts.maxTokens, reasoning: this.opts.reasoning };
    if (options.max_tokens != null) this.opts.maxTokens = options.max_tokens;
    if (typeof options.reasoning === "boolean") this.opts.reasoning = options.reasoning;
    try { return await this._complete(messages); }
    finally { Object.assign(this.opts, saved); }
  }

  // общий обход списка с дроблением нагрузки (пауза между токенами против TDR).
  // shouldStop — необязательная функция: если вернёт true, цикл прервётся между токенами
  // (на середине запроса прервать нельзя — WebLLM не даёт отменить вычисление).
  async adjudicate(items, onItem, shouldStop) {
    if (!this.ready) await this.init();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      if (shouldStop && shouldStop()) { out.aborted = true; break; }
      const { token, context, title } = items[i];
      let res;
      try {
        const raw = await this._complete(
          buildMessages(token, context, title, this.opts.reasoning)
        );
        res = { token, context, script: parseVerdict(raw), raw };
      } catch (e) {
        res = await this._onError(e, items[i]);
      }
      out.push(res);
      if (onItem) onItem(i, res);
      if (res && res.fatal) break;
      if (shouldStop && shouldStop()) { out.aborted = true; break; }
      if (this.opts.delayMs > 0 && i < items.length - 1)
        await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
    return out;
  }
  async _onError(e, _item) {
    return { script: null, raw: "ERR: " + (e?.message || e) };
  }
}

// ── Бэкенд 1: WebLLM (WebGPU в браузере) ───────────────────────────────────
const CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm",
  "https://esm.sh/@mlc-ai/web-llm",
];
class WebLLMBackend extends LLMBackend {
  constructor(opts = {}) {
    super(opts);
    this.modelId = opts.modelId || "gemma-2-9b-it-q4f16_1-MLC";
    this.lib = null;
    this.engine = null;
    this.onLog = opts.onLog || (() => {});
  }
  get name() { return "webllm"; }

  async _loadLib() {
    if (this.lib) return this.lib;
    let last;
    for (const u of CDN_URLS) {
      try {
        const m = await import(u);
        if (m.CreateMLCEngine) { this.lib = m; return m; }
      } catch (e) { last = e; }
    }
    throw new Error("WebLLM не загрузился: " + (last?.message || last));
  }

  async init(onProgress) {
    if (this.ready && this._loaded === this.modelId) return;
    if (!navigator.gpu) throw new Error("navigator.gpu недоступен в этом контексте");
    const lib = await this._loadLib();
    if (this.engine && this._loaded !== this.modelId) {
      try { await this.engine.reload(this.modelId); this._loaded = this.modelId; this.ready = true; return; }
      catch { try { await this.engine.unload?.(); } catch {} this.engine = null; }
    }
    this.engine = await lib.CreateMLCEngine(this.modelId, { initProgressCallback: onProgress });
    this._loaded = this.modelId;
    this.ready = true;
  }

  async _complete(messages) {
    const r = await this.engine.chat.completions.create({
      messages, temperature: 0, max_tokens: this.opts.maxTokens,
    });
    return r.choices[0].message.content || "";
  }

  // восстановление после потери GPU-устройства (TDR), один повтор
  async _onError(e, item) {
    const msg = (e?.message || String(e)).toLowerCase();
    const lost = msg.includes("device") && (msg.includes("lost") || msg.includes("dispose") || msg.includes("hung"));
    if (!lost) return { token: item.token, script: null, raw: "ERR: " + (e?.message || e) };
    this.onLog("устройство потеряно — engine.reload + повтор");
    try {
      await this.engine.reload(this.modelId);
      const raw = await this._complete(buildMessages(item.token, item.context, item.title, this.opts.reasoning));
      return { token: item.token, script: parseVerdict(raw), raw, recovered: true };
    } catch (e2) {
      return { token: item.token, script: null, raw: "FATAL: " + (e2?.message || e2), fatal: true };
    }
  }

  async listModels() {
    const lib = await this._loadLib();
    return lib.prebuiltAppConfig.model_list.map((m) => m.model_id);
  }

  async unload() {
    try { if (this.engine && typeof this.engine.unload === "function") await this.engine.unload(); } catch {}
    this.engine = null; this._loaded = null; this.ready = false;
  }
}

// ── Бэкенд 2: Ollama (локальный/удалённый сервер) — КАРКАС, дорабатывается ──
// TODO: проверить на запущенном Ollama (OLLAMA_ORIGINS=*), выбор моделей через /api/tags,
//       обработку ошибок сети, опционально потоковую отдачу. Реализация запроса дана,
//       но не протестирована в связке — отмечено как доработка.
class OllamaBackend extends LLMBackend {
  constructor(opts = {}) {
    super(opts);
    this.host = (opts.host || "http://localhost:11434").replace(/\/$/, "");
    this.model = opts.model || "qwen2.5:7b";
  }
  get name() { return "ollama"; }

  async init(_onProgress) {
    // проверка доступности сервера
    const r = await fetch(this.host + "/api/tags").catch((e) => { throw new Error("Ollama недоступен: " + e.message); });
    if (!r.ok) throw new Error("Ollama /api/tags HTTP " + r.status);
    this.ready = true;
  }

  async _complete(messages) {
    const r = await fetch(this.host + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, stream: false, options: { temperature: 0 }, messages }),
    });
    if (!r.ok) throw new Error("Ollama HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    const data = await r.json();
    return data.message?.content || "";
  }

  async listModels() {
    const r = await fetch(this.host + "/api/tags");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return ((await r.json()).models || []).map((m) => m.name);
  }

  async unload() { this.ready = false; } // у Ollama своя выгрузка по keep_alive; здесь no-op
}

// ── Фабрика ─────────────────────────────────────────────────────────────────
function createBackend(type, opts = {}) {
  if (type === "ollama") return new OllamaBackend(opts);
  return new WebLLMBackend(opts); // по умолчанию webllm
}

// экспорт через глобальную область (фоновая страница MV2 исполняет обычные скрипты,
// не ES-модули, поэтому НЕ используем export — кладём всё в self.LLMBackends).
// buildMessages / parseVerdict экспортируются для userscript'ов (копируют себе).
self.LLMBackends = { LLMBackend, WebLLMBackend, OllamaBackend, createBackend, buildMessages, parseVerdict };
