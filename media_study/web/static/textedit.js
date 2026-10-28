// Правка белой фразы прямо на месте, с видимой разницей относительно
// исходного текста фрагмента (original_text).
//
// Внутри поле — не просто строка, а последовательность символов-"токенов"
// трёх видов: исходный (белый), новый (зелёный) и удалённый (красный).
// Удалённые исходные символы не исчезают, а остаются на месте красными —
// так видно, что именно было убрано; в сам текст фрагмента (f.text) они не
// входят. Набранные или вставленные символы — зелёные; их удаление убирает
// их совсем, без красного следа.
//
// Правила правки (браузер сам ничего в поле не меняет — каждое действие
// перехватывается и применяется к токенам):
//   удаление (Backspace/Delete/вырезание/выделение) — зелёные символы
//     исчезают, белые становятся красными, красные остаются красными;
//     каретка встаёт слева от удалённого (Backspace, выделение) или справа
//     (Delete), выделение снимается;
//   ввод и вставка — всегда новые зелёные символы. Красные обратно в белые
//     не превращаются, даже если набрать ту же букву рядом: вернуть
//     удалённое — только Ctrl+Z (или набрать заново — будет зелёным).
//
// Разметка восстанавливается из пары (исходный текст, текущий текст)
// посимвольным сравнением, поэтому после перезагрузки страницы красное и
// зелёное снова видны. Своя история правок — Ctrl+Z / Ctrl+Shift+Z.
//
// Скрытые удалённые (hidden): исходные символы, убранные кнопками
// говорящего (‹ R ›) — они не краснеют, а пропадают из вида; в разметке —
// "x". На экране — пустой символ нулевой ширины (позиции каретки не сбиваются).
//
// Отдельно — голубой: исходные символы из участков, записанных НА СЛУХ
// (f.heard_ranges — диапазоны в original_text; текст не из Notion и т.п.).
// Это подсказка "проверь", а не правка: исправленное становится зелёным,
// нетронутое остаётся голубым.
// Говорящий в начале строки: всё до первого ":", если там не больше 3 слов
// (слово через дефис — одно): "Timid Civilian:", "Jinhsi:", "Strange Tacet
// Discord:". Возвращает {name, length} (длина вместе с ":" и пробелами) или null.
function speakerPrefix(line) {
  const m = /^\s*([^:\n]{1,80}?)\s*:[ \t]*/.exec(line || "");
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  return { name: m[1].trim(), length: m[0].length };
}

const ORIG = 0;
const INS = 1;
const DEL = 2;

const TextEditor = {
  tokens: [], // [{ch, kind}]
  undoStack: [],
  redoStack: [],
  HISTORY_LIMIT: 500,

  // -- модель ------------------------------------------------------------------

  // Токены из исходного и текущего текста: совпавшие символы — белые,
  // только в исходном — красные, только в текущем — зелёные (красные
  // ставятся перед зелёными в одном месте).
  build(original, text, heardRanges) {
    original = original || "";
    text = text || "";
    // heard[i] — символ original[i] записан на слух.
    const heard = new Uint8Array(original.length);
    for (const [start, end] of heardRanges || []) {
      for (let k = Math.max(0, start); k < Math.min(original.length, end); k++) heard[k] = 1;
    }
    const n = original.length;
    const m = text.length;
    let prefix = 0;
    while (prefix < n && prefix < m && original[prefix] === text[prefix]) prefix++;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && original[n - 1 - suffix] === text[m - 1 - suffix]) suffix++;
    const a = original.slice(prefix, n - suffix);
    const b = text.slice(prefix, m - suffix);
    const tokens = [];
    for (let k = 0; k < prefix; k++) tokens.push({ ch: text[k], kind: ORIG, heard: !!heard[k] });
    const A = a.length;
    const B = b.length;
    if (A * B > 4000000 || A === 0 || B === 0) {
      for (let i = 0; i < A; i++) tokens.push({ ch: a[i], kind: DEL, heard: !!heard[prefix + i] });
      for (const ch of b) tokens.push({ ch, kind: INS });
    } else {
      const dp = [];
      for (let i = 0; i <= A; i++) dp.push(new Uint16Array(B + 1));
      for (let i = A - 1; i >= 0; i--) {
        for (let j = B - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < A || j < B) {
        if (i < A && j < B && a[i] === b[j]) {
          tokens.push({ ch: a[i], kind: ORIG, heard: !!heard[prefix + i] });
          i++;
          j++;
        } else if (i < A && (j >= B || dp[i + 1][j] >= dp[i][j + 1])) {
          tokens.push({ ch: a[i], kind: DEL, heard: !!heard[prefix + i] });
          i++;
        } else {
          tokens.push({ ch: b[j], kind: INS });
          j++;
        }
      }
    }
    for (let k = m - suffix; k < m; k++) tokens.push({ ch: text[k], kind: ORIG, heard: !!heard[n - (m - k)] });
    return tokens;
  },

  // marks – сохранённая разметка (Fragment.text_marks): если она сходится с
  // исходным и текущим текстом, берём её как есть (красное остаётся красным,
  // зелёное – зелёным, даже если набранное совпало с удалённым); иначе –
  // посимвольное сравнение.
  load(original, text, heardRanges, marks = "") {
    this.tokens = this.fromMarks(original || "", text || "", heardRanges, marks) || this.build(original, text, heardRanges);
  },

  fromMarks(original, text, heardRanges, marks) {
    if (!marks) return null;
    const heard = new Uint8Array(original.length);
    for (const [start, end] of heardRanges || []) {
      for (let k = Math.max(0, start); k < Math.min(original.length, end); k++) heard[k] = 1;
    }
    const tokens = [];
    let i = 0; // позиция в исходном
    let j = 0; // позиция в текущем
    for (const kind of marks) {
      if (kind === "o") {
        if (i >= original.length || j >= text.length || original[i] !== text[j]) return null;
        tokens.push({ ch: original[i], kind: ORIG, heard: !!heard[i] });
        i++;
        j++;
      } else if (kind === "d" || kind === "x") {
        if (i >= original.length) return null;
        tokens.push({ ch: original[i], kind: DEL, heard: !!heard[i], hidden: kind === "x" });
        i++;
      } else if (kind === "i") {
        if (j >= text.length) return null;
        tokens.push({ ch: text[j], kind: INS });
        j++;
      } else {
        return null;
      }
    }
    return i === original.length && j === text.length ? tokens : null;
  },

  // Разметка для сохранения (см. fromMarks).
  marks() {
    return this.tokens.map((t) => (t.kind === ORIG ? "o" : t.kind === INS ? "i" : t.hidden ? "x" : "d")).join("");
  },

  // Текст поменяли не набором (очистка пробелов при выходе из поля, составной
  // ввод): разметка подстраивается под новый текст, а не строится заново –
  // пропавшие символы исчезают (зелёные) или краснеют (белые), новые –
  // зелёные; остальное и порядок символов не меняются.
  retarget(newText) {
    const visible = [];
    this.tokens.forEach((t, k) => t.kind !== DEL && visible.push(k));
    const a = visible.map((k) => this.tokens[k].ch);
    const b = [...newText];
    const A = a.length;
    const B = b.length;
    if (A * B > 4000000) return false;
    const dp = [];
    for (let i = 0; i <= A; i++) dp.push(new Uint16Array(B + 1));
    for (let i = A - 1; i >= 0; i--) {
      for (let j = B - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    // Для каждого видимого токена: остался ли он; вставки – перед каким токеном.
    const keep = new Uint8Array(A);
    const insertBefore = new Map(); // индекс видимого токена (A – в конце) -> строка
    let i = 0;
    let j = 0;
    // Лишний символ, который можно убрать и набранный, и исходный (двойной
    // пробел), – убирается набранный: исходный не должен краснеть зря.
    const ins = visible.map((k) => this.tokens[k].kind === INS);
    while (i < A || j < B) {
      if (i < A && j < B && a[i] === b[j] && !(ins[i] && dp[i + 1][j] === dp[i][j])) {
        keep[i] = 1;
        i++;
        j++;
      } else if (i < A && (j >= B || dp[i + 1][j] >= dp[i][j + 1])) {
        i++;
      } else {
        insertBefore.set(i, (insertBefore.get(i) || "") + b[j]);
        j++;
      }
    }
    const result = [];
    let v = 0;
    this.tokens.forEach((t) => {
      if (t.kind === DEL) {
        result.push(t);
        return;
      }
      for (const ch of insertBefore.get(v) || "") result.push({ ch, kind: INS });
      if (keep[v]) result.push(t);
      else if (t.kind === ORIG) result.push({ ch: t.ch, kind: DEL, heard: !!t.heard });
      v++;
    });
    for (const ch of insertBefore.get(A) || "") result.push({ ch, kind: INS });
    this.tokens = result;
    return true;
  },

  // Текст фрагмента — всё, кроме красного.
  text() {
    return this.tokens.filter((t) => t.kind !== DEL).map((t) => t.ch).join("");
  },

  // Удаление диапазона токенов [from, to). Возвращает, сколько токенов
  // осталось в диапазоне (белые стали красными, красные остались).
  deleteRange(from, to) {
    const kept = [];
    for (let k = from; k < to; k++) {
      const token = this.tokens[k];
      if (token.kind === INS) continue;
      kept.push({ ch: token.ch, kind: DEL, heard: !!token.heard, hidden: !!token.hidden });
    }
    this.tokens.splice(from, to - from, ...kept);
    return kept.length;
  },

  // Говорящий в начале первой строки ("Имя: "): прежний убирается совсем
  // (набранный — пропадает, исходный — скрытым удалённым), новый вставляется
  // зелёным; name пустое — просто убрать. Возвращает позицию каретки сразу
  // после вставленного.
  setSpeaker(name) {
    // Видимые символы первой строки и их токены.
    const visible = [];
    for (let k = 0; k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.kind === DEL) continue;
      if (t.ch === "\n") break;
      visible.push(k);
    }
    const line = visible.map((k) => this.tokens[k].ch).join("");
    // Говорящего нет – ничего не убирается, имя только добавляется слева.
    const prefix = speakerPrefix(line);
    const drop = new Set(prefix ? visible.slice(0, prefix.length) : []);
    const result = [];
    this.tokens.forEach((t, k) => {
      if (!drop.has(k)) result.push(t);
      else if (t.kind === ORIG) result.push({ ch: t.ch, kind: DEL, heard: !!t.heard, hidden: true });
    });
    // Новое имя – перед первым видимым символом строки (после скрытых/удалённых в начале).
    let at = 0;
    while (at < result.length && result[at].kind === DEL) at++;
    this.tokens = result;
    return name ? this.insert(at, `${name}: `) : at;
  },

  // Строка вместо выделенного [from, to) (выделенное краснеет / набранное
  // пропадает) или в позицию каретки. Возвращает каретку после вставки.
  replaceRange(from, to, str) {
    if (from !== to) {
      this.deleteRange(from, to);
    }
    return this.insert(from, str);
  },

  // Ввод строки в позицию at. Возвращает новую позицию каретки.
  insert(at, str) {
    for (const ch of str) {
      this.tokens.splice(at, 0, { ch, kind: INS });
      at++;
    }
    return at;
  },

  // -- отображение -------------------------------------------------------------

  // Удалённый перенос строки показывается красным знаком "↵", иначе его не видно.
  _shown(token) {
    if (token.kind === DEL && token.hidden) return "\u200B";
    return token.kind === DEL && token.ch === "\n" ? "↵" : token.ch;
  },

  // Режим двух столбцов (говорящие на карточках включены): каждая строка
  // фразы – две ячейки сетки: "Имя:" (прижато вправо) и сама реплика (по
  // центру). Порядок символов в разметке тот же, что в тексте, – позиции
  // каретки считаются как раньше (каждый токен – один символ).
  columns: false,
  hideWho: false, // ячейки имён скрыты (говорящие на карточках выключены)
  onRender: null, // после перерисовки поля (редактор подгоняет ширину столбцов)

  // Строки фразы: [{from, split, to}] – токены [from, split) идут в ячейку
  // говорящего, [split, to) – в ячейку реплики (вместе с переносом строки).
  // Строки делятся любым переносом, и удалённым (красный "↵" – в конце
  // своей строки). Говорящий – по видимому тексту строки (без красного).
  _cells() {
    const tokens = this.tokens;
    const n = tokens.length;
    const cells = [];
    let a = 0;
    for (;;) {
      let b = a;
      while (b < n && tokens[b].ch !== "\n") b++;
      const shown = [];
      for (let k = a; k < b; k++) if (tokens[k].kind !== DEL) shown.push(k);
      let prefix = speakerPrefix(shown.map((k) => tokens[k].ch).join(""));
      let list = shown;
      // Видимого имени нет (стёрто – красное, или строка удалена целиком) –
      // имя ищется вместе с удалённым: красное имя остаётся в поле говорящих,
      // а не переезжает в начало реплики.
      if (!prefix) {
        list = [];
        for (let k = a; k < b; k++) if (!tokens[k].hidden) list.push(k);
        prefix = speakerPrefix(list.map((k) => tokens[k].ch).join(""));
        if (prefix && list.slice(0, prefix.length).some((k) => tokens[k].kind === INS)) prefix = null;
      }
      const to = b < n ? b + 1 : n;
      cells.push({ from: a, split: prefix ? list[prefix.length - 1] + 1 : a, to });
      if (b >= n) break;
      a = to;
    }
    return cells;
  },

  render(el) {
    el.textContent = "";
    if (!this.columns) {
      this._renderRange(el, 0, this.tokens.length);
    } else {
      for (const cell of this._cells()) {
        const who = document.createElement("span");
        who.className = "who";
        const say = document.createElement("span");
        say.className = "say";
        // Пробелы после двоеточия – в элементе нулевой ширины: двоеточия всех
        // имён стоят ровно по правому краю столбца (расстояние до реплики
        // задаёт отступ между столбцами), а символы остаются в разметке.
        let colon = cell.split;
        while (colon > cell.from && /[ \t]/.test(this.tokens[colon - 1].ch)) colon--;
        this._renderRange(who, cell.from, colon);
        if (colon < cell.split) {
          const gap = document.createElement("span");
          gap.className = "gap";
          this._renderRange(gap, colon, cell.split);
          who.appendChild(gap);
        }
        this._renderRange(say, cell.split, cell.to);
        el.append(who, say);
      }
    }
    // Если текст кончается переносом, пустая последняя строка без <br> не видна.
    const tokens = this.tokens;
    const last = tokens[tokens.length - 1];
    if (last && last.ch === "\n" && last.kind !== DEL) {
      const br = document.createElement("br");
      br.dataset.sentinel = "1";
      (this.columns ? el.lastElementChild : el).appendChild(br);
    }
    if (this.onRender) this.onRender();
  },

  // Разметка токенов [from, to) – в parent.
  _renderRange(el, from, to) {
    const tokens = this.tokens;
    let i = from;
    while (i < to) {
      let j = i;
      let chunk = "";
      // Кусок — подряд идущие токены одного вида (у исходных — и одной
      // отметки "на слух").
      const heardChunk = tokens[i].kind === ORIG && !!tokens[i].heard;
      const hiddenChunk = tokens[i].kind === DEL && !!tokens[i].hidden;
      while (j < to && tokens[j].kind === tokens[i].kind && (tokens[i].kind !== ORIG || !!tokens[j].heard === heardChunk)
        && (tokens[i].kind !== DEL || !!tokens[j].hidden === hiddenChunk)) {
        chunk += this._shown(tokens[j]);
        j++;
      }
      if (hiddenChunk) {
        const span = document.createElement("span");
        span.className = "gone";
        span.textContent = chunk;
        el.appendChild(span);
      } else if (tokens[i].kind === ORIG && heardChunk) {
        const span = document.createElement("span");
        span.className = "heard";
        span.textContent = chunk;
        el.appendChild(span);
      } else if (tokens[i].kind === ORIG) {
        el.appendChild(document.createTextNode(chunk));
      } else {
        const span = document.createElement("span");
        span.className = tokens[i].kind === INS ? "ins" : "del";
        // Пробелы и новые переносы строк — в отдельных span: поверх пробела
        // рисуется цветная точка, перед переносом — знак "↵" (сам перенос
        // остаётся настоящим, строка переносится).
        chunk.split(/( |\n)/).forEach((part) => {
          if (!part) return;
          if (part === " " || part === "\n") {
            const mark = document.createElement("span");
            mark.className = part === " " ? "sp" : "nl";
            mark.textContent = part;
            span.appendChild(mark);
          } else {
            span.appendChild(document.createTextNode(part));
          }
        });
        el.appendChild(span);
      }
      i = j;
    }
  },

  // Сколько токенов стоит до точки (container, offset): каждый токен в
  // разметке — ровно один символ текста, служебный <br> не считается.
  offsetOf(el, container, offset) {
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(container, offset);
    const holder = document.createElement("div");
    holder.appendChild(before.cloneContents());
    let count = 0;
    const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) count += walker.currentNode.nodeValue.length;
    return count;
  },

  selection(el) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
    return [this.offsetOf(el, range.startContainer, range.startOffset), this.offsetOf(el, range.endContainer, range.endOffset)];
  },

  // Каретка в конец имени строки line (в поле говорящих, перед пробелами
  // после двоеточия).
  setCaretInWho(el, line) {
    const who = el.querySelectorAll(".who")[line];
    if (!who) return;
    const range = document.createRange();
    const gap = who.querySelector(".gap");
    if (gap) range.setStartBefore(gap);
    else range.selectNodeContents(who), range.collapse(false);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  },

  setCaret(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    const range = document.createRange();
    let node = walker.nextNode();
    while (node) {
      // Скрытая ячейка имени: каретке там не место – встаёт в начало реплики.
      if (this.hideWho && node.parentElement.closest(".who")) {
        remaining = Math.max(0, remaining - node.nodeValue.length);
        node = walker.nextNode();
        continue;
      }
      // В два столбца строка кончается своей ячейкой: каретка "после переноса" –
      // это начало следующей ячейки, а не хвост этой (иначе она рисовалась бы
      // в конце предыдущей строки).
      const lineEnd = this.columns && !this.hideWho && remaining === node.nodeValue.length && node.nodeValue.endsWith("\n");
      if (remaining <= node.nodeValue.length && !lineEnd) {
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= node.nodeValue.length;
      node = walker.nextNode();
    }
    // Дальше текста нет: конец поля (в два столбца – пустая последняя ячейка реплики).
    const lastCell = this.columns && el.lastElementChild;
    if (lastCell) {
      range.setStart(lastCell, lastCell.querySelector("br[data-sentinel]") ? 0 : lastCell.childNodes.length);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  },

  // -- обработка ввода ---------------------------------------------------------

  // Применяет событие beforeinput к токенам. Возвращает позицию каретки
  // после правки или null, если событие не меняет текст.
  // -- два поля (говорящие | реплики) --------------------------------------------

  // Поле, где стоит каретка (начало выделения): {cell – номер строки, col –
  // "who" | "say"} или null (не два поля).
  _fieldAt(el) {
    if (!this.columns || this.hideWho) return null;
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    const cellEl = node && node.closest && node.closest(".who, .say");
    if (!cellEl || !el.contains(cellEl)) return null;
    return { cell: Math.floor([...el.children].indexOf(cellEl) / 2), col: cellEl.classList.contains("who") ? "who" : "say" };
  },

  // Границы поля col в строке cell: [начало, конец) без переноса строки.
  _fieldRange(cell, col) {
    const end = cell.to > cell.split && this.tokens[cell.to - 1] && this.tokens[cell.to - 1].ch === "\n" ? cell.to - 1 : cell.to;
    return col === "who" ? [cell.from, cell.split] : [cell.split, end];
  },

  _lineEmpty(cell) {
    for (let k = cell.from; k < cell.to; k++) if (this.tokens[k].kind !== DEL && this.tokens[k].ch !== "\n") return false;
    return true;
  },

  // Удалить [from, to), но только внутри поля col (в каждой задетой строке –
  // её часть этого поля); переносы строк и другое поле не трогаются.
  // Возвращает новую позицию начала.
  _deleteInField(from, to, col) {
    const cells = this._cells();
    const parts = [];
    for (const cell of cells) {
      const [a, b] = this._fieldRange(cell, col);
      const s = Math.max(a, from);
      const e = Math.min(b, to);
      if (s < e) parts.push([s, e]);
    }
    // С конца – удаление набранного сдвигает позиции дальше по тексту.
    for (const [s, e] of parts.reverse()) this.deleteRange(s, e);
    return parts.length ? parts[parts.length - 1][0] : from;
  },

  apply(el, event) {
    const type = event.inputType;
    const sel = this.selection(el) || [this.tokens.length, this.tokens.length];
    let [from, to] = sel;
    const field = this._fieldAt(el);
    if (field) {
      const result = this._applyInField(el, event, field, from, to);
      if (result !== undefined) return result;
    }

    if (type.startsWith("delete")) {
      // Backspace в начале пустой первой строки (до каретки – только удалённое):
      // удаляется перенос строки после каретки – первая строка пропадает.
      if (type === "deleteContentBackward" && from === to && this.tokens.slice(0, from).every((t) => t.kind === DEL)) {
        let k = from;
        while (k < this.tokens.length && this.tokens[k].kind === DEL) k++;
        if (k < this.tokens.length && this.tokens[k].ch === "\n") {
          this.deleteRange(k, k + 1);
          return from;
        }
      }
      // Точный диапазон удаления (символ, слово, строка) подсказывает браузер.
      const ranges = event.getTargetRanges ? event.getTargetRanges() : [];
      if (ranges.length) {
        from = this.offsetOf(el, ranges[0].startContainer, ranges[0].startOffset);
        to = this.offsetOf(el, ranges[0].endContainer, ranges[0].endOffset);
      } else if (from === to) {
        if (type.includes("Backward")) from = Math.max(0, from - 1);
        else to = Math.min(this.tokens.length, to + 1);
      }
      if (from === to) return null;
      const kept = this.deleteRange(from, to);
      // Delete вперёд перешагивает покрасневшие символы, иначе каретка стоит на месте.
      const forward = type.includes("Forward") && sel[0] === sel[1];
      return forward ? from + kept : from;
    }

    let str = null;
    if (type === "insertText" || type === "insertReplacementText") {
      str = event.data ?? (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
    } else if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromYank") {
      str = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
    } else if (type === "insertParagraph" || type === "insertLineBreak") {
      str = "\n";
    }
    if (str === null) return null;
    str = str.replace(/\r\n?/g, "\n");
    // Сначала выделенное "удаляется" (краснеет), потом вводится новое (зелёное).
    if (from !== to) this.deleteRange(from, to);
    return this.insert(from, str);
  },

  // Имя строки line стёрто (в поле говорящих остались только пробелы после
  // двоеточия) – пробелы тоже стираются: иначе строка не считалась бы
  // пустой и не убиралась бы Backspace.
  _trimEmptyWho(line) {
    const cell = this._cells()[line];
    if (!cell) return;
    const [a, b] = this._fieldRange(cell, "who");
    const visible = [];
    for (let k = a; k < b; k++) if (this.tokens[k].kind !== DEL) visible.push(k);
    if (visible.length && visible.every((k) => /\s/.test(this.tokens[k].ch))) {
      for (const k of visible.reverse()) this.deleteRange(k, k + 1);
    }
  },

  // Правка в двух полях: удаление и замена выделенного – только в своём поле.
  // undefined – действовать как обычно (вставка без выделения и т.п.).
  _applyInField(el, event, field, from, to) {
    const type = event.inputType;
    const cells = this._cells();
    const cell = cells[field.cell];
    if (!cell) return undefined;
    const [fa, fb] = this._fieldRange(cell, field.col);
    if (type.startsWith("delete")) {
      if (from === to) {
        const back = type.includes("Backward");
        // На краю поля: дальше – другое поле или другая строка. Строка
        // убирается, только если она пустая; иначе ничего не происходит.
        if (back && from <= fa) {
          if (field.cell > 0 && this._lineEmpty(cell)) {
            const nl = cells[field.cell - 1].to - 1;
            this.deleteRange(nl, nl + 1);
            return this._fieldRange(cells[field.cell - 1], "say")[1];
          }
          return null;
        }
        if (!back && from >= fb) {
          const next = cells[field.cell + 1];
          if (field.col === "say" && next && this._lineEmpty(next) && this.tokens[cell.to - 1].ch === "\n") {
            this.deleteRange(cell.to - 1, cell.to);
            return from;
          }
          return null;
        }
        // Внутри поля: диапазон подсказывает браузер (слово – Ctrl+Backspace),
        // но не дальше края поля.
        const ranges = event.getTargetRanges ? event.getTargetRanges() : [];
        if (ranges.length) {
          from = Math.max(fa, this.offsetOf(el, ranges[0].startContainer, ranges[0].startOffset));
          to = Math.min(fb, this.offsetOf(el, ranges[0].endContainer, ranges[0].endOffset));
        } else if (back) {
          from = Math.max(fa, from - 1);
        } else {
          to = Math.min(fb, to + 1);
        }
        if (from >= to) return null;
        const kept = this.deleteRange(from, to);
        if (field.col === "who") this._trimEmptyWho(field.cell);
        return !back ? from + kept : from;
      }
      const at = this._deleteInField(from, to, field.col);
      if (field.col === "who") for (let i = 0; i < cells.length; i++) this._trimEmptyWho(i);
      return at;
    }
    let str = null;
    if (type === "insertText" || type === "insertReplacementText") {
      str = event.data ?? (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
    } else if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromYank") {
      str = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
    } else if (type === "insertParagraph" || type === "insertLineBreak") {
      str = "\n";
    }
    if (str === null) return null;
    str = str.replace(/\r\n?/g, "\n");
    // В поле имён переносов строк нет.
    if (field.col === "who") str = str.replace(/\n/g, " ");
    if (!str) return null;
    let at = from;
    if (from !== to) at = this._deleteInField(from, to, field.col);
    return this.insert(Math.max(at, fa), str);
  },

  // -- своя история правок -----------------------------------------------------

  _snapshot(caret) {
    return { tokens: this.tokens.map((t) => ({ ch: t.ch, kind: t.kind, heard: t.heard, hidden: t.hidden })), caret };
  },

  resetHistory() {
    this.undoStack = [];
    this.redoStack = [];
  },

  remember(caret) {
    this.undoStack.push(this._snapshot(caret));
    if (this.undoStack.length > this.HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  },

  // Возвращает каретку восстановленного состояния или null.
  undo(caret) {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push(this._snapshot(caret));
    this.tokens = step.tokens;
    return step.caret;
  },

  redo(caret) {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push(this._snapshot(caret));
    this.tokens = step.tokens;
    return step.caret;
  },
};
