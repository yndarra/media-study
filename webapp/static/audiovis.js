// Аудио в редакторе: вместо картинки (у аудио её нет – копия для редактора
// идёт с чёрным кадром) – холст поверх плеера:
//   - фон: несколько мягких цветных пятен (радиальные градиенты), которые
//     постоянно плывут по кругу, меняют размер и то проявляются, то тают –
//     от времени, независимо от воспроизведения;
//   - посередине круг, который "дышит" громкостью, вокруг – лучи по волне
//     соседних кадров и расходящиеся кольца. Всё это считается от ТЕКУЩЕГО
//     КАДРА (волна waveform.bin – громкость по кадрам, её же рисует дорожка),
//     поэтому при воспроизведении движется со звуком, а на паузе застывает
//     ровно таким, каким был этот кадр.
const AudioVisual = {
  canvas: null,
  active: false,
  // Пятна фона: оттенок, скорости и фазы движения/размера/прозрачности.
  BLOBS: [
    { hue: 268, sx: 0.071, sy: 0.053, px: 0.0, py: 1.3, sr: 0.09, pr: 0.4, sa: 0.061, pa: 0.0 },
    { hue: 222, sx: 0.047, sy: 0.067, px: 2.1, py: 0.2, sr: 0.07, pr: 2.2, sa: 0.083, pa: 1.7 },
    { hue: 318, sx: 0.059, sy: 0.043, px: 4.0, py: 3.1, sr: 0.11, pr: 1.1, sa: 0.052, pa: 3.3 },
    { hue: 190, sx: 0.038, sy: 0.074, px: 1.2, py: 4.4, sr: 0.06, pr: 3.7, sa: 0.071, pa: 4.6 },
    { hue: 248, sx: 0.083, sy: 0.031, px: 5.3, py: 2.6, sr: 0.08, pr: 5.0, sa: 0.044, pa: 2.4 },
    { hue: 295, sx: 0.029, sy: 0.058, px: 3.4, py: 5.6, sr: 0.10, pr: 0.9, sa: 0.066, pa: 5.5 },
  ],

  // Включить для открытого видео (только у аудио).
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

  // Громкость кадра 0..1 (по волне, чуть сглаженная по соседям).
  level(frame) {
    const wave = Timeline.waveform;
    if (!wave || !wave.length) return 0;
    let sum = 0;
    let n = 0;
    for (let k = frame - 2; k <= frame + 2; k++) {
      if (k >= 0 && k < wave.length) {
        sum += wave[k];
        n++;
      }
    }
    return n ? sum / n / 255 : 0;
  },

  frame(now) {
    if (!this.active) return;
    requestAnimationFrame((t) => this.frame(t));
    if (State.view !== "editor") return;
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
    const t = now / 1000;

    // -- фон: тёмная основа и переливающиеся пятна --------------------------------
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#08070d";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";
    const big = Math.max(w, h);
    for (const b of this.BLOBS) {
      const x = w * (0.5 + 0.42 * Math.sin(t * b.sx * 6.283 + b.px));
      const y = h * (0.5 + 0.40 * Math.cos(t * b.sy * 6.283 + b.py));
      const r = big * (0.32 + 0.14 * Math.sin(t * b.sr * 6.283 + b.pr));
      // То проявляется, то тает (иногда почти исчезает).
      const alpha = Math.max(0, 0.08 + 0.32 * Math.sin(t * b.sa * 6.283 + b.pa));
      const hue = b.hue + 18 * Math.sin(t * 0.05 + b.pa);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${hue}, 85%, 58%, ${alpha})`);
      g.addColorStop(0.55, `hsla(${hue}, 85%, 45%, ${alpha * 0.35})`);
      g.addColorStop(1, `hsla(${hue}, 85%, 40%, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";

    // -- круг по звуку текущего кадра -------------------------------------------
    if (!State.manifest) return;
    const frame = State.currentFrame || 0;
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.13;
    const level = this.level(frame);
    const energy = Math.pow(level, 1.4);
    const r = base * (1 + 0.38 * energy);
    const hue = 270 + 40 * Math.sin(frame / 240); // цвет медленно плывёт по ходу трека

    // Кольца, расходящиеся от круга (по кадрам: на паузе застывают).
    for (let k = 0; k < 3; k++) {
      const phase = ((frame / 50 + k / 3) % 1 + 1) % 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + phase * base * 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue + 30}, 90%, 75%, ${(1 - phase) * 0.28 * (0.4 + energy)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Лучи: громкость соседних кадров (симметрично), вокруг круга.
    const wave = Timeline.waveform;
    const N = 96;
    ctx.lineCap = "round";
    for (let k = 0; k < N; k++) {
      const offset = Math.abs(k - N / 2) - N / 4; // от -N/4 (прошлое) до +N/4 (будущее)
      const f = Math.round(frame + offset);
      const v = wave && f >= 0 && f < wave.length ? wave[f] / 255 : 0;
      const len = base * (0.06 + 0.75 * Math.pow(v, 1.3));
      const a = (k / N) * Math.PI * 2 - Math.PI / 2;
      const r1 = r + 8;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * (r1 + len), cy + Math.sin(a) * (r1 + len));
      ctx.strokeStyle = `hsla(${hue + (k / N) * 60}, 90%, ${62 + 20 * v}%, ${0.35 + 0.55 * v})`;
      ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * r1) / N * 0.45);
      ctx.stroke();
    }

    // Сам круг: светлый центр, цветной край, свечение по громкости.
    const g = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, `hsla(${hue + 40}, 100%, 92%, 0.95)`);
    g.addColorStop(0.6, `hsla(${hue}, 85%, 62%, 0.9)`);
    g.addColorStop(1, `hsla(${hue - 20}, 80%, 45%, 0.85)`);
    ctx.save();
    ctx.shadowColor = `hsla(${hue}, 100%, 70%, ${0.5 + 0.5 * energy})`;
    ctx.shadowBlur = 20 + 60 * energy;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  },
};
