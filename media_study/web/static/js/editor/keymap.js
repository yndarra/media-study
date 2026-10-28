// Горячие клавиши редактора: действия, их клавиши по умолчанию и свои
// (настройки → «Горячие клавиши», хранятся в settings.hotkeys как
// {действие: ["KeyA", "Shift+KeyD", …]}).
//
// Сочетание – строка из модификаторов и e.code (физическая клавиша, поэтому
// работает и в русской раскладке): "Ctrl+Shift+KeyZ", "Space", "ArrowLeft".
// У одного действия может быть несколько сочетаний; одно сочетание – только у
// одного действия (назначили занятое – у прежнего оно снимается).
//
// buttons – кнопки этого действия: в их подсказке (title) дописывается
// клавиша; inText – работает и в поле текста (text – что делать там);
// view – можно и во время перекраски карточек Anki (только просмотр).
const Keymap = {
  ACTIONS: [
    { id: "play", label: "Воспроизведение / пауза", keys: ["Space"], view: true, buttons: ["play-pause"],
      run: () => Player.togglePlay() },
    { id: "replay", label: "Повтор с начала отрезка", keys: ["KeyW"], view: true, buttons: ["replay-btn"],
      run: () => Player.replay() },
    { id: "replayMarker", label: "Повтор с жёлтой метки", keys: ["Shift+Space"], view: true, buttons: ["replay-marker-btn"],
      run: () => Player.replayFromMarker() },
    { id: "prev", label: "Предыдущий фрагмент (в рамках фильтра списка)", keys: ["KeyA"], view: true, buttons: ["nav-back-1"],
      run: () => App.goStep(-1) },
    { id: "next", label: "Следующий фрагмент (в рамках фильтра списка)", keys: ["KeyD"], view: true, buttons: ["nav-fwd-1"],
      run: () => App.goStep(1) },
    { id: "frameBack", label: "Кадр назад (или выделенная граница)", keys: ["ArrowLeft", "Shift+KeyA"], view: true,
      buttons: ["step-back-1"], run: () => App.step(-1) },
    { id: "frameFwd", label: "Кадр вперёд (или выделенная граница)", keys: ["ArrowRight", "Shift+KeyD"], view: true,
      buttons: ["step-fwd-1"], run: () => App.step(1) },
    { id: "snapStart", label: "Начало отрезка – к концу предыдущего", keys: ["KeyQ"], buttons: ["snap-start"],
      run: () => App.snapBound("start") },
    { id: "snapEnd", label: "Конец отрезка – к началу следующего", keys: ["KeyE"], buttons: ["snap-end"],
      run: () => App.snapBound("end") },
    { id: "selectStart", label: "Выделить начало отрезка", keys: ["Shift+KeyQ"], run: () => App.select("start") },
    { id: "selectEnd", label: "Выделить конец отрезка", keys: ["Shift+KeyE"], run: () => App.select("end") },
    { id: "selectPlayhead", label: "Выделить текущий кадр", keys: ["Shift+KeyW"], run: () => App.select("playhead") },
    { id: "delete", label: "Пометить на удаление (ещё раз – снять)", keys: ["KeyS"], buttons: ["delete-soft"],
      run: () => currentFragment() && !isLocked(currentFragment()) && App.deleteSoft() },
    { id: "rover", label: "Говорящий – Rover (ещё раз – как было)", keys: ["KeyR"], buttons: ["speaker-rover"],
      run: () => App.changeSpeaker("rover") },
    { id: "join", label: "Склеить в одну фразу (ещё раз – как было)", keys: ["Ctrl+Space"], inText: true, buttons: ["junction-join"],
      run: () => App.toggleJunction() },
    { id: "undo", label: "Отменить действие", keys: ["Ctrl+KeyZ"], inText: true, buttons: ["undo-btn"],
      run: () => App.undo(), text: () => App.textHistory(-1) },
    { id: "redo", label: "Вернуть отменённое", keys: ["Ctrl+KeyY", "Ctrl+Shift+KeyZ"], inText: true, buttons: ["redo-btn"],
      run: () => App.redo(), text: () => App.textHistory(1) },
  ],
  // Неизменяемые (особая обработка) – только для справки в настройках.
  FIXED: [
    ["Shift (зажать)", "Скорость 2×, пока держишь"],
    ["Ctrl", "Войти в поле реплик (каретка в конец) / выйти из текста"],
    ["Shift+Ctrl", "Войти в поле говорящих"],
    ["Esc", "Выйти из текста"],
    ["Alt+R", "В тексте: «Rover» в место каретки или вместо выделенного (ещё раз – убрать)"],
    ["Alt+F / F", "Буфер имён (F – вне поля текста): цифра 1–7 или S/W и F – выбрать; в тексте затем 1 – говорящим в начало, 2 – в место каретки"],
    ["Backspace", "В пустой строке – убрать эту строку (в двух полях – только в своём поле)"],
    ["Правая кнопка по видео", "Приблизить область (ещё раз – обратно)"],
  ],
  overrides: {}, // свои клавиши из настроек: {действие: [сочетания]}
  _byCombo: null,

  keysOf(action) {
    return this.overrides[action.id] || action.keys;
  },

  setOverrides(map) {
    this.overrides = map && typeof map === "object" ? map : {};
    this._byCombo = null;
  },

  // Сочетание нажатой клавиши (модификаторы сами по себе – не сочетание).
  comboOf(e) {
    if (["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)) return null;
    return (e.ctrlKey || e.metaKey ? "Ctrl+" : "") + (e.shiftKey ? "Shift+" : "") + (e.altKey ? "Alt+" : "") + e.code;
  },

  match(e) {
    if (!this._byCombo) {
      this._byCombo = new Map();
      for (const a of this.ACTIONS) for (const k of this.keysOf(a)) this._byCombo.set(k, a);
    }
    const combo = this.comboOf(e);
    return combo ? this._byCombo.get(combo) || null : null;
  },

  // Подпись сочетания: "Ctrl+Shift+Z", "Пробел", "←".
  label(combo) {
    const names = { Space: "Пробел", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc",
      Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Tab: "Tab", Comma: ",", Period: ".", Slash: "/",
      Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`" };
    return combo.split("+").map((p) => names[p] || p.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ")).join("+");
  },

  // Подсказки кнопок: клавиша дописывается при наведении (заголовки кнопок
  // меняются по ходу работы – поэтому не один раз, а перед показом).
  SUFFIX: /\s+·\s+Клавиш[аи]: .*$/,
  annotate(button) {
    const action = this.ACTIONS.find((a) => (a.buttons || []).includes(button.id));
    if (!action) return;
    const base = (button.getAttribute("title") || "").replace(this.SUFFIX, "");
    const keys = this.keysOf(action);
    button.setAttribute("title", keys.length ? `${base} · Клавиш${keys.length > 1 ? "и" : "а"}: ${keys.map((k) => this.label(k)).join(" / ")}` : base);
  },
};

document.addEventListener("mouseover", (e) => {
  const button = e.target.closest && e.target.closest("button[id], a[id]");
  if (button) Keymap.annotate(button);
}, true);
