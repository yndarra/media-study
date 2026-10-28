// Редактор: границы отрезка, запас, «прилепить» к соседу, отметки фрагмента, удалить, объединить, разделить.

Object.assign(App, {
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

  async saveBounds(f) {
    if (!f) return;
    const updated = await this._call(
      Api.updateFragment(f.id, { algo_start_frame: f.algo_start_frame, algo_end_frame: f.algo_end_frame, link: State.linkBounds }),
    );
    if (updated) {
      // Соседи, сдвинутые вместе с границей (режим "связанные границы").
      for (const n of updated.linked || []) {
        const g = State.manifest.fragments.find((x) => x.id === n.id);
        if (g) Object.assign(g, n);
      }
      delete updated.linked;
      this._applyServer(f, updated);
      FragList.schedule();
    }
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

  // Кнопка "Только озвучка": в Anki пойдёт звук без картинки (отменяется Ctrl+Z).
  async toggleSoundOnly() {
    const f = currentFragment();
    if (!f || isLocked(f)) return;
    await this.flushSaves();
    const updated = await this._call(Api.setSoundOnly(f.id, !f.sound_only));
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
    // В режиме связанных границ следующий фрагмент подтягивается к
    // предыдущему (удалённый не оставляет дыры) – см. ManifestStore.soft_delete.
    const result = await this._call(f.status === "active" ? Api.softDelete(f.id, State.linkBounds) : Api.restore(f.id, State.linkBounds));
    if (!result) return;
    // Пока сервер отвечал, могли уже перейти дальше (S, сразу D) – остаёмся там.
    await this.showFragment(result.manifest, currentFragment() ? currentFragment().id : f.id);
  },

  async deleteHard() {
    await this.flushSaves();
    const result = await this._call(Api.hardDelete(currentFragment().id));
    if (!result) return;
    State.manifest = withVideoExtras(result.manifest);
    await this.openById(result.nearest_left_fragment_id);
  },

  async merge(direction) {
    await this.flushSaves();
    const result = await this._call(Api.merge(currentFragment().id, direction));
    if (!result) return;
    State.manifest = withVideoExtras(result.manifest);
    await this.openById(result.merged_fragment_id); // стык подсветится сам (renderText -> updateJunction)
    if (State.autoPlay) Player.replay(); // объединённый – сразу слушать, как при переходе
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
});
