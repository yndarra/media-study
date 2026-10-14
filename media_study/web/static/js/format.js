// Общие помощники страниц: форматирование чисел, размеров и времени,
// группировка и сортировка списков медиа, языки, наборы от сообщества.

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// Подсветка карточки в "Обработке", пока видео обрабатывается: скачивание
// (рыжая полоса) – красноватая, шаг с синей полосой – синяя, самое начало
// (полосы ещё нет) – зеленоватая, остальные шаги – желтоватая.
function procState(v) {
  // Подсветка – только у того, что сейчас обрабатывается, и только синеватая.
  return v.state === "processing" ? " proc-blue" : "";
}

// Оформление карточки видео по этапу (фон-градиент и обводка):
//   фиолетовое – есть хоть один фрагмент, вернувшийся из Anki (с флагом), на
//   любом этапе; розовое – переведено всё (100%); зелёное – всё в Anki, идёт
//   или осталось перевод; синее – всё отредактировано, передаётся или ждёт
//   передачи в Anki; иначе (идёт правка) – обычное серое.
function cardState(v) {
  if ((v.flagged || 0) + (v.flag_interval || 0) > 0) return " has-returned";
  if (v.complete) return " complete";
  if (v.ready_to_translate) return " to-translate"; // перевод части видео карточку не красит
  if (v.ready_to_send) return " to-send"; // передача части видео карточку не красит
  if (v.awaiting && (v.reviewed || 0) > 0) return " started";
  return "";
}

function formatSize(bytes) {
  if (!bytes) return "0 МБ";
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} ГБ` : `${Math.round(bytes / 2 ** 20)} МБ`;
}

// Строка таблицы в окнах. value — текст или список строк: из нескольких строк
// видна первая, остальные свёрнуты и плавно раскрываются стрелкой ▾ справа.
function tableRow(name, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  if (!Array.isArray(value) || value.length === 1) {
    return `<tr><td>${name}</td><td>${Array.isArray(value) ? value[0] : value}</td></tr>`;
  }
  return `<tr class="multi"><td>${name}</td><td><div class="multi-first">${value[0]}` +
    `<button class="multi-toggle" title="Показать все (${value.length})">▾</button></div>` +
    `<div class="multi-rest">${value.slice(1).map((line) => `<div>${line}</div>`).join("")}</div></td></tr>`;
}

// Предложения агента по пачкам (в порядке поступления).
function groupBatches(proposals) {
  const groups = new Map();
  for (const p of proposals) {
    const key = p.batch || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()];
}

// Строка под полосами (только если есть что сказать): вернулись из Anki,
// ждут перевода, Anki закрыт.
function videoNotes(v, withDisk = true) {
  const q = v.stage3 || {};
  const queue = q.state === "waiting_anki" ? "Ждёт Anki" : "";
  const parts = [
    // Есть вернувшиеся из Anki – место на диске не показываем (строка одна, важнее они).
    withDisk && !v.flagged && v.disk_total !== undefined ? (v.drive ? `Место на диске ${v.drive} ${formatSize(v.disk_total)}` : `Место на диске: ${formatSize(v.disk_total)}`) : "",
    v.flagged ? `<span class="flagged-text">Вернулись из Anki: ${v.flagged}</span>` : "",
    v.flag_translation ? `<span class="translation-text">Перевод: ${v.flag_translation}</span>` : "",
    queue ? escapeHtml(queue) : "",
  ].filter(Boolean);
  return parts.length ? `<div class="muted small">${parts.join(" · ")}</div>` : "";
}

// Заголовок карточки видео: длительность перед названием.
function cardTitle(v) {
  return `<div class="card-title" data-fx-line><span class="card-time">${formatDuration(v.duration)}</span> ${escapeHtml(v.title)}</div>`;
}

// Следит за полями формы: кнопки "Сохранить"/"Отменить" активны, только когда
// что-то изменено. snapshot() — запомнить текущее как сохранённое.
// Языки речи и карточек (core/lang.py) – для списков выбора.
const MEDIA_LANGS = [["en", "Английский"], ["ja", "Японский"], ["ru", "Русский"], ["zh", "Китайский"], ["ko", "Корейский"],
  ["de", "Немецкий"], ["fr", "Французский"], ["es", "Испанский"], ["it", "Итальянский"], ["pt", "Португальский"], ["uk", "Украинский"]];

const langOptions = () => MEDIA_LANGS.map(([value, label]) => ({ value, label }));

// Наборы от сообщества (media_study/packs.py): выгрузить набор видео файлом.
async function downloadPack(id, note) {
  const res = await fetch(`/api/p/${encodeURIComponent(id)}/pack`);
  if (!res.ok) throw new Error(await res.text());
  const name = decodeURIComponent((res.headers.get("Content-Disposition") || "").split("''")[1] || `${id}.mspack.json`);
  const warnings = decodeURIComponent(res.headers.get("X-Pack-Warnings") || "");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  if (note) note(warnings ? `Набор сохранён. ${warnings}` : `Набор сохранён: ${name}`);
}

// Выбрать файл набора (.mspack.json) – текст файла или null.
function pickPackFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => resolve(input.files[0] ? await input.files[0].text() : null));
    input.click();
  });
}

// Форма слова по числу: plural(n, "фрагмент", "фрагмента", "фрагментов").
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// Первая буква – заглавная (статусы и подсказки всегда с большой буквы).
function cap(text) {
  const s = String(text || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Список сгруппирован по автору; внутри группы – как пришло (новые первыми).
// Порядок групп: по алфавиту, или своим сравнением (order).
function groupByAuthor(items, order = null) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return [...groups.entries()].sort(order || ((a, b) => a[0].localeCompare(b[0])));
}

// Внутри каждой группы – своим сравнением.
function sortWithin(groups, cmp) {
  return groups.map(([group, list]) => [group, [...list].sort(cmp)]);
}

// "Видео" внутри группы, по этапу:
//   0) есть вернувшиеся из Anki (фиолетовые),
//   1) не начатые (отредактировано 0 из N),
//   2) начатые (отредактировано хоть одно, но не всё),
//   3) всё отредактировано, но не всё передано в Anki,
//   4) всё в Anki, но не всё переведено,
//   5) готовые целиком.
// Внутри 0–2 – где больше осталось править; 3 – где больше не передано;
// 4 – где больше не переведено. При равенстве – по алфавиту.
const notSent = (v) => (v.active_total || 0) - (v.exported || 0);

const notTranslated = (v) => (v.cards_total || 0) - (v.translated || 0) - (v.translated_waiting || 0);

function videoStage(v) {
  if ((v.flagged || 0) + (v.flag_interval || 0) > 0) return 0;
  if (v.awaiting) return (v.reviewed || 0) > 0 ? 2 : 1;
  if (notSent(v) > 0) return 3;
  if (notTranslated(v) > 0) return 4;
  return 5;
}

function byVideoWork(a, b) {
  const sa = videoStage(a);
  const sb = videoStage(b);
  if (sa !== sb) return sa - sb;
  const diff = sa === 3 ? notSent(b) - notSent(a)
    : sa === 4 ? notTranslated(b) - notTranslated(a)
      : (b.awaiting || 0) - (a.awaiting || 0);
  return diff || String(a.title).localeCompare(String(b.title));
}

// "Обработка": группы – где больше видео в работе, при равенстве – где больше
// сумма процентов; внутри группы – по проценту (больше – выше), при равенстве –
// новые выше (список и так приходит новыми первыми, сортировка устойчивая).
const percentOf = (v) => (v.state === "processing" ? Number(v.percent) || 0 : -1);

function byProcessing(a, b) {
  const busy = (list) => list.filter((v) => v.state === "processing").length;
  const sum = (list) => list.reduce((s, v) => s + Math.max(0, percentOf(v)), 0);
  return busy(b[1]) - busy(a[1]) || sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]);
}

function byPercent(a, b) {
  return percentOf(b) - percentOf(a);
}

// Группы в "Видео": выше – где больше ждёт правки (сумма по видео группы:
// ещё не отредактированные + вернувшиеся из Anki), затем – где больше видео.
function byPendingWork(a, b) {
  const work = (list) => list.reduce((sum, v) => sum + (v.awaiting || 0), 0);
  return work(b[1]) - work(a[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]);
}
