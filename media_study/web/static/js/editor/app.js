// Редактор: открытие видео и фрагмента, переходы, отрисовка, вызовы сервера, отмена/возврат.
const App = {
  textTimer: null,

  textFragment: null,

  boundsTimer: null,

  boundsFragment: null,

  toastTimer: null,

  // Открыть видео в редакторе. Встаём на последний изменённый фрагмент —
  // там, где остановились в прошлый раз.
  async openProject(id) {
    if (State.project === id && State.manifest) {
      // Вернулись в редактор того же видео: фрагменты перечитываются с
      // сервера – пока редактор был закрыт, их могли передать в Anki из окна
      // видео, перевести, вернуть (раньше показывалось прежнее состояние, и
      // переданный фрагмент числился вернувшимся).
      const reattached = Player.reattach();
      const focusId = currentFragment() ? currentFragment().id : null;
      await this.flushSaves();
      const fresh = await this._call(Api.getManifest());
      if (fresh && State.project === id) {
        State.manifest = fresh;
        const index = Math.max(0, fresh.fragments.findIndex((f) => f.id === focusId));
        this.updateSpeakersButton();
        // Файл отпускали – фрагмент открывается заново; иначе только перерисовать.
        if (reattached || index !== State.fragmentIndex) await this.open(index);
        else this.renderAll(false);
        FragList.schedule();
      } else if (reattached && State.fragmentIndex >= 0) {
        await this.open(State.fragmentIndex);
      }
      return;
    }
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
    // Аудио – вместо картинки фон с кругом по звуку (audiovis.js).
    AudioVisual.enable(!!manifest.video.audio_only);
    this._audioVisual = !!manifest.video.audio_only;
    // У аудио нет "немых" реплик героя игры – кнопки Rover ("R", "Не озвучено") не нужны.
    document.getElementById("app").classList.toggle("audio-project", !!manifest.video.audio_only);
    this.updateSpeakersButton();
    // Режим "связанные границы" – по умолчанию для видео или аудио (настройки).
    if (State.linkDefaults) {
      State.linkBounds = State.linkDefaults[manifest.video.audio_only ? "audio" : "video"];
      this.updateLinkButton();
    }
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
    Names.visit(f);
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
    // Удалённый – красноватый всегда, даже если фрагмент числится переданным
    // в Anki или переведённым (красный важнее остальных цветов).
    document.body.classList.toggle("frag-deleted", inEditor && deleted);
    document.body.classList.toggle("frag-locked", inEditor && locked);
    for (const cls of ["bg-anki", "bg-pending", "bg-translated", "bg-returned"]) {
      document.body.classList.toggle(`frag-${cls}`, inEditor && !deleted && !f.sound_only && stage === cls);
    }
    // Цвет правки (удалён – красный, изменён – жёлтый, не озвучен – бирюзовый,
    // принят без правок – синий) важнее фона этапа Anki (зелёный/розовый);
    // вернувшийся из Anki – фиолетовый.
    // Переведённый (розовый) и переданный в Anki (зелёный) фон – важнее всего.
    let editKind = ["bg-returned", "bg-anki", "bg-translated"].includes(stage) ? "" : FragList.editClass(f, State.fragmentIndex, FragList._reviewed());
    if (editKind && editKind !== "deleted" && isUnvoiced(f)) editKind = "unvoiced"; // бирюзовый важнее жёлтого и синего
    if (f.sound_only) editKind = "sound"; // "только озвучка" – рыжеватый, важнее всего, кроме красного
    for (const kind of ["accepted", "changed", "unvoiced", "sound"]) {
      document.body.classList.toggle(`frag-edit-${kind}`, inEditor && !deleted && editKind === kind);
    }
    document.body.classList.toggle("frag-unvoiced", false);
    if (locked) $("reset-btn").disabled = true;
  },

  renderReadout() {
    const frame = State.currentFrame;
    $("time-readout").textContent = `${formatClock(frame / fps())} · ${frame}`;
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
    const sound = !!f.sound_only;
    $("sound-btn").classList.toggle("on", sound);
    $("sound-btn").disabled = isLocked(f);
    $("sound-btn").title = sound
      ? "Отмечено: только озвучка – в Anki звук без картинки (нажмите, чтобы снять)"
      : "Отметить: только озвучка – в Anki звук без картинки";
    // Вместо картинки – то же, что при правке аудио (фон по звуку).
    const visual = !!(State.manifest.video.audio_only || sound);
    if (this._audioVisual !== visual) {
      this._audioVisual = visual;
      AudioVisual.enable(visual);
    }
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
    location.hash = State.manifest && State.manifest.video.audio_only ? "#/audio" : "#/videos";
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
