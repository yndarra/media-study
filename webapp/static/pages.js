// Страницы приложения вокруг редактора и переходы между ними.
//
// Адрес страницы – в #-части ссылки, поэтому работают кнопки "назад/вперёд"
// браузера и обновление страницы:
//   #/videos        – библиотека: все видео, сгруппированные по автору;
//   #/video/<код>   – страница видео: прогресс, статистика, "Править";
//   #/edit/<код>    – редактор фрагментов этого видео;
//   #/process       – обработка (этап 1): источники текста, запуск, ход;
//   #/add           – добавить видео или аудио: ссылка или свой файл;
//   #/settings      – настройки приложения.
// Anki (прогресс, очередь, проверка флагов) – внутри раздела "Видео".
// Боковые панели скрываются и открываются кнопками; выбор запоминается.
const Panels = {
  init() {
    for (const side of ["left", "right"]) {
      try {
        if (localStorage.getItem(`panel-${side}`) === "closed") document.body.classList.add(`${side}-closed`);
      } catch (_) {}
    }
    document.addEventListener("click", (e) => {
      const button = e.target.closest("[data-toggle]");
      if (!button) return;
      const side = button.dataset.toggle;
      const closed = document.body.classList.toggle(`${side}-closed`);
      try {
        localStorage.setItem(`panel-${side}`, closed ? "closed" : "open");
      } catch (_) {}
      // Ширина редактора поменялась – дорожку надо перерисовать под неё.
      if (State.view === "editor") requestAnimationFrame(() => (Timeline._resize(), App.renderAll()));
    });
  },
};

const Router = {
  start() {
    Panels.init();
    Activity.start();
    window.addEventListener("hashchange", () => this.route());
    this.route();
  },

  async route() {
    const parts = (location.hash.replace(/^#\/?/, "") || "videos").split("/");
    const [page, id] = [parts[0], decodeURIComponent(parts[1] || "")];
    Pages.stopRefresh();
    // Окно подробностей живёт только на своём адресе (#/video/..., #/processing/...).
    if (!(page === "video" || (page === "process" && id))) Modal.close(false);
    if (page === "edit" && id) {
      this.show("editor", "videos");
      await App.openProject(id);
      FragList.reset();
      this.show("editor", "videos"); // обновить ссылку «сейчас правится» уже с названием видео
      return;
    }
    Player.pauseIfPlaying();
    if (page === "video" && id) {
      // Подробности видео – окно поверх списка видео.
      if (!document.getElementById("modal-overlay")) {
        this.show("videos", "videos");
        await Pages.videos();
      }
      Pages.videoModal(id);
    } else if (page === "process") {
      if (!(id && document.getElementById("modal-overlay"))) {
        this.show("process", "process");
        await Pages.process();
      }
      if (id) Pages.processModal(id);
    } else if (page === "add" || page === "download") {
      this.show("add", "add");
      Pages.add();
    } else if (page === "settings") {
      this.show("settings", "settings");
      Pages.settings();
    } else {
      this.show("videos", "videos");
      Pages.videos();
    }
  },

  show(view, menu) {
    State.view = view;
    document.querySelectorAll(".view").forEach((el) => el.classList.toggle("hidden", el.id !== `view-${view}`));
    document.querySelectorAll("#menu a[data-menu]").forEach((a) => a.classList.toggle("active", a.dataset.menu === menu));
    document.getElementById("fraglist").classList.toggle("hidden", view !== "editor");
    document.body.classList.toggle("no-fraglist", view !== "editor");
    // Фон "удалено"/"в Anki" относится к фрагменту в редакторе, не к другим страницам.
    if (view !== "editor") document.body.classList.remove("frag-deleted", "frag-locked");
    // Ссылка "сейчас правится" в меню – чтобы вернуться в редактор одним кликом.
    const editing = document.getElementById("menu-editing");
    editing.classList.toggle("hidden", !State.project);
    if (State.project) {
      const link = document.getElementById("menu-editing-link");
      link.href = `#/edit/${encodeURIComponent(State.project)}`;
      link.textContent = (State.manifest && State.manifest.video.title) || State.project;
    }
    if (view === "editor") requestAnimationFrame(() => Timeline._resize && (Timeline._resize(), App.renderAll()));
  },
};

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function progressBar(done, total, label) {
  const share = total ? Math.min(1, done / total) : 0;
  return `<div class="progress" title="${escapeHtml(label)}"><div class="progress-fill" style="width:${(share * 100).toFixed(1)}%"></div>` +
    `<span class="progress-label">${escapeHtml(label)}</span></div>`;
}

// Полоса из цветных отрезков: segments = [{n, cls}] – слева направо; последний
// отрезок с right: true прижимается к правому краю (между ними – серое).
function segmentBar(segments, total, label) {
  const pct = (n) => (total ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);
  const left = segments.filter((s) => !s.right && s.n > 0);
  const right = segments.filter((s) => s.right && s.n > 0);
  const html = (s) => `<div class="seg ${s.cls}" style="width:${pct(s.n).toFixed(2)}%" title="${escapeHtml(s.title || "")}"></div>`;
  return `<div class="progress segmented" title="${escapeHtml(label)}">` +
    `<div class="seg-left">${left.map(html).join("")}</div><div class="seg-right">${right.map(html).join("")}</div>` +
    `<span class="progress-label">${escapeHtml(label)}</span></div>`;
}

function formatSize(bytes) {
  if (!bytes) return "0 МБ";
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} ГБ` : `${Math.round(bytes / 2 ** 20)} МБ`;
}

// Две полосы видео.
// "Отредактировано" (слева направо, до скрытой метки – последнего
//   изменённого фрагмента): синее – просмотрено и принято без правок;
//   жёлтое – изменено; красное – удалено; серое – ещё не тронуто.
// "Передано в Anki" – живые фрагменты на этапе 3; справа фиолетовые —
//   карточки с флагом "обрезка/текст" (оранжевый, красный).
function videoBars(v) {
  const e = v.edit_bar || { accepted: 0, changed: 0, deleted: 0 };
  const edited = e.accepted + e.changed + e.deleted;
  const total = v.bar_total || v.fragments_total;
  return segmentBar([
    { n: e.accepted, cls: "accepted", title: `приняты без правок: ${e.accepted}` },
    { n: e.changed, cls: "changed", title: `изменены: ${e.changed}` },
    { n: e.deleted, cls: "deleted", title: `удалены: ${e.deleted}` },
  ], total, `Отредактировано ${edited} / ${total}`) +
  segmentBar([
    { n: v.exported - (v.flag_interval || 0), cls: "ok", title: `передано: ${v.exported}` },
    { n: v.flag_interval || 0, cls: "returned", right: true, title: `флаг «обрезка/текст» в Anki: ${v.flag_interval || 0}` },
  ], v.active_total, `Передано в Anki ${v.exported} / ${v.active_total}`);
}

// Строка под полосами (только если есть что сказать): вернулись из Anki,
// ждут перевода, очередь Anki.
function videoNotes(v) {
  const q = v.stage3 || {};
  const queue = q.state === "waiting_anki" ? "ждёт Anki" : q.notes_left ? `в очереди Anki ${q.notes_left}, ≈ ${Math.max(1, Math.ceil(q.eta_seconds / 60))} мин` : "";
  const all = v.notes_in_anki > 0 && v.translated >= v.notes_in_anki;
  const parts = [
    v.exported ? `<span class="${all ? "translated-all" : ""}">${all ? '<span class="tick">✓</span> ' : ""}Из них переведено: ${v.translated || 0}</span>` : "",
    v.flagged ? `<span class="flagged-text">Вернулись из Anki: ${v.flagged}</span>` : "",
    v.flag_translation ? `<span class="translation-text">Перевод: ${v.flag_translation}</span>` : "",
    queue ? escapeHtml(queue) : "",
  ].filter(Boolean);
  return parts.length ? `<div class="muted small">${parts.join(" · ")}</div>` : "";
}

// Заголовок карточки видео: длительность перед названием.
function cardTitle(v) {
  return `<div class="card-title"><span class="card-time">${formatDuration(v.duration)}</span> ${escapeHtml(v.title)}` +
    `${v.audio_only ? ' <span class="muted small">· аудио</span>' : ""}</div>`;
}

// Поле, которое растёт по содержимому (название видео, ссылки): высота —
// по тексту; Enter в однострочном поле (data-single) не переносит строку.
function autoGrow(el) {
  const fit = () => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener("input", fit);
  if (el.dataset.single !== undefined) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
  }
  requestAnimationFrame(fit);
}

// Следит за полями формы: кнопки "Сохранить"/"Отменить" активны, только когда
// что-то изменено. snapshot() — запомнить текущее как сохранённое.
function formWatch(root, buttons) {
  const fields = () => [...root.querySelectorAll("input, textarea, select")].filter((el) => el.dataset.watch !== "no");
  const value = (el) => (el.type === "checkbox" ? String(el.checked) : el.value);
  let saved = [];
  const watcher = {
    snapshot() {
      saved = fields().map(value);
      watcher.update();
    },
    isDirty() {
      const now = fields().map(value);
      return now.length !== saved.length || now.some((v, i) => v !== saved[i]);
    },
    restore() {
      fields().forEach((el, i) => {
        if (el.type === "checkbox") el.checked = saved[i] === "true";
        else el.value = saved[i];
        el.dispatchEvent(new Event("input"));
        el.dispatchEvent(new Event("change"));
      });
      watcher.update();
    },
    update() {
      const dirty = watcher.isDirty();
      buttons.forEach((button) => button && (button.disabled = !dirty));
    },
  };
  root.addEventListener("input", () => watcher.update());
  root.addEventListener("change", () => watcher.update());
  watcher.snapshot();
  return watcher;
}

// Всплывающее окно поверх страницы (подробности видео и т.п.). guard —
// {isDirty(), save()}: если при закрытии есть несохранённые правки, окно
// спрашивает, сохранять ли их.
const Modal = {
  onClose: null,
  guard: null,

  show(html, onClose, guard = null) {
    this.close(false);
    const overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.innerHTML = `<div class="modal"><button class="modal-close" title="Закрыть (Esc)">×</button><div class="modal-body">${html}</div></div>`;
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.requestClose();
    });
    overlay.querySelector(".modal-close").addEventListener("click", () => this.requestClose());
    document.body.appendChild(overlay);
    this.onClose = onClose || null;
    this.guard = guard;
    return overlay.querySelector(".modal-body");
  },

  // Закрыть по крестику / клику мимо / Esc: с вопросом, если есть несохранённое.
  requestClose() {
    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    if (overlay.querySelector(".confirm-box")) return; // вопрос уже задан
    if (!this.guard || !this.guard.isDirty()) {
      this.close();
      return;
    }
    const box = document.createElement("div");
    box.className = "confirm-box";
    box.innerHTML = `<div class="confirm"><div>Сохранить изменения?</div>
      <div class="confirm-actions"><button class="step-btn" data-a="cancel">Отмена</button>
      <button class="step-btn" data-a="drop">Не сохранять</button>
      <button class="big-btn" data-a="save">Сохранить</button></div></div>`;
    overlay.querySelector(".modal").appendChild(box);
    box.addEventListener("click", async (e) => {
      const action = e.target.dataset && e.target.dataset.a;
      if (!action) return;
      if (action === "cancel") return box.remove();
      if (action === "save") await this.guard.save();
      this.close();
    });
  },

  close(runCallback = true) {
    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    overlay.remove();
    this.guard = null;
    const callback = this.onClose;
    this.onClose = null;
    if (runCallback && callback) callback();
  },
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("modal-overlay")) Modal.requestClose();
});

// Ход этапа 1: шаг и процент (если шаг умеет его считать).
function processingBar(v) {
  if (v.percent === null || v.percent === undefined) {
    return `<div class="card-status">${escapeHtml(v.status || "обрабатывается")}…</div>`;
  }
  return progressBar(v.percent, 100, `${v.status}: ${Math.floor(v.percent)}%`);
}

// Список сгруппирован по автору: группы по алфавиту, внутри – как пришло (новые первыми).
function groupByAuthor(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const Pages = {
  timer: null,

  stopRefresh() {
    clearInterval(this.timer);
    this.timer = null;
  },

  // Страница, которая показывает живой прогресс, перерисовывается раз в несколько секунд.
  refreshEvery(ms, fn) {
    this.stopRefresh();
    this.timer = setInterval(fn, ms);
  },

  // -- библиотека (и Anki) -------------------------------------------------------
  async videos() {
    const el = document.getElementById("view-videos");
    el.innerHTML = `<div class="page-head"><h1>Видео</h1>
        <div class="head-actions">
          <button id="open-flags" class="step-btn">Проверка флагов</button>
          <button id="open-translate" class="step-btn">Перевод</button>
        </div></div>
      <p class="muted small page-note">Обработанные видео, сгруппированные по автору. Полоса «Отредактировано» – докуда дошла правка (синее – принято без правок, жёлтое – изменено, красное – удалено), «Передано в Anki» – сколько фрагментов уже стали карточками. Нажмите на видео, чтобы открыть подробности, изменить название или автора и перейти к правке.</p>
      <div id="videos-list"><p class="muted">Загрузка…</p></div>`;
    el.querySelector("#open-flags").addEventListener("click", () => this.flagsModal());
    el.querySelector("#open-translate").addEventListener("click", () => this.translateModal());
    const render = async () => {
      const box = document.getElementById("videos-list");
      if (!box) return;
      let items;
      try {
        items = await Api.ankiOverview();
      } catch (err) {
        box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
        return;
      }
      // Кнопка "Перевод" показывает, сколько карточек ждут перевода.
      const toTranslate = items.reduce((sum, v) => sum + (v.flag_translation || 0), 0);
      const translateButton = document.getElementById("open-translate");
      if (translateButton) translateButton.textContent = toTranslate ? `Перевод (${toTranslate})` : "Перевод";
      if (!items.length) {
        box.innerHTML = '<p class="muted">Готовых видео пока нет – добавьте их в разделе «Добавить», затем обработайте в «Обработке».</p>';
        return;
      }
      box.innerHTML = groupByAuthor(items).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          `<a class="card${v.complete ? " complete" : ""}" href="#/video/${encodeURIComponent(v.id)}">${cardTitle(v)}` +
          videoBars(v) + videoNotes(v) + "</a>").join("") + "</div>",
      ).join("");
    };
    await render();
    this.refreshEvery(5000, render);
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
      const statusLine = running ? `работает: ${st.done || 0} / ${st.total || "…"}${st.spent ? `, потрачено $${st.spent}` : ""}`
        : st.state === "error" ? `ошибка: ${escapeHtml(st.message || "")}` : "";
      const proposals = state.proposals;
      body.innerHTML = `
        <h2>Перевод</h2>
        <p class="muted small">Агент готовит перевод на обороте карточек с <span class="flag-dot f3"></span> зелёным и <span class="flag-dot f1"></span> красным флагом по правилам оформления, учитывает ваши комментарии со звёздочкой (*поясни за слово …) и убирает их. В Anki ничего не меняется, пока вы не одобрите. Одобренное: лицо – без комментариев, оборот – новый, метка «агент_перевод»; зелёный флаг снимается, красный становится оранжевым (обрезку ещё править).</p>
        <div class="muted small">Карточек с флагом «перевод» в Anki: ${flagged}${statusLine ? ` · ${statusLine}` : ""}${st.model ? ` · модель ${escapeHtml(st.model)}` : ""}</div>
        <div class="actions"><button id="agent-run" class="step-btn" ${running || !flagged ? "disabled" : ""}>Подготовить переводы</button></div>
        <div class="agent-list">${proposals.length ? proposals.map((p) => `
          <div class="agent-item" data-note="${p.note_id}">
            <label class="agent-head"><input type="checkbox" checked>
              <span class="flag-dot f${p.flag}"></span> ${escapeHtml(p.project)} · ${escapeHtml(p.fragment_id)}
              <span class="muted small">· ${escapeHtml(p.model || "")}${p.cost ? ` · $${p.cost}` : ""}</span></label>
            <div class="agent-en">${escapeHtml(p.text || "")}</div>
            ${(p.comments || []).length ? `<div class="agent-comments">Ваши комментарии: ${p.comments.map((c) => `«${escapeHtml(c)}»`).join(", ")}</div>` : ""}
            <div class="agent-diff">
              <div><div class="muted small">было</div><div class="agent-back old">${p.back_old || '<span class="muted">пусто</span>'}</div></div>
              <div><div class="muted small">станет</div><div class="agent-back new">${p.back_new}</div></div>
            </div>
          </div>`).join("") : '<p class="muted">Предложений нет.</p>'}</div>
        ${proposals.length ? `<div class="modal-actions">
          <button class="step-btn" id="agent-reject">Отклонить отмеченные</button>
          <span class="muted small note"></span>
          <button class="big-btn" id="agent-approve">Одобрить отмеченные</button>
        </div>` : ""}`;
      body.querySelector("#agent-run").addEventListener("click", async () => {
        try {
          await Api.agentRun();
        } catch (err) {
          alert(err.message);
        }
        draw();
      });
      const checked = () => [...body.querySelectorAll(".agent-item")]
        .filter((el) => el.querySelector("input").checked).map((el) => Number(el.dataset.note));
      const act = async (approve) => {
        const ids = checked();
        if (!ids.length) return;
        try {
          approve ? await Api.agentApply(ids, []) : await Api.agentApply([], ids);
          draw();
        } catch (err) {
          body.querySelector(".note").textContent = err.message;
        }
      };
      if (proposals.length) {
        body.querySelector("#agent-approve").addEventListener("click", () => act(true));
        body.querySelector("#agent-reject").addEventListener("click", () => act(false));
      }
      // Пока агент работает – обновляем окно, чтобы видеть ход.
      if (running) setTimeout(() => document.getElementById("modal-overlay") && body.isConnected && draw(), 3000);
    };
    await draw();
  },

  // Окно "Проверка флагов": карточки приложения с флагами в Anki; оранжевые и
  // красные можно вернуть в редактор, перевод – в окне "Перевод".
  flagsModal() {
    const body = Modal.show(`
      <h2>Проверка флагов</h2>
      <p class="muted small">Флаги карточек приложения в Anki:
        <span class="flag-dot f2"></span> оранжевый – поправить обрезку или английский текст (вернуть в редактор);
        <span class="flag-dot f3"></span> зелёный – поправить перевод (агент);
        <span class="flag-dot f1"></span> красный – и то, и другое. Anki должен быть открыт.</p>
      <div class="actions">
        <button id="anki-check" class="step-btn">Проверить</button>
        <button id="to-translate" class="step-btn">Перейти к переводу</button>
      </div>
      <div id="anki-check-result"></div>`);
    body.querySelector("#to-translate").addEventListener("click", () => this.translateModal());
    body.querySelector("#anki-check").addEventListener("click", async () => {
      const box = body.querySelector("#anki-check-result");
      box.innerHTML = '<p class="muted">Проверяю…</p>';
      let found;
      try {
        found = await Api.ankiCheck();
      } catch (err) {
        let message = err.message;
        try {
          message = JSON.parse(message).detail;
        } catch (_) {}
        box.innerHTML = `<p class="muted">Не получилось: ${escapeHtml(message)}</p>`;
        return;
      }
      if (!found.length) {
        box.innerHTML = '<p class="muted">Помеченных карточек нет.</p>';
        return;
      }
      const flagNames = { 1: "красный: обрезка и перевод", 2: "оранжевый: обрезка/текст", 3: "зелёный: перевод (агент)",
        4: "синий", 5: "розовый", 6: "бирюзовый", 7: "фиолетовый" };
      // В редактор возвращаются только карточки с флагом обрезки/текста (красный, оранжевый).
      const returnable = (item) => item.state === "in_anki" && (item.flag === 1 || item.flag === 2);
      box.innerHTML = `<table class="stats flagged">` + found.map((item, i) =>
        `<tr><td><input type="checkbox" data-i="${i}" ${returnable(item) ? "checked" : "disabled"}></td>` +
        `<td><span class="flag-dot f${item.flag}"></span> ${escapeHtml(item.project)} · ${escapeHtml(item.fragment_id)}</td>` +
        `<td>${escapeHtml(item.text.replace(/\n/g, " / "))}</td>` +
        `<td class="muted small">${flagNames[item.flag] || item.flag}${item.state === "returned" ? " · уже на доработке" : ""}</td></tr>`,
      ).join("") + `</table><button id="anki-return" class="step-btn">Вернуть отмеченные на доработку</button><div id="anki-return-result"></div>`;
      box.querySelector("#anki-return").addEventListener("click", async () => {
        const items = [...box.querySelectorAll("input[data-i]:checked")].map((cb) => {
          const item = found[Number(cb.dataset.i)];
          return { project: item.project, fragment_id: item.fragment_id };
        });
        if (!items.length) return;
        const result = await Api.ankiReturn(items);
        const links = Object.entries(result.returned).map(([pid, n]) =>
          `<a class="big-btn" href="#/edit/${encodeURIComponent(pid)}">править ${escapeHtml(pid)} (${n})</a>`).join(" ");
        box.querySelector("#anki-return-result").innerHTML =
          `<p>Вернули на доработку. В редакторе они отмечены флажком ⚑ – фильтр «помечены в Anki».</p>${links}`;
        // Открытое в редакторе видео надо перечитать – его фрагменты разблокировались.
        if (State.project && result.returned[State.project]) {
          State.manifest = null;
          const id = State.project;
          State.project = null;
          if (State.view === "editor") App.openProject(id);
        }
      });
    });
  },

  // Подробности видео – окно поверх списка (#/video/<код>): статистика, место
  // на диске, правка названия и автора (колода Anki переименуется вслед).
  async videoModal(id) {
    let watcher = null;
    let save = async () => {};
    const body = Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/video/")) location.hash = "#/videos";
    }, { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() });
    let data;
    try {
      data = await Api.projectStats(id);
    } catch (err) {
      body.innerHTML = `<p class="muted">Видео не найдено или ещё обрабатывается.</p>`;
      return;
    }
    const v = data.summary;
    const s = data.stats;
    const d = data.disk;
    const row = (name, value) => (value === null || value === undefined || value === "" ? "" : `<tr><td>${name}</td><td>${value}</td></tr>`);
    const spread = (x, unit = "") => (x ? `в среднем ${x.mean}${unit}, медиана ${x.median}${unit}, от ${x.min} до ${x.max}${unit}` : "");
    const lines = Object.entries(s.lines_per_card).map(([n, c]) => `${n} стр. – ${c}`).join(", ");
    body.innerHTML = `
      <div class="modal-head">
        <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
        <label>Автор <input id="group-input" value="${escapeHtml(v.group)}"></label>
      </div>
      ${videoBars({ ...v, flag_interval: 0 })}
      ${videoNotes(v)}
      <h2>Статистика</h2>
      <table class="stats">
        ${row("Ролик", `${formatDuration(s.video_seconds)}, карточек ${s.cards}`)}
        ${row("В клипах", `${formatDuration(s.kept_seconds)} – ${(s.kept_share * 100).toFixed(1)}% ролика, удалено ${s.deleted} фрагментов (${Math.round(s.deleted_seconds)} сек)`)}
        ${row("Длина клипа, сек", s.clip_seconds ? `${s.clip_seconds.mean} в среднем, ${s.clip_seconds.median} медиана, ${s.clip_seconds.min} минимально, ${s.clip_seconds.max} максимально` : "")}
        ${row("Строк в карточке", lines)}
        ${row("Правка текста", `${s.text_edited} из ${s.cards}`)}
        ${row("Правка границ", `${s.bounds_edited} из ${s.cards}` + (s.bound_shift_frames ? `; сдвиг ${spread(s.bound_shift_frames, " кадр.")}` : ""))}
        ${row("Колода Anki", v.anki_deck ? escapeHtml(v.anki_deck) : "нет")}
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
        <a class="big-btn" href="#/edit/${encodeURIComponent(v.id)}">Править</a>
        <span id="info-note" class="muted small"></span>
        <button id="info-save" class="step-btn">Сохранить</button>
      </div>`;
    autoGrow(body.querySelector("#title-input"));
    const saveButton = body.querySelector("#info-save");
    watcher = formWatch(body.querySelector(".modal-head"), [saveButton]);
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (!title || !group) return;
      const saved = await Api.saveProjectInfo(id, { title, group });
      watcher.snapshot();
      const sync = saved.deck_sync || {};
      body.querySelector("#info-note").textContent = !v.anki_deck ? ""
        : sync.pending ? "колода Anki переименуется, когда Anki откроется" : "колода Anki переименована";
    };
    saveButton.addEventListener("click", save);
  },

  // -- обработка (этап 1) --------------------------------------------------------------
  async process() {
    const el = document.getElementById("view-process");
    el.innerHTML = `<h1>Обработка</h1>
      <p class="muted small page-note">Добавленные видео: копия для редактора, распознавание речи, сверка с текстом и нарезка на фразы. Нажмите на видео, чтобы прикрепить ссылки на текст для сверки (например, страницу Notion) и запустить обработку.</p>
      <div id="process-list"><p class="muted">Загрузка…</p></div>`;
    const render = async () => {
      const box = document.getElementById("process-list");
      if (!box) return;
      const items = (await Api.projects()).filter((v) => v.state !== "ready");
      if (!items.length) {
        box.innerHTML = '<p class="muted">Нечего обрабатывать – добавьте видео или аудио в разделе «Добавить».</p>';
        return;
      }
      box.innerHTML = groupByAuthor(items).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) =>
          `<a class="card" href="#/process/${encodeURIComponent(v.id)}">` +
          cardTitle(v) +
          ((v.sources || []).length ? `<div class="muted small">ссылок на текст: ${v.sources.length}</div>` : "") +
          (v.state === "processing" ? processingBar(v) : `<div class="card-status">Добавлено, ждёт обработки</div>`) +
          "</a>").join("") + "</div>",
      ).join("");
    };
    await render();
    this.refreshEvery(3000, render);
  },

  // Окно видео из "Обработки": название и автор, ссылки на текст для сверки,
  // помощь агента, запуск, место на диске.
  async processModal(id) {
    let watcher = null;
    let save = async () => {};
    const body = Modal.show('<p class="muted">Загрузка…</p>', () => {
      if (location.hash.startsWith("#/process/")) location.hash = "#/process";
    }, { isDirty: () => !!watcher && watcher.isDirty(), save: () => save() });
    const v = (await Api.projects()).find((item) => item.id === id);
    if (!v) {
      body.innerHTML = '<p class="muted">Видео не найдено.</p>';
      return;
    }
    let disk = null;
    try {
      disk = await Api.projectDisk(id);
    } catch (_) {}
    const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
    body.innerHTML = `
      <div class="process-form">
        <div class="modal-head">
          <label>Название <textarea id="title-input" class="grow" rows="1" data-single>${escapeHtml(v.title)}</textarea></label>
          <label>Автор <input id="group-input" value="${escapeHtml(v.group)}"></label>
        </div>
        <div class="muted">${formatDuration(v.duration)}${v.audio_only ? " · аудио" : ""}</div>
        ${v.state === "processing" ? processingBar(v) : ""}
        <label class="check"><input type="checkbox" class="agent-deep" ${v.agent === "deep" ? "checked" : ""}> Глубокий поиск с помощью агента <span class="muted small">(агент + ваши ссылки)</span></label>
        <label class="check"><input type="checkbox" class="agent-search" ${v.agent === "search" ? "checked" : ""}> Поиск достоверных источников с помощью агента <span class="muted small">(ссылки не нужны)</span></label>
        <div class="sources-box">
          <label class="muted small">Текст для сверки (ссылки, по одной в строке)</label>
          <textarea class="sources grow" rows="1" placeholder="https://…notion.site/…">${escapeHtml((v.sources || []).join("\n"))}</textarea>
        </div>
      </div>
      ${disk ? `<h2>Место на диске</h2><table class="stats">
        ${row("Оригинал", formatSize(disk.master))}${row("Копия для редактора", formatSize(disk.editor))}${row("Всего", `<b>${formatSize(disk.total)}</b>`)}
      </table>` : ""}
      <div class="modal-actions">
        ${v.state === "processing" ? "" : '<button class="big-btn process-go">Обработать</button>'}
        <span class="muted small note"></span>
        <button class="step-btn info-save">Сохранить</button>
      </div>`;
    body.querySelectorAll("textarea.grow").forEach(autoGrow);
    const deep = body.querySelector(".agent-deep");
    const search = body.querySelector(".agent-search");
    const sourcesBox = body.querySelector(".sources-box");
    // Режимы взаимоисключающие; в режиме "агент сам ищет" ссылки не нужны — поле прячется.
    const syncModes = (changed) => {
      if (changed === deep && deep.checked) search.checked = false;
      if (changed === search && search.checked) deep.checked = false;
      sourcesBox.classList.toggle("hidden", search.checked);
    };
    deep.addEventListener("change", () => syncModes(deep));
    search.addEventListener("change", () => syncModes(search));
    syncModes(null);
    const saveButton = body.querySelector(".info-save");
    watcher = formWatch(body.querySelector(".process-form"), [saveButton]);
    save = async () => {
      const title = body.querySelector("#title-input").value.trim();
      const group = body.querySelector("#group-input").value.trim();
      if (title && group) await Api.saveProjectInfo(id, { title, group });
      const mode = deep.checked ? "deep" : search.checked ? "search" : "";
      await Api.saveSources(id, body.querySelector(".sources").value.split("\n"), mode);
      watcher.snapshot();
    };
    saveButton.addEventListener("click", save);
    const go = body.querySelector(".process-go");
    if (go) go.addEventListener("click", async () => {
      await save();
      try {
        await Api.process(id);
        Modal.close();
      } catch (err) {
        body.querySelector(".note").textContent = err.message;
      }
    });
  },

  // -- добавить -----------------------------------------------------------------------
  async add() {
    const el = document.getElementById("view-add");
    el.innerHTML = `<h1>Добавить</h1>
      <h2>По ссылке</h2>
      <p class="muted small">YouTube и всё, что умеет yt-dlp. Видео скачается в качестве, заданном в «Настройках».</p>
      <div class="author-row"><input id="download-url" class="wide" placeholder="https://youtu.be/…"><button id="download-go" class="step-btn" disabled>Скачать</button></div>
      <h2>Свой файл</h2>
      <p class="muted small">Видео или аудио любого распространённого формата (mp4, mkv, webm, mov, mp3, m4a, wav, flac, ogg…).</p>
      <div class="author-row">
        <label class="step-btn file-pick">Выбрать файл<input id="file-input" type="file" accept="video/*,audio/*" hidden></label>
        <span id="file-name" class="muted small">файл не выбран</span>
        <button id="file-go" class="step-btn" disabled>Добавить</button>
      </div>
      <div id="add-note" class="muted small"></div>`;
    const note = document.getElementById("add-note");
    const urlInput = document.getElementById("download-url");
    const fileInput = document.getElementById("file-input");
    // Кнопки активны, только когда есть что добавлять.
    urlInput.addEventListener("input", () => (document.getElementById("download-go").disabled = !urlInput.value.trim()));
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      document.getElementById("file-name").textContent = file ? file.name : "файл не выбран";
      document.getElementById("file-go").disabled = !file;
    });
    const done = (id) => {
      note.innerHTML = `Добавлено: ${escapeHtml(id)}. Дальше – <a href="#/process">Обработка</a>.`;
    };
    const fail = (err) => {
      let message = err.message;
      try {
        message = JSON.parse(message).detail;
      } catch (_) {}
      note.textContent = `Не получилось: ${message}`;
    };
    document.getElementById("download-go").addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      try {
        done((await Api.download(url)).id);
      } catch (err) {
        fail(err);
      }
    });
    document.getElementById("file-go").addEventListener("click", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        done((await Api.importFile(file, (share) => (note.textContent = `Отправляю файл: ${Math.floor(share * 100)}%`))).id);
      } catch (err) {
        fail(err);
      }
    });
  },

  // -- настройки ------------------------------------------------------------------------
  async settings() {
    const el = document.getElementById("view-settings");
    const s = await Api.settings();
    el.innerHTML = `<h1>Настройки</h1>
      <table class="stats" id="settings-form">
        <tr><td>Колода Anki</td><td><input id="set-deck" class="wide" value="${escapeHtml(s.anki_deck_root)}">
          <div class="muted small">карточки идут в &lt;колода&gt;::&lt;автор&gt;::&lt;видео&gt;; при смене уже созданные колоды всех видео переименовываются</div>
          <div id="deck-sync" class="small"></div></td></tr>
        <tr><td>Запас до и после отрезка</td><td><input id="set-padding" type="number" min="0" step="0.5" value="${s.context_padding_seconds}"> сек <div class="muted small">по умолчанию для всех видео; уже отредактированные фрагменты не меняются</div></td></tr>
        <tr><td>Качество скачивания</td><td><select id="set-quality">
          ${[[0, "лучшее доступное"], [2160, "4K (2160p)"], [1440, "2K (1440p)"], [1080, "Full HD (1080p)"], [720, "HD (720p)"]]
            .map(([h, name]) => `<option value="${h}" ${Number(s.download_max_height) === h ? "selected" : ""}>${name}</option>`).join("")}
          </select><div class="muted small">по умолчанию для видео, добавленных по ссылке; клипы для Anki режутся из скачанного</div></td></tr>
        <tr><td>После добавления</td><td><label class="check"><input id="set-auto" type="checkbox" ${s.auto_process ? "checked" : ""}> Сразу обрабатывать</label>
          <div class="muted small">видео, добавленное по ссылке или файлом, сразу уходит в обработку (распознавание и нарезка) – без захода в «Обработку» и без ссылок на текст для сверки</div></td></tr>
        <tr><td>Ключ OpenRouter</td><td><div class="secret-row"><input id="set-key" class="wide" type="password" autocomplete="off" value="${escapeHtml(s.openrouter_key || "")}" placeholder="sk-or-…"><button id="set-key-eye" class="icon-btn" title="Показать / скрыть">👁</button></div><div class="muted small">для агента перевода</div></td></tr>
        <tr><td>Модель перевода</td><td><div class="secret-row picker"><input id="set-model" class="wide" value="${escapeHtml(s.openrouter_model || "")}" placeholder="anthropic/claude-sonnet-5.5"><button id="set-model-pick" class="icon-btn" title="Выбрать из списка">▾</button>
          <div id="model-list" class="model-list hidden"></div></div>
          <div class="muted small">можно вписать свою (идентификатор на OpenRouter) или выбрать из списка; цена – $ за миллион токенов (вход / выход)</div></td></tr>
      </table>
      <div class="actions"><button id="settings-save" class="step-btn">Сохранить</button><button id="settings-cancel" class="step-btn">Отменить</button></div>`;
    const showDeckSync = (state) => {
      const box = document.getElementById("deck-sync");
      if (!box || !state) return;
      const moved = (state.moved || []).map((m) => `${escapeHtml(m.to)} (${m.cards})`).join("; ");
      box.innerHTML = state.pending
        ? `<span class="flagged-text">${escapeHtml(state.message)} – жду подключения…</span>`
        : moved ? `<span class="muted">переименовано: ${moved}</span>` : "";
    };
    const watchDeckSync = (state) => {
      showDeckSync(state);
      // Пока колоды ждут Anki – проверяем, не получилось ли уже.
      if (state && state.pending) this.refreshEvery(5000, async () => showDeckSync((await Api.settings()).deck_sync));
    };
    watchDeckSync(s.deck_sync);
    const saveButton = document.getElementById("settings-save");
    const cancelButton = document.getElementById("settings-cancel");
    const watcher = formWatch(document.getElementById("settings-form"), [saveButton, cancelButton]);
    document.getElementById("set-key-eye").addEventListener("click", () => {
      const input = document.getElementById("set-key");
      input.type = input.type === "password" ? "text" : "password";
    });
    const list = document.getElementById("model-list");
    document.getElementById("set-model-pick").addEventListener("click", async () => {
      if (!list.classList.contains("hidden")) {
        list.classList.add("hidden");
        return;
      }
      list.classList.remove("hidden");
      list.innerHTML = '<div class="muted small">загрузка…</div>';
      try {
        const models = await Api.openrouterModels();
        list.innerHTML = models.map((m) =>
          `<div class="model-item" data-id="${escapeHtml(m.id)}"><span>${escapeHtml(m.id)}</span><span class="muted small">$${m.prompt} / $${m.completion}</span></div>`).join("");
        list.querySelectorAll(".model-item").forEach((item) => item.addEventListener("click", () => {
          const input = document.getElementById("set-model");
          input.value = item.dataset.id;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          list.classList.add("hidden");
        }));
      } catch (err) {
        list.innerHTML = `<div class="muted small">не удалось загрузить список: ${escapeHtml(err.message)}</div>`;
      }
    });
    cancelButton.addEventListener("click", () => watcher.restore());
    saveButton.addEventListener("click", async () => {
      const saved = await Api.saveSettings({
        anki_deck_root: document.getElementById("set-deck").value.trim(),
        context_padding_seconds: Number(document.getElementById("set-padding").value),
        download_max_height: Number(document.getElementById("set-quality").value),
        auto_process: document.getElementById("set-auto").checked,
        openrouter_key: document.getElementById("set-key").value.trim(),
        openrouter_model: document.getElementById("set-model").value.trim(),
      });
      watcher.snapshot();
      watchDeckSync(saved.deck_sync);
    });
  },
};

// Блок "Сейчас идёт" внизу меню: фоновые процессы с процентом и временем до конца.
const Activity = {
  start() {
    this.render();
    setInterval(() => this.render(), 2500);
  },

  async render() {
    const box = document.getElementById("activity-list");
    let items;
    try {
      items = await Api.activity();
    } catch (_) {
      return;
    }
    if (!items.length) {
      box.textContent = "ничего";
      return;
    }
    box.innerHTML = items.map((a) => {
      const eta = a.eta_seconds ? ` · ≈ ${a.eta_seconds < 60 ? "<1" : Math.ceil(a.eta_seconds / 60)} мин` : "";
      const bar = a.percent === null || a.percent === undefined ? "" :
        `<div class="progress thin"><div class="progress-fill" style="width:${a.percent}%"></div></div>`;
      return `<div class="activity-item"><div class="activity-name">${escapeHtml(a.title)}</div>` +
        `<div>${escapeHtml(a.label)}${a.percent !== null && a.percent !== undefined ? ` ${Math.floor(a.percent)}%` : ""}${eta}</div>${bar}</div>`;
    }).join("");
  },
};
