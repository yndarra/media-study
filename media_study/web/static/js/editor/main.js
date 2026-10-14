// Связь с сервером: раз в секунду вкладка отмечается. Если сервер
// перезапустили (start.bat), самая свежая вкладка перезагружается
// сама, остальные показывают, что устарели.
const Heartbeat = {
  clientId: Math.random().toString(36).slice(2) + Date.now().toString(36),
  openedAt: Date.now(),
  instance: null,
  timer: null,

  start() {
    this.timer = setInterval(() => this.beat(), 1000);
    this.beat();
  },

  async beat() {
    let info;
    try {
      const res = await fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId, opened_at: this.openedAt, project: State.project, editing: State.view === "editor" }),
      });
      if (!res.ok) return;
      info = await res.json();
    } catch (_) {
      return; // сервер перезапускается — ждём
    }
    if (info.stage3) App.onStage3(info.stage3);
    if (info.translated_ids) {
      const next = new Set(info.translated_ids);
      const same = next.size === State.translatedIds.size && [...next].every((id) => State.translatedIds.has(id));
      if (!same) {
        State.translatedIds = next;
        FragList.schedule();
        if (State.view === "editor" && currentFragment()) App.renderStatus(currentFragment());
      }
    }
    // Это видео переносится на другой диск – отпустить его файл в плеере.
    if (State.project && (info.moving || []).includes(State.project)) Player.release();
    if (this.instance === null) {
      this.instance = info.instance;
      this.ui = info.ui;
      return;
    }
    // Поменялся интерфейс (html/js/css) без перезапуска сервера – тоже
    // перезагрузиться, но не посреди набора текста и не с несохранённым.
    // Любая открытая вкладка (не только самая новая): иначе вторая вкладка
    // так и оставалась со старым интерфейсом, и обновлять приходилось руками.
    if (info.ui !== this.ui && info.ready) this.reloadPending = true;
    if (this.reloadPending && info.instance === this.instance) {
      if (this.safeToReload()) this.reload();
      return;
    }
    if (info.instance === this.instance || !info.ready) return;
    if (info.newest) {
      // Сервер перезапущен – перезагрузиться, как только это ничего не испортит.
      this.reloadPending = true;
      if (this.safeToReload()) {
        clearInterval(this.timer);
        this.reload();
      }
    } else {
      clearInterval(this.timer);
      const banner = document.createElement("div");
      banner.className = "stale-banner";
      banner.textContent = "Редактор перезапущен — работайте в свежей вкладке, эта устарела.";
      document.body.prepend(banner);
      document.title = "(устарела) " + document.title;
    }
  },

  // Можно ли перезагрузить страницу сейчас: не пишем в поле, нет открытого
  // вопроса и несохранённых изменений (окно видео, настройки).
  safeToReload() {
    const a = document.activeElement;
    if (a && (a.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName))) return false;
    if (document.querySelector(".ask-overlay")) return false;
    if (typeof Modal !== "undefined" && Modal.guard && Modal.guard.isDirty && Modal.guard.isDirty()) return false;
    // В настройках – никогда: перезагрузка сразу после "Сохранить" выглядела
    // как сброс страницы. Свежий интерфейс подхватится при переходе в другой раздел.
    if (State.view === "settings") return false;
    return true;
  },

  async reload() {
    if (this.reloading) return; // уже перезагружаемся (сохранение ещё идёт)
    this.reloading = true;
    clearInterval(this.timer);
    try {
      await App.flushSaves(); // правки фрагмента – на сервер до перезагрузки
    } catch (_) {}
    location.reload();
  },
};

window.addEventListener("DOMContentLoaded", () => {
  Api.settings().then(applyEditorDefaults).catch(() => {});
  Heartbeat.start();
  Player.init();
  Letterbox.init();
  Timeline.init();
  App.updatePlayButton();
  App.updateModeButton();
  FragList.init();
  Router.start();
});
