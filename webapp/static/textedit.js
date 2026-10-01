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
// Отдельно — голубой: исходные символы из участков, записанных НА СЛУХ
// (f.heard_ranges — диапазоны в original_text; текст не из Notion и т.п.).
// Это подсказка "проверь", а не правка: исправленное становится зелёным,
// нетронутое остаётся голубым.
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
      } else if (kind === "d") {
        if (i >= original.length) return null;
        tokens.push({ ch: original[i], kind: DEL, heard: !!heard[i] });
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
    return this.tokens.map((t) => (t.kind === ORIG ? "o" : t.kind === INS ? "i" : "d")).join("");
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
      kept.push({ ch: token.ch, kind: DEL, heard: !!token.heard });
    }
    this.tokens.splice(from, to - from, ...kept);
    return kept.length;
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
    return token.kind === DEL && token.ch === "\n" ? "↵" : token.ch;
  },

  render(el) {
    el.textContent = "";
    const tokens = this.tokens;
    let i = 0;
    while (i < tokens.length) {
      let j = i;
      let chunk = "";
      // Кусок — подряд идущие токены одного вида (у исходных — и одной
      // отметки "на слух").
      const heardChunk = tokens[i].kind === ORIG && !!tokens[i].heard;
      while (j < tokens.length && tokens[j].kind === tokens[i].kind && (tokens[i].kind !== ORIG || !!tokens[j].heard === heardChunk)) {
        chunk += this._shown(tokens[j]);
        j++;
      }
      if (tokens[i].kind === ORIG && heardChunk) {
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
    // Если текст кончается переносом, пустая последняя строка без <br> не видна.
    const last = tokens[tokens.length - 1];
    if (last && last.ch === "\n" && last.kind !== DEL) {
      const br = document.createElement("br");
      br.dataset.sentinel = "1";
      el.appendChild(br);
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

  setCaret(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    const range = document.createRange();
    let node = walker.nextNode();
    while (node) {
      if (remaining <= node.nodeValue.length) {
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
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  },

  // -- обработка ввода ---------------------------------------------------------

  // Применяет событие beforeinput к токенам. Возвращает позицию каретки
  // после правки или null, если событие не меняет текст.
  apply(el, event) {
    const type = event.inputType;
    const sel = this.selection(el) || [this.tokens.length, this.tokens.length];
    let [from, to] = sel;

    if (type.startsWith("delete")) {
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

  // -- своя история правок -----------------------------------------------------

  _snapshot(caret) {
    return { tokens: this.tokens.map((t) => ({ ch: t.ch, kind: t.kind, heard: t.heard })), caret };
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
