// ==UserScript==
// @name         Avito Notes & Dislike
// @namespace    avito-notes
// @version      1.14.0
// @description  Заметки и дизлайк к объявлениям Avito — видны и редактируются на карточке и в поиске
// @match        *://www.avito.ru/*
// @match        *://*.avito.ru/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ── Хранилище ──────────────────────────────────────────────────────────────
  // Два уровня: по ID объявления (точечно) и по НАЗВАНИЮ (на все дубли продавца).
  const LS_KEY = "avito_notes_v1";       // { id: {note,dislike,like} }
  const LS_TKEY = "avito_notes_title_v1"; // { normTitle: {note,dislike,like} }
  const EMPTY = { note: "", dislike: false, like: false };

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  }
  function store(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
  }
  const loadAll = () => load(LS_KEY);
  const loadTitles = () => load(LS_TKEY);

  function normTitle(t) {
    return (t || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // Полностью записать запись уровня ID (или удалить, если пустая).
  function setEntryFull(id, entry) {
    const data = loadAll();
    if (!entry.note && !entry.dislike && !entry.like) delete data[id];
    else data[id] = { note: entry.note || "", dislike: !!entry.dislike, like: !!entry.like };
    store(LS_KEY, data);
  }
  // Полностью записать запись уровня НАЗВАНИЯ.
  function setTitleFull(title, entry) {
    const k = normTitle(title);
    if (!k) return;
    const data = loadTitles();
    if (!entry.note && !entry.dislike && !entry.like) delete data[k];
    else data[k] = { note: entry.note || "", dislike: !!entry.dislike, like: !!entry.like };
    store(LS_TKEY, data);
  }

  // Эффективная запись: уровень ID перекрывает уровень названия.
  function effEntry(id, title) {
    const all = loadAll();
    if (id && Object.prototype.hasOwnProperty.call(all, id)) return all[id];
    const k = normTitle(title);
    if (k) { const t = loadTitles()[k]; if (t) return t; }
    return EMPTY;
  }

  // Переключить лайк/дизлайк с сохранением остальных полей (материализует в ID-уровень).
  function toggleVote(id, title, field) {
    const cur = effEntry(id, title);
    const next = { note: cur.note, like: cur.like, dislike: cur.dislike };
    next[field] = !cur[field];
    if (field === "like" && next.like) next.dislike = false;
    if (field === "dislike" && next.dislike) next.like = false;
    setEntryFull(id, next);
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
  // Заголовок карточки поиска (для группировки дублей по названию).
  function titleFromCard(el) {
    const t = el.querySelector(
      "[data-marker='item-title'], h3 a, h3, h2 a, h2, [class*='title-root'], [class*='iva-item-title']"
    );
    return t ? t.textContent : "";
  }
  // Заголовок страницы объявления.
  function itemTitleText() {
    const h = document.querySelector(
      "h1[data-marker='item-view/title-info'], .js-item-view-title-info h1, h1[itemprop='name']"
    );
    return h ? h.textContent : "";
  }

  // ── Стили ──────────────────────────────────────────────────────────────────
  const STYLE = `
/* ── панель на странице объявления ── */
.an-item-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 2px 0 6px; padding: 0;
}
/* вариант «в строку с кнопкой Избранное» — тянется до конца колонки */
.an-item-bar.an-inline { margin: 0 0 0 12px; flex: 1 1 auto; min-width: 0; }
.an-item-bar.an-inline .an-note-wrap { flex: 1 1 auto; min-width: 0; }
.an-item-bar.an-inline .an-note-input { flex: 1 1 auto; min-width: 0; }
.an-like-btn, .an-dislike-btn {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 18px; line-height: 1; cursor: pointer; border: 1px solid #d1d5db;
  background: #fff; border-radius: 8px; padding: 4px 8px;
  transition: background .15s, border-color .15s, filter .15s;
  user-select: none; white-space: nowrap; font-family: inherit;
  filter: grayscale(1) opacity(.65);
}
.an-dislike-btn.on { background: #b91c1c; border-color: #b91c1c; filter: none; }
.an-dislike-btn:hover:not(.on) { background: #fee2e2; border-color: #fca5a5; filter: none; }
.an-like-btn.on { background: #16a34a; border-color: #16a34a; filter: none; }
.an-like-btn:hover:not(.on) { background: #dcfce7; border-color: #86efac; filter: none; }
.an-note-wrap { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 160px; }
.an-note-input {
  flex: 1; font-size: 13px; border: 1px solid #d1d5db; border-radius: 8px;
  padding: 5px 8px; box-sizing: border-box; font-family: inherit; min-width: 100px;
}
.an-note-input:focus { outline: none; border-color: #6366f1; }
/* кнопка «ко всем» (по названию) */
.an-all-btn {
  flex: 0 0 auto; cursor: pointer; user-select: none;
  font-size: 12px; line-height: 1; border: 1px solid #c7d2fe; color: #4338ca;
  background: #eef2ff; border-radius: 8px; padding: 5px 9px;
  white-space: nowrap; transition: background .15s, color .15s, border-color .15s;
}
.an-all-btn:hover { background: #e0e7ff; border-color: #a5b4fc; }
.an-all-btn.on { background: #4338ca; color: #fff; border-color: #4338ca; }
.an-card-wrap .an-all-btn { font-size: 11px; padding: 4px 7px; }

/* ── мини-виджет в карточке поиска ── */
.an-card-wrap {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 0 0; margin-top: 2px; width: 100%;
}
.an-card-like, .an-card-dislike {
  flex: 0 0 auto; cursor: pointer; user-select: none;
  font-size: 18px; line-height: 1; border: 1px solid #d1d5db;
  background: #fff; border-radius: 8px; padding: 3px 7px;
  transition: background .15s, border-color .15s, filter .15s;
  filter: grayscale(1) opacity(.65);
}
.an-card-dislike:hover { background: #fee2e2; border-color: #fca5a5; filter: none; }
.an-card-dislike.on { background: #b91c1c; border-color: #b91c1c; filter: none; }
.an-card-like:hover { background: #dcfce7; border-color: #86efac; filter: none; }
.an-card-like.on { background: #16a34a; border-color: #16a34a; filter: none; }
.an-card-note {
  flex: 1 1 auto; min-width: 60px;
  font-size: 13px; border: 1px solid #d1d5db; border-radius: 8px;
  padding: 4px 8px; box-sizing: border-box; font-family: inherit;
  background: #fffdf5;
}
.an-card-note:focus { outline: none; border-color: #6366f1; background: #fff; }

/* ── подсветка объявления ── */
.an-disliked {
  background: #fff1f1 !important;
  outline: 2px solid #f3b4b4; outline-offset: -2px; border-radius: 10px;
}
.an-liked {
  background: #f0fdf4 !important;
  outline: 2px solid #86efac; outline-offset: -2px; border-radius: 10px;
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
    const title = itemTitleText();
    const bar = document.createElement("div");
    bar.className = "an-item-bar";
    bar.setAttribute("data-an-id", id);

    const likeBtn = document.createElement("button");
    likeBtn.type = "button";
    likeBtn.textContent = "👍";
    likeBtn.title = "Лайк / снять";

    const dislikeBtn = document.createElement("button");
    dislikeBtn.type = "button";
    dislikeBtn.textContent = "👎";
    dislikeBtn.title = "Дизлайк / снять";

    const noteWrap = document.createElement("div");
    noteWrap.className = "an-note-wrap";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "an-note-input";
    input.placeholder = "Заметка к объявлению…";
    input.onclick = (e) => e.stopPropagation();
    noteWrap.appendChild(input);

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "an-all-btn";
    allBtn.textContent = "ко всем";
    allBtn.title = "Применить лайк/дизлайк и заметку ко всем объявлениям с таким же названием";

    const sync = () => {
      const e = effEntry(id, title);
      likeBtn.className = "an-like-btn" + (e.like ? " on" : "");
      dislikeBtn.className = "an-dislike-btn" + (e.dislike ? " on" : "");
      if (document.activeElement !== input) input.value = e.note || "";
      const k = normTitle(title);
      allBtn.classList.toggle("on", !!(k && loadTitles()[k]));
    };

    likeBtn.onclick = () => { toggleVote(id, title, "like"); sync(); };
    dislikeBtn.onclick = () => { toggleVote(id, title, "dislike"); sync(); };
    const save = () => {
      const cur = effEntry(id, title);
      setEntryFull(id, { note: input.value.trim(), like: cur.like, dislike: cur.dislike });
    };
    input.addEventListener("change", save);
    input.addEventListener("blur", () => { save(); sync(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

    allBtn.onclick = () => {
      const k = normTitle(title);
      if (k && loadTitles()[k]) {
        setTitleFull(title, EMPTY); // повторное нажатие — снять со всех
      } else {
        const cur = effEntry(id, title);
        setTitleFull(title, { note: cur.note, like: cur.like, dislike: cur.dislike });
      }
      sync();
    };

    bar.appendChild(likeBtn);
    bar.appendChild(dislikeBtn);
    bar.appendChild(noteWrap);
    bar.appendChild(allBtn);
    sync();
    return bar;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return el.offsetParent !== null && r.width > 0 && r.height > 0;
  }
  // видим И в пределах прокручиваемого документа (не в скрытой залипающей шапке вверху)
  function isVisibleInDoc(el) {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0; // не уехал выше вьюпорта (дубль из шапки имеет top < 0)
  }

  function insertUnderTitle(id) {
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

  // Вставка виджета на странице объявления.
  // Приоритет: справа от ВИДИМОЙ кнопки «Добавить в избранное» (та же flex-строка).
  // Если так виджет не отобразился — откат под заголовок.
  function injectItemWidget(id) {
    if (document.querySelector("[data-an-id='" + id + "']")) return false;

    // Пристыковываемся ТОЛЬКО к текстовой кнопке «Добавить в избранное».
    // Иконку-сердечко (у товарных объявлений рядом с ценой) НЕ трогаем —
    // иначе виджет наезжает на цену. В этом случае — откат под заголовок.
    const favs = [...document.querySelectorAll(
      "[data-marker='item-view/favorite-button'],[data-marker='favorite-button']"
    )].filter(isVisibleInDoc);
    const fav = favs.find((b) => /збранн/i.test(b.textContent || ""));

    if (fav) {
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
        if (isVisible(bar)) {
          // заставить строку кнопки (и её flex-предков) занять всю ширину колонки,
          // иначе строка сжимается по содержимому и заметка не тянется до конца
          let p = row;
          for (let i = 0; i < 4 && p && p !== document.body; i++) {
            const parent = p.parentElement;
            if (parent) {
              const pd = getComputedStyle(parent).display;
              if (pd === "flex" || pd === "inline-flex") {
                p.style.flexGrow = "1";
                p.style.minWidth = "0";
              }
            }
            p = parent;
          }
          return true;
        }
        bar.remove(); // вставилось, но невидимо — пробуем под заголовком
      }
    }

    return insertUnderTitle(id);
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

  function buildCardWidget(id, title) {
    const wrap = document.createElement("div");
    wrap.className = "an-card-wrap";
    wrap.setAttribute("data-an-card", id);
    wrap._title = title;
    killNav(wrap);

    const likeBtn = document.createElement("div");
    likeBtn.className = "an-card-like";
    likeBtn.textContent = "👍";
    likeBtn.title = "Лайк / снять";
    likeBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleVote(id, wrap._title, "like");
      syncCardWidget(wrap, id);
    });

    const dislikeBtn = document.createElement("div");
    dislikeBtn.className = "an-card-dislike";
    dislikeBtn.textContent = "👎";
    dislikeBtn.title = "Дизлайк / снять";
    dislikeBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleVote(id, wrap._title, "dislike");
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
    const save = () => {
      const cur = effEntry(id, wrap._title);
      setEntryFull(id, { note: input.value.trim(), like: cur.like, dislike: cur.dislike });
      syncCardWidget(wrap, id);
    };
    input.addEventListener("change", save);
    input.addEventListener("blur", save);

    // «ко всем» — применить состояние этой карточки ко всем дублям с тем же названием
    const allBtn = document.createElement("div");
    allBtn.className = "an-all-btn";
    allBtn.textContent = "ко всем";
    allBtn.title = "Применить лайк/дизлайк и заметку ко всем объявлениям с таким же названием";
    allBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const k = normTitle(wrap._title);
      if (k && loadTitles()[k]) setTitleFull(wrap._title, EMPTY);
      else {
        const cur = effEntry(id, wrap._title);
        setTitleFull(wrap._title, { note: cur.note, like: cur.like, dislike: cur.dislike });
      }
      refreshCards();
    });

    wrap._like = likeBtn;
    wrap._dislike = dislikeBtn;
    wrap._input = input;
    wrap._all = allBtn;
    wrap.appendChild(likeBtn);
    wrap.appendChild(dislikeBtn);
    wrap.appendChild(input);
    wrap.appendChild(allBtn);
    return wrap;
  }

  // Синхронизировать состояние виджета и подсветку карточки со стораджем.
  // Не трогаем input.value, если поле в фокусе (пользователь печатает).
  function syncCardWidget(wrap, id) {
    const entry = effEntry(id, wrap._title);
    wrap._like.classList.toggle("on", !!entry.like);
    wrap._dislike.classList.toggle("on", !!entry.dislike);
    const k = normTitle(wrap._title);
    wrap._all.classList.toggle("on", !!(k && loadTitles()[k]));
    if (document.activeElement !== wrap._input) wrap._input.value = entry.note || "";
    const card = wrap.closest("[data-marker='item'],[class*='iva-item-content']") || wrap.parentElement;
    if (card) {
      card.classList.toggle("an-disliked", !!entry.dislike);
      card.classList.toggle("an-liked", !!entry.like);
    }
  }

  function ensureCardWidget(card) {
    const id = idFromCard(card);
    if (!id) return;
    const title = titleFromCard(card);
    let wrap = card.querySelector(":scope .an-card-wrap[data-an-card='" + id + "']");
    if (!wrap) {
      // убрать чужой/устаревший виджет, если был
      const stale = card.querySelector(":scope .an-card-wrap");
      if (stale) stale.remove();
      wrap = buildCardWidget(id, title);
      const bottom =
        card.querySelector("[class*='iva-item-bottomBlock']") ||
        card.querySelector("[data-marker='item-line']") ||
        card.querySelector("[class*='bottomBlock']") ||
        card.querySelector("[class*='dateInfo']") ||
        card.querySelector("[class*='iva-item-body']") ||
        card;
      bottom.appendChild(wrap);
    } else if (title) {
      wrap._title = title; // обновить на случай ре-рендера
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

  console.log("[Avito Notes] v1.14.0 запущен на", location.href, "| страница объявления:", isItemPage());

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
