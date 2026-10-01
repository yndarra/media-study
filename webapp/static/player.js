// Управление воспроизведением: точная покадровая перемотка видео, звук с
// точностью до сэмпла (audio.js), режим остановки на конце отрезка и
// восстановление после зависаний.
//
// Звук — главные часы. Он играет через Web Audio из куска несжатой дорожки
// и планируется заранее: старт ровно с нужного кадра, остановка ровно в
// конце последнего кадра отрезка (или фрагмента). Видео при этом играет
// без звука и только показывает картинку, подстраиваясь под звук. Текущий
// кадр на дорожке во время воспроизведения считается по часам звука — это
// тот кадр, который сейчас слышно.
//
// Воспроизведение никогда не выходит за правый край фрагмента (последний
// кадр запаса справа, какой бы длины ни был запас) — там оно всегда
// останавливается.
//
// Режим остановки на конце отрезка (кнопка рядом с Play): включён — если
// воспроизведение началось левее последнего кадра отрезка, оно встаёт в
// конце этого кадра; если Play нажат на нём или правее — идёт до правого
// края фрагмента. Режим можно переключать на ходу: уже пройденный конец
// отрезка не остановит. Выключен — конец отрезка не учитывается.
//
// Перемотка: в полёте всегда не больше одной операции — при быстром
// таскании текущего кадра запоминается только последняя цель, и она
// выставляется, когда закончится предыдущая. Раньше каждое движение мыши
// запускало новую перемотку, браузер захлёбывался, и воспроизведение
// "ломалось" без ошибок в консоли.
//
// Позиция ставится на середину кадра ((f + 0.5) / fps) — так округление
// времени в браузере не уводит на соседний кадр.
const Player = {
  video: null,
  src: null, // /media/<код видео>/source.mp4 — задаётся при открытии видео
  playing: false,
  startFrame: null, // с какого кадра началось текущее воспроизведение
  stopFrame: null, // на каком кадре оно остановится
  source: null, // играющий звук (AudioBufferSourceNode)
  endTimer: null, // ожидание, пока конец звука дойдёт до динамиков
  audioWhen: null, // время часов звука, когда начал звучать кадр startFrame
  fromSec: null, // медиа-время кадра startFrame
  frozen: false, // поверх видео показан снимок кадра остановки
  targetFrame: null,
  issuedFrame: null,
  seekStartedAt: null,
  waiters: [],
  frameToken: 0,
  startToken: 0,
  speed: 1, // скорость текущего воспроизведения (State.speed на момент старта)

  init() {
    const v = (this.video = document.getElementById("video"));
    // Звук играет Web Audio — у самого видео он всегда выключен.
    v.muted = true;
    v.addEventListener("seeked", () => this._onSeeked());
    v.addEventListener("loadedmetadata", () => {
      if (this.targetFrame !== null) this._issue();
    });
    v.addEventListener("error", () => this._recover());
    this._armFrameCallback();
    setInterval(() => this._watchdog(), 1000);
  },

  _armFrameCallback() {
    const v = this.video;
    const token = ++this.frameToken;
    if (!v.requestVideoFrameCallback) return;
    const callback = (now, meta) => {
      if (token !== this.frameToken) return;
      try {
        this._onPresented(meta.mediaTime);
      } catch (err) {
        console.error(err);
      } finally {
        v.requestVideoFrameCallback(callback);
      }
    };
    v.requestVideoFrameCallback(callback);
  },

  // Медиа-время, которое сейчас слышно (звук идёт со скоростью this.speed:
  // секунда часов звука = speed секунд видео).
  _audioPosition() {
    return this.fromSec + Math.max(0, AudioEngine.now() - this.audioWhen) * this.speed;
  },

  // Каждый показанный видеокадр: подстраиваем видео под звук и, если
  // картинка уже дошла до кадра остановки, замораживаем её (см. _freeze).
  _onPresented(mediaTime) {
    if (!State.manifest || !this.playing) return;
    const frame = Math.round(mediaTime * fps());
    if (frame >= this.stopFrame) {
      if (!this.frozen) this._freeze();
      return;
    }
    // Видео подтягивается к звуку только скоростью (чуть быстрее или
    // медленнее) — перескок назад на старте выглядел как "вибрация".
    // Перематываем, лишь если разошлись больше чем на полсекунды.
    const drift = this._audioPosition() - mediaTime;
    if (Math.abs(drift) > 0.5) {
      this.video.currentTime = this._audioPosition();
    } else {
      this.video.playbackRate = this.speed * (1 + clamp(drift * 2, -0.25, 0.25));
    }
  },

  // Текущий кадр на дорожке во время воспроизведения — по часам звука.
  _tick() {
    if (!this.playing) return;
    const frame = Math.floor(this._audioPosition() * fps() + 1e-6);
    State.currentFrame = clamp(frame, this.startFrame, this.stopFrame);
    App.renderPlayback();
    requestAnimationFrame(() => this._tick());
  },

  // Картинка может обогнать звук на кадр-два: чтобы на экране не было видно
  // "перелёта" за кадр остановки и возврата назад, этот кадр замораживается
  // снимком поверх видео, пока звук не доиграет и видео не встанет на него.
  _freeze() {
    const v = this.video;
    const canvas = document.getElementById("freeze");
    const w = v.clientWidth;
    const h = v.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    // Вписываем кадр так же, как его показывает <video> (с полями по краям).
    const scale = Math.min(w / v.videoWidth, h / v.videoHeight);
    const dw = v.videoWidth * scale;
    const dh = v.videoHeight * scale;
    ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
    canvas.classList.remove("hidden");
    this.frozen = true;
    this.video.pause();
  },

  _unfreeze() {
    if (!this.frozen) return;
    document.getElementById("freeze").classList.add("hidden");
    this.frozen = false;
  },

  // Где остановиться: конец последнего кадра отрезка, если режим включён,
  // воспроизведение началось левее него и слышимая позиция его ещё не
  // прошла; иначе — правый край фрагмента. Остановка звука назначается
  // точно по часам звука; при повторном вызове (переключили режим на ходу)
  // действует последнее назначение.
  _planStop() {
    if (!this.playing || !this.source) return;
    const f = currentFragment();
    const rate = fps();
    const segmentLast = f.algo_end_frame - 1;
    const armed =
      State.stopAtSegmentEnd && this.startFrame < segmentLast && this._audioPosition() < (segmentLast + 1) / rate;
    this.stopFrame = armed ? segmentLast : f.context_end_frame - 1;
    const stopSec = (this.stopFrame + 1) / rate;
    this.source.stop(this.audioWhen + (stopSec - this.fromSec) / this.speed);
  },

  // Переключили режим во время воспроизведения.
  replan() {
    if (this.playing) this._planStop();
  },

  // Звук ушёл из звуковой системы. Слышно его ещё на задержку вывода
  // позже — до этого момента воспроизведение считается идущим, и текущий
  // кадр продолжает равномерно ехать по дорожке (иначе он "догонял" бы
  // последние кадры скачком).
  _onAudioEnded() {
    this.source = null;
    const wait = (((this.stopFrame + 1) / fps() - this._audioPosition()) / this.speed) * 1000;
    if (wait > 1) {
      this.endTimer = setTimeout(() => this._finishStop(), wait);
    } else {
      this._finishStop();
    }
  },

  // Конец отрезка (фрагмента) прозвучал: видео встаёт точно на кадр остановки.
  _finishStop() {
    const frame = this.stopFrame;
    this._halt();
    this.seekTo(frame, true);
    State.lastStop = { frame };
    App.renderPlayback();
    // Снимок убираем, когда видео уже встало на кадр остановки (плюс пара
    // кадров отрисовки, чтобы не мигнул предыдущий).
    this.whenSeeked().then(() => requestAnimationFrame(() => requestAnimationFrame(() => this._unfreeze())));
  },

  // Останавливает звук и видео (без перемотки).
  _halt() {
    this.startToken++;
    clearTimeout(this.endTimer);
    this.endTimer = null;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch (_) {}
      this.source = null;
    }
    this.playing = false;
    this.video.pause();
    this.video.playbackRate = 1;
    App.updatePlayButton();
  },

  // Пауза пользователем: встаём на тот кадр, который сейчас слышно.
  pause() {
    if (!this.playing) return;
    const frame = clamp(Math.floor(this._audioPosition() * fps() + 1e-6), this.startFrame, this.stopFrame);
    this._halt();
    this._unfreeze();
    this.seekTo(frame);
    App.renderPlayback();
  },

  // Сменили скорость: если играет — продолжаем с того же слышимого кадра уже
  // с новой скоростью (жёлтую метку не трогаем).
  async setSpeed(speed) {
    State.speed = speed;
    try {
      localStorage.setItem("playback-speed", String(speed));
    } catch (_) {}
    App.renderSpeed();
    if (!this.playing) return;
    const frame = clamp(Math.floor(this._audioPosition() * fps() + 1e-6), this.startFrame, this.stopFrame);
    this._halt();
    this._unfreeze();
    this.seekTo(frame);
    await this._start(frame);
  },

  // Открыли другое видео: новый источник, всё состояние воспроизведения сброшено.
  setSource(url) {
    this.pauseIfPlaying();
    this._unfreeze();
    this.src = url;
    this.targetFrame = null;
    this.issuedFrame = null;
    this.seekStartedAt = null;
    this.waiters = [];
    this.video.src = url;
    this.video.muted = true;
    this.video.load();
  },

  // -- перемотка ---------------------------------------------------------------

  // Любая программная перемотка сбрасывает признак "кадр выбран вручную на
  // дорожке" — дорожка выставляет его сама после своего вызова.
  seekTo(frame, keepStop = false) {
    const total = State.manifest.video.total_frames;
    frame = clamp(frame, 0, total - 1);
    State.currentFrame = frame;
    State.manualPlayhead = false;
    if (!keepStop) State.lastStop = null;
    this.targetFrame = frame;
    if (this.video.readyState >= 1 && !this.video.seeking) this._issue();
  },

  jumpTo(frame) {
    this.pauseIfPlaying();
    this._unfreeze();
    this.seekTo(frame);
  },

  pauseIfPlaying() {
    if (this.playing) {
      this._halt();
      this._unfreeze();
    }
  },

  _issue() {
    this.issuedFrame = this.targetFrame;
    this.seekStartedAt = performance.now();
    this.video.currentTime = (this.issuedFrame + 0.5) / fps();
  },

  _onSeeked() {
    if (this.targetFrame !== null && this.issuedFrame !== this.targetFrame) {
      this._issue();
      return;
    }
    this.seekStartedAt = null;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  },

  whenSeeked() {
    if (!this.video.seeking && this.issuedFrame === this.targetFrame) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  },

  // Перемотка висит дольше 4 с — видимо, медиаконвейер браузера застрял:
  // перезагружаем источник и возвращаемся на тот же кадр.
  _watchdog() {
    if (this.seekStartedAt !== null && performance.now() - this.seekStartedAt > 4000) {
      console.warn("перемотка зависла — перезагружаю видео");
      this._recover();
    }
  },

  _recover() {
    const frame = State.currentFrame;
    this._halt();
    this.seekStartedAt = null;
    this.targetFrame = frame;
    this.issuedFrame = null;
    this.video.src = `${this.src}?r=${Date.now()}`;
    this.video.load();
    this.video.muted = true;
    this._armFrameCallback();
  },

  // -- воспроизведение ---------------------------------------------------------

  // Повтор — всегда ровно с первого кадра отрезка (жёлтую метку не трогает).
  async replay() {
    const f = currentFragment();
    if (!f) return;
    this.pauseIfPlaying();
    this.seekTo(f.algo_start_frame);
    await this._start(f.algo_start_frame);
  },

  // Повтор с жёлтой метки (кнопка серая, если метки нет).
  async replayFromMarker() {
    if (State.timeMarkerFrame === null || State.timeMarkerFrame === undefined) return;
    this.pauseIfPlaying();
    const from = State.timeMarkerFrame;
    this.seekTo(from);
    await this._start(from);
  },

  async togglePlay() {
    if (this.playing) {
      this.pause();
      return;
    }
    const f = currentFragment();
    if (!f) return;
    let from = State.currentFrame;

    if (from >= f.context_end_frame - 1) {
      // Доиграли до правого края фрагмента — новый Play начинает с метки
      // начала воспроизведения, а если её нет — с начала отрезка.
      from = State.timeMarkerFrame ?? f.algo_start_frame;
      this.seekTo(from, true);
    } else if (State.manualPlayhead && from !== f.algo_start_frame) {
      // Жёлтая метка ставится, только если текущий кадр выбран вручную на
      // дорожке (клик по ней или перетаскивание красного треугольника), и
      // никогда — на первый кадр отрезка. Пауза/Play, шаги кадрами,
      // перетаскивание границ и горячие клавиши её не трогают.
      State.timeMarkerFrame = from;
    }
    await this._start(from);
  },

  async _start(from) {
    this._unfreeze();
    State.manualPlayhead = false;
    State.lastStop = null;
    const token = ++this.startToken;
    const f = currentFragment();
    const ctx = AudioEngine.context();
    // Часы звука запускаются по действию пользователя (правило браузеров).
    ctx.resume();
    const speed = State.speed;
    let audio;
    let buffer;
    try {
      [audio] = await Promise.all([AudioEngine.load(f), this.whenSeeked()]);
      buffer = await AudioEngine.loadAt(f, speed);
    } catch (err) {
      App.flash(String(err.message || err));
      return;
    }
    // Пока грузился звук, пользователь мог нажать что-то ещё.
    if (token !== this.startToken || currentFragment() !== f) return;
    await ctx.resume();

    const rate = fps();
    this.startFrame = from;
    this.fromSec = from / rate;
    this.speed = speed;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // Небольшой запас, чтобы видео успело тронуться одновременно со звуком.
    const when = ctx.currentTime + 0.08;
    // В растянутом звуке позиция делится на скорость.
    source.start(when, Math.max(0, this.fromSec - audio.startSec) / speed);
    source.onended = () => {
      if (this.source === source) this._onAudioEnded();
    };
    this.source = source;
    this.audioWhen = when;
    this.playing = true;
    this.stopFrame = f.context_end_frame - 1;
    this._planStop();
    App.updatePlayButton();
    this.video.playbackRate = speed;
    // Видео трогается, когда звук становится слышен (часы звука плюс
    // задержка вывода), иначе картинка убегает вперёд звука.
    setTimeout(() => {
      if (this.playing && this.source === source) this.video.play().catch(() => {});
    }, Math.max(0, (when + AudioEngine.latency() - ctx.currentTime) * 1000));
    this._tick();
  },
};
