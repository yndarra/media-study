// Аудио в редакторе: вместо картинки (у аудио её нет – копия для редактора
// идёт с чёрным кадром) – холст поверх плеера в духе современных
// "живых обоев", реагирующих на звук:
//   - почти чёрный фон с лёгким виньетированием и зерном (без цветных пятен);
//   - посередине несколько светящихся "жидких" колец: каждое – замкнутая
//     плавная кривая, которую изгибают несколько гармоник; сила изгиба – от
//     громкости, причём каждое следующее кольцо берёт громкость чуть более
//     ранних кадров – получается эхо, волна расходится от центра;
//   - внутри – мягкое ядро, яркость по громкости;
//   - наружу разлетаются искры (быстрее и ярче на громком).
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

  enable(on) {
    const wrap = document.getElementById("video-wrap");
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "audio-vis";
      wrap.appendChild(this.canvas);
    }
    wrap.classList.toggle("audio-mode", on);
    if (on && !this.active) {
      this.active = true;
      requestAnimationFrame((t) => this.frame(t));
    }
    if (!on) this.active = false;
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
    const t = frame / rate; // время трека – на паузе стоит
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.2;
    const level = this.level(frame);
    const energy = Math.pow(level, 1.3);

    // -- фон: почти чёрный, виньетирование, зерно ------------------------------
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#050508";
    ctx.fillRect(0, 0, w, h);
    const vignette = ctx.createRadialGradient(cx, cy, base * 0.5, cx, cy, Math.max(w, h) * 0.75);
    vignette.addColorStop(0, `rgba(40, 24, 60, ${0.25 + 0.25 * energy})`);
    vignette.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ctx.createPattern(this.grain(), "repeat");
    ctx.fillRect(0, 0, w, h);

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
      for (let k = 0; k <= N; k++) {
        const a = (k / N) * Math.PI * 2;
        // Несколько гармоник с медленно плывущими фазами – "жидкая" форма.
        const d = Math.sin(3 * a + spin * 2 + ring) * 0.55
          + Math.sin(5 * a - spin * 3 + ring * 1.7) * 0.3
          + Math.sin(8 * a + spin * 5 + ring * 0.6) * 0.15 * lv;
        const r = radius + amp * d;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(x, y);
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
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
  },
};
