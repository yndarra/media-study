// Редактор: три фразы (столбец говорящих), правка текста и её сохранение, говорящие, стык объединения, имена.

Object.assign(App, {
  // Соседняя фраза (серая) – ближайшая с текстом. Удалённые пользователем
  // пропускаются в режиме skipDeleted (по умолчанию), иначе видны
  // (зачёркнутыми) – любые, и исходники объединения/разделения тоже.
  _neighbor(direction) {
    const fragments = State.manifest.fragments;
    for (let i = State.fragmentIndex + direction; i >= 0 && i < fragments.length; i += direction) {
      const g = fragments[i];
      const deleted = g.status !== "active";
      if (deleted && State.skipDeleted) continue;
      const text = (g.text || "").trim();
      if (text) return { text, deleted };
    }
    return { text: "", deleted: false };
  },

  _neighborText(direction) {
    return this._neighbor(direction).text;
  },

  renderText(f, force) {
    // Предыдущая фраза (серая), эта (белая), следующая (серая). Белая
    // правится прямо на месте — клик ставит в неё мигающую каретку, больше
    // ничего визуально не меняется. Пока в ней идёт набор, текст не
    // перезаписывается, чтобы не сбить каретку.
    // Разница с исходным текстом видна прямо в фразе: новое — зелёное,
    // удалённое — красное (см. textedit.js).
    const cur = $("cur-text");
    // Говорящие на карточках включены – три фразы в два столбца: имена
    // (прижаты вправо) и реплики (столбец – по центру экрана). Выключены –
    // как раньше, одним столбцом.
    // Выключены (у видео) – имён в тексте нет совсем: строки так же разбиты на
    // ячейки, но ячейка имени скрыта (символы остаются в тексте фрагмента, в
    // поле их не видно и каретка в них не попадает). У аудио при выключенном
    // режиме текст показывается целиком ("Chorus: …" в песне – не говорящий).
    const columns = !!State.manifest.video.show_speakers;
    const hideWho = !columns && !State.manifest.video.audio_only;
    const modeChanged = this._whoColumn !== columns || TextEditor.hideWho !== hideWho;
    this._whoColumn = columns;
    TextEditor.columns = columns || hideWho;
    TextEditor.hideWho = hideWho;
    $("context-preview").classList.toggle("cols", columns);
    $("context-preview").classList.toggle("nowho", hideWho);
    if (force) TextEditor.resetHistory();
    if (force || document.activeElement !== cur) {
      TextEditor.load(f.original_text, f.text, f.heard_ranges, f.text_marks);
      TextEditor.render(cur);
    } else if (modeChanged) {
      TextEditor.render(cur);
    }
    cur.contentEditable = isLocked(f) ? "false" : "plaintext-only";
    for (const [id, dir] of [["prev-text", -1], ["next-text", 1]]) {
      const n = this._neighbor(dir);
      this._renderNeighbor($(id), n.text, columns || hideWho);
      $(id).classList.toggle("deleted-neighbor", n.deleted);
    }
    // Стык объединённого фрагмента: кнопка "Склеить в одну фразу" и мигание.
    this.updateJunction(f);
    this.fitTextBox();
  },

  // Серая соседняя фраза: одним текстом или (в два столбца) по строкам –
  // ячейка говорящего и ячейка реплики, как у белой.
  _renderNeighbor(el, text, columns) {
    if (!columns) {
      el.textContent = text;
      return;
    }
    el.textContent = "";
    const lines = text.split("\n");
    for (const [k, line] of lines.entries()) {
      const prefix = speakerPrefix(line);
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = prefix ? line.slice(0, prefix.length).trimEnd() : "";
      const say = document.createElement("span");
      say.className = "say";
      // Перенос строки – в конце ячейки реплики (без сетки строки идут подряд).
      say.textContent = (prefix ? line.slice(prefix.length) : line) + (k < lines.length - 1 ? "\n" : "");
      el.append(who, say);
    }
  },

  // Отступ между столбцом говорящих и столбцом реплик, px. Область клика
  // делится посередине этого отступа: левее – имена, правее – реплики.
  COLUMN_GAP: 14,

  // Два столбца: общая для трёх фраз ширина столбца имён (по самому длинному
  // имени) и столбца реплик (по самой длинной строке); столбец реплик стоит
  // по центру экрана, имена – слева от него (поле сдвинуто влево на половину
  // столбца имён с отступом). Поля – те же TEXT_BOX_PAD с каждой стороны.
  fitColumns() {
    const box = $("context-preview");
    for (const name of ["--who-w", "--say-w", "--col-gap"]) box.style.removeProperty(name);
    $("cur-text").style.minWidth = "";
    let who = 0;
    let say = 0;
    for (const id of ["prev-text", "cur-text", "next-text"]) {
      // Без заданной ширины столбцы – по содержимому (max-content): читаем, что вышло.
      const [w, s] = getComputedStyle($(id)).gridTemplateColumns.split(" ").map(parseFloat);
      who = Math.max(who, w || 0);
      say = Math.max(say, s || 0);
    }
    const gap = who > 0 ? this.COLUMN_GAP : 0;
    const style = getComputedStyle(box);
    const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    // Поле сдвинуто влево на (имена + отступ) / 2 – слева должно хватить места.
    say = Math.max(100, Math.min(Math.ceil(say) + 1, room - 2 * (Math.ceil(who) + gap + TEXT_BOX_PAD)));
    box.style.setProperty("--who-w", `${Math.ceil(who)}px`);
    box.style.setProperty("--say-w", `${say}px`);
    box.style.setProperty("--col-gap", `${gap}px`);
  },

  // Поле правимой фразы: ширина – по самой длинной строке из трёх фраз
  // (предыдущей, этой и следующей) плюс поля по TEXT_BOX_PAD с каждой стороны;
  // не шире места. Своя фраза длиннее – поле растёт само (fit-content).
  fitTextBox() {
    if (this._whoColumn) return this.fitColumns();
    const textWidth = (el) => {
      if (!el.textContent.trim()) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const widest = Math.max(textWidth($("prev-text")), textWidth($("next-text")));
    $("cur-text").style.minWidth = `${Math.ceil(widest) + 2 * TEXT_BOX_PAD}px`;
  },

  // Правка текста: событие beforeinput уже применено к токенам
  // (TextEditor.apply) — перерисовываем фразу и сохраняем.
  onTokensChanged(caret) {
    const f = currentFragment();
    const el = $("cur-text");
    f.text = TextEditor.text();
    f.text_marks = TextEditor.marks();
    TextEditor.render(el);
    TextEditor.setCaret(el, caret);
    this._scheduleTextSave(f);
    this.updateJunction(f); // правка у стыка – кнопка и мигание по новому тексту
  },

  // Составной ввод (IME) браузер не даёт перехватить — после него
  // перечитываем фразу из разметки (без красных символов) и строим заново.
  resyncFromDom() {
    const f = currentFragment();
    const el = $("cur-text");
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".del, br[data-sentinel]").forEach((node) => node.remove());
    const text = copy.textContent;
    if (!TextEditor.retarget(text)) TextEditor.load(f.original_text, text, f.heard_ranges);
    f.text = TextEditor.text();
    f.text_marks = TextEditor.marks();
    TextEditor.render(el);
    TextEditor.setCaret(el, TextEditor.tokens.length);
    this._scheduleTextSave(f);
  },

  // Своя отмена/возврат внутри текста.
  textHistory(direction) {
    const el = $("cur-text");
    const sel = TextEditor.selection(el);
    const caret = direction < 0 ? TextEditor.undo(sel ? sel[0] : 0) : TextEditor.redo(sel ? sel[0] : 0);
    if (caret === null) return;
    this.onTokensChanged(caret);
  },

  _scheduleTextSave(f) {
    this.renderStatus(f);
    this.textFragment = f;
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(() => {
      this.textTimer = null;
      this.saveText();
    }, 600);
  },

  // Ушли из текста: чистим его (лишние пробелы, пустые строки) и сразу
  // сохраняем, не дожидаясь паузы в наборе.
  async onTextBlur() {
    const f = currentFragment();
    if (!f) return;
    const cleaned = cleanText(f.text);
    if (cleaned !== f.text) {
      f.text = cleaned;
      // Красное и зелёное остаются как были – убираются только лишние пробелы.
      if (!TextEditor.retarget(cleaned)) TextEditor.load(f.original_text, cleaned, f.heard_ranges);
      f.text_marks = TextEditor.marks();
      TextEditor.render($("cur-text"));
      this.textFragment = f;
      clearTimeout(this.textTimer);
      this.textTimer = null;
      await this.saveText();
    }
    await this.flushSaves();
    this.renderStatus(f);
  },

  async saveText() {
    const f = this.textFragment;
    if (!f) return;
    const text = f.text;
    // Вместе с текстом – разметка правки (красное/зелёное), см. textedit.js.
    const updated = await this._call(Api.updateFragment(f.id, { text, text_marks: f.text_marks || "" }));
    if (updated) {
      const latest = f.text;
      const latestMarks = f.text_marks;
      Object.assign(f, updated);
      f.text = latest;
      f.text_marks = latestMarks;
    }
    if (f === currentFragment()) this.renderStatus(f);
  },

  async clearReview() {
    const f = currentFragment();
    const updated = await this._call(Api.updateFragment(f.id, { needs_review: false }));
    if (updated) this._applyServer(f, updated);
    this.renderStatus(f);
  },

  // Кнопки говорящего (‹ R ›). Для текущего фрагмента помним исходный текст
  // (до первого нажатия) и "смещение": 0 – как было, −k – k-й говорящий из
  // предыдущих фрагментов (по порядку назад, без повторов), +k – из следующих;
  // R – Rover поверх (ещё раз – снять). Нажатия складываются: 3 раза ‹ и 3
  // раза › – снова как было.
  speakerState: null,

  _speakersAround(direction) {
    const fragments = State.manifest.fragments;
    const own = this._speakerOf(currentFragment().text);
    const names = [];
    for (let i = State.fragmentIndex + direction; i >= 0 && i < fragments.length; i += direction) {
      const lines = (fragments[i].text || "").split("\n");
      for (const line of direction < 0 ? lines.reverse() : lines) {
        const p = speakerPrefix(line);
        if (p && p.name !== own && !names.includes(p.name)) names.push(p.name);
      }
      if (names.length >= 20) break;
    }
    return names;
  },

  _speakerOf(text) {
    const p = speakerPrefix((text || "").split("\n")[0]);
    return p ? p.name : "";
  },

  async changeSpeaker(action) {
    const f = currentFragment();
    if (!f || isLocked(f)) return;
    let st = this.speakerState;
    if (!st || st.id !== f.id) {
      // Списки имён – один раз, по исходному тексту (раньше пересчитывались
      // после каждого нажатия от уже подставленного имени, и ‹ перескакивал).
      st = this.speakerState = { id: f.id, tokens: TextEditor.tokens.map((t) => ({ ...t })), offset: 0, rover: false,
        prevNames: this._speakersAround(-1), nextNames: this._speakersAround(1) };
    }
    if (action === "clear") {
      // × – убрать говорящего (ещё раз – как было).
      st.cleared = !st.cleared;
      st.rover = false;
      st.offset = 0;
    } else if (action === "rover") {
      st.rover = !st.rover;
      st.cleared = false;
    } else {
      st.offset += action === "prev" ? -1 : 1;
      st.rover = false;
      st.cleared = false;
    }
    let name = null; // null – как было
    if (st.cleared) name = "";
    else if (st.rover) name = "Rover";
    else if (st.offset < 0) name = st.prevNames[-st.offset - 1] ?? null;
    else if (st.offset > 0) name = st.nextNames[st.offset - 1] ?? null;
    if (name === null && st.offset !== 0 && !st.rover && !st.cleared) {
      st.offset += action === "prev" ? 1 : -1; // дальше говорящих нет – остаёмся
      return;
    }
    TextEditor.tokens = st.tokens.map((t) => ({ ...t }));
    if (name !== null) TextEditor.setSpeaker(name); // "" – убрать говорящего
    // Поле не выделяется и каретка не ставится – шорткаты продолжают работать.
    const el = $("cur-text");
    if (document.activeElement === el) el.blur();
    f.text = TextEditor.text();
    f.text_marks = TextEditor.marks();
    TextEditor.render(el);
    this._scheduleTextSave(f);
  },

  // Стык объединённого фрагмента (f.junction – позиция в исходном тексте).
  // По токенам редактора (исходные символы идут по порядку, удалённые –
  // красные, набранные – новые) находится, где стык сейчас и цел ли он:
  //   - "сильно изменён" – удалён сам пробел/перенос стыка или два и больше
  //     из соседних исходных символов (тогда не мигает, кнопка серая);
  //   - "можно склеить" – на стыке сейчас видно ". Заглавная".
  // Возвращает {at – видимая позиция стыка, intact, joinable} или null.
  junctionState(f) {
    if (!f || f.junction === null || f.junction === undefined) return null;
    const tokens = TextEditor.tokens;
    const orig = []; // индексы токенов исходных символов
    tokens.forEach((t, k) => t.kind !== INS && orig.push(k));
    const j = f.junction;
    if (j < 0 || j >= orig.length) return null;
    const isDel = (i) => i >= 0 && i < orig.length && tokens[orig[i]].kind === DEL;
    const around = [j - 2, j - 1, j + 1, j + 2].filter(isDel).length;
    const intact = !isDel(j) && around < 2;
    let at = 0; // видимых символов до стыка
    for (let k = 0; k < orig[j]; k++) if (tokens[k].kind !== DEL) at++;
    const text = TextEditor.text();
    const joinable = intact && /^\. [A-ZА-ЯЁ]$/.test(text.slice(at - 1, at + 2));
    return { at, intact, joinable };
  },

  // Кнопка "Склеить в одну фразу" (видна у объединённого фрагмента; серая,
  // если склеивать нечего) и мигание стыка – пока не вошли в поле текста.
  updateJunction(f) {
    const st = this.junctionState(f);
    $("junction-row").classList.toggle("hidden", !st);
    $("junction-join").disabled = !(st && st.joinable);
    this._junction = st && st.intact ? { id: f.id, at: st.at } : null;
    this._junctionRange = null;
    if (this._junction && !this._junctionLoop) {
      this._junctionLoop = true;
      requestAnimationFrame((t) => this._junctionFrame(t));
    }
  },

  // Мигание стыка: символы вокруг (по 4–5 с каждой стороны) подчёркиваются и
  // плавно гаснут, по кругу; в поле текста – не мигает (CSS Custom Highlight API).
  _junctionFrame(now) {
    const el = $("cur-text");
    const j = this._junction;
    const f = currentFragment();
    const supported = window.CSS && CSS.highlights && typeof Highlight !== "undefined";
    if (!supported || !j || !f || f.id !== j.id || State.view !== "editor") {
      this._junctionLoop = false;
      if (supported) CSS.highlights.delete("junction");
      el.style.setProperty("--junction", "0");
      return;
    }
    requestAnimationFrame((t) => this._junctionFrame(t));
    if (document.activeElement === el) {
      el.style.setProperty("--junction", "0");
      return;
    }
    // Разметку поля перерисовывают – диапазон строится заново.
    const r = this._junctionRange;
    if (!r || !r.startContainer.isConnected || !r.endContainer.isConnected) {
      this._junctionRange = this._visibleRange(el, Math.max(0, j.at - 4), j.at + 5);
      if (!this._junctionRange) return;
      CSS.highlights.set("junction", new Highlight(this._junctionRange));
    }
    el.style.setProperty("--junction", String(Math.pow(Math.sin(Math.PI * ((now / 900) % 1)), 2)));
  },

  // DOM-диапазон видимых символов [from, to) текста фразы (удалённые красные
  // символы в счёт не идут: каждый токен – один символ разметки).
  _visibleRange(el, from, to) {
    const tokens = TextEditor.tokens;
    const tokenOf = (visible) => {
      let seen = 0;
      for (let k = 0; k < tokens.length; k++) {
        if (tokens[k].kind === DEL) continue;
        if (seen === visible) return k;
        seen++;
      }
      return tokens.length;
    };
    const a = tokenOf(from);
    const b = tokenOf(Math.min(to, TextEditor.text().length));
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let pos = 0;
    const range = document.createRange();
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.textContent.length;
      if (!started && a < pos + len) {
        range.setStart(node, a - pos);
        started = true;
      }
      if (started && b <= pos + len) {
        range.setEnd(node, b - pos);
        return range;
      }
      pos += len;
    }
    return started ? range : null;
  },

  // "Склеить в одну фразу": на стыке ". Заглавная" -> " строчная" (кроме
  // "I" и имён говорящих). Обычная правка текста – видна и отменяется Ctrl+Z.
  joinAtJunction() {
    const f = currentFragment();
    const j = this.junctionState(f);
    if (!f || !j || !j.joinable || isLocked(f)) return;
    const text = TextEditor.text();
    if (!/^\. [A-ZА-ЯЁ]$/.test(text.slice(j.at - 1, j.at + 2))) return;
    const word = (text.slice(j.at + 1).match(/^[\w'’]+/) || [""])[0];
    const keep = /^I(['’](m|ll|ve|d))?$/.test(word) || this._speakerNames().has(word);
    const tokens = TextEditor.tokens;
    const tokenOf = (visible) => {
      let seen = 0;
      for (let k = 0; k < tokens.length; k++) {
        if (tokens[k].kind === DEL) continue;
        if (seen === visible) return k;
        seen++;
      }
      return tokens.length;
    };
    TextEditor.remember(tokenOf(j.at));
    // Участок вокруг стыка до склейки – для отмены повторным Ctrl+Space.
    const from = Math.max(0, tokenOf(j.at - 1) - 3);
    const beforeSlice = tokens.slice(from, tokenOf(j.at + 1) + 4).map((t) => ({ ...t }));
    if (!keep) {
      const k = tokenOf(j.at + 1);
      TextEditor.replaceRange(k, k + 1, text[j.at + 1].toLowerCase());
    }
    const dot = tokenOf(j.at - 1);
    TextEditor.deleteRange(dot, dot + 1);
    const grown = keep ? 0 : 1; // строчная буква – новый токен рядом с удалённой заглавной
    this._joinUndo = { id: f.id, from, before: beforeSlice,
      after: TextEditor.tokens.slice(from, from + beforeSlice.length + grown).map((t) => ({ ...t })) };
    f.text = TextEditor.text();
    f.text_marks = TextEditor.marks();
    TextEditor.render($("cur-text"));
    this._scheduleTextSave(f);
    this.updateJunction(f); // склеено – кнопка серая, стык больше не мигает
  },

  // Ctrl+Space: склеить в одну фразу; если только что склеили и этот участок
  // с тех пор не трогали – повторное нажатие возвращает как было.
  toggleJunction() {
    const f = currentFragment();
    if (!f || isLocked(f)) return;
    const u = this._joinUndo;
    const same = (a, b) => a.length === b.length && a.every((t, k) => t.ch === b[k].ch && t.kind === b[k].kind);
    if (u && u.id === f.id && same(TextEditor.tokens.slice(u.from, u.from + u.after.length), u.after)) {
      TextEditor.remember(u.from);
      TextEditor.tokens.splice(u.from, u.after.length, ...u.before.map((t) => ({ ...t })));
      this._joinUndo = null;
      f.text = TextEditor.text();
      f.text_marks = TextEditor.marks();
      TextEditor.render($("cur-text"));
      this._scheduleTextSave(f);
      this.updateJunction(f);
      return;
    }
    this.joinAtJunction();
  },

  // Имена говорящих видео (с заглавной – их не делаем строчными).
  _speakerNames() {
    const names = new Set();
    for (const g of State.manifest.fragments) {
      for (const line of (g.text || "").split("\n")) {
        const p = speakerPrefix(line);
        if (p) for (const w of p.name.split(/\s+/)) names.add(w);
      }
    }
    return names;
  },

  // Имя из буфера (Alt+F) или Rover (Alt+R): "prefix" – говорящим в начало
  // фразы; "inline" – в место каретки / вместо выделенного. В поле текста –
  // как набор (Ctrl+Z отменяет, поле остаётся в режиме правки); вне поля –
  // правка сохраняется (Ctrl+Z – отмена правки фрагмента).
  insertName(name, how) {
    const f = currentFragment();
    if (!f || isLocked(f)) return;
    const el = $("cur-text");
    const editing = document.activeElement === el;
    const sel = editing ? TextEditor.selection(el) || [TextEditor.tokens.length, TextEditor.tokens.length] : null;
    TextEditor.remember(sel ? sel[0] : 0);
    let caret;
    if (how === "prefix") caret = TextEditor.setSpeaker(name);
    else caret = TextEditor.replaceRange(sel[0], sel[1], name);
    if (editing) {
      this.onTokensChanged(caret);
    } else {
      f.text = TextEditor.text();
      f.text_marks = TextEditor.marks();
      TextEditor.render(el);
      this._scheduleTextSave(f);
    }
  },

  // Alt+R в поле текста: "Rover" в место каретки / вместо выделенного; ещё раз
  // сразу – убрать вставленное (вернуть как было). Поле остаётся в правке.
  insertRover() {
    const f = currentFragment();
    const el = $("cur-text");
    if (!f || isLocked(f) || document.activeElement !== el) return;
    if (roverInsert && roverInsert.id === f.id && roverInsert.marks === TextEditor.marks()) {
      TextEditor.tokens = roverInsert.tokens;
      const caret = roverInsert.caret;
      roverInsert = null;
      this.onTokensChanged(caret);
      return;
    }
    const sel = TextEditor.selection(el) || [TextEditor.tokens.length, TextEditor.tokens.length];
    const tokens = TextEditor.tokens.map((t) => ({ ...t }));
    TextEditor.remember(sel[0]);
    const caret = TextEditor.replaceRange(sel[0], sel[1], "Rover");
    roverInsert = { id: f.id, tokens, caret: sel[0], marks: TextEditor.marks() };
    this.onTokensChanged(caret);
  },
});
