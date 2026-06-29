// ==UserScript==
// @name         Avito Notes & Dislike
// @namespace    avito-notes
// @version      1.1.0
// @description  Заметки и дизлайк к объявлениям Avito — видны на карточке и в поиске
// @match        *://www.avito.ru/*
// @match        *://*.avito.ru/*
// @grant        none
// @run-at       document-start
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
  padding: 1px 5px; max-width: 100%;
  box-sizing: border-box; word-break: break-word;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.an-badge-dislike { background: #fde8e8; color: #b91c1c; }
.an-badge-note { background: #fef9e7; color: #7c6000; }
.an-card-wrap {
  display: flex; flex-direction: column; gap: 2px;
  padding: 3px 0 0; margin-top: 2px;
}

/* ── item page: строка рядом с «Добавить в избранное» ── */
.an-item-bar {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: wrap; margin: 6px 0;
}
.an-dislike-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 13px; cursor: pointer;
  border: 1px solid #d1d5db; background: #fff;
  border-radius: 8px; padding: 5px 12px;
  transition: background .15s, color .15s, border-color .15s;
  user-select: none; white-space: nowrap;
}
.an-dislike-btn.on { background: #b91c1c; color: #fff; border-color: #b91c1c; }
.an-dislike-btn:hover:not(.on) { background: #fee2e2; border-color: #fca5a5; }
.an-note-wrap { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 180px; }
.an-note-input {
  flex: 1; font-size: 13px; border: 1px solid #d1d5db; border-radius: 8px;
  padding: 5px 8px; box-sizing: border-box; font-family: inherit;
  min-width: 120px;
}
.an-note-input:focus { outline: none; border-color: #6366f1; }
.an-save-btn {
  font-size: 13px; border: 1px solid #6366f1; color: #6366f1;
  background: #fff; border-radius: 8px; padding: 5px 10px; cursor: pointer;
  white-space: nowrap; transition: background .15s, color .15s;
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
  // Вставляется в ту же строку, что «Добавить в избранное» (data-marker="item-view/favorite-button")
  function buildItemBar(id) {
    const entry = getEntry(id);
    const bar = document.createElement("div");
    bar.className = "an-item-bar";
    bar.setAttribute("data-an-id", id);

    const dislikeBtn = document.createElement("button");
    dislikeBtn.className = "an-dislike-btn" + (entry.dislike ? " on" : "");
    dislikeBtn.textContent = entry.dislike ? "👎 Снять" : "👎 Дизлайк";
    dislikeBtn.title = "Пометить объявление дизлайком";
    dislikeBtn.onclick = () => {
      const next = !getEntry(id).dislike;
      setEntry(id, { dislike: next });
      dislikeBtn.className = "an-dislike-btn" + (next ? " on" : "");
      dislikeBtn.textContent = next ? "👎 Снять" : "👎 Дизлайк";
    };

    const noteWrap = document.createElement("div");
    noteWrap.className = "an-note-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "an-note-input";
    input.placeholder = "Заметка…";
    input.value = entry.note || "";
    input.onclick = (e) => e.stopPropagation();

    const saveBtn = document.createElement("button");
    saveBtn.className = "an-save-btn";
    saveBtn.textContent = "Сохр.";
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      setEntry(id, { note: input.value.trim() });
      saveBtn.textContent = "✓";
      setTimeout(() => { saveBtn.textContent = "Сохр."; }, 1200);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

    noteWrap.appendChild(input);
    noteWrap.appendChild(saveBtn);
    bar.appendChild(dislikeBtn);
    bar.appendChild(noteWrap);
    return bar;
  }

  function injectItemWidget(id) {
    if (document.querySelector("[data-an-id='" + id + "']")) return;

    // Находим контейнер кнопки «Добавить в избранное»
    // На скриншоте: button[data-marker="item-view/favorite-button"] внутри нескольких div
    // Поднимаемся до flex-контейнера строки (._2a702415f0569409 или родитель кнопки 3-4 уровня)
    const favBtn = document.querySelector(
      "[data-marker='item-view/favorite-button']," +
      "[data-marker='favorite-button']," +
      "button[class*='favorite']," +
      "[class*='favorite-button']"
    );
    if (!favBtn) return;

    // Ищем ближайший flex-контейнер строки (родитель 1-4 уровня)
    let row = favBtn.parentElement;
    for (let i = 0; i < 4 && row; i++) {
      const cs = getComputedStyle(row);
      if (cs.display === "flex" || cs.display === "inline-flex") break;
      row = row.parentElement;
    }
    if (!row) row = favBtn.parentElement;

    const bar = buildItemBar(id);
    // Вставить после строки с избранным
    row.parentNode.insertBefore(bar, row.nextSibling);
  }

  // ── Бейджи в карточках поиска ─────────────────────────────────────────────
  function injectCardBadges(card) {
    const id = idFromCard(card);
    if (!id) return;

    // Удалить старые бейджи этой карточки
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

    // Целевой контейнер: iva-item-bottomBlock (нижний левый блок карточки)
    // На скриншоте: div[class*="iva-item-bottomBlock"]
    const bottom =
      card.querySelector("[class*='iva-item-bottomBlock']") ||
      card.querySelector("[data-marker='item-line']") ||
      card.querySelector("[class*='bottomBlock']") ||
      card.querySelector("[class*='dateInfoStep']");

    if (bottom) {
      bottom.appendChild(wrap);
    } else {
      // fallback: в конец body карточки
      const body = card.querySelector("[class*='iva-item-body']") || card;
      body.appendChild(wrap);
    }
  }

  // Все карточки поиска (item-level контейнеры)
  function allCards() {
    // data-marker="item" — самый надёжный
    let els = document.querySelectorAll("[data-marker='item']");
    if (els.length) return [...els];
    // fallback: iva-item-content-*
    els = document.querySelectorAll("[class*='iva-item-content']");
    if (els.length) return [...els];
    return [];
  }

  function refreshCards() {
    allCards().forEach(injectCardBadges);
  }

  // ── Тип страницы ──────────────────────────────────────────────────────────
  function isItemPage() {
    return /avito\.ru\/[^/]+_\d+([?#]|$)/.test(location.href);
  }

  let lastHref = "";

  function onNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    injectStyles();
    if (isItemPage()) {
      const id = idFromUrl();
      if (!id) return;
      let attempts = 12;
      const tryInject = () => {
        injectItemWidget(id);
        if (attempts-- > 0 && !document.querySelector("[data-an-id='" + id + "']"))
          setTimeout(tryInject, 400);
      };
      tryInject();
    } else {
      setTimeout(refreshCards, 300);
    }
  }

  // ── MutationObserver — карточки появляются динамически ───────────────────
  let moTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      onNavigate();
      if (!isItemPage()) refreshCards();
    }, 250);
  });

  function start() {
    injectStyles();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    onNavigate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(onNavigate, 80);
      return r;
    };
  });

  window.addEventListener("popstate", () => setTimeout(onNavigate, 80));
})();
