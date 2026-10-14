// Раздел «Видео» / «Аудио»: список по авторам, окно медиа, проверка флагов, доводка.

Object.assign(Pages, {
  // -- библиотека (и Anki) -------------------------------------------------------
  async videos(kind = "video") {
    // Один и тот же раздел для видео и для аудио (список фильтруется по audio_only).
    this.libraryKind = kind;
    const audio = kind === "audio";
    const el = document.getElementById("view-videos");
    el.innerHTML = `<div class="page-head"><h1>${audio ? "Аудио" : "Видео"}</h1>
        <div class="head-actions">
          <span id="flags-status" class="muted small"></span>
          <button id="open-flags" class="step-btn">Проверка флагов</button>
          <button id="open-translate" class="step-btn">Доводка</button>
        </div></div>
      <p class="muted small page-note">${audio
        ? "Обработанные аудио (песни и т.п.), сгруппированные по исполнителю. Полосы – как у видео: докуда дошла правка, сколько фрагментов стали карточками Anki и переведены. Нажмите на аудио, чтобы открыть подробности и перейти к правке."
        : "Обработанные видео, сгруппированные по автору. Полоса «Отредактировано» – докуда дошла правка (синее – принято без правок, жёлтое – изменено, красное – удалено), «Передано в Anki» – сколько фрагментов уже стали карточками. Нажмите на видео, чтобы открыть подробности, изменить название или автора и перейти к правке."}</p>
      <div id="videos-list"></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    el.querySelector("#open-flags").addEventListener("click", () => this.checkFlags());
    el.querySelector("#open-translate").addEventListener("click", () => this.translateModal());
    const render = async () => {
      const box = document.getElementById("videos-list");
      if (!box) return;
      let items;
      try {
        items = (await Api.ankiOverview()).filter((v) => !!v.audio_only === audio);
        // Свежие данные карточек – окну подробностей (открывается сразу с ними).
        Pages.listItems = new Map(items.map((v) => [v.id, v]));
      } catch (err) {
        box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
        return;
      }
      // Кнопка "Перевод" показывает, сколько карточек ждут перевода.
      const toTranslate = items.reduce((sum, v) => sum + (v.flag_translation || 0), 0);
      const translateButton = document.getElementById("open-translate");
      if (translateButton) translateButton.textContent = toTranslate ? `Доводка (${toTranslate})` : "Доводка";
      if (!items.length) {
        box.innerHTML = `<p class="muted">Готовых ${audio ? "аудио" : "видео"} пока нет – добавьте их в разделе «Добавить», затем обработайте в «Обработке».</p>`;
        return;
      }
      const first = !box.querySelector("a.card");
      renderSmooth(box, sortWithin(groupByAuthor(items, byPendingWork), byVideoWork).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          v.state === "offline"
            ? `<div class="card offline-card">${cardTitle(v)}<div class="muted small">Диск ${escapeHtml(v.storage)} не подключён</div></div>`
            : `<a class="card${cardState(v)}" href="#/${audio ? "audio" : "video"}/${encodeURIComponent(v.id)}">${cardTitle(v)}` +
          // Кнопка следующего шага – вместо строки "Место на диске".
          videoBars(v) + (cardAction(v) ? cardAction(v) + videoNotes(v, false) : videoNotes(v)) +
          "</a>").join("") + "</div>",
      ).join(""), first);
      if (first) cardsEnter(box);
      // Кнопка появилась – раскрывается; исчезла – плавно возвращается строка
      // "Место на диске" (при первом показе раздела – без анимации).
      // Исчезла – прежняя кнопка (её копия) плавно сжимается на своём месте.
      const now = new Map(items.map((v) => [v.id, cardAction(v)]));
      if (!first && this.lastActions) {
        for (const [vid, html] of now) {
          const was = this.lastActions.get(vid);
          if (!!was === !!html) continue;
          const card = box.querySelector(`a.card[href$="/${CSS.escape(encodeURIComponent(vid))}"]`);
          if (!card) continue;
          if (html) {
            const el = card.querySelector(".card-action");
            if (el) el.classList.add("grow-in");
            continue;
          }
          const notes = card.querySelector(".muted.small:last-child");
          if (notes) notes.classList.add("fade-in");
        }
      }
      this.lastActions = now;
      flashCard(box);
      this.prefetchStats(items.filter((v) => v.state === "ready").map((v) => v.id));
      Zebra.start();
    };
    // Кнопки на карточке ("Передать в Anki", "Перевести"): действие сразу, окно
    // не открывается; кнопка плавно сворачивается, карточка уменьшается.
    // Обработчик на самой странице – вешается один раз (страница перерисовывается).
    if (!el.dataset.actionsBound) {
      el.dataset.actionsBound = "1";
      el.addEventListener("click", async (e) => {
        const button = e.target.closest(".card-action");
        if (!button) return;
        e.preventDefault();
        e.stopPropagation();
        const id = button.dataset.id;
        if (button.dataset.action === "none") return;
        if (["stop", "cancel-send", "cancel-move"].includes(button.dataset.action)) {
          // Занятая кнопка – отменить её действие.
          button.disabled = true;
          Pages.pressedActions.delete(id);
          try {
            if (button.dataset.action === "stop") await Api.agentStop(id);
            else if (button.dataset.action === "cancel-send") await Api.stopStage3(id);
            else await Api.cancelMove(id);
          } catch (err) {
            console.error(err);
          }
          if (Pages.videosRender) Pages.videosRender();
          return;
        }
        Pages.pressedActions.set(id, { at: Date.now(), action: button.dataset.action });
        // Сразу – вид "идёт" (другой текст и полосы); перерисовка подхватит.
        button.disabled = true;
        button.classList.add("busy");
        button.querySelector("span").dataset.type = button.dataset.action === "send" ? "Передаётся в Anki…" : "Выполняется перевод…";
        try {
          if (button.dataset.action === "send") await Api.queueProject(id);
          else await Api.agentRun({ project: id, batch: false });
        } catch (err) {
          Pages.pressedActions.delete(id);
          console.error(err); // кнопка вернётся при перерисовке – можно нажать ещё раз
        }
        if (Pages.videosRender) Pages.videosRender();
      });
    }
    this.videosRender = render;
    await render();
    this.refreshEvery(3000, render); // чаще – кнопки шагов появляются без задержки
  },

  // Окно "Перевод": агент готовит перевод для карточек с зелёным/красным
  // флагом; его предложения (было -> станет) одобряются или отклоняются.
  async translateModal() {
    const body = Modal.show('<p class="muted">Загрузка…</p>');
    const draw = async () => {
      let state;
      let items;
      try {
        [state, items] = await Promise.all([Api.agentState(), Api.ankiOverview()]);
      } catch (err) {
        body.innerHTML = `<p class="muted">Не удалось узнать состояние агента: ${escapeHtml(err.message)}</p>`;
        return;
      }
      const flagged = items.reduce((sum, v) => sum + (v.flag_translation || 0), 0);
      const st = state.status || {};
      const running = st.state === "running";
      const statusLine = running ? `Работает: ${st.done || 0} / ${st.total || "…"}${st.spent ? `, потрачено $${st.spent}` : ""}`
        : st.state === "error" ? `ошибка: ${escapeHtml(st.message || "")}` : "";
      const proposals = state.proposals;
      body.innerHTML = `
        <h2>Перевод</h2>
        <p class="muted small">Агент переводит пачками по сцене (видит весь текст видео и словарь терминов): карточки с <span class="flag-dot f3"></span> зелёным и <span class="flag-dot f1"></span> красным флагом – здесь, целое видео – кнопкой «Перевести» в подробностях видео. Перевод по правилам оформления, учитывает ваши комментарии со звёздочкой (*поясни за слово …) и убирает их. В Anki ничего не меняется, пока вы не одобрите. Одобренное: лицо – без комментариев, оборот – новый, метка «агент_перевод»; зелёный флаг снимается, красный становится оранжевым (обрезку ещё править).</p>
        <div class="muted small">Карточек с флагом «перевод» в Anki: ${flagged}${statusLine ? ` · ${statusLine}` : ""}${st.model ? ` · модель ${escapeHtml(st.model)}` : ""}</div>
        <div class="actions"><button id="agent-run" class="step-btn" ${running || !flagged ? "disabled" : ""}>Подготовить переводы</button></div>
        ${(state.batches || []).length ? `<div class="muted small">Пакетные заявки: ${state.batches.map((j) =>
          `${escapeHtml(j.project)} – ${j.cards} ${plural(j.cards, "карточка", "карточки", "карточек")} (${escapeHtml(j.state)})`).join("; ")}</div>` : ""}
        <div class="agent-list">${proposals.length ? groupBatches(proposals).map(([batch, list]) => `
          <div class="agent-batch" data-batch="${escapeHtml(batch)}">
            <div class="agent-batch-head"><b>${escapeHtml(batch || "Без пачки")}</b> <span class="muted small">· ${list.length} ${plural(list.length, "карточка", "карточки", "карточек")}</span>
              <span class="spacer"></span>
              <button class="step-btn batch-reject">Отклонить пачку</button>
              <button class="step-btn primary batch-approve">Одобрить пачку</button></div>
            ${list.map((p) => `
            <div class="agent-item" data-note="${p.note_id}">
              <label class="agent-head check"><input type="checkbox" checked>
                ${p.flag ? `<span class="flag-dot f${p.flag}"></span> ` : ""}#${escapeHtml(p.card_number || p.fragment_id)}
                <span class="muted small">· ${escapeHtml(p.model || "")}</span></label>
              <div class="agent-en">${escapeHtml(p.text || "")}</div>
              ${(p.comments || []).length ? `<div class="agent-comments">Ваши комментарии: ${p.comments.map((c) => `«${escapeHtml(c)}»`).join(", ")}</div>` : ""}
              <div class="agent-diff">
                <div><div class="muted small">Было</div><div class="agent-back old">${p.back_old || '<span class="muted">Пусто</span>'}</div></div>
                <div><div class="muted small">Станет <span class="muted">(можно поправить)</span></div><div class="agent-back new" contenteditable="true">${p.back_new}</div></div>
              </div>
            </div>`).join("")}
          </div>`).join("") : '<p class="muted">Предложений нет.</p>'}</div>
        ${proposals.length ? `<div class="modal-actions">
          <button class="step-btn" id="agent-reject">Отклонить отмеченные</button>
          <span class="muted small note"></span>
          <button class="step-btn primary" id="agent-approve">Одобрить отмеченные</button>
        </div>` : ""}`;
      body.querySelector("#agent-run").addEventListener("click", async () => {
        try {
          await Api.agentRun({});
        } catch (err) {
          alert(err.message);
        }
        draw();
      });
      // Обороты, которые поправили вручную (отличаются от предложенного).
      const original = new Map(proposals.map((p) => [String(p.note_id), p.back_new]));
      const editsOf = (ids) => Object.fromEntries(ids.map((id) => {
        const el = body.querySelector(`.agent-item[data-note="${id}"] .agent-back.new`);
        return [String(id), el ? el.innerHTML : null];
      }).filter(([id, html]) => html !== null && html !== original.get(id)));
      const checked = () => [...body.querySelectorAll(".agent-item")]
        .filter((el) => el.querySelector("input").checked).map((el) => Number(el.dataset.note));
      const act = async (approve) => {
        const ids = checked();
        if (!ids.length) return;
        try {
          approve ? await Api.agentApply(ids, [], editsOf(ids)) : await Api.agentApply([], ids);
          draw();
        } catch (err) {
          body.querySelector(".note").textContent = err.message;
        }
      };
      if (proposals.length) {
        body.querySelector("#agent-approve").addEventListener("click", () => act(true));
        body.querySelector("#agent-reject").addEventListener("click", () => act(false));
      }
      // Одобрить / отклонить пачку целиком (все её карточки, независимо от отметок).
      body.querySelectorAll(".agent-batch").forEach((group) => {
        const ids = () => [...group.querySelectorAll(".agent-item")].map((el) => Number(el.dataset.note));
        const run = async (approve) => {
          try {
            approve ? await Api.agentApply(ids(), [], editsOf(ids())) : await Api.agentApply([], ids());
            draw();
          } catch (err) {
            body.querySelector(".note").textContent = err.message;
          }
        };
        group.querySelector(".batch-approve").addEventListener("click", () => run(true));
        group.querySelector(".batch-reject").addEventListener("click", () => run(false));
      });
      // Пока агент работает – обновляем окно, чтобы видеть ход.
      if (running) setTimeout(() => document.getElementById("modal-overlay") && body.isConnected && draw(), 3000);
    };
    await draw();
  },

  // Окно "Проверка флагов": карточки приложения с флагами в Anki; оранжевые и
  // красные можно вернуть в редактор, перевод – в окне "Перевод".
  // "Проверка флагов": спросить Anki и сразу вернуть в редактор карточки с
  // флагом обрезки/текста (оранжевый, красный); зелёные (и красные) ждут
  // перевода – их готовит окно "Перевод". Итог – слева от кнопки.
  pressedActions: new Map(), // видео, где только что нажали кнопку на карточке: {id: время}
  statsCache: new Map(), // данные окна медиа по коду (для мгновенного открытия)
  diskCache: new Map(), // место на диске по коду (окно в "Обработке" – сразу)

  async prefetchDisk(ids) {
    if (this._prefetchingDisk) return;
    this._prefetchingDisk = true;
    try {
      for (const id of ids) {
        if (this.diskCache.has(id) || State.view !== "process") continue;
        try {
          this.diskCache.set(id, await Api.projectDisk(id));
        } catch (_) {}
      }
    } finally {
      this._prefetchingDisk = false;
    }
  },

  // Пока виден список – данные окон его медиа подгружаются заранее, по одному,
  // каждое не чаще раза в минуту (окно тогда открывается без ожидания).
  async prefetchStats(ids) {
    if (this._prefetching) return;
    this._prefetching = true;
    try {
      for (const id of ids) {
        const c = this.statsCache.get(id);
        if (c && Date.now() - c._at < 60000) continue;
        if (State.view !== "videos" || document.hidden) break;
        try {
          this.statsCache.set(id, { ...(await Api.projectStats(id)), _at: Date.now() });
        } catch (_) {}
      }
    } finally {
      this._prefetching = false;
    }
  },

  async checkFlags() {
    const status = document.getElementById("flags-status");
    const button = document.getElementById("open-flags");
    const say = (text, hint = "") => {
      status.textContent = text;
      status.title = hint;
    };
    button.disabled = true;
    say("Проверяю…");
    try {
      const found = await Api.ankiCheck();
      const returnable = found.filter((item) => item.state === "in_anki" && (item.flag === 1 || item.flag === 2));
      const translation = found.filter((item) => item.flag === 1 || item.flag === 3).length;
      const already = found.filter((item) => item.state === "returned").length;
      let returned = {};
      if (returnable.length) {
        returned = (await Api.ankiReturn(returnable.map((item) => ({ project: item.project, fragment_id: item.fragment_id })))).returned;
        // Открытое в редакторе видео надо перечитать – его фрагменты разблокировались.
        if (State.project && returned[State.project]) {
          const id = State.project;
          State.manifest = null;
          State.project = null;
          if (State.view === "editor") App.openProject(id);
        }
      }
      const parts = [];
      if (returnable.length) parts.push(`На правку: ${returnable.length}`);
      if (already) parts.push(`уже на правке: ${already}`);
      if (translation) parts.push(`на перевод: ${translation}`);
      say(parts.length ? cap(parts.join(" · ")) : "Помеченных карточек нет",
        returnable.length ? "Вернулись в редактор – фильтр «помечены в Anki»" : "");
    } catch (err) {
      let message = err.message;
      try {
        message = JSON.parse(message).detail;
      } catch (_) {}
      say("Не получилось", message);
    }
    button.disabled = false;
    if (this.videosRender) this.videosRender();
  },

  // Разметка окна медиа по данным data (сводка, статистика, место на диске):
  // название и автор, полосы, таблицы, кнопки действий (их вид по состоянию
  // ставит videoModal – render).
  videoModalHtml(data) {
    const v = data.summary;
    const s = data.stats;
    const d = data.disk;
    const row = tableRow;
    // Строк в карточке: по 6 записей в строке, дальше — следующие строки (свёрнуты).
    const lineItems = Object.entries(s.lines_per_card).map(([n, c]) => `${n} стр. – ${c}`);
    const lines = [];
    for (let i = 0; i < lineItems.length; i += 6) lines.push(lineItems.slice(i, i + 6).join(", "));
    // Источники текста для сверки: ссылки, по одной в строке.
    const sources = (v.sources_display || []).map((src) =>
      `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.title || src.url)}</a>` +
      (src.used ? "" : ' <span class="muted small">(не использован)</span>'));
    const pct = (n) => (s.cards ? `${Math.round((n / s.cards) * 100)}%` : "0%");
    const shift = s.bound_shift_frames;
    // "Править": есть что править – синяя зебра; осталось только вернувшееся
    // из Anki – фиолетовая; править нечего – просто синяя.
    const editZebra = !v.awaiting ? "" : (v.flagged || 0) >= v.awaiting ? "editReturned" : "edit";
    return `
      <div class="modal-head">
        <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
        <label>Автор <textarea id="group-input" class="grow fixed" rows="1" data-single>${escapeHtml(v.group)}</textarea></label>
      </div>
      <div class="modal-bars" data-key="modal">${videoBars({ ...v, flag_interval: 0 })}</div>
      ${videoNotes({ ...v, disk_total: undefined })}
      <h2>Статистика</h2>
      <table class="stats">
        ${row("Ролик", `${formatDuration(s.video_seconds)}, карточек ${s.cards}`)}
        ${row("В клипах", `${formatDuration(s.kept_seconds)} – ${(s.kept_share * 100).toFixed(1)}% ролика, удалено ${s.deleted} ${plural(s.deleted, "фрагмент", "фрагмента", "фрагментов")} (${Math.round(s.deleted_seconds)} сек)`)}
        ${row("Длина клипа, сек", s.clip_seconds ? `${s.clip_seconds.mean} в среднем, ${s.clip_seconds.median} медиана, ${s.clip_seconds.min} мин., ${s.clip_seconds.max} макс.` : "")}
        ${row("Строк в карточке", lines)}
        ${row(sources.length > 1 ? "Источники" : "Источник", sources.length ? sources : "Нет")}
        ${row("Правка текста и границ", `${s.text_edited} ${plural(s.text_edited, "фрагмент", "фрагмента", "фрагментов")} (${pct(s.text_edited)}), ` +
          `${s.bounds_edited} ${plural(s.bounds_edited, "фрагмент", "фрагмента", "фрагментов")} (${pct(s.bounds_edited)})`)}
        ${row("Сдвиг границ, кадр", shift ? `${shift.mean} в среднем, ${shift.median} медиана, ${shift.min} мин., ${shift.max} макс.` : "")}
        ${row("Потрачено", spentLine(s.costs))}
        ${row("Колода Anki", v.anki_deck ? escapeHtml(v.anki_deck) : "Нет")}
      </table>
      <h2>Место на диске</h2>
      <div class="disk-grid">
        <table class="stats">
          ${row("Оригинал", formatSize(d.master))}
          ${row("Копия для редактора и звук", `${formatSize(d.editor)}, ${formatSize(d.editor_audio)}`)}
        </table>
        <table class="stats">
          ${row("Клипы для Anki", formatSize(d.clips))}
          ${row("Всего", `<b>${formatSize(d.total)}</b>`)}
        </table>
      </div>
      <div class="modal-actions">
        <a id="info-edit" class="step-btn${editZebra ? " primary" : ""} zebra-host" href="#/edit/${encodeURIComponent(v.id)}"
          ${editZebra ? `data-zebra="${editZebra}"` : ""}><canvas class="zebra"></canvas><span>Редактировать</span></a>
        <button id="info-anki" class="step-btn fold zebra-host gone"><canvas class="zebra"></canvas><span>Передать в Anki</span></button>
        <button id="info-translate" class="step-btn fold zebra-host gone"><canvas class="zebra"></canvas><span>Перевести</span></button>
        <span id="info-note" class="muted small"></span>
        <button id="info-pack" class="step-btn fold" title="Набор для других: разметка, тексты и переводы этого видео файлом (без самого видео)">Набор</button>
        <button id="info-storage" class="step-btn fold zebra-host" title="Где хранится видео; перенос на другой диск"><canvas class="zebra"></canvas><span>Хранилище</span></button>
        <button id="info-save" class="step-btn fold gone">Сохранить</button>
      </div>`;
  },

  // Подробности видео – окно поверх списка (#/video/<код>): статистика, место
  // на диске, правка названия и автора (колода Anki переименуется вслед).
  // Окно открывается сразу: если данные этого медиа уже есть (подгружены
  // заранее, пока виден список, или с прошлого открытия) – с ними, а свежие
  // запрашиваются параллельно и, если что-то поменялось, окно тут же
  // перерисовывается на месте (reuse – то же окно, без анимации появления).
  // Не перерисовывается, пока правят название/автора.
  async videoModal(id, reuse = null) {
    // (MODAL_SETTLE_MS – см. ниже: окно сперва отыгрывает появление.)
    let watcher = null;
    let save = async () => {};
    const guard = { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() };
    const body = reuse ? reuse.body : Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/video/")) location.hash = "#/videos";
      else if (location.hash.startsWith("#/audio/")) location.hash = "#/audio";
    }, guard);
    if (reuse) Modal.guard = guard;
    // Поколение содержимого окна: старые циклы обновления после перерисовки затихают.
    const gen = (body.dataset.gen = String(Number(body.dataset.gen || 0) + 1));
    let cached = reuse ? reuse.data : Pages.statsCache.get(id);
    const listed = !reuse && Pages.listItems && Pages.listItems.get(id);
    if (cached && listed) cached = { ...cached, summary: { ...cached.summary, ...listed } };
    const load = () => Api.projectStats(id).then((d) => {
      Pages.statsCache.set(id, { ...d, _at: Date.now() });
      return d;
    });
    let data = cached;
    if (!data) {
      try {
        data = await load();
      } catch (err) {
        body.innerHTML = `<p class="muted">Видео не найдено или ещё обрабатывается.</p>`;
        return;
      }
    } else if (!reuse) {
      // Проверить актуальность – когда анимации появления закончатся.
      const fresh = new Promise((resolve) => setTimeout(resolve, MODAL_SETTLE_MS)).then(load);
      fresh.then((d) => {
        if (!body.isConnected || body.dataset.gen !== gen) return;
        // Сравнить только то, что пришло (сводка – по её полям): совпало – не перерисовывать.
        const keys = Object.keys(d.summary || {});
        // Свободное место на дисках (storage) меняется постоянно – окно из-за
        // него не перерисовывается (оно нужно только окошку "Хранилище", а
        // там своё обновление).
        const strip = (x) => JSON.stringify({ ...x, _at: 0, storage: 0, summary: keys.map((k) => (x.summary || {})[k]) });
        if (strip(d) === strip(cached)) return;
        const head = body.querySelector(".modal-head");
        if ((watcher && watcher.isDirty()) || (head && head.contains(document.activeElement))) return;
        this.videoModal(id, { body, data: d });
      }).catch(() => {});
    }
    const v = data.summary;
    const s = data.stats;
    const d = data.disk;
    // Градиент и обводка окна – как у карточки этого видео в списке.
    const modalBox = body.closest(".modal");
    // Состояние меняется (передача закончилась или её остановили) – градиент
    // окна вслед за ним (раньше оставался прежним до закрытия окна).
    const paint = (sv) => {
      modalBox.classList.remove("complete", "to-translate", "to-send", "has-returned", "started");
      const state = cardState(sv).trim();
      if (state) modalBox.classList.add(state);
    };
    paint(v);
    // Фрагментов без перевода (переданные в Anki и ещё нет); null — Anki закрыт, неизвестно.
    // Переводить нечего (нет непереведённых карточек в Anki) или над видео идёт
    // процесс (передача в Anki) – кнопка серая.
    // Пересчитывается при каждом обновлении окна (см. refresh): перевод
    // закончился – кнопка сразу становится серой.
    // Anki закрыт (to_translate = null) – переводить нечего: перевод идёт только
    // по карточкам в Anki, кнопку не показываем.
    let untranslated = v.sending ? 0 : v.to_translate || 0;
    // Перерисовка со свежими данными (reuse): полосы доезжают от того, что
    // сейчас на экране, а не заполняются заново с нуля.
    const barsBefore = reuse ? barSnapshot(body.querySelector(".modal-bars"), true) : new Map();
    // Какие кнопки действий уже были видны (перерисовка): они остаются как
    // есть, проявляется только новая.
    const shownBefore = new Set(reuse ? [...body.querySelectorAll(".modal-actions .fold:not(.gone)")].map((b) => b.id) : []);
    body.innerHTML = this.videoModalHtml(data);
    autoGrow(body.querySelector("#title-input"));
    singleLine(body.querySelector("#group-input"));
    animateBars(body.querySelector(".modal-bars"), barsBefore);
    foldLongRows(body);
    if (!reuse) rowLinesEnter(body);
    const saveButton = body.querySelector("#info-save");
    const closeAndFlash = () => {
      Pages.flashId = id;
      Modal.close();
    };
    // "Сохранить" появляется вместо "Хранилище", только когда есть изменения (см. render).
    watcher = formWatch(body.querySelector(".modal-head"), []);
    body.querySelector(".modal-head").addEventListener("input", () => render());
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (!title || !group) return;
      await Api.saveProjectInfo(id, { title, group });
      watcher.snapshot();
      // Переименовали видео, которое открыто в редакторе, – обновить ссылку в меню.
      if (State.project === id && State.manifest) {
        State.manifest.video.title = title;
        State.manifest.video.group = group;
        setEditingLink();
      }
    };
    saveButton.addEventListener("click", async () => {
      await save();
      closeAndFlash();
    });
    Zebra.start();

    const storageButton = body.querySelector("#info-storage");
    let storageInfo = data.storage;
    let moving = !!(v.moving || (storageInfo && storageInfo.move && !storageInfo.move.finished));
    const ankiButton = body.querySelector("#info-anki");
    const translateButton = body.querySelector("#info-translate");
    const note = body.querySelector("#info-note");
    const setNote = (text, hint = "") => {
      note.textContent = text;
      note.title = hint || text;
    };

    // Вид строки кнопок по состоянию видео:
    //  - "Передать в Anki" – только если есть что передать (зебра, когда
    //    отредактировано всё); "Перевести" – только если есть что переводить
    //    (зебра, когда всё в Anki); идёт действие – на её месте "Отменить" с
    //    быстрой зеброй;
    //  - справа "Хранилище" (окошко: где лежит, перенос на другой диск); идёт
    //    перенос – "Отменить" с быстрой серой зеброй, остальное серое;
    //  - изменили название/автора – вместо "Хранилище" "Сохранить", остальное серое;
    //  - "Редактировать" серая, пока идёт перенос, и пока идёт передача/перевод,
    //    если править уже нечего (в редактор тогда не пускает и роутер).
    let sending = !!v.sending;
    let running = !!v.translating;
    let waitingBatch = false;
    let last = v;
    const fold = (el, gone) => el && el.classList.toggle("gone", gone);
    const zebra = (el, kind) => (kind ? el.setAttribute("data-zebra", kind) : el.removeAttribute("data-zebra"));
    const label = (el, text) => (el.querySelector("span").textContent = text);
    const render = (s = last) => {
      last = s;
      const dirty = watcher.isDirty();
      const busy = sending || running;
      body.querySelectorAll(".modal-head input, .modal-head textarea").forEach((field) => (field.disabled = busy || moving));
      // Передать в Anki
      const canSend = (s.sendable || 0) > 0;
      fold(ankiButton, running || !(sending || canSend));
      label(ankiButton, sending ? "Отменить" : "Передать в Anki");
      // Зебра – по тем же правилам, что у "Редактировать": есть что передать – полосы идут.
      zebra(ankiButton, sending ? "sendBusy" : canSend ? "sendReady" : "");
      ankiButton.classList.toggle("send-ready", !sending && canSend);
      ankiButton.disabled = moving || dirty;
      ankiButton.title = sending ? "Отменить передачу в Anki" : `Передать отредактированные: ${s.sendable || 0}`;
      // Перевести
      const canTranslate = untranslated > 0;
      fold(translateButton, sending || !(running || canTranslate));
      label(translateButton, running ? "Отменить" : "Перевести");
      zebra(translateButton, running ? "translateBusy" : canTranslate ? "translateReady" : "");
      translateButton.classList.toggle("translate-ready", !running && canTranslate);
      translateButton.disabled = moving || dirty;
      translateButton.title = running ? "Отменить перевод" : s.to_translate === null ? "Anki закрыт" : `Без перевода: ${untranslated}`;
      // Хранилище / Сохранить / Отменить перенос
      fold(saveButton, !dirty || moving);
      fold(storageButton, dirty && !moving);
      label(storageButton, moving ? "Отменить" : "Хранилище");
      zebra(storageButton, moving ? "moveBusy" : "");
      storageButton.disabled = !moving && busy;
      storageButton.title = moving ? "Отменить перенос на другой диск" : busy ? "Перенести можно после передачи в Anki / перевода" : "Где хранится видео; перенос на другой диск";
      // Редактировать
      const editLocked = moving || dirty || (busy && !(s.editable > 0));
      editLink.classList.toggle("disabled", editLocked);
      editLink.title = moving ? "Видео переносится на другой диск" : busy && !(s.editable > 0) ? "Править нечего, пока идёт передача / перевод" : "";
      note.classList.toggle("busy", busy || moving);
      if (!busy && !moving) setNote("");
    };
    const editLink = body.querySelector("#info-edit");
    body.querySelector("#info-pack").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      // Сначала окошко: что войдёт в набор и для чего он; скачивается – по кнопке.
      const fragments = last.active_total || 0;
      const box = '<svg viewBox="0 0 20 20"><path d="M3.5 6.5L10 3.5l6.5 3v7L10 16.5l-6.5-3z"/><path d="M3.5 6.5L10 9.5l6.5-3M10 9.5v7"/></svg>';
      const answer = await askConfirm({
        title: "Набор",
        icon: box,
        text: `Файл для других: разметка ${fragments} ${plural(fragments, "фрагмента", "фрагментов", "фрагментов")}, ` +
          "исправленные тексты, переводы и словарь этого " + (v.audio_only ? "аудио" : "видео") +
          " – <b>без самого " + (v.audio_only ? "аудио" : "видео") + "</b>.<br><br>Другой человек добавит то же " +
          (v.audio_only ? "аудио" : "видео") + " и при обработке нажмёт «Применить набор» – сдвиг по времени найдётся сам.",
        yes: "Скачать",
        no: "Закрыть",
      });
      if (answer !== "yes") return;
      button.disabled = true;
      try {
        await downloadPack(id, (text) => setNote(text));
      } catch (err) {
        setNote(`Набор не выгрузился: ${err.message}`);
      } finally {
        button.disabled = false;
      }
    });
    // Первый вид кнопок – сразу на своих местах, без раскрытия по ширине
    // (иначе "Передать в Anki" / "Перевести" вырастали после появления окна и
    // ещё раз – при перерисовке свежими данными). Новые кнопки проявляются из
    // пустоты; раскрытие по ширине – только при смене состояния позже.
    const actions = body.querySelector(".modal-actions");
    actions.classList.add("fold-instant");
    render();
    // Перерисовка свежими данными: кнопка, которая была видна и больше не
    // нужна, сворачивается плавно, а не пропадает разом.
    const leaving = [...actions.querySelectorAll(".fold.gone")].filter((b) => shownBefore.has(b.id));
    leaving.forEach((b) => b.classList.remove("gone"));
    void actions.offsetWidth; // применить без перехода
    actions.classList.remove("fold-instant");
    leaving.forEach((b) => b.classList.add("gone"));
    // Окно только что открыли – полосы всех трёх кнопок ("Редактировать",
    // "Передать в Anki", "Перевести") начинают с серой фазы и секунду стоят
    // (при обновлении – как шли). Идущее действие ("Отменить") – без паузы.
    if (!reuse) actions.querySelectorAll("[data-zebra]").forEach((b) => /Busy$/.test(b.dataset.zebra) || Zebra.restartGray(b));
    Zebra.paintNow();
    actions.querySelectorAll(".fold:not(.gone)").forEach((b) => {
      if (reuse && !shownBefore.has(b.id)) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: "ease" });
    });

    const refresh = async () => {
      if (!body.isConnected || body.dataset.gen !== gen) return;
      try {
        const [stats, state] = await Promise.all([Api.projectStats(id), Api.agentState()]);
        Pages.statsCache.set(id, { ...stats, _at: Date.now() });
        const s = stats.summary;
        const st = state.status || {};
        sending = !!s.sending;
        storageInfo = stats.storage;
        const mv = storageInfo && storageInfo.move;
        moving = !!(mv && !mv.finished);
        untranslated = s.sending ? 0 : s.to_translate || 0;
        waitingBatch = (state.batches || []).some((j) => j.project === id);
        running = waitingBatch || (st.state === "running" && st.project === id && Date.now() / 1000 - st.updated < 300);
        render(s);
        paint(s);
        // Копия готова, но файлы видео кто-то держит – перенос ждёт (кто – в тексте).
        if (moving && mv.waiting) setNote(mv.waiting);
        else if (moving) setNote(`Перенос на ${mv.dest}:\n${mv.total ? Math.floor((100 * mv.done) / mv.total) : 0}% – ` +
          `${(mv.done / 2 ** 30).toFixed(1)}/${(mv.total / 2 ** 30).toFixed(1)} ГБ`);
        else if (mv && mv.error) setNote(mv.error);
        else if (sending) setNote(`Передача в Anki: ${s.in_anki}/${s.active_total}`);
        else if (st.state === "running" && st.project === id && st.cards_total) {
          setNote(`Перевод: ${Math.floor(100 * (st.cards_done || 0) / st.cards_total)}% – ${st.cards_done || 0}/${st.cards_total} ` +
            plural(st.cards_total, "фрагмент", "фрагмента", "фрагментов"));
        }
        else if (waitingBatch) setNote("Ждём ответ пакета");
        const box = body.querySelector(".modal-bars");
        if ((sending || running) && box) renderSmooth(box, videoBars({ ...s, flag_interval: 0 }));
      } catch (_) {
        return;
      }
      if (moving) setTimeout(refresh, 1200);
      else if (sending || running) setTimeout(refresh, 3000);
    };
    if (sending || running || moving) refresh();

    // "Хранилище": окошко с дисками; выбрали – перенос (ход – справа и на карточке).
    // Идёт перенос – эта же кнопка его отменяет.
    storageButton.addEventListener("click", async () => {
      if (moving) {
        storageButton.disabled = true;
        try {
          await Api.cancelMove(id);
        } catch (err) {
          setNote("Ошибка", err.message);
        }
        setTimeout(refresh, 300);
        return;
      }
      const dest = await askStorage(storageInfo || { here: { label: "?", path: "" }, targets: [] });
      if (!dest) return;
      try {
        await Api.moveProject(id, dest);
      } catch (err) {
        let message = err.message;
        try {
          message = JSON.parse(message).detail;
        } catch (_) {}
        setNote(cap(message));
        return;
      }
      moving = true;
      render();
      refresh();
    });

    // Кнопки шагов: действие – и окно сразу закрывается (ход виден на карточке).
    ankiButton.addEventListener("click", async () => {
      ankiButton.disabled = true;
      try {
        if (sending) await Api.stopStage3(id);
        else await Api.queueProject(id);
      } catch (err) {
        setNote("Ошибка", err.message);
        return;
      }
      closeAndFlash();
    });
    translateButton.addEventListener("click", async () => {
      translateButton.disabled = true;
      try {
        if (running) await Api.agentStop(id);
        else await Api.agentRun({ project: id, batch: false }); // пакетом не переводим – слишком долго
      } catch (err) {
        setNote("Ошибка", err.message);
        return;
      }
      closeAndFlash();
    });
  },
});
