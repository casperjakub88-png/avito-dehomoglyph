// ==UserScript==
// @name         Avito Notes & Dislike
// @namespace    avito-notes
// @version      1.0.0
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
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; line-height: 1.2; border-radius: 4px;
  padding: 2px 6px; margin: 2px 0; max-width: 100%;
  box-sizing: border-box; word-break: break-word;
}
.an-badge-dislike {
  background: #fde8e8; color: #b91c1c; border: 1px solid #f9a8a8;
}
.an-badge-note {
  background: #fef9e7; color: #7c6000; border: 1px solid #ffe082;
}
.an-widget {
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px 0; border-top: 1px solid #eee; margin-top: 4px;
}
.an-dislike-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; cursor: pointer; border: 1px solid #d1d5db;
  background: #fff; border-radius: 6px; padding: 3px 10px;
  transition: background .15s, color .15s;
  user-select: none;
}
.an-dislike-btn.on { background: #b91c1c; color: #fff; border-color: #b91c1c; }
.an-dislike-btn:hover:not(.on) { background: #fee2e2; }
.an-note-wrap { display: flex; gap: 4px; align-items: flex-start; }
.an-note-input {
  flex: 1; font-size: 12px; border: 1px solid #d1d5db; border-radius: 6px;
  padding: 4px 6px; resize: vertical; min-height: 36px; box-sizing: border-box;
  font-family: inherit;
}
.an-note-input:focus { outline: none; border-color: #6366f1; }
.an-save-btn {
  font-size: 12px; border: 1px solid #6366f1; color: #6366f1;
  background: #fff; border-radius: 6px; padding: 4px 8px; cursor: pointer;
  white-space: nowrap; transition: background .15s, color .15s;
}
.an-save-btn:hover { background: #6366f1; color: #fff; }
`;

  function injectStyles() {
    if (document.getElementById("an-styles")) return;
    const s = document.createElement("style");
    s.id = "an-styles";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // ── Виджет на странице объявления ─────────────────────────────────────────
  function buildItemWidget(id) {
    const entry = getEntry(id);
    const wrap = document.createElement("div");
    wrap.className = "an-widget";
    wrap.setAttribute("data-an-id", id);

    const dislikeBtn = document.createElement("button");
    dislikeBtn.className = "an-dislike-btn" + (entry.dislike ? " on" : "");
    dislikeBtn.innerHTML = entry.dislike ? "👎 Дизлайк снят" : "👎 Дизлайк";
    dislikeBtn.title = "Пометить объявление дизлайком";

    dislikeBtn.onclick = () => {
      const e = getEntry(id);
      const next = !e.dislike;
      setEntry(id, { dislike: next });
      dislikeBtn.className = "an-dislike-btn" + (next ? " on" : "");
      dislikeBtn.innerHTML = next ? "👎 Дизлайк снят" : "👎 Дизлайк";
    };

    const noteWrap = document.createElement("div");
    noteWrap.className = "an-note-wrap";

    const textarea = document.createElement("textarea");
    textarea.className = "an-note-input";
    textarea.placeholder = "Заметка к объявлению…";
    textarea.rows = 2;
    textarea.value = entry.note || "";

    const saveBtn = document.createElement("button");
    saveBtn.className = "an-save-btn";
    saveBtn.textContent = "Сохранить";
    saveBtn.onclick = () => {
      setEntry(id, { note: textarea.value.trim() });
      saveBtn.textContent = "✓";
      setTimeout(() => { saveBtn.textContent = "Сохранить"; }, 1200);
    };

    noteWrap.appendChild(textarea);
    noteWrap.appendChild(saveBtn);
    wrap.appendChild(dislikeBtn);
    wrap.appendChild(noteWrap);
    return wrap;
  }

  // Найти якорь для вставки виджета на странице объявления
  function injectItemWidget(id) {
    if (document.querySelector("[data-an-id='" + id + "']")) return;
    // типичные контейнеры цены/кнопок на авито
    const anchors = [
      "[data-marker='item-view/item-actions']",
      "[data-marker='item-view/price']",
      ".item-actions",
      ".js-item-actions",
      "div[class*='item-actions']",
      "div[class*='price-block']",
    ];
    let anchor = null;
    for (const sel of anchors) {
      anchor = document.querySelector(sel);
      if (anchor) break;
    }
    if (!anchor) return;
    const widget = buildItemWidget(id);
    anchor.parentNode.insertBefore(widget, anchor.nextSibling);
  }

  // ── Бейджи в карточках поиска ─────────────────────────────────────────────
  function badgesFor(id) {
    const entry = getEntry(id);
    const frags = [];
    if (entry.dislike) {
      const b = document.createElement("div");
      b.className = "an-badge an-badge-dislike";
      b.textContent = "👎 дизлайк";
      frags.push(b);
    }
    if (entry.note) {
      const b = document.createElement("div");
      b.className = "an-badge an-badge-note";
      b.textContent = "📝 " + entry.note;
      b.title = entry.note;
      frags.push(b);
    }
    return frags;
  }

  // Найти контейнер для бейджей в карточке поиска
  function notesContainerFor(card) {
    // ищем блок с ценой или заголовком
    const anchors = [
      "[data-marker='item-title']",
      "h3",
      "[class*='title']",
      "[class*='price']",
    ];
    for (const sel of anchors) {
      const el = card.querySelector(sel);
      if (el) return el.parentElement || card;
    }
    return card;
  }

  function injectCardBadges(card) {
    const id = idFromCard(card);
    if (!id) return;
    // удалить старые
    card.querySelectorAll(".an-badge").forEach((b) => b.remove());
    const badges = badgesFor(id);
    if (!badges.length) return;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;margin:2px 0;";
    badges.forEach((b) => wrap.appendChild(b));
    const container = notesContainerFor(card);
    container.appendChild(wrap);
  }

  // Все карточки поиска
  const CARD_SELECTORS = [
    "[data-marker='item']",
    "[data-marker='catalog-serp/item']",
    "article[class*='item']",
    "div[class*='iva-item']",
  ];

  function allCards() {
    for (const sel of CARD_SELECTORS) {
      const els = document.querySelectorAll(sel);
      if (els.length) return [...els];
    }
    return [];
  }

  function refreshCards() {
    allCards().forEach(injectCardBadges);
  }

  // ── Определить тип страницы и действовать ─────────────────────────────────
  function isItemPage() {
    return /avito\.ru\/.*_\d+([?#]|$)/.test(location.href);
  }

  let lastHref = "";

  function onNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    injectStyles();
    if (isItemPage()) {
      const id = idFromUrl();
      if (id) {
        // DOM может быть ещё не готов — повторяем с задержками
        const tryInject = (attempts) => {
          injectItemWidget(id);
          if (attempts > 0 && !document.querySelector("[data-an-id='" + id + "']")) {
            setTimeout(() => tryInject(attempts - 1), 500);
          }
        };
        tryInject(8);
      }
    } else {
      setTimeout(refreshCards, 400);
    }
  }

  // ── MutationObserver для SPA-навигации ────────────────────────────────────
  let moTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(onNavigate, 200);
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

  // перехватить pushState/replaceState для SPA
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(onNavigate, 50);
      return r;
    };
  });

  window.addEventListener("popstate", () => setTimeout(onNavigate, 50));
})();
