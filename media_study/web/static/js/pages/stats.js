// Раздел «Статистика»: расходы, сводка, скорость правки, авторы.

// Скорость правки (результаты таймера в редакторе): итоги, лучшая/средняя/
// медиана, последняя против средней, прогноз оставшейся правки, график по
// результатам и разбивка по видео. remaining – сколько фрагментов ещё не
// отредактировано во всех видео.
const speedOf = (r) => (r.ms ? r.frags / (r.ms / 60000) : 0); // фрагментов в минуту

const formatMinutes = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};

const shortDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

// Горизонтальные столбцы для статистики: строки {label, href, segs:[{value,
// cls, title}], text} – длина по сумме сегментов (самая длинная – во всю
// ширину), справа – подпись значения.
function hbars(items, legend = "") {
  const total = (i) => i.segs.reduce((acc, x) => acc + (x.value || 0), 0);
  const max = Math.max(0, ...items.map(total)) || 1;
  return `<div class="hbars">${legend ? `<div class="hbar-legend">${legend}</div>` : ""}${items.map((i) => {
    const label = i.href ? `<a href="${i.href}">${escapeHtml(i.label)}</a>` : escapeHtml(i.label);
    return `<div class="hbar-row"><div class="hbar-label" title="${escapeHtml(i.label)}">${label}</div><div class="hbar-track"><div class="hbar-fill">` +
      i.segs.map((x) => `<div class="hbar-seg ${x.cls || ""}" style="width:${((x.value || 0) / max * 100).toFixed(2)}%" title="${escapeHtml(x.title || "")}"></div>`).join("") +
      `</div></div><div class="hbar-value">${i.text}</div></div>`;
  }).join("") || '<p class="muted small">Нет данных</p>'}</div>`;
}

// Таблица статистики, которая не вылезает за блок: ширина колонок по долям –
// первая (название) занимает nameUnits долей, каждая из остальных n – одну.
// Длинное название обрезается многоточием (целиком – в подсказке).
function fitCols(nameUnits, n) {
  const unit = 100 / (nameUnits + n);
  return `<colgroup><col style="width:${(unit * nameUnits).toFixed(3)}%">${`<col style="width:${unit.toFixed(3)}%">`.repeat(n)}</colgroup>`;
}

const legendItem = (cls, text) => `<span class="hbar-key"><i class="hbar-seg ${cls}"></i>${text}</span>`;

// Название результата таймера: видео или пометка для замеров без видео.
const resultTitle = (r) => r.title || "Без видео (замер из чата)";

// График скорости правки: линия по результатам (по порядку сохранения) с
// заливкой, точки (лучшая – зелёная), средняя – пунктиром, сетка с подписями.
// Рисуется по настоящей ширине блока (точки не растягиваются).
function drawSpeedChart(box, list, avg) {
  const W = Math.max(320, box.clientWidth);
  const H = 230;
  const pad = { l: 44, r: 16, t: 16, b: 30 };
  const speeds = list.map(speedOf);
  const max = Math.max(...speeds, avg) * 1.18 || 1;
  const x = (k) => pad.l + (list.length === 1 ? (W - pad.l - pad.r) / 2 : (k / (list.length - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const pts = speeds.map((v, k) => [x(k), y(v)]);
  // Плавная линия (Catmull-Rom -> кривые Безье).
  let line = `M${pts[0][0]},${pts[0][1]}`;
  for (let k = 1; k < pts.length; k++) {
    const p0 = pts[k - 2] || pts[k - 1];
    const p1 = pts[k - 1];
    const p2 = pts[k];
    const p3 = pts[k + 1] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    line += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  const area = `${line} L${pts[pts.length - 1][0]},${H - pad.b} L${pts[0][0]},${H - pad.b} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max / 1.18 * t);
  const grid = ticks.map((v) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>` +
    `<text class="axis" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`).join("");
  const best = speeds.indexOf(Math.max(...speeds));
  // Без точек (так чище): подсказка о результате – при наведении на его полосу графика.
  const half = list.length > 1 ? (W - pad.l - pad.r) / (list.length - 1) / 2 : (W - pad.l - pad.r) / 2;
  const dots = list.map((r, k) => `<rect class="hover-band" x="${pts[k][0] - half}" y="${pad.t}" width="${half * 2}" height="${H - pad.t - pad.b}">` +
    `<title>${escapeHtml(shortDate(r.saved_at))} · ${escapeHtml(resultTitle(r))}\n${speedOf(r).toFixed(2)}/мин – ${r.frags} фрагм. за ${formatMinutes(r.ms)}${k === best ? " (лучший)" : ""}</title></rect>`).join("");
  const labels = list.length > 1
    ? `<text class="axis" x="${x(0)}" y="${H - 8}">${escapeHtml(shortDate(list[0].saved_at))}</text>` +
      `<text class="axis" x="${x(list.length - 1)}" y="${H - 8}" text-anchor="end">${escapeHtml(shortDate(list[list.length - 1].saved_at))}</text>`
    : "";
  box.innerHTML = `<svg class="speed-line" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="speed-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#79b8ff" stop-opacity="0.35"/><stop offset="1" stop-color="#79b8ff" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="area" d="${area}"/><path class="line" d="${line}" pathLength="1"/>
    <line class="avg" x1="${pad.l}" x2="${W - pad.r}" y1="${y(avg)}" y2="${y(avg)}"/>
    <text class="avg-label" x="${W - pad.r}" y="${y(avg) - 6}" text-anchor="end">средняя ${avg.toFixed(2)}/мин</text>
    ${dots}${labels}</svg>`;
}

// Вкладка "Скорость правки": итоги, график, разбивка по видео.
function speedTab(results, remaining) {
  if (!results || !results.length) {
    return '<p class="muted small">Результатов пока нет – запустите таймер над видео в редакторе и сохраните результат (иконка рядом со скоростью).</p>';
  }
  const list = [...results].sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at))); // старые – первыми
  const totalMs = list.reduce((acc, r) => acc + r.ms, 0);
  const totalFrags = list.reduce((acc, r) => acc + r.frags, 0);
  const avg = totalMs ? totalFrags / (totalMs / 60000) : 0; // взвешенная по времени
  const speeds = list.map(speedOf);
  const best = list[speeds.indexOf(Math.max(...speeds))];
  const sorted = [...speeds].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const last = list[list.length - 1];
  const vsAvg = avg ? Math.round(((speedOf(last) - avg) / avg) * 100) : 0;
  const sp = (v) => `${v.toFixed(2)}/мин <span class="muted small">(${Math.round(v * 60)}/ч)</span>`;
  const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
  const left = [row("Результатов", list.length), row("Всего времени", formatMinutes(totalMs)),
    row("Всего фрагментов", totalFrags.toLocaleString("ru-RU")), row("Средняя скорость", sp(avg))].join("");
  const right = [
    row("Лучшая", `${sp(speedOf(best))} <span class="muted small">· ${shortDate(best.saved_at)}</span>`),
    row("Медиана", sp(median)),
    row("Последняя", `${sp(speedOf(last))} <span class="${vsAvg >= 0 ? "ok-text" : "flagged-text"} small">${vsAvg >= 0 ? "+" : ""}${vsAvg}% к средней</span>`),
    row("Осталось править", remaining && avg ? `${remaining.toLocaleString("ru-RU")} фрагм. ≈ ${formatMinutes((remaining / avg) * 60000)}` : "–"),
  ].join("");
  const byVideo = new Map();
  for (const r of list) {
    const key = resultTitle(r);
    const v = byVideo.get(key) || { n: 0, ms: 0, frags: 0 };
    v.n += 1;
    v.ms += r.ms;
    v.frags += r.frags;
    byVideo.set(key, v);
  }
  const videos = [...byVideo.entries()].map(([title, v]) => ({ title, ...v, speed: v.frags / (v.ms / 60000) }))
    .sort((a, b) => b.speed - a.speed);
  return `<div class="tab-head"><span class="muted small">Результаты таймера в редакторе (иконка сохранения рядом со скоростью)</span>
      <button id="speed-all" class="step-btn">Все результаты (${list.length})</button></div>
    <div class="disk-grid"><table class="stats">${left}</table><table class="stats">${right}</table></div>
    <div id="speed-chart" class="chart-box"></div>
    <h3 class="tab-sub">Скорость по видео</h3>
    ${hbars(videos.map((v) => ({ label: v.title, segs: [{ value: v.speed, cls: "c-blue", title: `${v.frags} фрагм. за ${formatMinutes(v.ms)}` }],
      text: `${v.speed.toFixed(2)}/мин` })))}
    <table class="stats grid-table fit-table">${fitCols(3, 4)}<tr><th>Видео</th><th>Результатов</th><th>Время</th><th>Фрагментов</th><th>Скорость</th></tr>
    ${videos.map((v) => `<tr><td title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</td><td>${v.n}</td><td>${formatMinutes(v.ms)}</td>` +
      `<td>${v.frags.toLocaleString("ru-RU")}</td><td><b>${v.speed.toFixed(2)}/мин</b></td></tr>`).join("")}
    <tr class="total-row"><td>Итого</td><td>${list.length}</td><td>${formatMinutes(totalMs)}</td><td>${totalFrags.toLocaleString("ru-RU")}</td><td><b>${avg.toFixed(2)}/мин</b></td></tr></table>`;
}

// Окно со всеми результатами таймера (новые – первыми): удалить лишние.
// Закрыли окно, что-то удалив, – статистика перерисовывается (onChange).
function resultsModal(results, onChange) {
  let changed = false;
  const list = [...results].sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  const body = Modal.show(`<h2 class="modal-title">Результаты таймера</h2>
    <table class="stats grid-table results-list"><tr><th>Дата</th><th>Видео</th><th>Время</th><th>Фрагментов</th><th>Скорость</th><th></th></tr>
    ${list.map((r) => `<tr data-id="${escapeHtml(r.id)}"><td>${escapeHtml(shortDate(r.saved_at))}</td>` +
      `<td>${escapeHtml(r.title || "Не указано")}${r.note ? ` <span class="muted small">(${escapeHtml(r.note)})</span>` : ""}</td>` +
      `<td>${formatMinutes(r.ms)}</td><td>${r.frags}</td><td>${speedOf(r).toFixed(2)}/мин</td>` +
      `<td><button class="step-btn result-del">Удалить</button></td></tr>`).join("")}
    </table>`, () => changed && onChange());
  body.querySelectorAll(".result-del").forEach((button) => button.addEventListener("click", async () => {
    const tr = button.closest("tr");
    button.disabled = true;
    try {
      await Api.deleteTimerResult(tr.dataset.id);
    } catch (_) {
      button.disabled = false;
      return;
    }
    changed = true;
    tr.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).onfinish = () => tr.remove();
  }));
}

// Строка "Потрачено": всего и по видам (OpenRouter).
function spentLine(costs) {
  const c = costs || {};
  const money = (x) => `$${(Number(x) || 0).toFixed(2)}`;
  const total = costTotal(c);
  return `${money(total)} всего (${money(c.search)} поиск, ${money(translateCost(c))} перевод и доводка)`;
}

// Сумма расходов видео.
const costTotal = (c) => (c && ((c.search || 0) + (c.fix || 0) + (c.translate || 0) + (c.retranslate || 0))) || 0;

// "Перевод и доводка": перевод, повторный перевод (доводка по флагам) и ИИ-доводка текста – одной суммой.
const translateCost = (c) => (c && ((c.translate || 0) + (c.retranslate || 0) + (c.fix || 0))) || 0;

Object.assign(Pages, {
  // -- статистика ------------------------------------------------------------------
  // Итоги по всем видео: расходы OpenRouter, правка, Anki, перевод, место;
  // ниже – расходы по видео и сводка по авторам.
  async stats() {
    const el = document.getElementById("view-stats");
    el.innerHTML = "";
    let data;
    try {
      data = await Api.overallStats();
      data.results = await Api.timerResults().catch(() => []);
    } catch (err) {
      el.innerHTML = `<h1>Статистика</h1><p class="muted">Не удалось загрузить: ${escapeHtml(err.message)}</p>`;
      return;
    }
    // Только медиа текущего режима (видео или аудио).
    const audioMode = Mode.kind === "audio";
    const all = data.videos.filter((v) => !!v.audio_only === audioMode);
    const ids = new Set(all.map((v) => v.id));
    data.results = (data.results || []).filter((r) => (r.project ? ids.has(r.project) : !audioMode));
    const ready = all.filter((v) => v.state === "ready");
    const sum = (list, f) => list.reduce((s, v) => s + (Number(f(v)) || 0), 0);
    const money = (x) => `$${(Number(x) || 0).toFixed(2)}`;
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "0%");
    const num = (n) => Number(n || 0).toLocaleString("ru-RU");
    const edited = (v) => { const e = v.edit_bar || {}; return (e.accepted || 0) + (e.unvoiced || 0) + (e.changed || 0) + (e.deleted || 0); };
    const kinds = { search: "Поиск источников", translate: "Перевод и доводка" };
    const kindOf = (c, k) => (k === "translate" ? translateCost(c) : c[k] || 0);
    const kindTotal = (k, list = all) => sum(list, (v) => kindOf(v.costs, k));
    const spentVideos = sum(all, (v) => costTotal(v.costs));
    // Итог – по счётчику OpenRouter (если доступен): туда входят и расходы не
    // по видео (эксперименты, проверки, траты до появления учёта).
    const usage = data.openrouter_usage;
    // Счётчик OpenRouter – общий на всё; в режиме "Аудио" – только расходы по аудио.
    const spentAll = !audioMode && usage !== null && usage !== undefined ? Math.max(usage, spentVideos) : spentVideos;
    const other = spentAll - spentVideos;
    const cards = sum(ready, (v) => v.cards_total);
    const translated = sum(ready, (v) => v.translated);
    const barTotal = sum(ready, (v) => v.bar_total || v.fragments_total);
    const editedAll = sum(ready, edited);
    const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`;
    const card = (title, rows) => `<section class="set-card"><h2>${title}</h2><table class="stats">${rows.join("")}</table></section>`;

    // Расходы по видео – дорогие сверху; итог внизу.
    const byCost = [...all].filter((v) => costTotal(v.costs) > 0 || v.state === "ready").sort((a, b) => costTotal(b.costs) - costTotal(a.costs));
    const costRows = byCost.map((v) =>
      `<tr><td><a href="#/${v.state === "ready" ? "video" : "process"}/${encodeURIComponent(v.id)}">${escapeHtml(v.title)}</a></td>` +
      Object.keys(kinds).map((k) => `<td>${money(kindOf(v.costs, k))}</td>`).join("") +
      `<td><b>${money(costTotal(v.costs))}</b></td></tr>`).join("");

    // По авторам.
    const groups = new Map();
    for (const v of all) {
      if (!groups.has(v.group)) groups.set(v.group, []);
      groups.get(v.group).push(v);
    }
    const groupRows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([group, list]) => {
      const r = list.filter((v) => v.state === "ready");
      return `<tr><td>${escapeHtml(group)}</td><td>${list.length}</td><td>${formatDuration(sum(list, (v) => v.duration))}</td>` +
        `<td>${pct(sum(r, edited), sum(r, (v) => v.bar_total || v.fragments_total))}</td>` +
        `<td>${num(sum(r, (v) => v.in_anki))}</td><td>${num(sum(r, (v) => v.translated))}</td>` +
        `<td>${money(sum(list, (v) => costTotal(v.costs)))}</td><td>${formatSize(sum(list, (v) => v.disk_total))}</td></tr>`;
    }).join("");

    // Показатели медиа – для вкладки "Информация" (график и сортировка) и "Авторы".
    const metrics = [
      { key: "duration", label: "Длительность", get: (v) => v.duration || 0, fmt: (x) => formatDuration(x) },
      { key: "fragments", label: "Фрагментов", get: (v) => v.fragments_total || 0, fmt: num },
      { key: "edited", label: "Ред., %", get: (v) => (v.bar_total ? (edited(v) / v.bar_total) * 100 : 0), fmt: (x) => `${Math.round(x)}%` },
      { key: "anki", label: "В Anki", get: (v) => v.in_anki || 0, fmt: num },
      { key: "translated", label: "Переведено", get: (v) => v.translated || 0, fmt: num },
      { key: "editor", label: "В редакторе", get: (v) => v.editor_seconds || 0, fmt: (x) => formatMinutes(x * 1000) },
      { key: "cost", label: "Потрачено", get: (v) => costTotal(v.costs), fmt: money },
      { key: "disk", label: "Место на диске", get: (v) => v.disk_total || 0, fmt: (x) => formatSize(x) },
    ];
    const metricOf = (k) => metrics.find((m) => m.key === k) || metrics[0];
    const ui = (this.statsUi ||= { tab: "costs", infoMetric: "duration", sort: "duration", dir: -1, authorMetric: "duration" });
    const mediaLink = (v) => `#/${v.state === "ready" ? (v.audio_only ? "audio" : "video") : "process"}/${encodeURIComponent(v.id)}`;

    const tabs = {
      costs: {
        label: "Расходы",
        html: () => {
          const byCost = [...all].filter((v) => costTotal(v.costs) > 0).sort((a, b) => costTotal(b.costs) - costTotal(a.costs));
          return hbars(byCost.map((v) => ({
            label: v.title, href: mediaLink(v),
            segs: [{ value: v.costs.search || 0, cls: "c-blue", title: `Поиск источников: ${money(v.costs.search)}` },
              { value: translateCost(v.costs), cls: "c-pink", title: `Перевод и доводка: ${money(translateCost(v.costs))}` }],
            text: `<b>${money(costTotal(v.costs))}</b>`,
          })), legendItem("c-blue", "Поиск источников") + legendItem("c-pink", "Перевод и доводка")) +
            `<table class="stats grid-table fit-table">${fitCols(3, Object.keys(kinds).length + 1)}<tr><th>${audioMode ? "Аудио" : "Видео"}</th>${Object.values(kinds).map((k) => `<th>${k}</th>`).join("")}<th>Всего</th></tr>
            ${byCost.map((v) => `<tr><td title="${escapeHtml(v.title)}"><a href="${mediaLink(v)}">${escapeHtml(v.title)}</a></td>` +
              Object.keys(kinds).map((k) => `<td>${money(kindOf(v.costs, k))}</td>`).join("") + `<td><b>${money(costTotal(v.costs))}</b></td></tr>`).join("")}
            <tr class="total-row"><td>Итого</td>${Object.keys(kinds).map((k) => `<td>${money(kindTotal(k))}</td>`).join("")}<td><b>${money(spentVideos)}</b></td></tr></table>`;
        },
      },
      info: {
        label: "Информация",
        html: () => {
          const m = metricOf(ui.infoMetric);
          const chart = [...all].sort((a, b) => m.get(b) - m.get(a));
          const s2 = metricOf(ui.sort);
          const rows = [...all].sort((a, b) => ui.sort === "title"
            ? ui.dir * String(a.title).localeCompare(String(b.title)) : ui.dir * (s2.get(a) - s2.get(b)));
          const th = (key, label) => `<th class="sortable${ui.sort === key ? " sorted" : ""}" data-sort="${key}">${label}${ui.sort === key ? (ui.dir < 0 ? " ↓" : " ↑") : ""}</th>`;
          return `<div class="tab-head"><span class="field-label">График по</span><div class="picker-host" data-for="info-metric"></div></div>` +
            hbars(chart.map((v) => ({ label: v.title, href: mediaLink(v), segs: [{ value: m.get(v), cls: "c-blue" }], text: m.fmt(m.get(v)) }))) +
            `<table class="stats grid-table info-table fit-table">${fitCols(3, metrics.length)}<tr>${th("title", audioMode ? "Аудио" : "Видео")}${metrics.map((x) => th(x.key, x.label)).join("")}</tr>` +
            rows.map((v) => `<tr><td title="${escapeHtml(v.title)}"><a href="${mediaLink(v)}">${escapeHtml(v.title)}</a></td>${metrics.map((x) => `<td>${x.fmt(x.get(v))}</td>`).join("")}</tr>`).join("") +
            "</table>";
        },
      },
      speed: { label: "Скорость правки", html: () => speedTab(data.results, Math.max(0, barTotal - editedAll)) },
      authors: {
        label: audioMode ? "Исполнители" : "Авторы",
        html: () => {
          const groups = new Map();
          for (const v of all) {
            if (!groups.has(v.group)) groups.set(v.group, []);
            groups.get(v.group).push(v);
          }
          // Для автора – сумма по его медиа (отредактировано – общей долей).
          const agg = (list, m) => (m.key === "edited"
            ? (sum(list, (v) => v.bar_total) ? (sum(list, edited) / sum(list, (v) => v.bar_total)) * 100 : 0)
            : sum(list, m.get));
          const m = metricOf(ui.authorMetric);
          const entries = [...groups.entries()].sort((a, b) => agg(b[1], m) - agg(a[1], m));
          return `<div class="tab-head"><span class="field-label">График по</span><div class="picker-host" data-for="author-metric"></div></div>` +
            hbars(entries.map(([g, list]) => ({ label: g, segs: [{ value: agg(list, m), cls: "c-violet" }], text: m.fmt(agg(list, m)) }))) +
            `<table class="stats grid-table fit-table">${fitCols(2, metrics.length + 1)}<tr><th>${audioMode ? "Исполнитель" : "Автор"}</th><th>${audioMode ? "Аудио" : "Видео"}</th>${metrics.map((x) => `<th>${x.label}</th>`).join("")}</tr>` +
            entries.map(([g, list]) => `<tr><td title="${escapeHtml(g)}">${escapeHtml(g)}</td><td>${list.length}</td>${metrics.map((x) => `<td>${x.fmt(agg(list, x))}</td>`).join("")}</tr>`).join("") +
            "</table>";
        },
      },
    };
    if (!tabs[ui.tab]) ui.tab = "costs";

    el.innerHTML = `<h1>Статистика</h1>
      <div class="page-grid stats-grid">
        ${card("Расходы", [
          row("Всего", `<b>${money(spentAll)}</b>`),
          ...Object.entries(kinds).map(([k, name]) => row(name, money(kindTotal(k)))),
          ...(other >= 0.005 ? [row("Прочее (не по видео)", money(other))] : []),
        ])}
        ${card(audioMode ? "Аудио" : "Видео", [
          row("Готово к правке", num(ready.length)),
          row("В обработке и ждут", num(all.length - ready.length)),
          row("Длительность", formatDuration(sum(all, (v) => v.duration))),
          row("Место на дисках", formatSize(sum(all, (v) => v.disk_total))),
        ])}
        ${card("Правка", [
          row("Фрагментов", num(sum(ready, (v) => v.fragments_total))),
          row("Отредактировано", `${num(editedAll)} (${pct(editedAll, barTotal)})`),
          row("Изменено", num(sum(ready, (v) => (v.edit_bar || {}).changed))),
          row("Удалено", num(sum(ready, (v) => v.deleted_total))),
        ])}
        ${card("Anki и перевод", [
          row("Карточек с текстом", num(cards)),
          row("В Anki", `${num(sum(ready, (v) => v.in_anki))} (${pct(sum(ready, (v) => v.in_anki), sum(ready, (v) => v.active_total))})`),
          row("Переведено", `${num(translated)} (${pct(translated, cards)})`),
          row("Вернулись на правку", num(sum(ready, (v) => v.flagged))),
        ])}
        <section class="set-card wide-card stats-tabs">
          <div class="seg-switch tab-bar">${Object.entries(tabs).map(([k, t]) => `<button data-k="${k}" class="${k === ui.tab ? "active" : ""}">${t.label}</button>`).join("")}</div>
          <div id="stats-tab"></div>
        </section>
      </div>`;

    // Содержимое вкладки (переключение – без перезагрузки страницы).
    const panel = el.querySelector("#stats-tab");
    const showTab = async (animate = true) => {
      const from = panel.offsetHeight;
      if (animate) {
        // Сначала пусто, содержимое – следующим шагом (до отрисовки кадра):
        // тогда текст для анимации букв – новый, даже если он тот же самый.
        panel.replaceChildren();
        await Promise.resolve();
      }
      panel.innerHTML = tabs[ui.tab].html();
      if (animate) {
        [...panel.children].forEach((child, i) => {
          child.style.setProperty("--i", i);
          child.classList.add("enter");
          const done = (e) => {
            if (e.target !== child) return;
            child.classList.remove("enter");
            child.removeEventListener("animationend", done);
          };
          child.addEventListener("animationend", done);
        });
        // Высота блока – плавно от прежней к новой.
        const to = panel.offsetHeight;
        if (from && Math.abs(to - from) > 1) {
          panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 350, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" });
        }
      }
      if (ui.tab === "speed" && data.results.length) {
        const list = [...data.results].sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at)));
        const ms = list.reduce((acc, r) => acc + r.ms, 0);
        drawSpeedChart(panel.querySelector("#speed-chart"), list, ms ? list.reduce((acc, r) => acc + r.frags, 0) / (ms / 60000) : 0);
        panel.querySelector("#speed-all").addEventListener("click", () => resultsModal(data.results, () => this.stats()));
      }
      const metricPicker = (id, key) => {
        const host = panel.querySelector(`.picker-host[data-for="${id}"]`);
        if (!host) return;
        Picker.create(host, {
          id, value: ui[key], options: metrics.map((m) => ({ value: m.key, label: m.label })),
          onChange: (value) => {
            ui[key] = value;
            showTab();
          },
        });
      };
      metricPicker("info-metric", "infoMetric");
      metricPicker("author-metric", "authorMetric");
      panel.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
        ui.dir = ui.sort === th.dataset.sort ? -ui.dir : th.dataset.sort === "title" ? 1 : -1;
        ui.sort = th.dataset.sort;
        showTab();
      }));
    };
    el.querySelectorAll(".tab-bar button").forEach((b) => b.addEventListener("click", () => {
      ui.tab = b.dataset.k;
      el.querySelectorAll(".tab-bar button").forEach((x) => x.classList.toggle("active", x === b));
      showTab();
    }));
    viewEnter(el);
    showTab();
  },
});
