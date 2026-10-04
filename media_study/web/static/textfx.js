// Появление текста по всему приложению (кроме редактора – там важна
// скорость): новый или изменившийся текст проявляется посимвольно, каждая
// буква вырастает снизу ("из-под земли") – как "Отмена?" на занятых кнопках.
//
// Как устроено. MutationObserver следит за всей страницей; "лист" – элемент,
// в котором только текст (подпись, статус, число, ячейка таблицы):
//   - текст листа поменялся (setNote, textContent, процент переноса) –
//     анимируется только изменившийся хвост: общее начало остаётся как было
//     ("Перенос на D: …: 82%" -> "…: 83%" – вырастает только "3");
//   - контейнер перерисовали целиком (innerHTML: списки обновляются каждые
//     несколько секунд, окно подробностей – свежими данными) – старые и новые
//     листья сопоставляются по ключу (ближайший предок с data-key / data-id /
//     href / id + путь до листа); тот же текст – без анимации, другой –
//     анимируется отличие, совсем новый лист – появляется целиком;
//   - на время анимации буквы обёрнуты в <span>, после – текст снова простой.
//
// Не трогается: редактор, поля ввода, svg/canvas, числа, которые и так
// плавно считаются (progress-count), буквы занятых кнопок (.flip), и всё,
// что помечено классом no-fx. За один раз анимируется не больше MAX_CHARS
// букв – огромные таблицы появляются без неё (иначе тормозило бы).
const TextFx = {
  EXCLUDE: "#view-editor, #fraglist, #text-panel, #video-wrap, input, textarea, select, option, script, style, svg, canvas, " +
    "[contenteditable], .no-fx, .flip, .progress-count, .picker-list",
  MAX_LEAF: 160, // длиннее – без анимации (абзацы, длинные пути)
  MAX_CHARS: 3000, // за одну пачку изменений
  STEP_MS: 14, // задержка между буквами
  MAX_SPREAD_MS: 320, // вся строка вырастает не дольше этого
  GROW_MS: 260,
  observer: null,

  start() {
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
  },

  // Лист: только текст (или уже обёрнутый нами текст).
  isLeaf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.dataset.fx) return true;
    if (!el.firstChild) return false;
    for (const n of el.childNodes) if (n.nodeType !== 3) return false;
    return true;
  },

  excluded(el) {
    return !el.isConnected || !!el.closest(this.EXCLUDE) || !!(el.parentElement && el.parentElement.closest("[data-fx]"));
  },

  // Ключ листа внутри перерисованного узла top: ближайший "именованный"
  // предок (data-key / data-id / href / id) или topKey (контейнер + номер
  // узла среди удалённых/добавленных) – и путь от него до листа. Одинаково
  // считается и для старых (уже отцепленных) узлов, и для новых.
  keyOf(el, top, topKey) {
    const parts = [];
    let node = el;
    while (node) {
      const named = node.dataset && (node.dataset.key || node.dataset.id || (node.tagName === "A" && node.getAttribute("href")) || node.id);
      if (named) return [`#${named}`, ...parts.reverse()].join("/");
      if (node === top) return [topKey, ...parts.reverse()].join("/");
      const index = Array.prototype.indexOf.call(node.parentNode.children, node);
      parts.push(`${node.tagName}.${typeof node.className === "string" ? node.className : ""}:${index}`);
      node = node.parentNode;
    }
    return [topKey, ...parts.reverse()].join("/");
  },

  leavesIn(node) {
    if (node.nodeType !== 1) return [];
    const out = this.isLeaf(node) ? [node] : [];
    node.querySelectorAll("*").forEach((el) => this.isLeaf(el) && out.push(el));
    return out;
  },

  onMutations(records) {
    const old = new Map(); // ключ -> прежний текст (из удалённых узлов)
    const touched = new Map(); // лист -> прежний текст (или undefined – новый)
    let budget = this.MAX_CHARS;
    for (const r of records) {
      if (r.type === "characterData") {
        const el = r.target.parentElement;
        if (el && this.isLeaf(el) && !touched.has(el)) touched.set(el, el.__fxText ?? r.oldValue ?? "");
        continue;
      }
      const target = r.target;
      // Текст листа заменили целиком (textContent = …).
      if (this.isLeaf(target)) {
        if (!touched.has(target)) {
          const removed = [...r.removedNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join("");
          touched.set(target, target.__fxText ?? removed);
        }
        continue;
      }
      // Контейнер перерисовали: запомнить тексты удалённых листьев по ключам.
      const rootKey = `${target.id || target.className || target.tagName}`;
      [...r.removedNodes].forEach((n, i) => this.leavesIn(n).forEach((leaf) =>
        old.set(this.keyOf(leaf, n, `${rootKey}:${i}`), leaf.__fxText ?? leaf.textContent)));
      [...r.addedNodes].forEach((n, i) => this.leavesIn(n).forEach((leaf) => {
        if (!touched.has(leaf)) touched.set(leaf, { key: this.keyOf(leaf, n, `${rootKey}:${i}`) });
      }));
    }
    for (const [el, prev] of touched) {
      if (this.excluded(el)) continue;
      const text = el.dataset.fx ? el.__fxText : el.textContent;
      let before = prev;
      if (prev && typeof prev === "object") before = old.has(prev.key) ? old.get(prev.key) : "";
      if (before === text || !text.trim() || text.length > this.MAX_LEAF) {
        el.__fxText = text;
        continue;
      }
      // Общее начало остаётся, анимируется изменившийся хвост.
      let common = 0;
      while (common < before.length && common < text.length && before[common] === text[common]) common++;
      // Не резать слово посередине: начало – до ближайшего пробела слева.
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

  animate(el, text, from) {
    el.__fxText = text;
    el.dataset.fx = "1";
    const frag = document.createDocumentFragment();
    if (from > 0) frag.append(text.slice(0, from));
    const tail = text.slice(from);
    const chars = [...tail.replace(/\s/g, "")].length || 1;
    const step = Math.min(this.STEP_MS, this.MAX_SPREAD_MS / chars);
    let k = 0;
    for (const token of tail.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        frag.append(token);
        continue;
      }
      // Слово – одним блоком (буквы-блоки иначе переносились бы посреди слова).
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
    el.replaceChildren(frag);
    clearTimeout(el.__fxTimer);
    el.__fxTimer = setTimeout(() => {
      // Анимация прошла – обратно простой текст (если его тем временем не сменили).
      if (el.dataset.fx && el.__fxText === text) {
        el.textContent = text; // наблюдатель увидит тот же текст – не анимирует
        delete el.dataset.fx;
      }
    }, k * step + this.GROW_MS + 80);
  },
};
document.addEventListener("DOMContentLoaded", () => TextFx.start());
