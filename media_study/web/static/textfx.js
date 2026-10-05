// Появление текста по всему приложению (кроме редактора – там важна
// скорость): новый или изменившийся текст проявляется посимвольно, каждая
// буква вырастает снизу ("из-под земли") – как "Отмена?" на занятых кнопках.
//
// Как устроено. MutationObserver следит за всей страницей. Единица
// анимации – "лист" (элемент, в котором только текст: подпись, статус,
// число, ячейка таблицы) или "строка" – элемент с атрибутом data-fx-line,
// внутри которого текст и простые <span> разного цвета (название медиа с
// длительностью): строка анимируется целиком, буквы идут подряд через все её
// части.
//   - текст поменялся (setNote, textContent, процент переноса) –
//     анимируется только изменившийся хвост: общее начало остаётся как было
//     ("…: 82%" -> "…: 83%" – вырастает только "83%");
//   - контейнер перерисовали целиком (innerHTML: списки обновляются каждые
//     несколько секунд, окно подробностей – свежими данными) – старые и новые
//     единицы сопоставляются по ключу (ближайший предок с data-key / data-id /
//     href / id или номер перерисованного узла + путь до единицы); тот же
//     текст – без анимации, другой – анимируется отличие, новый – целиком;
//   - текст, который не влезает и обрезается многоточием (text-overflow:
//     ellipsis, line-clamp), сначала обрезается так, как обрежет его CSS, и
//     анимируется уже обрезанный – ничего не вылезает за край;
//   - на время анимации буквы обёрнуты в <span>, после – прежняя разметка.
//
// Не трогается: редактор, поля ввода, svg/canvas, числа, которые и так
// плавно считаются (progress-count), буквы занятых кнопок (.flip), и всё,
// что помечено классом no-fx. За один раз анимируется не больше MAX_CHARS
// букв – огромные таблицы появляются без неё (иначе тормозило бы).
const TextFx = {
  EXCLUDE: "#view-editor, #fraglist, #text-panel, #video-wrap, input, textarea, select, option, script, style, svg, canvas, " +
    "[contenteditable], .no-fx, .flip, .progress-count, .picker-list",
  MAX_LEAF: 200, // длиннее – без анимации (абзацы, длинные пути)
  MAX_CHARS: 8000, // за одну пачку изменений
  STEP_MS: 14, // задержка между буквами
  MAX_SPREAD_MS: 320, // вся строка вырастает не дольше этого
  GROW_MS: 260,
  observer: null,

  start() {
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
  },

  // Лист: только текст (или уже обёрнутый нами); строка data-fx-line – тоже единица.
  isUnit(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.dataset.fx || el.hasAttribute("data-fx-line")) return true;
    if (!el.firstChild) return false;
    for (const n of el.childNodes) if (n.nodeType !== 3) return false;
    return true;
  },

  // Единица, к которой относится элемент: строка (если он внутри неё) или он сам.
  unitOf(el) {
    return (el && el.closest && el.closest("[data-fx-line]")) || el;
  },

  textOf(el) {
    return el.dataset.fx ? el.__fxText : el.textContent;
  },

  excluded(el) {
    return !el.isConnected || !!el.closest(this.EXCLUDE) || !!(el.parentElement && el.parentElement.closest("[data-fx]"));
  },

  // Ключ единицы внутри перерисованного узла top: ближайший "именованный"
  // предок (data-key / data-id / href / id) или topKey (контейнер + номер
  // узла среди удалённых/добавленных) – и путь от него. Одинаково считается
  // и для старых (уже отцепленных) узлов, и для новых.
  keyOf(el, top, topKey) {
    const parts = [];
    let node = el;
    while (node) {
      const named = node.dataset && (node.dataset.key || node.dataset.id || (node.tagName === "A" && node.getAttribute("href")) || node.id);
      if (named) return [`#${named}`, ...parts.reverse()].join("/");
      if (node === top || !node.parentNode) return [topKey, ...parts.reverse()].join("/");
      const index = Array.prototype.indexOf.call(node.parentNode.children, node);
      parts.push(`${node.tagName}.${typeof node.className === "string" ? node.className : ""}:${index}`);
      node = node.parentNode;
    }
    return [topKey, ...parts.reverse()].join("/");
  },

  unitsIn(node) {
    if (node.nodeType !== 1) return [];
    const out = new Set();
    if (this.isUnit(node)) out.add(this.unitOf(node));
    node.querySelectorAll("*").forEach((el) => this.isUnit(el) && out.add(this.unitOf(el)));
    return [...out];
  },

  onMutations(records) {
    const old = new Map(); // ключ -> прежний текст (из удалённых узлов)
    const touched = new Map(); // единица -> прежний текст или {key} (новая)
    let budget = this.MAX_CHARS;
    for (const r of records) {
      if (r.type === "characterData") {
        const el = r.target.parentElement && this.unitOf(r.target.parentElement);
        if (el && this.isUnit(el) && !touched.has(el)) touched.set(el, el.__fxText ?? r.oldValue ?? "");
        continue;
      }
      const target = r.target;
      // Текст единицы заменили (textContent = … / внутри строки).
      const unit = this.unitOf(target);
      if (this.isUnit(unit) && (unit === target || unit.contains(target))) {
        if (!touched.has(unit)) {
          const removed = [...r.removedNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join("");
          touched.set(unit, unit.__fxText ?? (unit === target ? removed : ""));
        }
        continue;
      }
      // Контейнер перерисовали: запомнить тексты удалённых единиц по ключам.
      const rootKey = `${target.id || (typeof target.className === "string" ? target.className : "") || target.tagName}`;
      [...r.removedNodes].forEach((n, i) => this.unitsIn(n).forEach((u) =>
        old.set(this.keyOf(u, n, `${rootKey}:${i}`), u.__fxText ?? u.textContent)));
      [...r.addedNodes].forEach((n, i) => this.unitsIn(n).forEach((u) => {
        if (!touched.has(u)) touched.set(u, { key: this.keyOf(u, n, `${rootKey}:${i}`) });
      }));
    }
    for (const [el, prev] of touched) {
      if (!el.isConnected || this.excluded(el)) continue;
      const text = this.textOf(el);
      let before = prev;
      if (prev && typeof prev === "object") before = old.has(prev.key) ? old.get(prev.key) : "";
      if (before === text || !text.trim() || text.length > this.MAX_LEAF) {
        el.__fxText = text;
        continue;
      }
      // Общее начало остаётся, анимируется изменившийся хвост (с начала слова).
      let common = 0;
      while (common < before.length && common < text.length && before[common] === text[common]) common++;
      while (common > 0 && !/\s/.test(text[common - 1])) common--;
      const grow = text.length - common;
      if (grow <= 0) continue;
      if ((budget -= grow) < 0) {
        el.__fxText = text;
        continue;
      }
      this.animate(el, text, common);
    }
    this.observer.takeRecords(); // свои же изменения (обёртка букв) – не разбирать
  },

  // Блок, который обрезает текст многоточием (сам элемент или его родитель).
  clipBox(el) {
    for (const box of [el, el.parentElement]) {
      if (!box) continue;
      const cs = getComputedStyle(box);
      if (cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none")) return box;
    }
    return null;
  },

  overflows(box) {
    return box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;
  },

  textNodes(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  },

  // Обрезать текст так, как его обрежет CSS (первые n букв + "…"); вернуть n.
  truncate(el, box) {
    const nodes = this.textNodes(el);
    const full = nodes.map((n) => n.data);
    const total = full.reduce((s, t) => s + t.length, 0);
    const apply = (n) => {
      let left = n;
      let lastShown = null;
      nodes.forEach((node, i) => {
        const take = Math.max(0, Math.min(full[i].length, left));
        node.data = full[i].slice(0, take);
        if (take > 0) lastShown = node;
        left -= take;
      });
      if (n < total && lastShown) lastShown.data = lastShown.data.replace(/\s+$/, "") + "…";
    };
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      apply(mid);
      if (this.overflows(box)) hi = mid - 1;
      else lo = mid;
    }
    apply(lo);
    return lo;
  },

  animate(el, text, from) {
    if (el.dataset.fx && el.__fxSaved !== undefined) el.innerHTML = el.__fxSaved; // прошлая анимация не закончилась
    el.__fxText = text;
    el.__fxSaved = el.innerHTML;
    el.dataset.fx = "1";
    // Не влезает – сначала обрезать, как обрежет CSS.
    const box = this.clipBox(el);
    if (box && this.overflows(box)) from = Math.min(from, this.truncate(el, box));
    const nodes = this.textNodes(el);
    const shownChars = nodes.reduce((s, n) => s + n.data.replace(/\s/g, "").length, 0) || 1;
    const step = Math.min(this.STEP_MS, this.MAX_SPREAD_MS / Math.max(1, shownChars));
    let g = 0; // номер буквы во всей единице
    let k = 0; // номер анимируемой буквы
    for (const node of nodes) {
      const data = node.data;
      const frag = document.createDocumentFragment();
      const keep = Math.max(0, Math.min(data.length, from - g));
      if (keep) frag.append(data.slice(0, keep));
      g += data.length;
      const tail = data.slice(keep);
      // Слово вместе с пробелом после него – одним блоком (буквы-блоки иначе
      // переносились бы посреди слова); пробел внутри – такая же "буква".
      // Пробелы в начале и конце и переводы строк – обычным текстом.
      const lead = tail.match(/^\s*/)[0];
      const trail = tail.slice(lead.length).match(/\s*$/)[0];
      if (lead) frag.append(lead);
      const body = tail.slice(lead.length, tail.length - trail.length);
      for (const token of body.match(/\S+[^\S\n]*|\n\s*/g) || []) {
        if (token.startsWith("\n")) {
          frag.append(token);
          continue;
        }
        const word = document.createElement("span");
        word.className = "fxw";
        for (const ch of token) {
          const span = document.createElement("span");
          span.className = "fxc";
          span.textContent = ch;
          span.style.animationDelay = `${Math.round(k++ * step)}ms`;
          word.append(span);
        }
        frag.append(word);
      }
      if (trail) frag.append(trail);
      node.replaceWith(frag);
    }
    clearTimeout(el.__fxTimer);
    el.__fxTimer = setTimeout(() => {
      // Анимация прошла – прежняя разметка (если текст тем временем не сменили).
      if (el.dataset.fx && el.__fxText === text) {
        el.innerHTML = el.__fxSaved; // наблюдатель увидит тот же текст – не анимирует
        delete el.dataset.fx;
        el.__fxSaved = undefined;
      }
    }, k * step + this.GROW_MS + 80);
  },
};
// Сразу (скрипт – в конце страницы): иначе первые отрисовки разделов шли до
// запуска наблюдателя, и часть текста появлялась без анимации "через раз".
TextFx.start();
