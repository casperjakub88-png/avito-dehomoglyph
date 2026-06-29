// ==UserScript==
// @name         Avito Notes & Dislike
// @namespace    avito-notes
// @version      1.6.0
// @description  Заметки и дизлайк к объявлениям Avito — видны и редактируются на карточке и в поиске
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
    if (el.dataset && el.dataset.itemId) return el.dataset.itemId;
    if (el.id && /^i?\d+$/.test(el.id)) return el.id.replace(/^i/, "");
    const a = el.querySelector("a[href*='_']");
    if (!a) return null;
    return idFromUrl(a.href);
  }

  // ── Стили ──────────────────────────────────────────────────────────────────
  const STYLE = `
/* ── панель на странице объявления ── */
.an-item-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 2px 0 6px; padding: 0;
}
/* вариант «в строку с кнопкой Избранное» — компактнее, не на всю ширину */
.an-item-bar.an-inline { margin: 0 0 0 12px; flex: 1 1 auto; min-width: 220px; }
.an-item-bar.an-inline .an-note-input { min-width: 90px; }
.an-dislike-btn {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 13px; cursor: pointer; border: 1px solid #d1d5db;
  background: #fff; border-radius: 8px; padding: 5px 12px;
  transition: background .15s, color .15s, border-color .15s;
  user-select: none; white-space: nowrap; font-family: inherit; line-height: 1.2;
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

/* ── мини-виджет в карточке поиска ── */
.an-card-wrap {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 0 0; margin-top: 2px; width: 100%;
}
.an-card-dislike {
  flex: 0 0 auto; cursor: pointer; user-select: none;
  font-size: 18px; line-height: 1; border: 1px solid #d1d5db;
  background: #fff; border-radius: 8px; padding: 3px 7px;
  transition: background .15s, border-color .15s, filter .15s;
  filter: grayscale(1) opacity(.65);
}
.an-card-dislike:hover { background: #fee2e2; border-color: #fca5a5; filter: none; }
.an-card-dislike.on { background: #b91c1c; border-color: #b91c1c; filter: none; }
.an-card-note {
  flex: 1 1 auto; min-width: 60px;
  font-size: 13px; border: 1px solid #d1d5db; border-radius: 8px;
  padding: 4px 8px; box-sizing: border-box; font-family: inherit;
  background: #fffdf5;
}
.an-card-note:focus { outline: none; border-color: #6366f1; background: #fff; }

/* ── подсветка дизлайкнутого объявления ── */
.an-disliked {
  background: #fff1f1 !important;
  outline: 2px solid #f3b4b4; outline-offset: -2px; border-radius: 10px;
}
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
    dislikeBtn.type = "button";
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
    saveBtn.type = "button";
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

  // Вставка виджета на странице объявления.
  // Приоритет: справа от кнопки «Добавить в избранное» (в той же flex-строке).
  // Иначе — внутрь блока заголовка под h1.
  function injectItemWidget(id) {
    if (document.querySelector("[data-an-id='" + id + "']")) return false;

    const fav = document.querySelector(
      "[data-marker='item-view/favorite-button'],[data-marker='favorite-button']"
    );
    if (fav) {
      // поднимаемся до ближайшего flex-контейнера и добавляем виджет в конец (= справа)
      let row = fav.parentElement;
      for (let i = 0; i < 5 && row; i++) {
        const d = getComputedStyle(row).display;
        if (d === "flex" || d === "inline-flex") break;
        row = row.parentElement;
      }
      if (row) {
        const bar = buildItemBar(id);
        bar.classList.add("an-inline");
        row.appendChild(bar);
        return true;
      }
    }

    const titleBox =
      document.querySelector(".js-item-view-title-info") ||
      document.querySelector("[data-marker='item-view/title-info']");
    if (titleBox) { titleBox.appendChild(buildItemBar(id)); return true; }

    const alt = document.querySelector(
      "[data-marker='item-view/item-price'],[data-marker='item-view/price'],[data-marker='item-view/item-actions']"
    );
    if (alt) { const bar = buildItemBar(id); alt.parentNode.insertBefore(bar, alt.nextSibling); return true; }
    return false;
  }

  // ── Мини-виджет в карточке поиска (интерактивный) ──────────────────────────
  function stopCard(e) { e.stopPropagation(); }
  // На карточках-ссылках клик по нашему виджету не должен открывать объявление.
  // ВАЖНО: слушаем в фазе ВСПЛЫТИЯ (bubble), а не перехвата — иначе stopPropagation
  // на родителе не даёт событию дойти до дочерней кнопки дизлайка.
  function killNav(el) {
    ["mousedown", "mouseup", "pointerdown", "touchstart", "auxclick"].forEach((ev) =>
      el.addEventListener(ev, (e) => { e.stopPropagation(); }, false)
    );
    el.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); }, false);
  }

  function buildCardWidget(id) {
    const wrap = document.createElement("div");
    wrap.className = "an-card-wrap";
    wrap.setAttribute("data-an-card", id);
    killNav(wrap);

    const dislikeBtn = document.createElement("div");
    dislikeBtn.className = "an-card-dislike";
    dislikeBtn.textContent = "👎";
    dislikeBtn.title = "Дизлайк / снять";
    dislikeBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const next = !getEntry(id).dislike;
      setEntry(id, { dislike: next });
      syncCardWidget(wrap, id);
    });

    const input = document.createElement("input");
    input.type = "text";
    input.className = "an-card-note";
    input.placeholder = "Заметка…";
    input.addEventListener("click", (e) => { e.preventDefault(); stopCard(e); });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { input.blur(); }
    });
    const save = () => { setEntry(id, { note: input.value.trim() }); syncCardWidget(wrap, id); };
    input.addEventListener("change", save);
    input.addEventListener("blur", save);

    wrap._dislike = dislikeBtn;
    wrap._input = input;
    wrap.appendChild(dislikeBtn);
    wrap.appendChild(input);
    return wrap;
  }

  // Синхронизировать состояние виджета и подсветку карточки со стораджем.
  // Не трогаем input.value, если поле в фокусе (пользователь печатает).
  function syncCardWidget(wrap, id) {
    const entry = getEntry(id);
    wrap._dislike.classList.toggle("on", !!entry.dislike);
    if (document.activeElement !== wrap._input) wrap._input.value = entry.note || "";
    const card = wrap.closest("[data-marker='item'],[class*='iva-item-content']") || wrap.parentElement;
    if (card) card.classList.toggle("an-disliked", !!entry.dislike);
  }

  function ensureCardWidget(card) {
    const id = idFromCard(card);
    if (!id) return;
    let wrap = card.querySelector(":scope .an-card-wrap[data-an-card='" + id + "']");
    if (!wrap) {
      // убрать чужой/устаревший виджет, если был
      const stale = card.querySelector(":scope .an-card-wrap");
      if (stale) stale.remove();
      wrap = buildCardWidget(id);
      const bottom =
        card.querySelector("[class*='iva-item-bottomBlock']") ||
        card.querySelector("[data-marker='item-line']") ||
        card.querySelector("[class*='bottomBlock']") ||
        card.querySelector("[class*='dateInfo']") ||
        card.querySelector("[class*='iva-item-body']") ||
        card;
      bottom.appendChild(wrap);
    }
    syncCardWidget(wrap, id);
  }

  function allCards() {
    let els = document.querySelectorAll("[data-marker='item']");
    if (els.length) return [...els];
    els = document.querySelectorAll("[class*='iva-item-content']");
    return [...els];
  }

  function refreshCards() {
    allCards().forEach(ensureCardWidget);
  }

  // ── SPA-навигация ─────────────────────────────────────────────────────────
  function isItemPage() {
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
    if (!isItemPage()) setTimeout(refreshCards, 300);
  }

  function ensureItemWidget() {
    if (!isItemPage()) return;
    const id = idFromUrl();
    if (!id) return;
    if (document.querySelector("[data-an-id='" + id + "']")) return;
    injectItemWidget(id);
  }

  // MutationObserver — восстановление виджета и подсветки после ре-рендеров React
  let moTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      if (location.href !== lastHref) { onNavigate(); return; }
      if (isItemPage()) ensureItemWidget();
      else refreshCards();
    }, 150);
  });

  console.log("[Avito Notes] v1.6.0 запущен на", location.href, "| страница объявления:", isItemPage());

  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectStyles();
  onNavigate();
  ensureItemWidget();

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
