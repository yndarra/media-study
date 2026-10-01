// Правый сайдбар редактора: прокручиваемый список всех фрагментов видео.
//
// Клик по строке — переход к фрагменту. Номер и текст строки — цвет правки
// (как полоса "Отредактировано"): синий — просмотрен и принят без правок (до
// скрытой метки), жёлтый — изменён, красный — удалён; серый — ещё не тронут.
// Фон всей строки (как строка в git diff) — этап Anki: зеленоватый — в Anki,
// розоватый — в Anki и переведён, желтоватый — передаётся (в очереди),
// фиолетоватый — вернулся из Anki на доработку. Фон появляется плавно — и
// при открытии списка, и когда фрагменты уходят в Anki / переводятся на глазах.
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
    const select = document.getElementById("fraglist-filter");
    select.addEventListener("change", () => {
      this.filter = select.value;
      this.lastCurrent = -1;
      this.render();
      App.renderNav();
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
    return i <= reviewed ? "accepted" : "";
  },

  // Фон строки — этап Anki.
  stageClass(f) {
    if (f.anki_flagged && !f.exported) return "bg-returned";
    if (!f.exported) return "";
    if (State.stage3.pending_ids.includes(f.id)) return "bg-pending";
    return State.translatedIds.has(f.id) ? "bg-translated" : "bg-anki";
  },

  visible(f) {
    if (this.filter === "todo") return !f.exported;
    if (this.filter === "flagged") return f.anki_flagged && !f.exported;
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
    const shownRows = [];
    fragments.forEach((f, i) => {
      if (!this.visible(f)) return;
      const first = (f.text || "").split("\n")[0].trim() || "(без слов)";
      const flag = f.anki_flagged && !f.exported ? "⚑ " : "";
      const classes = ["frag-row", this.editClass(f, i, reviewed), this.stageClass(f), i === State.fragmentIndex ? "current" : ""]
        .filter(Boolean).join(" ");
      shownRows.push({ i, id: f.id, classes, text: flag + first });
    });
    const keys = shownRows.map((r) => r.id).join(",");
    if (keys === this.keys && this.el.children.length === shownRows.length) {
      // Те же строки — обновить на месте (фон меняется плавно, см. styles.css).
      shownRows.forEach((r, k) => {
        const row = this.el.children[k];
        if (row.className !== r.classes) row.className = r.classes;
        const num = row.firstChild;
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
        `<span class="frag-num">${r.i + 1}</span><span class="frag-text">${escapeHtml(r.text)}</span></div>`).join("") ||
        '<div class="frag-empty">Нет таких фрагментов</div>';
      if (shownRows.length) {
        this.el.getBoundingClientRect();
        requestAnimationFrame(() => shownRows.forEach((r, k) => {
          const row = this.el.children[k];
          if (row) row.className = r.classes;
        }));
      }
    }
    document.getElementById("fraglist-count").textContent = `${shownRows.length} из ${fragments.length}`;
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
