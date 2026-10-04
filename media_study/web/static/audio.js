// Звук редактора через Web Audio — с точностью до сэмпла.
//
// Для каждого фрагмента сервер отдаёт кусок несжатого звука ровно на окно
// фрагмента (/api/audio). Воспроизведение планируется заранее по часам
// звуковой системы: старт — точно с нужного кадра, остановка — точно в
// конце последнего кадра отрезка (или фрагмента). Обычный <video> так не
// умеет: после паузы у него ещё звучат накопленные десятки миллисекунд, и
// сколько именно — каждый раз по-разному.
const AudioEngine = {
  ctx: null,
  cache: new Map(), // "начало-конец" окна в кадрах → Promise<{buffer, startSec}>
  CACHE_LIMIT: 8,

  context() {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: "interactive" });
    return this.ctx;
  },

  // Загружает (или берёт из кэша) звук окна фрагмента.
  load(f) {
    const key = `${State.project}:${f.context_start_frame}-${f.context_end_frame}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const promise = (async () => {
      const res = await fetch(`${Api.base()}/audio?start_frame=${f.context_start_frame}&end_frame=${f.context_end_frame}`);
      if (!res.ok) throw new Error(`звук не загрузился: ${res.status}`);
      const startSample = Number(res.headers.get("X-Audio-Start-Sample"));
      const rate = Number(res.headers.get("X-Audio-Rate"));
      const buffer = await this.context().decodeAudioData(await res.arrayBuffer());
      return { buffer, startSec: startSample / rate };
    })();
    promise.catch(() => this.cache.delete(key));
    this.cache.set(key, promise);
    while (this.cache.size > this.CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    return promise;
  },

  // Звук окна для скорости speed (1 — как есть). Для другой скорости буфер
  // растягивается/сжимается по времени БЕЗ изменения высоты голоса (WSOLA,
  // см. stretch) и кэшируется при звуке окна. Соответствие времени
  // сохраняется: секунда растянутого звука = speed секунд исходного.
  async loadAt(f, speed) {
    const audio = await this.load(f);
    if (Math.abs(speed - 1) < 1e-9) return audio.buffer;
    if (!audio.stretched) audio.stretched = new Map();
    const key = speed.toFixed(2);
    if (!audio.stretched.has(key)) audio.stretched.set(key, this.stretch(audio.buffer, speed));
    return audio.stretched.get(key);
  },

  // WSOLA (waveform similarity overlap-add): выход собирается из окон по 40 мс
  // с перекрытием 50%; очередное окно берётся из исходника около "положенного"
  // места (k · шаг · speed), сдвинутое в пределах ±12 мс так, чтобы форма
  // волны лучше всего продолжала предыдущее окно — поэтому речь не
  // "булькает" и тон не меняется. Похожесть ищется грубо (по каждому 4-му
  // отсчёту), затем уточняется до отсчёта.
  stretch(buffer, speed) {
    const sr = buffer.sampleRate;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const len = buffer.length;
    const mono = new Float32Array(len);
    for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length;

    const N = 2 * Math.round(0.02 * sr); // окно 40 мс
    const Hs = N / 2; // шаг выхода
    const Ha = Hs * speed; // шаг входа
    const tol = Math.round(0.012 * sr); // поиск ±12 мс
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

    const outLen = Math.ceil(len / speed) + N;
    const out = channels.map(() => new Float32Array(outLen));
    const maxPos = len - N;
    const similarity = (a, b, step) => {
      let sum = 0;
      for (let i = 0; i < N; i += step) sum += mono[a + i] * mono[b + i];
      return sum;
    };
    let prev = 0;
    for (let k = 0; k * Hs < outLen - N; k++) {
      // Центр окна выхода (k·Hs + N/2) должен соответствовать центру окна
      // входа ((k·Hs + N/2)·speed) — иначе звук разъедется с картинкой.
      const nominal = Math.max(0, Math.round(k * Ha + (N / 2) * (speed - 1)));
      if (nominal > maxPos) break;
      let pos = nominal;
      if (k > 0) {
        // Естественное продолжение предыдущего окна — prev + Hs.
        const natural = Math.min(prev + Hs, maxPos);
        const lo = Math.max(0, nominal - tol);
        const hi = Math.min(maxPos, nominal + tol);
        let best = nominal;
        let bestScore = -Infinity;
        for (let d = lo; d <= hi; d += 4) {
          const s = similarity(natural, d, 4);
          if (s > bestScore) [bestScore, best] = [s, d];
        }
        pos = best;
        for (let d = Math.max(lo, best - 3); d <= Math.min(hi, best + 3); d++) {
          const s = similarity(natural, d, 1);
          if (s > bestScore) [bestScore, pos] = [s, d];
        }
      }
      const at = k * Hs;
      for (let c = 0; c < channels.length; c++) {
        const src = channels[c];
        const dst = out[c];
        for (let i = 0; i < N; i++) dst[at + i] += src[pos + i] * win[i];
      }
      prev = pos;
    }
    const result = this.context().createBuffer(channels.length, outLen, sr);
    out.forEach((data, c) => result.copyToChannel(data, c));
    return result;
  },

  // Задержка между часами звука и тем, что реально слышно из динамиков.
  latency() {
    const ctx = this.context();
    return ctx.outputLatency || ctx.baseLatency || 0;
  },

  // Слышимое сейчас время (часы звука минус задержка вывода).
  now() {
    return this.context().currentTime - this.latency();
  },
};
