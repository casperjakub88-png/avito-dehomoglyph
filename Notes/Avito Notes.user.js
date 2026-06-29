// ==UserScript==
// @name         Avito Notes & Dislike
// @namespace    avito-notes
// @version      1.3.0
// @description  Заметки и дизлайк к объявлениям Avito — видны на карточке и в поиске
// @match        *://www.avito.ru/*
// @match        *://*.avito.ru/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ── Хранилище ──────────────────────────────────────────────────────────────
  const LS_KEY = "avito_notes_v1";

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
  }

  function saveAll(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
  }

  function getEntry(id) {
    return loadAll()[id] || { note: "", dislike: false };
  }

  function setEntry(id, patch) {
    const data = loadAll();
    data[id] = Object.assign(getEntry(id), patch);
    if (!data[id].note && !data[id].dislike) delete data[id];
    saveAll(data);
  }

  // ── Извлечь ID объявления ──────────────────────────────────────────────────
  function idFromUrl(url) {
    const m = (url || location.href).match(/_(\d+)(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  function idFromCard(el) {
    const a = el.querySelector("a[href*='_']");
    if (!a) return null;
    return idFromUrl(a.href);
  }

  // ── Стили ──────────────────────────────────────────────────────────────────
  const STYLE = `
.an-badge {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 11px; line-height: 1.3; border-radius: 4px;
  padding: 1px 5px; max-width: 100%; box-sizing: border-box;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.an-badge-dislike { background: #fde8e8; color: #b91c1c; }
.an-badge-note    { background: #fef9e7; color: #7c6000; }
.an-card-wrap { display: flex; flex-direction: column; gap: 2px; padding: 3px 0 0; }

.an-item-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 8px 0; padding: 6px 0; border-top: 1px solid #e5e7eb;
}
.an-dislike-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 13px; cursor: pointer; border: 1px solid #d1d5db;
  background: #fff; border-radius: 8px; padding: 5px 12px;
  transition: background .15s, color .15s, border-color .15s;
  user-select: none; white-space: nowrap; font-family: inherit;
}
.an-dislike-btn.on { background: #b91c1c; color: #fff; border-color: #b91c1c; }
.an-dislike-btn:hover:not(.on) { background: #fee2e2; border-color: #fca5a5; }
.an-note-wrap { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 160px; }
.an-note-input {
  flex: 1; font-size: 13px; border: 1px solid #d1d5db; border-radius: 8px;
  padding: 5px 8px; box-sizing: border-box; font-family: inherit; min-width: 100px;
}
.an-note-input:focus { outline: none; border-color: #6366f1; }
.an-save-btn {
  font-size: 13px; border: 1px solid #6366f1; color: #6366f1;
  background: #fff; border-radius: 8px; padding: 5px 10px; cursor: pointer;
  white-space: nowrap; transition: background .15s, color .15s; font-family: inherit;
}
.an-save-btn:hover { background: #6366f1; color: #fff; }
`;

  function injectStyles() {
    if (document.getElementById("an-styles")) return;
    const s = document.createElement("style");
    s.id = "an-styles";
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Виджет на странице объявления ─────────────────────────────────────────
  function buildItemBar(id) {
    const entry = getEntry(id);
    const bar = document.createElement("div");
    bar.className = "an-item-bar";
    bar.setAttribute("data-an-id", id);

    const dislikeBtn = document.createElement("button");
    dislikeBtn.className = "an-dislike-btn" + (entry.dislike ? " on" : "");
    dislikeBtn.textContent = entry.dislike ? "👎 Снять дизлайк" : "👎 Дизлайк";
    dislikeBtn.onclick = () => {
      const next = !getEntry(id).dislike;
      setEntry(id, { dislike: next });
      dislikeBtn.className = "an-dislike-btn" + (next ? " on" : "");
      dislikeBtn.textContent = next ? "👎 Снять дизлайк" : "👎 Дизлайк";
    };

    const noteWrap = document.createElement("div");
    noteWrap.className = "an-note-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "an-note-input";
    input.placeholder = "Заметка к объявлению…";
    input.value = entry.note || "";
    input.onclick = (e) => e.stopPropagation();

    const saveBtn = document.createElement("button");
    saveBtn.className = "an-save-btn";
    saveBtn.textContent = "Сохранить";
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      setEntry(id, { note: input.value.trim() });
      saveBtn.textContent = "✓";
      setTimeout(() => { saveBtn.textContent = "Сохранить"; }, 1200);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

    noteWrap.appendChild(input);
    noteWrap.appendChild(saveBtn);
    bar.appendChild(dislikeBtn);
    bar.appendChild(noteWrap);
    return bar;
  }

  // Найти якорь для вставки на странице объявления.
  // Пробуем несколько стабильных точек, от предпочтительных к fallback.
  function findItemAnchor() {
    const candidates = [
      // блок с заголовком (стабильный класс, виден на скриншоте)
      ".js-item-view-title-info",
      // маркер заголовка
      "[data-marker='item-view/title-info']",
      // блок цены/действий
      "[data-marker='item-view/item-price']",
      "[data-marker='item-view/price']",
      "[data-marker='item-view/item-actions']",
      // кнопка избранного — поднимаемся до контейнера
      "[data-marker='item-view/favorite-button']",
      "[data-marker='favorite-button']",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function injectItemWidget(id) {
    if (document.querySelector("[data-an-id='" + id + "']")) return false;
    const anchor = findItemAnchor();
    if (!anchor) return false;
    const bar = buildItemBar(id);
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    return true;
  }

  // ── Бейджи в карточках поиска ─────────────────────────────────────────────
  function injectCardBadges(card) {
    const id = idFromCard(card);
    if (!id) return;

    // убрать старые
    const old = card.querySelector(".an-card-wrap");
    if (old) old.remove();

    const entry = getEntry(id);
    if (!entry.dislike && !entry.note) return;

    const wrap = document.createElement("div");
    wrap.className = "an-card-wrap";

    if (entry.dislike) {
      const b = document.createElement("span");
      b.className = "an-badge an-badge-dislike";
      b.textContent = "👎 дизлайк";
      wrap.appendChild(b);
    }
    if (entry.note) {
      const b = document.createElement("span");
      b.className = "an-badge an-badge-note";
      b.textContent = "📝 " + entry.note;
      b.title = entry.note;
      wrap.appendChild(b);
    }

    // iva-item-bottomBlock — нижняя левая часть карточки (скриншот 1/2)
    const bottom =
      card.querySelector("[class*='iva-item-bottomBlock']") ||
      card.querySelector("[data-marker='item-line']") ||
      card.querySelector("[class*='bottomBlock']") ||
      card.querySelector("[class*='dateInfo']");

    (bottom || card).appendChild(wrap);
  }

  function allCards() {
    let els = document.querySelectorAll("[data-marker='item']");
    if (els.length) return [...els];
    els = document.querySelectorAll("[class*='iva-item-content']");
    return [...els];
  }

  function refreshCards() {
    allCards().forEach(injectCardBadges);
  }

  // ── SPA-навигация ─────────────────────────────────────────────────────────
  function isItemPage() {
    // id объявления — в последнем сегменте пути: .../что-то_1234567[?#]
    // плюс надёжный признак — наличие блока заголовка объявления в DOM
    if (/_\d+(?:[/?#]|$)/.test(location.pathname) &&
        !/\/(katalog|catalog|items|favorites|profile|user)\b/.test(location.pathname)) {
      return true;
    }
    return !!document.querySelector(
      ".js-item-view-title-info,[data-marker='item-view/title-info']"
    );
  }

  let lastHref = "";

  function onNavigate() {
    const cur = location.href;
    if (cur === lastHref) return;
    lastHref = cur;
    injectStyles();

    if (isItemPage()) {
      const id = idFromUrl();
      if (!id) return;
      // повторяем пока не найдём якорь (React рендерит асинхронно)
      let n = 20;
      const tick = () => {
        if (injectItemWidget(id)) return;
        if (--n > 0) setTimeout(tick, 300);
      };
      tick();
    } else {
      // поиск: дать React отрисовать карточки
      setTimeout(refreshCards, 300);
    }
  }

  // MutationObserver — ловим подгрузку карточек при скролле
  let moTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      if (location.href !== lastHref) { onNavigate(); return; }
      if (!isItemPage()) refreshCards();
    }, 300);
  });

  console.log("[Avito Notes] v1.3.0 запущен на", location.href, "| страница объявления:", isItemPage());

  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectStyles();
  onNavigate();

  // перехват SPA-навигации
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(onNavigate, 100);
      return r;
    };
  });
  window.addEventListener("popstate", () => setTimeout(onNavigate, 100));
})();
