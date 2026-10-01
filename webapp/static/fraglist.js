// Правый сайдбар редактора: прокручиваемый список всех фрагментов видео.
//
// Клик по строке — переход к фрагменту. Номер и текст строки — цвет правки
// (как полоса "Отредактировано"): синий — просмотрен и принят без правок (до
// скрытой метки), жёлтый — изменён, красный — удалён; серый — ещё не тронут.
// Значок слева от номера (в своей колонке — номера не сдвигаются) — этап Anki:
// зелёная галочка — в Anki, розовый значок перевода — в Anki и переведён,
// жёлтые часы — передан, ждёт своей очереди (править уже нельзя),
// фиолетовая стрелка — вернулся из Anki на доработку. Значок появляется плавно.
// Удалённые и пустые фрагменты (карточек у них нет) получают "в Anki" и
// "переведён" по очереди — когда очередь передачи / перевод дошли до них.
//
// Фильтр: все / требуют доработки (ещё не в Anki) / вернулись из Anki. Кнопки
// "вперёд"/"назад" и A/D при фильтре ходят по фрагментам фильтра.
//
// Список перестраивается не чаще раза за кадр отрисовки: renderAll вызывается
// очень часто (например, при перетаскивании границы). Строки не пересоздаются,
// а обновляются на месте — поэтому смена фона анимируется.
const FragList = {
  el: null,
  filter: "all",
  pending: false,
  lastCurrent: -1,
  keys: "", // id показанных строк – если те же, строки обновляются на месте

  init() {
    this.el = document.getElementById("fraglist-items");
    this.picker = Picker.create(document.getElementById("fraglist-filter-host"), {
      id: "fraglist-filter",
      value: "all",
      options: this.filterOptions(),
      onChange: (value) => {
        this.filter = value;
        this.lastCurrent = -1;
        this.render();
        App.renderNav();
      },
    });
    this.el.addEventListener("click", (e) => {
      const row = e.target.closest("[data-index]");
      if (row) App.go(Number(row.dataset.index));
    });
  },

  reset() {
    this.lastCurrent = -1;
    this.keys = "";
    this.schedule();
  },

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  },

  // Последний просмотренный фрагмент (скрытая метка, как в webapp/library.py).
  _reviewed() {
    const fragments = State.manifest.fragments;
    if ((State.manifest.settings || {}).finished) return fragments.length - 1;
    let last = -1;
    fragments.forEach((f, i) => {
      if (isTouched(f)) last = i;
    });
    return last;
  },

  // Цвет правки (номер и текст).
  editClass(f, i, reviewed) {
    if (f.status !== "active") return "deleted";
    if (isTextEdited(f) || isBoundsEdited(f) || f.context_custom || f.merged_from || f.split_from) return "changed";
    if (isUnvoiced(f)) return "unvoiced";
    return i <= reviewed ? "accepted" : "";
  },

  // Где сейчас очередь передачи в Anki и перевод (для удалённых и пустых
  // фрагментов — у них своей карточки нет, статус идёт "по очереди").
  _queue() {
    const fragments = State.manifest.fragments;
    const pending = new Set(State.stage3.pending_ids);
    let firstPending = Infinity;
    let firstUntranslated = Infinity;
    let anyTranslated = false;
    fragments.forEach((g, i) => {
      if (!g.exported || g.status !== "active") return;
      if (pending.has(g.id)) firstPending = Math.min(firstPending, i);
      else if ((g.text || "").trim()) {
        if (State.translatedIds.has(g.id)) anyTranslated = true;
        else firstUntranslated = Math.min(firstUntranslated, i);
      }
    });
    return { firstPending, firstUntranslated: Math.min(firstUntranslated, firstPending), anyTranslated };
  },

  // Этап Anki фрагмента (значок в списке, фон редактора).
  stageClass(f, i = State.manifest.fragments.indexOf(f), queue = this._queue()) {
    if (f.anki_flagged && !f.exported) return "bg-returned";
    if (!f.exported) return "";
    const ownCard = f.status === "active" && (f.text || "").trim();
    if (State.stage3.pending_ids.includes(f.id)) return "bg-pending";
    // Без своей карточки — ждёт, пока очередь передачи дойдёт до него.
    if (!ownCard && i > queue.firstPending) return "bg-pending";
    if (ownCard) return State.translatedIds.has(f.id) ? "bg-translated" : "bg-anki";
    // ...и "переведён" — когда перевод прошёл дальше него.
    return queue.anyTranslated && i < queue.firstUntranslated ? "bg-translated" : "bg-anki";
  },

  // Пункты фильтра с числом фрагментов в каждом.
  filterOptions() {
    const fragments = (State.manifest && State.manifest.fragments) || [];
    const count = (filter) => fragments.filter((f) => this.visible(f, filter)).length;
    return [
      { value: "all", label: "Все фрагменты", count: count("all") },
      { value: "todo", label: "Не отредактировано", count: count("todo") },
      { value: "flagged", label: "Вернулись из Anki", count: count("flagged") },
    ];
  },

  visible(f, filter = this.filter) {
    if (filter === "todo") return !f.exported;
    if (filter === "flagged") return f.anki_flagged && !f.exported;
    return true;
  },

  // Индекс фрагмента на step шагов вперёд/назад среди видимых в фильтре (null — нет).
  stepIndex(from, step) {
    const fragments = State.manifest.fragments;
    const direction = Math.sign(step);
    let left = Math.abs(step);
    let found = null;
    for (let i = from + direction; i >= 0 && i < fragments.length; i += direction) {
      if (!this.visible(fragments[i])) continue;
      found = i;
      if (--left === 0) return i;
    }
    // Шагов больше, чем осталось: ±10 доходит до крайнего видимого; ±1 — нет.
    return Math.abs(step) > 1 ? found : null;
  },

  render() {
    if (!this.el || !State.manifest || State.view !== "editor") return;
    const fragments = State.manifest.fragments;
    const reviewed = this._reviewed();
    const queue = this._queue();
    const shownRows = [];
    fragments.forEach((f, i) => {
      if (!this.visible(f)) return;
      const first = (f.text || "").split("\n")[0].trim() || "(без слов)";
      const flag = f.anki_flagged && !f.exported ? "⚑ " : "";
      const classes = ["frag-row", this.editClass(f, i, reviewed), this.stageClass(f, i, queue), i === State.fragmentIndex ? "current" : ""]
        .filter(Boolean).join(" ");
      shownRows.push({ i, id: f.id, classes, text: flag + first });
    });
    const keys = shownRows.map((r) => r.id).join(",");
    if (keys === this.keys && this.el.children.length === shownRows.length) {
      // Те же строки — обновить на месте (фон меняется плавно, см. styles.css).
      shownRows.forEach((r, k) => {
        const row = this.el.children[k];
        if (row.className !== r.classes) row.className = r.classes;
        const num = row.children[1];
        const text = row.lastChild;
        if (num.textContent !== String(r.i + 1)) num.textContent = String(r.i + 1);
        if (text.textContent !== r.text) text.textContent = r.text;
        row.dataset.index = r.i;
      });
    } else {
      // Новый набор строк: сначала без фона, кадром позже — с фоном (фон проявляется).
      this.keys = keys;
      this.el.innerHTML = shownRows.map((r) =>
        `<div class="${r.classes.replace(/ bg-[a-z]+/, "")}" data-index="${r.i}">` +
        `<span class="frag-icon"></span><span class="frag-num">${r.i + 1}</span><span class="frag-text">${escapeHtml(r.text)}</span></div>`).join("") ||
        '<div class="frag-empty">Нет таких фрагментов</div>';
      if (shownRows.length) {
        this.el.getBoundingClientRect();
        requestAnimationFrame(() => shownRows.forEach((r, k) => {
          const row = this.el.children[k];
          if (row) row.className = r.classes;
        }));
      }
    }
    // Числа в фильтре – обновить, если поменялись.
    const options = this.filterOptions();
    const counts = options.map((o) => o.count).join(",");
    if (this.picker && counts !== this.lastCounts) {
      this.lastCounts = counts;
      this.picker.setOptions(options);
    }
    // Текущий фрагмент держим в поле зрения, но только когда он сменился —
    // иначе список дёргался бы при любой правке.
    if (this.lastCurrent !== State.fragmentIndex) {
      this.lastCurrent = State.fragmentIndex;
      const row = this.el.querySelector(".current");
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  },
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
