// Страницы приложения вокруг редактора и переходы между ними.
//
// Адрес страницы — в #-части ссылки, поэтому работают кнопки "назад/вперёд"
// браузера и обновление страницы:
//   #/videos        — библиотека: все видео, сгруппированные по автору;
//   #/video/<код>   — страница видео: прогресс, статистика, "Править";
//   #/edit/<код>    — редактор фрагментов этого видео;
//   #/process       — обработка (этап 1): источники текста, запуск, ход;
//   #/add           — добавить видео или аудио: ссылка или свой файл;
//   #/settings      — настройки приложения.
// Anki (прогресс, очередь, проверка флагов) — внутри раздела "Видео".
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
      // Ширина редактора поменялась — дорожку надо перерисовать под неё.
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
    if (page === "edit" && id) {
      this.show("editor", "videos");
      await App.openProject(id);
      FragList.reset();
      this.show("editor", "videos"); // обновить ссылку «сейчас правится» уже с названием видео
      return;
    }
    Player.pauseIfPlaying();
    if (page === "video" && id) {
      this.show("video", "videos");
      Pages.video(id);
    } else if (page === "process") {
      this.show("process", "process");
      Pages.process();
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
    // Ссылка "сейчас правится" в меню — чтобы вернуться в редактор одним кликом.
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

// Ход этапа 1: шаг и процент (если шаг умеет его считать).
function processingBar(v) {
  if (v.percent === null || v.percent === undefined) {
    return `<div class="card-status">${escapeHtml(v.status || "обрабатывается")}…</div>`;
  }
  return progressBar(v.percent, 100, `${v.status}: ${Math.floor(v.percent)}%`);
}

// Список сгруппирован по автору: группы по алфавиту, внутри — как пришло (новые первыми).
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
    el.innerHTML = `<h1>Видео</h1><div id="videos-list"><p class="muted">Загрузка…</p></div>
      <h2>Anki: проверка флагов</h2>
      <p class="muted small">Ищет в Anki карточки этого приложения, помеченные любым флагом, — их можно вернуть на доработку. Anki должен быть открыт.</p>
      <button id="anki-check" class="step-btn">Проверить</button>
      <div id="anki-check-result"></div>`;
    const render = async () => {
      const box = document.getElementById("videos-list");
      if (!box) return;
      let items;
      try {
        items = (await Api.ankiOverview());
      } catch (err) {
        box.innerHTML = `<p class="muted">Не удалось загрузить список: ${escapeHtml(err.message)}</p>`;
        return;
      }
      if (!items.length) {
        box.innerHTML = '<p class="muted">Готовых видео пока нет — добавьте их в разделе «Добавить», затем обработайте в «Обработке».</p>';
        return;
      }
      box.innerHTML = groupByAuthor(items).map(([group, list]) =>
        `<h2 class="group-title">${escapeHtml(group)}</h2><div class="cards">` + list.map((v) => {
          const q = v.stage3;
          const queue = q.state === "waiting_anki" ? "ждёт Anki" : q.notes_left ? `в очереди Anki ${q.notes_left}, ≈ ${Math.max(1, Math.ceil(q.eta_seconds / 60))} мин` : "";
          return `<a class="card" href="#/video/${encodeURIComponent(v.id)}"><div class="card-title">${escapeHtml(v.title)}</div>` +
            `<div class="muted">${formatDuration(v.duration)} · фрагментов ${v.fragments_total}</div>` +
            progressBar(v.exported, v.fragments_total, `передано в Anki ${v.exported} / ${v.fragments_total}`) +
            progressBar(v.notes_in_anki, v.cards_total, `карточек в Anki ${v.notes_in_anki} / ${v.cards_total}`) +
            `<div class="muted small">правка дошла до №${v.last_touched || 0}` +
            (v.flagged ? ` · <span class="flagged-text">⚑ на доработке: ${v.flagged}</span>` : "") +
            (queue ? ` · ${escapeHtml(queue)}` : "") + "</div></a>";
        }).join("") + "</div>",
      ).join("");
    };
    await render();
    this.refreshEvery(5000, render);
    this.bindAnkiCheck();
  },

  // -- страница видео -----------------------------------------------------------
  async video(id) {
    const el = document.getElementById("view-video");
    el.innerHTML = '<p class="muted">Загрузка…</p>';
    let data;
    try {
      data = await Api.projectStats(id);
    } catch (err) {
      el.innerHTML = `<p class="muted">Видео не найдено или ещё обрабатывается.</p>`;
      return;
    }
    const v = data.summary;
    const s = data.stats;
    const row = (name, value) => (value === null || value === undefined || value === "" ? "" : `<tr><td>${name}</td><td>${value}</td></tr>`);
    const spread = (x, unit = "") => (x ? `в среднем ${x.mean}${unit}, медиана ${x.median}${unit}, от ${x.min} до ${x.max}${unit}` : "");
    const lines = Object.entries(s.lines_per_card).map(([n, c]) => `${n} стр. — ${c}`).join(", ");
    el.innerHTML = `
      <a class="back-link" href="#/videos">‹ все видео</a>
      <h1>${escapeHtml(v.title)}</h1>
      <div class="author-row">
        <label>Автор <input id="group-input" value="${escapeHtml(v.group)}"></label>
        <button id="group-save" class="step-btn">сохранить</button>
        <span id="group-note" class="muted small"></span>
      </div>
      ${progressBar(v.exported, v.fragments_total, `в Anki ${v.exported} / ${v.fragments_total} фрагментов`)}
      <div class="actions">
        <a class="big-btn" href="#/edit/${encodeURIComponent(v.id)}">Править</a>
        <span class="muted">можно редактировать: ${v.editable} фрагментов · правка дошла до №${v.last_touched || 0}</span>
      </div>
      <h2>Статистика</h2>
      <table class="stats">
        ${row("Ролик", formatDuration(s.video_seconds))}
        ${row("Карточек (фраз)", s.cards)}
        ${row("В клипах", `${formatDuration(s.kept_seconds)} — ${(s.kept_share * 100).toFixed(1)}% ролика`)}
        ${row("Удалено", `${s.deleted} фрагментов, ${s.deleted_seconds} с`)}
        ${row("Длина клипа, с", spread(s.clip_seconds))}
        ${row("Слов", `${s.words_total}; ${spread(s.words_per_card)} на карточку; темп речи ${s.words_per_minute} слов/мин`)}
        ${row("Строк в карточке", lines)}
        ${row("Правка текста", `${s.text_edited} из ${s.cards}`)}
        ${row("Правка границ", `${s.bounds_edited} из ${s.cards}` + (s.bound_shift_frames ? `; сдвиг ${spread(s.bound_shift_frames, " кадр.")}` : ""))}
        ${row("Помечено «проверить текст»", s.needs_review)}
        ${row("Клипов выгружено", s.clips ? `${s.clips}, всего ${s.clips_megabytes_total} МБ; ${spread(s.clip_megabytes, " МБ")}; ${s.megabytes_per_second} МБ на секунду видео` : "0")}
        ${row("Колода Anki", v.anki_deck ? escapeHtml(v.anki_deck) : "создастся при первой передаче")}
      </table>`;
    document.getElementById("group-save").addEventListener("click", async () => {
      const group = document.getElementById("group-input").value.trim();
      if (!group) return;
      await Api.renameGroup(id, group);
      document.getElementById("group-note").textContent = v.anki_deck
        ? "сохранено (уже созданная колода Anki не переименовывается)"
        : "сохранено";
    });
  },

  // Кнопка "Проверить" в разделе "Видео": карточки с флагом -> вернуть на доработку.
  bindAnkiCheck() {
    document.getElementById("anki-check").addEventListener("click", async () => {
      const box = document.getElementById("anki-check-result");
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
      const flagNames = { 1: "красный", 2: "оранжевый", 3: "зелёный", 4: "синий", 5: "розовый", 6: "бирюзовый", 7: "фиолетовый" };
      box.innerHTML = `<table class="stats flagged">` + found.map((item, i) =>
        `<tr><td><input type="checkbox" data-i="${i}" ${item.state === "in_anki" ? "checked" : "disabled"}></td>` +
        `<td>${escapeHtml(item.project)} · ${escapeHtml(item.fragment_id)}</td>` +
        `<td>${escapeHtml(item.text.replace(/\n/g, " / "))}</td>` +
        `<td class="muted small">флаг: ${flagNames[item.flag] || item.flag}${item.state === "returned" ? " · уже на доработке" : ""}</td></tr>`,
      ).join("") + `</table><button id="anki-return" class="step-btn">Вернуть отмеченные на доработку</button><div id="anki-return-result"></div>`;
      document.getElementById("anki-return").addEventListener("click", async () => {
        const items = [...box.querySelectorAll("input[data-i]:checked")].map((cb) => {
          const item = found[Number(cb.dataset.i)];
          return { project: item.project, fragment_id: item.fragment_id };
        });
        if (!items.length) return;
        const result = await Api.ankiReturn(items);
        const links = Object.entries(result.returned).map(([pid, n]) =>
          `<a class="big-btn" href="#/edit/${encodeURIComponent(pid)}">править ${escapeHtml(pid)} (${n})</a>`).join(" ");
        document.getElementById("anki-return-result").innerHTML =
          `<p>Вернули на доработку. В редакторе они отмечены флажком ⚑ — фильтр «помечены в Anki».</p>${links}`;
        // Открытое в редакторе видео надо перечитать — его фрагменты разблокировались.
        if (State.project && result.returned[State.project]) {
          State.manifest = null;
          const id = State.project;
          State.project = null;
          if (State.view === "editor") App.openProject(id);
        }
      });
    });
  },

  // -- обработка (этап 1) --------------------------------------------------------------
  async process() {
    const el = document.getElementById("view-process");
    el.innerHTML = `<h1>Обработка</h1>
      <p class="muted small">Добавленные видео: копия для редактора, распознавание речи, сверка с текстом и нарезка на фразы. До запуска к видео можно прикрепить ссылки на текст для сверки (например, страницу Notion), по одной в строке.</p>
      <div id="process-list"><p class="muted">Загрузка…</p></div>`;
    const render = async (full) => {
      const box = document.getElementById("process-list");
      if (!box) return;
      const items = (await Api.projects()).filter((v) => v.state !== "ready");
      if (!items.length) {
        box.innerHTML = '<p class="muted">Нечего обрабатывать — добавьте видео или аудио в разделе «Добавить».</p>';
        return;
      }
      // Пока пользователь печатает ссылки, карточки не перерисовываются — обновляются только полоски хода.
      if (!full && box.querySelector("textarea:focus")) return;
      box.innerHTML = items.map((v) => `
        <div class="anki-row" data-id="${escapeHtml(v.id)}">
          <div class="card-title">${escapeHtml(v.title)}${v.audio_only ? ' <span class="muted small">· аудио</span>' : ""}</div>
          <div class="muted small">${formatDuration(v.duration)} · ${escapeHtml(v.group)}</div>
          ${v.state === "processing" ? processingBar(v) : `
            <label class="muted small">Текст для сверки (ссылки, по одной в строке)</label>
            <textarea class="sources" rows="3" placeholder="https://…notion.site/…">${escapeHtml((v.sources || []).join("\n"))}</textarea>
            <label class="small"><input type="checkbox" class="agent" ${v.agent ? "checked" : ""}> агент сам найдёт достоверный источник (глубокий поиск)</label>
            <div class="muted small">Агента пока нет — пока по ссылкам разбирается Claude в чате.</div>
            <div class="actions"><button class="step-btn process-go">Обработать</button><span class="muted small note"></span></div>`}
        </div>`).join("");
      box.querySelectorAll(".process-go").forEach((button) => button.addEventListener("click", async () => {
        const row = button.closest("[data-id]");
        const id = row.dataset.id;
        const sources = row.querySelector(".sources").value.split("\n");
        await Api.saveSources(id, sources, row.querySelector(".agent").checked);
        try {
          await Api.process(id);
          render(true);
        } catch (err) {
          row.querySelector(".note").textContent = err.message;
        }
      }));
      box.querySelectorAll(".sources, .agent").forEach((input) => input.addEventListener("change", () => {
        const row = input.closest("[data-id]");
        Api.saveSources(row.dataset.id, row.querySelector(".sources").value.split("\n"), row.querySelector(".agent").checked);
      }));
    };
    await render(true);
    this.refreshEvery(3000, () => render(false));
  },

  // -- добавить -----------------------------------------------------------------------
  async add() {
    const el = document.getElementById("view-add");
    el.innerHTML = `<h1>Добавить</h1>
      <h2>По ссылке</h2>
      <p class="muted small">YouTube и всё, что умеет yt-dlp. Видео скачается в максимальном качестве.</p>
      <div class="author-row"><input id="download-url" class="wide" placeholder="https://youtu.be/…"><button id="download-go" class="step-btn">Скачать</button></div>
      <h2>Свой файл</h2>
      <p class="muted small">Видео или аудио любого распространённого формата (mp4, mkv, webm, mov, mp3, m4a, wav, flac, ogg…).</p>
      <div class="author-row"><input id="file-input" type="file" accept="video/*,audio/*"><button id="file-go" class="step-btn">Добавить</button></div>
      <div id="add-note" class="muted small"></div>`;
    const note = document.getElementById("add-note");
    const done = (id) => {
      note.innerHTML = `Добавлено: ${escapeHtml(id)}. Дальше — <a href="#/process">Обработка</a>.`;
    };
    const fail = (err) => {
      let message = err.message;
      try {
        message = JSON.parse(message).detail;
      } catch (_) {}
      note.textContent = `Не получилось: ${message}`;
    };
    document.getElementById("download-go").addEventListener("click", async () => {
      const url = document.getElementById("download-url").value.trim();
      if (!url) return;
      try {
        done((await Api.download(url)).id);
      } catch (err) {
        fail(err);
      }
    });
    document.getElementById("file-go").addEventListener("click", async () => {
      const file = document.getElementById("file-input").files[0];
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
      <table class="stats">
        <tr><td>Колода Anki</td><td><input id="set-deck" class="wide" value="${escapeHtml(s.anki_deck_root)}"><div class="muted small">карточки идут в &lt;колода&gt;::&lt;автор&gt;::&lt;видео&gt;</div></td></tr>
        <tr><td>Запас до и после отрезка</td><td><input id="set-padding" type="number" min="0" step="0.5" value="${s.context_padding_seconds}"> с <div class="muted small">для новых видео</div></td></tr>
        <tr><td>После добавления</td><td><label><input id="set-auto" type="checkbox" ${s.auto_process ? "checked" : ""}> сразу обрабатывать (без прикрепления источников)</label></td></tr>
      </table>
      <div class="actions"><button id="settings-save" class="step-btn">Сохранить</button><span id="settings-note" class="muted small"></span></div>`;
    document.getElementById("settings-save").addEventListener("click", async () => {
      await Api.saveSettings({
        anki_deck_root: document.getElementById("set-deck").value.trim(),
        context_padding_seconds: Number(document.getElementById("set-padding").value),
        auto_process: document.getElementById("set-auto").checked,
      });
      document.getElementById("settings-note").textContent = "сохранено";
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
