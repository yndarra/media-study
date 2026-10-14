// Общее состояние редактора и вся логика кнопок/текста/навигации.
// timeline.js и player.js обращаются к State/App/currentFragment лениво —
// в момент вызова страница уже полностью загружена.
const State = {
  manifest: null,
  fragmentIndex: -1,
  currentFrame: 0,
  timeMarkerFrame: null,
  stopAtSegmentEnd: true, // режим остановки на последнем кадре отрезка (кнопка рядом с Play)
  selected: "playhead", // что двигают ±1/±10 и стрелки: "playhead" | "start" | "end"
  lastStop: null, // {frame} — где было последнее автоматическое завершение воспроизведения
  manualPlayhead: false, // текущий кадр выбран вручную на дорожке (для жёлтой метки)
  stage3: { eta_seconds: 0, pending_ids: [], state: "idle", message: "" }, // очередь Anki открытого видео
  project: null, // код открытого в редакторе видео
  view: null, // открытая страница: videos | video | anki | download | editor
  speed: loadSpeed(), // скорость воспроизведения — общая для всех видео (0.5–2)
  translatedIds: new Set(), // фрагменты открытого видео, переведённые в Anki (розовый фон в списке)
  // Автозапуск: переход к фрагменту, клик/протяжка по дорожке и левая граница
  // отрезка сразу запускают воспроизведение (кнопка справа от режима остановки).
  // Режимы при открытии – из "Настроек" (default_*); кнопки в редакторе
  // меняют их до перезагрузки страницы.
  autoPlay: true,
  // Соседние фразы (серые): удалённые фрагменты пропускаются – видна ближайшая
  // живая; выключено – видна и удалённая (зачёркнутой).
  skipDeleted: true,
  // Связанные границы: внутренняя граница отрезка двигается вместе с
  // границей соседа (склейка всех фрагментов = исходник покадрово).
  // По умолчанию: видео – выкл, аудио – вкл (настройки).
  linkBounds: false,
};

// Режимы редактора по умолчанию (настройки) – при загрузке страницы и после
// сохранения настроек.
function applyEditorDefaults(settings) {
  if (!settings) return;
  State.autoPlay = settings.default_auto_play !== false;
  State.stopAtSegmentEnd = settings.default_stop_at_end !== false;
  State.skipDeleted = settings.default_skip_deleted !== false;
  State.linkDefaults = { video: !!settings.default_link_video, audio: settings.default_link_audio !== false };
  State.linkBounds = State.linkDefaults[State.manifest && State.manifest.video.audio_only ? "audio" : "video"];
  if (typeof App !== "undefined" && App.updateAutoButton) {
    App.updateAutoButton();
    App.updateModeButton();
    App.updateSkipButton();
    App.updateLinkButton();
    if (State.manifest && currentFragment()) App.renderText(currentFragment(), false);
  }
}

// Скорость воспроизведения хранится в браузере и общая для всех видео.
function loadSpeed() {
  try {
    const value = Number(localStorage.getItem("playback-speed"));
    if (value >= 0.5 && value <= 2) return value;
  } catch (_) {}
  return 1;
}

// Скорость, пока зажат Shift.
const BOOST_SPEED = 2;

function currentFragment() {
  return State.manifest ? State.manifest.fragments[State.fragmentIndex] : null;
}

function fps() {
  return State.manifest.video.fps;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(value, high));
}

// Фрагмент хоть как-то изменён — для "скрытого прогресса": редактор
// открывается на последнем таком фрагменте (то же правило, что media_study/web/library.py).
function isTouched(f) {
  return !!(f.exported || f.status !== "active" || isTextEdited(f) || isBoundsEdited(f) || f.context_custom || f.merged_from || f.split_from);
}

// Отметка "не озвучено" — ставится кнопкой (как Fragment.is_unvoiced на сервере).
function isUnvoiced(f) {
  return !!(f && f.unvoiced);
}

// Фрагмент передан в Anki (этап 3): его можно только просматривать.
function isLocked(f) {
  return !!(f && f.exported);
}

function isTextEdited(f) {
  return f.text !== f.original_text;
}

function isBoundsEdited(f) {
  return f.algo_start_frame !== f.original_algo_start_frame || f.algo_end_frame !== f.original_algo_end_frame;
}

// Чистка текста по тому же правилу, что на сервере (media_study/core/text_clean.py):
// без невидимых пробелов, без повторных пробелов, без пустых строк.
function cleanText(text) {
  return (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line)
    .join("\n");
}

// Время в формате ЧЧ:ММ:СС.
function formatClock(seconds) {
  const total = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const ICONS = {
  // Соседние фразы: удалённые пропускаются (перечёркнутый глаз) / видны (глаз).
  skipOn: '<svg viewBox="0 0 20 20"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/><path d="M4 16L16 4"/></svg>',
  skipOff: '<svg viewBox="0 0 20 20"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/></svg>',
  // Связанные границы: соединённые звенья / разорванные.
  speakersOn: '<svg viewBox="0 0 20 20"><circle cx="8" cy="7" r="3"/><path d="M2.5 16.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><path d="M14 4.5c1 .8 1.5 1.8 1.5 3s-.5 2.2-1.5 3"/><path d="M16 2.5c1.6 1.3 2.4 3 2.4 5s-.8 3.7-2.4 5"/></svg>',
  speakersOff: '<svg viewBox="0 0 20 20"><circle cx="8" cy="7" r="3"/><path d="M2.5 16.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><path d="M14 6l4 4M18 6l-4 4"/></svg>',
  linkOn: '<svg viewBox="0 0 20 20"><path d="M8.5 11.5l3-3"/><path d="M9.5 6.5l1.2-1.2a3 3 0 0 1 4.2 4.2l-1.2 1.2"/><path d="M10.5 13.5l-1.2 1.2a3 3 0 0 1-4.2-4.2l1.2-1.2"/></svg>',
  linkOff: '<svg viewBox="0 0 20 20"><path d="M9.5 6.5l1.2-1.2a3 3 0 0 1 4.2 4.2l-1.2 1.2"/><path d="M10.5 13.5l-1.2 1.2a3 3 0 0 1-4.2-4.2l1.2-1.2"/><path d="M4 4l2 2M16 16l-2-2"/></svg>',
  // Не озвучено: динамик с крестиком. Только озвучка: динамик со звуком (в Anki – без картинки).
  unvoiced: '<svg viewBox="0 0 20 20"><path d="M3 8v4h3l4 3.5v-11L6 8z"/><path d="M13.5 7.5l4 5M17.5 7.5l-4 5"/></svg>',
  soundOnly: '<svg viewBox="0 0 20 20"><path d="M3 8v4h3l4 3.5v-11L6 8z"/><path d="M13 7.5c.9.7 1.3 1.5 1.3 2.5s-.4 1.8-1.3 2.5"/><path d="M15.2 5.5c1.5 1.2 2.2 2.7 2.2 4.5s-.7 3.3-2.2 4.5"/></svg>',
  play: '<svg viewBox="0 0 20 20"><path d="M6 4l10 6-10 6z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 20 20"><path d="M6.5 4v12M13.5 4v12" stroke-width="3"/></svg>',
  // Остановка на конце отрезка включена / выключена (играть до конца видео).
  segment: '<svg viewBox="0 0 20 20"><path d="M2 10h16"/><rect x="6" y="6" width="8" height="8" rx="1" fill="currentColor"/></svg>',
  fragment: '<svg viewBox="0 0 20 20"><rect x="2" y="6" width="16" height="8" rx="1" fill="currentColor"/></svg>',
  // Автозапуск включён / выключен: треугольник Play с буквой A (выкл. — перечёркнут).
  autoOn: '<svg viewBox="0 0 20 20"><path d="M3.5 4.5l8 5.5-8 5.5z" fill="currentColor"/>' +
    '<path d="M12.5 16.5l2.5-7 2.5 7M13.4 14h3.2" stroke-width="1.4"/></svg>',
  autoOff: '<svg viewBox="0 0 20 20" opacity="0.55"><path d="M3.5 4.5l8 5.5-8 5.5z" fill="currentColor"/>' +
    '<path d="M12.5 16.5l2.5-7 2.5 7M13.4 14h3.2" stroke-width="1.4"/><path d="M2.5 17.5l15-15" stroke="#ff6b6b" stroke-width="1.6"/></svg>',
};

const $ = (id) => document.getElementById(id);

// Приближение видео правой кнопкой (только для текущего фрагмента, не
// сохраняется): вокруг точки появляется рамка в 1.7 раза меньше кадра (у края –
// прижимается к нему), затем рамка вместе с содержимым растягивается на весь
// плеер. Правая кнопка ещё раз – обратно. Остальное в редакторе работает как
// обычно.

const TEXT_BOX_PAD = 50;

// Шаг кнопок запаса ±3 с (совпадает с PADDING_STEP_SECONDS на сервере).
const PADDING_STEP_SECONDS = 3;
