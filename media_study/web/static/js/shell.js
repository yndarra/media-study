

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

// Горячие клавиши редактора – список в настройках (сами клавиши – в js/editor/input.js, HOTKEYS и обработчики).
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
    // Первая отрисовка – без переезда пилюли; дальше переключения плавные.
    const sw = document.getElementById("mode-switch");
    sw.classList.add("no-anim");
    this.paint();
    requestAnimationFrame(() => requestAnimationFrame(() => sw.classList.remove("no-anim")));
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
    if (changed) this.restartFlow(kind);
    if (changed && reroute && ["videos", "process", "add", "stats"].includes(State.view)) {
      if (State.view === "videos") location.hash = "#/media";
      Router.route(true);
    }
  },

  // Перелив выбранного режима – с начала цикла: у видео с голубого, у аудио с
  // розового (иначе он продолжался бы с того места, где шёл в фоне).
  // Перезапускаются только слои нового режима (градиент пилюли и обводка),
  // старые продолжают переливаться, пока плавно гаснут.
  restartFlow(kind) {
    const sw = document.getElementById("mode-switch");
    const pill = sw.querySelector(`.pill-${kind}`);
    const border = kind === "video" ? "::before" : "::after";
    for (const a of document.getAnimations()) {
      const e = a.effect;
      if (!(a instanceof CSSAnimation) || !e) continue; // плавное появление (transition) не трогаем
      if (e.target === pill || (e.target === sw && e.pseudoElement === border)) a.currentTime = 0;
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
    // Раздел считается открытым и тогда, когда адрес другой, но ведёт туда же:
    // после закрытия окна видео адрес – #/videos или #/audio, а ссылка меню –
    // #/media (раньше такой клик лишь тихо перерисовывал список – казалось,
    // что ничего не произошло).
    document.querySelectorAll("#menu a[data-menu]").forEach((link) => link.addEventListener("click", (e) => {
      const same = location.hash === link.getAttribute("href");
      const sameSection = link.classList.contains("active") && !document.getElementById("modal-overlay");
      if (!same && !sameSection) return;
      if (State.view === "settings" && Pages.settingsGuard && Pages.settingsGuard.isDirty()) return;
      if (!same) {
        // Адрес – как у ссылки, но без hashchange (иначе раздел показался бы дважды).
        e.preventDefault();
        history.replaceState(null, "", link.getAttribute("href"));
      }
      this.route(true);
    }));
    this.route();
  },

  async route(full = false) {
    // Интерфейс обновился, пока вкладка ждала (например, в настройках) –
    // перезагрузиться при переходе в другой раздел (адрес уже новый).
    if (typeof Heartbeat !== "undefined" && Heartbeat.reloadPending && !location.hash.startsWith("#/settings")) {
      const a = document.activeElement;
      const typing = a && (a.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName));
      if (!typing && !document.querySelector(".ask-overlay")) {
        Heartbeat.reload();
        return;
      }
    }
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
      // Окно подробностей – прочь сразу, без затухания, и дать браузеру его
      // убрать с экрана до того, как начнёт строиться редактор (большое видео
      // строится заметное время – окно висело, и казалось, что всё зависло).
      document.querySelectorAll(".modal-overlay").forEach((o) => o.remove());
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
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
    // Ушли из редактора – плеер отпускает файл видео (см. Player.release).
    if (view !== "editor" && typeof Player !== "undefined") Player.release();
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
      "#main .view:not(.hidden) :is(.card, .set-card, .group-title, .page-head, .page-note, #app), " +
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
      text: "Приложение перестанет отвечать, пока вы снова не запустите <b>start.bat</b>. Фоновые процессы – обработка, передача в Anki, перевод – доделают своё.",
      yes: "Остановить", no: "Отмена", danger: true,
    });
    if (answer !== "yes") return;
    try {
      await Api.json("/api/shutdown", { method: "POST" });
    } catch (_) {}
    const banner = document.createElement("div");
    banner.className = "stale-banner";
    banner.textContent = "Сервер остановлен. Чтобы продолжить, запустите start.bat – эта вкладка обновится сама.";
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
    // Перекраска карточек Anki: правка и всё, что пишет в Anki, недоступны
    // (сервер такие запросы тоже отклоняет).
    const locked = items.some((a) => a.lock);
    document.body.classList.toggle("anki-locked", locked);
    State.ankiLocked = locked;
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
