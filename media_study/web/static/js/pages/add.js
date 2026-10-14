// Раздел «Добавить»: ссылка, свой файл, набор от сообщества.

Object.assign(Pages, {
  // -- добавить -----------------------------------------------------------------------
  async add() {
    const el = document.getElementById("view-add");
    // Как в "Настройках": блоки-карточки, два рядом (на узком экране – друг под другом).
    const audio = Mode.kind === "audio";
    el.innerHTML = `<h1>Добавить</h1>
      <div class="page-grid">
        <section class="set-card half-card${audio ? " hidden" : ""}">
          <h2>По ссылке</h2>
          <p class="muted small">YouTube и всё, что умеет yt-dlp. Видео скачается в качестве, заданном в «Настройках».</p>
          <div class="author-row"><input id="download-url" class="wide" placeholder="https://youtu.be/…"><button id="download-go" class="step-btn" disabled>Скачать</button></div>
        </section>
        <section class="set-card half-card">
          <h2>${audio ? "Свой аудиофайл" : "Свой файл"}</h2>
          <p class="muted small">${audio
            ? "Песня, подкаст и т.п. любого распространённого формата (mp3, m4a, wav, flac, ogg, opus…). Имя «Исполнитель — Название» разберётся само."
            : "Видео любого распространённого формата (mp4, mkv, webm, mov…); аудиофайлы – в режиме «Аудио»."}</p>
          <div class="author-row">
            <label class="step-btn file-pick">Выбрать файл<input id="file-input" type="file" accept="${audio ? "audio/*" : "video/*,audio/*"}" hidden></label>
            <span id="file-chip" class="file-chip hidden"><span class="file-chip-name"></span><button class="file-chip-x" title="Убрать файл">×</button></span>
            <button id="file-go" class="step-btn" disabled>Добавить</button>
          </div>
        </section>
        <section class="set-card half-card">
          <h2>Набор от сообщества</h2>
          <p class="muted small">Готовая разметка чужого видео (файл .mspack.json): видео скачается по ссылке из набора, фрагменты, тексты и переводы – из набора, без распознавания речи. Набор для своего файла – добавьте файл, затем «Применить набор» в «Обработке».</p>
          <div class="author-row"><button id="pack-go" class="step-btn">Выбрать набор</button></div>
        </section>
      </div>
      <div id="add-note" class="muted small"></div>`;
    viewEnter(el); // заголовок, описание и содержимое появляются по очереди
    const note = document.getElementById("add-note");
    const urlInput = document.getElementById("download-url");
    const fileInput = document.getElementById("file-input");
    // Кнопки активны, только когда есть что добавлять.
    urlInput.addEventListener("input", () => (document.getElementById("download-go").disabled = !urlInput.value.trim()));
    // Выбранный файл — плашкой с крестиком (убрать выбор).
    const chip = document.getElementById("file-chip");
    const showFile = () => {
      const file = fileInput.files[0];
      chip.classList.toggle("hidden", !file);
      chip.querySelector(".file-chip-name").textContent = file ? file.name : "";
      document.getElementById("file-go").disabled = !file;
    };
    fileInput.addEventListener("change", showFile);
    chip.querySelector(".file-chip-x").addEventListener("click", () => {
      fileInput.value = "";
      showFile();
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
    document.getElementById("pack-go").addEventListener("click", async () => {
      const text = await pickPackFile();
      if (!text) return;
      try {
        const res = await fetch("/api/packs/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
        if (!res.ok) throw new Error(await res.text());
        const r = await res.json();
        if (r.needs_file) note.textContent = `Набор «${r.title}» – для своего файла: добавьте файл, затем «Применить набор» в «Обработке».`;
        else note.innerHTML = `Набор принят: ${escapeHtml(r.id)} скачивается и размечается. Ход – в <a href="#/process">Обработке</a>.`;
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
});
