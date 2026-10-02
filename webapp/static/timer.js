// Таймер правки – поверх плеера, слева сверху.
//
// Маленькая квадратная кнопка с секундомером. Нажал – она становится ×, а
// справа выезжают: старт / пауза, сброс (серый, пока на нуле), время,
// сколько фрагментов отредактировано за это время и скорость. × – свернуть
// (таймер продолжает считать в фоне). Нажатие на время, фрагменты или
// скорость – скопировать это значение.
//
// Фрагменты считаются по скрытой метке "отредактировано" (последний
// изменённый фрагмент видео + 1 – то же число, что "Отредактировано N / M" на
// карточке видео): за период – насколько она продвинулась, пока таймер шёл.
// Сменил видео на ходу – продвижение по прежнему видео сохраняется, по новому
// считается от его текущей метки. Состояние переживает перезагрузку страницы
// (localStorage; если он недоступен – просто живёт до перезагрузки).
const EditTimer = {
  KEY: "edit-timer",
  // Состояние: ms – накоплено до текущего запуска; startedAt – когда запущен
  // (null – на паузе); frags – фрагментов накоплено; base / baseProject –
  // метка видео в момент запуска (или смены видео); open – панель раскрыта.
  st: { ms: 0, startedAt: null, frags: 0, base: null, baseProject: null, open: false },
  el: null,
  tick: null,

  init() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.KEY) || "null");
      if (saved) this.st = { ...this.st, ...saved };
    } catch (_) {}
    const wrap = document.getElementById("video-wrap");
    if (!wrap) return;
    const el = (this.el = document.createElement("div"));
    el.id = "edit-timer";
    el.innerHTML = `
      <button class="et-toggle" title="Таймер правки"></button>
      <div class="et-panel">
        <button class="et-btn et-run"></button>
        <button class="et-btn et-reset" title="Сбросить">
          <svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 3.5v3h3"/></svg>
        </button>
        <button class="et-info et-time" title="Время (нажмите – скопировать)"></button>
        <button class="et-info et-frags" title="Отредактировано фрагментов за это время (нажмите – скопировать)"></button>
        <button class="et-info et-speed" title="Скорость (нажмите – скопировать)"></button>
      </div>`;
    wrap.appendChild(el);
    // Клики по таймеру не доходят до видео (клик по видео – воспроизведение,
    // правая кнопка – приближение).
    for (const type of ["mousedown", "click", "dblclick", "contextmenu", "pointerdown"]) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    el.querySelector(".et-toggle").addEventListener("click", () => this.setOpen(!this.st.open));
    el.querySelector(".et-run").addEventListener("click", () => (this.st.startedAt ? this.pause() : this.start()));
    el.querySelector(".et-reset").addEventListener("click", () => this.reset());
    el.querySelectorAll(".et-info").forEach((b) => b.addEventListener("click", () => this.copy(b)));
    // Кнопки не забирают фокус – горячие клавиши редактора продолжают работать.
    el.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
    this.render();
    this.tick = setInterval(() => this.update(), 1000);
  },

  // Скрытая метка открытого видео (null – видео не открыто).
  mark() {
    const fragments = State.manifest && State.manifest.fragments;
    if (!fragments) return null;
    if (State.manifest.settings && State.manifest.settings.finished) return fragments.length;
    let last = -1;
    fragments.forEach((f, i) => {
      if (isTouched(f)) last = i;
    });
    return last + 1;
  },

  // Продвижение метки с последнего запуска / смены видео (не меньше нуля:
  // отмена правок может вернуть метку назад – тогда и счёт меньше).
  progress() {
    if (!this.st.startedAt || this.st.base === null) return 0;
    if (State.project !== this.st.baseProject) return 0;
    const mark = this.mark();
    return mark === null ? 0 : mark - this.st.base;
  },

  // Сменили видео на ходу: продвижение по прежнему – в копилку, база – новая.
  follow() {
    if (!this.st.startedAt || !State.project || State.project === this.st.baseProject) return;
    if (this.st.lastProgress) this.st.frags += this.st.lastProgress;
    this.st.lastProgress = 0;
    this.st.baseProject = State.project;
    this.st.base = this.mark();
    this.save();
  },

  elapsed() {
    return this.st.ms + (this.st.startedAt ? Date.now() - this.st.startedAt : 0);
  },

  frags() {
    return Math.max(0, this.st.frags + this.progress());
  },

  start() {
    this.st.startedAt = Date.now();
    this.st.baseProject = State.project || null;
    this.st.base = this.mark();
    this.st.lastProgress = 0;
    this.save();
    this.render();
  },

  pause() {
    this.follow(); // сменили видео перед самой паузой – продвижение по прежнему не теряется
    this.st.frags = this.frags();
    this.st.ms = this.elapsed();
    this.st.startedAt = null;
    this.st.base = null;
    this.st.lastProgress = 0;
    this.save();
    this.render();
  },

  reset() {
    const running = !!this.st.startedAt;
    this.st.ms = 0;
    this.st.frags = 0;
    this.st.startedAt = null;
    if (running) this.start(); // шёл – идёт дальше с нуля
    this.save();
    this.render();
  },

  setOpen(open) {
    this.st.open = open;
    this.save();
    this.render();
  },

  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(this.st));
    } catch (_) {}
  },

  // Тексты значений (они же копируются).
  texts() {
    const ms = this.elapsed();
    const s = Math.floor(ms / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const time = `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    const n = this.frags();
    const perMin = ms >= 1000 ? n / (ms / 60000) : 0;
    return {
      time,
      frags: `${n} ${plural(n, "фрагмент", "фрагмента", "фрагментов")}`,
      speed: `${perMin.toFixed(2)}/мин (${Math.round(perMin * 60)}/ч)`,
    };
  },

  update() {
    this.follow();
    if (this.st.startedAt) {
      this.st.lastProgress = this.progress();
      this.save(); // переживает перезагрузку
    }
    if (this.st.open) this.render();
  },

  render() {
    if (!this.el) return;
    const el = this.el;
    const open = this.st.open;
    const running = !!this.st.startedAt;
    el.classList.toggle("open", open);
    el.classList.toggle("running", running);
    el.querySelector(".et-toggle").innerHTML = open
      ? '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>'
      : '<svg viewBox="0 0 20 20"><circle cx="10" cy="11" r="6"/><path d="M10 11V8M8.5 3h3M15 6l1-1"/></svg>';
    el.querySelector(".et-toggle").title = open ? "Свернуть (таймер считает дальше)" : "Таймер правки" + (running ? " – идёт" : "");
    const run = el.querySelector(".et-run");
    run.innerHTML = running
      ? '<svg viewBox="0 0 20 20"><path d="M7 5v10M13 5v10" stroke-width="2.6"/></svg>'
      : '<svg viewBox="0 0 20 20"><path d="M7 5l8 5-8 5z" fill="currentColor"/></svg>';
    run.title = running ? "Пауза" : "Старт";
    el.querySelector(".et-reset").disabled = this.elapsed() < 1000 && !this.frags();
    const t = this.texts();
    el.querySelector(".et-time").textContent = t.time;
    el.querySelector(".et-frags").textContent = t.frags;
    el.querySelector(".et-speed").textContent = t.speed;
  },

  async copy(button) {
    const t = this.texts();
    const text = button.classList.contains("et-time") ? t.time : button.classList.contains("et-frags") ? String(this.frags()) : t.speed;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      return;
    }
    button.classList.remove("copied");
    void button.offsetWidth; // перезапустить вспышку
    button.classList.add("copied");
  },
};

document.addEventListener("DOMContentLoaded", () => EditTimer.init());
