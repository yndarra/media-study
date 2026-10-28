// Редактор: режимы (автозапуск, соседние фразы, связанные границы, говорящие, остановка) и передача в Anki.

Object.assign(App, {
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
    $("stage3-btn").textContent = stop ? "Остановить" : "Anki";
    $("stage3-btn").dataset.action = stop ? "stop" : "queue";
    $("stage3-btn").disabled = !stop && !hasNew;
    // Вернуть из Anki – только уже ставший карточкой (не в очереди) фрагмент.
    const f = currentFragment();
    $("return-btn").disabled = !(f && f.exported && f.status === "active" && !State.stage3.pending_ids.includes(f.id));
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

  // Остановить передачу в Anki: ещё не закодированное снова правится.
  // Вернуть текущий фрагмент из Anki: он снова правится здесь (текст,
  // поправленный в самом Anki, подтягивается); следующая передача обновит
  // ту же карточку (клип переделывается, только если поменялись границы).
  async returnFromAnki() {
    const f = currentFragment();
    if (!f || !f.exported) return;
    await this.flushSaves();
    const result = await this._call(Api.ankiReturn([{ project: State.project, fragment_id: f.id }]));
    if (!result) return;
    const manifest = await this._call(Api.getManifest());
    if (!manifest) return;
    await this.showFragment(manifest, f.id);
    FragList.schedule();
    this.flash("Фрагмент вернулся из Anki – после правки нажмите «Anki», карточка перепишется", "ok");
  },

  async stopStage3() {
    await this.flushSaves();
    const result = await this._call(Api.stopStage3(State.project));
    if (!result) return;
    State.stage3 = result.stage3;
    await this.showFragment(result.manifest, currentFragment().id);
    if (result.returned.length) this.flash(`Передача остановлена: вернулось в правку ${result.returned.length}`);
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
    this.updateAutoButton();
  },

  // Соседние фразы: пропускать удалённые (по умолчанию) или показывать их.
  updateSkipButton() {
    const on = State.skipDeleted;
    $("skip-deleted-btn").innerHTML = on ? ICONS.skipOn : ICONS.skipOff;
    $("skip-deleted-btn").title = on
      ? "Соседние фразы: удалённые пропускаются – видна ближайшая живая (нажмите, чтобы показывать удалённые)"
      : "Соседние фразы: удалённые тоже видны, зачёркнутыми (нажмите, чтобы пропускать)";
  },

  // Связанные границы.
  updateLinkButton() {
    const on = State.linkBounds;
    $("link-bounds-btn").innerHTML = on ? ICONS.linkOn : ICONS.linkOff;
    $("link-bounds-btn").classList.toggle("on", on);
    $("link-bounds-btn").title = on
      ? "Связанные границы: ВКЛ – граница отрезка, стоящая вплотную к соседу, двигает и его границу (склейка = исходник покадрово)"
      : "Связанные границы: ВЫКЛ – границы двигаются независимо";
  },

  toggleLinkBounds() {
    State.linkBounds = !State.linkBounds;
    this.updateLinkButton();
  },

  // Говорящие на карточках (режим видео, хранится на сервере).
  updateSpeakersButton() {
    const on = !!(State.manifest && State.manifest.video.show_speakers);
    // Состояние видно по самому значку (звук / крестик), без подсветки.
    $("speakers-btn").innerHTML = on ? ICONS.speakersOn : ICONS.speakersOff;
    $("speakers-btn").title = on
      ? "Говорящие на карточках: ВКЛ – имена персонажей серым в конце карточки (нажмите, чтобы убрать со всех карточек этого видео)"
      : "Говорящие на карточках: ВЫКЛ (нажмите, чтобы добавить на все карточки этого видео)";
  },

  // Переключение касается всех карточек видео: уже переданные в Anki
  // возвращаются (помечаются вернувшимися) и обновятся при следующей передаче.
  async toggleSpeakers() {
    if (!State.manifest) return;
    await this.flushSaves();
    const on = !State.manifest.video.show_speakers;
    const result = await this._call(Api.setSpeakers(on));
    if (!result) return;
    if (result.manifest) {
      await this.showFragment(result.manifest, currentFragment() ? currentFragment().id : null);
    } else {
      State.manifest.video.show_speakers = on;
    }
    this.updateSpeakersButton();
    if (currentFragment()) this.renderText(currentFragment(), false); // столбец говорящих появляется / исчезает
    // Вернули режим, как был: нетронутые фрагменты снова числятся в Anki.
    this.flash(`Говорящие на карточках: ${on ? "вкл" : "выкл"}` +
      (result.restored ? ` – ${result.restored} нетронутых фрагментов снова в Anki` : "") +
      (result.returned ? ` – ${result.returned} карточек вернулись, передайте их в Anki снова` : ""), on ? "ok" : "");
  },

  toggleSkipDeleted() {
    State.skipDeleted = !State.skipDeleted;
    this.updateSkipButton();
    if (currentFragment()) this.renderText(currentFragment(), false);
  },

  toggleMode() {
    State.stopAtSegmentEnd = !State.stopAtSegmentEnd;
    this.updateModeButton();
    // Идёт воспроизведение — точка остановки пересчитывается сразу.
    Player.replan();
  },
});
