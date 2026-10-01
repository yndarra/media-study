// Canvas-дорожка одного фрагмента: [context_start .. algo_start .. algo_end .. context_end).
//
// Сверху вниз по строкам:
//   - метка начала воспроизведения: свой жёлтый треугольник + пунктир через дорожку;
//     нажатие на неё сливает с ней текущий кадр, дальше их можно тянуть
//     вместе; двойной клик по ней удаляет её; ставится Play после ручного
//     выбора текущего кадра на дорожке или двойным кликом по дорожке;
//   - текущий кадр: красный треугольник + линия, двигаются вместе;
//   - сама дорожка со звуковой волной, отрезок подсвечен;
//   - границы отрезка: синие треугольники под дорожкой, тянутся только за них;
//     если границы сдвинули, разница с исходным положением закрашена желтоватым.
// Все треугольники одного размера; выделенный объект (текущий кадр или одна
// из границ) — то, что двигают кнопки ±1/±10 и стрелки, — получает белую
// обводку и больше ничем не отличается.
// Маркер конца стоит на ПОСЛЕДНЕМ кадре отрезка (algo_end_frame - 1): именно
// этот кадр остаётся на экране при остановке на конце отрезка.
const Timeline = {
  canvas: null,
  ctx: null,
  width: 0,
  dragging: null,
  waveform: null,

  HEIGHT: 72,
  MARGIN: 12,
  // Треугольники текущего кадра и метки начала воспроизведения — в одной строке.
  HEAD_ROW: [2, 14],
  TRACK: [16, 56],
  BOUND_ROW: [58, 70],
  TRIANGLE_HALF_WIDTH: 6,
  HIT_RADIUS: 9,

  init() {
    this.canvas = document.getElementById("timeline");
    this.ctx = this.canvas.getContext("2d");
    this._resize();
    window.addEventListener("resize", () => { this._resize(); if (currentFragment()) App.renderAll(); });
    this.canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this._onMove(e));
    this.canvas.addEventListener("pointerup", (e) => this._onUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this._onUp(e));
    // Двойной клик по кадру дорожки ставит туда жёлтую метку (кроме первого
    // кадра отрезка — туда метка не ставится никогда).
    this.canvas.addEventListener("dblclick", (e) => this._onDoubleClick(e));

  },

  // Звуковая волна открытого видео (по байту на кадр).
  loadWaveform(url) {
    this.waveform = null;
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (!buf) return;
        this.waveform = new Uint8Array(buf);
        if (currentFragment()) this.render(currentFragment(), State);
      })
      .catch(() => {});
  },

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.width = this.canvas.clientWidth;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.HEIGHT * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  // Кадры — точки: первый кадр фрагмента ровно на левом краю дорожки,
  // последний (context_end_frame - 1) — ровно на правом. Поэтому и
  // текущий кадр на последнем кадре фрагмента стоит на самом краю, и все
  // маркеры совпадают с краями закрашенных кусков.
  _span(f) {
    return Math.max(1, f.context_end_frame - 1 - f.context_start_frame);
  },

  frameToX(f, frame) {
    return this.MARGIN + ((frame - f.context_start_frame) / this._span(f)) * (this.width - 2 * this.MARGIN);
  },

  _xToFrameFloat(f, x) {
    return f.context_start_frame + ((x - this.MARGIN) / (this.width - 2 * this.MARGIN)) * this._span(f);
  },

  xToFrame(f, x) {
    return Math.round(this._xToFrameFloat(f, x));
  },

  render(f, s) {
    if (!f) return;
    const ctx = this.ctx;
    const [tt, tb] = this.TRACK;
    ctx.clearRect(0, 0, this.width, this.HEIGHT);

    const x = (frame) => this.frameToX(f, frame);
    // Отрезок и его исходное положение — от первого до последнего кадра
    // включительно; маркеры стоят ровно на краях закрашенного.
    const start = f.algo_start_frame;
    const last = f.algo_end_frame - 1;
    const origStart = f.original_algo_start_frame;
    const origLast = f.original_algo_end_frame - 1;
    const sx = x(start);
    const ex = x(last);

    // Серый — запас; голубой — отрезок, общий с исходным; желтоватый —
    // разница с исходным положением (кадры, которые добавились в отрезок
    // или ушли из него при сдвиге границ).
    const band = (from, to, color) => {
      if (to < from) return;
      ctx.fillStyle = color;
      ctx.fillRect(from, tt, Math.max(1, to - from), tb - tt);
    };
    band(x(f.context_start_frame), x(f.context_end_frame - 1), "#23232a");
    band(x(Math.max(start, origStart)), x(Math.min(last, origLast)), "#213650");
    if (start !== origStart) band(x(Math.min(start, origStart)), x(Math.max(start, origStart)), "#46321c");
    if (last !== origLast) band(x(Math.min(last, origLast)), x(Math.max(last, origLast)), "#46321c");

    this._drawWaveform(f, sx, ex);
    const endMarkX = ex;

    // Метка начала воспроизведения — такой же треугольник и линия, как у
    // текущего кадра, но жёлтые. Если текущий кадр стоит ровно на метке,
    // её линия не рисуется, а треугольник текущего кадра становится жёлтым
    // (его линия остаётся красной).
    const hasMarker = s.timeMarkerFrame !== null && s.timeMarkerFrame !== undefined;
    const onMarker = hasMarker && s.timeMarkerFrame === s.currentFrame;
    if (hasMarker && !onMarker) {
      const mx = this.frameToX(f, s.timeMarkerFrame);
      ctx.fillStyle = "#ffc857";
      ctx.fillRect(mx - 0.75, this.HEAD_ROW[1], 1.5, tb - this.HEAD_ROW[1] + 1);
      this._triangle(mx, this.HEAD_ROW[0], this.HEAD_ROW[1], "#ffc857", "down");
    }

    this._drawBound(sx, s.selected === "start");
    this._drawBound(endMarkX, s.selected === "end");

    const px = this.frameToX(f, s.currentFrame);
    ctx.fillStyle = "#ff5050";
    ctx.fillRect(px - 0.75, this.HEAD_ROW[1], 1.5, tb - this.HEAD_ROW[1] + 1);
    this._triangle(px, this.HEAD_ROW[0], this.HEAD_ROW[1], onMarker ? "#ffc857" : "#ff5050", "down", s.selected === "playhead");
  },

  _drawWaveform(f, sx, ex) {
    if (!this.waveform) return;
    const ctx = this.ctx;
    const [tt, tb] = this.TRACK;
    const mid = (tt + tb) / 2;
    const half = (tb - tt) / 2 - 2;
    const wave = this.waveform;
    const left = Math.ceil(this.MARGIN);
    const right = Math.floor(this.width - this.MARGIN);
    for (let x = left; x <= right; x++) {
      const fa = Math.floor(this._xToFrameFloat(f, x));
      const fb = Math.max(fa + 1, Math.ceil(this._xToFrameFloat(f, x + 1)));
      let peak = 0;
      for (let fr = Math.max(fa, 0); fr < fb && fr < wave.length; fr++) {
        if (wave[fr] > peak) peak = wave[fr];
      }
      const h = (peak / 255) * half;
      // Внутри отрезка волна голубая, у фрагментов "проверить текст" — светло-фиолетовая.
      const inside = x >= sx && x <= ex;
      ctx.fillStyle = inside ? (f.needs_review ? "rgba(205, 170, 255, 0.9)" : "rgba(150, 205, 255, 0.9)") : "rgba(150, 150, 170, 0.55)";
      ctx.fillRect(x, mid - h, 1, Math.max(1, 2 * h));
    }
  },

  _drawBound(x, selected) {
    const ctx = this.ctx;
    const [tt, tb] = this.TRACK;
    const [bt, bb] = this.BOUND_ROW;
    const color = "#5fb4f0";
    ctx.fillStyle = color;
    ctx.fillRect(x - 0.75, tt, 1.5, bt - tt);
    this._triangle(x, bt, bb, color, "up", selected);
  },

  _triangle(x, top, bottom, color, direction, outline = false) {
    const ctx = this.ctx;
    const halfWidth = this.TRIANGLE_HALF_WIDTH;
    ctx.beginPath();
    if (direction === "down") {
      ctx.moveTo(x - halfWidth, top);
      ctx.lineTo(x + halfWidth, top);
      ctx.lineTo(x, bottom);
    } else {
      ctx.moveTo(x, top);
      ctx.lineTo(x + halfWidth, bottom);
      ctx.lineTo(x - halfWidth, bottom);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  },

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  },

  _onDown(e) {
    const f = currentFragment();
    if (!f) return;
    const { x, y } = this._pos(e);
    const R = this.HIT_RADIUS;

    // Нажали на жёлтый треугольник (он не дальше красного) — текущий кадр
    // сливается с меткой, и дальше их можно тянуть вместе.
    if (this._onMarkerTriangle(f, x, y)) {
      State.selected = "playhead";
      Player.jumpTo(State.timeMarkerFrame);
      this.dragging = "marker";
      this.canvas.setPointerCapture(e.pointerId);
      App.renderAll();
      return;
    }

    if (y >= this.TRACK[1] - 1) {
      const ds = Math.abs(x - this.frameToX(f, f.algo_start_frame));
      const de = Math.abs(x - this.frameToX(f, f.algo_end_frame - 1));
      // У фрагмента, переданного в Anki, границы не двигаются.
      if (Math.min(ds, de) <= R && !isLocked(f)) {
        const target = ds <= de ? "start" : "end";
        State.selected = target;
        this.dragging = target;
        this.canvas.setPointerCapture(e.pointerId);
        App.jumpToBound(target);
        return;
      }
      // Клик ниже дорожки мимо треугольников ничего не делает.
      return;
    }

    State.selected = "playhead";
    this.dragging = "playhead";
    this.canvas.setPointerCapture(e.pointerId);
    // Нажали на сам красный треугольник — только выделяем текущий кадр (и
    // можно тянуть). Любой клик по дорожке переносит текущий кадр ровно на
    // кадр под курсором, даже если это соседний кадр.
    const px = this.frameToX(f, State.currentFrame);
    const onTriangle = y <= this.HEAD_ROW[1] + 1 && Math.abs(x - px) <= this.TRIANGLE_HALF_WIDTH;
    const frame = clamp(this.xToFrame(f, x), f.context_start_frame, f.context_end_frame - 1);
    if (!onTriangle) {
      const wasPlaying = Player.playing;
      Player.jumpTo(frame);
      // Кадр выбран вручную — следующий Play поставит сюда жёлтую метку.
      State.manualPlayhead = true;
      // Во время воспроизведения клик не ставит на паузу: кадр переносится,
      // и воспроизведение продолжается с него (как клик + Play).
      if (wasPlaying) Player.togglePlay();
    } else {
      Player.pauseIfPlaying();
    }
    App.renderAll();
  },

  _onMarkerTriangle(f, x, y) {
    if (State.timeMarkerFrame === null || State.timeMarkerFrame === undefined) return false;
    if (y > this.HEAD_ROW[1] + 1) return false;
    const dm = Math.abs(x - this.frameToX(f, State.timeMarkerFrame));
    const dp = Math.abs(x - this.frameToX(f, State.currentFrame));
    return dm <= this.HIT_RADIUS && dm <= dp;
  },

  _onDoubleClick(e) {
    const f = currentFragment();
    if (!f) return;
    const { x, y } = this._pos(e);
    if (y >= this.TRACK[1] - 1) return; // ряд границ отрезка — не про метку
    // Двойной клик по треугольнику метки удаляет её.
    if (this._onMarkerTriangle(f, x, y)) {
      State.timeMarkerFrame = null;
      App.renderAll();
      return;
    }
    const frame = clamp(this.xToFrame(f, x), f.context_start_frame, f.context_end_frame - 1);
    if (frame === f.algo_start_frame) return;
    State.timeMarkerFrame = frame;
    App.renderAll();
  },

  _onMove(e) {
    if (!this.dragging) return;
    const f = currentFragment();
    const { x } = this._pos(e);
    const frame = this.xToFrame(f, clamp(x, this.MARGIN, this.width - this.MARGIN));

    if (this.dragging === "marker") {
      // Метка едет вместе с текущим кадром (на первый кадр отрезка её не ставим).
      const target = clamp(frame, f.context_start_frame, f.context_end_frame - 1);
      Player.seekTo(target);
      if (target !== f.algo_start_frame) State.timeMarkerFrame = target;
    } else if (this.dragging === "start") {
      f.algo_start_frame = clamp(frame, f.context_start_frame, f.algo_end_frame - 1);
      Player.seekTo(f.algo_start_frame);
    } else if (this.dragging === "end") {
      // Маркер стоит на последнем кадре отрезка, конец — следующий за ним.
      f.algo_end_frame = clamp(frame + 1, f.algo_start_frame + 1, f.context_end_frame);
      Player.seekTo(f.algo_end_frame - 1);
    } else {
      Player.seekTo(clamp(frame, f.context_start_frame, f.context_end_frame - 1));
      State.manualPlayhead = true;
    }
    App.renderAll();
  },

  _onUp(e) {
    if (!this.dragging) return;
    const target = this.dragging;
    this.dragging = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (target === "start" || target === "end") App.saveBounds(currentFragment());
  },
};
