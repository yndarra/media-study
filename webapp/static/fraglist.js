// Правый сайдбар редактора: прокручиваемый список всех фрагментов видео.
//
// Клик по строке — переход к фрагменту (без стрелок). Цвет строки — состояние
// фрагмента: жёлтый — изменён (текст, границы, запас), красный — помечен на
// удаление, зелёный — передан в Anki (дальше только просмотр), оранжевый с
// флажком — вернулся из Anki на доработку. Номер зелёный, если фрагмент
// прошёл этап 3 (в том числе удалённый — он в колоду не попал, но обработан). Фильтр оставляет только фрагменты,
// которые ещё требуют доработки (не переданы в Anki), или только вернувшиеся
// из Anki по флагу.
//
// Список перестраивается не чаще раза за кадр отрисовки: renderAll вызывается
// очень часто (например, при перетаскивании границы).
const FragList = {
  el: null,
  filter: "all",
  pending: false,
  lastCurrent: -1,

  init() {
    this.el = document.getElementById("fraglist-items");
    const select = document.getElementById("fraglist-filter");
    select.addEventListener("change", () => {
      this.filter = select.value;
      this.lastCurrent = -1;
      this.render();
    });
    this.el.addEventListener("click", (e) => {
      const row = e.target.closest("[data-index]");
      if (row) App.go(Number(row.dataset.index));
    });
  },

  reset() {
    this.lastCurrent = -1;
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

  // Классы строки: состояние правки (цвет текста) и прошёл ли фрагмент
  // этап 3 (зелёный номер) — независимо друг от друга.
  kind(f) {
    const classes = [];
    if (f.status !== "active") classes.push("deleted");
    else if (f.anki_flagged && !f.exported) classes.push("flagged");
    else if (isTextEdited(f) || isBoundsEdited(f) || f.context_custom) classes.push("edited");
    if (f.exported) classes.push(State.stage3.pending_ids.includes(f.id) ? "anki pending" : "anki");
    return classes.join(" ");
  },

  visible(f) {
    if (this.filter === "todo") return !f.exported;
    if (this.filter === "flagged") return f.anki_flagged && !f.exported;
    return true;
  },

  render() {
    if (!this.el || !State.manifest || State.view !== "editor") return;
    const fragments = State.manifest.fragments;
    const rows = [];
    let shown = 0;
    fragments.forEach((f, i) => {
      if (!this.visible(f)) return;
      shown++;
      const first = (f.text || "").split("\n")[0].trim() || "(без слов)";
      const current = i === State.fragmentIndex ? " current" : "";
      const flag = f.anki_flagged && !f.exported ? "⚑ " : "";
      rows.push(
        `<div class="frag-row ${this.kind(f)}${current}" data-index="${i}">` +
          `<span class="frag-num">${i + 1}</span><span class="frag-text">${flag}${escapeHtml(first)}</span></div>`,
      );
    });
    this.el.innerHTML = rows.join("") || '<div class="frag-empty">Нет таких фрагментов</div>';
    document.getElementById("fraglist-count").textContent = `${shown} из ${fragments.length}`;
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
