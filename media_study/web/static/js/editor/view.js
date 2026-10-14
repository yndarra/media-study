// Вид плеера редактора: приближение (Zoom) и обрезка чёрных полос катсцен (Letterbox).

const Zoom = {
  SCALE: 1.7,
  fragmentId: null,

  targets() {
    return [$("video"), $("freeze")];
  },

  toggle(e) {
    if (State.manifest && State.manifest.video.audio_only) return; // у аудио приближать нечего
    if (this.fragmentId && currentFragment() && this.fragmentId === currentFragment().id) return this.reset();
    const wrap = $("video-wrap");
    const rect = wrap.getBoundingClientRect();
    // Плеер показывает ровно картинку (без полей и без записанных чёрных полос).
    const video = $("video");
    const cw = rect.width;
    const ch = rect.height;
    const cx = 0;
    const cy = 0;
    // Видео может быть сдвинуто вверх (скрытая полоса записи) – на столько же
    // поправляется и перенос при увеличении.
    const oy = video.getBoundingClientRect().top - rect.top;
    const w = cw / this.SCALE;
    const h = ch / this.SCALE;
    const x = clamp(e.clientX - rect.left - w / 2, cx, cx + cw - w);
    const y = clamp(e.clientY - rect.top - h / 2, cy, cy + ch - h);
    this.fragmentId = currentFragment() ? currentFragment().id : null;
    // Рамка-"скриншот"...
    const frame = document.createElement("div");
    frame.className = "zoom-frame";
    Object.assign(frame.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    wrap.appendChild(frame);
    // Рамка (x, y) после увеличения встаёт ровно на место картинки (cx, cy).
    const transform = `translate(${cx - x * this.SCALE}px, ${cy - oy - (y - oy) * this.SCALE}px) scale(${this.SCALE})`;
    // ...затем она и содержимое растягиваются на весь плеер.
    setTimeout(() => {
      for (const el of [...this.targets(), frame]) {
        el.style.transformOrigin = "0 0";
        el.style.transition = "transform 0.35s cubic-bezier(0.22, 0.61, 0.36, 1)";
        el.style.transform = transform;
      }
      // Рамка гаснет, пока растягивается.
      frame.style.transition += ", opacity 0.3s ease-in 0.1s";
      frame.style.opacity = "0";
      setTimeout(() => frame.remove(), 450);
    }, 180);
  },

  reset(instant = false) {
    this.fragmentId = null;
    for (const el of this.targets()) {
      el.style.transition = instant ? "none" : "transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1)";
      el.style.transform = "";
    }
  },
};

// Чёрные полосы, записанные в самом видео: катсцены игр часто идут 21:9
// внутри кадра 16:9 (у WuWa – по 90 px сверху и снизу при 720p), а геймплей –
// во весь кадр. Когда видео стоит (открыли фрагмент, перемотали), кадр
// уменьшенно рисуется на холсте и по нему ищутся чёрные строки сверху и
// снизу; есть одинаковые полосы – плеер по высоте показывает только картинку
// (сама картинка не режется и не растягивается). Во время воспроизведения не
// меняется – чтобы ничего не прыгало; затемнения (весь кадр чёрный) не в счёт.
const Letterbox = {
  W: 64, // по ширине хватит и 64 точек; по высоте – все строки кадра (точная граница)
  LIMIT: 18, // строка "чёрная", если ярче этого нет ни одной точки
  bar: 0, // текущая скрытая полоса – доля высоты кадра

  init() {
    const video = $("video");
    for (const type of ["seeked", "loadeddata"]) video.addEventListener(type, () => this.detect());
  },

  detect() {
    const video = $("video");
    if (!video.videoWidth || Player.playing) return;
    const canvas = (this.canvas ||= document.createElement("canvas"));
    const H = Math.min(video.videoHeight, 1080);
    canvas.width = this.W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(video, 0, 0, this.W, H);
    } catch (_) {
      return;
    }
    const data = ctx.getImageData(0, 0, this.W, H).data;
    const dark = (row) => {
      for (let x = 0; x < this.W; x++) {
        const i = (row * this.W + x) * 4;
        if (Math.max(data[i], data[i + 1], data[i + 2]) > this.LIMIT) return false;
      }
      return true;
    };
    let top = 0;
    while (top < H && dark(top)) top++;
    let bottom = 0;
    while (bottom < H && dark(H - 1 - bottom)) bottom++;
    // Весь кадр тёмный (затемнение) или полосы разные – не решаем, оставляем как было.
    if (top + bottom >= H * 0.6 || Math.abs(top - bottom) > H * 0.01) return;
    const rows = Math.min(top, bottom);
    this.apply(rows >= H * 0.04 ? rows / H : 0);
  },

  apply(bar) {
    if (Math.abs(bar - this.bar) < 0.005) return;
    this.bar = bar;
    const video = $("video");
    const wrap = $("video-wrap");
    const ratio = video.videoWidth / video.videoHeight;
    wrap.classList.toggle("letterboxed", bar > 0);
    wrap.style.setProperty("--visible-ratio", `${ratio / (1 - 2 * bar)}`);
    wrap.style.setProperty("--bar-w", `${bar / ratio}`);
    // Высота плеера поменялась – дорожка и текст под ним встают на новые места.
    requestAnimationFrame(() => App.renderAll && App.renderAll());
  },
};

// Поля правимой фразы слева и справа (px).
