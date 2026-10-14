// Раздел «Настройки».

Object.assign(Pages, {
  // -- настройки ------------------------------------------------------------------------
  // Разметка страницы настроек по сохранённым значениям s: карточки по темам,
  // внизу – горячие клавиши и кнопки. Выпадающие списки ставятся позже, в
  // места .picker-host (см. settings()).
  settingsHtml(s) {
    const field = (id, label, control, hint) =>
      `<div class="field"><label class="field-label" for="${id}">${label}</label>${control}` +
      (hint ? `<div class="field-hint">${hint}</div>` : "") + "</div>";
    // Выпадающие списки (picker.js) ставятся в эти места после разметки.
    const modelField = (id, label, hint) => field(id, label, `<div class="picker-host" data-for="${id}"></div>`, hint);
    // Настройки – карточками по темам; кнопки – внизу справа.
    return `<h1>Настройки</h1>
      <div id="settings-form" class="page-grid">
        <section class="set-card">
          <h2>Anki</h2>
          ${field("set-deck", "Колода", `<input id="set-deck" class="wide" value="${escapeHtml(s.anki_deck_root)}">`,
            "Карточки идут в &lt;колода&gt;::&lt;автор&gt;::&lt;видео&gt;; при смене уже созданные колоды всех видео переименовываются")}
          ${field("set-deck-audio", "Колода для аудио", `<input id="set-deck-audio" class="wide" value="${escapeHtml(s.anki_deck_root_audio || "")}">`,
            "Песни и другие аудио: &lt;колода&gt;::&lt;исполнитель&gt;::&lt;название&gt;")}
          ${field("set-anki-model", "Тип заметок", '<div class="picker-host" data-for="set-anki-model"></div>',
            "Первое поле типа – лицо (клип и текст), второе – оборот (перевод). Пусто – возьмётся из Anki (Basic или первый в списке) и запомнится. Применяется к новым карточкам")}
          <div class="field"><div class="field-label">Обратные карточки</div>
            <label class="check"><input id="set-rev-video" type="checkbox" ${s.reverse_cards_video ? "checked" : ""}> Видео</label>
            <label class="check"><input id="set-rev-audio" type="checkbox" ${s.reverse_cards_audio ? "checked" : ""}> Аудио</label>
            <div class="field-hint">Вторая карточка: на лице перевод, на обороте клип и оригинал – сразу за прямой, когда у неё есть перевод (свой тип заметок «media-study (обратная)»)</div></div>
          <div id="deck-sync" class="small"></div>
        </section>
        <section class="set-card">
          <h2>Редактор</h2>
          ${field("set-padding", "Запас до и после отрезка",
            `<div class="with-unit"><input id="set-padding" type="number" min="0" step="0.5" value="${s.context_padding_seconds}"><span>сек</span></div>`,
            "По умолчанию для всех видео; уже отредактированные фрагменты не меняются")}
          <div class="field"><div class="field-label">Режимы при открытии</div>
            <label class="check"><input id="set-def-auto" type="checkbox" ${s.default_auto_play !== false ? "checked" : ""}> Автозапуск</label>
            <label class="check"><input id="set-def-stop" type="checkbox" ${s.default_stop_at_end !== false ? "checked" : ""}> Остановка на конце отрезка</label>
            <label class="check"><input id="set-def-skip" type="checkbox" ${s.default_skip_deleted !== false ? "checked" : ""}> Соседние фразы без удалённых</label>
            <label class="check"><input id="set-def-link-video" type="checkbox" ${s.default_link_video ? "checked" : ""}> Связанные границы – видео</label>
            <label class="check"><input id="set-def-link-audio" type="checkbox" ${s.default_link_audio !== false ? "checked" : ""}> Связанные границы – аудио</label>
            <label class="check"><input id="set-def-speakers-video" type="checkbox" ${s.default_speakers_video !== false ? "checked" : ""}> Говорящие на карточках – видео</label>
            <label class="check"><input id="set-def-speakers-audio" type="checkbox" ${s.default_speakers_audio ? "checked" : ""}> Говорящие на карточках – аудио</label>
          </div>
        </section>
        <section class="set-card">
          <h2>Добавление видео</h2>
          ${field("set-quality", "Качество скачивания", '<div class="picker-host" data-for="set-quality"></div>',
            "Для видео, добавленных по ссылке; клипы для Anki режутся из скачанного")}
          <div class="field"><label class="check"><input id="set-auto" type="checkbox" ${s.auto_process ? "checked" : ""}> Сразу обрабатывать</label></div>
        </section>
        <section class="set-card">
          <h2>Производительность</h2>
          ${field("set-reserve", "Свободные ядра процессора", '<div class="picker-host narrow-picker" data-for="set-reserve"></div>',
            "Распознавание речи на процессоре и перекодирование их не занимают – система не захлёбывается")}
          ${field("set-gpu-load", "Нагрузка на видеокарту", '<div class="picker-host narrow-picker" data-for="set-gpu-load"></div>',
            "Распознавание на видеокарте: меньше 100% – после каждого куска пауза, видеокарта занята только эту долю времени (игры и система не подтормаживают, распознавание дольше)")}
          <div class="field"><label class="check"><input id="set-priority" type="checkbox" ${s.low_priority !== false ? "checked" : ""}> Пониженный приоритет обработки</label></div>
        </section>
        <!-- Цвета на карточках Anki – отдельный блок в две мини-карточки;
             рядом – пока пустой блок такой же ширины (под будущие настройки). -->
        <section class="set-card half-card">
          <h2>Цвета на карточках</h2>
          <div class="color-row">
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_en || "#c9b6ff")}"><input type="color" id="set-color-en" value="${escapeHtml(s.anki_color_en || "#c9b6ff")}"></span> Английский</label>
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_ru || "#f6edcf")}"><input type="color" id="set-color-ru" value="${escapeHtml(s.anki_color_ru || "#f6edcf")}"></span> Русский</label>
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_dash || "#7d7d88")}"><input type="color" id="set-color-dash" value="${escapeHtml(s.anki_color_dash || "#7d7d88")}"></span> Тире</label>
            <label class="color-pick"><span class="swatch" style="background:${escapeHtml(s.anki_color_who || "#8a8a95")}"><input type="color" id="set-color-who" value="${escapeHtml(s.anki_color_who || "#8a8a95")}"></span> Говорящие</label>
          </div>
          <div class="field-hint">Новые карточки – сразу в этих цветах; уже готовые – кнопкой ниже (после «Сохранить»)</div>
          <div class="el-check-row"><button id="set-recolor" class="step-btn">Перекрасить готовые карточки</button><span id="set-recolor-note" class="muted small"></span></div>
        </section>
        <!-- Интерфейс: язык (меняется сразу, без "Сохранить" – страница перезагружается). -->
        <section class="set-card half-card">
          <h2>Языки</h2>
          ${field("set-ui-lang", "Язык интерфейса", '<div class="picker-host narrow-picker" data-for="set-ui-lang"></div>', "")}
          <div class="field-row">
            ${field("set-speech-video", "Язык речи – видео", '<div class="picker-host" data-for="set-speech-video"></div>', "")}
            ${field("set-speech-audio", "Язык речи – аудио", '<div class="picker-host" data-for="set-speech-audio"></div>', "")}
          </div>
          ${field("set-card-lang", "Язык карточек", '<div class="picker-host narrow-picker" data-for="set-card-lang"></div>',
            "На какой язык переводить. У каждого видео можно задать свои – в окне обработки")}
        </section>
        <section class="set-card wide-card">
          <h2>Хранилище</h2>
          <!-- Диски: название и путь, заполненность (занято всего / из них медиа), убрать. -->
          <div class="field"><div class="field-label">Диски</div><div id="storages-list" class="store-list"></div></div>
          <input type="hidden" id="set-storages" value="${escapeHtml(JSON.stringify(s.storages || []))}">
          ${field("set-storage-new", "Добавить хранилище",
            '<div class="store-add"><input id="set-storage-new" class="wide" placeholder="D:\\ или E:\\Медиа" data-watch="no"><button id="set-storage-add" class="step-btn" disabled>Добавить</button></div>',
            "Место на другом диске (например, внешнем): папка media-study создаётся там сама. Медиа переносятся кнопкой «Хранилище» в окне видео или аудио; в data/ остаётся ссылка")}
          <div class="field-row">
            ${field("set-new-storage", "Новые видео сохранять", '<div class="picker-host" data-for="set-new-storage"></div>',
              "Куда скачиваются и добавляются новые видео")}
            ${field("set-new-audio-storage", "Новые аудио сохранять", '<div class="picker-host" data-for="set-new-audio-storage"></div>',
              "Свои аудиофайлы; «Как видео» – туда же, куда видео")}
          </div>
        </section>
        <section class="set-card wide-card">
          <h2>Распознавание речи</h2>
          <!-- Поля – по движку (data-engine у блока): у Whisper – модель, устройство,
               нагрузка; у ElevenLabs – ключ, модель, подсказка имён. Язык
               ElevenLabs определяет сам, прокси не нужен (VPN – на весь компьютер). -->
          <div id="asr-box" data-engine="${escapeHtml(s.asr_engine || "whisper")}">
          <div class="field-row">
            ${field("set-asr", "Движок", '<div class="picker-host" data-for="set-asr"></div>',
              "Whisper – локально и бесплатно (на видеокарте – в разы быстрее); ElevenLabs Scribe – по API, платно, точнее")}
            <div class="asr-el">${field("set-el-key", "Ключ ElevenLabs", `<div class="secret-row"><input id="set-el-key" class="wide" type="password" autocomplete="off" value="${escapeHtml(s.elevenlabs_key || "")}" placeholder="sk_…"><button id="set-el-key-eye" class="icon-btn" title="Показать / скрыть"><svg viewBox="0 0 20 20"><path d="M1.8 10s3-5.5 8.2-5.5S18.2 10 18.2 10s-3 5.5-8.2 5.5S1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.6"/></svg></button></div>`,
              "elevenlabs.io → профиль → API Keys; нужен доступ «Speech to Text»")}</div>
          </div>
          <!-- Локальный Whisper: модель (установлена ли), устройство, нагрузка на видеокарту. -->
          <div class="field-row asr-wh">
            ${field("set-wh-model", "Модель Whisper", '<div class="wh-row"><div class="picker-host" data-for="set-wh-model"></div><button id="set-wh-install" class="step-btn hidden">Установить</button></div>',
              '<span id="set-wh-model-note">Скачивается один раз в кэш</span>')}
            ${field("set-wh-device", "Устройство", '<div class="picker-host" data-for="set-wh-device"></div>',
              '<span id="set-wh-gpu-note">Проверяю видеокарту…</span> <button id="set-wh-cuda" class="step-btn small-btn hidden">Установить библиотеки CUDA</button>')}
          </div>
          <div class="field-row asr-el">
            ${field("set-el-model", "Модель ElevenLabs", '<div class="picker-host" data-for="set-el-model"></div>', "Из списка или своя (название модели в API ElevenLabs)")}
            <div></div>
          </div>
          <div class="field asr-el"><label class="check"><input id="set-el-terms" type="checkbox" ${s.elevenlabs_keyterms !== false ? "checked" : ""}> Подсказать ElevenLabs имена и термины</label>
            <div class="field-hint">Перед распознаванием ElevenLabs получает список имён персонажей и названий из словаря автора (тот же, что у перевода) – их реже искажают («Changli», а не «Chang Lee»). ElevenLabs берёт за это +20% к цене</div></div>
          <div class="el-check-row asr-el"><button id="set-el-check" class="step-btn">Проверить подключение</button><span id="set-el-result" class="muted small"></span></div>
          </div>
        </section>
        <section class="set-card wide-card">
          <h2>Агенты (OpenRouter)</h2>
          ${field("set-key", "Ключ", `<div class="secret-row"><input id="set-key" class="wide" type="password" autocomplete="off" value="${escapeHtml(s.openrouter_key || "")}" placeholder="sk-or-…"><button id="set-key-eye" class="icon-btn" title="Показать / скрыть"><svg viewBox="0 0 20 20"><path d="M1.8 10s3-5.5 8.2-5.5S18.2 10 18.2 10s-3 5.5-8.2 5.5S1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.6"/></svg></button></div>`,
            "Для перевода и поиска источников")}
          <div class="field-row">
            ${modelField("set-model", "Модель перевода",
              "Своя (идентификатор на OpenRouter) или из списка; цена – $ за млн токенов (вход / выход)")}
            ${modelField("set-search-model", "Модель поиска",
              "Ищет источники текста для сверки (с веб-поиском); запросов мало – лучше сильная модель")}
          </div>
        </section>
      </div>
      <section class="set-card wide-card hotkeys-card">
        <h2>Горячие клавиши редактора</h2>
        <table class="stats hotkeys-table">${HOTKEY_HELP.map(([keys, what]) =>
          `<tr><td>${keys.split(" / ").map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(" / ")}</td><td>${escapeHtml(what)}</td></tr>`).join("")}</table>
      </section>
      <div class="settings-actions"><span id="settings-note" class="muted small"></span><button id="settings-cancel" class="step-btn">Отменить</button><button id="settings-save" class="step-btn primary">Сохранить</button></div>`;
  },

  // Значения полей страницы настроек – для сохранения (ключи – как в
  // DEFAULT_APP_SETTINGS на сервере).
  settingsPayload() {
    const $v = (id) => document.getElementById(id);
    return {
      anki_deck_root: $v("set-deck").value.trim(),
      anki_deck_root_audio: $v("set-deck-audio").value.trim(),
      anki_model: $v("set-anki-model").value.trim(),
      anki_color_en: $v("set-color-en").value,
      anki_color_ru: $v("set-color-ru").value,
      anki_color_dash: $v("set-color-dash").value,
      anki_color_who: $v("set-color-who").value,
      new_audio_storage: $v("set-new-audio-storage").value,
      context_padding_seconds: Number($v("set-padding").value),
      download_max_height: Number($v("set-quality").value),
      auto_process: $v("set-auto").checked,
      openrouter_key: $v("set-key").value.trim(),
      openrouter_model: $v("set-model").value.trim(),
      search_model: $v("set-search-model").value.trim(),
      reserve_cpu_cores: Math.max(0, Number($v("set-reserve").value) || 0),
      low_priority: $v("set-priority").checked,
      storages: JSON.parse($v("set-storages").value || "[]"),
      default_auto_play: $v("set-def-auto").checked,
      default_stop_at_end: $v("set-def-stop").checked,
      default_skip_deleted: $v("set-def-skip").checked,
      default_link_video: $v("set-def-link-video").checked,
      asr_engine: $v("set-asr").value,
      whisper_model: $v("set-wh-model").value,
      whisper_device: $v("set-wh-device").value,
      gpu_load_percent: Number($v("set-gpu-load").value) || 100,
      reverse_cards_video: $v("set-rev-video").checked,
      reverse_cards_audio: $v("set-rev-audio").checked,
      speech_lang_video: $v("set-speech-video").value,
      speech_lang_audio: $v("set-speech-audio").value,
      card_lang: $v("set-card-lang").value,
      elevenlabs_key: $v("set-el-key").value.trim(),
      elevenlabs_model: $v("set-el-model").value.trim() || "scribe_v2",
      elevenlabs_language: "", // язык – всегда определяет сам
      elevenlabs_proxy: "", // прокси не нужен – VPN на весь компьютер
      elevenlabs_keyterms: $v("set-el-terms").checked,
      default_link_audio: $v("set-def-link-audio").checked,
      default_speakers_video: $v("set-def-speakers-video").checked,
      default_speakers_audio: $v("set-def-speakers-audio").checked,
      new_video_storage: $v("set-new-storage").value,
    };
  },

  async settings() {
    const el = document.getElementById("view-settings");
    // Пока настройки грузятся, прошлое содержимое не показываем (иначе оно
    // мелькало и потом "появлялось" ещё раз – анимация как будто дважды).
    el.innerHTML = "";
    const [s, stores] = await Promise.all([Api.settings(), Api.storages().catch(() => [])]);
    el.innerHTML = this.settingsHtml(s);
    const host = (id) => el.querySelector(`.picker-host[data-for="${id}"]`);
    // Хранилища: основное (data/) и добавленные; список правится до "Сохранить"
    // (скрытое поле set-storages – чтобы работали "Отменить" и вопрос при уходе).
    const storesField = el.querySelector("#set-storages");
    const listed = () => JSON.parse(storesField.value || "[]");
    const drawStores = () => {
      const extra = listed();
      const main = stores.find((x) => x.main);
      const rows = [main, ...extra.map((path) => stores.find((x) => !x.main && x.path.toLowerCase() === path.toLowerCase()) || { path, label: path.slice(0, 2), online: true, fresh: true })]
        .filter(Boolean).map((x) => {
          // Полоска: занято на диске всего (серым) и из этого – медиа приложения (синим).
          const pct = (n) => (x.total ? Math.min(100, (n / x.total) * 100).toFixed(1) : 0);
          const usage = !x.online ? '<span class="flagged-text small">Диск не подключён</span>'
            : x.fresh ? '<span class="muted small">Появится после «Сохранить»</span>'
              : `<div class="store-bar"><div class="store-busy" style="width:${pct(x.total - x.free)}%"></div><div class="store-app" style="width:${pct(x.used || 0)}%"></div></div>` +
                `<div class="muted small">Свободно ${formatSize(x.free)} из ${formatSize(x.total)} · медиа: ${x.videos || 0}${x.videos ? `, ${formatSize(x.used)}` : ""}</div>`;
          return `<div class="store-row"><div class="store-name"><span class="store-drive">${escapeHtml(x.label)}</span>` +
            `${x.main ? ' <span class="muted small">основное</span>' : ""}<div class="muted small store-path">${escapeHtml(x.path)}</div></div>` +
            `<div class="store-usage">${usage}</div>` +
            `<div>${x.main ? "" : `<button class="step-btn storage-remove" data-path="${escapeHtml(x.path)}" title="${x.videos ? "Сначала перенесите медиа с этого диска" : "Убрать из списка (файлы не удаляются)"}"${x.videos ? " disabled" : ""}>Убрать</button>`}</div></div>`;
        }).join("");
      el.querySelector("#storages-list").innerHTML = rows;
      el.querySelectorAll(".storage-remove").forEach((b) => b.addEventListener("click", () => {
        setStores(listed().filter((p) => p !== b.dataset.path));
      }));
    };
    const setStores = (list) => {
      storesField.value = JSON.stringify(list);
      storesField.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // И после "Отменить" (поле восстанавливается и шлёт input) – таблица и список заново.
    storesField.addEventListener("input", () => {
      drawStores();
      newStorePicker.setOptions(storeOptions());
      newAudioPicker.setOptions(audioStoreOptions());
    });
    const storeOptions = () => [{ value: "", label: `${(stores.find((x) => x.main) || {}).label || "Основное"} (основное)` },
      ...listed().map((p) => ({ value: p, label: `${(stores.find((x) => x.path.toLowerCase() === p.toLowerCase()) || { label: p.slice(0, 2) }).label} – ${p}` }))];
    const newStorePicker = Picker.create(host("set-new-storage"), { id: "set-new-storage", value: s.new_video_storage || "", options: storeOptions() });
    const audioStoreOptions = () => [{ value: "", label: "Как видео" }, ...storeOptions().filter((o) => o.value)];
    const newAudioPicker = Picker.create(host("set-new-audio-storage"), { id: "set-new-audio-storage", value: s.new_audio_storage || "", options: audioStoreOptions() });
    drawStores();
    const newInput = el.querySelector("#set-storage-new");
    const addButton = el.querySelector("#set-storage-add");
    newInput.addEventListener("input", () => (addButton.disabled = !newInput.value.trim()));
    addButton.addEventListener("click", () => {
      // Указывают только место (диск или папку) – хранилище – папка
      // media-study внутри него (сервер создаст её при сохранении). Если
      // указали уже саму папку media-study – вторую не добавляем.
      let path = newInput.value.trim().replace(/["']/g, "").replace(/\//g, "\\").replace(/\\+$/, "");
      if (/^[a-z]$/i.test(path)) path += ":"; // "D" -> "D:"
      if (path && !/(^|\\)media-study$/i.test(path)) path += "\\media-study";
      if (path && !listed().some((p) => p.toLowerCase() === path.toLowerCase())) setStores([...listed(), path]);
      newInput.value = "";
      addButton.disabled = true;
    });
    // Перекраска готовых карточек приложения в сохранённые цвета (в фоне).
    el.querySelector("#set-recolor").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      const note = el.querySelector("#set-recolor-note");
      if (watcher.isDirty()) {
        note.textContent = "Сначала сохраните настройки";
        return;
      }
      button.disabled = true;
      try {
        await Api.json("/api/anki/recolor", { method: "POST" });
      } catch (err) {
        note.textContent = err.message;
        button.disabled = false;
        return;
      }
      const poll = async () => {
        if (!button.isConnected) return;
        const st = await Api.json("/api/anki/recolor");
        note.textContent = st.running ? `Перекрашиваю: ${st.done}/${st.total || "?"}`
          : st.error ? `Не получилось: ${st.error}` : `Готово: изменено ${st.changed} карточек`;
        if (st.running) setTimeout(poll, 1000);
        else button.disabled = false;
      };
      poll();
    });
    // Whisper: модели (установленные и нет), устройство, установка недостающего.
    const whModel = Picker.create(host("set-wh-model"), { id: "set-wh-model", value: s.whisper_model || "medium.en", options: [], onChange: () => drawAsr() });
    const whDevice = Picker.create(host("set-wh-device"), {
      id: "set-wh-device", value: s.whisper_device || "cpu",
      options: [{ value: "cpu", label: "Процессор" }, { value: "cuda", label: "Видеокарта (NVIDIA)" }],
      onChange: () => drawAsr(),
    });
    let asr = null;
    const drawAsr = () => {
      if (!asr || !el.isConnected) return;
      const models = asr.models;
      whModel.setOptions(models.map((m) => ({ value: m.name, label: m.label, hint: m.installed ? "установлена" : `${m.size_gb} ГБ` })));
      const chosen = models.find((m) => m.name === el.querySelector("#set-wh-model").value);
      const busy = (key) => asr.installs[key] && asr.installs[key].running;
      const failed = (key) => asr.installs[key] && asr.installs[key].error;
      const installBtn = el.querySelector("#set-wh-install");
      installBtn.classList.toggle("hidden", !chosen || chosen.installed);
      installBtn.disabled = !!(chosen && busy(`model:${chosen.name}`));
      installBtn.textContent = chosen && busy(`model:${chosen.name}`) ? "Устанавливаю…" : `Установить (${chosen ? chosen.size_gb : "?"} ГБ)`;
      el.querySelector("#set-wh-model-note").textContent = chosen && failed(`model:${chosen.name}`)
        ? `Не установилась: ${failed(`model:${chosen.name}`)}` : chosen && chosen.installed ? "Установлена" : "Не установлена – скачается при первом распознавании или кнопкой";
      const g = asr.gpu;
      const cudaBtn = el.querySelector("#set-wh-cuda");
      cudaBtn.classList.toggle("hidden", !g.available || g.libs);
      cudaBtn.disabled = !!busy("cuda");
      cudaBtn.textContent = busy("cuda") ? "Устанавливаю библиотеки…" : "Установить библиотеки CUDA (~1,2 ГБ)";
      el.querySelector("#set-wh-gpu-note").textContent = !g.available ? "Видеокарта NVIDIA не найдена – только процессор"
        : g.libs ? `${g.name.split(",")[0]} – готова` : failed("cuda") ? `Библиотеки не установились: ${failed("cuda")}` : `${g.name.split(",")[0]} – нужны библиотеки CUDA`;
      // Пока что-то ставится – обновлять.
      if (Object.values(asr.installs).some((x) => x.running)) setTimeout(loadAsr, 2000);
    };
    const loadAsr = async () => {
      try {
        asr = await Api.json("/api/asr/status");
      } catch (_) {
        return;
      }
      drawAsr();
    };
    loadAsr();
    el.querySelector("#set-wh-install").addEventListener("click", async () => {
      await Api.json("/api/asr/install", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: "model", name: el.querySelector("#set-wh-model").value }) });
      setTimeout(loadAsr, 300);
    });
    el.querySelector("#set-wh-cuda").addEventListener("click", async () => {
      await Api.json("/api/asr/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ what: "cuda" }) });
      setTimeout(loadAsr, 300);
    });
    // Образцы цвета: квадрат перекрашивается сразу при выборе.
    el.querySelectorAll(".color-pick input[type=color]").forEach((input) =>
      input.addEventListener("input", () => { input.parentElement.style.background = input.value; }));
    Picker.create(host("set-asr"), {
      id: "set-asr",
      value: s.asr_engine || "whisper",
      options: [{ value: "whisper", label: "Whisper (локально)" }, { value: "elevenlabs", label: "ElevenLabs Scribe (API)" }],
    });
    // Поля другого движка прячутся – и при выборе, и при "Отменить" (оно
    // возвращает значение поля и шлёт input/change).
    const asrField = el.querySelector("#set-asr");
    const showEngine = () => (el.querySelector("#asr-box").dataset.engine = asrField.value);
    asrField.addEventListener("input", showEngine);
    asrField.addEventListener("change", showEngine);
    // Модель ElevenLabs: из списка или своя.
    Picker.create(host("set-el-model"), {
      id: "set-el-model", editable: true, value: s.elevenlabs_model || "scribe_v2", placeholder: "scribe_v2",
      options: [
        { value: "scribe_v2", label: "scribe_v2", hint: "Самая точная" },
        { value: "scribe_v1", label: "scribe_v1", hint: "Прошлая версия" },
        { value: "scribe_v1_experimental", label: "scribe_v1_experimental", hint: "Экспериментальная" },
      ],
    });
    // Ключ ElevenLabs: показать/скрыть и проверка (с введёнными, ещё не сохранёнными значениями).
    el.querySelector("#set-el-key-eye").addEventListener("click", () => {
      const input = el.querySelector("#set-el-key");
      input.type = input.type === "password" ? "text" : "password";
    });
    el.querySelector("#set-el-check").addEventListener("click", async (e) => {
      const out = el.querySelector("#set-el-result");
      const button = e.currentTarget; // после await currentTarget уже пуст
      button.disabled = true;
      out.textContent = "Проверяю…";
      out.className = "muted small";
      try {
        const r = await Api.elevenlabsCheck(el.querySelector("#set-el-key").value.trim(), "");
        out.textContent = r.message;
        out.className = `small ${r.ok ? "ok-text" : "flagged-text"}`;
      } catch (err) {
        out.textContent = err.message;
      }
      button.disabled = false;
    });
    Picker.create(host("set-quality"), {
      id: "set-quality",
      value: String(Number(s.download_max_height) || 0),
      options: [[0, "Лучшее доступное"], [2160, "4K (2160p)"], [1440, "2K (1440p)"], [1080, "Full HD (1080p)"], [720, "HD (720p)"]]
        .map(([h, label]) => ({ value: String(h), label })),
    });
    // Язык интерфейса (i18n.js): сразу, страница перезагружается.
    Picker.create(host("set-ui-lang"), {
      id: "set-ui-lang", value: I18n.lang,
      options: [{ value: "ru", label: "Русский" }, { value: "en", label: "English" }],
      onChange: (v) => v !== I18n.lang && I18n.set(v),
    });
    el.querySelector("#set-ui-lang").dataset.watch = "no"; // не "несохранённое изменение"
    Picker.create(host("set-speech-video"), { id: "set-speech-video", value: s.speech_lang_video || "en", options: langOptions() });
    Picker.create(host("set-speech-audio"), { id: "set-speech-audio", value: s.speech_lang_audio || "en", options: langOptions() });
    // Тип заметок: список – из Anki (при открытии), можно вписать и вручную.
    Picker.create(host("set-anki-model"), {
      id: "set-anki-model", value: s.anki_model || "", editable: true, placeholder: "Из Anki (Basic или первый в списке)",
      load: async () => (await Api.json("/api/anki/models")).models.map((m) => ({ value: m, label: m })),
    });
    Picker.create(host("set-card-lang"), { id: "set-card-lang", value: s.card_lang || "ru", options: langOptions() });
    // Производительность: свободные ядра и нагрузка на видеокарту – списки.
    const cores = navigator.hardwareConcurrency || 8;
    Picker.create(host("set-reserve"), {
      id: "set-reserve", value: String(Math.min(cores - 1, Number(s.reserve_cpu_cores ?? 2))),
      options: Array.from({ length: cores }, (_, k) => ({ value: String(k), label: `${k} из ${cores}` })),
    });
    Picker.create(host("set-gpu-load"), {
      id: "set-gpu-load", value: String(s.gpu_load_percent || 100),
      options: [100, 75, 50, 25].map((p) => ({ value: String(p), label: p === 100 ? "100% – без ограничения" : `${p}%` })),
    });
    // Модели OpenRouter: по компании, внутри – по цене (дешевле – выше); список
    // общий для обоих полей, грузится при первом открытии.
    let modelsPromise = null;
    const loadModels = () => (modelsPromise ||= Api.openrouterModels().then((models) => models.map((m) => ({
      value: m.id, label: m.id, group: m.provider, hint: `$${m.prompt} / $${m.completion}`,
    }))));
    for (const id of ["set-model", "set-search-model"]) {
      Picker.create(host(id), {
        id, editable: true, load: loadModels, placeholder: "anthropic/claude-sonnet-5.5",
        value: (id === "set-model" ? s.openrouter_model : s.search_model) || "",
      });
    }
    // Заголовок, описание, карточки по очереди, кнопки.
    viewEnter(el, [el.querySelector("h1"), ...el.querySelectorAll(".set-card")]);
    const showDeckSync = (state) => {
      const box = document.getElementById("deck-sync");
      if (!box || !state) return;
      const moved = (state.moved || []).map((m) => `${escapeHtml(m.to)} (${m.cards})`).join("; ");
      box.innerHTML = state.pending
        ? `<span class="flagged-text">${escapeHtml(state.message)} – жду подключения…</span>`
        : moved ? `<span class="muted">Переименовано: ${moved}</span>` : "";
    };
    const watchDeckSync = (state) => {
      showDeckSync(state);
      // Пока колоды ждут Anki – проверяем, не получилось ли уже.
      if (state && state.pending) this.refreshEvery(5000, async () => showDeckSync((await Api.settings()).deck_sync));
    };
    watchDeckSync(s.deck_sync);
    const saveButton = document.getElementById("settings-save");
    const cancelButton = document.getElementById("settings-cancel");
    // "Отменить" / "Сохранить" – плашка поверх страницы внизу справа, видна,
    // только пока есть несохранённые изменения.
    const actions = el.querySelector(".settings-actions");
    const watcher = formWatch(document.getElementById("settings-form"), [saveButton, cancelButton],
      (dirty) => actions.classList.toggle("show", dirty));
    document.getElementById("set-key-eye").addEventListener("click", () => {
      const input = document.getElementById("set-key");
      input.type = input.type === "password" ? "text" : "password";
    });
    cancelButton.addEventListener("click", () => watcher.restore());
    const saveSettings = async () => {
      const note = document.getElementById("settings-note");
      note.textContent = "";
      let saved;
      try {
        saved = await Api.saveSettings(this.settingsPayload());
      } catch (err) {
        let message = err.message;
        try {
          message = JSON.parse(message).detail;
        } catch (_) {}
        note.textContent = cap(message);
        note.classList.add("error");
        throw err;
      }
      note.classList.remove("error");
      watcher.snapshot();
      applyEditorDefaults(saved); // режимы редактора – сразу
      watchDeckSync(saved.deck_sync);
    };
    // Ошибка (например, модели нет на OpenRouter) уже показана слева от кнопок.
    saveButton.addEventListener("click", () => saveSettings().catch(() => {}));
    // Для вопроса при уходе со страницы (Router.route).
    this.settingsGuard = { isDirty: () => watcher.isDirty(), save: saveSettings, restore: () => watcher.restore() };
  },
});
