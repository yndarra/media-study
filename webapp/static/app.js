// Общее состояние редактора и вся логика кнопок/текста/навигации.
// timeline.js и player.js обращаются к State/App/currentFragment лениво —
// в момент вызова страница уже полностью загружена.
const State = {
  manifest: null,
  fragmentIndex: -1,
  currentFrame: 0,
  timeMarkerFrame: null,
  stopAtSegmentEnd: true, // режим остановки на последнем кадре отрезка (кнопка рядом с Play)
  selected: "playhead", // что двигают ±1/±10 и стрелки: "playhead" | "start" | "end"
  lastStop: null, // {frame} — где было последнее автоматическое завершение воспроизведения
  manualPlayhead: false, // текущий кадр выбран вручную на дорожке (для жёлтой метки)
  stage3: { eta_seconds: 0, pending_ids: [], state: "idle", message: "" }, // очередь Anki открытого видео
  project: null, // код открытого в редакторе видео
  view: null, // открытая страница: videos | video | anki | download | editor
  speed: loadSpeed(), // скорость воспроизведения — общая для всех видео (0.5–2)
  translatedIds: new Set(), // фрагменты открытого видео, переведённые в Anki (розовый фон в списке)
  // Автозапуск: переход к фрагменту, клик/протяжка по дорожке и левая граница
  // отрезка сразу запускают воспроизведение (кнопка справа от режима остановки).
  autoPlay: loadAutoPlay(),
};

function loadAutoPlay() {
  try {
    return localStorage.getItem("auto-play") !== "off";
  } catch (_) {
    return true;
  }
}

// Скорость воспроизведения хранится в браузере и общая для всех видео.
function loadSpeed() {
  try {
    const value = Number(localStorage.getItem("playback-speed"));
    if (value >= 0.5 && value <= 2) return value;
  } catch (_) {}
  return 1;
}

// Скорость, пока зажат Shift.
const BOOST_SPEED = 2;

function currentFragment() {
  return State.manifest ? State.manifest.fragments[State.fragmentIndex] : null;
}

function fps() {
  return State.manifest.video.fps;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(value, high));
}

// Фрагмент хоть как-то изменён — для "скрытого прогресса": редактор
// открывается на последнем таком фрагменте (то же правило, что webapp/library.py).
function isTouched(f) {
  return !!(f.exported || f.status !== "active" || isTextEdited(f) || isBoundsEdited(f) || f.context_custom || f.merged_from || f.split_from);
}

// Отметка "не озвучено" — ставится кнопкой (как Fragment.is_unvoiced на сервере).
function isUnvoiced(f) {
  return !!(f && f.unvoiced);
}

// Фрагмент передан в Anki (этап 3): его можно только просматривать.
function isLocked(f) {
  return !!(f && f.exported);
}

function isTextEdited(f) {
  return f.text !== f.original_text;
}

function isBoundsEdited(f) {
  return f.algo_start_frame !== f.original_algo_start_frame || f.algo_end_frame !== f.original_algo_end_frame;
}

// Чистка текста по тому же правилу, что на сервере (common/text_clean.py):
// без невидимых пробелов, без повторных пробелов, без пустых строк.
function cleanText(text) {
  return (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line)
    .join("\n");
}

// Время в формате ЧЧ:ММ:СС.
function formatClock(seconds) {
  const total = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const ICONS = {
  play: '<svg viewBox="0 0 20 20"><path d="M6 4l10 6-10 6z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 20 20"><path d="M6.5 4v12M13.5 4v12" stroke-width="3"/></svg>',
  // Остановка на конце отрезка включена / выключена (играть до конца видео).
  segment: '<svg viewBox="0 0 20 20"><path d="M2 10h16"/><rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor"/></svg>',
  fragment: '<svg viewBox="0 0 20 20"><rect x="2" y="6" width="16" height="8" rx="1" fill="currentColor"/></svg>',
  // Автозапуск включён / выключен: треугольник Play с буквой A (выкл. — перечёркнут).
  autoOn: '<svg viewBox="0 0 20 20"><path d="M3.5 4.5l8 5.5-8 5.5z" fill="currentColor"/>' +
    '<path d="M12.5 16.5l2.5-7 2.5 7M13.4 14h3.2" stroke-width="1.4"/></svg>',
  autoOff: '<svg viewBox="0 0 20 20" opacity="0.55"><path d="M3.5 4.5l8 5.5-8 5.5z" fill="currentColor"/>' +
    '<path d="M12.5 16.5l2.5-7 2.5 7M13.4 14h3.2" stroke-width="1.4"/><path d="M2.5 17.5l15-15" stroke="#ff6b6b" stroke-width="1.6"/></svg>',
};

const $ = (id) => document.getElementById(id);

// Приближение видео правой кнопкой (только для текущего фрагмента, не
// сохраняется): вокруг точки появляется рамка в 1.7 раза меньше кадра (у края –
// прижимается к нему), затем рамка вместе с содержимым растягивается на весь
// плеер. Правая кнопка ещё раз – обратно. Остальное в редакторе работает как
// обычно.
const Zoom = {
  SCALE: 1.7,
  fragmentId: null,

  targets() {
    return [$("video"), $("freeze")];
  },

  toggle(e) {
    if (this.fragmentId && currentFragment() && this.fragmentId === currentFragment().id) return this.reset();
    const wrap = $("video-wrap");
    const rect = wrap.getBoundingClientRect();
    // Сама картинка внутри плеера (без чёрных полей по бокам/сверху).
    const video = $("video");
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : rect.width / rect.height;
    const cw = Math.min(rect.width, rect.height * ratio);
    const ch = cw / ratio;
    const cx = (rect.width - cw) / 2;
    const cy = (rect.height - ch) / 2;
    const w = cw / this.SCALE;
    const h = ch / this.SCALE;
    const x = clamp(e.clientX - rect.left - w / 2, cx, cx + cw - w);
    const y = clamp(e.clientY - rect.top - h / 2, cy, cy + ch - h);
    this.fragmentId = currentFragment() ? currentFragment().id : null;
    // Рамка-"скриншот"...
    const frame = document.createElement("div");
    frame.className = "zoom-frame";
    Object.assign(frame.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    wrap.appendChild(frame);
    // Рамка (x, y) после увеличения встаёт ровно на место картинки (cx, cy).
    const transform = `translate(${cx - x * this.SCALE}px, ${cy - y * this.SCALE}px) scale(${this.SCALE})`;
    // ...затем она и содержимое растягиваются на весь плеер.
    setTimeout(() => {
      for (const el of [...this.targets(), frame]) {
        el.style.transformOrigin = "0 0";
        el.style.transition = "transform 0.35s cubic-bezier(0.22, 0.61, 0.36, 1)";
        el.style.transform = transform;
      }
      // Рамка гаснет, пока растягивается.
      frame.style.transition += ", opacity 0.3s ease-in 0.1s";
      frame.style.opacity = "0";
      setTimeout(() => frame.remove(), 450);
    }, 180);
  },

  reset(instant = false) {
    this.fragmentId = null;
    for (const el of this.targets()) {
      el.style.transition = instant ? "none" : "transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1)";
      el.style.transform = "";
    }
  },
};

// Поля правимой фразы слева и справа (px).
const TEXT_BOX_PAD = 50;

// Шаг кнопок запаса ±3 с (совпадает с PADDING_STEP_SECONDS на сервере).
const PADDING_STEP_SECONDS = 3;

const App = {
  textTimer: null,
  textFragment: null,
  boundsTimer: null,
  boundsFragment: null,
  toastTimer: null,

  // Открыть видео в редакторе. Встаём на последний изменённый фрагмент —
  // там, где остановились в прошлый раз.
  async openProject(id) {
    if (State.project === id && State.manifest) return;
    await this.flushSaves();
    Player.pauseIfPlaying();
    State.project = id;
    State.manifest = null;
    State.fragmentIndex = -1;
    State.stage3 = { eta_seconds: 0, pending_ids: [], state: "idle", message: "" };
    AudioEngine.cache.clear();
    Player.setSource(`/media/${encodeURIComponent(id)}/source.mp4`);
    Timeline.loadWaveform(`/media/${encodeURIComponent(id)}/waveform.bin`);
    const manifest = await this._call(Api.getManifest());
    if (!manifest) return;
    State.manifest = manifest;
    FragList.reset();
    let last = -1;
    manifest.fragments.forEach((f, i) => {
      if (isTouched(f)) last = i;
    });
    await this.open(Math.max(0, last));
  },

  // -- открытие фрагментов -----------------------------------------------------

  async open(index) {
    if (!State.manifest) return;
    index = clamp(index, 0, State.manifest.fragments.length - 1);
    await this.flushSaves();
    State.fragmentIndex = index;
    const f = currentFragment();
    State.timeMarkerFrame = null;
    State.lastStop = null;
    State.selected = "playhead";
    // Звук окна фрагмента — заранее, чтобы Play зазвучал без задержки.
    AudioEngine.load(f).catch(() => {});
    // При любом открытии текущий кадр стоит на начале отрезка; приближение –
    // только для того фрагмента, где его включили.
    if (Zoom.fragmentId && Zoom.fragmentId !== f.id) Zoom.reset(true);
    if (this.speakerState && this.speakerState.id !== f.id) this.speakerState = null;
    Player.jumpTo(f.algo_start_frame);
    this.renderAll(true);
    this.refreshHistory();
  },

  // Переход к другому фрагменту по кнопкам/клавишам/списку: открыть и сразу
  // воспроизвести отрезок с начала (при открытии видео — без автозапуска:
  // браузер не даёт играть звук без действия пользователя).
  // Вперёд/назад на step фрагментов — среди видимых в фильтре списка справа.
  goStep(step) {
    const index = FragList.stepIndex(State.fragmentIndex, step);
    if (index !== null) this.go(index);
  },

  async go(index) {
    if (!State.manifest) return;
    await this.open(index);
    if (State.autoPlay) Player.replay();
  },

  // После операции на сервере: если остаёмся на том же фрагменте — текущий
  // кадр и метка не трогаются (только прижимаются внутрь фрагмента), иначе
  // фрагмент открывается как обычно.
  async showFragment(manifest, focusId) {
    const previousId = currentFragment() ? currentFragment().id : null;
    if (!manifest || !Array.isArray(manifest.fragments)) {
      console.warn("неожиданный ответ сервера — перечитываю манифест");
      manifest = await this._call(Api.getManifest());
      if (!manifest) return;
    }
    State.manifest = manifest;
    const index = manifest.fragments.findIndex((f) => f.id === focusId);
    if (index < 0) {
      await this.open(State.fragmentIndex);
      return;
    }
    if (focusId === previousId) {
      State.fragmentIndex = index;
      this.keepInsideFragment();
      this.renderAll(true);
    } else {
      await this.open(index);
    }
  },

  // Запас фрагмента мог уменьшиться — текущий кадр и метка не должны
  // остаться за краями дорожки.
  keepInsideFragment() {
    const f = currentFragment();
    const inside = (frame) => frame >= f.context_start_frame && frame < f.context_end_frame;
    if (State.timeMarkerFrame !== null && !inside(State.timeMarkerFrame)) State.timeMarkerFrame = null;
    if (!inside(State.currentFrame)) {
      Player.jumpTo(clamp(State.currentFrame, f.context_start_frame, f.context_end_frame - 1));
    }
  },

  async openById(id) {
    const index = State.manifest.fragments.findIndex((f) => f.id === id);
    if (index >= 0) await this.open(index);
    else this.renderAll(true);
  },

  // Shift+Q / Shift+E: выделить границу отрезка (её двигают ±1/±10 и
  // стрелки) и перенести на неё текущий кадр. Shift+W — выделить текущий кадр.
  select(target) {
    if (!currentFragment()) return;
    State.selected = target;
    if (target === "playhead") this.renderAll();
    else this.jumpToBound(target);
  },

  jumpToBound(target) {
    const f = currentFragment();
    // Для конца показываем последний кадр отрезка (конец — полуинтервал).
    Player.jumpTo(target === "start" ? f.algo_start_frame : f.algo_end_frame - 1);
    this.renderAll();
  },

  // -- отрисовка ---------------------------------------------------------------

  renderAll(forceText = false) {
    const f = currentFragment();
    if (!f) return;
    FragList.schedule();
    Timeline.render(f, State);
    this.renderStatus(f);
    this.renderButtons(f);
    this.renderText(f, forceText);
    this.renderNav();
    this.renderReadout();
  },

  renderPlayback() {
    const f = currentFragment();
    if (!f) return;
    Timeline.render(f, State);
    this.renderButtons(f);
    this.renderReadout();
  },

  renderStatus(f) {
    const textEdited = isTextEdited(f);
    const boundsEdited = isBoundsEdited(f);
    const deleted = f.status !== "active";
    $("fragment-status").textContent = f.id;
    $("text-edited-badge").classList.toggle("hidden", !textEdited);
    $("bounds-edited-badge").classList.toggle("hidden", !boundsEdited);
    $("merged-badge").classList.toggle("hidden", !f.merged_from);
    $("split-badge").classList.toggle("hidden", !f.split_from);
    // Reset виден всегда; серый, когда возвращать нечего.
    $("reset-btn").disabled = !(textEdited || boundsEdited || f.restorable || f.context_custom);
    // Серый статус: запас слева/справа изменён вручную.
    $("padding-badge").classList.toggle("hidden", !f.context_custom);
    const seconds = (frames) => Math.round((frames / fps()) * 10) / 10;
    $("padding-badge").textContent =
      `Запас ${seconds(f.original_algo_start_frame - f.context_start_frame)} с · ` +
      `${seconds(f.context_end_frame - f.original_algo_end_frame)} с`;
    $("deleted-badge").classList.toggle("hidden", !deleted);
    $("review-badge").classList.toggle("hidden", !f.needs_review);
    $("review-badge").title = f.review_note ? `${f.review_note} — нажмите, если текст проверен` : "Текст проверен — снять пометку";
    // Удалённый фрагмент — красноватый фон всей страницы, переданный в Anki — желтоватый.
    const locked = isLocked(f);
    const done = locked && !State.stage3.pending_ids.includes(f.id);
    $("stage3-badge").classList.toggle("hidden", !locked);
    $("stage3-badge").classList.toggle("done", done);
    $("stage3-badge").textContent = done ? "В Anki ✓" : "В очереди в Anki";
    // Фон редактора — этап фрагмента (как фон строки в списке справа): красноватый —
    // удалён, желтоватый — передаётся в Anki, зеленоватый — в Anki, розоватый —
    // в Anki и переведён, фиолетоватый — вернулся из Anki. Только в редакторе.
    const inEditor = State.view === "editor";
    const stage = FragList.stageClass(f);
    document.body.classList.toggle("frag-deleted", inEditor && deleted && !locked);
    document.body.classList.toggle("frag-locked", inEditor && locked);
    for (const cls of ["bg-anki", "bg-pending", "bg-translated", "bg-returned"]) {
      document.body.classList.toggle(`frag-${cls}`, inEditor && stage === cls);
    }
    // Цвет правки (удалён – красный, изменён – жёлтый, не озвучен – бирюзовый,
    // принят без правок – синий) важнее фона этапа Anki (зелёный/розовый);
    // вернувшийся из Anki – фиолетовый.
    let editKind = stage === "bg-returned" ? "" : FragList.editClass(f, State.fragmentIndex, FragList._reviewed());
    if (editKind && editKind !== "deleted" && isUnvoiced(f)) editKind = "unvoiced"; // бирюзовый важнее жёлтого и синего
    for (const kind of ["accepted", "changed", "unvoiced"]) {
      document.body.classList.toggle(`frag-edit-${kind}`, inEditor && !deleted && editKind === kind);
    }
    document.body.classList.toggle("frag-unvoiced", false);
    if (locked) $("reset-btn").disabled = true;
  },

  // Можно ли сдвинуть запас с этой стороны — то же правило, что на сервере
  // (ManifestStore.change_side_padding): увеличение — пока не упёрлись в
  // край видео, уменьшение — не ниже 3 с от исходной границы и не внутрь отрезка.
  canChangePadding(f, side, direction) {
    const step = Math.round(PADDING_STEP_SECONDS * fps());
    const total = State.manifest.video.total_frames;
    if (side === "left" && direction > 0) return f.context_start_frame > 0;
    if (side === "right" && direction > 0) return f.context_end_frame < total;
    if (side === "left") {
      const limit = Math.min(f.context_start_frame + step, f.original_algo_start_frame - step, f.algo_start_frame);
      return limit > f.context_start_frame;
    }
    const limit = Math.max(f.context_end_frame - step, f.original_algo_end_frame + step, f.algo_end_frame);
    return limit < f.context_end_frame;
  },

  renderReadout() {
    const frame = State.currentFrame;
    $("time-readout").textContent = `${formatClock(frame / fps())} · ${frame}`;
  },

  // Ближайший живой (не удалённый) фрагмент слева (-1) или справа (+1).
  _liveNeighbor(direction) {
    const fragments = State.manifest.fragments;
    for (let i = State.fragmentIndex + direction; i >= 0 && i < fragments.length; i += direction) {
      if (fragments[i].status === "active") return fragments[i];
    }
    return null;
  },

  // Куда кнопки "прилепить" перенесли бы границу отрезка (null — некуда):
  //   "start" — на кадр после конца отрезка предыдущего фрагмента;
  //   "end"   — на кадр перед началом отрезка следующего (конец — полуинтервал,
  //             поэтому algo_end_frame = начало следующего).
  // Только если границу соседа меняли (иначе отрезки и так стоят, где
  // нарезал алгоритм) и новое место — внутри фрагмента, отрезок не пустой.
  snapTarget(f, side) {
    if (!f || !State.manifest) return null;
    const neighbor = this._liveNeighbor(side === "start" ? -1 : 1);
    if (!neighbor) return null;
    if (side === "start") {
      if (neighbor.algo_end_frame === neighbor.original_algo_end_frame) return null;
      const target = neighbor.algo_end_frame;
      return target >= f.context_start_frame && target < f.algo_end_frame ? target : null;
    }
    if (neighbor.algo_start_frame === neighbor.original_algo_start_frame) return null;
    const target = neighbor.algo_start_frame;
    return target > f.algo_start_frame && target <= f.context_end_frame ? target : null;
  },

  async snapBound(side) {
    const f = currentFragment();
    const target = this.snapTarget(f, side);
    if (target === null || isLocked(f)) return;
    await this.flushSaves();
    if (side === "start") f.algo_start_frame = target;
    else f.algo_end_frame = target;
    await this.saveBounds(f);
    // Текущий кадр – на новую границу (последний кадр отрезка для конца).
    App.jumpToBound(side);
    // Новое начало – как нажатие на левую границу: с автозапуском играет отсюда.
    if (side === "start" && State.autoPlay && !Player.playing) Player.togglePlay();
  },

  _hasLiveNeighbor(direction) {
    const fragments = State.manifest.fragments;
    for (let i = State.fragmentIndex + direction; i >= 0 && i < fragments.length; i += direction) {
      if (fragments[i].status === "active") return true;
    }
    return false;
  },

  renderButtons(f) {
    const deleted = f.status !== "active";
    const cur = State.currentFrame;
    // Границы и текст можно править и у удалённого фрагмента.
    $("set-start").disabled = cur >= f.algo_end_frame;
    $("set-end").disabled = cur + 1 <= f.algo_start_frame;
    // Объединять можно только с соседним живым фрагментом, который ещё не в
    // Anki (в фильтре "вернулись из Anki" соседи обычно в Anki — недоступно).
    const prevLive = this._liveNeighbor(-1);
    const nextLive = this._liveNeighbor(1);
    $("merge-prev").disabled = deleted || !prevLive || isLocked(prevLive);
    $("merge-next").disabled = deleted || !nextLive || isLocked(nextLive);
    // Делить можно только строго внутри отрезка, не на его крайних кадрах.
    $("split-btn").disabled = deleted || !(cur > f.algo_start_frame && cur < f.algo_end_frame - 1);
    // Повторное нажатие «удалить» снимает пометку удаления.
    $("delete-soft").disabled = deleted && !f.restorable;
    $("delete-soft").title = deleted ? "Снять пометку удаления" : "Пометить на удаление";
    $("delete-hard").disabled = !f.hard_deletable;
    $("replay-marker-btn").disabled = State.timeMarkerFrame === null || State.timeMarkerFrame === undefined;
    $("pad-left-minus").disabled = !this.canChangePadding(f, "left", -1);
    $("pad-left-plus").disabled = !this.canChangePadding(f, "left", 1);
    $("pad-right-minus").disabled = !this.canChangePadding(f, "right", -1);
    $("pad-right-plus").disabled = !this.canChangePadding(f, "right", 1);
    const unvoiced = isUnvoiced(f);
    $("unvoiced-btn").classList.toggle("on", unvoiced);
    $("unvoiced-btn").disabled = isLocked(f);
    for (const id of ["speaker-prev", "speaker-clear", "speaker-rover", "speaker-next"]) $(id).disabled = isLocked(f);
    $("unvoiced-btn").title = unvoiced
      ? "Отмечено: реплика не озвучена – в Anki без видео, только текст (нажмите, чтобы снять)"
      : "Отметить: реплика не озвучена – в Anki без видео, только текст";
    // "Прилепить" к соседу: серые, если некуда или граница уже там.
    const snapStart = this.snapTarget(f, "start");
    const snapEnd = this.snapTarget(f, "end");
    $("snap-start").disabled = snapStart === null || snapStart === f.algo_start_frame;
    $("snap-end").disabled = snapEnd === null || snapEnd === f.algo_end_frame;
    $("snap-start").title = "Начало отрезка – сразу после конца отрезка предыдущего фрагмента" +
      (snapStart === null ? " (границу соседа не меняли)" : snapStart === f.algo_start_frame ? " (уже там)" : "");
    $("snap-end").title = "Конец отрезка – сразу перед началом отрезка следующего фрагмента" +
      (snapEnd === null ? " (границу соседа не меняли)" : snapEnd === f.algo_end_frame ? " (уже там)" : "");
    // Переданный в Anki фрагмент — только просмотр: все кнопки правки серые.
    if (isLocked(f)) {
      for (const id of ["set-start", "set-end", "merge-prev", "merge-next", "split-btn", "delete-soft", "delete-hard",
        "pad-left-minus", "pad-left-plus", "pad-right-minus", "pad-right-plus", "snap-start", "snap-end", "undo-btn", "redo-btn"]) {
        $(id).disabled = true;
      }
    }
    this.renderStage3();
  },

  // Кнопка "добавить в Anki" активна, если среди фрагментов с первого по
  // текущий есть ещё не переданные; слева от неё — оставшееся время очереди.
  renderStage3() {
    // Состояние очереди может прийти раньше, чем загрузился манифест.
    if (!State.manifest || State.fragmentIndex < 0) return;
    const fragments = State.manifest.fragments;
    const hasNew = fragments.slice(0, State.fragmentIndex + 1).some((g) => !isLocked(g));
    // Идёт передача, а текущий фрагмент уже передан (ждёт очереди или в Anki) —
    // кнопка останавливает передачу; на ещё не переданном – "Anki" (очередь
    // продлевается до него).
    const running = State.stage3.pending_ids.length > 0 || State.stage3.notes_left > 0;
    const stop = running && isLocked(currentFragment());
    $("stage3-btn").textContent = stop ? "Остановить" : "Передать в Anki";
    $("stage3-btn").dataset.action = stop ? "stop" : "queue";
    $("stage3-btn").disabled = !stop && !hasNew;
    const s = State.stage3;
    const eta = $("stage3-eta");
    let label = "";
    if (s.state === "waiting_anki") label = "Ждёт Anki";
    else if (s.eta_seconds > 0) label = s.eta_seconds < 60 ? "≈ <1 мин" : `≈ ${Math.ceil(s.eta_seconds / 60)} мин`;
    eta.textContent = label;
    eta.title = s.message || "";
    eta.classList.toggle("hidden", !label);
  },

  onStage3(status) {
    if (!status) return;
    const wasPending = State.stage3.pending_ids.length;
    State.stage3 = status;
    this.renderStage3();
    const f = currentFragment();
    if (wasPending !== status.pending_ids.length) {
      if (f && isLocked(f)) this.renderStatus(f);
      FragList.schedule();
    }
  },

  async queueStage3() {
    const f = currentFragment();
    if (!f) return;
    await this.flushSaves();
    const result = await this._call(Api.queueStage3(f.id));
    if (!result) return;
    State.stage3 = result.stage3;
    await this.showFragment(result.manifest, f.id);
    this.flash(`В очередь Anki: ${result.queued.length} фрагментов`);
    FragList.schedule();
  },

  _neighborText(direction) {
    const fragments = State.manifest.fragments;
    for (let i = State.fragmentIndex + direction; i >= 0 && i < fragments.length; i += direction) {
      const g = fragments[i];
      if (g.status !== "active") continue;
      const text = (g.text || "").trim();
      if (text) return text;
    }
    return "";
  },

  renderText(f, force) {
    // Предыдущая фраза (серая), эта (белая), следующая (серая). Белая
    // правится прямо на месте — клик ставит в неё мигающую каретку, больше
    // ничего визуально не меняется. Пока в ней идёт набор, текст не
    // перезаписывается, чтобы не сбить каретку.
    // Разница с исходным текстом видна прямо в фразе: новое — зелёное,
    // удалённое — красное (см. textedit.js).
    const cur = $("cur-text");
    if (force) TextEditor.resetHistory();
    if (force || document.activeElement !== cur) {
      TextEditor.load(f.original_text, f.text, f.heard_ranges, f.text_marks);
      TextEditor.render(cur);
    }
    cur.contentEditable = isLocked(f) ? "false" : "plaintext-only";
    $("prev-text").textContent = this._neighborText(-1);
    $("next-text").textContent = this._neighborText(1);
    this.fitTextBox();
  },

  // Поле правимой фразы: ширина – по самой длинной строке из трёх фраз
  // (предыдущей, этой и следующей) плюс поля по TEXT_BOX_PAD с каждой стороны;
  // не шире места. Своя фраза длиннее – поле растёт само (fit-content).
  fitTextBox() {
    const textWidth = (el) => {
      if (!el.textContent.trim()) return 0;
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const widest = Math.max(textWidth($("prev-text")), textWidth($("next-text")));
    $("cur-text").style.minWidth = `${Math.ceil(widest) + 2 * TEXT_BOX_PAD}px`;
  },

  renderNav() {
    const index = State.fragmentIndex;
    const last = State.manifest.fragments.length - 1;
    $("position-indicator").textContent = `${index + 1} / ${last + 1}`;
    // С фильтром списка — по фрагментам фильтра.
    $("nav-back-1").disabled = FragList.stepIndex(index, -1) === null;
    $("nav-back-10").disabled = FragList.stepIndex(index, -10) === null;
    $("nav-fwd-1").disabled = FragList.stepIndex(index, 1) === null;
    $("nav-fwd-10").disabled = FragList.stepIndex(index, 10) === null;
    // Последний фрагмент: вместо кнопок вперёд — "Финиш".
    const atEnd = index >= last;
    $("nav-fwd-1").classList.toggle("hidden", atEnd);
    $("nav-fwd-10").classList.toggle("hidden", atEnd);
    $("finish-btn").classList.toggle("hidden", !atEnd);
    const finished = !!(State.manifest.settings || {}).finished;
    $("finish-btn").textContent = finished ? "Финиш ✓" : "Финиш";
    $("finish-btn").title = finished ? "Всё видео уже отмечено отредактированным"
      : "Отметить всё видео отредактированным (полоса «Отредактировано» – целиком)";
  },

  async finish() {
    await this.flushSaves();
    const result = await this._call(Api.finish(State.project));
    if (!result) return;
    State.manifest.settings = result.manifest.settings;
    this.renderNav();
    location.hash = "#/videos";
  },

  // Скорость воспроизведения: значение и доступность кнопок на краях диапазона.
  renderSpeed() {
    const speed = State.boost ? BOOST_SPEED : State.speed;
    $("speed-value").textContent = `${speed.toFixed(1)}×`;
    $("speed-value").classList.toggle("changed", Math.abs(speed - 1) > 1e-9);
    $("speed-down").disabled = speed <= 0.5 + 1e-9;
    $("speed-up").disabled = speed >= 2 - 1e-9;
  },

  updatePlayButton() {
    $("play-pause").innerHTML = Player.playing ? ICONS.pause : ICONS.play;
  },

  updateModeButton() {
    const on = State.stopAtSegmentEnd;
    $("mode-toggle").innerHTML = on ? ICONS.segment : ICONS.fragment;
    $("mode-toggle").title = on
      ? "Остановка на конце отрезка: ВКЛ (нажмите, чтобы играть до конца видео)"
      : "Остановка на конце отрезка: ВЫКЛ (видео играет до конца или до паузы)";
  },

  updateHistoryButtons(history) {
    $("undo-btn").disabled = !history.can_undo;
    $("redo-btn").disabled = !history.can_redo;
  },

  // «Назад»/«вперёд» — история текущего фрагмента (у каждого своя).
  async refreshHistory() {
    const f = currentFragment();
    if (!f) return;
    try {
      this.updateHistoryButtons(await Api.history(f.id));
    } catch (err) {
      console.error(err);
    }
  },

  flash(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.add("hidden"), 5000);
  },

  async _call(promise) {
    try {
      const result = await promise;
      this.refreshHistory();
      return result;
    } catch (err) {
      console.error(err);
      let message = String(err.message || err);
      try {
        message = JSON.parse(message).detail || message;
      } catch (_) {}
      this.flash(message);
      return null;
    }
  },

  // -- сохранение --------------------------------------------------------------

  _applyServer(f, updated) {
    // Если пользователь продолжает печатать, не затираем свежий текст ответом сервера.
    const localText = f.text;
    Object.assign(f, updated);
    if (this.textTimer && this.textFragment === f) f.text = localText;
  },

  async saveBounds(f) {
    if (!f) return;
    const updated = await this._call(
      Api.updateFragment(f.id, { algo_start_frame: f.algo_start_frame, algo_end_frame: f.algo_end_frame }),
    );
    if (updated) this._applyServer(f, updated);
    if (f === currentFragment()) this.renderAll();
  },

  scheduleBoundsSave(f) {
    this.boundsFragment = f;
    clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => {
      this.boundsTimer = null;
      this.saveBounds(f);
    }, 400);
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

  async flushSaves() {
    if (this.textTimer) {
      clearTimeout(this.textTimer);
      this.textTimer = null;
      await this.saveText();
    }
    if (this.boundsTimer) {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
      await this.saveBounds(this.boundsFragment);
    }
  },

  // -- действия ----------------------------------------------------------------

  step(delta) {
    const f = currentFragment();
    if (!f) return;
    Player.pauseIfPlaying();
    if (isLocked(f)) State.selected = "playhead";
    if (State.selected === "start") {
      f.algo_start_frame = clamp(f.algo_start_frame + delta, f.context_start_frame, f.algo_end_frame - 1);
      Player.seekTo(f.algo_start_frame);
      this.scheduleBoundsSave(f);
    } else if (State.selected === "end") {
      f.algo_end_frame = clamp(f.algo_end_frame + delta, f.algo_start_frame + 1, f.context_end_frame);
      Player.seekTo(f.algo_end_frame - 1);
      this.scheduleBoundsSave(f);
    } else {
      Player.seekTo(clamp(State.currentFrame + delta, f.context_start_frame, f.context_end_frame - 1));
    }
    this.renderAll();
  },

  async setStart() {
    const f = currentFragment();
    f.algo_start_frame = State.currentFrame;
    await this.saveBounds(f);
  },

  async setEnd() {
    const f = currentFragment();
    // Текущий кадр входит в отрезок как последний.
    f.algo_end_frame = State.currentFrame + 1;
    await this.saveBounds(f);
  },

  async reset() {
    await this.flushSaves();
    const f = currentFragment();
    const result = await this._call(Api.resetFragment(f.id));
    if (!result) return;
    State.lastStop = null;
    await this.showFragment(result.manifest, f.id);
    Player.jumpTo(currentFragment().algo_start_frame);
    this.renderAll(true);
  },

  async changePadding(side, direction) {
    await this.flushSaves();
    const f = currentFragment();
    const updated = await this._call(Api.changePadding(f.id, side, direction));
    if (!updated) return;
    this._applyServer(f, updated);
    this.keepInsideFragment();
    this.renderAll();
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
      st = this.speakerState = { id: f.id, tokens: TextEditor.tokens.map((t) => ({ ...t })), offset: 0, rover: false };
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
    else if (st.offset < 0) name = this._speakersAround(-1)[-st.offset - 1] ?? null;
    else if (st.offset > 0) name = this._speakersAround(1)[st.offset - 1] ?? null;
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

  // Кнопка "Не озвучено": переключить отметку (отменяется Ctrl+Z).
  async toggleUnvoiced() {
    const f = currentFragment();
    if (!f || isLocked(f)) return;
    await this.flushSaves();
    const updated = await this._call(Api.setUnvoiced(f.id, !isUnvoiced(f)));
    if (!updated) return;
    this._applyServer(f, updated);
    this.refreshHistory();
    this.renderAll();
  },

  async deleteSoft() {
    await this.flushSaves();
    // Остаёмся на этом же фрагменте — он просто получает пометку «удалено»
    // (или теряет её, если уже был удалён).
    const f = currentFragment();
    const result = await this._call(f.status === "active" ? Api.softDelete(f.id) : Api.restore(f.id));
    if (!result) return;
    // Пока сервер отвечал, могли уже перейти дальше (S, сразу D) – остаёмся там.
    await this.showFragment(result.manifest, currentFragment() ? currentFragment().id : f.id);
  },

  async deleteHard() {
    await this.flushSaves();
    const result = await this._call(Api.hardDelete(currentFragment().id));
    if (!result) return;
    State.manifest = result.manifest;
    await this.openById(result.nearest_left_fragment_id);
  },

  async merge(direction) {
    await this.flushSaves();
    const result = await this._call(Api.merge(currentFragment().id, direction));
    if (!result) return;
    State.manifest = result.manifest;
    await this.openById(result.merged_fragment_id);
  },

  async split() {
    await this.flushSaves();
    // Остаёмся на исходном фрагменте (он помечается удалённым); части
    // встают слева и справа от него.
    const f = currentFragment();
    const result = await this._call(Api.split(f.id, State.currentFrame));
    if (!result) return;
    await this.showFragment(result.manifest, f.id);
  },

  updateAutoButton() {
    const on = State.autoPlay;
    $("auto-toggle").innerHTML = on ? ICONS.autoOn : ICONS.autoOff;
    $("auto-toggle").title = on
      ? "Автозапуск: ВКЛ – переход к фрагменту, клик по дорожке и левая граница отрезка сразу запускают воспроизведение (нажмите, чтобы выключить)"
      : "Автозапуск: ВЫКЛ – воспроизведение только по Play / Пробелу / W (нажмите, чтобы включить)";
  },

  toggleAuto() {
    State.autoPlay = !State.autoPlay;
    try {
      localStorage.setItem("auto-play", State.autoPlay ? "on" : "off");
    } catch (_) {}
    this.updateAutoButton();
  },

  // Остановить передачу в Anki: ещё не закодированное снова правится.
  async stopStage3() {
    await this.flushSaves();
    const result = await this._call(Api.stopStage3(State.project));
    if (!result) return;
    State.stage3 = result.stage3;
    await this.showFragment(result.manifest, currentFragment().id);
    if (result.returned.length) this.flash(`Передача остановлена: вернулось в правку ${result.returned.length}`);
  },

  toggleMode() {
    State.stopAtSegmentEnd = !State.stopAtSegmentEnd;
    this.updateModeButton();
    // Идёт воспроизведение — точка остановки пересчитывается сразу.
    Player.replan();
  },

  async undo() {
    await this.flushSaves();
    const result = await this._call(Api.undo(currentFragment().id));
    if (!result) return;
    this.updateHistoryButtons(result.history);
    await this.showFragment(result.manifest, result.focus_fragment_id);
  },

  async redo() {
    await this.flushSaves();
    const result = await this._call(Api.redo(currentFragment().id));
    if (!result) return;
    this.updateHistoryButtons(result.history);
    await this.showFragment(result.manifest, result.focus_fragment_id);
  },
};

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
App.updateAutoButton();
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
$("unvoiced-btn").addEventListener("click", () => App.toggleUnvoiced());
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
  }
  if (e.key === "Control") ctrlAlone = false;
});

// Связь с сервером: раз в секунду вкладка отмечается. Если сервер
// перезапустили (open_editor.bat), самая свежая вкладка перезагружается
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
        body: JSON.stringify({ client_id: this.clientId, opened_at: this.openedAt, project: State.project }),
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
    if (this.instance === null) {
      this.instance = info.instance;
      return;
    }
    if (info.instance === this.instance || !info.ready) return;
    clearInterval(this.timer);
    if (info.newest) {
      location.reload();
    } else {
      const banner = document.createElement("div");
      banner.className = "stale-banner";
      banner.textContent = "Редактор перезапущен — работайте в свежей вкладке, эта устарела.";
      document.body.prepend(banner);
      document.title = "(устарела) " + document.title;
    }
  },
};

window.addEventListener("DOMContentLoaded", () => {
  Heartbeat.start();
  Player.init();
  Timeline.init();
  App.updatePlayButton();
  App.updateModeButton();
  FragList.init();
  Router.start();
});
