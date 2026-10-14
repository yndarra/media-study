// Анимации и полосы: зебры кнопок (Zebra), «Отмена?» на занятых кнопках
// (CancelFlip), полосы прогресса и их заполнение, появление блоков и строк.

function progressBar(done, total, label, cls = "") {
  const share = total ? Math.min(1, done / total) : 0;
  return `<div class="progress${cls ? ` ${cls}` : ""}" title="${escapeHtml(label)}"><div class="progress-fill" style="width:${(share * 100).toFixed(1)}%"></div>` +
    `<span class="progress-label">${escapeHtml(label)}</span></div>`;
}

// Кнопка следующего шага на карточке: зелёная "Передать в Anki" или розовая
// "Перевести". Пока шаг идёт – кнопка остаётся, текст другой, полосы зебры
// другие; шаг закончился – кнопка уходит, возвращается строка "Место на диске".
//
// Зебра рисуется на canvas (Zebra): ширина полос и скорость плавно
// подтягиваются к целевым при смене вида ("Перевести" ↔ "Выполняется
// перевод…": полосы плавно сужаются и ускоряются, обратно – расширяются и
// замедляются). Состояние – по видео, поэтому перерисовка списка (каждые 3 с)
// не сбрасывает ни фазу, ни ширину.
const Zebra = {
  // stripe – ширина цветной полосы (= промежутка), px; speed – px/с.
  PARAMS: {
    send: { stripe: 26, speed: 32.5, color: "#1f6b3b" },
    sendBusy: { stripe: 15, speed: 73.125, color: "#1f6b3b" }, // как translateBusy
    // В окне видео: "Передать в Anki", когда отредактировано всё, и "Перевести",
    // когда всё в Anki, – как "Редактировать" (чуть быстрее карточных), свой цвет.
    sendReady: { stripe: 161.5, speed: 48.75, color: "#1f6b3b" },
    translateReady: { stripe: 161.5, speed: 48.75, color: "#a3407a" },
    // Перенос на другой диск – быстрая светло-серая.
    moveBusy: { stripe: 15, speed: 73.125, color: "#5c5c69" },
    translate: { stripe: 323, speed: 32.5, color: "#a3407a" },
    translateBusy: { stripe: 15, speed: 73.125, color: "#a3407a" },
    // "Править" (есть что править) и "Обработать" – синяя; только вернувшиеся
    // из Anki – фиолетовая.
    // "Править" и "Обработать": вдвое уже "Перевести" и в 1.5 раза быстрее.
    edit: { stripe: 161.5, speed: 48.75, color: "#2f5f9e" },
    editReturned: { stripe: 161.5, speed: 48.75, color: "#8957e5" },
    process: { stripe: 161.5, speed: 48.75, color: "#2f5f9e" },
  },
  SLANT: 0.406, // как у "/": по горизонтали на 1 по вертикали
  // Кнопки окна ("Редактировать", "Передать в Anki", "Перевести", "Обработать"):
  // ширина и скорость полос – пропорционально ширине кнопки. Эталон –
  // "Редактировать" (117 px) с её скоростью: кнопка шире – полосы шире и
  // быстрее, уже – уже и медленнее, так что все кнопки заполняются за одно
  // и то же время и идут в такт.
  SCALED: ["edit", "editReturned", "process", "sendReady", "translateReady"],
  REF_WIDTH: 117,

  // Вид полос кнопки с поправкой на её ширину.
  targetFor(button, type) {
    const base = this.PARAMS[type];
    if (!base || !this.SCALED.includes(type) || !button.offsetWidth) return base;
    const k = button.offsetWidth / this.REF_WIDTH;
    return { stripe: base.stripe * k, speed: base.speed * k, color: base.color };
  },
  EASE_SECONDS: 1.1, // за сколько примерно доходит до новой ширины/скорости
  state: new Map(), // видео + вид кнопки -> {stripe, speed, cycles, last}
  running: false,

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame((t) => this.frame(t));
  },

  // Начать круг заново с серой фазы: левая полоса кончается ровно у левого
  // края кнопки (offset = период − ширина полосы) и стоит там hold мс (кнопка
  // сначала просто серая), потом начинает выдвигаться сбоку.
  GRAY_HOLD_MS: 1000,
  restartGray(button, hold = this.GRAY_HOLD_MS) {
    const type = button.dataset.zebra;
    const target = this.targetFor(button, type);
    if (!target) return;
    const key = `${button.dataset.id || button.id}:${type.replace(/Busy|Ready/, "")}`;
    const period = 2 * target.stripe;
    const now = performance.now();
    this.state.set(key, { stripe: target.stripe, speed: target.speed, cycles: (period - target.stripe) / period, last: now, holdUntil: now + hold });
  },

  // Нарисовать сразу (новая кнопка / перерисованное окно): иначе первый кадр
  // кнопка без полос – серая, и только потом полосы "заполняют" её.
  paintNow() {
    this.frame(performance.now(), true);
    this.start();
  },

  frame(now, once = false) {
    const buttons = document.querySelectorAll(".card-action, [data-zebra]");
    if (!buttons.length) {
      if (!once) this.running = false;
      return;
    }
    for (const button of buttons) {
      // Вид полос: кнопки шага на карточках – по классам; остальные – data-zebra.
      const type = button.dataset.zebra ||
        (button.classList.contains("translate") ? "translate" : button.classList.contains("move") ? "move" : "send");
      const target = this.targetFor(button, button.dataset.zebra || type + (button.classList.contains("busy") ? "Busy" : ""));
      if (!target) continue;
      // Ключ – без Busy/Ready: смена вида кнопки плавно меняет ширину и скорость полос.
      const key = `${button.dataset.id || button.id}:${type.replace(/Busy|Ready/, "")}`;
      let st = this.state.get(key);
      if (!st) {
        st = { stripe: target.stripe, speed: target.speed, cycles: 0, last: now };
        this.state.set(key, st);
      }
      const dt = Math.min(0.1, Math.max(0, (now - st.last) / 1000));
      st.last = now;
      // Ширина – плавно в логарифме (от 323 до 15 – в 20 раз), скорость – линейно.
      const k = 1 - Math.exp(-dt / (this.EASE_SECONDS / 3));
      st.stripe = Math.exp(Math.log(st.stripe) + (Math.log(target.stripe) - Math.log(st.stripe)) * k);
      st.speed += (target.speed - st.speed) * k;
      // Фаза – в долях шага: при смене ширины полосы растягиваются, а не прыгают.
      // Пока идёт серая пауза (restartGray) – полосы стоят.
      if (!(st.holdUntil > now)) st.cycles = (st.cycles + (st.speed * dt) / (2 * st.stripe)) % 1;
      this.draw(button, st, target.color);
    }
    if (!once) requestAnimationFrame((t) => this.frame(t));
  },

  draw(button, st, color) {
    const canvas = button.querySelector("canvas.zebra");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    // Точный (дробный) размер холста: иначе картинка чуть растягивается по
    // ширине, и полосы у кнопок разной ширины выглядят по-разному.
    const box = canvas.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    const period = 2 * st.stripe;
    const slant = this.SLANT * h;
    const offset = st.cycles * period;
    const stripes = new Path2D();
    for (let x = offset - period - slant; x < w + period; x += period) {
      stripes.moveTo(x + slant, 0);
      stripes.lineTo(x + slant + st.stripe, 0);
      stripes.lineTo(x + st.stripe, h);
      stripes.lineTo(x, h);
      stripes.closePath();
    }
    ctx.fill(stripes);
    // Кнопки окна: холст лежит поверх рамки кнопки, поэтому обводка рисуется
    // здесь же и идёт вместе с полосами – над серым серая (как у обычной
    // кнопки), над цветной полосой – светлее её цвета.
    if (!button.classList.contains("zebra-host")) return;
    if (button.__zebraRadius === undefined) button.__zebraRadius = parseFloat(getComputedStyle(button).borderTopLeftRadius) || 0;
    const ring = new Path2D();
    ring.roundRect(0.5, 0.5, w - 1, h - 1, Math.max(0, button.__zebraRadius - 0.5));
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.EDGE_GRAY;
    ctx.stroke(ring);
    ctx.save();
    ctx.clip(stripes);
    ctx.strokeStyle = this.edgeColor(color);
    ctx.stroke(ring);
    ctx.restore();
  },

  EDGE_GRAY: "#45454e", // рамка обычной кнопки
  _edges: new Map(),

  // Цвет обводки над цветной полосой: тот же цвет, на треть ближе к белому.
  edgeColor(color) {
    let edge = this._edges.get(color);
    if (!edge) {
      const n = parseInt(color.slice(1), 16);
      const mix = (c) => Math.round(c + (255 - c) * 0.33);
      edge = `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
      this._edges.set(color, edge);
    }
    return edge;
  },
};

// Текст занятой кнопки на карточке ("Передаётся в Anki…", "Выполняется
// перевод…", "Перемещение…"): эти кнопки ещё и отменяют действие, и чтобы это
// было понятно, по кругу текст посимвольно стирается (с конца), печатается
// "Отмена?", держится, стирается и снова печатается основной. Каждая буква
// при печати вырастает снизу ("из-под земли"), при стирании – уходит вниз
// (CSS-переход у каждой буквы, класс on).
//
// Круг ОБЩИЙ для всех таких кнопок: фаза – от одних часов, длительности
// стирания/печати не зависят от длины текста, поэтому "Отмена?" появляется и
// исчезает у всех кнопок одновременно; новая кнопка сразу в текущей фазе.
const CancelFlip = {
  CANCEL: "Отмена?",
  // [фаза, длительность, мс]
  PHASES: [["holdMain", 3200], ["eraseMain", 650], ["typeCancel", 520], ["holdCancel", 1600], ["eraseCancel", 420], ["typeMain", 750]],

  start() {
    const frame = () => {
      const now = performance.now();
      for (const flip of document.querySelectorAll(".flip")) {
        const main = flip.querySelectorAll(".flip-main .ch");
        const cancel = flip.querySelectorAll(".flip-cancel .ch");
        const [m, c] = this.counts(main.length, cancel.length, now);
        main.forEach((ch, i) => ch.classList.toggle("on", i < m));
        cancel.forEach((ch, i) => ch.classList.toggle("on", i < c));
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  },

  // Сколько букв основного текста (из nMain) и "Отмена?" (из nCancel) видно сейчас.
  counts(nMain, nCancel, now) {
    const cycle = this.PHASES.reduce((sum, [, d]) => sum + d, 0);
    let t = now % cycle;
    let phase = "holdMain";
    let k = 0; // доля пройденной фазы, 0..1
    for (const [name, d] of this.PHASES) {
      if (t < d) {
        phase = name;
        k = t / d;
        break;
      }
      t -= d;
    }
    const shown = (n) => Math.max(0, Math.min(n, Math.ceil(n * k)));
    return {
      holdMain: [nMain, 0],
      eraseMain: [nMain - shown(nMain), 0],
      typeCancel: [0, shown(nCancel)],
      holdCancel: [0, nCancel],
      eraseCancel: [0, nCancel - shown(nCancel)],
      typeMain: [shown(nMain), 0],
    }[phase];
  },

  // Разметка: основной и "Отмена?" в одной ячейке (ширина – по длинному), каждая
  // буква – отдельно. Сразу в текущей фазе: список карточек перерисовывается
  // каждые несколько секунд, и буквы не должны при этом "вырастать" заново.
  html(main) {
    const [m, c] = this.counts([...main].length, [...this.CANCEL].length, performance.now());
    const chars = (text, on) => [...text].map((ch, i) => `<span class="ch${i < on ? " on" : ""}">${escapeHtml(ch)}</span>`).join("");
    return `<span class="flip"><span class="flip-main">${chars(main, m)}</span><span class="flip-cancel">${chars(this.CANCEL, c)}</span></span>`;
  },
};

CancelFlip.start();

function cardAction(v) {
  const pressed = Pages.pressedActions.get(v.id);
  const just = pressed && Date.now() - pressed.at < 8000 ? pressed.action : null; // нажали, сервер ещё не успел
  const id = escapeHtml(v.id);
  // Идущие действия – нажатие отменяет (текст сам подсказывает: "… ↔ Отмена?").
  if (v.moving || just === "move") {
    return `<button class="card-action move busy" data-action="cancel-move" data-id="${id}" title="Отменить перенос"><canvas class="zebra"></canvas>${CancelFlip.html("Перемещение…")}</button>`;
  }
  if (v.sending || just === "send") {
    return `<button class="card-action send busy" data-action="cancel-send" data-id="${id}" title="Отменить передачу в Anki"><canvas class="zebra"></canvas>${CancelFlip.html("Передаётся в Anki…")}</button>`;
  }
  if (v.translating || just === "translate") {
    return `<button class="card-action translate busy" data-action="stop" data-id="${id}" title="Отменить перевод"><canvas class="zebra"></canvas>${CancelFlip.html("Выполняется перевод…")}</button>`;
  }
  if (v.ready_to_send) {
    return `<button class="card-action send" data-action="send" data-id="${id}"><canvas class="zebra"></canvas><span>Передать в Anki</span></button>`;
  }
  if (v.ready_to_translate) {
    return `<button class="card-action translate" data-action="translate" data-id="${id}"><canvas class="zebra"></canvas><span>Перевести</span></button>`;
  }
  return "";
}

// Полоса из цветных отрезков: segments = [{n, cls}] – слева направо; последний
// отрезок с right: true прижимается к правому краю (между ними – серое).
// name – подпись слева, done / total – справа. Стыки цветов – под наклоном
// (классы sl / sr: скошенный левый / правый край, см. css/library.css).
// Ширины и число плавно анимируются – см. animateBars.
function segmentBar(segments, total, name, done, rightText = "") {
  const pct = (n) => (total ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);
  const left = segments.filter((s) => !s.right && s.n > 0);
  const right = segments.filter((s) => s.right && s.n > 0);
  const leftEnd = left.reduce((sum, s) => sum + pct(s.n), 0);
  const html = (s, k, list, side) => {
    const w = pct(s.n);
    // Каждый отрезок – параллелограмм: соседи стыкуются ровно по одной
    // наклонной линии (вертикальных концов нет нигде, и узкий отрезок не
    // показывает под собой конец предыдущего). Не скошены только края
    // полосы: левый край первого отрезка и правый – у дошедшего до 100%.
    const sl = side === "right" || k > 0;
    const sr = side === "left" ? !(k === list.length - 1 && leftEnd >= 99.9) : k < list.length - 1;
    return `<div class="seg ${s.cls}${sl ? " sl" : ""}${sr ? " sr" : ""}" data-w="${w.toFixed(2)}" ` +
      `style="width:${segWidth(w, sl)}" title="${escapeHtml(s.title || "")}"></div>`;
  };
  return `<div class="progress segmented" data-bar="${done === null ? "progress" : escapeHtml(name)}" title="${escapeHtml(done === null ? name : `${name} ${done} / ${total}`)}">` +
    `<div class="seg-left">${left.map((s, k) => html(s, k, left, "left")).join("")}</div>` +
    `<div class="seg-right">${right.map((s, k) => html(s, k, right, "right")).join("")}</div>` +
    `<span class="progress-label"><span>${escapeHtml(name)}</span>` +
    (done === null ? (rightText ? `<span class="progress-count">${escapeHtml(rightText)}</span>` : "")
      : `<span class="progress-count" data-done="${done}" data-total="${total || 0}">${done} / ${total || 0}</span>`) +
    "</span></div>";
}

// Ширина отрезка: со скосом слева он заходит на 6 px под предыдущий.
function segWidth(w, slanted) {
  return slanted && w > 0 ? `calc(${w}% + var(--slant))` : `${w}%`;
}

// Снимок полос перед перерисовкой: ширины отрезков и числа – чтобы новые
// значения не прыгали, а плавно доезжали от старых.
// live – брать ширину, которая СЕЙЧАС на экране (полоса может ещё ехать):
// перерисовка посреди анимации продолжает её с того же места, а не с нуля.
function barSnapshot(root, live = false) {
  const snap = new Map();
  if (!root) return snap;
  root.querySelectorAll("[data-bar]").forEach((bar) => {
    const key = barKey(bar);
    const full = bar.getBoundingClientRect().width;
    bar.querySelectorAll(".seg").forEach((seg) => snap.set(`${key}|${seg.classList[1]}`,
      live && full && (seg.getAnimations().length || seg.parentElement.getAnimations().length)
        ? (seg.getBoundingClientRect().width / full) * 100 : parseFloat(seg.dataset.w) || 0));
    const count = bar.querySelector(".progress-count");
    if (count) snap.set(`${key}|#`, parseFloat(count.dataset.shown ?? count.dataset.done) || 0);
  });
  return snap;
}

function barKey(bar) {
  const owner = bar.closest("[data-key]") || bar.closest("a.card");
  return `${owner ? owner.dataset.key || owner.getAttribute("href") : ""}|${bar.dataset.bar}`;
}

// Плавно довести полосы внутри root от снимка (или от нуля – при первом
// показе раздела) до их настоящих значений; числа считают вверх/вниз так же.
// Заполнение от нуля (первый показ) – растяжением всей полосы (transform):
// его рисует видеокарта отдельно от страницы, и оно не подлагивает, пока
// страница строится (окно подробностей, свежие данные). Изменение уже
// показанных значений – шириной отрезков, как раньше.
function animateBars(root, snap = new Map()) {
  if (!root) return;
  const segs = [];
  root.querySelectorAll("[data-bar]").forEach((bar) => {
    const key = barKey(bar);
    const all = [...bar.querySelectorAll(".seg")];
    const fromZero = all.length && all.every((seg) => !(snap.get(`${key}|${seg.classList[1]}`) > 0));
    const holder = all.length && all[0].parentElement;
    if (fromZero && holder && all.every((seg) => seg.parentElement === holder)) {
      holder.style.transformOrigin = "0 50%";
      holder.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: BAR_ANIMATION_MS, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" });
      const count = bar.querySelector(".progress-count");
      if (count) countUp(count, 0, parseFloat(count.dataset.done) || 0);
      return;
    }
    all.forEach((seg) => {
      const from = snap.get(`${key}|${seg.classList[1]}`) ?? 0;
      const to = parseFloat(seg.dataset.w) || 0;
      if (Math.abs(from - to) < 0.01) return;
      const slanted = seg.classList.contains("sl");
      seg.style.transition = "none";
      seg.style.width = segWidth(from, slanted);
      segs.push([seg, to, slanted]);
    });
    const count = bar.querySelector(".progress-count");
    if (count) countUp(count, snap.get(`${key}|#`) ?? 0, parseFloat(count.dataset.done) || 0);
  });
  if (!segs.length) return;
  root.getBoundingClientRect(); // применить стартовые ширины до включения анимации
  requestAnimationFrame(() => segs.forEach(([seg, to, slanted]) => {
    seg.style.transition = "";
    seg.style.width = segWidth(to, slanted);
  }));
}

// Число "N / K" в полосе: плавно от from до to (за то же время, что и полоса).
function countUp(el, from, to) {
  const total = el.dataset.total;
  if (from === to) return;
  const start = performance.now();
  const step = (now) => {
    if (!el.isConnected) return;
    const t = Math.min(1, (now - start) / BAR_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (to - from) * eased);
    el.dataset.shown = value;
    el.textContent = `${value} / ${total}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const BAR_ANIMATION_MS = 900;

// Окно подробностей открывается с уже известными данными; свежие – после
// того, как отыграло появление (полосы, текст), чтобы не перерисовывать
// посреди анимации (двойное заполнение полос и т.п.).
const MODAL_SETTLE_MS = 1600;

// Раздел открыли: заголовок, описание и остальное содержимое страницы
// появляются по очереди (так же, как карточки).
function viewEnter(el, items = null) {
  // Раздел показан заново – весь его текст появляется посимвольно, даже если
  // он такой же, как в прошлый раз (иначе TextFx сверял новый текст со старым
  // из скрытого раздела и описание "через раз" появлялось без анимации).
  TextFx.fresh(el);
  (items || [...el.children]).forEach((child, i) => {
    child.style.setProperty("--i", i);
    child.classList.add("enter");
    const done = (e) => {
      if (e.target !== child) return; // анимация вложенного (буквы, полосы) – не наша
      child.classList.remove("enter");
      child.removeEventListener("animationend", done);
    };
    child.addEventListener("animationend", done);
  });
}

// Карточку только что сохранённого видео коротко подсветить (окно закрылось).
function flashCard(box) {
  if (!Pages.flashId) return;
  const card = [...box.querySelectorAll("a.card")].find((a) => a.getAttribute("href").endsWith(`/${encodeURIComponent(Pages.flashId)}`));
  Pages.flashId = null;
  if (card) card.animate([
    { boxShadow: "0 0 0 2px rgba(121, 184, 255, 0.75)", transform: "scale(1.015)" },
    { boxShadow: "0 0 0 2px rgba(121, 184, 255, 0)", transform: "none" },
  ], { duration: 700, easing: "ease-out" });
}

// Раздел открыли: карточки появляются по очереди (лёгкий подъём и проявление).
// elapsed – сколько мс появление уже идёт (перерисовка посреди него: новые
// карточки продолжают ту же анимацию с того же места, а не встают рывком).
function cardsEnter(box, elapsed = 0) {
  if (!elapsed) box.__enterAt = performance.now();
  box.querySelectorAll("a.card, .group-title").forEach((el, i) => {
    el.style.setProperty("--i", Math.min(i, 60));
    if (elapsed) el.style.animationDelay = `calc(var(--i) * var(--enter-step) - ${Math.round(elapsed)}ms)`;
    el.classList.add("enter");
    const done = (e) => {
      if (e.target !== el) return; // анимация вложенного (буквы, полосы) – не наша
      el.classList.remove("enter");
      el.style.animationDelay = "";
      el.removeEventListener("animationend", done);
    };
    el.addEventListener("animationend", done);
  });
}

const CARDS_ENTER_MS = 60 * 70 + 600; // последняя карточка (--i = 60) + длительность

// Перерисовать список без мигания: полосы доезжают от прежних значений
// (first – первый показ раздела: заполняются от нуля).
// Полосы – от ширины, которая сейчас на экране (могли ещё заполняться);
// карточки, которые ещё появлялись, – продолжают появляться.
function renderSmooth(box, html, first = false) {
  // Ничего не поменялось – не перестраивать (перестройка – лишняя работа и
  // риск сдвига букв на долю пикселя).
  if (!first && box.__html === html && box.isConnected) return;
  box.__html = html;
  const snap = first ? new Map() : barSnapshot(box, true);
  box.innerHTML = html;
  animateBars(box, snap);
  if (typeof Zebra !== "undefined") Zebra.paintNow();
  const elapsed = box.__enterAt ? performance.now() - box.__enterAt : Infinity;
  if (!first && elapsed < CARDS_ENTER_MS) cardsEnter(box, elapsed);
}

// Две полосы видео.
// "Отредактировано" (слева направо, до скрытой метки – последнего
//   изменённого фрагмента): синее – просмотрено и принято без правок;
//   жёлтое – изменено; красное – удалено; серое – ещё не тронуто.
// "Передано в Anki" – живые фрагменты на этапе 3; справа фиолетовые —
//   карточки с флагом "обрезка/текст" (оранжевый, красный).
function videoBars(v) {
  const e = v.edit_bar || { accepted: 0, changed: 0, deleted: 0 };
  const edited = e.accepted + (e.unvoiced || 0) + e.changed + e.deleted;
  const total = v.bar_total || v.fragments_total;
  return segmentBar([
    { n: e.accepted, cls: "accepted", title: `Приняты без правок: ${e.accepted}` },
    // Не озвученные – вместе с изменёнными (жёлтым).
    { n: e.changed + (e.unvoiced || 0), cls: "changed", title: `Изменены: ${e.changed + (e.unvoiced || 0)}` },
    { n: e.deleted, cls: "deleted", title: `удалены: ${e.deleted}` },
  ], total, "Отредактировано", edited) +
  (() => {
    // Только то, что уже стало карточкой (очередь не показывается – полоса
    // растёт по мере создания карточек).
    const inAnki = v.in_anki ?? v.exported;
    return segmentBar([
      { n: inAnki - (v.flag_interval || 0), cls: "ok", title: `В Anki: ${inAnki}` },
      { n: v.flag_interval || 0, cls: "returned", right: true, title: `Флаг «обрезка/текст» в Anki: ${v.flag_interval || 0}` },
    ], v.active_total, "Передано в Anki", inAnki);
  })() +
  // Переведено: в Anki (оборот заполнен) + переведённые заранее, ждущие передачи в Anki;
  // из всех фрагментов с текстом.
  (() => {
    const done = (v.translated || 0) + (v.translated_waiting || 0);
    return segmentBar([
      { n: done, cls: "translated", title: `Переведено: ${done}` + (v.translated_waiting ? `, из них ждут передачи в Anki: ${v.translated_waiting}` : "") },
    ], v.cards_total, "Переведено", done);
  })();
}

// Значения таблиц, которые не влезли в одну строку (длинная колода Anki и
// т.п.), – тоже сворачиваются: видна одна строка с многоточием и стрелка ▾.
// Вызывается, когда окно уже на экране (нужны настоящие размеры).
function foldLongRows(root) {
  root.querySelectorAll("table.stats tr:not(.multi) > td:last-child").forEach((td) => {
    const line = parseFloat(getComputedStyle(td).lineHeight) || 20;
    if (td.querySelector(".one-line") || td.clientHeight - 8 < line * 1.5) return;
    // Буквы ещё растут – закончить, иначе в свёрнутую строку скопируются
    // недорисованные (она анимируется заново – уже свёрнутой).
    td.querySelectorAll("[data-fx], [data-fxdone]").forEach((el) => TextFx.finish(el));
    TextFx.finish(td);
    td.innerHTML = `<div class="multi-first one-line"><span class="one-line-text">${td.innerHTML}</span>` +
      '<button class="multi-toggle" title="Показать целиком">▾</button></div>';
    td.parentElement.classList.add("multi");
  });
}

// Окно только что открыли: разделитель под каждой строкой таблицы
// проявляется тогда же, когда начинает появляться текст этой строки (сверху
// вниз, см. TextFx.startDelay), а не весь сразу вместе с окном.
function rowLinesEnter(root) {
  root.querySelectorAll("table.stats tr").forEach((tr) => {
    const cell = tr.firstElementChild;
    if (!cell) return;
    const delay = Math.round(TextFx.startDelay(cell));
    tr.style.setProperty("--row-delay", `${delay}ms`);
    tr.classList.add("row-in");
    setTimeout(() => tr.classList.remove("row-in"), delay + 900);
  });
}

// Раскрыть / свернуть многострочное значение (плавно, по высоте содержимого).
document.addEventListener("click", (e) => {
  const button = e.target.closest(".multi-toggle");
  if (!button) return;
  const single = button.closest(".one-line");
  if (single) {
    // Свёрнутая в одну строку: плавно до полной высоты и обратно.
    const text = single.querySelector(".one-line-text");
    // Текст после побуквенного появления остаётся обрезанным ("…") и в одну
    // строку (TextFx) – вернуть его целиком, иначе раскрывать нечего.
    text.querySelectorAll("[data-fx], [data-fxdone]").forEach((el) => TextFx.finish(el));
    TextFx.finish(text);
    const from = text.offsetHeight;
    const open = single.classList.toggle("open");
    button.classList.toggle("open", open);
    const to = text.offsetHeight;
    text.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 250, easing: "ease" });
    return;
  }
  const rest = button.closest("td").querySelector(".multi-rest");
  const open = !rest.classList.contains("open");
  rest.style.maxHeight = open ? `${rest.scrollHeight}px` : "0px";
  rest.classList.toggle("open", open);
  button.classList.toggle("open", open);
});

// Ход этапа 1: шаг и процент (если шаг умеет его считать).
// Полоса хода обработки – как полосы в "Видео" (наклонный край, плавный рост),
// без чисел: скачивание – рыжая, остальные шаги – синие.
function processingBar(v) {
  if (v.percent === null || v.percent === undefined) {
    return `<div class="card-status">${escapeHtml(cap(v.status || "Обрабатывается"))}…</div>`;
  }
  const cls = v.step === "download" ? "downloading" : "accepted";
  return segmentBar([{ n: v.percent, cls, title: `${Math.floor(v.percent)}%` }], 100, cap(v.status), null, `${Math.floor(v.percent)}%`);
}
