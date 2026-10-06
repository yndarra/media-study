// Язык интерфейса (английский) – слоем поверх страницы.
//
// Интерфейс написан по-русски; при языке "en" этот модуль подменяет русский
// текст на английский по словарю (i18n-en.js: "русская фраза" -> "перевод")
// по мере появления на странице – и в разметке, и в текстах от сервера
// (статусы, ошибки, этапы). Так не нужно переписывать каждое место в коде.
//
// Как ищется перевод (по порядку):
//   1. фраза целиком (пробелы по краям сохраняются);
//   2. фраза с числами: числа -> {0}, {1}… ("Свободно 95.1 ГБ" -> "Свободно {0} ГБ"),
//      по словарю – с теми же числами обратно ("Free {0} GB");
//   3. шаблоны словаря с подстановками ({0} – любой текст): "Перенос на {0}" и т.п.;
//   4. куски: в склеенной строке заменяются известные фразы (длинные – первыми).
// Чего нет в словаре – остаётся как есть и копится в I18n.missing (для
// пополнения словаря: tools/i18n_extract.py + обход приложения).
//
// Не переводится содержимое пользователя: элементы с атрибутом data-no-i18n
// (текст фрагмента, переводы карточек, журналы, поля ввода).
const I18n = {
  lang: "ru",
  exact: new Map(),
  patterns: [], // [{re, out}]
  pieces: [], // [[ru, en]] – длинные первыми
  cache: new Map(),
  missing: new Set(),
  CYR: /[А-Яа-яЁё]/,
  NUM: /\d+(?:[.,]\d+)?/g,
  // Пользовательское: текст фрагмента и соседей, переводы и комментарии агента, журналы, имена.
  SKIP: "[data-no-i18n], script, style, textarea, #cur-text, .ctx, .fxc, .log-body, .agent-back, .agent-en, .agent-diff, .agent-comments, .names-item, .fl-text, #context-preview, #source-preview",
  ATTRS: ["title", "placeholder", "aria-label"],

  init() {
    try {
      this.lang = localStorage.getItem("ui-lang") || "ru";
    } catch (_) {}
    document.documentElement.lang = this.lang;
    if (this.lang === "ru" || !window.I18N_DICT) return;
    for (const [ru, en] of Object.entries(window.I18N_DICT[this.lang] || {})) {
      if (!en) continue;
      if (/\{\d+\}/.test(ru)) {
        const parts = ru.split(/(\{\d+\})/);
        const order = [];
        const re = parts.map((p) => {
          const m = p.match(/^\{(\d+)\}$/);
          if (m) {
            order.push(Number(m[1]));
            return "(.+?)";
          }
          return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("");
        this.exact.set(ru, en); // и как точная фраза (форма с числами)
        this.patterns.push({ re: new RegExp(`^${re}$`, "s"), order, out: en, len: ru.length });
      } else {
        this.exact.set(ru, en);
        if (ru.length >= 6 && /\s/.test(ru)) this.pieces.push([ru, en]);
      }
    }
    this.patterns.sort((a, b) => b.len - a.len);
    this.pieces.sort((a, b) => b[0].length - a[0].length);
    this.translateTree(document.body);
    new MutationObserver((records) => this.onMutations(records))
      .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: this.ATTRS });
  },

  // Перевод строки (или она же, если перевода нет).
  tr(s) {
    if (this.lang === "ru" || !s || !this.CYR.test(s)) return s;
    if (this.cache.has(s)) return this.cache.get(s);
    const lead = s.match(/^\s*/)[0];
    const trail = s.slice(lead.length).match(/\s*$/)[0];
    const core = s.slice(lead.length, s.length - trail.length);
    let out = this.translateCore(core);
    if (out === null) {
      out = core;
      this.missing.add(core.replace(this.NUM, "{n}"));
    }
    const result = lead + out + trail;
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(s, result);
    return result;
  },

  translateCore(core) {
    // Многострочное (статус в две строки и т.п.) – по строкам, переносы сохраняются.
    if (core.includes("\n")) {
      const lines = core.split("\n");
      const out = lines.map((line) => (line.trim() && this.CYR.test(line) ? this.translateCore(line.trim()) : line));
      return out.some((x) => x === null) ? null : out.join("\n");
    }
    const flat = core.replace(/\s+/g, " ");
    if (this.exact.has(flat)) return this.exact.get(flat);
    // Числа -> {0}, {1}…
    const nums = [];
    const shape = flat.replace(this.NUM, (m) => `{${nums.push(m) - 1}}`);
    if (nums.length && this.exact.has(shape)) return this.exact.get(shape).replace(/\{(\d+)\}/g, (_, i) => nums[Number(i)] ?? "");
    for (const p of this.patterns) {
      const m = flat.match(p.re);
      if (!m) continue;
      const values = {};
      p.order.forEach((n, i) => (values[n] = this.translateCore(m[i + 1]) ?? m[i + 1]));
      return p.out.replace(/\{(\d+)\}/g, (_, i) => values[Number(i)] ?? "");
    }
    // Куски склеенной строки.
    let text = flat;
    for (const [ru, en] of this.pieces) if (text.includes(ru)) text = text.split(ru).join(en);
    return this.CYR.test(text) ? (text !== flat ? text : null) : text;
  },

  skip(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !el || !!el.closest(this.SKIP);
  },

  translateText(node) {
    if (this.skip(node)) return;
    const t = this.tr(node.data);
    if (t !== node.data) node.data = t;
  },

  translateAttrs(el) {
    if (el.closest(this.SKIP)) return;
    for (const a of this.ATTRS) {
      const v = el.getAttribute(a);
      if (v && this.CYR.test(v)) {
        const t = this.tr(v);
        if (t !== v) el.setAttribute(a, t);
      }
    }
  },

  translateTree(root) {
    if (root.nodeType === 3) return this.translateText(root);
    if (root.nodeType !== 1 || this.skip(root)) return;
    this.translateAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === 3) this.translateText(n);
      else this.translateAttrs(n);
    }
  },

  onMutations(records) {
    for (const r of records) {
      if (r.type === "characterData") this.translateText(r.target);
      else if (r.type === "attributes") this.translateAttrs(r.target);
      else r.addedNodes.forEach((n) => this.translateTree(n));
    }
  },

  // Сменить язык (настройки): запомнить и перезагрузить страницу.
  set(lang) {
    try {
      localStorage.setItem("ui-lang", lang);
    } catch (_) {}
    location.reload();
  },
};
I18n.init();
// Для кода, которому нужен перевод строки напрямую (диалоги, alert и т.п.).
const tr = (s) => I18n.tr(s);
