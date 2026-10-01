// Выпадающий список — свой, вместо системного <select> (тот не красится под
// тёмную тему и выглядит по-разному в разных местах). Один вид для всех:
// поле + кнопка-стрелка справа + список под полем.
//
//   editable: true  — в поле можно вписать своё (модели OpenRouter), список —
//                     подсказки; набор в поле фильтрует список;
//   editable: false — только выбор из списка (качество скачивания, фильтр
//                     фрагментов); клик по самому полю тоже открывает список.
//
// Значение лежит в <input id=...> (у неизменяемого — скрытом), поэтому formWatch
// (кнопки "Сохранить"/"Отменить") и сохранение читают его как обычное поле;
// выбор из списка шлёт события input/change.
//
// options: [{value, label, hint?, group?, count?}] — hint серым справа,
// group — заголовок группы (меняется — новый заголовок), count — число слева от
// подписи (фильтр фрагментов). Или load: async () => options — подгружается при
// первом открытии.
const Picker = {
  CHEVRON: '<svg viewBox="0 0 20 20"><path d="M6 8l4 4 4-4"/></svg>',

  create(host, { id, value = "", options = [], load = null, editable = false, placeholder = "", onChange = null }) {
    const root = document.createElement("div");
    root.className = `picker${editable ? " editable" : ""}`;
    root.innerHTML = editable
      ? `<input id="${id}" class="picker-field" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}">`
      : `<input id="${id}" type="hidden"><div class="picker-field picker-display" tabindex="0"></div>`;
    root.insertAdjacentHTML("beforeend",
      `<button type="button" class="picker-btn" tabindex="-1" title="Выбрать из списка">${this.CHEVRON}</button><div class="picker-list hidden"></div>`);
    host.appendChild(root);

    const input = root.querySelector("input");
    const display = root.querySelector(".picker-display");
    const list = root.querySelector(".picker-list");
    let items = options;
    let loaded = !load;

    const labelOf = (v) => {
      const item = items.find((o) => String(o.value) === String(v));
      return item ? item : null;
    };
    const showValue = () => {
      if (editable) return;
      const item = labelOf(input.value);
      display.innerHTML = item
        ? (item.count !== undefined ? `<span class="picker-count">${item.count}</span>` : "") + escapeHtml(item.label)
        : escapeHtml(input.value);
    };
    const renderList = (filter = "") => {
      const needle = filter.trim().toLowerCase();
      const shown = needle ? items.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(needle)) : items;
      let group = null;
      list.innerHTML = shown.map((o) => {
        const head = o.group && o.group !== group ? `<div class="picker-group">${escapeHtml(o.group)}</div>` : "";
        group = o.group || group;
        const active = String(o.value) === String(input.value) ? " active" : "";
        return head + `<div class="picker-item${active}" data-value="${escapeHtml(String(o.value))}">` +
          `<span>${o.count !== undefined ? `<span class="picker-count">${o.count}</span>` : ""}${escapeHtml(o.label)}</span>` +
          (o.hint ? `<span class="picker-hint">${escapeHtml(o.hint)}</span>` : "") + "</div>";
      }).join("") || '<div class="picker-empty">Ничего не найдено</div>';
      const active = list.querySelector(".active");
      if (active) active.scrollIntoView({ block: "nearest" });
    };
    const close = () => {
      list.classList.add("hidden");
      root.classList.remove("open");
    };
    const open = async () => {
      root.classList.add("open");
      list.classList.remove("hidden");
      if (!loaded) {
        list.innerHTML = '<div class="picker-empty">Загрузка…</div>';
        try {
          items = await load();
          loaded = true;
        } catch (err) {
          list.innerHTML = `<div class="picker-empty">Не удалось загрузить список: ${escapeHtml(err.message)}</div>`;
          return;
        }
      }
      renderList();
    };
    const toggle = () => (list.classList.contains("hidden") ? open() : close());
    const choose = (v) => {
      input.value = v;
      showValue();
      close();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if (onChange) onChange(v);
    };

    root.querySelector(".picker-btn").addEventListener("click", toggle);
    if (display) {
      display.addEventListener("click", toggle);
      display.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    } else {
      // Набор в поле — список подсказок сужается.
      input.addEventListener("input", (e) => {
        if (e.isTrusted && !list.classList.contains("hidden") && loaded) renderList(input.value);
      });
    }
    list.addEventListener("mousedown", (e) => e.preventDefault()); // фокус остаётся в поле
    list.addEventListener("click", (e) => {
      const item = e.target.closest(".picker-item");
      if (item) choose(item.dataset.value);
    });
    // Нажатие где угодно вне списка закрывает его. pointerdown в фазе перехвата –
    // приходит всегда (дорожка и другие элементы гасят обычный mousedown).
    document.addEventListener("pointerdown", (e) => {
      if (!root.contains(e.target)) close();
    }, true);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !list.classList.contains("hidden")) {
        e.stopPropagation();
        close();
      }
    });
    // formWatch при "Отменить" восстанавливает значение через input/change.
    input.addEventListener("change", showValue);

    input.value = value;
    showValue();
    return {
      root,
      input,
      get value() {
        return input.value;
      },
      set value(v) {
        input.value = v;
        showValue();
      },
      setOptions(next) {
        items = next;
        loaded = true;
        showValue();
        if (!list.classList.contains("hidden")) renderList();
      },
    };
  },
};
