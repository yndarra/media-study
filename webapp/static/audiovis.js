// Аудио в редакторе: вместо картинки (у аудио её нет – копия для редактора
// идёт с чёрным кадром) – холст поверх плеера в духе современных
// "живых обоев", реагирующих на звук. Стилей несколько, переключаются
// кнопкой в правом верхнем углу плеера (выбор запоминается в браузере):
//
//   «Кольца» – почти чёрный фон с зерном и виньетированием, посередине
//     светящиеся "жидкие" кольца (замкнутые кривые из нескольких гармоник,
//     изгиб – от громкости; каждое следующее кольцо берёт громкость чуть
//     более ранних кадров – эхо расходится от центра), мягкое ядро, искры;
//
//   «Хребты» – по мотивам обложки Joy Division "Unknown Pleasures"
//     (пульсар CP 1919): десятки горизонтальных линий друг над другом,
//     каждая – громкость отрезка трека; нижняя – "сейчас", чем выше, тем
//     раньше по времени, поэтому рельеф уплывает вверх. Линии перекрывают
//     друг друга (под каждой – заливка фоном), цвет – розовый -> голубой;
//
//   «Сфера» – трёхмерное облако точек (равномерно по сфере, спираль
//     Фибоначчи), медленно вращается; громкость раздувает сферу, причём
//     волна идёт от полюса к полюсу (у каждой широты своя задержка в
//     кадрах), дальние точки тусклее и мельче – перспектива;
//
//   «Ленты» – несколько полупрозрачных светящихся лент поперёк плеера
//     (как волна голосовых ассистентов): высота ленты в каждой точке – от
//     громкости с запаздыванием, ленты складываются по яркости.
//
// Всё считается от ТЕКУЩЕГО КАДРА (волна waveform.bin – громкость по кадрам,
// её же рисует дорожка), поэтому при воспроизведении движется со звуком, а
// на паузе застывает ровно таким, каким был этот кадр.
const AudioVisual = {
  canvas: null,
  active: false,
  RINGS: 6,
  SPARKS: 140,
  // Цвета колец: розовый -> фиолетовый -> голубой (оттенок HSL).
  HUES: [328, 305, 282, 262, 236, 205],
  STYLES: [
    { id: "rings", label: "Кольца" },
    { id: "ridges", label: "Хребты" },
    { id: "sphere", label: "Сфера" },
    { id: "ribbons", label: "Ленты" },
  ],
  style: "rings",

  enable(on) {
    const wrap = document.getElementById("video-wrap");
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "audio-vis";
      wrap.appendChild(this.canvas);
      // Переключатель стиля – маленькая кнопка поверх плеера.
      try {
        const saved = localStorage.getItem("audio-vis-style");
        if (this.STYLES.some((s) => s.id === saved)) this.style = saved;
      } catch (_) { /* хранилище недоступно – стиль по умолчанию */ }
      this.button = document.createElement("button");
      this.button.id = "audio-vis-style";
      this.button.title = "Стиль визуализации";
      this.button.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = this.STYLES.findIndex((s) => s.id === this.style);
        this.style = this.STYLES[(i + 1) % this.STYLES.length].id;
        try { localStorage.setItem("audio-vis-style", this.style); } catch (_) { /* не важно */ }
        this.updateButton();
        this.button.blur(); // пробел и прочие клавиши – снова редактору
      });
      wrap.appendChild(this.button);
      this.updateButton();
    }
    wrap.classList.toggle("audio-mode", on);
    if (on && !this.active) {
      this.active = true;
      requestAnimationFrame((t) => this.frame(t));
    }
    if (!on) this.active = false;
  },

  updateButton() {
    const s = this.STYLES.find((x) => x.id === this.style);
    this.button.textContent = s ? s.label : "";
  },

  // Громкость кадра 0..1 (по волне, сглаженная по соседним кадрам).
  level(frame) {
    const wave = Timeline.waveform;
    if (!wave || !wave.length) return 0;
    let sum = 0;
    let n = 0;
    for (let k = frame - 3; k <= frame + 1; k++) {
      if (k >= 0 && k < wave.length) {
        sum += wave[k];
        n++;
      }
    }
    return n ? sum / n / 255 : 0;
  },

  // Громкость в дробном кадре: между соседними кадрами – линейно.
  levelAt(f) {
    const a = Math.floor(f);
    const k = f - a;
    return this.level(a) * (1 - k) + this.level(a + 1) * k;
  },

  // Громкость одного кадра без сглаживания (для хребтов – там нужны детали).
  raw(frame) {
    const wave = Timeline.waveform;
    if (!wave || frame < 0 || frame >= wave.length) return 0;
    return wave[frame] / 255;
  },

  // Зерно фона – один раз (повторяющийся узор), чтобы не было "ровного" чёрного.
  grain() {
    if (this._grain) return this._grain;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 10;
    }
    g.putImageData(img, 0, 0);
    this._grain = c;
    return c;
  },

  // Псевдослучайное по номеру (одинаковое на каждом кадре – искры не "дрожат").
  rand(i) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  },

  // Общий фон: почти чёрный, виньетирование (ярче на громком), зерно.
  background(ctx, w, h, energy, tint = "40, 24, 60") {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#050508";
    ctx.fillRect(0, 0, w, h);
    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.1, w / 2, h / 2, Math.max(w, h) * 0.75);
    vignette.addColorStop(0, `rgba(${tint}, ${0.25 + 0.25 * energy})`);
    vignette.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ctx.createPattern(this.grain(), "repeat");
    ctx.fillRect(0, 0, w, h);
  },

  frame() {
    if (!this.active) return;
    requestAnimationFrame((t) => this.frame(t));
    if (State.view !== "editor" || !State.manifest) return;
    const canvas = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame = State.currentFrame || 0;
    const rate = State.manifest.video.fps || 30;
    const k = { ctx, w, h, frame, rate, t: frame / rate }; // t – время трека, на паузе стоит
    if (this.style === "ridges") this.drawRidges(k);
    else if (this.style === "sphere") this.drawSphere(k);
    else if (this.style === "ribbons") this.drawRibbons(k);
    else this.drawRings(k);
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
  },

  // ---------------------------------------------------------------- «Кольца»
  drawRings({ ctx, w, h, frame, rate, t }) {
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.2;
    const level = this.level(frame);
    const energy = Math.pow(level, 1.3);
    this.background(ctx, w, h, energy);
    ctx.globalCompositeOperation = "lighter";

    // -- искры: летят из центра наружу, каждая по своему лучу -------------------
    for (let i = 0; i < this.SPARKS; i++) {
      const angle = this.rand(i) * Math.PI * 2 + t * 0.05;
      const speed = 0.12 + this.rand(i + 1000) * 0.35;
      const phase = (t * speed + this.rand(i + 2000)) % 1; // 0 – у колец, 1 – у края
      const born = Math.max(0, Math.round(frame - phase / speed * rate));
      const loud = this.level(born); // громкость, когда искра "родилась"
      const r = base * (1.05 + phase * 2.4);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r * 0.92;
      const alpha = (1 - phase) * (0.15 + 0.85 * loud);
      if (alpha < 0.03) continue;
      ctx.fillStyle = `hsla(${this.HUES[i % this.HUES.length]}, 90%, 72%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + 2.2 * loud * (1 - phase), 0, Math.PI * 2);
      ctx.fill();
    }

    // -- ядро ---------------------------------------------------------------------
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * (0.85 + 0.25 * energy));
    core.addColorStop(0, `rgba(255, 220, 245, ${0.18 + 0.45 * energy})`);
    core.addColorStop(0.35, `rgba(190, 90, 220, ${0.10 + 0.25 * energy})`);
    core.addColorStop(1, "rgba(60, 30, 120, 0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, base * 1.2, 0, Math.PI * 2);
    ctx.fill();

    // -- "жидкие" кольца: эхо громкости по кадрам ---------------------------------
    const N = 160;
    for (let ring = 0; ring < this.RINGS; ring++) {
      const lv = Math.pow(this.level(frame - ring * 4), 1.2); // каждое – чуть позже
      const radius = base * (0.62 + ring * 0.075) * (1 + 0.18 * lv);
      const amp = base * (0.015 + 0.16 * lv);
      const spin = t * (0.12 + ring * 0.025) * (ring % 2 ? -1 : 1);
      ctx.beginPath();
      for (let n = 0; n <= N; n++) {
        const a = (n / N) * Math.PI * 2;
        // Несколько гармоник с медленно плывущими фазами – "жидкая" форма.
        const d = Math.sin(3 * a + spin * 2 + ring) * 0.55
          + Math.sin(5 * a - spin * 3 + ring * 1.7) * 0.3
          + Math.sin(8 * a + spin * 5 + ring * 0.6) * 0.15 * lv;
        const r = radius + amp * d;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (n === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const hue = this.HUES[ring];
      ctx.strokeStyle = `hsla(${hue}, 95%, ${62 + 18 * lv}%, ${0.35 + 0.55 * lv})`;
      ctx.lineWidth = 1.4 + 2.2 * lv;
      ctx.shadowColor = `hsla(${hue}, 100%, 65%, 0.9)`;
      ctx.shadowBlur = 10 + 26 * lv;
      ctx.stroke();
    }
  },

  // ---------------------------------------------------------------- «Хребты»
  drawRidges({ ctx, w, h, frame }) {
    const LINES = 44;
    const POINTS = 120;
    const STEP = 3; // кадров между соседними линиями – скорость "уплывания" вверх
    const SPAN = 90; // кадров трека на одну линию (ширина окна по времени)
    const energy = Math.pow(this.level(frame), 1.3);
    this.background(ctx, w, h, energy * 0.6, "30, 20, 50");
    const left = w * 0.22;
    const width = w * 0.56;
    const top = h * 0.16;
    const gap = (h * 0.7) / LINES;
    const peak = gap * 9; // высота пика при полной громкости
    // Рисуем сверху вниз: нижние (более новые) линии заливкой фона закрывают
    // верхние – как на обложке, где горы заслоняют дальние хребты.
    for (let line = LINES - 1; line >= 0; line--) {
      const y0 = top + (LINES - 1 - line) * gap + gap;
      const start = frame - line * STEP - SPAN; // окно линии кончается "её" моментом
      const fade = 1 - line / LINES; // дальние – тусклее
      ctx.beginPath();
      const pts = [];
      for (let p = 0; p <= POINTS; p++) {
        const u = p / POINTS;
        // Огибающая: края спокойные, середина "горная" (как у пульсара).
        const env = Math.pow(Math.sin(Math.PI * u), 3);
        const f = start + u * SPAN;
        // Громкость (плавно) + мелкая "шероховатость" (детерминированная по кадру).
        const lv = this.levelAt(f);
        const v = lv * 0.9 + this.rand(Math.round(f) * 7 + line) * 0.1 * lv;
        pts.push([left + u * width, y0 - peak * env * Math.pow(v, 1.4) - gap * 0.08 * this.rand(p + line * 131) * env]);
      }
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      // Заливка фоном под линией – перекрытие дальних хребтов.
      ctx.lineTo(left + width, y0 + gap * 2);
      ctx.lineTo(left, y0 + gap * 2);
      ctx.closePath();
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#050508";
      ctx.fill();
      // Сама линия – градиент поперёк: розовый -> фиолетовый -> голубой.
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      const grad = ctx.createLinearGradient(left, 0, left + width, 0);
      grad.addColorStop(0, `hsla(328, 90%, 70%, ${0.15 + 0.75 * fade})`);
      grad.addColorStop(0.5, `hsla(275, 90%, 78%, ${0.25 + 0.75 * fade})`);
      grad.addColorStop(1, `hsla(205, 90%, 70%, ${0.15 + 0.75 * fade})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = line === 0 ? 1.8 : 1.1;
      ctx.shadowColor = "hsla(280, 100%, 70%, 0.8)";
      ctx.shadowBlur = line < 3 ? 8 + 14 * energy : 0;
      ctx.stroke();
    }
  },

  // ---------------------------------------------------------------- «Сфера»
  drawSphere({ ctx, w, h, frame, t }) {
    const N = 1800;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.27;
    const energy = Math.pow(this.level(frame), 1.3);
    this.background(ctx, w, h, energy, "24, 26, 70");
    // Точки на сфере – спираль Фибоначчи (один раз).
    if (!this._sphere) {
      const golden = Math.PI * (3 - Math.sqrt(5));
      this._sphere = Array.from({ length: N }, (_, i) => {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        return [Math.cos(golden * i) * r, y, Math.sin(golden * i) * r];
      });
    }
    // Вращение вокруг вертикали и лёгкий наклон – от времени трека.
    const yaw = t * 0.35;
    const pitch = 0.35 + Math.sin(t * 0.13) * 0.15;
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Громкость по широтам: волна идёт от нижнего полюса к верхнему.
    const bands = 24;
    const lv = Array.from({ length: bands + 1 }, (_, b) => Math.pow(this.level(frame - b), 1.2));
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < N; i++) {
      const [x0, y0, z0] = this._sphere[i];
      const band = Math.round(((y0 + 1) / 2) * bands);
      // Раздувание: громкость широты + "шипы" по шуму точки.
      const bump = 1 + lv[band] * (0.22 + 0.35 * this.rand(i + 77));
      let x = x0 * bump, y = y0 * bump, z = z0 * bump;
      [x, z] = [x * cyaw - z * syaw, x * syaw + z * cyaw];
      [y, z] = [y * cp - z * sp, y * sp + z * cp];
      const persp = 2.6 / (2.6 + z); // ближние (z<0) – крупнее
      const px = cx + x * R * persp;
      const py = cy + y * R * persp;
      const depth = (1 - z) / 2; // 0 – дальняя сторона, 1 – ближняя
      const hue = 205 + (y0 + 1) * 60 + lv[band] * 30; // голубой внизу -> розовый вверху
      ctx.fillStyle = `hsla(${hue}, 90%, ${55 + 25 * lv[band]}%, ${0.12 + 0.7 * depth * (0.45 + 0.55 * lv[band])})`;
      const size = (0.5 + 1.1 * depth) * persp * (1 + 0.8 * lv[band]);
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
    // Мягкое свечение в центре.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
    glow.addColorStop(0, `rgba(150, 110, 255, ${0.05 + 0.18 * energy})`);
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  },

  // ---------------------------------------------------------------- «Ленты»
  drawRibbons({ ctx, w, h, frame, t }) {
    const RIBBONS = 5;
    const POINTS = 140;
    const cy = h / 2;
    const energy = Math.pow(this.level(frame), 1.3);
    this.background(ctx, w, h, energy * 0.7, "50, 20, 60");
    ctx.globalCompositeOperation = "lighter";
    for (let r = 0; r < RIBBONS; r++) {
      const hue = this.HUES[r];
      const speed = 0.6 + r * 0.17;
      const freq = 1.3 + r * 0.35;
      const top = [];
      const bottom = [];
      for (let p = 0; p <= POINTS; p++) {
        const u = p / POINTS;
        // По ширине – громкость с запаздыванием: правая часть ленты "помнит"
        // недавнее, левая – чуть более раннее, звук прокатывается волной.
        const lv = Math.pow(this.levelAt(frame - (1 - u) * 20 - r * 2), 1.2);
        const env = Math.pow(Math.sin(Math.PI * u), 1.6); // к краям – в ноль
        const amp = h * (0.02 + 0.3 * lv) * env;
        const wave = Math.sin(u * Math.PI * 2 * freq + t * speed * 2 + r * 1.3);
        const centre = cy + amp * wave;
        const thick = (2 + h * 0.05 * lv) * env;
        top.push([u * w, centre - thick]);
        bottom.push([u * w, centre + thick]);
      }
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (const [x, y] of top) ctx.lineTo(x, y);
      for (let p = bottom.length - 1; p >= 0; p--) ctx.lineTo(bottom[p][0], bottom[p][1]);
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue}, 95%, 60%, ${0.18 + 0.25 * energy})`;
      ctx.shadowColor = `hsla(${hue}, 100%, 65%, 0.9)`;
      ctx.shadowBlur = 14 + 30 * energy;
      ctx.fill();
      // Яркая кромка по середине ленты.
      ctx.beginPath();
      for (let p = 0; p <= POINTS; p++) {
        const x = top[p][0];
        const y = (top[p][1] + bottom[p][1]) / 2;
        if (p === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `hsla(${hue}, 100%, 82%, ${0.35 + 0.5 * energy})`;
      ctx.lineWidth = 1.2;
      ctx.shadowBlur = 0;
      ctx.stroke();
    }
  },
};
