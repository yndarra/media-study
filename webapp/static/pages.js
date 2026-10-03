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
      const closed = !document.body.classList.contains(`${side}-closed`);
      try {
        localStorage.setItem(`panel-${side}`, closed ? "closed" : "open");
      } catch (_) {}
      PanelMotion.toggle(side, closed);
    });
  },
};

// Горячие клавиши редактора – список в настройках (сами клавиши – в app.js, HOTKEYS и обработчики).
const HOTKEY_HELP = [
  ["Пробел", "Воспроизведение / пауза"],
  ["W", "Повтор с начала отрезка"],
  ["Shift+Пробел / Ctrl+Пробел", "Повтор с жёлтой метки"],
  ["Shift (зажать)", "Скорость 2×, пока держишь"],
  ["A / D", "Предыдущий / следующий фрагмент (в рамках фильтра списка)"],
  ["← / → / Shift+A / Shift+D", "Кадр назад / вперёд (или выделенная граница)"],
  ["Q / E", "Начало отрезка – к концу предыдущего / конец – к началу следующего"],
  ["Shift+Q / Shift+E / Shift+W", "Выделить начало / конец отрезка / текущий кадр"],
  ["S", "Пометить на удаление (ещё раз – снять)"],
  ["R", "Говорящий – Rover (ещё раз – как было)"],
  ["Ctrl", "Войти в текст (каретка в конец) / выйти из текста"],
  ["Esc", "Выйти из текста"],
  ["Alt+R", "В тексте: «Rover» в место каретки или вместо выделенного (ещё раз – убрать)"],
  ["Alt+F / F", "Буфер имён (F – вне поля текста): цифра 1–7 или S/W и F – выбрать; в тексте затем 1 – говорящим в начало, 2 – в место каретки"],
  ["Backspace", "В начале пустой первой строки – убрать эту строку"],
  ["Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z", "Отменить / вернуть"],
  ["Правая кнопка по видео", "Приблизить область (ещё раз – обратно)"],
];

// Что будет при отмене обработки на каждом шаге (готовое не переделывается).
const PROCESS_CANCEL_EFFECT = {
  download: "Скачанная часть видео <b>сохранится</b>; при следующем запуске скачивание продолжится с места остановки.",
  proxy: "Скачанное видео <b>сохранится</b>. Копия для редактора не готова – при следующем запуске она начнётся <b>заново</b>.",
  transcribe: "Видео и копия для редактора <b>сохранятся</b>. Распознавание речи не готово – при следующем запуске начнётся <b>заново</b> (это самый долгий шаг).",
  agent_search: "Видео, копия и распознанная речь <b>сохранятся</b>. Поиск текста для сверки начнётся <b>заново</b> (агент – снова платный запрос).",
  search: "Видео, копия и распознанная речь <b>сохранятся</b>. Сверка с текстом начнётся <b>заново</b>.",
  ai_fix: "Видео, копия, распознанная речь и текст для сверки <b>сохранятся</b>. Нарезка и ИИ-доводка текста на слух начнутся <b>заново</b> (доводка – снова платный запрос, недорогой).",
  segment: "Видео, копия, распознанная речь и текст для сверки <b>сохранятся</b>. Нарезка на фразы начнётся <b>заново</b> (это быстро).",
  assets: "Всё <b>сохранится</b>, кроме звуковой дорожки для редактора – её построение начнётся <b>заново</b> (это быстро).",
  default: "Готовые шаги <b>сохранятся</b>, незаконченный начнётся <b>заново</b> при следующем запуске.",
};

// Вопрос о несохранённых изменениях – поверх всего (и окон, и страниц).
// Возвращает "save", "drop" ("Нет") или null (клик мимо / Esc – остаться).
function askSave() {
  return askConfirm({ title: "Несохранённые изменения", text: "Сохранить их?", yes: "Сохранить", no: "Нет", yesValue: "save", noValue: "drop" });
}

// Вопрос с подтверждением (поверх всего). yes – синяя кнопка (или красная,
// danger: true), no – вторая; клик мимо / Esc – null.
function askConfirm({ title, text, yes, no, yesValue = "yes", noValue = "no", danger = false, icon = null }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    const pen = '<svg viewBox="0 0 20 20"><path d="M4 14.5V16h1.5l8.6-8.6-1.5-1.5L4 14.5z"/><path d="M13.6 4.9l1.5 1.5 1.2-1.2a1 1 0 0 0 0-1.4l-.1-.1a1 1 0 0 0-1.4 0l-1.2 1.2z"/></svg>';
    overlay.innerHTML = `<div class="ask${danger ? " danger" : ""}" role="dialog">
        <div class="ask-icon">${icon || pen}</div>
        <div class="ask-title">${escapeHtml(title)}</div>
        <div class="ask-text">${text}</div>
        <div class="ask-actions">${no ? `<button class="step-btn${danger ? "" : " danger"}" data-a="${noValue}">${escapeHtml(no)}</button>` : ""}` +
        `<button class="step-btn ${danger ? "danger" : "primary"}" data-a="${yesValue}">${escapeHtml(yes)}</button></div>
      </div>`;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 150);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) return finish(null);
      const action = e.target.closest("[data-a]");
      if (action) finish(action.dataset.a);
    });
    document.body.appendChild(overlay);
    overlay.querySelector(`[data-a="${yesValue}"]`).focus();
  });
}

// Окошко "Хранилище" (кнопка в окне видео): где лежит видео и куда его можно
// перенести (подключённые хранилища из настроек). Возвращает путь выбранного
// хранилища или null (закрыли / переносить некуда).
function askStorage(info) {
  return new Promise((resolve) => {
    const here = info.here;
    const targets = info.targets || [];
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    const disk = '<svg viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" rx="2"/><path d="M6 12h3"/><circle cx="14" cy="12" r="0.6"/></svg>';
    const option = (t, k) => `<button class="storage-option" data-k="${k}"><span class="so-name">${escapeHtml(t.label)}</span>` +
      `<span class="so-path">${escapeHtml(t.path)}</span><span class="so-free">Свободно ${formatSize(t.free)}</span></button>`;
    overlay.innerHTML = `<div class="ask storage-ask" role="dialog">
        <div class="ask-icon">${disk}</div>
        <div class="ask-title">Хранилище</div>
        <div class="ask-text"><b>${escapeHtml(here.label)}</b>${here.main ? " (основное)" : ""}
          <div class="muted small">${escapeHtml(here.path)}</div></div>
        ${targets.length ? `<div class="storage-options">${targets.map(option).join("")}</div>`
          : '<div class="ask-text muted small">Других хранилищ нет – добавьте папку на другом диске в «Настройках».</div>'}
        <div class="ask-actions"><button class="step-btn" data-a="close">Закрыть</button>` +
        `${targets.length ? '<button class="step-btn primary" data-a="move" disabled>Перенести</button>' : ""}</div>
      </div>`;
    let chosen = null;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 150);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) return finish(null);
      const opt = e.target.closest(".storage-option");
      if (opt) {
        chosen = targets[Number(opt.dataset.k)];
        overlay.querySelectorAll(".storage-option").forEach((o) => o.classList.toggle("chosen", o === opt));
        overlay.querySelector('[data-a="move"]').disabled = false;
        return;
      }
      const action = e.target.closest("[data-a]");
      if (!action) return;
      finish(action.dataset.a === "move" && chosen ? chosen.path : null);
    });
    document.body.appendChild(overlay);
  });
}

// Режим приложения: видео или аудио (переключатель под названием в меню).
// От него зависят разделы "Медиа" (название и значок тоже), "Обработка",
// "Добавить" и "Статистика"; "Настройки" общие. Запоминается в браузере.
const Mode = {
  ICONS: {
    video: '<svg class="menu-icon" viewBox="0 0 20 20"><rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M8.5 7.5l4 2.5-4 2.5z"/></svg>',
    audio: '<svg class="menu-icon" viewBox="0 0 20 20"><path d="M8 14.5V4.5l8-1.5v10"/><circle cx="5.8" cy="14.5" r="2.2"/><circle cx="13.8" cy="13" r="2.2"/></svg>',
  },
  kind: (() => {
    try {
      return localStorage.getItem("media-mode") === "audio" ? "audio" : "video";
    } catch (_) {
      return "video";
    }
  })(),
  counts: null,

  init() {
    document.querySelectorAll("#mode-switch button").forEach((b) => b.addEventListener("click", () => this.set(b.dataset.k)));
    this.paint();
    this.refreshCounts();
    setInterval(() => this.refreshCounts(), 5000);
  },

  // Переключить режим; открытый раздел (кроме настроек и редактора) – заново.
  set(kind, reroute = true) {
    if (kind !== "video" && kind !== "audio") return;
    const changed = kind !== this.kind;
    this.kind = kind;
    try {
      localStorage.setItem("media-mode", kind);
    } catch (_) {}
    this.paint();
    if (changed && reroute && ["videos", "process", "add", "stats"].includes(State.view)) {
      if (State.view === "videos") location.hash = "#/media";
      Router.route(true);
    }
  },

  paint() {
    const audio = this.kind === "audio";
    const sw = document.getElementById("mode-switch");
    sw.classList.toggle("audio", audio);
    sw.classList.toggle("video", !audio);
    sw.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.k === this.kind));
    const link = document.getElementById("menu-media");
    link.querySelector(".menu-icon-host").innerHTML = this.ICONS[this.kind];
    link.querySelector(".menu-label").textContent = audio ? "Аудио" : "Видео";
    this.paintCounts();
  },

  async refreshCounts() {
    try {
      this.counts = await Api.counts();
    } catch (_) {
      return;
    }
    this.paintCounts();
  },

  paintCounts() {
    const c = this.counts && this.counts[this.kind];
    document.getElementById("count-media").textContent = c && c.ready ? c.ready : "";
    document.getElementById("count-process").textContent = c && c.pending ? c.pending : "";
  },
};

// Ссылка "сейчас правится" в меню: автор (мелко) и под ним название.
function setEditingLink() {
  const link = document.getElementById("menu-editing-link");
  if (!link) return;
  const v = State.manifest && State.manifest.video;
  link.innerHTML = (v && v.group ? `<span class="editing-group">${escapeHtml(v.group)}</span>` : "") +
    `<span class="editing-title">${escapeHtml((v && v.title) || State.project || "")}</span>`;
}

const Router = {
  start() {
    Panels.init();
    Mode.init();
    Activity.start();
    window.addEventListener("hashchange", () => this.route());
    // Нажали на раздел, который уже открыт, – он показывается заново, с той же
    // анимацией появления, что при переходе из другого раздела (несохранённые
    // настройки не трогаем).
    document.querySelectorAll("#menu a[data-menu]").forEach((link) => link.addEventListener("click", () => {
      if (location.hash !== link.getAttribute("href")) return;
      if (State.view === "settings" && Pages.settingsGuard && Pages.settingsGuard.isDirty()) return;
      this.route(true);
    }));
    this.route();
  },

  async route(full = false) {
    const parts = (location.hash.replace(/^#\/?/, "") || "videos").split("/");
    const [page, id] = [parts[0], decodeURIComponent(parts[1] || "")];
    // Уходим из настроек, а там несохранённое – спросить; "остаться" – вернуть адрес.
    if (State.view === "settings" && page !== "settings" && Pages.settingsGuard && Pages.settingsGuard.isDirty()) {
      const target = location.hash;
      history.replaceState(null, "", "#/settings");
      const answer = await askSave();
      if (!answer) return;
      if (answer === "save") await Pages.settingsGuard.save();
      else Pages.settingsGuard.restore();
      Pages.settingsGuard = null;
      location.hash = target;
      return;
    }
    // Открыть / закрыть окно поверх уже показанного списка – список не
    // перерисовывается заново (иначе страница на миг пустеет) и продолжает обновляться.
    const listShown = (view, box) => !full && State.view === view && document.querySelector(`#${box} a.card`);
    // Библиотека: "Видео" (#/videos, #/video/<код>) и "Аудио" (#/audio, #/audio/<код>) –
    // одна страница с разным списком.
    // Адрес видео или аудио переключает режим (ссылка на конкретное медиа).
    if (page === "audio" || page === "video" || page === "videos") Mode.set(page === "audio" ? "audio" : "video", false);
    const lib = page === "media" || page === "audio" || page === "video" || page === "videos" ? Mode.kind : null;
    const libModal = !!(lib && id && (page === "audio" || page === "video"));
    if (lib && listShown("videos", "videos-list") && Pages.libraryKind === lib) {
      if (libModal) Pages.videoModal(id);
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
    if (!(libModal || (page === "process" && id))) Modal.close(false);
    if (page === "edit" && id) {
      // Видео переносится на другой диск (или править нечего, пока идёт
      // передача в Anki / перевод) – в редактор не пускаем.
      let lock = { locked: false };
      try {
        lock = await Api.editState(id);
      } catch (_) {}
      if (lock.locked) {
        history.replaceState(null, "", "#/media");
        askConfirm({ title: "Редактировать нельзя", text: escapeHtml(lock.reason), yes: "Понятно", no: null });
        if (State.view !== "videos") this.route(true);
        return;
      }
      this.show("editor", null); // в редакторе ни один раздел меню не выделен
      await App.openProject(id);
      FragList.reset();
      this.show("editor", null); // обновить ссылку «сейчас правится» уже с названием видео
      return;
    }
    Player.pauseIfPlaying();
    if (lib) {
      // Подробности – окно поверх списка своего раздела (видео или аудио).
      if (!(libModal && document.getElementById("modal-overlay") && Pages.libraryKind === lib)) {
        this.show("videos", "media");
        await Pages.videos(lib);
      }
      if (libModal) Pages.videoModal(id);
    } else if (page === "process") {
      if (!(id && document.getElementById("modal-overlay"))) {
        this.show("process", "process");
        await Pages.process();
      }
      if (id) Pages.processModal(id);
    } else if (page === "add" || page === "download") {
      this.show("add", "add");
      Pages.add();
    } else if (page === "stats") {
      this.show("stats", "stats");
      Pages.stats();
    } else if (page === "settings") {
      this.show("settings", "settings");
      Pages.settings();
    } else {
      this.show("videos", "media");
      Pages.videos(Mode.kind);
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
        "frag-bg-translated", "frag-bg-returned", "frag-unvoiced", "frag-edit-accepted", "frag-edit-changed",
        "frag-edit-unvoiced");
    }
    // Ссылка "сейчас правится" в меню – чтобы вернуться в редактор одним кликом.
    const editing = document.getElementById("menu-editing");
    editing.classList.toggle("hidden", !State.project);
    if (State.project) {
      const link = document.getElementById("menu-editing-link");
      link.href = `#/edit/${encodeURIComponent(State.project)}`;
      setEditingLink();
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

// Подсветка карточки в "Обработке", пока видео обрабатывается: скачивание
// (рыжая полоса) – красноватая, шаг с синей полосой – синяя, самое начало
// (полосы ещё нет) – зеленоватая, остальные шаги – желтоватая.
function procState(v) {
  // Подсветка – только у того, что сейчас обрабатывается, и только синеватая.
  return v.state === "processing" ? " proc-blue" : "";
}

// Оформление карточки видео по этапу (фон-градиент и обводка):
//   фиолетовое – есть хоть один фрагмент, вернувшийся из Anki (с флагом), на
//   любом этапе; розовое – переведено всё (100%); зелёное – всё в Anki, идёт
//   или осталось перевод; синее – всё отредактировано, передаётся или ждёт
//   передачи в Anki; иначе (идёт правка) – обычное серое.
function cardState(v) {
  if ((v.flagged || 0) + (v.flag_interval || 0) > 0) return " has-returned";
  if (v.complete) return " complete";
  if (v.ready_to_translate) return " to-translate"; // перевод части видео карточку не красит
  if (v.ready_to_send) return " to-send"; // передача части видео карточку не красит
  if (v.awaiting && (v.reviewed || 0) > 0) return " started";
  return "";
}

// Кнопка следующего шага на карточке: зелёная "Передать в Anki" или розовая
// "Перевести". Пока шаг идёт – кнопка остаётся, текст другой, полосы зебры
// другие; шаг закончился – кнопка уходит, возвращается строка "Место на диске".
//
// Зебра рисуется на canvas (Zebra): ширина полос и скорость плавно
// подтягиваются к целевым при смене вида ("Перевести" ↔ "Выполняется
// перевод…": полосы плавно сужаются и ускоряются, обратно – расширяются и
// замедляются). Состояние – по видео, поэтому перерисовка списка (каждые 3 с)
// не сбрасывает ни фазу, ни ширину.
const Zebra = {
  // stripe – ширина цветной полосы (= промежутка), px; speed – px/с.
  PARAMS: {
    send: { stripe: 26, speed: 32.5, color: "#1f6b3b" },
    sendBusy: { stripe: 15, speed: 73.125, color: "#1f6b3b" }, // как translateBusy
    // В окне видео: "Передать в Anki", когда отредактировано всё, и "Перевести",
    // когда всё в Anki, – как "Редактировать" (чуть быстрее карточных), свой цвет.
    sendReady: { stripe: 161.5, speed: 48.75, color: "#1f6b3b" },
    translateReady: { stripe: 161.5, speed: 48.75, color: "#a3407a" },
    // Перенос на другой диск – быстрая светло-серая.
    moveBusy: { stripe: 15, speed: 73.125, color: "#5c5c69" },
    translate: { stripe: 323, speed: 32.5, color: "#a3407a" },
    translateBusy: { stripe: 15, speed: 73.125, color: "#a3407a" },
    // "Править" (есть что править) и "Обработать" – синяя; только вернувшиеся
    // из Anki – фиолетовая.
    // "Править" и "Обработать": вдвое уже "Перевести" и в 1.5 раза быстрее.
    edit: { stripe: 161.5, speed: 48.75, color: "#2f5f9e" },
    editReturned: { stripe: 161.5, speed: 48.75, color: "#8957e5" },
    process: { stripe: 161.5, speed: 48.75, color: "#2f5f9e" },
  },
  SLANT: 0.406, // как у "/": по горизонтали на 1 по вертикали
  EASE_SECONDS: 1.1, // за сколько примерно доходит до новой ширины/скорости
  state: new Map(), // видео + вид кнопки -> {stripe, speed, cycles, last}
  running: false,

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame((t) => this.frame(t));
  },

  frame(now) {
    const buttons = document.querySelectorAll(".card-action, [data-zebra]");
    if (!buttons.length) {
      this.running = false;
      return;
    }
    for (const button of buttons) {
      // Вид полос: кнопки шага на карточках – по классам; остальные – data-zebra.
      const type = button.dataset.zebra ||
        (button.classList.contains("translate") ? "translate" : button.classList.contains("move") ? "move" : "send");
      const target = this.PARAMS[button.dataset.zebra || type + (button.classList.contains("busy") ? "Busy" : "")];
      if (!target) continue;
      // Ключ – без Busy/Ready: смена вида кнопки плавно меняет ширину и скорость полос.
      const key = `${button.dataset.id || button.id}:${type.replace(/Busy|Ready/, "")}`;
      let st = this.state.get(key);
      if (!st) {
        st = { stripe: target.stripe, speed: target.speed, cycles: 0, last: now };
        this.state.set(key, st);
      }
      const dt = Math.min(0.1, Math.max(0, (now - st.last) / 1000));
      st.last = now;
      // Ширина – плавно в логарифме (от 323 до 15 – в 20 раз), скорость – линейно.
      const k = 1 - Math.exp(-dt / (this.EASE_SECONDS / 3));
      st.stripe = Math.exp(Math.log(st.stripe) + (Math.log(target.stripe) - Math.log(st.stripe)) * k);
      st.speed += (target.speed - st.speed) * k;
      // Фаза – в долях шага: при смене ширины полосы растягиваются, а не прыгают.
      st.cycles = (st.cycles + (st.speed * dt) / (2 * st.stripe)) % 1;
      this.draw(button, st, target.color);
      // Текст "… ↔ Отмена" печатается и стирается (занятые кнопки на карточках).
      const typed = button.querySelector("span[data-type]");
      if (typed) typed.textContent = Typer.text(key, typed.dataset.type, now);
    }
    Typer.forget(now);
    requestAnimationFrame((t) => this.frame(t));
  },

  draw(button, st, color) {
    const canvas = button.querySelector("canvas.zebra");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    // Точный (дробный) размер холста: иначе картинка чуть растягивается по
    // ширине, и полосы у кнопок разной ширины выглядят по-разному.
    const box = canvas.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    const period = 2 * st.stripe;
    const slant = this.SLANT * h;
    const offset = st.cycles * period;
    for (let x = offset - period - slant; x < w + period; x += period) {
      ctx.beginPath();
      ctx.moveTo(x + slant, 0);
      ctx.lineTo(x + slant + st.stripe, 0);
      ctx.lineTo(x + st.stripe, h);
      ctx.lineTo(x, h);
      ctx.closePath();
      ctx.fill();
    }
  },
};

// Текст занятой кнопки на карточке ("Передаётся в Anki…", "Выполняется
// перевод…", "Перемещение…"): эти кнопки ещё и отменяют действие, и чтобы это
// было понятно, текст по кругу посимвольно стирается (как Backspace),
// печатается "Отмена", держится, стирается, и снова печатается основной.
// Появилась кнопка – основной текст сначала печатается. Время – от первого
// показа кнопки, поэтому перерисовка списка (каждые 3 с) текст не сбрасывает.
const Typer = {
  CANCEL: "Отмена",
  TYPE_MS: 55, // на символ при печати
  ERASE_MS: 32, // на символ при стирании
  HOLD_MAIN_MS: 3200,
  HOLD_CANCEL_MS: 1500,
  starts: new Map(), // ключ кнопки -> {t0, seen}

  text(key, main, now) {
    let st = this.starts.get(key);
    if (!st) {
      st = { t0: now, seen: now };
      this.starts.set(key, st);
    }
    st.seen = now;
    const c = this.CANCEL;
    const typeIn = (s, t) => s.slice(0, Math.min(s.length, Math.floor(t / this.TYPE_MS) + 1));
    const eraseOut = (s, t) => s.slice(0, Math.max(0, s.length - Math.floor(t / this.ERASE_MS) - 1));
    let t = now - st.t0;
    if (t < main.length * this.TYPE_MS) return typeIn(main, t);
    t -= main.length * this.TYPE_MS;
    // Круг: держим основной -> стираем -> печатаем "Отмена" -> держим -> стираем -> печатаем основной.
    const parts = [
      [this.HOLD_MAIN_MS, () => main],
      [main.length * this.ERASE_MS, (x) => eraseOut(main, x)],
      [c.length * this.TYPE_MS, (x) => typeIn(c, x)],
      [this.HOLD_CANCEL_MS, () => c],
      [c.length * this.ERASE_MS, (x) => eraseOut(c, x)],
      [main.length * this.TYPE_MS, (x) => typeIn(main, x)],
    ];
    t %= parts.reduce((sum, [d]) => sum + d, 0);
    for (const [d, f] of parts) {
      if (t < d) return f(t) || "\u00a0"; // пустая строка не схлопывает кнопку
      t -= d;
    }
    return main;
  },

  // Кнопка пропала (дольше секунды не рисовалась) – при новом появлении текст снова печатается.
  forget(now) {
    for (const [key, st] of this.starts) if (now - st.seen > 1000) this.starts.delete(key);
  },
};

function cardAction(v) {
  const pressed = Pages.pressedActions.get(v.id);
  const just = pressed && Date.now() - pressed.at < 8000 ? pressed.action : null; // нажали, сервер ещё не успел
  const id = escapeHtml(v.id);
  // Идущие действия – нажатие отменяет (текст сам подсказывает: "… ↔ Отмена").
  if (v.moving || just === "move") {
    return `<button class="card-action move busy" data-action="cancel-move" data-id="${id}" title="Отменить перенос"><canvas class="zebra"></canvas><span data-type="Перемещение…"></span></button>`;
  }
  if (v.sending || just === "send") {
    return `<button class="card-action send busy" data-action="cancel-send" data-id="${id}" title="Отменить передачу в Anki"><canvas class="zebra"></canvas><span data-type="Передаётся в Anki…"></span></button>`;
  }
  if (v.translating || just === "translate") {
    return `<button class="card-action translate busy" data-action="stop" data-id="${id}" title="Отменить перевод"><canvas class="zebra"></canvas><span data-type="Выполняется перевод…"></span></button>`;
  }
  if (v.ready_to_send) {
    return `<button class="card-action send" data-action="send" data-id="${id}"><canvas class="zebra"></canvas><span>Передать в Anki</span></button>`;
  }
  if (v.ready_to_translate) {
    return `<button class="card-action translate" data-action="translate" data-id="${id}"><canvas class="zebra"></canvas><span>Перевести</span></button>`;
  }
  return "";
}

// Полоса из цветных отрезков: segments = [{n, cls}] – слева направо; последний
// отрезок с right: true прижимается к правому краю (между ними – серое).
// name – подпись слева, done / total – справа. Стыки цветов – под наклоном
// (классы sl / sr: скошенный левый / правый край, см. styles.css).
// Ширины и число плавно анимируются – см. animateBars.
function segmentBar(segments, total, name, done, rightText = "") {
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
  return `<div class="progress segmented" data-bar="${done === null ? "progress" : escapeHtml(name)}" title="${escapeHtml(done === null ? name : `${name} ${done} / ${total}`)}">` +
    `<div class="seg-left">${left.map((s, k) => html(s, k, left, "left")).join("")}</div>` +
    `<div class="seg-right">${right.map((s, k) => html(s, k, right, "right")).join("")}</div>` +
    `<span class="progress-label"><span>${escapeHtml(name)}</span>` +
    (done === null ? (rightText ? `<span class="progress-count">${escapeHtml(rightText)}</span>` : "")
      : `<span class="progress-count" data-done="${done}" data-total="${total || 0}">${done} / ${total || 0}</span>`) +
    "</span></div>";
}

// Ширина отрезка: со скосом слева он заходит на 6 px под предыдущий.
function segWidth(w, slanted) {
  return slanted && w > 0 ? `calc(${w}% + var(--slant))` : `${w}%`;
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
function viewEnter(el, items = null) {
  (items || [...el.children]).forEach((child, i) => {
    child.style.setProperty("--i", i);
    child.classList.add("enter");
    child.addEventListener("animationend", () => child.classList.remove("enter"), { once: true });
  });
}

// Карточку только что сохранённого видео коротко подсветить (окно закрылось).
function flashCard(box) {
  if (!Pages.flashId) return;
  const card = [...box.querySelectorAll("a.card")].find((a) => a.getAttribute("href").endsWith(`/${encodeURIComponent(Pages.flashId)}`));
  Pages.flashId = null;
  if (card) card.animate([
    { boxShadow: "0 0 0 2px rgba(121, 184, 255, 0.75)", transform: "scale(1.015)" },
    { boxShadow: "0 0 0 2px rgba(121, 184, 255, 0)", transform: "none" },
  ], { duration: 700, easing: "ease-out" });
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
  const edited = e.accepted + (e.unvoiced || 0) + e.changed + e.deleted;
  const total = v.bar_total || v.fragments_total;
  return segmentBar([
    { n: e.accepted, cls: "accepted", title: `Приняты без правок: ${e.accepted}` },
    // Не озвученные – вместе с изменёнными (жёлтым).
    { n: e.changed + (e.unvoiced || 0), cls: "changed", title: `Изменены: ${e.changed + (e.unvoiced || 0)}` },
    { n: e.deleted, cls: "deleted", title: `удалены: ${e.deleted}` },
  ], total, "Отредактировано", edited) +
  (() => {
    // Только то, что уже стало карточкой (очередь не показывается – полоса
    // растёт по мере создания карточек).
    const inAnki = v.in_anki ?? v.exported;
    return segmentBar([
      { n: inAnki - (v.flag_interval || 0), cls: "ok", title: `В Anki: ${inAnki}` },
      { n: v.flag_interval || 0, cls: "returned", right: true, title: `Флаг «обрезка/текст» в Anki: ${v.flag_interval || 0}` },
    ], v.active_total, "Передано в Anki", inAnki);
  })() +
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

// Значения таблиц, которые не влезли в одну строку (длинная колода Anki и
// т.п.), – тоже сворачиваются: видна одна строка с многоточием и стрелка ▾.
// Вызывается, когда окно уже на экране (нужны настоящие размеры).
function foldLongRows(root) {
  root.querySelectorAll("table.stats tr:not(.multi) > td:last-child").forEach((td) => {
    const line = parseFloat(getComputedStyle(td).lineHeight) || 20;
    if (td.querySelector(".one-line") || td.clientHeight - 8 < line * 1.5) return;
    td.innerHTML = `<div class="multi-first one-line"><span class="one-line-text">${td.innerHTML}</span>` +
      '<button class="multi-toggle" title="Показать целиком">▾</button></div>';
    td.parentElement.classList.add("multi");
  });
}

// Раскрыть / свернуть многострочное значение (плавно, по высоте содержимого).
document.addEventListener("click", (e) => {
  const button = e.target.closest(".multi-toggle");
  if (!button) return;
  const single = button.closest(".one-line");
  if (single) {
    // Свёрнутая в одну строку: плавно до полной высоты и обратно.
    const text = single.querySelector(".one-line-text");
    const from = text.offsetHeight;
    const open = single.classList.toggle("open");
    button.classList.toggle("open", open);
    const to = text.offsetHeight;
    text.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 250, easing: "ease" });
    return;
  }
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
// ждут перевода, Anki закрыт.
function videoNotes(v, withDisk = true) {
  const q = v.stage3 || {};
  const queue = q.state === "waiting_anki" ? "Ждёт Anki" : "";
  const parts = [
    withDisk && v.disk_total !== undefined ? `Место на диске: ${formatSize(v.disk_total)}` : "",
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

// Поле в одну строку на вид многострочного (автор): Enter не переносит строку.
function singleLine(el) {
  if (el) el.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
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
    overlay.innerHTML = `<div class="modal"><div class="modal-body">${html}</div></div>`;
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.requestClose();
    });
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
    if (this.asking) return; // вопрос уже задан
    if (!this.guard || !this.guard.isDirty()) {
      this.close();
      return;
    }
    // "Нет" – закрыть без сохранения; клик мимо вопроса – отмена (окно остаётся).
    this.asking = true;
    askSave().then(async (answer) => {
      this.asking = false;
      if (!answer) return;
      if (answer === "save") await this.guard.save();
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
// Полоса хода обработки – как полосы в "Видео" (наклонный край, плавный рост),
// без чисел: скачивание – рыжая, остальные шаги – синие.
function processingBar(v) {
  if (v.percent === null || v.percent === undefined) {
    return `<div class="card-status">${escapeHtml(cap(v.status || "Обрабатывается"))}…</div>`;
  }
  const cls = v.step === "download" ? "downloading" : "accepted";
  return segmentBar([{ n: v.percent, cls, title: `${Math.floor(v.percent)}%` }], 100, cap(v.status), null, `${Math.floor(v.percent)}%`);
}

// Скорость правки (результаты таймера в редакторе): итоги, лучшая/средняя/
// медиана, последняя против средней, прогноз оставшейся правки, график по
// результатам и разбивка по видео. remaining – сколько фрагментов ещё не
// отредактировано во всех видео.
const speedOf = (r) => (r.ms ? r.frags / (r.ms / 60000) : 0); // фрагментов в минуту
const formatMinutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};
const shortDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

// Горизонтальные столбцы для статистики: строки {label, href, segs:[{value,
// cls, title}], text} – длина по сумме сегментов (самая длинная – во всю
// ширину), справа – подпись значения.
function hbars(items, legend = "") {
  const total = (i) => i.segs.reduce((acc, x) => acc + (x.value || 0), 0);
  const max = Math.max(0, ...items.map(total)) || 1;
  return `<div class="hbars">${legend ? `<div class="hbar-legend">${legend}</div>` : ""}${items.map((i) => {
    const label = i.href ? `<a href="${i.href}">${escapeHtml(i.label)}</a>` : escapeHtml(i.label);
    return `<div class="hbar-row"><div class="hbar-label" title="${escapeHtml(i.label)}">${label}</div><div class="hbar-track">` +
      i.segs.map((x) => `<div class="hbar-seg ${x.cls || ""}" style="width:${((x.value || 0) / max * 100).toFixed(2)}%" title="${escapeHtml(x.title || "")}"></div>`).join("") +
      `</div><div class="hbar-value">${i.text}</div></div>`;
  }).join("") || '<p class="muted small">Нет данных</p>'}</div>`;
}

const legendItem = (cls, text) => `<span class="hbar-key"><i class="hbar-seg ${cls}"></i>${text}</span>`;

// Название результата таймера: видео или пометка для замеров без видео.
const resultTitle = (r) => r.title || "Без видео (замер из чата)";

// График скорости правки: линия по результатам (по порядку сохранения) с
// заливкой, точки (лучшая – зелёная), средняя – пунктиром, сетка с подписями.
// Рисуется по настоящей ширине блока (точки не растягиваются).
function drawSpeedChart(box, list, avg) {
  const W = Math.max(320, box.clientWidth);
  const H = 230;
  const pad = { l: 44, r: 16, t: 16, b: 30 };
  const speeds = list.map(speedOf);
  const max = Math.max(...speeds, avg) * 1.18 || 1;
  const x = (k) => pad.l + (list.length === 1 ? (W - pad.l - pad.r) / 2 : (k / (list.length - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const pts = speeds.map((v, k) => [x(k), y(v)]);
  // Плавная линия (Catmull-Rom -> кривые Безье).
  let line = `M${pts[0][0]},${pts[0][1]}`;
  for (let k = 1; k < pts.length; k++) {
    const p0 = pts[k - 2] || pts[k - 1];
    const p1 = pts[k - 1];
    const p2 = pts[k];
    const p3 = pts[k + 1] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    line += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  const area = `${line} L${pts[pts.length - 1][0]},${H - pad.b} L${pts[0][0]},${H - pad.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max / 1.18 * t);
  const grid = ticks.map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>` +
    `<text class="axis" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`).join("");
  const best = speeds.indexOf(Math.max(...speeds));
  // Без точек (так чище): подсказка о результате – при наведении на его полосу графика.
  const half = list.length > 1 ? (W - pad.l - pad.r) / (list.length - 1) / 2 : (W - pad.l - pad.r) / 2;
  const dots = list.map((r, k) => `<rect class="hover-band" x="${pts[k][0] - half}" y="${pad.t}" width="${half * 2}" height="${H - pad.t - pad.b}">` +
    `<title>${escapeHtml(shortDate(r.saved_at))} · ${escapeHtml(resultTitle(r))}\n${speedOf(r).toFixed(2)}/мин – ${r.frags} фрагм. за ${formatMinutes(r.ms)}${k === best ? " (лучший)" : ""}</title></rect>`).join("");
  const labels = list.length > 1
    ? `<text class="axis" x="${x(0)}" y="${H - 8}">${escapeHtml(shortDate(list[0].saved_at))}</text>` +
      `<text class="axis" x="${x(list.length - 1)}" y="${H - 8}" text-anchor="end">${escapeHtml(shortDate(list[list.length - 1].saved_at))}</text>`
    : "";
  box.innerHTML = `<svg class="speed-line" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="speed-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#79b8ff" stop-opacity="0.35"/><stop offset="1" stop-color="#79b8ff" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="area" d="${area}"/><path class="line" d="${line}"/>
    <line class="avg" x1="${pad.l}" x2="${W - pad.r}" y1="${y(avg)}" y2="${y(avg)}"/>
    <text class="avg-label" x="${W - pad.r}" y="${y(avg) - 6}" text-anchor="end">средняя ${avg.toFixed(2)}/мин</text>
    ${dots}${labels}</svg>`;
}

// Вкладка "Скорость правки": итоги, график, разбивка по видео.
function speedTab(results, remaining) {
  if (!results || !results.length) {
    return '<p class="muted small">Результатов пока нет – запустите таймер над видео в редакторе и сохраните результат (иконка рядом со скоростью).</p>';
  }
  const list = [...results].sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at))); // старые – первыми
  const totalMs = list.reduce((acc, r) => acc + r.ms, 0);
  const totalFrags = list.reduce((acc, r) => acc + r.frags, 0);
  const avg = totalMs ? totalFrags / (totalMs / 60000) : 0; // взвешенная по времени
  const speeds = list.map(speedOf);
  const best = list[speeds.indexOf(Math.max(...speeds))];
  const sorted = [...speeds].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const last = list[list.length - 1];
  const vsAvg = avg ? Math.round(((speedOf(last) - avg) / avg) * 100) : 0;
  const sp = (v) => `${v.toFixed(2)}/мин <span class="muted small">(${Math.round(v * 60)}/ч)</span>`;
  const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
  const left = [row("Результатов", list.length), row("Всего времени", formatMinutes(totalMs)),
    row("Всего фрагментов", totalFrags.toLocaleString("ru-RU")), row("Средняя скорость", sp(avg))].join("");
  const right = [
    row("Лучшая", `${sp(speedOf(best))} <span class="muted small">· ${shortDate(best.saved_at)}</span>`),
    row("Медиана", sp(median)),
    row("Последняя", `${sp(speedOf(last))} <span class="${vsAvg >= 0 ? "ok-text" : "flagged-text"} small">${vsAvg >= 0 ? "+" : ""}${vsAvg}% к средней</span>`),
    row("Осталось править", remaining && avg ? `${remaining.toLocaleString("ru-RU")} фрагм. ≈ ${formatMinutes((remaining / avg) * 60000)}` : "–"),
  ].join("");
  const byVideo = new Map();
  for (const r of list) {
    const key = resultTitle(r);
    const v = byVideo.get(key) || { n: 0, ms: 0, frags: 0 };
    v.n += 1;
    v.ms += r.ms;
    v.frags += r.frags;
    byVideo.set(key, v);
  }
  const videos = [...byVideo.entries()].map(([title, v]) => ({ title, ...v, speed: v.frags / (v.ms / 60000) }))
    .sort((a, b) => b.speed - a.speed);
  return `<div class="tab-head"><span class="muted small">Результаты таймера в редакторе (иконка сохранения рядом со скоростью)</span>
      <button id="speed-all" class="step-btn">Все результаты (${list.length})</button></div>
    <div class="disk-grid"><table class="stats">${left}</table><table class="stats">${right}</table></div>
    <div id="speed-chart" class="chart-box"></div>
    <h3 class="tab-sub">Скорость по видео</h3>
    ${hbars(videos.map((v) => ({ label: v.title, segs: [{ value: v.speed, cls: "c-blue", title: `${v.frags} фрагм. за ${formatMinutes(v.ms)}` }],
      text: `${v.speed.toFixed(2)}/мин <span class="muted small">· ${v.n} рез., ${formatMinutes(v.ms)}</span>` })))}`;
}

// Окно со всеми результатами таймера (новые – первыми): удалить лишние.
// Закрыли окно, что-то удалив, – статистика перерисовывается (onChange).
function resultsModal(results, onChange) {
  let changed = false;
  const list = [...results].sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  const body = Modal.show(`<h2 class="modal-title">Результаты таймера</h2>
    <table class="stats grid-table results-list"><tr><th>Дата</th><th>Видео</th><th>Время</th><th>Фрагментов</th><th>Скорость</th><th></th></tr>
    ${list.map((r) => `<tr data-id="${escapeHtml(r.id)}"><td>${escapeHtml(shortDate(r.saved_at))}</td>` +
      `<td>${escapeHtml(r.title || "Не указано")}${r.note ? ` <span class="muted small">(${escapeHtml(r.note)})</span>` : ""}</td>` +
      `<td>${formatMinutes(r.ms)}</td><td>${r.frags}</td><td>${speedOf(r).toFixed(2)}/мин</td>` +
      `<td><button class="step-btn result-del">Удалить</button></td></tr>`).join("")}
    </table>`, () => changed && onChange());
  body.querySelectorAll(".result-del").forEach((button) => button.addEventListener("click", async () => {
    const tr = button.closest("tr");
    button.disabled = true;
    try {
      await Api.deleteTimerResult(tr.dataset.id);
    } catch (_) {
      button.disabled = false;
      return;
    }
    changed = true;
    tr.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).onfinish = () => tr.remove();
  }));
}

// Строка "Потрачено": всего и по видам (OpenRouter).
function spentLine(costs) {
  const c = costs || {};
  const money = (x) => `$${(Number(x) || 0).toFixed(2)}`;
  const total = costTotal(c);
  return `${money(total)} всего (${money(c.search)} поиск, ${money(translateCost(c))} перевод и доводка)`;
}

// Сумма расходов видео.
const costTotal = (c) => (c && ((c.search || 0) + (c.fix || 0) + (c.translate || 0) + (c.retranslate || 0))) || 0;
// "Перевод и доводка": перевод, повторный перевод (доводка по флагам) и ИИ-доводка текста – одной суммой.
const translateCost = (c) => (c && ((c.translate || 0) + (c.retranslate || 0) + (c.fix || 0))) || 0;

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

// Внутри каждой группы – своим сравнением.
function sortWithin(groups, cmp) {
  return groups.map(([group, list]) => [group, [...list].sort(cmp)]);
}

// "Видео" внутри группы, по этапу:
//   0) есть вернувшиеся из Anki (фиолетовые),
//   1) не начатые (отредактировано 0 из N),
//   2) начатые (отредактировано хоть одно, но не всё),
//   3) всё отредактировано, но не всё передано в Anki,
//   4) всё в Anki, но не всё переведено,
//   5) готовые целиком.
// Внутри 0–2 – где больше осталось править; 3 – где больше не передано;
// 4 – где больше не переведено. При равенстве – по алфавиту.
const notSent = (v) => (v.active_total || 0) - (v.exported || 0);
const notTranslated = (v) => (v.cards_total || 0) - (v.translated || 0) - (v.translated_waiting || 0);
function videoStage(v) {
  if ((v.flagged || 0) + (v.flag_interval || 0) > 0) return 0;
  if (v.awaiting) return (v.reviewed || 0) > 0 ? 2 : 1;
  if (notSent(v) > 0) return 3;
  if (notTranslated(v) > 0) return 4;
  return 5;
}
function byVideoWork(a, b) {
  const sa = videoStage(a);
  const sb = videoStage(b);
  if (sa !== sb) return sa - sb;
  const diff = sa === 3 ? notSent(b) - notSent(a)
    : sa === 4 ? notTranslated(b) - notTranslated(a)
      : (b.awaiting || 0) - (a.awaiting || 0);
  return diff || String(a.title).localeCompare(String(b.title));
}

// "Обработка": группы – где больше видео в работе, при равенстве – где больше
// сумма процентов; внутри группы – по проценту (больше – выше), при равенстве –
// новые выше (список и так приходит новыми первыми, сортировка устойчивая).
const percentOf = (v) => (v.state === "processing" ? Number(v.percent) || 0 : -1);
function byProcessing(a, b) {
  const busy = (list) => list.filter((v) => v.state === "processing").length;
  const sum = (list) => list.reduce((s, v) => s + Math.max(0, percentOf(v)), 0);
  return busy(b[1]) - busy(a[1]) || sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]);
}
function byPercent(a, b) {
  return percentOf(b) - percentOf(a);
}

// Группы в "Видео": выше – где больше ждёт правки (сумма по видео группы:
// ещё не отредактированные + вернувшиеся из Anki), затем – где больше видео.
function byPendingWork(a, b) {
  const work = (list) => list.reduce((sum, v) => sum + (v.awaiting || 0), 0);
  return work(b[1]) - work(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]);
}

// Скрыть / показать боковую панель. Страница не "тянется" вслед за панелью
// (раньше колонки сайта плавно меняли ширину, карточки по дороге
// растягивались и в конце прыгали): панель уезжает за край, затем раскладка
// меняется сразу, а содержимое страницы плавно переезжает на новые места
// (FLIP: из старого положения в новое).
const PanelMotion = {
  DURATION: 320,

  // Что переезжает плавно: карточки, заголовки, блоки страниц.
  _items() {
    return [...document.querySelectorAll(
      "#main .view:not(.hidden) :is(.card, .set-card, .group-title, .page-head, .page-note, .settings-actions, #app), " +
      "#main .view:not(.hidden) > h1")];
  },

  _flip(change) {
    const items = this._items();
    const before = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
    change();
    for (const el of items) {
      const a = before.get(el);
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: this.DURATION, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" });
    }
    // Ширина редактора поменялась – дорожку перерисовать под неё.
    if (State.view === "editor") requestAnimationFrame(() => (Timeline._resize(), App.renderAll()));
  },

  toggle(side, close) {
    const body = document.body;
    if (close) {
      // Панель уезжает, и одновременно содержимое переезжает на новые места.
      this._flip(() => body.classList.add(`${side}-closed`));
    } else {
      // Сразу раскладка (место под панелью), содержимое переезжает; панель въезжает.
      this._flip(() => {
        body.classList.add(`${side}-closing`);
        body.classList.remove(`${side}-closed`);
      });
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove(`${side}-closing`)));
    }
  },
};

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
  async videos(kind = "video") {
    // Один и тот же раздел для видео и для аудио (список фильтруется по audio_only).
    this.libraryKind = kind;
    const audio = kind === "audio";
    const el = document.getElementById("view-videos");
    el.innerHTML = `<div class="page-head"><h1>${audio ? "Аудио" : "Видео"}</h1>
        <div class="head-actions">
          <span id="flags-status" class="muted small"></span>
          <button id="open-flags" class="step-btn">Проверка флагов</button>
          <button id="open-translate" class="step-btn">Доводка</button>
        </div></div>
      <p class="muted small page-note">${audio
        ? "Обработанные аудио (песни и т.п.), сгруппированные по исполнителю. Полосы – как у видео: докуда дошла правка, сколько фрагментов стали карточками Anki и переведены. Нажмите на аудио, чтобы открыть подробности и перейти к правке."
        : "Обработанные видео, сгруппированные по автору. Полоса «Отредактировано» – докуда дошла правка (синее – принято без правок, жёлтое – изменено, красное – удалено), «Передано в Anki» – сколько фрагментов уже стали карточками. Нажмите на видео, чтобы открыть подробности, изменить название или автора и перейти к правке."}</p>
      <div id="videos-list"><p class="muted">Загрузка…</p></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    el.querySelector("#open-flags").addEventListener("click", () => this.checkFlags());
    el.querySelector("#open-translate").addEventListener("click", () => this.translateModal());
    const render = async () => {
      const box = document.getElementById("videos-list");
      if (!box) return;
      let items;
      try {
        items = (await Api.ankiOverview()).filter((v) => !!v.audio_only === audio);
      } catch (err) {
        box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
        return;
      }
      // Кнопка "Перевод" показывает, сколько карточек ждут перевода.
      const toTranslate = items.reduce((sum, v) => sum + (v.flag_translation || 0), 0);
      const translateButton = document.getElementById("open-translate");
      if (translateButton) translateButton.textContent = toTranslate ? `Доводка (${toTranslate})` : "Доводка";
      if (!items.length) {
        box.innerHTML = `<p class="muted">Готовых ${audio ? "аудио" : "видео"} пока нет – добавьте их в разделе «Добавить», затем обработайте в «Обработке».</p>`;
        return;
      }
      const first = !box.querySelector("a.card");
      renderSmooth(box, sortWithin(groupByAuthor(items, byPendingWork), byVideoWork).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          v.state === "offline"
            ? `<div class="card offline-card">${cardTitle(v)}<div class="muted small">Диск ${escapeHtml(v.storage)} не подключён</div></div>`
            : `<a class="card${cardState(v)}" href="#/${audio ? "audio" : "video"}/${encodeURIComponent(v.id)}">${cardTitle(v)}` +
          // Кнопка следующего шага – вместо строки "Место на диске".
          videoBars(v) + (cardAction(v) ? cardAction(v) + videoNotes(v, false) : videoNotes(v)) +
          "</a>").join("") + "</div>",
      ).join(""), first);
      if (first) cardsEnter(box);
      // Кнопка появилась – раскрывается; исчезла – плавно возвращается строка
      // "Место на диске" (при первом показе раздела – без анимации).
      // Исчезла – прежняя кнопка (её копия) плавно сжимается на своём месте.
      const now = new Map(items.map((v) => [v.id, cardAction(v)]));
      if (!first && this.lastActions) {
        for (const [vid, html] of now) {
          const was = this.lastActions.get(vid);
          if (!!was === !!html) continue;
          const card = box.querySelector(`a.card[href$="/${CSS.escape(encodeURIComponent(vid))}"]`);
          if (!card) continue;
          if (html) {
            const el = card.querySelector(".card-action");
            if (el) el.classList.add("grow-in");
            continue;
          }
          const notes = card.querySelector(".muted.small:last-child");
          if (notes) notes.classList.add("fade-in");
          const tmp = document.createElement("div");
          tmp.innerHTML = was;
          const ghost = tmp.firstElementChild;
          ghost.classList.add("shrink-out");
          ghost.removeAttribute("data-id"); // не кнопка: не нажимается, не рисуется заново
          ghost.disabled = true;
          if (notes) card.insertBefore(ghost, notes);
          else card.appendChild(ghost);
          ghost.addEventListener("animationend", () => ghost.remove(), { once: true });
        }
      }
      this.lastActions = now;
      flashCard(box);
      this.prefetchStats(items.filter((v) => v.state === "ready").map((v) => v.id));
      Zebra.start();
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
        if (button.dataset.action === "none") return;
        if (["stop", "cancel-send", "cancel-move"].includes(button.dataset.action)) {
          // Занятая кнопка – отменить её действие.
          button.disabled = true;
          Pages.pressedActions.delete(id);
          try {
            if (button.dataset.action === "stop") await Api.agentStop(id);
            else if (button.dataset.action === "cancel-send") await Api.stopStage3(id);
            else await Api.cancelMove(id);
          } catch (err) {
            console.error(err);
          }
          if (Pages.videosRender) Pages.videosRender();
          return;
        }
        Pages.pressedActions.set(id, { at: Date.now(), action: button.dataset.action });
        // Сразу – вид "идёт" (другой текст и полосы); перерисовка подхватит.
        button.disabled = true;
        button.classList.add("busy");
        button.querySelector("span").dataset.type = button.dataset.action === "send" ? "Передаётся в Anki…" : "Выполняется перевод…";
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
    this.refreshEvery(3000, render); // чаще – кнопки шагов появляются без задержки
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
          <button class="step-btn primary" id="agent-approve">Одобрить отмеченные</button>
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
  statsCache: new Map(), // данные окна медиа по коду (для мгновенного открытия)
  diskCache: new Map(), // место на диске по коду (окно в "Обработке" – сразу)

  async prefetchDisk(ids) {
    if (this._prefetchingDisk) return;
    this._prefetchingDisk = true;
    try {
      for (const id of ids) {
        if (this.diskCache.has(id) || State.view !== "process") continue;
        try {
          this.diskCache.set(id, await Api.projectDisk(id));
        } catch (_) {}
      }
    } finally {
      this._prefetchingDisk = false;
    }
  },

  // Пока виден список – данные окон его медиа подгружаются заранее, по одному,
  // каждое не чаще раза в минуту (окно тогда открывается без ожидания).
  async prefetchStats(ids) {
    if (this._prefetching) return;
    this._prefetching = true;
    try {
      for (const id of ids) {
        const c = this.statsCache.get(id);
        if (c && Date.now() - c._at < 60000) continue;
        if (State.view !== "videos" || document.hidden) break;
        try {
          this.statsCache.set(id, { ...(await Api.projectStats(id)), _at: Date.now() });
        } catch (_) {}
      }
    } finally {
      this._prefetching = false;
    }
  },

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
  // Окно открывается сразу: если данные этого медиа уже есть (подгружены
  // заранее, пока виден список, или с прошлого открытия) – с ними, а свежие
  // запрашиваются параллельно и, если что-то поменялось, окно тут же
  // перерисовывается на месте (reuse – то же окно, без анимации появления).
  // Не перерисовывается, пока правят название/автора.
  async videoModal(id, reuse = null) {
    let watcher = null;
    let save = async () => {};
    const guard = { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() };
    const body = reuse ? reuse.body : Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/video/")) location.hash = "#/videos";
      else if (location.hash.startsWith("#/audio/")) location.hash = "#/audio";
    }, guard);
    if (reuse) Modal.guard = guard;
    // Поколение содержимого окна: старые циклы обновления после перерисовки затихают.
    const gen = (body.dataset.gen = String(Number(body.dataset.gen || 0) + 1));
    const cached = reuse ? reuse.data : Pages.statsCache.get(id);
    const fresh = reuse ? null : Api.projectStats(id).then((d) => {
      Pages.statsCache.set(id, { ...d, _at: Date.now() });
      return d;
    });
    let data = cached;
    if (!data) {
      try {
        data = await fresh;
      } catch (err) {
        body.innerHTML = `<p class="muted">Видео не найдено или ещё обрабатывается.</p>`;
        return;
      }
    } else if (fresh) {
      fresh.then((d) => {
        if (!body.isConnected || body.dataset.gen !== gen) return;
        const strip = (x) => JSON.stringify({ ...x, _at: 0 });
        if (strip(d) === strip(cached)) return;
        const head = body.querySelector(".modal-head");
        if ((watcher && watcher.isDirty()) || (head && head.contains(document.activeElement))) return;
        this.videoModal(id, { body, data: d });
      }).catch(() => {});
    }
    const v = data.summary;
    const s = data.stats;
    const d = data.disk;
    // Градиент и обводка окна – как у карточки этого видео в списке.
    const modalBox = body.closest(".modal");
    // Состояние меняется (передача закончилась или её остановили) – градиент
    // окна вслед за ним (раньше оставался прежним до закрытия окна).
    const paint = (sv) => {
      modalBox.classList.remove("complete", "to-translate", "to-send", "has-returned", "started");
      const state = cardState(sv).trim();
      if (state) modalBox.classList.add(state);
    };
    paint(v);
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
    // Пересчитывается при каждом обновлении окна (см. refresh): перевод
    // закончился – кнопка сразу становится серой.
    let untranslated = v.sending ? 0 : v.to_translate === null ? 1 : v.to_translate || 0;
    // "Править": есть что править – синяя зебра; осталось только вернувшееся
    // из Anki – фиолетовая; править нечего – просто синяя.
    const editZebra = !v.awaiting ? "" : (v.flagged || 0) >= v.awaiting ? "editReturned" : "edit";
    body.innerHTML = `
      <div class="modal-head">
        <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
        <label>Автор <textarea id="group-input" class="grow fixed" rows="1" data-single>${escapeHtml(v.group)}</textarea></label>
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
        ${row("Потрачено", spentLine(s.costs))}
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
        <a id="info-edit" class="step-btn${editZebra ? " primary" : ""} zebra-host" href="#/edit/${encodeURIComponent(v.id)}"
          ${editZebra ? `data-zebra="${editZebra}"` : ""}><canvas class="zebra"></canvas><span>Редактировать</span></a>
        <button id="info-anki" class="step-btn fold zebra-host gone"><canvas class="zebra"></canvas><span>Передать в Anki</span></button>
        <button id="info-translate" class="step-btn fold zebra-host gone"><canvas class="zebra"></canvas><span>Перевести</span></button>
        <span id="info-note" class="muted small"></span>
        <button id="info-storage" class="step-btn fold zebra-host" title="Где хранится видео; перенос на другой диск"><canvas class="zebra"></canvas><span>Хранилище</span></button>
        <button id="info-save" class="step-btn fold gone">Сохранить</button>
      </div>`;
    autoGrow(body.querySelector("#title-input"));
    singleLine(body.querySelector("#group-input"));
    animateBars(body.querySelector(".modal-bars"));
    requestAnimationFrame(() => foldLongRows(body));
    const saveButton = body.querySelector("#info-save");
    const closeAndFlash = () => {
      Pages.flashId = id;
      Modal.close();
    };
    // "Сохранить" появляется вместо "Хранилище", только когда есть изменения (см. render).
    watcher = formWatch(body.querySelector(".modal-head"), []);
    body.querySelector(".modal-head").addEventListener("input", () => render());
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (!title || !group) return;
      await Api.saveProjectInfo(id, { title, group });
      watcher.snapshot();
      // Переименовали видео, которое открыто в редакторе, – обновить ссылку в меню.
      if (State.project === id && State.manifest) {
        State.manifest.video.title = title;
        State.manifest.video.group = group;
        setEditingLink();
      }
    };
    saveButton.addEventListener("click", async () => {
      await save();
      closeAndFlash();
    });
    Zebra.start();

    const storageButton = body.querySelector("#info-storage");
    let storageInfo = data.storage;
    let moving = !!(v.moving || (storageInfo && storageInfo.move && !storageInfo.move.finished));
    const ankiButton = body.querySelector("#info-anki");
    const translateButton = body.querySelector("#info-translate");
    const note = body.querySelector("#info-note");
    const setNote = (text, hint = "") => {
      note.textContent = text;
      note.title = hint || text;
    };

    // Вид строки кнопок по состоянию видео:
    //  - "Передать в Anki" – только если есть что передать (зебра, когда
    //    отредактировано всё); "Перевести" – только если есть что переводить
    //    (зебра, когда всё в Anki); идёт действие – на её месте "Отменить" с
    //    быстрой зеброй;
    //  - справа "Хранилище" (окошко: где лежит, перенос на другой диск); идёт
    //    перенос – "Отменить" с быстрой серой зеброй, остальное серое;
    //  - изменили название/автора – вместо "Хранилище" "Сохранить", остальное серое;
    //  - "Редактировать" серая, пока идёт перенос, и пока идёт передача/перевод,
    //    если править уже нечего (в редактор тогда не пускает и роутер).
    let sending = !!v.sending;
    let running = !!v.translating;
    let waitingBatch = false;
    let last = v;
    const fold = (el, gone) => el && el.classList.toggle("gone", gone);
    const zebra = (el, kind) => (kind ? el.setAttribute("data-zebra", kind) : el.removeAttribute("data-zebra"));
    const label = (el, text) => (el.querySelector("span").textContent = text);
    const render = (s = last) => {
      last = s;
      const dirty = watcher.isDirty();
      const busy = sending || running;
      body.querySelectorAll(".modal-head input, .modal-head textarea").forEach((field) => (field.disabled = busy || moving));
      // Передать в Anki
      const canSend = (s.sendable || 0) > 0;
      fold(ankiButton, running || !(sending || canSend));
      label(ankiButton, sending ? "Отменить" : "Передать в Anki");
      zebra(ankiButton, sending ? "sendBusy" : canSend && s.ready_to_send ? "sendReady" : "");
      ankiButton.classList.toggle("send-ready", !sending && canSend);
      ankiButton.disabled = moving || dirty;
      ankiButton.title = sending ? "Отменить передачу в Anki" : `Передать отредактированные: ${s.sendable || 0}`;
      // Перевести
      const canTranslate = untranslated > 0;
      fold(translateButton, sending || !(running || canTranslate));
      label(translateButton, running ? "Отменить" : "Перевести");
      zebra(translateButton, running ? "translateBusy" : canTranslate && s.ready_to_translate ? "translateReady" : "");
      translateButton.classList.toggle("translate-ready", !running && canTranslate);
      translateButton.disabled = moving || dirty;
      translateButton.title = running ? "Отменить перевод" : s.to_translate === null ? "Anki закрыт" : `Без перевода: ${untranslated}`;
      // Хранилище / Сохранить / Отменить перенос
      fold(saveButton, !dirty || moving);
      fold(storageButton, dirty && !moving);
      label(storageButton, moving ? "Отменить" : "Хранилище");
      zebra(storageButton, moving ? "moveBusy" : "");
      storageButton.disabled = !moving && busy;
      storageButton.title = moving ? "Отменить перенос на другой диск" : busy ? "Перенести можно после передачи в Anki / перевода" : "Где хранится видео; перенос на другой диск";
      // Редактировать
      const editLocked = moving || dirty || (busy && !(s.editable > 0));
      editLink.classList.toggle("disabled", editLocked);
      editLink.title = moving ? "Видео переносится на другой диск" : busy && !(s.editable > 0) ? "Править нечего, пока идёт передача / перевод" : "";
      note.classList.toggle("busy", busy || moving);
      if (!busy && !moving) setNote("");
    };
    const editLink = body.querySelector("#info-edit");
    render();

    const refresh = async () => {
      if (!body.isConnected || body.dataset.gen !== gen) return;
      try {
        const [stats, state] = await Promise.all([Api.projectStats(id), Api.agentState()]);
        Pages.statsCache.set(id, { ...stats, _at: Date.now() });
        const s = stats.summary;
        const st = state.status || {};
        sending = !!s.sending;
        storageInfo = stats.storage;
        const mv = storageInfo && storageInfo.move;
        moving = !!(mv && !mv.finished);
        untranslated = s.sending ? 0 : s.to_translate === null ? 1 : s.to_translate || 0;
        waitingBatch = (state.batches || []).some((j) => j.project === id);
        running = waitingBatch || (st.state === "running" && st.project === id && Date.now() / 1000 - st.updated < 300);
        render(s);
        paint(s);
        if (moving) setNote(`Перенос на ${mv.dest}: ${mv.total ? Math.floor((100 * mv.done) / mv.total) : 0}% – ` +
          `${(mv.done / 2 ** 30).toFixed(1)}/${(mv.total / 2 ** 30).toFixed(1)} ГБ`);
        else if (mv && mv.error) setNote(mv.error);
        else if (sending) setNote(`Передача в Anki: ${s.in_anki}/${s.active_total}`);
        else if (st.state === "running" && st.project === id && st.cards_total) {
          setNote(`Перевод: ${Math.floor(100 * (st.cards_done || 0) / st.cards_total)}% – ${st.cards_done || 0}/${st.cards_total} ` +
            plural(st.cards_total, "фрагмент", "фрагмента", "фрагментов"));
        }
        else if (waitingBatch) setNote("Ждём ответ пакета");
        const box = body.querySelector(".modal-bars");
        if ((sending || running) && box) renderSmooth(box, videoBars({ ...s, flag_interval: 0 }));
      } catch (_) {
        return;
      }
      if (moving) setTimeout(refresh, 1200);
      else if (sending || running) setTimeout(refresh, 3000);
    };
    if (sending || running || moving) refresh();

    // "Хранилище": окошко с дисками; выбрали – перенос (ход – справа и на карточке).
    // Идёт перенос – эта же кнопка его отменяет.
    storageButton.addEventListener("click", async () => {
      if (moving) {
        storageButton.disabled = true;
        try {
          await Api.cancelMove(id);
        } catch (err) {
          setNote("Ошибка", err.message);
        }
        setTimeout(refresh, 300);
        return;
      }
      const dest = await askStorage(storageInfo || { here: { label: "?", path: "" }, targets: [] });
      if (!dest) return;
      try {
        await Api.moveProject(id, dest);
      } catch (err) {
        let message = err.message;
        try {
          message = JSON.parse(message).detail;
        } catch (_) {}
        setNote(cap(message));
        return;
      }
      moving = true;
      render();
      refresh();
    });

    // Кнопки шагов: действие – и окно сразу закрывается (ход виден на карточке).
    ankiButton.addEventListener("click", async () => {
      ankiButton.disabled = true;
      try {
        if (sending) await Api.stopStage3(id);
        else await Api.queueProject(id);
      } catch (err) {
        setNote("Ошибка", err.message);
        return;
      }
      closeAndFlash();
    });
    translateButton.addEventListener("click", async () => {
      translateButton.disabled = true;
      try {
        if (running) await Api.agentStop(id);
        else await Api.agentRun({ project: id, batch: false }); // пакетом не переводим – слишком долго
      } catch (err) {
        setNote("Ошибка", err.message);
        return;
      }
      closeAndFlash();
    });
  },

  // -- обработка (этап 1) --------------------------------------------------------------
  async process() {
    const el = document.getElementById("view-process");
    // Видео или аудио – по режиму (переключатель в меню).
    const kind = Mode.kind;
    el.innerHTML = `<h1>Обработка</h1>
      <p class="muted small page-note">${kind === "audio"
        ? "Добавленные аудио: распознавание речи, сверка с текстом (агент ищет текст песни сам или по вашей ссылке) и нарезка на фразы. Нажмите на аудио, чтобы прикрепить ссылки и запустить обработку."
        : "Добавленные видео: копия для редактора, распознавание речи, сверка с текстом и нарезка на фразы. Нажмите на видео, чтобы прикрепить ссылки на текст для сверки (например, страницу Notion) и запустить обработку."}</p>
      <div id="process-list"><p class="muted">Загрузка…</p></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    const render = async () => {
      const box = document.getElementById("process-list");
      if (!box) return;
      const pending = (await Api.projects()).filter((v) => v.state !== "ready");
      const items = pending.filter((v) => !!v.audio_only === (kind === "audio"));
      Pages.processItems = pending;
      Pages.prefetchDisk(items.map((v) => v.id));
      if (!items.length) {
        box.innerHTML = `<p class="muted">Нечего обрабатывать – добавьте ${kind === "audio" ? "аудио" : "видео"} в разделе «Добавить».</p>`;
        return;
      }
      const first = !box.querySelector("a.card");
      renderSmooth(box, sortWithin(groupByAuthor(items, byProcessing), byPercent).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          // Как карточка в "Видео": название (до 2 строк), под ним – строка
          // состояния (как "Место на диске") или полоса хода (как кнопка шага).
          `<a class="card proc-card${procState(v)}" href="#/process/${encodeURIComponent(v.id)}">` +
          cardTitle(v) +
          (v.state === "processing" && v.percent !== null && v.percent !== undefined ? processingBar(v)
            : `<div class="muted small${v.state === "failed" ? " failed" : ""}">${escapeHtml(cap(
              v.state === "processing" ? v.status || "Обрабатывается" : v.state === "failed" ? v.status : "Добавлено, ждёт обработки"))}</div>`) +
          "</a>").join("") + "</div>",
      ).join(""), first);
      if (first) cardsEnter(box);
      flashCard(box);
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
    // Окно – сразу: медиа берётся из уже показанного списка, место на диске –
    // из подгруженного заранее; свежее место на диске подставляется по приходу.
    const v = (Pages.processItems || []).find((item) => item.id === id) || (await Api.projects()).find((item) => item.id === id);
    if (!v) {
      body.innerHTML = '<p class="muted">Видео не найдено.</p>';
      return;
    }
    const diskFresh = Api.projectDisk(id).then((d) => {
      Pages.diskCache.set(id, d);
      return d;
    }).catch(() => null);
    let disk = Pages.diskCache.get(id) || null;
    if (!disk) disk = await diskFresh;
    const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
    body.innerHTML = `
      <div class="process-form">
        <div class="modal-head">
          <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
          <label>Автор <textarea id="group-input" class="grow fixed" rows="1" data-single>${escapeHtml(v.group)}</textarea></label>
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
      ${disk ? `<h2>Место на диске</h2><table class="stats" id="proc-disk">
        ${row("Оригинал", formatSize(disk.master))}${row("Копия для редактора", formatSize(disk.editor))}${row("Всего", `<b>${formatSize(disk.total)}</b>`)}
      </table>` : ""}
      <div class="modal-actions">
        ${v.state === "processing" ? '<button class="step-btn process-cancel">Отменить</button>'
          : `<button class="step-btn primary process-go zebra-host" data-zebra="process" id="process-go"><canvas class="zebra"></canvas><span>${escapeHtml(v.next_step || "Обработать")}</span></button>`}
        <span class="muted small note"></span>
        ${v.state === "processing" ? '<span class="process-status"></span>' : ""}
        <button id="process-storage" class="step-btn zebra-host${v.state === "processing" ? " hidden" : ""}" title="Где хранится видео; перенос на другой диск"><canvas class="zebra"></canvas><span>Хранилище</span></button>
        <button class="step-btn info-save hidden">Сохранить</button>
      </div>`;
    body.querySelectorAll("textarea.grow:not(.fixed)").forEach(autoGrow);
    singleLine(body.querySelector("#group-input"));
    // Пришло свежее место на диске – числа в таблице на месте.
    diskFresh.then((d) => {
      const table = body.querySelector("#proc-disk");
      if (!d || !table || !body.isConnected) return;
      table.innerHTML = row("Оригинал", formatSize(d.master)) + row("Копия для редактора", formatSize(d.editor)) + row("Всего", `<b>${formatSize(d.total)}</b>`);
    });
    requestAnimationFrame(() => foldLongRows(body));
    // Градиент окна – по этапу, как у карточки в "Обработке" (рыжий – скачивание,
    // синий – шаг с процентом, жёлтый – сверка/поиск агентом/нарезка, зелёный – начало).
    const procBox = body.closest(".modal");
    const paintProc = (pv) => {
      procBox.classList.remove("proc-red", "proc-blue", "proc-yellow", "proc-green");
      const state = procState(pv).trim();
      if (state) procBox.classList.add(state);
    };
    paintProc(v);
    // Над видео идёт работа (скачивание, обработка) – ничего не меняется.
    if (v.state === "processing") {
      body.querySelectorAll("input, textarea, select").forEach((field) => (field.disabled = true));
      const saveBtn = body.querySelector(".info-save");
      saveBtn.disabled = true;
      saveBtn.classList.add("hidden");
    }
    // Идёт обработка: справа – её ход (обновляется), слева – "Отменить" с
    // вопросом: что сохранится, а что начнётся заново на этом шаге.
    const statusBox = body.querySelector(".process-status");
    if (statusBox) {
      const showStatus = async () => {
        if (!body.isConnected) return;
        const now = (await Api.projects()).find((item) => item.id === id);
        if (!now) return;
        paintProc(now);
        if (now.state !== "processing") {
          statusBox.textContent = cap(now.status || "Готово");
          return;
        }
        statusBox.textContent = cap(now.status) + (now.percent !== null && now.percent !== undefined ? `: ${Math.floor(now.percent)}%` : "");
        setTimeout(showStatus, 2000);
      };
      showStatus();
      body.querySelector(".process-cancel").addEventListener("click", async () => {
        const now = (await Api.projects()).find((item) => item.id === id) || v;
        const answer = await askConfirm({
          title: "Отменить обработку?", text: PROCESS_CANCEL_EFFECT[now.step] || PROCESS_CANCEL_EFFECT.default,
          yes: "Отменить обработку", no: "Продолжить", danger: true,
        });
        if (answer !== "yes") return;
        try {
          await Api.cancelProcess(id);
        } catch (err) {
          statusBox.textContent = "Не удалось отменить";
          statusBox.title = err.message;
          return;
        }
        Pages.flashId = id;
        Modal.close();
      });
    }
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
    watcher = formWatch(body.querySelector(".process-form"), []);
    // "Сохранить" – вместо "Хранилище", только когда есть изменения; во время
    // переноса "Хранилище" – "Отменить" с быстрой серой зеброй, остальное серое.
    const storageBtn = body.querySelector("#process-storage");
    let storageInfo = disk && disk.storage;
    let moving = !!(storageInfo && storageInfo.move && !storageInfo.move.finished);
    const procNote = body.querySelector(".note");
    const renderProc = () => {
      if (v.state === "processing") return;
      const dirty = watcher.isDirty();
      saveButton.classList.toggle("hidden", !dirty || moving);
      storageBtn.classList.toggle("hidden", dirty && !moving);
      storageBtn.querySelector("span").textContent = moving ? "Отменить" : "Хранилище";
      if (moving) storageBtn.setAttribute("data-zebra", "moveBusy");
      else storageBtn.removeAttribute("data-zebra");
      storageBtn.disabled = false;
      const goBtn = body.querySelector(".process-go");
      if (goBtn) goBtn.disabled = moving || dirty;
      body.querySelectorAll(".process-form input, .process-form textarea").forEach((f) => (f.disabled = moving));
    };
    body.querySelector(".process-form").addEventListener("input", renderProc);
    body.querySelector(".process-form").addEventListener("change", renderProc);
    const pollMove = async () => {
      if (!body.isConnected) return;
      try {
        storageInfo = (await Api.projectDisk(id)).storage;
      } catch (_) {
        return;
      }
      const mv = storageInfo && storageInfo.move;
      moving = !!(mv && !mv.finished);
      procNote.textContent = moving ? `Перенос на ${mv.dest}: ${mv.total ? Math.floor((100 * mv.done) / mv.total) : 0}%` : mv && mv.error ? mv.error : "";
      renderProc();
      if (moving) setTimeout(pollMove, 1200);
    };
    storageBtn.addEventListener("click", async () => {
      if (moving) {
        storageBtn.disabled = true;
        try {
          await Api.cancelMove(id);
        } catch (_) {}
        setTimeout(pollMove, 300);
        return;
      }
      const dest = await askStorage(storageInfo || { here: { label: "?", path: "" }, targets: [] });
      if (!dest) return;
      try {
        await Api.moveProject(id, dest);
      } catch (err) {
        let message = err.message;
        try {
          message = JSON.parse(message).detail;
        } catch (_) {}
        procNote.textContent = cap(message);
        return;
      }
      moving = true;
      renderProc();
      pollMove();
    });
    Zebra.start();
    renderProc();
    if (moving) pollMove();
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (title && group) await Api.saveProjectInfo(id, { title, group });
      const mode = deep.checked ? "deep" : search.checked ? "search" : "";
      await Api.saveSources(id, body.querySelector(".sources").value.split("\n"), mode, body.querySelector(".no-gaps").checked);
      watcher.snapshot();
    };
    saveButton.addEventListener("click", async () => {
      await save();
      Pages.flashId = id;
      Modal.close();
    });
    const go = body.querySelector(".process-go");
    if (go) {
      Zebra.start();
      // Нажали – запуск, кнопка становится "Отменить", окно закрывается.
      go.addEventListener("click", async () => {
        await save();
        try {
          await Api.process(id);
        } catch (err) {
          body.querySelector(".note").textContent = err.message;
          return;
        }
        go.outerHTML = '<button class="step-btn process-cancel">Отменить</button>';
        Pages.flashId = id;
        Modal.close();
      });
    }
  },

  // -- добавить -----------------------------------------------------------------------
  async add() {
    const el = document.getElementById("view-add");
    // Как в "Настройках": блоки-карточки, два рядом (на узком экране – друг под другом).
    const audio = Mode.kind === "audio";
    el.innerHTML = `<h1>Добавить</h1>
      <div class="page-grid">
        <section class="set-card half-card${audio ? " hidden" : ""}">
          <h2>По ссылке</h2>
          <p class="muted small">YouTube и всё, что умеет yt-dlp. Видео скачается в качестве, заданном в «Настройках».</p>
          <div class="author-row"><input id="download-url" class="wide" placeholder="https://youtu.be/…"><button id="download-go" class="step-btn" disabled>Скачать</button></div>
        </section>
        <section class="set-card half-card">
          <h2>${audio ? "Свой аудиофайл" : "Свой файл"}</h2>
          <p class="muted small">${audio
            ? "Песня, подкаст и т.п. любого распространённого формата (mp3, m4a, wav, flac, ogg, opus…). Имя «Исполнитель — Название» разберётся само."
            : "Видео любого распространённого формата (mp4, mkv, webm, mov…); аудиофайлы – в режиме «Аудио»."}</p>
          <div class="author-row">
            <label class="step-btn file-pick">Выбрать файл<input id="file-input" type="file" accept="${audio ? "audio/*" : "video/*,audio/*"}" hidden></label>
            <span id="file-chip" class="file-chip hidden"><span class="file-chip-name"></span><button class="file-chip-x" title="Убрать файл">×</button></span>
            <button id="file-go" class="step-btn" disabled>Добавить</button>
          </div>
        </section>
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
  // -- статистика ------------------------------------------------------------------
  // Итоги по всем видео: расходы OpenRouter, правка, Anki, перевод, место;
  // ниже – расходы по видео и сводка по авторам.
  async stats() {
    const el = document.getElementById("view-stats");
    el.innerHTML = "";
    let data;
    try {
      data = await Api.overallStats();
      data.results = await Api.timerResults().catch(() => []);
    } catch (err) {
      el.innerHTML = `<h1>Статистика</h1><p class="muted">Не удалось загрузить: ${escapeHtml(err.message)}</p>`;
      return;
    }
    // Только медиа текущего режима (видео или аудио).
    const audioMode = Mode.kind === "audio";
    const all = data.videos.filter((v) => !!v.audio_only === audioMode);
    const ids = new Set(all.map((v) => v.id));
    data.results = (data.results || []).filter((r) => (r.project ? ids.has(r.project) : !audioMode));
    const ready = all.filter((v) => v.state === "ready");
    const sum = (list, f) => list.reduce((s, v) => s + (Number(f(v)) || 0), 0);
    const money = (x) => `$${(Number(x) || 0).toFixed(2)}`;
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "0%");
    const num = (n) => Number(n || 0).toLocaleString("ru-RU");
    const edited = (v) => { const e = v.edit_bar || {}; return (e.accepted || 0) + (e.unvoiced || 0) + (e.changed || 0) + (e.deleted || 0); };
    const kinds = { search: "Поиск источников", translate: "Перевод и доводка" };
    const kindOf = (c, k) => (k === "translate" ? translateCost(c) : c[k] || 0);
    const kindTotal = (k, list = all) => sum(list, (v) => kindOf(v.costs, k));
    const spentVideos = sum(all, (v) => costTotal(v.costs));
    // Итог – по счётчику OpenRouter (если доступен): туда входят и расходы не
    // по видео (эксперименты, проверки, траты до появления учёта).
    const usage = data.openrouter_usage;
    // Счётчик OpenRouter – общий на всё; в режиме "Аудио" – только расходы по аудио.
    const spentAll = !audioMode && usage !== null && usage !== undefined ? Math.max(usage, spentVideos) : spentVideos;
    const other = spentAll - spentVideos;
    const cards = sum(ready, (v) => v.cards_total);
    const translated = sum(ready, (v) => v.translated);
    const barTotal = sum(ready, (v) => v.bar_total || v.fragments_total);
    const editedAll = sum(ready, edited);
    const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
    const card = (title, rows) => `<section class="set-card"><h2>${title}</h2><table class="stats">${rows.join("")}</table></section>`;

    // Расходы по видео – дорогие сверху; итог внизу.
    const byCost = [...all].filter((v) => costTotal(v.costs) > 0 || v.state === "ready").sort((a, b) => costTotal(b.costs) - costTotal(a.costs));
    const costRows = byCost.map((v) =>
      `<tr><td><a href="#/${v.state === "ready" ? "video" : "process"}/${encodeURIComponent(v.id)}">${escapeHtml(v.title)}</a></td>` +
      Object.keys(kinds).map((k) => `<td>${money(kindOf(v.costs, k))}</td>`).join("") +
      `<td><b>${money(costTotal(v.costs))}</b></td></tr>`).join("");

    // По авторам.
    const groups = new Map();
    for (const v of all) {
      if (!groups.has(v.group)) groups.set(v.group, []);
      groups.get(v.group).push(v);
    }
    const groupRows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([group, list]) => {
      const r = list.filter((v) => v.state === "ready");
      return `<tr><td>${escapeHtml(group)}</td><td>${list.length}</td><td>${formatDuration(sum(list, (v) => v.duration))}</td>` +
        `<td>${pct(sum(r, edited), sum(r, (v) => v.bar_total || v.fragments_total))}</td>` +
        `<td>${num(sum(r, (v) => v.in_anki))}</td><td>${num(sum(r, (v) => v.translated))}</td>` +
        `<td>${money(sum(list, (v) => costTotal(v.costs)))}</td><td>${formatSize(sum(list, (v) => v.disk_total))}</td></tr>`;
    }).join("");

    // Показатели медиа – для вкладки "Информация" (график и сортировка) и "Авторы".
    const metrics = [
      { key: "duration", label: "Длительность", get: (v) => v.duration || 0, fmt: (x) => formatDuration(x) },
      { key: "fragments", label: "Фрагментов", get: (v) => v.fragments_total || 0, fmt: num },
      { key: "edited", label: "Отредактировано, %", get: (v) => (v.bar_total ? (edited(v) / v.bar_total) * 100 : 0), fmt: (x) => `${Math.round(x)}%` },
      { key: "anki", label: "В Anki", get: (v) => v.in_anki || 0, fmt: num },
      { key: "translated", label: "Переведено", get: (v) => v.translated || 0, fmt: num },
      { key: "editor", label: "Время в редакторе", get: (v) => v.editor_seconds || 0, fmt: (x) => formatMinutes(x * 1000) },
      { key: "cost", label: "Потрачено", get: (v) => costTotal(v.costs), fmt: money },
      { key: "disk", label: "Место на диске", get: (v) => v.disk_total || 0, fmt: (x) => formatSize(x) },
    ];
    const metricOf = (k) => metrics.find((m) => m.key === k) || metrics[0];
    const ui = (this.statsUi ||= { tab: localStorage.getItem("stats-tab") || "speed", infoMetric: "duration", sort: "duration", dir: -1, authorMetric: "duration" });
    const mediaLink = (v) => `#/${v.state === "ready" ? (v.audio_only ? "audio" : "video") : "process"}/${encodeURIComponent(v.id)}`;

    const tabs = {
      speed: { label: "Скорость правки", html: () => speedTab(data.results, Math.max(0, barTotal - editedAll)) },
      costs: {
        label: "Расходы",
        html: () => {
          const byCost = [...all].filter((v) => costTotal(v.costs) > 0).sort((a, b) => costTotal(b.costs) - costTotal(a.costs));
          return hbars(byCost.map((v) => ({
            label: v.title, href: mediaLink(v),
            segs: [{ value: v.costs.search || 0, cls: "c-blue", title: `Поиск источников: ${money(v.costs.search)}` },
              { value: translateCost(v.costs), cls: "c-pink", title: `Перевод и доводка: ${money(translateCost(v.costs))}` }],
            text: `<b>${money(costTotal(v.costs))}</b>`,
          })), legendItem("c-blue", "Поиск источников") + legendItem("c-pink", "Перевод и доводка")) +
            `<table class="stats grid-table"><tr><th>${audioMode ? "Аудио" : "Видео"}</th>${Object.values(kinds).map((k) => `<th>${k}</th>`).join("")}<th>Всего</th></tr>
            ${byCost.map((v) => `<tr><td><a href="${mediaLink(v)}">${escapeHtml(v.title)}</a></td>` +
              Object.keys(kinds).map((k) => `<td>${money(kindOf(v.costs, k))}</td>`).join("") + `<td><b>${money(costTotal(v.costs))}</b></td></tr>`).join("")}
            <tr class="total-row"><td>Итого</td>${Object.keys(kinds).map((k) => `<td>${money(kindTotal(k))}</td>`).join("")}<td><b>${money(spentVideos)}</b></td></tr></table>`;
        },
      },
      info: {
        label: "Информация",
        html: () => {
          const m = metricOf(ui.infoMetric);
          const chart = [...all].sort((a, b) => m.get(b) - m.get(a));
          const s2 = metricOf(ui.sort);
          const rows = [...all].sort((a, b) => ui.sort === "title"
            ? ui.dir * String(a.title).localeCompare(String(b.title)) : ui.dir * (s2.get(a) - s2.get(b)));
          const th = (key, label) => `<th class="sortable${ui.sort === key ? " sorted" : ""}" data-sort="${key}">${label}${ui.sort === key ? (ui.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
          return `<div class="tab-head"><span class="field-label">График по</span><div class="picker-host" data-for="info-metric"></div></div>` +
            hbars(chart.map((v) => ({ label: v.title, href: mediaLink(v), segs: [{ value: m.get(v), cls: "c-blue" }], text: m.fmt(m.get(v)) }))) +
            `<table class="stats grid-table info-table"><tr>${th("title", audioMode ? "Аудио" : "Видео")}${metrics.map((x) => th(x.key, x.label)).join("")}</tr>` +
            rows.map((v) => `<tr><td><a href="${mediaLink(v)}">${escapeHtml(v.title)}</a></td>${metrics.map((x) => `<td>${x.fmt(x.get(v))}</td>`).join("")}</tr>`).join("") +
            "</table>";
        },
      },
      authors: {
        label: audioMode ? "Исполнители" : "Авторы",
        html: () => {
          const groups = new Map();
          for (const v of all) {
            if (!groups.has(v.group)) groups.set(v.group, []);
            groups.get(v.group).push(v);
          }
          // Для автора – сумма по его медиа (отредактировано – общей долей).
          const agg = (list, m) => (m.key === "edited"
            ? (sum(list, (v) => v.bar_total) ? (sum(list, edited) / sum(list, (v) => v.bar_total)) * 100 : 0)
            : sum(list, m.get));
          const m = metricOf(ui.authorMetric);
          const entries = [...groups.entries()].sort((a, b) => agg(b[1], m) - agg(a[1], m));
          return `<div class="tab-head"><span class="field-label">График по</span><div class="picker-host" data-for="author-metric"></div></div>` +
            hbars(entries.map(([g, list]) => ({ label: g, segs: [{ value: agg(list, m), cls: "c-violet" }], text: m.fmt(agg(list, m)) }))) +
            `<table class="stats grid-table"><tr><th>${audioMode ? "Исполнитель" : "Автор"}</th><th>${audioMode ? "Аудио" : "Видео"}</th>${metrics.map((x) => `<th>${x.label}</th>`).join("")}</tr>` +
            entries.map(([g, list]) => `<tr><td>${escapeHtml(g)}</td><td>${list.length}</td>${metrics.map((x) => `<td>${x.fmt(agg(list, x))}</td>`).join("")}</tr>`).join("") +
            "</table>";
        },
      },
    };
    if (!tabs[ui.tab]) ui.tab = "speed";

    el.innerHTML = `<h1>Статистика</h1>
      <div class="page-grid stats-grid">
        ${card("Расходы", [
          row("Всего", `<b>${money(spentAll)}</b>`),
          ...Object.entries(kinds).map(([k, name]) => row(name, money(kindTotal(k)))),
          ...(other >= 0.005 ? [row("Прочее (не по видео)", money(other))] : []),
        ])}
        ${card(audioMode ? "Аудио" : "Видео", [
          row("Готово к правке", num(ready.length)),
          row("В обработке и ждут", num(all.length - ready.length)),
          row("Длительность", formatDuration(sum(all, (v) => v.duration))),
          row("Время в редакторе", formatMinutes(sum(all, (v) => v.editor_seconds) * 1000)),
          row("Место на диске", formatSize(sum(all, (v) => v.disk_total))),
        ])}
        ${card("Правка", [
          row("Фрагментов", num(sum(ready, (v) => v.fragments_total))),
          row("Отредактировано", `${num(editedAll)} (${pct(editedAll, barTotal)})`),
          row("Изменено", num(sum(ready, (v) => (v.edit_bar || {}).changed))),
          row("Удалено", num(sum(ready, (v) => v.deleted_total))),
        ])}
        ${card("Anki и перевод", [
          row("Карточек с текстом", num(cards)),
          row("В Anki", `${num(sum(ready, (v) => v.in_anki))} (${pct(sum(ready, (v) => v.in_anki), sum(ready, (v) => v.active_total))})`),
          row("Переведено", `${num(translated)} (${pct(translated, cards)})`),
          row("Вернулись на правку", num(sum(ready, (v) => v.flagged))),
        ])}
        <section class="set-card wide-card stats-tabs">
          <div class="seg-switch tab-bar">${Object.entries(tabs).map(([k, t]) => `<button data-k="${k}" class="${k === ui.tab ? "active" : ""}">${t.label}</button>`).join("")}</div>
          <div id="stats-tab"></div>
        </section>
      </div>`;

    // Содержимое вкладки (переключение – без перезагрузки страницы).
    const panel = el.querySelector("#stats-tab");
    const showTab = () => {
      panel.innerHTML = tabs[ui.tab].html();
      if (ui.tab === "speed" && data.results.length) {
        const list = [...data.results].sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at)));
        const ms = list.reduce((acc, r) => acc + r.ms, 0);
        drawSpeedChart(panel.querySelector("#speed-chart"), list, ms ? list.reduce((acc, r) => acc + r.frags, 0) / (ms / 60000) : 0);
        panel.querySelector("#speed-all").addEventListener("click", () => resultsModal(data.results, () => this.stats()));
      }
      const metricPicker = (id, key) => {
        const host = panel.querySelector(`.picker-host[data-for="${id}"]`);
        if (!host) return;
        Picker.create(host, {
          id, value: ui[key], options: metrics.map((m) => ({ value: m.key, label: m.label })),
          onChange: (value) => {
            ui[key] = value;
            showTab();
          },
        });
      };
      metricPicker("info-metric", "infoMetric");
      metricPicker("author-metric", "authorMetric");
      panel.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
        ui.dir = ui.sort === th.dataset.sort ? -ui.dir : th.dataset.sort === "title" ? 1 : -1;
        ui.sort = th.dataset.sort;
        showTab();
      }));
    };
    el.querySelectorAll(".tab-bar button").forEach((b) => b.addEventListener("click", () => {
      ui.tab = b.dataset.k;
      try {
        localStorage.setItem("stats-tab", ui.tab);
      } catch (_) {}
      el.querySelectorAll(".tab-bar button").forEach((x) => x.classList.toggle("active", x === b));
      showTab();
    }));
    viewEnter(el);
    showTab();
  },

  async settings() {
    const el = document.getElementById("view-settings");
    // Пока настройки грузятся, прошлое содержимое не показываем (иначе оно
    // мелькало и потом "появлялось" ещё раз – анимация как будто дважды).
    el.innerHTML = "";
    const [s, stores] = await Promise.all([Api.settings(), Api.storages().catch(() => [])]);
    const field = (id, label, control, hint) =>
      `<div class="field"><label class="field-label" for="${id}">${label}</label>${control}` +
      (hint ? `<div class="field-hint">${hint}</div>` : "") + "</div>";
    // Выпадающие списки (picker.js) ставятся в эти места после разметки.
    const modelField = (id, label, hint) => field(id, label, `<div class="picker-host" data-for="${id}"></div>`, hint);
    // Настройки – карточками по темам; кнопки – внизу справа.
    el.innerHTML = `<h1>Настройки</h1>
      <div id="settings-form" class="page-grid">
        <section class="set-card">
          <h2>Anki</h2>
          ${field("set-deck", "Колода", `<input id="set-deck" class="wide" value="${escapeHtml(s.anki_deck_root)}">`,
            "Карточки идут в &lt;колода&gt;::&lt;автор&gt;::&lt;видео&gt;; при смене уже созданные колоды всех видео переименовываются")}
          ${field("set-deck-audio", "Колода для аудио", `<input id="set-deck-audio" class="wide" value="${escapeHtml(s.anki_deck_root_audio || "")}">`,
            "Песни и другие аудио: &lt;колода&gt;::&lt;исполнитель&gt;::&lt;название&gt;")}
          <div id="deck-sync" class="small"></div>
        </section>
        <section class="set-card">
          <h2>Редактор</h2>
          ${field("set-padding", "Запас до и после отрезка",
            `<div class="with-unit"><input id="set-padding" type="number" min="0" step="0.5" value="${s.context_padding_seconds}"><span>сек</span></div>`,
            "По умолчанию для всех видео; уже отредактированные фрагменты не меняются")}
          <div class="field"><div class="field-label">Режимы при открытии</div>
            <label class="check"><input id="set-def-auto" type="checkbox" ${s.default_auto_play !== false ? "checked" : ""}> Автозапуск</label>
            <label class="check"><input id="set-def-stop" type="checkbox" ${s.default_stop_at_end !== false ? "checked" : ""}> Остановка на конце отрезка</label>
            <label class="check"><input id="set-def-skip" type="checkbox" ${s.default_skip_deleted !== false ? "checked" : ""}> Соседние фразы без удалённых</label>
            <label class="check"><input id="set-def-link-video" type="checkbox" ${s.default_link_video ? "checked" : ""}> Связанные границы – видео</label>
            <label class="check"><input id="set-def-link-audio" type="checkbox" ${s.default_link_audio !== false ? "checked" : ""}> Связанные границы – аудио</label>
          </div>
        </section>
        <section class="set-card">
          <h2>Добавление видео</h2>
          ${field("set-quality", "Качество скачивания", '<div class="picker-host" data-for="set-quality"></div>',
            "Для видео, добавленных по ссылке; клипы для Anki режутся из скачанного")}
          <div class="field"><label class="check"><input id="set-auto" type="checkbox" ${s.auto_process ? "checked" : ""}> Сразу обрабатывать</label></div>
        </section>
        <section class="set-card">
          <h2>Производительность</h2>
          ${field("set-reserve", "Свободные ядра процессора",
            `<div class="with-unit"><input id="set-reserve" type="number" min="0" max="${Math.max(0, (navigator.hardwareConcurrency || 8) - 1)}" step="1" value="${Number(s.reserve_cpu_cores ?? 2)}"><span>из ${navigator.hardwareConcurrency || "?"}</span></div>`,
            "Распознавание речи и перекодирование их не занимают – система не захлёбывается. Клипы для Anki кодирует видеокарта")}
          <div class="field"><label class="check"><input id="set-priority" type="checkbox" ${s.low_priority !== false ? "checked" : ""}> Пониженный приоритет обработки</label></div>
        </section>
        <!-- Цвета на карточках Anki – отдельный блок в две мини-карточки;
             рядом – пока пустой блок такой же ширины (под будущие настройки). -->
        <section class="set-card half-card">
          <h2>Цвета на карточках</h2>
          <div class="color-row">
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_en || "#c9b6ff")}"><input type="color" id="set-color-en" value="${escapeHtml(s.anki_color_en || "#c9b6ff")}"></span> Английский</label>
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_ru || "#f6edcf")}"><input type="color" id="set-color-ru" value="${escapeHtml(s.anki_color_ru || "#f6edcf")}"></span> Русский</label>
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_dash || "#7d7d88")}"><input type="color" id="set-color-dash" value="${escapeHtml(s.anki_color_dash || "#7d7d88")}"></span> Тире</label>
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_who || "#8a8a95")}"><input type="color" id="set-color-who" value="${escapeHtml(s.anki_color_who || "#8a8a95")}"></span> Говорящие</label>
          </div>
          <div class="field-hint">Новые карточки – сразу в этих цветах; уже готовые – кнопкой ниже (после «Сохранить»)</div>
          <div class="el-check-row"><button id="set-recolor" class="step-btn">Перекрасить готовые карточки</button><span id="set-recolor-note" class="muted small"></span></div>
        </section>
        <section class="set-card half-card empty-card"></section>
        <section class="set-card wide-card">
          <h2>Хранилище</h2>
          <!-- Диски: название и путь, заполненность (занято всего / из них медиа), убрать. -->
          <div class="field"><div class="field-label">Диски</div><div id="storages-list" class="store-list"></div></div>
          <input type="hidden" id="set-storages" value="${escapeHtml(JSON.stringify(s.storages || []))}">
          ${field("set-storage-new", "Добавить хранилище",
            '<div class="store-add"><input id="set-storage-new" class="wide" placeholder="D:\\media-study" data-watch="no"><button id="set-storage-add" class="step-btn" disabled>Добавить</button></div>',
            "Папка на другом диске (например, внешнем). Медиа переносятся кнопкой «Хранилище» в окне видео или аудио; в data/ остаётся ссылка")}
          <div class="field-row">
            ${field("set-new-storage", "Новые видео сохранять", '<div class="picker-host" data-for="set-new-storage"></div>',
              "Куда скачиваются и добавляются новые видео")}
            ${field("set-new-audio-storage", "Новые аудио сохранять", '<div class="picker-host" data-for="set-new-audio-storage"></div>',
              "Свои аудиофайлы; «Как видео» – туда же, куда видео")}
          </div>
        </section>
        <section class="set-card wide-card">
          <h2>Распознавание речи</h2>
          <div class="field-row">
            ${field("set-asr", "Движок", '<div class="picker-host" data-for="set-asr"></div>',
              "Whisper – локально и бесплатно (на видеокарте – в разы быстрее); ElevenLabs Scribe – по API, платно, ключ ниже")}
            ${field("set-el-key", "Ключ ElevenLabs", `<div class="secret-row"><input id="set-el-key" class="wide" type="password" autocomplete="off" value="${escapeHtml(s.elevenlabs_key || "")}" placeholder="sk_…"><button id="set-el-key-eye" class="icon-btn" title="Показать / скрыть"><svg viewBox="0 0 20 20"><path d="M1.8 10s3-5.5 8.2-5.5S18.2 10 18.2 10s-3 5.5-8.2 5.5S1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.6"/></svg></button></div>`,
              "elevenlabs.io → профиль → API Keys; нужен доступ «Speech to Text»")}
          </div>
          <!-- Локальный Whisper: модель (установлена ли), устройство, нагрузка на видеокарту. -->
          <div class="field-row">
            ${field("set-wh-model", "Модель Whisper", '<div class="wh-row"><div class="picker-host" data-for="set-wh-model"></div><button id="set-wh-install" class="step-btn hidden">Установить</button></div>',
              '<span id="set-wh-model-note">Скачивается один раз в кэш</span>')}
            ${field("set-wh-device", "Устройство", '<div class="picker-host" data-for="set-wh-device"></div>',
              '<span id="set-wh-gpu-note">Проверяю видеокарту…</span> <button id="set-wh-cuda" class="step-btn small-btn hidden">Установить библиотеки CUDA</button>')}
          </div>
          <div class="field"><label class="check"><input id="set-wh-gentle" type="checkbox" ${s.whisper_gentle ? "checked" : ""}> Бережная нагрузка на видеокарту</label>
            <div class="field-hint">Паузы между кусками и облегчённая точность – система и игры не подтормаживают, распознавание чуть дольше</div></div>
          <div class="field-row">
            ${field("set-el-model", "Модель ElevenLabs", `<input id="set-el-model" class="wide" value="${escapeHtml(s.elevenlabs_model || "scribe_v2")}">`, "scribe_v2 – самая точная")}
            ${field("set-el-lang", "Язык", `<input id="set-el-lang" class="wide" value="${escapeHtml(s.elevenlabs_language || "")}" placeholder="авто">`, "Код языка (en); пусто – определяется сам")}
          </div>
          ${field("set-el-proxy", "Прокси для ElevenLabs", `<input id="set-el-proxy" class="wide" value="${escapeHtml(s.elevenlabs_proxy || "")}" placeholder="socks5://127.0.0.1:1080 или http://127.0.0.1:10809">`,
            "ElevenLabs недоступен из некоторых стран – укажите прокси вашего VPN (или включите VPN на весь компьютер и оставьте пустым)")}
          <div class="field"><label class="check"><input id="set-el-terms" type="checkbox" ${s.elevenlabs_keyterms !== false ? "checked" : ""}> Подсказывать имена и термины из словаря</label>
            <div class="field-hint">+20% к цене распознавания</div></div>
          <div class="el-check-row"><button id="set-el-check" class="step-btn">Проверить подключение</button><span id="set-el-result" class="muted small"></span></div>
        </section>
        <section class="set-card wide-card">
          <h2>Агенты (OpenRouter)</h2>
          ${field("set-key", "Ключ", `<div class="secret-row"><input id="set-key" class="wide" type="password" autocomplete="off" value="${escapeHtml(s.openrouter_key || "")}" placeholder="sk-or-…"><button id="set-key-eye" class="icon-btn" title="Показать / скрыть"><svg viewBox="0 0 20 20"><path d="M1.8 10s3-5.5 8.2-5.5S18.2 10 18.2 10s-3 5.5-8.2 5.5S1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.6"/></svg></button></div>`,
            "Для перевода и поиска источников")}
          <div class="field-row">
            ${modelField("set-model", "Модель перевода",
              "Своя (идентификатор на OpenRouter) или из списка; цена – $ за млн токенов (вход / выход)")}
            ${modelField("set-search-model", "Модель поиска",
              "Ищет источники текста для сверки (с веб-поиском); запросов мало – лучше сильная модель")}
          </div>
        </section>
      </div>
      <section class="set-card wide-card hotkeys-card">
        <h2>Горячие клавиши редактора</h2>
        <table class="stats hotkeys-table">${HOTKEY_HELP.map(([keys, what]) =>
          `<tr><td>${keys.split(" / ").map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(" / ")}</td><td>${escapeHtml(what)}</td></tr>`).join("")}</table>
      </section>
      <div class="settings-actions"><span id="settings-note" class="muted small"></span><button id="settings-cancel" class="step-btn">Отменить</button><button id="settings-save" class="step-btn primary">Сохранить</button></div>`;
    const host = (id) => el.querySelector(`.picker-host[data-for="${id}"]`);
    // Хранилища: основное (data/) и добавленные; список правится до "Сохранить"
    // (скрытое поле set-storages – чтобы работали "Отменить" и вопрос при уходе).
    const storesField = el.querySelector("#set-storages");
    const listed = () => JSON.parse(storesField.value || "[]");
    const drawStores = () => {
      const extra = listed();
      const main = stores.find((x) => x.main);
      const rows = [main, ...extra.map((path) => stores.find((x) => !x.main && x.path.toLowerCase() === path.toLowerCase()) || { path, label: path.slice(0, 2), online: true, fresh: true })]
        .filter(Boolean).map((x) => {
          // Полоска: занято на диске всего (серым) и из этого – медиа приложения (синим).
          const pct = (n) => (x.total ? Math.min(100, (n / x.total) * 100).toFixed(1) : 0);
          const usage = !x.online ? '<span class="flagged-text small">Диск не подключён</span>'
            : x.fresh ? '<span class="muted small">Появится после «Сохранить»</span>'
              : `<div class="store-bar"><div class="store-busy" style="width:${pct(x.total - x.free)}%"></div><div class="store-app" style="width:${pct(x.used || 0)}%"></div></div>` +
                `<div class="muted small">Свободно ${formatSize(x.free)} из ${formatSize(x.total)} · медиа: ${x.videos || 0}${x.videos ? `, ${formatSize(x.used)}` : ""}</div>`;
          return `<div class="store-row"><div class="store-name"><span class="store-drive">${escapeHtml(x.label)}</span>` +
            `${x.main ? ' <span class="muted small">основное</span>' : ""}<div class="muted small store-path">${escapeHtml(x.path)}</div></div>` +
            `<div class="store-usage">${usage}</div>` +
            `<div>${x.main ? "" : `<button class="step-btn storage-remove" data-path="${escapeHtml(x.path)}" title="${x.videos ? "Сначала перенесите медиа с этого диска" : "Убрать из списка (файлы не удаляются)"}"${x.videos ? " disabled" : ""}>Убрать</button>`}</div></div>`;
        }).join("");
      el.querySelector("#storages-list").innerHTML = rows;
      el.querySelectorAll(".storage-remove").forEach((b) => b.addEventListener("click", () => {
        setStores(listed().filter((p) => p !== b.dataset.path));
      }));
    };
    const setStores = (list) => {
      storesField.value = JSON.stringify(list);
      storesField.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // И после "Отменить" (поле восстанавливается и шлёт input) – таблица и список заново.
    storesField.addEventListener("input", () => {
      drawStores();
      newStorePicker.setOptions(storeOptions());
      newAudioPicker.setOptions(audioStoreOptions());
    });
    const storeOptions = () => [{ value: "", label: `${(stores.find((x) => x.main) || {}).label || "Основное"} (основное)` },
      ...listed().map((p) => ({ value: p, label: `${(stores.find((x) => x.path.toLowerCase() === p.toLowerCase()) || { label: p.slice(0, 2) }).label} – ${p}` }))];
    const newStorePicker = Picker.create(host("set-new-storage"), { id: "set-new-storage", value: s.new_video_storage || "", options: storeOptions() });
    const audioStoreOptions = () => [{ value: "", label: "Как видео" }, ...storeOptions().filter((o) => o.value)];
    const newAudioPicker = Picker.create(host("set-new-audio-storage"), { id: "set-new-audio-storage", value: s.new_audio_storage || "", options: audioStoreOptions() });
    drawStores();
    const newInput = el.querySelector("#set-storage-new");
    const addButton = el.querySelector("#set-storage-add");
    newInput.addEventListener("input", () => (addButton.disabled = !newInput.value.trim()));
    addButton.addEventListener("click", () => {
      const path = newInput.value.trim().replace(/[\\/]+$/, "");
      if (path && !listed().some((p) => p.toLowerCase() === path.toLowerCase())) setStores([...listed(), path]);
      newInput.value = "";
      addButton.disabled = true;
    });
    // Перекраска готовых карточек приложения в сохранённые цвета (в фоне).
    el.querySelector("#set-recolor").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      const note = el.querySelector("#set-recolor-note");
      if (watcher.isDirty()) {
        note.textContent = "Сначала сохраните настройки";
        return;
      }
      button.disabled = true;
      try {
        await Api.json("/api/anki/recolor", { method: "POST" });
      } catch (err) {
        note.textContent = err.message;
        button.disabled = false;
        return;
      }
      const poll = async () => {
        if (!button.isConnected) return;
        const st = await Api.json("/api/anki/recolor");
        note.textContent = st.running ? `Перекрашиваю: ${st.done}/${st.total || "?"}`
          : st.error ? `Не получилось: ${st.error}` : `Готово: изменено ${st.changed} карточек`;
        if (st.running) setTimeout(poll, 1000);
        else button.disabled = false;
      };
      poll();
    });
    // Whisper: модели (установленные и нет), устройство, установка недостающего.
    const whModel = Picker.create(host("set-wh-model"), { id: "set-wh-model", value: s.whisper_model || "medium.en", options: [], onChange: () => drawAsr() });
    const whDevice = Picker.create(host("set-wh-device"), {
      id: "set-wh-device", value: s.whisper_device || "cpu",
      options: [{ value: "cpu", label: "Процессор" }, { value: "cuda", label: "Видеокарта (NVIDIA)" }],
      onChange: () => drawAsr(),
    });
    let asr = null;
    const drawAsr = () => {
      if (!asr || !el.isConnected) return;
      const models = asr.models;
      whModel.setOptions(models.map((m) => ({ value: m.name, label: m.label, hint: m.installed ? "установлена" : `${m.size_gb} ГБ` })));
      const chosen = models.find((m) => m.name === el.querySelector("#set-wh-model").value);
      const busy = (key) => asr.installs[key] && asr.installs[key].running;
      const failed = (key) => asr.installs[key] && asr.installs[key].error;
      const installBtn = el.querySelector("#set-wh-install");
      installBtn.classList.toggle("hidden", !chosen || chosen.installed);
      installBtn.disabled = !!(chosen && busy(`model:${chosen.name}`));
      installBtn.textContent = chosen && busy(`model:${chosen.name}`) ? "Устанавливаю…" : `Установить (${chosen ? chosen.size_gb : "?"} ГБ)`;
      el.querySelector("#set-wh-model-note").textContent = chosen && failed(`model:${chosen.name}`)
        ? `Не установилась: ${failed(`model:${chosen.name}`)}` : chosen && chosen.installed ? "Установлена" : "Не установлена – скачается при первом распознавании или кнопкой";
      const g = asr.gpu;
      const cudaBtn = el.querySelector("#set-wh-cuda");
      cudaBtn.classList.toggle("hidden", !g.available || g.libs);
      cudaBtn.disabled = !!busy("cuda");
      cudaBtn.textContent = busy("cuda") ? "Устанавливаю библиотеки…" : "Установить библиотеки CUDA (~1,2 ГБ)";
      el.querySelector("#set-wh-gpu-note").textContent = !g.available ? "Видеокарта NVIDIA не найдена – только процессор"
        : g.libs ? `${g.name.split(",")[0]} – готова` : failed("cuda") ? `Библиотеки не установились: ${failed("cuda")}` : `${g.name.split(",")[0]} – нужны библиотеки CUDA`;
      // Пока что-то ставится – обновлять.
      if (Object.values(asr.installs).some((x) => x.running)) setTimeout(loadAsr, 2000);
    };
    const loadAsr = async () => {
      try {
        asr = await Api.json("/api/asr/status");
      } catch (_) {
        return;
      }
      drawAsr();
    };
    loadAsr();
    el.querySelector("#set-wh-install").addEventListener("click", async () => {
      await Api.json("/api/asr/install", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: "model", name: el.querySelector("#set-wh-model").value }) });
      setTimeout(loadAsr, 300);
    });
    el.querySelector("#set-wh-cuda").addEventListener("click", async () => {
      await Api.json("/api/asr/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ what: "cuda" }) });
      setTimeout(loadAsr, 300);
    });
    // Образцы цвета: квадрат перекрашивается сразу при выборе.
    el.querySelectorAll(".color-pick input[type=color]").forEach((input) =>
      input.addEventListener("input", () => { input.parentElement.style.background = input.value; }));
    Picker.create(host("set-asr"), {
      id: "set-asr",
      value: s.asr_engine || "whisper",
      options: [{ value: "whisper", label: "Whisper (локально)" }, { value: "elevenlabs", label: "ElevenLabs Scribe (API)" }],
    });
    // Ключ ElevenLabs: показать/скрыть и проверка (с введёнными, ещё не сохранёнными значениями).
    el.querySelector("#set-el-key-eye").addEventListener("click", () => {
      const input = el.querySelector("#set-el-key");
      input.type = input.type === "password" ? "text" : "password";
    });
    el.querySelector("#set-el-check").addEventListener("click", async (e) => {
      const out = el.querySelector("#set-el-result");
      const button = e.currentTarget; // после await currentTarget уже пуст
      button.disabled = true;
      out.textContent = "Проверяю…";
      out.className = "muted small";
      try {
        const r = await Api.elevenlabsCheck(el.querySelector("#set-el-key").value.trim(), el.querySelector("#set-el-proxy").value.trim());
        out.textContent = r.message;
        out.className = `small ${r.ok ? "ok-text" : "flagged-text"}`;
      } catch (err) {
        out.textContent = err.message;
      }
      button.disabled = false;
    });
    Picker.create(host("set-quality"), {
      id: "set-quality",
      value: String(Number(s.download_max_height) || 0),
      options: [[0, "Лучшее доступное"], [2160, "4K (2160p)"], [1440, "2K (1440p)"], [1080, "Full HD (1080p)"], [720, "HD (720p)"]]
        .map(([h, label]) => ({ value: String(h), label })),
    });
    // Модели OpenRouter: по компании, внутри – по цене (дешевле – выше); список
    // общий для обоих полей, грузится при первом открытии.
    let modelsPromise = null;
    const loadModels = () => (modelsPromise ||= Api.openrouterModels().then((models) => models.map((m) => ({
      value: m.id, label: m.id, group: m.provider, hint: `$${m.prompt} / $${m.completion}`,
    }))));
    for (const id of ["set-model", "set-search-model"]) {
      Picker.create(host(id), {
        id, editable: true, load: loadModels, placeholder: "anthropic/claude-sonnet-5.5",
        value: (id === "set-model" ? s.openrouter_model : s.search_model) || "",
      });
    }
    // Заголовок, описание, карточки по очереди, кнопки.
    viewEnter(el, [el.querySelector("h1"), ...el.querySelectorAll(".set-card"), el.querySelector(".settings-actions")]);
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
    cancelButton.addEventListener("click", () => watcher.restore());
    const saveSettings = async () => {
      const note = document.getElementById("settings-note");
      note.textContent = "";
      let saved;
      try {
        saved = await Api.saveSettings({
        anki_deck_root: document.getElementById("set-deck").value.trim(),
        anki_deck_root_audio: document.getElementById("set-deck-audio").value.trim(),
        anki_color_en: document.getElementById("set-color-en").value,
        anki_color_ru: document.getElementById("set-color-ru").value,
        anki_color_dash: document.getElementById("set-color-dash").value,
        anki_color_who: document.getElementById("set-color-who").value,
        new_audio_storage: document.getElementById("set-new-audio-storage").value,
        context_padding_seconds: Number(document.getElementById("set-padding").value),
        download_max_height: Number(document.getElementById("set-quality").value),
        auto_process: document.getElementById("set-auto").checked,
        openrouter_key: document.getElementById("set-key").value.trim(),
        openrouter_model: document.getElementById("set-model").value.trim(),
        search_model: document.getElementById("set-search-model").value.trim(),
        reserve_cpu_cores: Math.max(0, Number(document.getElementById("set-reserve").value) || 0),
        low_priority: document.getElementById("set-priority").checked,
        storages: JSON.parse(document.getElementById("set-storages").value || "[]"),
        default_auto_play: document.getElementById("set-def-auto").checked,
        default_stop_at_end: document.getElementById("set-def-stop").checked,
        default_skip_deleted: document.getElementById("set-def-skip").checked,
        default_link_video: document.getElementById("set-def-link-video").checked,
        asr_engine: document.getElementById("set-asr").value,
        whisper_model: document.getElementById("set-wh-model").value,
        whisper_device: document.getElementById("set-wh-device").value,
        whisper_gentle: document.getElementById("set-wh-gentle").checked,
        elevenlabs_key: document.getElementById("set-el-key").value.trim(),
        elevenlabs_model: document.getElementById("set-el-model").value.trim() || "scribe_v2",
        elevenlabs_language: document.getElementById("set-el-lang").value.trim(),
        elevenlabs_proxy: document.getElementById("set-el-proxy").value.trim(),
        elevenlabs_keyterms: document.getElementById("set-el-terms").checked,
        default_link_audio: document.getElementById("set-def-link-audio").checked,
        new_video_storage: document.getElementById("set-new-storage").value,
        });
      } catch (err) {
        let message = err.message;
        try {
          message = JSON.parse(message).detail;
        } catch (_) {}
        note.textContent = cap(message);
        note.classList.add("error");
        throw err;
      }
      note.classList.remove("error");
      watcher.snapshot();
      applyEditorDefaults(saved); // режимы редактора – сразу
      watchDeckSync(saved.deck_sync);
    };
    // Ошибка (например, модели нет на OpenRouter) уже показана слева от кнопок.
    saveButton.addEventListener("click", () => saveSettings().catch(() => {}));
    // Для вопроса при уходе со страницы (Router.route).
    this.settingsGuard = { isDirty: () => watcher.isDirty(), save: saveSettings, restore: () => watcher.restore() };
  },
};

// Журналы (кнопка внизу меню): сервер, передача в Anki, перевод – окно поверх
// всего, строки дописываются по мере появления (раз в секунду), с цветом:
// ошибки – красным, предупреждения – жёлтым, запросы – по коду ответа.
const LogViewer = {
  TABS: [["server", "Сервер"], ["anki", "Передача в Anki"], ["translate", "Перевод"]],
  el: null,
  name: "server",
  next: null,
  timer: null,

  open() {
    if (this.el) return;
    const el = (this.el = document.createElement("div"));
    el.className = "log-overlay";
    el.innerHTML = `<div class="log-window" role="dialog">
        <div class="log-head">${this.TABS.map(([k, t]) => `<button class="log-tab" data-k="${k}">${t}</button>`).join("")}
          <span class="log-follow muted small"></span><button class="log-close" title="Закрыть (Esc)">×</button></div>
        <pre class="log-body"></pre></div>`;
    el.addEventListener("mousedown", (e) => e.target === el && this.close());
    el.querySelector(".log-close").addEventListener("click", () => this.close());
    el.querySelectorAll(".log-tab").forEach((b) => b.addEventListener("click", () => this.show(b.dataset.k)));
    this.onKey = (e) => e.key === "Escape" && (e.stopPropagation(), this.close());
    document.addEventListener("keydown", this.onKey, true);
    document.body.appendChild(el);
    this.show(this.name);
  },

  close() {
    if (!this.el) return;
    clearTimeout(this.timer);
    document.removeEventListener("keydown", this.onKey, true);
    this.el.remove();
    this.el = null;
  },

  show(name) {
    this.name = name;
    this.next = null;
    this.el.querySelectorAll(".log-tab").forEach((b) => b.classList.toggle("active", b.dataset.k === name));
    this.el.querySelector(".log-body").innerHTML = "";
    clearTimeout(this.timer);
    this.poll();
  },

  async poll() {
    if (!this.el) return;
    const body = this.el.querySelector(".log-body");
    const name = this.name;
    try {
      const q = this.next === null ? "" : `&since=${this.next}`;
      const data = await Api.json(`/api/logs?name=${name}${q}`);
      if (!this.el || name !== this.name) return;
      // Внизу – прокручиваем за новыми строками; пролистали вверх – не мешаем.
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      if (data.text) body.insertAdjacentHTML("beforeend", this.paint(data.text));
      this.next = data.next;
      if (atBottom) body.scrollTop = body.scrollHeight;
      this.el.querySelector(".log-follow").textContent = atBottom ? "" : "Прокрутка остановлена – новые строки внизу";
    } catch (_) {
      body.insertAdjacentHTML("beforeend", '<span class="lg-err">Сервер не отвечает</span>\n');
    }
    this.timer = setTimeout(() => this.poll(), 1000);
  },

  paint(text) {
    return text.replace(/\r/g, "").split("\n").map((line, k, all) => {
      if (k === all.length - 1 && !line) return "";
      const html = escapeHtml(line);
      if (/Traceback|Error|ERROR|Exception|ОШИБКА|не смог|не удалось|не скачалось/.test(line)) return `<span class="lg-err">${html}</span>\n`;
      if (/^\s+(File |\^|raise )/.test(line)) return `<span class="lg-trace">${html}</span>\n`;
      if (/WARNING|предупрежд/i.test(line)) return `<span class="lg-warn">${html}</span>\n`;
      // Запрос: метод и путь – акцентом, код ответа – по цвету.
      const req = /^(INFO:\s+)(.*?")(GET|POST|PATCH|PUT|DELETE)( [^ ]+ )(HTTP\/[\d.]+")( )(\d{3})(.*)$/.exec(line);
      if (req) {
        const code = Number(req[7]);
        const cls = code >= 500 ? "lg-err" : code >= 400 ? "lg-warn" : "lg-ok";
        return `<span class="lg-info">${escapeHtml(req[1])}</span><span class="lg-dim">${escapeHtml(req[2])}</span>` +
          `<span class="lg-method">${req[3]}</span>${escapeHtml(req[4])}<span class="lg-dim">${escapeHtml(req[5])}</span> ` +
          `<span class="${cls}">${req[7]}</span><span class="lg-dim">${escapeHtml(req[8])}</span>\n`;
      }
      if (/^INFO:/.test(line)) return `<span class="lg-info">INFO:</span>${escapeHtml(line.slice(5))}\n`;
      return `${html}\n`;
    }).join("");
  },
};

// Кнопки внизу меню: журнал, перезапуск и остановка сервера.
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("server-log").addEventListener("click", () => LogViewer.open());
  // Перезапуск: сервер поднимает свою копию и выходит; вкладка, заметив новый
  // сервер, перезагружается сама (Heartbeat).
  document.getElementById("server-restart").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    button.classList.add("spinning");
    try {
      await Api.json("/api/restart", { method: "POST" });
    } catch (_) {}
    setTimeout(() => {
      button.disabled = false;
      button.classList.remove("spinning");
    }, 15000);
  });
  document.getElementById("server-stop").addEventListener("click", async () => {
    const answer = await askConfirm({
      title: "Остановить сервер?",
      text: "Приложение перестанет отвечать, пока вы снова не запустите <b>open_editor.bat</b>. Фоновые процессы – обработка, передача в Anki, перевод – доделают своё.",
      yes: "Остановить", no: "Отмена", danger: true,
    });
    if (answer !== "yes") return;
    try {
      await Api.json("/api/shutdown", { method: "POST" });
    } catch (_) {}
    const banner = document.createElement("div");
    banner.className = "stale-banner";
    banner.textContent = "Сервер остановлен. Чтобы продолжить, запустите open_editor.bat – эта вкладка обновится сама.";
    document.body.prepend(banner);
  });
});

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
    if (State.project) {
      Api.editState(State.project).then((lock) => {
        const link = document.getElementById("menu-editing-link");
        if (!link) return;
        link.classList.toggle("locked", !!lock.locked);
        link.title = lock.locked ? lock.reason : "";
      }).catch(() => {});
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
      // Перенос на другой диск – серым.
      const cls = a.kind === "move" ? "moving" : a.kind === "translate" ? "translated" : a.kind === "phase1" ? (a.step === "download" ? "downloading" : "accepted") : "ok";
      const bar = has ? `<div class="progress thin" data-bar="p"><div class="seg ${cls}" data-w="${a.percent}" style="width:${a.percent}%"></div></div>` : "";
      return `<div class="activity-item" data-key="${escapeHtml(`${a.kind}:${a.id}`)}"><div class="activity-name">${escapeHtml(a.title)}</div>` +
        `<div class="activity-line">${escapeHtml(cap(a.label))}${has ? `: ${Math.floor(a.percent)}%` : ""}` +
        `${a.detail ? ` – ${escapeHtml(a.detail)}` : ""}</div>${bar}</div>`;
    }).join("");
    animateBars(box, snap);
  },
};
