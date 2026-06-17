// popup.js — UI расширения. Общается с фоном по browser.runtime (внутренний канал).
const api = (typeof browser !== "undefined") ? browser : chrome;
const $ = (id) => document.getElementById(id);
const log = (m) => { const l = $("log"); l.textContent += m + "\n"; l.scrollTop = l.scrollHeight; };

// тестовые токены теперь в фоне (background.js); попап их не дублирует

let curType = "webllm";

function send(cmd, extra = {}) {
  return api.runtime.sendMessage(Object.assign({ cmd }, extra));
}

function readCfg() {
  return {
    type: curType,
    modelId: $("model").value || "gemma-2-9b-it-q4f16_1-MLC",
    ollamaHost: $("ohost").value,
    ollamaModel: $("omodel").value,
    delayMs: parseInt($("delay").value) || 0,
    maxTokens: parseInt($("maxtok").value) || 200,
    reasoning: $("reason").checked,
  };
}

function setBackend(type) {
  curType = type;
  $("be-webllm").classList.toggle("on", type === "webllm");
  $("be-ollama").classList.toggle("on", type === "ollama");
  $("webllm-cfg").style.display = type === "webllm" ? "" : "none";
  $("ollama-cfg").style.display = type === "ollama" ? "" : "none";
}

// приём бродкастов от фона (лог, прогресс, статус, прогресс по токенам)
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.__from !== "bg") return;
  if (msg.kind === "log") log(msg.payload);
  else if (msg.kind === "progress") { $("status").textContent = "загрузка…"; log("· " + msg.payload); }
  else if (msg.kind === "status") $("status").textContent = msg.payload;
  else if (msg.kind === "item") {
    const p = msg.payload;
    log("[" + (p.i + 1) + "/" + p.total + "] " + p.token + " → " + (p.script ?? "—") + (p.recovered ? " (восст.)" : ""));
  }
  else if (msg.kind === "report") renderReport(msg.payload);
});

$("be-webllm").onclick = () => setBackend("webllm");
$("be-ollama").onclick = () => setBackend("ollama");

$("list").onclick = async () => {
  await send("setConfig", { cfg: readCfg() });
  const r = await send("listModels");
  if (!r?.ok) { log("список не получен: " + (r?.error || "")); return; }
  const cur = $("model").value;
  $("model").innerHTML = "";
  const sc = (x) => /gemma-2-9b/i.test(x) ? 0 : /qwen2\.5-7b/i.test(x) ? 1 : /qwen|gemma|llama/i.test(x) ? 2 : 3;
  r.models.sort((a, b) => sc(a) - sc(b) || a.localeCompare(b)).forEach((id) => {
    const o = document.createElement("option"); o.value = id; o.textContent = id; $("model").appendChild(o);
  });
  if (r.models.includes(cur)) $("model").value = cur;
  log("моделей: " + r.models.length);
  refreshCachedBadges();   // пометить скачанные
};

$("load").onclick = async () => {
  $("load").disabled = true;
  await send("setConfig", { cfg: readCfg() });
  const r = await send("load");
  if (r?.ok) { $("unload").disabled = false; $("status").textContent = "ready"; }
  else log("ошибка загрузки: " + (r?.error || ""));
  $("load").disabled = false;
};

$("unload").onclick = async () => {
  await send("unload");
  $("unload").disabled = true; $("status").textContent = "idle";
};

function renderReport(rep) {
  if (!rep) return;
  const s = rep.summary || {};
  const line = (label, ok, extra) =>
    `<div class="sum-row ${ok ? "sum-ok" : "sum-bad"}"><span>${ok ? "✓" : "✗"} ${label}</span><b>${extra || ""}</b></div>`;
  let html = "<div style='font-size:11px;color:#888;margin-bottom:4px'>диагностика " + (rep.ts || "") + "</div>";
  if ("env" in s) html += line("Окружение (GPU/адаптер)", s.env);
  if ("net" in s) html += line("Сеть (CDN/веса)", s.net);
  if ("load" in s) html += line("Загрузка модели", s.load);
  if (s.infer) {
    const inf = s.infer;
    const ok = inf.errs === 0;
    html += line("Инференс", ok, "точность " + inf.ok + "/" + inf.scored + ", ~" + Math.round(inf.ms / 12) + "мс/ток" + (inf.lost ? ", TDR×" + inf.lost : ""));
  }
  $("summary").innerHTML = html;
}

let testRunning = false;

function setTestButton(running) {
  testRunning = running;
  $("test").textContent = running ? "Остановить" : "Прогнать тест";
  $("test").style.background = running ? "#b91c1c" : "";
  $("test").style.color = running ? "#fff" : "";
}

$("test").onclick = async () => {
  if (testRunning) {
    // повторное нажатие → остановка (между токенами)
    log("отправлен запрос на остановку…");
    await send("stop");
    return;
  }
  setTestButton(true);
  $("summary").innerHTML = "<div class='sum-row' style='background:#eef'>диагностика идёт…</div>";
  await send("setConfig", { cfg: readCfg() });
  const r = await send("diagnose");
  if (r?.ok && r.report) renderReport(r.report);
  else log("диагностика не удалась: " + (r?.error || ""));
  setTestButton(false);
};

$("clear").onclick = async () => {
  if (!confirm("Удалить ВСЕ скачанные модели из Cache Storage?\nПри следующей загрузке они будут скачаны заново (несколько ГБ).")) return;
  $("clear").disabled = true;
  const r = await send("clearCache");
  $("clear").disabled = false;
  if (!r?.ok) { log("ошибка очистки: " + (r?.error || "")); return; }
  $("unload").disabled = true;
  $("status").textContent = "idle (кэш очищен, " + (r.usageMB ?? "?") + " МБ занято)";
  renderCaches([]);
};

// ── секрет моста ──
$("saveSecret").onclick = async () => {
  const s = $("secret").value.trim();
  if (!s) { log("секрет пустой — не сохранён"); return; }
  await send("setConfig", { cfg: { bridgeSecret: s } });
  log("секрет моста сохранён (не забудь поставить ту же строку в userscript)");
};

// ── список и удаление конкретных моделей из кэша ──
function renderCaches(items) {
  const box = $("caches");
  if (!items || !items.length) { box.innerHTML = "<div style='font-size:11px;color:#888;padding:4px'>кэш пуст или не загружен</div>"; return; }
  box.innerHTML = "";
  items.forEach((c) => {
    const row = document.createElement("div");
    row.className = "cache-row";
    const label = c.model + (c.mb ? " · " + c.mb + " МБ" : "") + " · " + c.count + " файл.";
    row.innerHTML = "<span>" + label + "</span>";
    const btn = document.createElement("button");
    btn.textContent = "удалить";
    btn.onclick = async () => {
      if (!confirm("Удалить «" + c.model + "» из кэша?")) return;
      btn.disabled = true;
      const r = await send("deleteCache", { model: c.model });
      if (r?.ok) { row.remove(); log("удалено: " + c.model + " (" + r.removed + " файлов, занято: " + (r.usageMB ?? "?") + " МБ)"); refreshCachedBadges(); }
      else { log("не удалось удалить: " + (r?.error || "")); btn.disabled = false; }
    };
    row.appendChild(btn);
    box.appendChild(row);
  });
}

$("listCaches").onclick = async () => {
  $("caches").innerHTML = "<div style='font-size:11px;color:#888;padding:4px'>читаю кэш…</div>";
  const r = await send("listCaches");
  if (r?.ok) renderCaches(r.caches);
  else log("не удалось прочитать кэш: " + (r?.error || ""));
};

// пометить скачанные модели (● + наверх) И добавить отсутствующие в выпадашку
async function refreshCachedBadges() {
  const r = await send("listCachedModels").catch(() => null);
  const cached = new Set((r && r.models) || []);
  const sel = $("model");
  const cur = sel.value;
  // существующие пункты (очистим от старых пометок)
  const opts = [...sel.options].map((o) => ({ value: o.value, base: o.textContent.replace(/^●\s*/, "").replace(/\s*\(скачано\)$/, "") }));
  const have = new Set(opts.map((o) => o.value));
  // добавить скачанные, которых нет в списке
  for (const id of cached) if (!have.has(id)) opts.push({ value: id, base: id });
  // скачанные — наверх
  opts.sort((a, b) => (cached.has(b.value) ? 1 : 0) - (cached.has(a.value) ? 1 : 0));
  sel.innerHTML = "";
  opts.forEach((o) => {
    const el = document.createElement("option");
    el.value = o.value;
    el.textContent = (cached.has(o.value) ? "● " : "") + o.base + (cached.has(o.value) ? " (скачано)" : "");
    sel.appendChild(el);
  });
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// инициализация: подтянуть конфиг и заполнить модель по умолчанию
(async () => {
  // дефолтная модель в выпадашку (полный список — по кнопке ⟳)
  ["gemma-2-9b-it-q4f16_1-MLC", "Qwen2.5-7B-Instruct-q4f16_1-MLC", "Qwen2.5-3B-Instruct-q4f16_1-MLC"].forEach((id) => {
    const o = document.createElement("option"); o.value = id; o.textContent = id; $("model").appendChild(o);
  });
  const r = await send("getConfig").catch(() => null);
  if (r?.cfg) {
    // восстановить накопленный лог из фона (он переживает закрытие попапа)
    if (Array.isArray(r.logLines) && r.logLines.length) {
      $("log").textContent = r.logLines.join("\n") + "\n";
      $("log").scrollTop = $("log").scrollHeight;
    }
    setBackend(r.cfg.type || "webllm");
    if (r.cfg.modelId) $("model").value = r.cfg.modelId;
    $("ohost").value = r.cfg.ollamaHost || $("ohost").value;
    $("omodel").value = r.cfg.ollamaModel || $("omodel").value;
    $("delay").value = r.cfg.delayMs ?? 60;
    $("maxtok").value = r.cfg.maxTokens ?? 200;
    $("reason").checked = r.cfg.reasoning ?? true;
    if (r.cfg.bridgeSecret) $("secret").value = r.cfg.bridgeSecret;
    $("status").textContent = r.status || "—";
    if (r.status === "ready") $("unload").disabled = false;
    if (r.report) renderReport(r.report);   // восстановить последнюю диагностику
  }
  refreshCachedBadges();   // отметить уже скачанные модели в выпадашке
})();
