// Страницы приложения вокруг редактора и переходы между ними.
//
// Адрес страницы – в #-части ссылки, поэтому работают кнопки "назад/вперёд"
// браузера и обновление страницы:
//   #/videos        – библиотека: все видео, сгруппированные по автору;
//   #/video/<код>   – страница видео: прогресс, статистика, "Править";
//   #/edit/<код>    – редактор фрагментов этого видео;
//   #/process       – обработка (этап 1): источники текста, запуск, ход;
//   #/add           – добавить видео или аудио: ссылка или свой файл;
//   #/settings      – настройки приложения.
// Anki (прогресс, очередь, проверка флагов) – внутри раздела "Видео".
// Боковые панели скрываются и открываются кнопками; выбор запоминается.
const Panels = {
  init() {
    for (const side of ["left", "right"]) {
      try {
        if (localStorage.getItem(`panel-${side}`) === "closed") document.body.classList.add(`${side}-closed`);
      } catch (_) {}
    }
    document.addEventListener("click", (e) => {
      const button = e.target.closest("[data-toggle]");
      if (!button) return;
      const side = button.dataset.toggle;
      const closed = document.body.classList.toggle(`${side}-closed`);
      try {
        localStorage.setItem(`panel-${side}`, closed ? "closed" : "open");
      } catch (_) {}
      // Ширина редактора поменялась – дорожку надо перерисовать под неё.
      if (State.view === "editor") requestAnimationFrame(() => (Timeline._resize(), App.renderAll()));
    });
  },
};

const Router = {
  start() {
    Panels.init();
    Activity.start();
    window.addEventListener("hashchange", () => this.route());
    this.route();
  },

  async route() {
    const parts = (location.hash.replace(/^#\/?/, "") || "videos").split("/");
    const [page, id] = [parts[0], decodeURIComponent(parts[1] || "")];
    // Открыть / закрыть окно поверх уже показанного списка – список не
    // перерисовывается заново (иначе страница на миг пустеет) и продолжает обновляться.
    const listShown = (view, box) => State.view === view && document.querySelector(`#${box} a.card`);
    if ((page === "video" || page === "videos") && listShown("videos", "videos-list")) {
      if (page === "video" && id) Pages.videoModal(id);
      else {
        Modal.close(false);
        Pages.videosRender && Pages.videosRender();
      }
      return;
    }
    if (page === "process" && listShown("process", "process-list")) {
      if (id) Pages.processModal(id);
      else {
        Modal.close(false);
        Pages.processRender && Pages.processRender();
      }
      return;
    }
    Pages.stopRefresh();
    // Окно подробностей живёт только на своём адресе (#/video/..., #/processing/...).
    if (!(page === "video" || (page === "process" && id))) Modal.close(false);
    if (page === "edit" && id) {
      this.show("editor", null); // в редакторе ни один раздел меню не выделен
      await App.openProject(id);
      FragList.reset();
      this.show("editor", null); // обновить ссылку «сейчас правится» уже с названием видео
      return;
    }
    Player.pauseIfPlaying();
    if (page === "video" && id) {
      // Подробности видео – окно поверх списка видео.
      if (!document.getElementById("modal-overlay")) {
        this.show("videos", "videos");
        await Pages.videos();
      }
      Pages.videoModal(id);
    } else if (page === "process") {
      if (!(id && document.getElementById("modal-overlay"))) {
        this.show("process", "process");
        await Pages.process();
      }
      if (id) Pages.processModal(id);
    } else if (page === "add" || page === "download") {
      this.show("add", "add");
      Pages.add();
    } else if (page === "settings") {
      this.show("settings", "settings");
      Pages.settings();
    } else {
      this.show("videos", "videos");
      Pages.videos();
    }
  },

  show(view, menu) {
    State.view = view;
    document.querySelectorAll(".view").forEach((el) => el.classList.toggle("hidden", el.id !== `view-${view}`));
    document.querySelectorAll("#menu a[data-menu]").forEach((a) => a.classList.toggle("active", a.dataset.menu === menu));
    document.getElementById("fraglist").classList.toggle("hidden", view !== "editor");
    document.body.classList.toggle("no-fraglist", view !== "editor");
    // Фон "удалено"/"в Anki" относится к фрагменту в редакторе, не к другим страницам.
    if (view !== "editor") {
      document.body.classList.remove("frag-deleted", "frag-locked", "frag-bg-anki", "frag-bg-pending",
        "frag-bg-translated", "frag-bg-returned");
    }
    // Ссылка "сейчас правится" в меню – чтобы вернуться в редактор одним кликом.
    const editing = document.getElementById("menu-editing");
    editing.classList.toggle("hidden", !State.project);
    if (State.project) {
      const link = document.getElementById("menu-editing-link");
      link.href = `#/edit/${encodeURIComponent(State.project)}`;
      link.textContent = (State.manifest && State.manifest.video.title) || State.project;
    }
    if (view === "editor") requestAnimationFrame(() => Timeline._resize && (Timeline._resize(), App.renderAll()));
  },
};

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function progressBar(done, total, label, cls = "") {
  const share = total ? Math.min(1, done / total) : 0;
  return `<div class="progress${cls ? ` ${cls}` : ""}" title="${escapeHtml(label)}"><div class="progress-fill" style="width:${(share * 100).toFixed(1)}%"></div>` +
    `<span class="progress-label">${escapeHtml(label)}</span></div>`;
}

// Оформление карточки видео по этапу (фон-градиент и обводка):
//   готово (всё переведено) – розовое; идёт перевод или осталось перевести –
//   бледно-розовое; идёт передача в Anki или всё отредактировано, но не
//   передано – синее; иначе (идёт правка) – обычное серое.
function cardState(v) {
  if (v.complete) return " complete";
  if (v.translating) return " to-translate";
  if (v.sending) return " to-send";
  if (v.ready_to_translate) return " to-translate";
  if (v.ready_to_send) return " to-send";
  return "";
}

// Кнопка следующего шага на карточке: зелёная "Передать в Anki" или розовая
// "Перевести". Пока шаг идёт (или его только что нажали) – кнопки нет.
function cardAction(v) {
  const pressed = Pages.pressedActions.get(v.id);
  if (pressed && Date.now() - pressed < 20000) return "";
  if (v.translating || v.sending) return "";
  if (v.ready_to_send) {
    return `<button class="card-action send" data-action="send" data-id="${escapeHtml(v.id)}">Передать в Anki</button>`;
  }
  if (v.ready_to_translate) {
    return `<button class="card-action translate" data-action="translate" data-id="${escapeHtml(v.id)}">Перевести</button>`;
  }
  return "";
}

// Полоса из цветных отрезков: segments = [{n, cls}] – слева направо; последний
// отрезок с right: true прижимается к правому краю (между ними – серое).
// name – подпись слева, done / total – справа. Стыки цветов – под наклоном
// (классы sl / sr: скошенный левый / правый край, см. styles.css).
// Ширины и число плавно анимируются – см. animateBars.
function segmentBar(segments, total, name, done) {
  const pct = (n) => (total ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);
  const left = segments.filter((s) => !s.right && s.n > 0);
  const right = segments.filter((s) => s.right && s.n > 0);
  const leftEnd = left.reduce((sum, s) => sum + pct(s.n), 0);
  const html = (s, k, list, side) => {
    const w = pct(s.n);
    // Каждый отрезок – параллелограмм: соседи стыкуются ровно по одной
    // наклонной линии (вертикальных концов нет нигде, и узкий отрезок не
    // показывает под собой конец предыдущего). Не скошены только края
    // полосы: левый край первого отрезка и правый – у дошедшего до 100%.
    const sl = side === "right" || k > 0;
    const sr = side === "left" ? !(k === list.length - 1 && leftEnd >= 99.9) : k < list.length - 1;
    return `<div class="seg ${s.cls}${sl ? " sl" : ""}${sr ? " sr" : ""}" data-w="${w.toFixed(2)}" ` +
      `style="width:${segWidth(w, sl)}" title="${escapeHtml(s.title || "")}"></div>`;
  };
  return `<div class="progress segmented" data-bar="${escapeHtml(name)}" title="${escapeHtml(`${name} ${done} / ${total}`)}">` +
    `<div class="seg-left">${left.map((s, k) => html(s, k, left, "left")).join("")}</div>` +
    `<div class="seg-right">${right.map((s, k) => html(s, k, right, "right")).join("")}</div>` +
    `<span class="progress-label"><span>${escapeHtml(name)}</span>` +
    `<span class="progress-count" data-done="${done}" data-total="${total || 0}">${done} / ${total || 0}</span></span></div>`;
}

// Ширина отрезка: со скосом слева он заходит на 6 px под предыдущий.
function segWidth(w, slanted) {
  return slanted && w > 0 ? `calc(${w}% + 6px)` : `${w}%`;
}

// Снимок полос перед перерисовкой: ширины отрезков и числа – чтобы новые
// значения не прыгали, а плавно доезжали от старых.
function barSnapshot(root) {
  const snap = new Map();
  if (!root) return snap;
  root.querySelectorAll("[data-bar]").forEach((bar) => {
    const key = barKey(bar);
    bar.querySelectorAll(".seg").forEach((seg) => snap.set(`${key}|${seg.classList[1]}`, parseFloat(seg.dataset.w) || 0));
    const count = bar.querySelector(".progress-count");
    if (count) snap.set(`${key}|#`, parseFloat(count.dataset.shown ?? count.dataset.done) || 0);
  });
  return snap;
}

function barKey(bar) {
  const owner = bar.closest("[data-key]") || bar.closest("a.card");
  return `${owner ? owner.dataset.key || owner.getAttribute("href") : ""}|${bar.dataset.bar}`;
}

// Плавно довести полосы внутри root от снимка (или от нуля – при первом
// показе раздела) до их настоящих значений; числа считают вверх/вниз так же.
function animateBars(root, snap = new Map()) {
  if (!root) return;
  const segs = [];
  root.querySelectorAll("[data-bar]").forEach((bar) => {
    const key = barKey(bar);
    bar.querySelectorAll(".seg").forEach((seg) => {
      const from = snap.get(`${key}|${seg.classList[1]}`) ?? 0;
      const to = parseFloat(seg.dataset.w) || 0;
      if (Math.abs(from - to) < 0.01) return;
      const slanted = seg.classList.contains("sl");
      seg.style.transition = "none";
      seg.style.width = segWidth(from, slanted);
      segs.push([seg, to, slanted]);
    });
    const count = bar.querySelector(".progress-count");
    if (count) countUp(count, snap.get(`${key}|#`) ?? 0, parseFloat(count.dataset.done) || 0);
  });
  if (!segs.length) return;
  root.getBoundingClientRect(); // применить стартовые ширины до включения анимации
  requestAnimationFrame(() => segs.forEach(([seg, to, slanted]) => {
    seg.style.transition = "";
    seg.style.width = segWidth(to, slanted);
  }));
}

// Число "N / K" в полосе: плавно от from до to (за то же время, что и полоса).
function countUp(el, from, to) {
  const total = el.dataset.total;
  if (from === to) return;
  const start = performance.now();
  const step = (now) => {
    if (!el.isConnected) return;
    const t = Math.min(1, (now - start) / BAR_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (to - from) * eased);
    el.dataset.shown = value;
    el.textContent = `${value} / ${total}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const BAR_ANIMATION_MS = 900;

// Раздел открыли: заголовок, описание и остальное содержимое страницы
// появляются по очереди (так же, как карточки).
function viewEnter(el) {
  [...el.children].forEach((child, i) => {
    child.style.setProperty("--i", i);
    child.classList.add("enter");
    child.addEventListener("animationend", () => child.classList.remove("enter"), { once: true });
  });
}

// Раздел открыли: карточки появляются по очереди (лёгкий подъём и проявление).
function cardsEnter(box) {
  box.querySelectorAll("a.card, .group-title").forEach((el, i) => {
    el.style.setProperty("--i", Math.min(i, 20));
    el.classList.add("enter");
    el.addEventListener("animationend", () => el.classList.remove("enter"), { once: true });
  });
}

// Перерисовать список без мигания: полосы доезжают от прежних значений
// (first – первый показ раздела: заполняются от нуля).
function renderSmooth(box, html, first = false) {
  const snap = first ? new Map() : barSnapshot(box);
  box.innerHTML = html;
  animateBars(box, snap);
}

function formatSize(bytes) {
  if (!bytes) return "0 МБ";
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} ГБ` : `${Math.round(bytes / 2 ** 20)} МБ`;
}

// Две полосы видео.
// "Отредактировано" (слева направо, до скрытой метки – последнего
//   изменённого фрагмента): синее – просмотрено и принято без правок;
//   жёлтое – изменено; красное – удалено; серое – ещё не тронуто.
// "Передано в Anki" – живые фрагменты на этапе 3; справа фиолетовые —
//   карточки с флагом "обрезка/текст" (оранжевый, красный).
function videoBars(v) {
  const e = v.edit_bar || { accepted: 0, changed: 0, deleted: 0 };
  const edited = e.accepted + e.changed + e.deleted;
  const total = v.bar_total || v.fragments_total;
  return segmentBar([
    { n: e.accepted, cls: "accepted", title: `Приняты без правок: ${e.accepted}` },
    { n: e.changed, cls: "changed", title: `Изменены: ${e.changed}` },
    { n: e.deleted, cls: "deleted", title: `удалены: ${e.deleted}` },
  ], total, "Отредактировано", edited) +
  segmentBar([
    { n: v.exported - (v.flag_interval || 0), cls: "ok", title: `Передано: ${v.exported}` },
    { n: v.flag_interval || 0, cls: "returned", right: true, title: `флаг «обрезка/текст» в Anki: ${v.flag_interval || 0}` },
  ], v.active_total, "Передано в Anki", v.exported) +
  // Переведено: в Anki (оборот заполнен) + переведённые заранее, ждущие передачи в Anki;
  // из всех фрагментов с текстом.
  (() => {
    const done = (v.translated || 0) + (v.translated_waiting || 0);
    return segmentBar([
      { n: done, cls: "translated", title: `Переведено: ${done}` + (v.translated_waiting ? `, из них ждут передачи в Anki: ${v.translated_waiting}` : "") },
    ], v.cards_total, "Переведено", done);
  })();
}

// Строка таблицы в окнах. value — текст или список строк: из нескольких строк
// видна первая, остальные свёрнуты и плавно раскрываются стрелкой ▾ справа.
function tableRow(name, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  if (!Array.isArray(value) || value.length === 1) {
    return `<tr><td>${name}</td><td>${Array.isArray(value) ? value[0] : value}</td></tr>`;
  }
  return `<tr class="multi"><td>${name}</td><td><div class="multi-first">${value[0]}` +
    `<button class="multi-toggle" title="Показать все (${value.length})">▾</button></div>` +
    `<div class="multi-rest">${value.slice(1).map((line) => `<div>${line}</div>`).join("")}</div></td></tr>`;
}

// Раскрыть / свернуть многострочное значение (плавно, по высоте содержимого).
document.addEventListener("click", (e) => {
  const button = e.target.closest(".multi-toggle");
  if (!button) return;
  const rest = button.closest("td").querySelector(".multi-rest");
  const open = !rest.classList.contains("open");
  rest.style.maxHeight = open ? `${rest.scrollHeight}px` : "0px";
  rest.classList.toggle("open", open);
  button.classList.toggle("open", open);
});

// Предложения агента по пачкам (в порядке поступления).
function groupBatches(proposals) {
  const groups = new Map();
  for (const p of proposals) {
    const key = p.batch || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()];
}

// Строка под полосами (только если есть что сказать): вернулись из Anki,
// ждут перевода, очередь Anki.
function videoNotes(v) {
  const q = v.stage3 || {};
  const queue = q.state === "waiting_anki" ? "Ждёт Anki" : q.notes_left ? `В очереди Anki ${q.notes_left}` : "";
  const parts = [
    v.disk_total !== undefined ? `Место на диске: ${formatSize(v.disk_total)}` : "",
    v.flagged ? `<span class="flagged-text">Вернулись из Anki: ${v.flagged}</span>` : "",
    v.flag_translation ? `<span class="translation-text">Перевод: ${v.flag_translation}</span>` : "",
    queue ? escapeHtml(queue) : "",
  ].filter(Boolean);
  return parts.length ? `<div class="muted small">${parts.join(" · ")}</div>` : "";
}

// Заголовок карточки видео: длительность перед названием.
function cardTitle(v) {
  return `<div class="card-title"><span class="card-time">${formatDuration(v.duration)}</span> ${escapeHtml(v.title)}` +
    `${v.audio_only ? ' <span class="muted small">· аудио</span>' : ""}</div>`;
}

// Поле, которое растёт по содержимому (название видео, ссылки): высота —
// по тексту; Enter в однострочном поле (data-single) не переносит строку.
function autoGrow(el) {
  const fit = () => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener("input", fit);
  if (el.dataset.single !== undefined) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
  }
  requestAnimationFrame(fit);
}

// Следит за полями формы: кнопки "Сохранить"/"Отменить" активны, только когда
// что-то изменено. snapshot() — запомнить текущее как сохранённое.
function formWatch(root, buttons) {
  const fields = () => [...root.querySelectorAll("input, textarea, select")].filter((el) => el.dataset.watch !== "no");
  const value = (el) => (el.type === "checkbox" ? String(el.checked) : el.value);
  let saved = [];
  const watcher = {
    snapshot() {
      saved = fields().map(value);
      watcher.update();
    },
    isDirty() {
      const now = fields().map(value);
      return now.length !== saved.length || now.some((v, i) => v !== saved[i]);
    },
    restore() {
      fields().forEach((el, i) => {
        if (el.type === "checkbox") el.checked = saved[i] === "true";
        else el.value = saved[i];
        el.dispatchEvent(new Event("input"));
        el.dispatchEvent(new Event("change"));
      });
      watcher.update();
    },
    update() {
      const dirty = watcher.isDirty();
      buttons.forEach((button) => button && (button.disabled = !dirty));
    },
  };
  root.addEventListener("input", () => watcher.update());
  root.addEventListener("change", () => watcher.update());
  watcher.snapshot();
  return watcher;
}

// Всплывающее окно поверх страницы (подробности видео и т.п.). guard —
// {isDirty(), save()}: если при закрытии есть несохранённые правки, окно
// спрашивает, сохранять ли их.
const Modal = {
  onClose: null,
  guard: null,

  show(html, onClose, guard = null) {
    this.close(false);
    const overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal"><button class="modal-close" title="Закрыть (Esc)">×</button><div class="modal-body">${html}</div></div>`;
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.requestClose();
    });
    overlay.querySelector(".modal-close").addEventListener("click", () => this.requestClose());
    document.body.appendChild(overlay);
    this.animateHeight(overlay.querySelector(".modal"), overlay.querySelector(".modal-body"));
    this.onClose = onClose || null;
    this.guard = guard;
    return overlay.querySelector(".modal-body");
  },

  // Содержимое окна сменилось (например, "Загрузка…" -> подробности) – окно
  // не прыгает, а плавно раздвигается (или сжимается) до новой высоты.
  // Высота окна всегда плавно подстраивается под содержимое ("Загрузка…" ->
  // подробности, раскрытие строк, поля и т.п.): следим за настоящим размером
  // содержимого (ResizeObserver), а не угадываем его – без перелёта и рывка.
  // Новое содержимое после "Загрузка…" плавно проявляется.
  animateHeight(modal, body) {
    const cs = getComputedStyle(modal);
    const extra = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
      .reduce((sum, k) => sum + parseFloat(cs[k]), 0);
    modal.style.boxSizing = "border-box";
    let current = null;
    const done = () => {
      modal.style.transition = "";
      modal.style.overflow = "";
    };
    new ResizeObserver(() => {
      const target = body.offsetHeight + extra;
      if (current === null) {
        current = target;
        modal.style.height = `${target}px`;
        return;
      }
      if (Math.abs(target - current) < 1) return;
      const from = modal.offsetHeight; // видимая сейчас (в том числе посреди анимации)
      current = target;
      modal.style.transition = "none";
      modal.style.height = `${from}px`;
      modal.style.overflow = "hidden";
      modal.getBoundingClientRect();
      modal.style.transition = "height 0.3s cubic-bezier(0.22, 0.61, 0.36, 1)";
      modal.style.height = `${target}px`;
      modal.addEventListener("transitionend", done, { once: true });
    }).observe(body);
    // Первое настоящее содержимое (вместо "Загрузка…") – проявляется.
    new MutationObserver((_, observer) => {
      observer.disconnect();
      [...body.children].forEach((el) => el.classList.add("appear"));
    }).observe(body, { childList: true });
  },

  // Закрыть по крестику / клику мимо / Esc: с вопросом, если есть несохранённое.
  requestClose() {
    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    if (overlay.querySelector(".confirm-box")) return; // вопрос уже задан
    if (!this.guard || !this.guard.isDirty()) {
      this.close();
      return;
    }
    const box = document.createElement("div");
    box.className = "confirm-box";
    // "Нет" – закрыть без сохранения; клик мимо вопроса – отмена (окно остаётся).
    box.innerHTML = `<div class="confirm"><div class="confirm-text">Сохранить изменения?</div>
      <div class="confirm-actions"><button class="step-btn danger" data-a="drop">Нет</button>
      <button class="step-btn primary" data-a="save">Сохранить</button></div></div>`;
    overlay.querySelector(".modal").appendChild(box);
    box.addEventListener("click", async (e) => {
      if (e.target === box) return box.remove(); // мимо вопроса – отмена
      const action = e.target.dataset && e.target.dataset.a;
      if (!action) return;
      if (action === "save") await this.guard.save();
      this.close();
    });
  },

  close(runCallback = true) {
    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    // Плавно гаснет (стили .closing), а из поиска по id исчезает сразу –
    // новое окно можно открыть тут же.
    overlay.removeAttribute("id");
    overlay.classList.add("closing");
    setTimeout(() => overlay.remove(), 160);
    this.guard = null;
    const callback = this.onClose;
    this.onClose = null;
    if (runCallback && callback) callback();
  },
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("modal-overlay")) Modal.requestClose();
});

// Ход этапа 1: шаг и процент (если шаг умеет его считать).
// Полоса – синяя, без процентов в подписи (процент виден по заполнению).
function processingBar(v) {
  if (v.percent === null || v.percent === undefined) {
    return `<div class="card-status">${escapeHtml(cap(v.status || "Обрабатывается"))}…</div>`;
  }
  return progressBar(v.percent, 100, cap(v.status), "processing");
}

// Форма слова по числу: plural(n, "фрагмент", "фрагмента", "фрагментов").
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// Первая буква – заглавная (статусы и подсказки всегда с большой буквы).
function cap(text) {
  const s = String(text || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Список сгруппирован по автору; внутри группы – как пришло (новые первыми).
// Порядок групп: по алфавиту, или своим сравнением (order).
function groupByAuthor(items, order = null) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.entries()].sort(order || ((a, b) => a[0].localeCompare(b[0])));
}

// Группы в "Видео": выше – где больше ждёт правки (сумма по видео группы:
// ещё не отредактированные + вернувшиеся из Anki), затем – где больше видео.
function byPendingWork(a, b) {
  const work = (list) => list.reduce((sum, v) => sum + (v.awaiting || 0), 0);
  return work(b[1]) - work(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]);
}

const Pages = {
  timer: null,

  stopRefresh() {
    clearInterval(this.timer);
    this.timer = null;
  },

  // Страница, которая показывает живой прогресс, перерисовывается раз в несколько секунд.
  refreshEvery(ms, fn) {
    this.stopRefresh();
    this.timer = setInterval(fn, ms);
  },

  // -- библиотека (и Anki) -------------------------------------------------------
  async videos() {
    const el = document.getElementById("view-videos");
    el.innerHTML = `<div class="page-head"><h1>Видео</h1>
        <div class="head-actions">
          <span id="flags-status" class="muted small"></span>
          <button id="open-flags" class="step-btn">Проверка флагов</button>
          <button id="open-translate" class="step-btn">Перевод</button>
        </div></div>
      <p class="muted small page-note">Обработанные видео, сгруппированные по автору. Полоса «Отредактировано» – докуда дошла правка (синее – принято без правок, жёлтое – изменено, красное – удалено), «Передано в Anki» – сколько фрагментов уже стали карточками. Нажмите на видео, чтобы открыть подробности, изменить название или автора и перейти к правке.</p>
      <div id="videos-list"><p class="muted">Загрузка…</p></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    el.querySelector("#open-flags").addEventListener("click", () => this.checkFlags());
    el.querySelector("#open-translate").addEventListener("click", () => this.translateModal());
    const render = async () => {
      const box = document.getElementById("videos-list");
      if (!box) return;
      let items;
      try {
        items = await Api.ankiOverview();
      } catch (err) {
        box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
        return;
      }
      // Кнопка "Перевод" показывает, сколько карточек ждут перевода.
      const toTranslate = items.reduce((sum, v) => sum + (v.flag_translation || 0), 0);
      const translateButton = document.getElementById("open-translate");
      if (translateButton) translateButton.textContent = toTranslate ? `Перевод (${toTranslate})` : "Перевод";
      if (!items.length) {
        box.innerHTML = '<p class="muted">Готовых видео пока нет – добавьте их в разделе «Добавить», затем обработайте в «Обработке».</p>';
        return;
      }
      const first = !box.querySelector("a.card");
      renderSmooth(box, groupByAuthor(items, byPendingWork).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          `<a class="card${cardState(v)}" href="#/video/${encodeURIComponent(v.id)}">${cardTitle(v)}` +
          videoBars(v) + videoNotes(v) + cardAction(v) +
          "</a>").join("") + "</div>",
      ).join(""), first);
      if (first) cardsEnter(box);
    };
    // Кнопки на карточке ("Передать в Anki", "Перевести"): действие сразу, окно
    // не открывается; кнопка плавно сворачивается, карточка уменьшается.
    // Обработчик на самой странице – вешается один раз (страница перерисовывается).
    if (!el.dataset.actionsBound) {
      el.dataset.actionsBound = "1";
      el.addEventListener("click", async (e) => {
        const button = e.target.closest(".card-action");
        if (!button) return;
        e.preventDefault();
        e.stopPropagation();
        const id = button.dataset.id;
        Pages.pressedActions.set(id, Date.now());
        button.disabled = true;
        button.style.height = `${button.offsetHeight}px`;
        button.getBoundingClientRect();
        button.classList.add("gone");
        try {
          if (button.dataset.action === "send") await Api.queueProject(id);
          else await Api.agentRun({ project: id, batch: false });
        } catch (err) {
          Pages.pressedActions.delete(id);
          console.error(err); // кнопка вернётся при перерисовке – можно нажать ещё раз
        }
        if (Pages.videosRender) Pages.videosRender();
      });
    }
    this.videosRender = render;
    await render();
    this.refreshEvery(5000, render);
  },

  // Окно "Перевод": агент готовит перевод для карточек с зелёным/красным
  // флагом; его предложения (было -> станет) одобряются или отклоняются.
  async translateModal() {
    const body = Modal.show('<p class="muted">Загрузка…</p>');
    const draw = async () => {
      let state;
      let items;
      try {
        [state, items] = await Promise.all([Api.agentState(), Api.ankiOverview()]);
      } catch (err) {
        body.innerHTML = `<p class="muted">Не удалось узнать состояние агента: ${escapeHtml(err.message)}</p>`;
        return;
      }
      const flagged = items.reduce((sum, v) => sum + (v.flag_translation || 0), 0);
      const st = state.status || {};
      const running = st.state === "running";
      const statusLine = running ? `Работает: ${st.done || 0} / ${st.total || "…"}${st.spent ? `, потрачено $${st.spent}` : ""}`
        : st.state === "error" ? `ошибка: ${escapeHtml(st.message || "")}` : "";
      const proposals = state.proposals;
      body.innerHTML = `
        <h2>Перевод</h2>
        <p class="muted small">Агент переводит пачками по сцене (видит весь текст видео и словарь терминов): карточки с <span class="flag-dot f3"></span> зелёным и <span class="flag-dot f1"></span> красным флагом – здесь, целое видео – кнопкой «Перевести» в подробностях видео. Перевод по правилам оформления, учитывает ваши комментарии со звёздочкой (*поясни за слово …) и убирает их. В Anki ничего не меняется, пока вы не одобрите. Одобренное: лицо – без комментариев, оборот – новый, метка «агент_перевод»; зелёный флаг снимается, красный становится оранжевым (обрезку ещё править).</p>
        <div class="muted small">Карточек с флагом «перевод» в Anki: ${flagged}${statusLine ? ` · ${statusLine}` : ""}${st.model ? ` · модель ${escapeHtml(st.model)}` : ""}</div>
        <div class="actions"><button id="agent-run" class="step-btn" ${running || !flagged ? "disabled" : ""}>Подготовить переводы</button></div>
        ${(state.batches || []).length ? `<div class="muted small">Пакетные заявки: ${state.batches.map((j) =>
          `${escapeHtml(j.project)} – ${j.cards} ${plural(j.cards, "карточка", "карточки", "карточек")} (${escapeHtml(j.state)})`).join("; ")}</div>` : ""}
        <div class="agent-list">${proposals.length ? groupBatches(proposals).map(([batch, list]) => `
          <div class="agent-batch" data-batch="${escapeHtml(batch)}">
            <div class="agent-batch-head"><b>${escapeHtml(batch || "Без пачки")}</b> <span class="muted small">· ${list.length} ${plural(list.length, "карточка", "карточки", "карточек")}</span>
              <span class="spacer"></span>
              <button class="step-btn batch-reject">Отклонить пачку</button>
              <button class="step-btn primary batch-approve">Одобрить пачку</button></div>
            ${list.map((p) => `
            <div class="agent-item" data-note="${p.note_id}">
              <label class="agent-head check"><input type="checkbox" checked>
                ${p.flag ? `<span class="flag-dot f${p.flag}"></span> ` : ""}#${escapeHtml(p.card_number || p.fragment_id)}
                <span class="muted small">· ${escapeHtml(p.model || "")}</span></label>
              <div class="agent-en">${escapeHtml(p.text || "")}</div>
              ${(p.comments || []).length ? `<div class="agent-comments">Ваши комментарии: ${p.comments.map((c) => `«${escapeHtml(c)}»`).join(", ")}</div>` : ""}
              <div class="agent-diff">
                <div><div class="muted small">Было</div><div class="agent-back old">${p.back_old || '<span class="muted">Пусто</span>'}</div></div>
                <div><div class="muted small">Станет <span class="muted">(можно поправить)</span></div><div class="agent-back new" contenteditable="true">${p.back_new}</div></div>
              </div>
            </div>`).join("")}
          </div>`).join("") : '<p class="muted">Предложений нет.</p>'}</div>
        ${proposals.length ? `<div class="modal-actions">
          <button class="step-btn" id="agent-reject">Отклонить отмеченные</button>
          <span class="muted small note"></span>
          <button class="big-btn" id="agent-approve">Одобрить отмеченные</button>
        </div>` : ""}`;
      body.querySelector("#agent-run").addEventListener("click", async () => {
        try {
          await Api.agentRun({});
        } catch (err) {
          alert(err.message);
        }
        draw();
      });
      // Обороты, которые поправили вручную (отличаются от предложенного).
      const original = new Map(proposals.map((p) => [String(p.note_id), p.back_new]));
      const editsOf = (ids) => Object.fromEntries(ids.map((id) => {
        const el = body.querySelector(`.agent-item[data-note="${id}"] .agent-back.new`);
        return [String(id), el ? el.innerHTML : null];
      }).filter(([id, html]) => html !== null && html !== original.get(id)));
      const checked = () => [...body.querySelectorAll(".agent-item")]
        .filter((el) => el.querySelector("input").checked).map((el) => Number(el.dataset.note));
      const act = async (approve) => {
        const ids = checked();
        if (!ids.length) return;
        try {
          approve ? await Api.agentApply(ids, [], editsOf(ids)) : await Api.agentApply([], ids);
          draw();
        } catch (err) {
          body.querySelector(".note").textContent = err.message;
        }
      };
      if (proposals.length) {
        body.querySelector("#agent-approve").addEventListener("click", () => act(true));
        body.querySelector("#agent-reject").addEventListener("click", () => act(false));
      }
      // Одобрить / отклонить пачку целиком (все её карточки, независимо от отметок).
      body.querySelectorAll(".agent-batch").forEach((group) => {
        const ids = () => [...group.querySelectorAll(".agent-item")].map((el) => Number(el.dataset.note));
        const run = async (approve) => {
          try {
            approve ? await Api.agentApply(ids(), [], editsOf(ids())) : await Api.agentApply([], ids());
            draw();
          } catch (err) {
            body.querySelector(".note").textContent = err.message;
          }
        };
        group.querySelector(".batch-approve").addEventListener("click", () => run(true));
        group.querySelector(".batch-reject").addEventListener("click", () => run(false));
      });
      // Пока агент работает – обновляем окно, чтобы видеть ход.
      if (running) setTimeout(() => document.getElementById("modal-overlay") && body.isConnected && draw(), 3000);
    };
    await draw();
  },

  // Окно "Проверка флагов": карточки приложения с флагами в Anki; оранжевые и
  // красные можно вернуть в редактор, перевод – в окне "Перевод".
  // "Проверка флагов": спросить Anki и сразу вернуть в редактор карточки с
  // флагом обрезки/текста (оранжевый, красный); зелёные (и красные) ждут
  // перевода – их готовит окно "Перевод". Итог – слева от кнопки.
  pressedActions: new Map(), // видео, где только что нажали кнопку на карточке: {id: время}

  async checkFlags() {
    const status = document.getElementById("flags-status");
    const button = document.getElementById("open-flags");
    const say = (text, hint = "") => {
      status.textContent = text;
      status.title = hint;
    };
    button.disabled = true;
    say("Проверяю…");
    try {
      const found = await Api.ankiCheck();
      const returnable = found.filter((item) => item.state === "in_anki" && (item.flag === 1 || item.flag === 2));
      const translation = found.filter((item) => item.flag === 1 || item.flag === 3).length;
      const already = found.filter((item) => item.state === "returned").length;
      let returned = {};
      if (returnable.length) {
        returned = (await Api.ankiReturn(returnable.map((item) => ({ project: item.project, fragment_id: item.fragment_id })))).returned;
        // Открытое в редакторе видео надо перечитать – его фрагменты разблокировались.
        if (State.project && returned[State.project]) {
          const id = State.project;
          State.manifest = null;
          State.project = null;
          if (State.view === "editor") App.openProject(id);
        }
      }
      const parts = [];
      if (returnable.length) parts.push(`На правку: ${returnable.length}`);
      if (already) parts.push(`уже на правке: ${already}`);
      if (translation) parts.push(`на перевод: ${translation}`);
      say(parts.length ? cap(parts.join(" · ")) : "Помеченных карточек нет",
        returnable.length ? "Вернулись в редактор – фильтр «помечены в Anki»" : "");
    } catch (err) {
      let message = err.message;
      try {
        message = JSON.parse(message).detail;
      } catch (_) {}
      say("Не получилось", message);
    }
    button.disabled = false;
    if (this.videosRender) this.videosRender();
  },

  // Подробности видео – окно поверх списка (#/video/<код>): статистика, место
  // на диске, правка названия и автора (колода Anki переименуется вслед).
  async videoModal(id) {
    let watcher = null;
    let save = async () => {};
    const body = Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/video/")) location.hash = "#/videos";
    }, { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() });
    let data;
    try {
      data = await Api.projectStats(id);
    } catch (err) {
      body.innerHTML = `<p class="muted">Видео не найдено или ещё обрабатывается.</p>`;
      return;
    }
    const v = data.summary;
    const s = data.stats;
    const d = data.disk;
    // Градиент и обводка окна – как у карточки этого видео в списке.
    const modalBox = body.closest(".modal");
    modalBox.classList.remove("complete", "to-translate", "to-send");
    const state = cardState(v).trim();
    if (state) modalBox.classList.add(state);
    const row = tableRow;
    // Строк в карточке: по 6 записей в строке, дальше — следующие строки (свёрнуты).
    const lineItems = Object.entries(s.lines_per_card).map(([n, c]) => `${n} стр. – ${c}`);
    const lines = [];
    for (let i = 0; i < lineItems.length; i += 6) lines.push(lineItems.slice(i, i + 6).join(", "));
    // Источники текста для сверки: ссылки, по одной в строке.
    const sources = (v.sources_display || []).map((src) =>
      `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.title || src.url)}</a>` +
      (src.used ? "" : ' <span class="muted small">(не использован)</span>'));
    const pct = (n) => (s.cards ? `${Math.round((n / s.cards) * 100)}%` : "0%");
    const shift = s.bound_shift_frames;
    // Фрагментов без перевода (переданные в Anki и ещё нет); null — Anki закрыт, неизвестно.
    // Переводить нечего (нет непереведённых карточек в Anki) или над видео идёт
    // процесс (передача в Anki) – кнопка серая.
    const untranslated = v.sending ? 0 : v.to_translate === null ? 1 : v.to_translate || 0;
    body.innerHTML = `
      <div class="modal-head">
        <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
        <label>Автор <input id="group-input" value="${escapeHtml(v.group)}"></label>
      </div>
      <div class="modal-bars" data-key="modal">${videoBars({ ...v, flag_interval: 0 })}</div>
      ${videoNotes({ ...v, disk_total: undefined })}
      <h2>Статистика</h2>
      <table class="stats">
        ${row("Ролик", `${formatDuration(s.video_seconds)}, карточек ${s.cards}`)}
        ${row("В клипах", `${formatDuration(s.kept_seconds)} – ${(s.kept_share * 100).toFixed(1)}% ролика, удалено ${s.deleted} ${plural(s.deleted, "фрагмент", "фрагмента", "фрагментов")} (${Math.round(s.deleted_seconds)} сек)`)}
        ${row("Длина клипа, сек", s.clip_seconds ? `${s.clip_seconds.mean} в среднем, ${s.clip_seconds.median} медиана, ${s.clip_seconds.min} мин., ${s.clip_seconds.max} макс.` : "")}
        ${row("Строк в карточке", lines)}
        ${row(sources.length > 1 ? "Источники" : "Источник", sources.length ? sources : "Нет")}
        ${row("Правка текста и границ", `${s.text_edited} ${plural(s.text_edited, "фрагмент", "фрагмента", "фрагментов")} (${pct(s.text_edited)}), ` +
          `${s.bounds_edited} ${plural(s.bounds_edited, "фрагмент", "фрагмента", "фрагментов")} (${pct(s.bounds_edited)})`)}
        ${row("Сдвиг границ, кадр", shift ? `${shift.mean} в среднем, ${shift.median} медиана, ${shift.min} мин., ${shift.max} макс.` : "")}
        ${row("Колода Anki", v.anki_deck ? escapeHtml(v.anki_deck) : "Нет")}
      </table>
      <h2>Место на диске</h2>
      <div class="disk-grid">
        <table class="stats">
          ${row("Оригинал", formatSize(d.master))}
          ${row("Копия для редактора и звук", `${formatSize(d.editor)}, ${formatSize(d.editor_audio)}`)}
        </table>
        <table class="stats">
          ${row("Клипы для Anki", formatSize(d.clips))}
          ${row("Всего", `<b>${formatSize(d.total)}</b>`)}
        </table>
      </div>
      <div class="modal-actions">
        <a class="step-btn primary" href="#/edit/${encodeURIComponent(v.id)}">Править</a>
        <button id="info-translate" class="step-btn" ${untranslated > 0 ? "" : "disabled"} title="${v.to_translate === null ? "Anki закрыт" : untranslated > 0 ? `Без перевода: ${untranslated}` : "Переводить нечего"}">Перевести</button>
        <label class="check small batch-check${untranslated > 0 ? "" : " hidden"}" title="OpenRouter Batch API: вдвое дешевле, результат – в течение минут или часов (до 24 ч)"><input type="checkbox" id="info-batch" data-watch="no"> Пакетом <span class="muted">(вдвое дешевле, но дольше)</span></label>
        <span id="info-note" class="muted small"></span>
        <button id="info-save" class="step-btn">Сохранить</button>
      </div>`;
    autoGrow(body.querySelector("#title-input"));
    animateBars(body.querySelector(".modal-bars"));
    const saveButton = body.querySelector("#info-save");
    watcher = formWatch(body.querySelector(".modal-head"), [saveButton]);
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (!title || !group) return;
      const saved = await Api.saveProjectInfo(id, { title, group });
      watcher.snapshot();
      // Переименовали видео, которое открыто в редакторе, – обновить ссылку в меню.
      if (State.project === id && State.manifest) {
        State.manifest.video.title = title;
        const link = document.getElementById("menu-editing-link");
        if (link) link.textContent = title;
      }
      const sync = saved.deck_sync || {};
      const savedNote = body.querySelector("#info-note");
      savedNote.textContent = !v.anki_deck ? "" : sync.pending ? "Колода – при запуске Anki" : "Колода переименована";
      savedNote.title = !v.anki_deck ? "" : sync.pending ? "Колода Anki переименуется, когда Anki откроется" : "Колода Anki переименована";
    };
    saveButton.addEventListener("click", save);
    // Перевод видео: "Перевести" <-> "Остановить" (пока идёт перевод этого
    // видео или ждёт его пакетная заявка). Снять "Пакетом", пока заявка ждёт,
    // – отменить заявку и перевести сразу.
    const translateButton = body.querySelector("#info-translate");
    const batchBox = body.querySelector("#info-batch");
    const note = body.querySelector("#info-note");
    // Короткая надпись в строке кнопок; полный текст – во всплывающей подсказке.
    const setNote = (text, hint = "") => {
      note.textContent = text;
      note.title = hint || text;
    };
    const label = translateButton.textContent;
    let running = false;
    let waitingBatch = false;
    const refreshTranslate = async () => {
      if (!body.isConnected) return;
      let state;
      try {
        state = await Api.agentState();
      } catch (_) {
        return;
      }
      const st = state.status || {};
      waitingBatch = (state.batches || []).some((j) => j.project === id);
      running = waitingBatch || (st.state === "running" && st.project === id && Date.now() / 1000 - st.updated < 300);
      batchBox.checked = waitingBatch || (running ? false : batchBox.checked);
      translateButton.textContent = running ? "Остановить" : label;
      translateButton.disabled = !running && untranslated <= 0;
      // Ход перевода – коротко и зелёным (места в строке кнопок немного).
      const progress = st.state === "running" && st.project === id && st.total;
      note.classList.toggle("running", !!progress);
      if (progress) setNote(`Перевод: ${st.done || 0}/${st.total}`);
      else if (waitingBatch) setNote("Ждём ответ пакета");
      if (running || wasRunning) refreshBars();
      wasRunning = running;
      if (running) setTimeout(refreshTranslate, 3000);
    };
    // Пока идёт перевод – полосы окна обновляются (плавно), и ещё раз после конца.
    let wasRunning = false;
    const refreshBars = async () => {
      try {
        const fresh = (await Api.projectStats(id)).summary;
        const box = body.querySelector(".modal-bars");
        if (box) renderSmooth(box, videoBars({ ...fresh, flag_interval: 0 }));
      } catch (_) {}
    };
    translateButton.addEventListener("click", async () => {
      try {
        if (running) {
          await Api.agentStop(id);
          note.classList.remove("running");
          setNote("Остановлено", "Перевод остановлен – уже переведённое сохранено");
        } else {
          await Api.agentRun({ project: id, batch: batchBox.checked });
          note.classList.add("running");
          if (batchBox.checked) setNote("Заявка отправлена", "Переводы запишутся, когда OpenRouter их вернёт");
          else setNote("Запускаю…", "Переданные в Anki получат перевод сразу, остальные – когда их передадут");
        }
      } catch (err) {
        note.classList.remove("running");
        setNote("Ошибка", err.message);
      }
      setTimeout(refreshTranslate, 800);
    });
    batchBox.addEventListener("change", async () => {
      if (waitingBatch && !batchBox.checked) {
        await Api.agentStop(id);
        await Api.agentRun({ project: id, batch: false });
        note.classList.add("running");
        setNote("Перевожу сразу", "Пакетная заявка отменена – перевожу сразу");
        setTimeout(refreshTranslate, 800);
      }
    });
    refreshTranslate();
  },

  // -- обработка (этап 1) --------------------------------------------------------------
  async process() {
    const el = document.getElementById("view-process");
    el.innerHTML = `<h1>Обработка</h1>
      <p class="muted small page-note">Добавленные видео: копия для редактора, распознавание речи, сверка с текстом и нарезка на фразы. Нажмите на видео, чтобы прикрепить ссылки на текст для сверки (например, страницу Notion) и запустить обработку.</p>
      <div id="process-list"><p class="muted">Загрузка…</p></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    const render = async () => {
      const box = document.getElementById("process-list");
      if (!box) return;
      const items = (await Api.projects()).filter((v) => v.state !== "ready");
      if (!items.length) {
        box.innerHTML = '<p class="muted">Нечего обрабатывать – добавьте видео или аудио в разделе «Добавить».</p>';
        return;
      }
      const first = !box.querySelector("a.card");
      box.innerHTML = groupByAuthor(items).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          `<a class="card" href="#/process/${encodeURIComponent(v.id)}">` +
          cardTitle(v) +
          ((v.sources || []).length ? `<div class="muted small">Ссылок на текст: ${v.sources.length}</div>` : "") +
          (v.state === "processing" ? processingBar(v) : `<div class="card-status">Добавлено, ждёт обработки</div>`) +
          "</a>").join("") + "</div>",
      ).join("");
      if (first) cardsEnter(box);
    };
    this.processRender = render;
    await render();
    this.refreshEvery(3000, render);
  },

  // Окно видео из "Обработки": название и автор, ссылки на текст для сверки,
  // помощь агента, запуск, место на диске.
  async processModal(id) {
    let watcher = null;
    let save = async () => {};
    const body = Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/process/")) location.hash = "#/process";
    }, { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() });
    const v = (await Api.projects()).find((item) => item.id === id);
    if (!v) {
      body.innerHTML = '<p class="muted">Видео не найдено.</p>';
      return;
    }
    let disk = null;
    try {
      disk = await Api.projectDisk(id);
    } catch (_) {}
    const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
    body.innerHTML = `
      <div class="process-form">
        <div class="modal-head">
          <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
          <label>Автор <input id="group-input" value="${escapeHtml(v.group)}"></label>
        </div>
        ${v.audio_only ? '<div class="muted">Аудио</div>' : ""}
        ${v.state === "processing" ? processingBar(v) : ""}
        <label class="check"><input type="checkbox" class="agent-search" ${v.agent === "search" ? "checked" : ""}> Поиск достоверных источников с помощью агента <span class="muted small">(ссылки не нужны)</span></label>
        <div class="sources-box"><div class="sources-inner">
          <label class="muted small">Текст для сверки (ссылки, по одной в строке)</label>
          <textarea class="sources grow" rows="1" placeholder="https://…notion.site/…">${escapeHtml((v.sources || []).join("\n"))}</textarea>
          <label class="check"><input type="checkbox" class="agent-deep" ${v.agent === "deep" ? "checked" : ""}> Глубокий поиск с помощью агента <span class="muted small">(агент + ваши ссылки)</span></label>
        </div></div>
        <label class="check"><input type="checkbox" class="no-gaps" ${v.no_gaps ? "checked" : ""}> Без пустых фрагментов <span class="muted small">(без музыки, шумов и других фрагментов без текста)</span></label>
      </div>
      ${disk ? `<h2>Место на диске</h2><table class="stats">
        ${row("Оригинал", formatSize(disk.master))}${row("Копия для редактора", formatSize(disk.editor))}${row("Всего", `<b>${formatSize(disk.total)}</b>`)}
      </table>` : ""}
      <div class="modal-actions">
        ${v.state === "processing" ? "" : '<button class="big-btn process-go">Обработать</button>'}
        <span class="muted small note"></span>
        <button class="step-btn info-save">Сохранить</button>
      </div>`;
    body.querySelectorAll("textarea.grow").forEach(autoGrow);
    const deep = body.querySelector(".agent-deep");
    const search = body.querySelector(".agent-search");
    const sourcesBox = body.querySelector(".sources-box");
    // Режимы взаимоисключающие; в режиме "агент сам ищет" ссылки и глубокий
    // поиск не нужны — прячутся вместе (глубокий поиск лежит в sources-box).
    const syncModes = (changed) => {
      if (changed === deep && deep.checked) search.checked = false;
      if (changed === search && search.checked) deep.checked = false;
      sourcesBox.classList.toggle("collapsed", search.checked);
    };
    deep.addEventListener("change", () => syncModes(deep));
    search.addEventListener("change", () => syncModes(search));
    syncModes(null);
    const saveButton = body.querySelector(".info-save");
    watcher = formWatch(body.querySelector(".process-form"), [saveButton]);
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (title && group) await Api.saveProjectInfo(id, { title, group });
      const mode = deep.checked ? "deep" : search.checked ? "search" : "";
      await Api.saveSources(id, body.querySelector(".sources").value.split("\n"), mode, body.querySelector(".no-gaps").checked);
      watcher.snapshot();
    };
    saveButton.addEventListener("click", save);
    const go = body.querySelector(".process-go");
    if (go) go.addEventListener("click", async () => {
      await save();
      try {
        await Api.process(id);
        Modal.close();
      } catch (err) {
        body.querySelector(".note").textContent = err.message;
      }
    });
  },

  // -- добавить -----------------------------------------------------------------------
  async add() {
    const el = document.getElementById("view-add");
    el.innerHTML = `<h1>Добавить</h1>
      <h2>По ссылке</h2>
      <p class="muted small">YouTube и всё, что умеет yt-dlp. Видео скачается в качестве, заданном в «Настройках».</p>
      <div class="author-row"><input id="download-url" class="wide" placeholder="https://youtu.be/…"><button id="download-go" class="step-btn" disabled>Скачать</button></div>
      <h2>Свой файл</h2>
      <p class="muted small">Видео или аудио любого распространённого формата (mp4, mkv, webm, mov, mp3, m4a, wav, flac, ogg…).</p>
      <div class="author-row">
        <label class="step-btn file-pick">Выбрать файл<input id="file-input" type="file" accept="video/*,audio/*" hidden></label>
        <span id="file-chip" class="file-chip hidden"><span class="file-chip-name"></span><button class="file-chip-x" title="Убрать файл">×</button></span>
        <button id="file-go" class="step-btn" disabled>Добавить</button>
      </div>
      <div id="add-note" class="muted small"></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    const note = document.getElementById("add-note");
    const urlInput = document.getElementById("download-url");
    const fileInput = document.getElementById("file-input");
    // Кнопки активны, только когда есть что добавлять.
    urlInput.addEventListener("input", () => (document.getElementById("download-go").disabled = !urlInput.value.trim()));
    // Выбранный файл — плашкой с крестиком (убрать выбор).
    const chip = document.getElementById("file-chip");
    const showFile = () => {
      const file = fileInput.files[0];
      chip.classList.toggle("hidden", !file);
      chip.querySelector(".file-chip-name").textContent = file ? file.name : "";
      document.getElementById("file-go").disabled = !file;
    };
    fileInput.addEventListener("change", showFile);
    chip.querySelector(".file-chip-x").addEventListener("click", () => {
      fileInput.value = "";
      showFile();
    });
    const done = (id) => {
      note.innerHTML = `Добавлено: ${escapeHtml(id)}. Дальше – <a href="#/process">Обработка</a>.`;
    };
    const fail = (err) => {
      let message = err.message;
      try {
        message = JSON.parse(message).detail;
      } catch (_) {}
      note.textContent = `Не получилось: ${message}`;
    };
    document.getElementById("download-go").addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      try {
        done((await Api.download(url)).id);
      } catch (err) {
        fail(err);
      }
    });
    document.getElementById("file-go").addEventListener("click", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        done((await Api.importFile(file, (share) => (note.textContent = `Отправляю файл: ${Math.floor(share * 100)}%`))).id);
      } catch (err) {
        fail(err);
      }
    });
  },

  // -- настройки ------------------------------------------------------------------------
  async settings() {
    const el = document.getElementById("view-settings");
    const s = await Api.settings();
    el.innerHTML = `<h1>Настройки</h1>
      <table class="stats" id="settings-form">
        <tr><td>Колода Anki</td><td><input id="set-deck" class="wide" value="${escapeHtml(s.anki_deck_root)}">
          <div class="muted small">Карточки идут в &lt;колода&gt;::&lt;автор&gt;::&lt;видео&gt;; при смене уже созданные колоды всех видео переименовываются</div>
          <div id="deck-sync" class="small"></div></td></tr>
        <tr><td>Запас до и после отрезка</td><td><input id="set-padding" type="number" min="0" step="0.5" value="${s.context_padding_seconds}"> сек <div class="muted small">По умолчанию для всех видео; уже отредактированные фрагменты не меняются</div></td></tr>
        <tr><td>Качество скачивания</td><td><select id="set-quality">
          ${[[0, "лучшее доступное"], [2160, "4K (2160p)"], [1440, "2K (1440p)"], [1080, "Full HD (1080p)"], [720, "HD (720p)"]]
            .map(([h, name]) => `<option value="${h}" ${Number(s.download_max_height) === h ? "selected" : ""}>${name}</option>`).join("")}
          </select><div class="muted small">По умолчанию для видео, добавленных по ссылке; клипы для Anki режутся из скачанного</div></td></tr>
        <tr><td>После добавления</td><td><label class="check"><input id="set-auto" type="checkbox" ${s.auto_process ? "checked" : ""}> Сразу обрабатывать</label>
          <div class="muted small">Видео, добавленное по ссылке или файлом, сразу уходит в обработку (распознавание и нарезка)</div></td></tr>
        <tr><td>Ключ OpenRouter</td><td><div class="secret-row"><input id="set-key" class="wide" type="password" autocomplete="off" value="${escapeHtml(s.openrouter_key || "")}" placeholder="sk-or-…"><button id="set-key-eye" class="icon-btn" title="Показать / скрыть">👁</button></div><div class="muted small">Для агента перевода</div></td></tr>
        <tr><td>Модель перевода</td><td><div class="secret-row picker"><input id="set-model" class="wide" value="${escapeHtml(s.openrouter_model || "")}" placeholder="anthropic/claude-sonnet-5.5"><button id="set-model-pick" class="icon-btn" title="Выбрать из списка">▾</button>
          <div id="model-list" class="model-list hidden"></div></div>
          <div class="muted small">Можно вписать свою (идентификатор на OpenRouter) или выбрать из списка; цена – $ за миллион токенов (вход / выход)</div></td></tr>
        <tr><td>Модель поиска</td><td><div class="secret-row picker"><input id="set-search-model" class="wide" value="${escapeHtml(s.search_model || "")}" placeholder="anthropic/claude-sonnet-5.5"><button id="set-search-pick" class="icon-btn" title="Выбрать из списка">▾</button>
          <div id="search-model-list" class="model-list hidden"></div></div>
          <div class="muted small">Агент поиска источников текста для сверки (с веб-поиском OpenRouter); лучше брать сильную модель – запросов мало</div></td></tr>
      </table>
      <div class="actions"><button id="settings-save" class="step-btn">Сохранить</button><button id="settings-cancel" class="step-btn">Отменить</button></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    const showDeckSync = (state) => {
      const box = document.getElementById("deck-sync");
      if (!box || !state) return;
      const moved = (state.moved || []).map((m) => `${escapeHtml(m.to)} (${m.cards})`).join("; ");
      box.innerHTML = state.pending
        ? `<span class="flagged-text">${escapeHtml(state.message)} – жду подключения…</span>`
        : moved ? `<span class="muted">Переименовано: ${moved}</span>` : "";
    };
    const watchDeckSync = (state) => {
      showDeckSync(state);
      // Пока колоды ждут Anki – проверяем, не получилось ли уже.
      if (state && state.pending) this.refreshEvery(5000, async () => showDeckSync((await Api.settings()).deck_sync));
    };
    watchDeckSync(s.deck_sync);
    const saveButton = document.getElementById("settings-save");
    const cancelButton = document.getElementById("settings-cancel");
    const watcher = formWatch(document.getElementById("settings-form"), [saveButton, cancelButton]);
    document.getElementById("set-key-eye").addEventListener("click", () => {
      const input = document.getElementById("set-key");
      input.type = input.type === "password" ? "text" : "password";
    });
    // Выбор модели из списка OpenRouter (кнопка ▾ справа от поля).
    const modelPicker = (buttonId, listId, inputId) => {
      const list = document.getElementById(listId);
      document.getElementById(buttonId).addEventListener("click", async () => {
        if (!list.classList.contains("hidden")) {
          list.classList.add("hidden");
          return;
        }
        list.classList.remove("hidden");
        list.innerHTML = '<div class="muted small">Загрузка…</div>';
        try {
          const models = await Api.openrouterModels();
          list.innerHTML = models.map((m) =>
            `<div class="model-item" data-id="${escapeHtml(m.id)}"><span>${escapeHtml(m.id)}</span><span class="muted small">$${m.prompt} / $${m.completion}</span></div>`).join("");
          list.querySelectorAll(".model-item").forEach((item) => item.addEventListener("click", () => {
            const input = document.getElementById(inputId);
            input.value = item.dataset.id;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            list.classList.add("hidden");
          }));
        } catch (err) {
          list.innerHTML = `<div class="muted small">Не удалось загрузить список: ${escapeHtml(err.message)}</div>`;
        }
      });
    };
    modelPicker("set-model-pick", "model-list", "set-model");
    modelPicker("set-search-pick", "search-model-list", "set-search-model");
    cancelButton.addEventListener("click", () => watcher.restore());
    saveButton.addEventListener("click", async () => {
      const saved = await Api.saveSettings({
        anki_deck_root: document.getElementById("set-deck").value.trim(),
        context_padding_seconds: Number(document.getElementById("set-padding").value),
        download_max_height: Number(document.getElementById("set-quality").value),
        auto_process: document.getElementById("set-auto").checked,
        openrouter_key: document.getElementById("set-key").value.trim(),
        openrouter_model: document.getElementById("set-model").value.trim(),
        search_model: document.getElementById("set-search-model").value.trim(),
      });
      watcher.snapshot();
      watchDeckSync(saved.deck_sync);
    });
  },
};

// Блок "Сейчас идёт" внизу меню: фоновые процессы с процентом и временем до конца.
const Activity = {
  start() {
    this.render();
    setInterval(() => this.render(), 2500);
  },

  async render() {
    const box = document.getElementById("activity-list");
    let items;
    try {
      items = await Api.activity();
    } catch (_) {
      return;
    }
    // Нет фоновых процессов — блок фоновых процессов (с разделителем) не показывается.
    box.closest(".activity").classList.toggle("hidden", !items.length);
    if (!items.length) {
      box.textContent = "";
      return;
    }
    // Полоса – тот же отрезок, что и в библиотеке: доезжает до нового значения плавно.
    const snap = barSnapshot(box);
    box.innerHTML = items.map((a) => {
      const has = a.percent !== null && a.percent !== undefined;
      // Перевод – розовым (как полоса "Переведено"), обработка – синим, Anki – зелёным.
      const cls = a.kind === "translate" ? "translated" : a.kind === "phase1" ? "accepted" : "ok";
      const bar = has ? `<div class="progress thin" data-bar="p"><div class="seg ${cls}" data-w="${a.percent}" style="width:${a.percent}%"></div></div>` : "";
      return `<div class="activity-item" data-key="${escapeHtml(`${a.kind}:${a.id}`)}"><div class="activity-name">${escapeHtml(a.title)}</div>` +
        `<div>${escapeHtml(cap(a.label))}${has ? ` (${Math.floor(a.percent)}%)` : ""}</div>${bar}</div>`;
    }).join("");
    animateBars(box, snap);
  },
};
