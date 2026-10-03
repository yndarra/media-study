// Тонкие обёртки над backend API. Все методы бросают Error с текстом
// ответа сервера при неуспехе, чтобы вызывающий код мог показать причину.
const Api = {
  // Запросы редактора идут к открытому сейчас видео: /api/p/<код видео>/...
  base() {
    return `/api/p/${encodeURIComponent(State.project)}`;
  },

  async json(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  // -- библиотека, Anki, скачивание ---------------------------------------------
  projects() {
    return this.json("/api/projects");
  },

  projectStats(id) {
    return this.json(`/api/p/${encodeURIComponent(id)}/stats`);
  },

  renameGroup(id, group) {
    return this.saveProjectInfo(id, { group });
  },

  // Название и/или автор видео (поля, которых нет, не меняются).
  saveProjectInfo(id, info) {
    return this.json(`/api/p/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info),
    });
  },

  // Агент перевода: ход и предложения; запуск; одобрить/отклонить.
  agentState() {
    return this.json("/api/agent");
  },

  // options: {limit, project (перевести видео), batch (пакетом)}; без project — карточки с флагом.
  agentRun(options = {}) {
    return this.json("/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
  },

  // Остановить перевод (идущий процесс и/или пакетную заявку) видео project.
  agentStop(project = null) {
    return this.json("/api/agent/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project }),
    });
  },

  // edits: {id заметки: оборот, поправленный вручную}.
  agentApply(approve, reject, edits = {}) {
    return this.json("/api/agent/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve, reject, edits }),
    });
  },

  // Сколько места занимает видео по этапам (и для ещё не обработанного).
  projectDisk(id) {
    return this.json(`/api/p/${encodeURIComponent(id)}/disk`);
  },

  // Хранилища видео (настройки) и перенос видео между ними.
  storages() {
    return this.json("/api/storages");
  },

  cancelMove(id) {
    return this.json(`/api/p/${encodeURIComponent(id)}/move/cancel`, { method: "POST" });
  },

  // Можно ли открыть видео в редакторе (не переносится ли, есть ли что править).
  editState(id) {
    return this.json(`/api/p/${encodeURIComponent(id)}/edit_state`);
  },

  moveProject(id, dest) {
    return this.json(`/api/p/${encodeURIComponent(id)}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dest }),
    });
  },

  download(url) {
    return this.json("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  },

  saveSources(id, sources, agent, noGaps = false) {
    return this.json(`/api/p/${encodeURIComponent(id)}/sources`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources, agent, no_gaps: noGaps }),
    });
  },

  process(id) {
    return this.json(`/api/p/${encodeURIComponent(id)}/process`, { method: "POST" });
  },

  // Свой файл уходит телом запроса целиком; onProgress(доля 0..1) — ход отправки.
  importFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/import?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText)));
      xhr.onerror = () => reject(new Error("не удалось отправить файл"));
      xhr.send(file);
    });
  },

  settings() {
    return this.json("/api/settings");
  },

  saveSettings(values) {
    return this.json("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
  },

  openrouterModels() {
    return this.json("/api/openrouter/models");
  },

  // Проверка ключа и доступа ElevenLabs (настройки).
  elevenlabsCheck(key, proxy) {
    return this.json("/api/elevenlabs/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, proxy }),
    });
  },

  // Сколько медиа в разделах меню (по режимам видео/аудио).
  counts() {
    return this.json("/api/counts");
  },

  activity() {
    return this.json("/api/activity");
  },

  ankiOverview() {
    return this.json("/api/anki/overview");
  },

  // Результаты таймера правки.
  timerResults() {
    return this.json("/api/timer");
  },

  saveTimerResult(result) {
    return this.json("/api/timer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result),
    });
  },

  deleteTimerResult(id) {
    return this.json(`/api/timer/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // Раздел "Статистика": все видео с расходами, правкой, Anki и местом.
  overallStats() {
    return this.json("/api/stats");
  },

  // Кнопка "Финиш" в редакторе: всё видео считается отредактированным.
  finish(project) {
    return this.json(`/api/p/${encodeURIComponent(project)}/finish`, { method: "POST" });
  },

  // Отменить скачивание/обработку видео (готовые шаги сохраняются).
  cancelProcess(project) {
    return this.json(`/api/p/${encodeURIComponent(project)}/process/cancel`, { method: "POST" });
  },

  // Остановить передачу в Anki (непереданное возвращается в правку).
  stopStage3(project) {
    return this.json(`/api/p/${encodeURIComponent(project)}/stage3/stop`, { method: "POST" });
  },

  // Передать в Anki всё видео (кнопка на карточке в списке видео).
  queueProject(project) {
    return this.json(`/api/p/${encodeURIComponent(project)}/stage3/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  },

  ankiCheck() {
    return this.json("/api/anki/check", { method: "POST" });
  },

  ankiReturn(items) {
    return this.json("/api/anki/return", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  },

  async getManifest() {
    const res = await fetch(`${Api.base()}/manifest`);
    if (!res.ok) throw new Error("не удалось загрузить манифест");
    return res.json();
  },

  async updateFragment(id, patch) {
    const res = await fetch(`${Api.base()}/fragments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  // Отметка "не озвучено" (карточка без видео, с подписью Rover:).
  async setUnvoiced(id, value) {
    const res = await fetch(`${Api.base()}/fragments/${id}/unvoiced`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async resetFragment(id) {
    const res = await fetch(`${Api.base()}/fragments/${id}/reset`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async changePadding(id, side, direction) {
    const res = await fetch(`${Api.base()}/fragments/${id}/padding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, direction }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  // Режим "говорящие на карточках" видео (см. server.set_speakers).
  async setSpeakers(on) {
    const res = await fetch(`${Api.base()}/speakers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async softDelete(id, link = false) {
    const res = await fetch(`${Api.base()}/fragments/${id}/delete${link ? "?link=true" : ""}`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async restore(id, link = false) {
    const res = await fetch(`${Api.base()}/fragments/${id}/restore${link ? "?link=true" : ""}`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async hardDelete(id) {
    const res = await fetch(`${Api.base()}/fragments/${id}/delete_final`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async merge(id, direction) {
    const res = await fetch(`${Api.base()}/fragments/${id}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async split(id, currentFrame) {
    const res = await fetch(`${Api.base()}/fragments/${id}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_frame: currentFrame }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async queueStage3(throughId) {
    const res = await fetch(`${Api.base()}/stage3/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ through_fragment_id: throughId }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async history(id) {
    const res = await fetch(`${Api.base()}/fragments/${id}/history`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async undo(id) {
    const res = await fetch(`${Api.base()}/fragments/${id}/undo`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async redo(id) {
    const res = await fetch(`${Api.base()}/fragments/${id}/redo`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};
