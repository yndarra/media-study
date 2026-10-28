// Раздел «Обработка» (этап 1): список, окно с источниками и запуском.

// Что будет при отмене обработки на каждом шаге (готовое не переделывается).
const PROCESS_CANCEL_EFFECT = {
  download: "Скачанная часть видео <b>сохранится</b>; при следующем запуске скачивание продолжится с места остановки.",
  proxy: "Скачанное видео <b>сохранится</b>. Копия для редактора не готова – при следующем запуске она начнётся <b>заново</b>.",
  transcribe: "Видео и копия для редактора <b>сохранятся</b>. Распознавание речи не готово – при следующем запуске начнётся <b>заново</b> (это самый долгий шаг).",
  agent_search: "Видео, копия и распознанная речь <b>сохранятся</b>. Поиск текста для сверки начнётся <b>заново</b> (агент – снова платный запрос).",
  search: "Видео, копия и распознанная речь <b>сохранятся</b>. Сверка с текстом начнётся <b>заново</b>.",
  ai_fix: "Видео, копия, распознанная речь и текст для сверки <b>сохранятся</b>. Нарезка и ИИ-доводка текста на слух начнутся <b>заново</b> (доводка – снова платный запрос, недорогой).",
  segment: "Видео, копия, распознанная речь и текст для сверки <b>сохранятся</b>. Нарезка на фразы начнётся <b>заново</b> (это быстро).",
  assets: "Всё <b>сохранится</b>, кроме звуковой дорожки для редактора – её построение начнётся <b>заново</b> (это быстро).",
  default: "Готовые шаги <b>сохранятся</b>, незаконченный начнётся <b>заново</b> при следующем запуске.",
};

Object.assign(Pages, {
  // -- обработка (этап 1) --------------------------------------------------------------
  async process() {
    const el = document.getElementById("view-process");
    // Видео или аудио – по режиму (переключатель в меню).
    const kind = Mode.kind;
    el.innerHTML = `<h1>Обработка</h1>
      <p class="muted small page-note">${kind === "audio"
        ? "Добавленные аудио: распознавание речи, сверка с текстом (агент ищет текст песни сам или по вашей ссылке) и нарезка на фразы. Нажмите на аудио, чтобы прикрепить ссылки и запустить обработку."
        : "Добавленные видео: копия для редактора, распознавание речи, сверка с текстом и нарезка на фразы. Нажмите на видео, чтобы прикрепить ссылки на текст для сверки (например, страницу Notion) и запустить обработку."}</p>
      <div id="process-list"></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    const render = async () => {
      const box = document.getElementById("process-list");
      if (!box) return;
      const pending = (await Api.projects()).filter((v) => v.state !== "ready");
      const items = pending.filter((v) => !!v.audio_only === (kind === "audio"));
      Pages.processItems = pending;
      Pages.prefetchDisk(items.map((v) => v.id));
      if (!items.length) {
        box.innerHTML = `<p class="muted">Нечего обрабатывать – добавьте ${kind === "audio" ? "аудио" : "видео"} в разделе «Добавить».</p>`;
        return;
      }
      const first = !box.querySelector("a.card");
      renderSmooth(box, sortWithin(groupByAuthor(items, byProcessing), byPercent).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          // Как карточка в "Видео": название (до 2 строк), под ним – строка
          // состояния (как "Место на диске") или полоса хода (как кнопка шага).
          `<a class="card proc-card${procState(v)}" href="#/process/${encodeURIComponent(v.id)}">` +
          cardTitle(v) +
          (v.state === "processing" && v.percent !== null && v.percent !== undefined ? processingBar(v)
            : `<div class="muted small${v.state === "failed" ? " failed" : ""}">${escapeHtml(cap(
              v.state === "processing" ? v.status || "Обрабатывается" : v.state === "failed" ? v.status : "Добавлено, ждёт обработки"))}</div>`) +
          "</a>").join("") + "</div>",
      ).join(""), first);
      if (first) cardsEnter(box);
      flashCard(box);
    };
    this.processRender = render;
    await render();
    this.refreshEvery(3000, render);
  },

  // Разметка окна обработки: название и автор, источники текста, режимы
  // агента, языки, место на диске (если уже известно), кнопки.
  processModalHtml(v, disk) {
    const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
    return `
      <div class="process-form">
        <div class="modal-head">
          <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
          <label>Автор <textarea id="group-input" class="grow fixed" rows="1" data-single>${escapeHtml(v.group)}</textarea></label>
        </div>
        ${v.audio_only ? '<div class="muted">Аудио</div>' : ""}
        ${v.state === "processing" ? processingBar(v) : ""}
        <label class="check"><input type="checkbox" class="agent-search" ${v.agent === "search" ? "checked" : ""}> <span class="check-text" data-fx-line>Поиск достоверных источников с помощью агента <span class="muted small">(ссылки не нужны)</span></span></label>
        <!-- Свёрнут сразу в разметке, если агент ищет сам: иначе блок сначала
             рисовался раскрытым и окно на глазах уменьшалось. -->
        <div class="sources-box${v.agent === "search" ? " collapsed" : ""}"><div class="sources-inner">
          <label class="muted small">Текст для сверки (ссылки, по одной в строке)</label>
          <textarea class="sources grow" rows="1" placeholder="https://…notion.site/…">${escapeHtml((v.sources || []).join("\n"))}</textarea>
          <label class="check"><input type="checkbox" class="agent-deep" ${v.agent === "deep" ? "checked" : ""}> <span class="check-text" data-fx-line>Глубокий поиск с помощью агента <span class="muted small">(агент + ваши ссылки)</span></span></label>
        </div></div>
        <label class="check"><input type="checkbox" class="no-gaps" ${v.no_gaps ? "checked" : ""}> <span class="check-text" data-fx-line>Без пустых фрагментов <span class="muted small">(без музыки, шумов и других фрагментов без текста)</span></span></label>
        <!-- Языки этого видео: на каком говорят и на какой переводить карточки. -->
        <div class="field-row proc-langs">
          <div class="field"><div class="field-label">Язык речи</div><div class="picker-host" data-for="proc-speech-lang"></div></div>
          <div class="field"><div class="field-label">Язык карточек</div><div class="picker-host" data-for="proc-card-lang"></div></div>
        </div>
      </div>
      ${disk ? `<h2>Место на диске</h2><table class="stats" id="proc-disk">
        ${row("Оригинал", formatSize(disk.master))}${row("Копия для редактора", formatSize(disk.editor))}${row("Всего", `<b>${formatSize(disk.total)}</b>`)}
      </table>` : ""}
      <div class="modal-actions">
        ${v.state === "processing" ? '<button class="step-btn process-cancel">Отменить</button>'
          : `<button class="step-btn primary process-go zebra-host" data-zebra="process" id="process-go"><canvas class="zebra"></canvas><span>${escapeHtml(v.next_step || "Обработать")}</span></button>`}
        <span class="muted small note"></span>
        ${v.state === "processing" ? '<span class="process-status"></span>' : ""}
        ${v.state === "processing" ? "" : '<button class="step-btn process-pack" title="Разметить по набору от сообщества (файл .mspack.json) – без распознавания речи">Применить набор</button>'}
        <button id="process-storage" class="step-btn zebra-host${v.state === "processing" ? " hidden" : ""}" title="Где хранится видео; перенос на другой диск"><canvas class="zebra"></canvas><span>Хранилище</span></button>
        <button class="step-btn info-save hidden">Сохранить</button>
      </div>`;
  },

  // Окно видео из "Обработки": название и автор, ссылки на текст для сверки,
  // помощь агента, запуск, место на диске.
  async processModal(id) {
    let watcher = null;
    let save = async () => {};
    const body = Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/process/")) location.hash = "#/process";
    }, { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() });
    // Окно – сразу: медиа берётся из уже показанного списка, место на диске –
    // из подгруженного заранее; свежее место на диске подставляется по приходу.
    const v = (Pages.processItems || []).find((item) => item.id === id) || (await Api.projects()).find((item) => item.id === id);
    if (!v) {
      body.innerHTML = '<p class="muted">Видео не найдено.</p>';
      return;
    }
    const diskFresh = Api.projectDisk(id).then((d) => {
      Pages.diskCache.set(id, d);
      return d;
    }).catch(() => null);
    let disk = Pages.diskCache.get(id) || null;
    if (!disk) disk = await diskFresh;
    body.innerHTML = this.processModalHtml(v, disk);
    body.querySelectorAll("textarea.grow:not(.fixed)").forEach(autoGrow);
    singleLine(body.querySelector("#group-input"));
    // Окно открыли – полосы "Обработать" начинают с серой фазы и секунду стоят,
    // как у кнопок окна видео (раньше продолжали с того места, где шли).
    body.querySelectorAll("[data-zebra]").forEach((b) => Zebra.restartGray(b));
    Zebra.paintNow();
    rowLinesEnter(body);
    const packButton = body.querySelector(".process-pack");
    if (packButton) packButton.addEventListener("click", async () => {
      const text = await pickPackFile();
      if (!text) return;
      const out = body.querySelector(".modal-actions .note");
      try {
        const res = await fetch(`/api/p/${encodeURIComponent(id)}/pack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
        if (!res.ok) throw new Error(JSON.parse(await res.text()).detail);
        if (out) out.textContent = "Набор применяется – видео обрабатывается по нему";
        setTimeout(() => this.route && Router.route(true), 800);
      } catch (err) {
        if (out) out.textContent = `Не получилось: ${err.message}`;
      }
    });
    // Пришло свежее место на диске – числа в таблице на месте.
    diskFresh.then((d) => {
      const table = body.querySelector("#proc-disk");
      if (!d || !table || !body.isConnected) return;
      // Только изменившиеся значения – строки не пересоздаются (их появление
      // и разделители не начинаются заново).
      const values = [formatSize(d.master), formatSize(d.editor), `<b>${formatSize(d.total)}</b>`];
      table.querySelectorAll("tr").forEach((tr, k) => {
        const cell = tr.lastElementChild;
        const probe = document.createElement("td");
        probe.innerHTML = values[k] ?? "";
        if (cell && values[k] !== undefined && cell.textContent !== probe.textContent) cell.innerHTML = values[k];
      });
    });
    foldLongRows(body);
    // Градиент окна – по этапу, как у карточки в "Обработке" (рыжий – скачивание,
    // синий – шаг с процентом, жёлтый – сверка/поиск агентом/нарезка, зелёный – начало).
    const procBox = body.closest(".modal");
    const paintProc = (pv) => {
      procBox.classList.remove("proc-red", "proc-blue", "proc-yellow", "proc-green");
      const state = procState(pv).trim();
      if (state) procBox.classList.add(state);
    };
    paintProc(v);
    // Над видео идёт работа (скачивание, обработка) – ничего не меняется.
    if (v.state === "processing") {
      body.querySelectorAll("input, textarea, select").forEach((field) => (field.disabled = true));
      const saveBtn = body.querySelector(".info-save");
      saveBtn.disabled = true;
      saveBtn.classList.add("hidden");
    }
    // Идёт обработка: справа – её ход (обновляется), слева – "Отменить" с
    // вопросом: что сохранится, а что начнётся заново на этом шаге.
    const statusBox = body.querySelector(".process-status");
    if (statusBox) {
      const showStatus = async () => {
        if (!body.isConnected) return;
        const now = (await Api.projects()).find((item) => item.id === id);
        if (!now) return;
        paintProc(now);
        if (now.state !== "processing") {
          statusBox.textContent = cap(now.status || "Готово");
          return;
        }
        statusBox.textContent = cap(now.status) + (now.percent !== null && now.percent !== undefined ? `: ${Math.floor(now.percent)}%` : "");
        setTimeout(showStatus, 2000);
      };
      showStatus();
      body.querySelector(".process-cancel").addEventListener("click", async () => {
        const now = (await Api.projects()).find((item) => item.id === id) || v;
        const answer = await askConfirm({
          title: "Отменить обработку?", text: PROCESS_CANCEL_EFFECT[now.step] || PROCESS_CANCEL_EFFECT.default,
          yes: "Отменить обработку", no: "Продолжить", danger: true,
        });
        if (answer !== "yes") return;
        try {
          await Api.cancelProcess(id);
        } catch (err) {
          statusBox.textContent = "Не удалось отменить";
          statusBox.title = err.message;
          return;
        }
        Pages.flashId = id;
        Modal.close();
      });
    }
    const deep = body.querySelector(".agent-deep");
    const search = body.querySelector(".agent-search");
    const sourcesBox = body.querySelector(".sources-box");
    // Режимы взаимоисключающие; в режиме "агент сам ищет" ссылки и глубокий
    // поиск не нужны — прячутся вместе (глубокий поиск лежит в sources-box).
    const syncModes = (changed) => {
      if (changed === deep && deep.checked) search.checked = false;
      if (changed === search && search.checked) deep.checked = false;
      sourcesBox.classList.toggle("collapsed", search.checked);
    };
    deep.addEventListener("change", () => syncModes(deep));
    search.addEventListener("change", () => syncModes(search));
    syncModes(null);
    const saveButton = body.querySelector(".info-save");
    // Языки – до снимка формы (иначе выбор сразу считался бы изменением).
    for (const [id2, value] of [["proc-speech-lang", v.speech_lang || "en"], ["proc-card-lang", v.card_lang || "ru"]]) {
      const hostEl = body.querySelector(`.picker-host[data-for="${id2}"]`);
      if (hostEl) Picker.create(hostEl, { id: id2, value, options: langOptions() });
    }
    watcher = formWatch(body.querySelector(".process-form"), []);
    // "Сохранить" – вместо "Хранилище", только когда есть изменения; во время
    // переноса "Хранилище" – "Отменить" с быстрой серой зеброй, остальное серое.
    const storageBtn = body.querySelector("#process-storage");
    let storageInfo = disk && disk.storage;
    let moving = !!(storageInfo && storageInfo.move && !storageInfo.move.finished);
    const procNote = body.querySelector(".note");
    const renderProc = () => {
      if (v.state === "processing") return;
      const dirty = watcher.isDirty();
      saveButton.classList.toggle("hidden", !dirty || moving);
      storageBtn.classList.toggle("hidden", dirty && !moving);
      storageBtn.querySelector("span").textContent = moving ? "Отменить" : "Хранилище";
      if (moving) storageBtn.setAttribute("data-zebra", "moveBusy");
      else storageBtn.removeAttribute("data-zebra");
      storageBtn.disabled = false;
      const goBtn = body.querySelector(".process-go");
      if (goBtn) goBtn.disabled = moving || dirty;
      body.querySelectorAll(".process-form input, .process-form textarea").forEach((f) => (f.disabled = moving));
    };
    body.querySelector(".process-form").addEventListener("input", renderProc);
    body.querySelector(".process-form").addEventListener("change", renderProc);
    const pollMove = async () => {
      if (!body.isConnected) return;
      try {
        storageInfo = (await Api.projectDisk(id)).storage;
      } catch (_) {
        return;
      }
      const mv = storageInfo && storageInfo.move;
      moving = !!(mv && !mv.finished);
      procNote.textContent = moving ? (mv.waiting || `Перенос на ${mv.dest}\n${mv.total ? Math.floor((100 * mv.done) / mv.total) : 0}%`) : mv && mv.error ? mv.error : "";
      renderProc();
      if (moving) setTimeout(pollMove, 1200);
    };
    storageBtn.addEventListener("click", async () => {
      if (moving) {
        storageBtn.disabled = true;
        try {
          await Api.cancelMove(id);
        } catch (_) {}
        setTimeout(pollMove, 300);
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
        procNote.textContent = cap(message);
        return;
      }
      moving = true;
      renderProc();
      pollMove();
    });
    Zebra.start();
    renderProc();
    if (moving) pollMove();
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (title && group) await Api.saveProjectInfo(id, { title, group });
      const mode = deep.checked ? "deep" : search.checked ? "search" : "";
      const langs = {
        speech_lang: (body.querySelector("#proc-speech-lang") || {}).value || null,
        card_lang: (body.querySelector("#proc-card-lang") || {}).value || null,
      };
      await Api.saveSources(id, body.querySelector(".sources").value.split("\n"), mode, body.querySelector(".no-gaps").checked, langs);
      watcher.snapshot();
    };
    saveButton.addEventListener("click", async () => {
      await save();
      Pages.flashId = id;
      Modal.close();
    });
    const go = body.querySelector(".process-go");
    if (go) {
      Zebra.start();
      // Нажали – запуск, кнопка становится "Отменить", окно закрывается.
      go.addEventListener("click", async () => {
        await save();
        try {
          await Api.process(id);
        } catch (err) {
          body.querySelector(".note").textContent = err.message;
          return;
        }
        go.outerHTML = '<button class="step-btn process-cancel">Отменить</button>';
        Pages.flashId = id;
        Modal.close();
      });
    }
  },
});
