// -- привязка кнопок и клавиш --------------------------------------------------

$("play-pause").addEventListener("click", () => Player.togglePlay());
$("replay-btn").addEventListener("click", () => Player.replay());
$("replay-marker-btn").addEventListener("click", () => Player.replayFromMarker());
// Клик по самому видео — то же, что кнопка Play/пауза.
$("video").addEventListener("click", () => Player.togglePlay());
$("undo-btn").addEventListener("click", () => App.undo());
$("stage3-btn").addEventListener("click", () =>
  ($("stage3-btn").dataset.action === "stop" ? App.stopStage3() : App.queueStage3()));
$("redo-btn").addEventListener("click", () => App.redo());
$("mode-toggle").addEventListener("click", () => App.toggleMode());
$("auto-toggle").addEventListener("click", () => App.toggleAuto());
$("skip-deleted-btn").addEventListener("click", () => App.toggleSkipDeleted());
$("link-bounds-btn").addEventListener("click", () => App.toggleLinkBounds());
$("speakers-btn").addEventListener("click", () => App.toggleSpeakers());
$("junction-join").addEventListener("click", () => App.joinAtJunction());
App.updateAutoButton();
App.updateSkipButton();
App.updateLinkButton();
$("reset-btn").addEventListener("click", () => App.reset());
$("pad-left-minus").addEventListener("click", () => App.changePadding("left", -1));
$("pad-left-plus").addEventListener("click", () => App.changePadding("left", 1));
$("pad-right-minus").addEventListener("click", () => App.changePadding("right", -1));
$("pad-right-plus").addEventListener("click", () => App.changePadding("right", 1));
$("review-badge").addEventListener("click", () => App.clearReview());

$("step-back-10").addEventListener("click", () => App.step(-10));
$("step-back-1").addEventListener("click", () => App.step(-1));
$("step-fwd-1").addEventListener("click", () => App.step(1));
$("step-fwd-10").addEventListener("click", () => App.step(10));

$("set-start").addEventListener("click", () => App.setStart());
$("snap-start").addEventListener("click", () => App.snapBound("start"));
$("snap-end").addEventListener("click", () => App.snapBound("end"));
$("set-end").addEventListener("click", () => App.setEnd());
$("merge-prev").addEventListener("click", () => App.merge("prev"));
$("merge-next").addEventListener("click", () => App.merge("next"));
$("split-btn").addEventListener("click", () => App.split());
$("delete-soft").addEventListener("click", () => App.deleteSoft());
TextEditor.onRender = () => { if (App._whoColumn && State.manifest) App.fitColumns(); };
window.addEventListener("resize", () => { if (App._whoColumn && State.manifest && State.view === "editor") App.fitColumns(); });
$("unvoiced-btn").addEventListener("click", () => App.toggleUnvoiced());
$("unvoiced-btn").innerHTML = ICONS.unvoiced;
$("sound-btn").innerHTML = ICONS.soundOnly;
$("sound-btn").addEventListener("click", () => App.toggleSoundOnly());
window.addEventListener("resize", () => State.view === "editor" && App.fitTextBox());
$("video-wrap").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  Zoom.toggle(e);
});
for (const [id, action] of [["speaker-prev", "prev"], ["speaker-clear", "clear"], ["speaker-rover", "rover"], ["speaker-next", "next"]]) {
  // mousedown не уводит фокус из текста; сам клик – смена говорящего.
  $(id).addEventListener("mousedown", (e) => e.preventDefault());
  $(id).addEventListener("click", () => App.changeSpeaker(action));
}
$("delete-hard").addEventListener("click", () => App.deleteHard());

// Скорость: шаг 0.1× от 0.5× до 2× (округление убирает накопление 0.30000000000000004).
const changeSpeed = (delta) => Player.setSpeed(clamp(Math.round((State.speed + delta) * 10) / 10, 0.5, 2));
$("speed-down").addEventListener("click", () => changeSpeed(-0.1));
$("speed-up").addEventListener("click", () => changeSpeed(0.1));
$("speed-value").addEventListener("click", () => Player.setSpeed(1));
App.renderSpeed();

$("nav-back-10").addEventListener("click", () => App.goStep(-10));
$("nav-back-1").addEventListener("click", () => App.goStep(-1));
$("nav-fwd-1").addEventListener("click", () => App.goStep(1));
$("nav-fwd-10").addEventListener("click", () => App.goStep(10));
$("finish-btn").addEventListener("click", () => App.finish());

// Браузер сам ничего в фразе не меняет: каждое действие перехватывается и
// применяется к токенам (правила — в textedit.js).
$("cur-text").addEventListener("beforeinput", (e) => {
  if (e.isComposing) return;
  e.preventDefault();
  if (e.inputType === "historyUndo") return App.textHistory(-1);
  if (e.inputType === "historyRedo") return App.textHistory(1);
  const el = $("cur-text");
  const sel = TextEditor.selection(el);
  const before = TextEditor._snapshot(sel ? sel[0] : 0);
  const caret = TextEditor.apply(el, e);
  if (caret === null) return;
  TextEditor.undoStack.push(before);
  if (TextEditor.undoStack.length > TextEditor.HISTORY_LIMIT) TextEditor.undoStack.shift();
  TextEditor.redoStack = [];
  App.onTokensChanged(caret);
});
// Копирование и вырезание берут выделенное как обычный текст (красное
// тоже); вырезанное "удаляется" по тем же правилам, что и Backspace.
function copySelectionText(e) {
  const el = $("cur-text");
  const sel = TextEditor.selection(el);
  if (!sel || sel[0] === sel[1]) return null;
  // Копируется всё выделенное как обычный текст, в том числе красное: его
  // можно вставить обратно на то же место, и оно снова станет белым.
  const text = TextEditor.tokens.slice(sel[0], sel[1]).map((t) => t.ch).join("");
  e.clipboardData.setData("text/plain", text);
  e.preventDefault();
  return sel;
}
$("cur-text").addEventListener("copy", (e) => copySelectionText(e));
// Вставка: текст берётся прямо из события paste (в beforeinput браузер
// отдаёт его не всегда) и вводится по тем же правилам, что и набор.
$("cur-text").addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
  if (!text) return;
  const el = $("cur-text");
  const sel = TextEditor.selection(el);
  const before = TextEditor._snapshot(sel ? sel[0] : 0);
  const caret = TextEditor.apply(el, { inputType: "insertText", data: text });
  if (caret === null) return;
  TextEditor.undoStack.push(before);
  TextEditor.redoStack = [];
  App.onTokensChanged(caret);
});
$("cur-text").addEventListener("cut", (e) => {
  const sel = copySelectionText(e);
  if (!sel) return;
  TextEditor.undoStack.push(TextEditor._snapshot(sel[0]));
  TextEditor.redoStack = [];
  TextEditor.deleteRange(sel[0], sel[1]);
  App.onTokensChanged(sel[0]);
});
$("cur-text").addEventListener("compositionend", () => App.resyncFromDom());
$("cur-text").addEventListener("blur", () => App.onTextBlur());

// Горячие клавиши. Клавиши определяются по физическому положению (e.code),
// поэтому работают и в русской раскладке (A = Ф, D = В, Q = Й, W = Ц, E = У).
const HOTKEYS = {
  KeyA: () => App.goStep(-1), // предыдущий фрагмент (в рамках фильтра списка)
  KeyD: () => App.goStep(1), // следующий фрагмент (в рамках фильтра списка)
  "Shift+KeyA": () => App.step(-1), // на кадр назад (или выделенную границу)
  "Shift+KeyD": () => App.step(1), // на кадр вперёд
  ArrowLeft: () => App.step(-1),
  ArrowRight: () => App.step(1),
  Space: () => Player.togglePlay(), // пауза / воспроизведение
  KeyW: () => Player.replay(), // повтор с начала отрезка
  "Shift+Space": () => Player.replayFromMarker(), // повтор с жёлтой метки (нет метки — ничего)
  KeyQ: () => App.snapBound("start"), // начало отрезка — к концу предыдущего (кнопка слева)
  "Shift+KeyQ": () => App.select("start"), // выделить начало отрезка
  "Shift+KeyW": () => App.select("playhead"), // выделить текущий кадр
  KeyE: () => App.snapBound("end"), // конец отрезка — к началу следующего (кнопка справа)
  "Shift+KeyE": () => App.select("end"), // выделить конец отрезка
  KeyR: () => App.changeSpeaker("rover"), // кнопка R: говорящий – Rover (ещё раз – как было)
  // Пометить на удаление / снять пометку (как кнопка корзины); переданные в Anki — нельзя.
  KeyS: () => currentFragment() && !isLocked(currentFragment()) && App.deleteSoft(),
};

// Буфер имён: 7 недавних говорящих (свежие сверху). Обновляется только при
// переходе к другому фрагменту: сначала говорящие покинутого (уже с правками –
// подставленное имя тоже попадает в буфер), потом открытого. Пока работаешь
// с одним фрагментом, список не двигается (раньше каждая правка/‹/› его
// переставляла и номера "уезжали").
// Alt+F (или F вне поля текста) открывает окошко поверх видео, справа:
// цифра 1–7 – имя сразу; или S – вверх, W – вниз и F / Alt+F – выбрать
// подсвеченное. В поле текста дальше так же: 1 / 2 (или S/W и F / Alt+F):
// 1 – говорящим в начало фразы ("Имя: ", прежний говорящий заменяется),
// 2 – в место каретки / вместо выделенного (без двоеточия); вне поля – сразу
// говорящим в начало. Пока окошко открыто, его клавиши в текст не идут;
// любая другая клавиша (и Ctrl) его закрывает. Отмена – Ctrl+Z.
const Names = {
  LIMIT: 7,
  list: [],
  stage: null, // null | "pick" | "how"
  chosen: null,
  cursor: 0, // подсвеченная строка окошка
  lastFragment: null, // фрагмент, чьи имена уже в буфере (id и сам объект)

  remember(name) {
    if (!name) return;
    this.list = [name, ...this.list.filter((n) => n !== name)].slice(0, this.LIMIT);
  },

  // Говорящие фрагмента – самыми свежими (первая реплика – на самом верху).
  rememberFragment(f) {
    const names = (f.text || "").split("\n").map((l) => speakerPrefix(l)).filter(Boolean).map((p) => p.name);
    for (const name of names.reverse()) this.remember(name);
  },

  // Открыт фрагмент. Тот же самый (повторная отрисовка после правки, удаления,
  // отмены) – буфер не трогаем.
  visit(f) {
    const last = this.lastFragment;
    if (last && last.id === f.id) return;
    if (last) {
      const left = (State.manifest.fragments || []).find((x) => x.id === last.id);
      if (left) this.rememberFragment(left);
    }
    this.rememberFragment(f);
    this.lastFragment = { id: f.id };
  },

  box() {
    let el = document.getElementById("names-box");
    if (!el) {
      el = document.createElement("div");
      el.id = "names-box";
      $("video-wrap").appendChild(el);
    }
    return el;
  },

  open() {
    this.stage = "pick";
    this.chosen = null;
    this.cursor = 0;
    this.draw();
    this.box().classList.add("open");
  },

  // Строки текущего шага окошка.
  options() {
    return this.stage === "how" ? ["говорящим в начало", "в место курсора"] : this.list;
  },

  draw() {
    const title = this.stage === "how" ? escapeHtml(this.chosen) : "Имена";
    const items = this.options().map((n, i) =>
      `<div class="names-item${i === this.cursor ? " active" : ""}"><b>${i + 1}</b> ${escapeHtml(n)}</div>`).join("")
      || '<div class="names-empty">Имён пока нет</div>';
    this.box().innerHTML = `<div class="names-title">${title}</div>${items}`;
  },

  // Выбрана строка n (с 1) текущего шага.
  choose(n) {
    const editing = document.activeElement === $("cur-text");
    if (this.stage === "pick") {
      this.chosen = this.list[n - 1];
      if (!editing) {
        this.close();
        App.insertName(this.chosen, "prefix");
        return;
      }
      this.stage = "how";
      this.cursor = 0;
      this.draw();
      return;
    }
    const name = this.chosen;
    this.close();
    App.insertName(name, n === 1 ? "prefix" : "inline");
  },

  close() {
    this.stage = null;
    this.box().classList.remove("open");
  },

  // Клавиша, пока окошко открыто. true – клавиша обработана здесь.
  key(e) {
    if (!this.stage) return false;
    const digit = /^Digit([1-9])$/.exec(e.code) || /^Numpad([1-9])$/.exec(e.code);
    const n = digit ? Number(digit[1]) : 0;
    const count = this.options().length;
    if (n >= 1 && n <= count) {
      e.preventDefault();
      this.choose(n);
      return true;
    }
    // S – вверх, W – вниз (по кругу); F / Alt+F – выбрать подсвеченное.
    // Без Ctrl: Ctrl закрывает окошко, как и раньше.
    if (!e.ctrlKey && (e.code === "KeyS" || e.code === "KeyW")) {
      e.preventDefault();
      if (count) {
        this.cursor = (this.cursor + (e.code === "KeyS" ? -1 : 1) + count) % count;
        this.draw();
      }
      return true;
    }
    if (!e.ctrlKey && e.code === "KeyF") {
      e.preventDefault();
      if (count) this.choose(this.cursor + 1);
      else this.close();
      return true;
    }
    // Любая другая клавиша (в том числе Ctrl) – окошко закрывается; цифра
    // мимо списка – не печатается.
    this.close();
    if (digit) {
      e.preventDefault();
      return true;
    }
    return false;
  },
};

// Последняя вставка Alt+R (ещё раз Alt+R – убрать её): фрагмент и состояние до неё.
let roverInsert = null;

// Одиночный Ctrl (нажат и отпущен без других клавиш и кликов) внутри текста —
// выйти из текста, как Esc: в режиме набора горячие клавиши не работают.
// Программы переназначения клавиш (AutoHotkey и т.п.) при Alt+клавиша сами
// посылают мгновенное нажатие Ctrl ("маска", чтобы не открылось меню окна) —
// его не считаем: Ctrl рядом с Alt или короче CTRL_MIN_MS не выводит из текста.
const CTRL_MIN_MS = 40;
const ALT_QUIET_MS = 400;
let ctrlAlone = false;
let ctrlDownAt = 0;
let altAt = 0;
document.addEventListener("mousedown", () => (ctrlAlone = false), true);

// Зажатый Shift во время воспроизведения — временно 2× (отпустил — прежняя
// скорость). Shift вместе с другой клавишей (Shift+A, Shift+Пробел…) — это
// сочетание, ускорение сразу снимается.
function shiftBoostAllowed(e) {
  return State.view === "editor" && State.manifest && !e.target.isContentEditable
    && !["TEXTAREA", "INPUT"].includes(e.target.tagName);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Shift") {
    if (!e.repeat && Player.playing && shiftBoostAllowed(e)) Player.setBoost(true);
  } else if (State.boost) {
    Player.setBoost(false, false); // сочетание с Shift — его действие само решит, играть ли дальше
  }
}, true);
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && State.boost) Player.setBoost(false);
}, true);
window.addEventListener("blur", () => State.boost && Player.setBoost(false));

// Идёт перекраска карточек Anki (State.ankiLocked, см. Activity в js/shell.js):
// в редакторе работают только просмотр и переходы – воспроизведение,
// повтор, соседние фрагменты; клавиши правки не срабатывают (иначе правка
// применилась бы на экране, а сервер её отклонил).
const VIEW_ONLY_KEYS = new Set(["Space", "KeyW", "KeyA", "KeyD", "ShiftLeft", "ShiftRight", "Escape", "ControlLeft", "ControlRight", "AltLeft", "AltRight"]);
document.addEventListener("keydown", (e) => {
  if (!State.ankiLocked || State.view !== "editor" || !State.manifest) return;
  const typing = e.target.isContentEditable || ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName);
  if (!typing && VIEW_ONLY_KEYS.has(e.code) && !e.ctrlKey) return;
  if (e.code === "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!e.repeat) App.flash("Идёт перекраска карточек Anki – правка недоступна, подождите");
}, true);

// Буфер имён и Alt+R – раньше остальных обработчиков (работают и в поле текста).
document.addEventListener("keydown", (e) => {
  if (State.view !== "editor" || !State.manifest) return;
  if (Names.stage) {
    // Сами по себе Shift и Alt окошко не закрывают (Alt – начало Alt+F,
    // которым выбирают подсвеченное); Ctrl закрывает.
    if (["Shift", "Alt", "Meta"].includes(e.key)) return;
    if (Names.key(e)) {
      e.stopImmediatePropagation();
      return;
    }
  }
  // Alt+F – везде; просто F – когда не пишешь в поле текста (и не в другом поле ввода).
  const typing = e.target.isContentEditable || ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName);
  if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.altKey || !typing)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    Names.open();
    return;
  }
  if (e.altKey && !e.ctrlKey && e.code === "KeyR" && document.activeElement === $("cur-text")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    App.insertRover();
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Alt" || e.altKey) altAt = performance.now();
  if (e.key === "Control") {
    if (!e.repeat) {
      ctrlAlone = true;
      ctrlDownAt = performance.now();
    }
  } else {
    ctrlAlone = false;
  }
  // Горячие клавиши редактора работают только на странице редактора.
  if (State.view !== "editor" || !State.manifest) return;
  const tag = e.target.tagName;
  // Внутри текста — обычный набор; своя отмена и Esc — выйти из текста.
  if (e.target.isContentEditable) {
    if (e.ctrlKey && (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey))) {
      e.preventDefault();
      App.textHistory(1);
    } else if (e.ctrlKey && e.code === "KeyZ") {
      e.preventDefault();
      App.textHistory(-1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.target.blur();
    }
    return;
  }
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  if (e.ctrlKey || e.metaKey) {
    if (e.code === "Space") {
      // Ctrl+Пробел — повтор с жёлтой метки.
      e.preventDefault();
      if (document.activeElement && document.activeElement.tagName === "BUTTON") document.activeElement.blur();
      Player.replayFromMarker();
    } else if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) {
      e.preventDefault();
      App.redo();
    } else if (e.code === "KeyZ") {
      e.preventDefault();
      App.undo();
    }
    return;
  }
  if (e.altKey) return;
  const action = HOTKEYS[(e.shiftKey ? "Shift+" : "") + e.code];
  if (!action) return;
  e.preventDefault();
  // Пробел не должен ещё и "нажимать" кнопку, на которой остался фокус после клика.
  if (document.activeElement && document.activeElement.tagName === "BUTTON") document.activeElement.blur();
  action();
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && !e.target.isContentEditable) e.preventDefault();
  if (e.key === "Alt" || e.altKey) altAt = performance.now();
  const now = performance.now();
  const real = now - ctrlDownAt >= CTRL_MIN_MS && now - altAt > ALT_QUIET_MS;
  if (e.key === "Control" && ctrlAlone && real && e.target.isContentEditable && State.view === "editor") {
    e.target.blur();
  } else if (e.key === "Control" && ctrlAlone && real && State.view === "editor" && !e.target.isContentEditable
    && !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) && currentFragment() && !isLocked(currentFragment())) {
    // Одиночный Ctrl вне поля текста – войти в поле, каретка в конец.
    const el = $("cur-text");
    el.focus();
    TextEditor.setCaret(el, TextEditor.tokens.length);
  }
  if (e.key === "Control") ctrlAlone = false;
});
