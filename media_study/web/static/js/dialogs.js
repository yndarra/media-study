// Вопросы поверх всего (askConfirm, askSave, askStorage), окно поверх
// страницы (Modal) и помощники форм (formWatch, autoGrow, singleLine).

// Вопрос о несохранённых изменениях – поверх всего (и окон, и страниц).
// Возвращает "save", "drop" ("Нет") или null (клик мимо / Esc – остаться).
function askSave() {
  return askConfirm({ title: "Несохранённые изменения", text: "Сохранить их?", yes: "Сохранить", no: "Нет", yesValue: "save", noValue: "drop" });
}

// Вопрос с подтверждением (поверх всего). yes – синяя кнопка (или красная,
// danger: true), no – вторая; клик мимо / Esc – null.
function askConfirm({ title, text, yes, no, yesValue = "yes", noValue = "no", danger = false, icon = null }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    const pen = '<svg viewBox="0 0 20 20"><path d="M4 14.5V16h1.5l8.6-8.6-1.5-1.5L4 14.5z"/><path d="M13.6 4.9l1.5 1.5 1.2-1.2a1 1 0 0 0 0-1.4l-.1-.1a1 1 0 0 0-1.4 0l-1.2 1.2z"/></svg>';
    overlay.innerHTML = `<div class="ask${danger ? " danger" : ""}" role="dialog">
        <div class="ask-icon">${icon || pen}</div>
        <div class="ask-title">${escapeHtml(title)}</div>
        <div class="ask-text">${text}</div>
        <div class="ask-actions">${no ? `<button class="step-btn" data-a="${noValue}">${escapeHtml(no)}</button>` : ""}` +
        `<button class="step-btn ${danger ? "danger" : "primary"}" data-a="${yesValue}">${escapeHtml(yes)}</button></div>
      </div>`;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 150);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) return finish(null);
      const action = e.target.closest("[data-a]");
      if (action) finish(action.dataset.a);
    });
    document.body.appendChild(overlay);
    overlay.querySelector(`[data-a="${yesValue}"]`).focus();
  });
}

// Окошко "Хранилище" (кнопка в окне видео): где лежит видео и куда его можно
// перенести (подключённые хранилища из настроек). Возвращает путь выбранного
// хранилища или null (закрыли / переносить некуда).
// pack: true – ещё и кнопка «Набор» (выгрузить набор для других; ответ "pack").
function askStorage(info, { pack = false } = {}) {
  return new Promise((resolve) => {
    const here = info.here;
    const targets = info.targets || [];
    const overlay = document.createElement("div");
    overlay.className = "ask-overlay";
    const disk = '<svg viewBox="0 0 20 20"><rect x="3" y="5" width="14" height="10" rx="2"/><path d="M6 12h3"/><circle cx="14" cy="12" r="0.6"/></svg>';
    const option = (t, k) => `<button class="storage-option" data-k="${k}"><span class="so-name">${escapeHtml(t.label)}</span>` +
      `<span class="so-path">${escapeHtml(t.path)}</span><span class="so-free">Свободно ${formatSize(t.free)}</span></button>`;
    overlay.innerHTML = `<div class="ask storage-ask" role="dialog">
        <div class="ask-icon">${disk}</div>
        <div class="ask-title">Хранилище</div>
        <!-- Список хранилищ: текущее – сверху, такой же строкой, с синей
             обводкой и градиентом (как карточки медиа); остальные – выбрать. -->
        <div class="storage-options">
          <div class="storage-option current chosen" data-k="here"><span class="so-name">${escapeHtml(here.label)}${here.main ? " (основное)" : ""}</span>` +
          `<span class="so-path">${escapeHtml(here.path)}</span>${here.free !== undefined ? `<span class="so-free">Свободно ${formatSize(here.free)}</span>` : ""}</div>
          ${targets.map(option).join("")}
        </div>
        ${targets.length ? "" : '<div class="ask-text muted small">Других хранилищ нет – добавьте папку на другом диске в «Настройках».</div>'}
        <div class="ask-actions">${pack ? '<button class="step-btn" data-a="pack" title="Набор для других: разметка, тексты и переводы файлом (без самого видео)">Набор</button>' : ""}` +
        `<button class="step-btn" data-a="close">Закрыть</button>` +
        `${targets.length ? '<button class="step-btn primary" data-a="move" disabled>Перенести</button>' : ""}</div>
      </div>`;
    let chosen = null;
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 150);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) return finish(null);
      const opt = e.target.closest(".storage-option");
      if (opt) {
        // Текущее хранилище – "никуда не переносить".
        chosen = opt.dataset.k === "here" ? null : targets[Number(opt.dataset.k)];
        overlay.querySelectorAll(".storage-option").forEach((o) => o.classList.toggle("chosen", o === opt));
        const move = overlay.querySelector('[data-a="move"]');
        if (move) move.disabled = !chosen;
        return;
      }
      const action = e.target.closest("[data-a]");
      if (!action) return;
      if (action.dataset.a === "pack") return finish("pack");
      finish(action.dataset.a === "move" && chosen ? chosen.path : null);
    });
    document.body.appendChild(overlay);
  });
}

// Поле, которое растёт по содержимому (название видео, ссылки): высота —
// по тексту; Enter в однострочном поле (data-single) не переносит строку.
function autoGrow(el) {
  const fit = () => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener("input", fit);
  if (el.dataset.single !== undefined) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
  }
  requestAnimationFrame(fit);
}

// Поле в одну строку на вид многострочного (автор): Enter не переносит строку.
function singleLine(el) {
  if (el) el.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
}

function formWatch(root, buttons, onChange = null) {
  const fields = () => [...root.querySelectorAll("input, textarea, select")].filter((el) => el.dataset.watch !== "no");
  const value = (el) => (el.type === "checkbox" ? String(el.checked) : el.value);
  let saved = [];
  const watcher = {
    snapshot() {
      saved = fields().map(value);
      watcher.update();
    },
    isDirty() {
      const now = fields().map(value);
      return now.length !== saved.length || now.some((v, i) => v !== saved[i]);
    },
    restore() {
      fields().forEach((el, i) => {
        if (el.type === "checkbox") el.checked = saved[i] === "true";
        else el.value = saved[i];
        el.dispatchEvent(new Event("input"));
        el.dispatchEvent(new Event("change"));
      });
      watcher.update();
    },
    update() {
      const dirty = watcher.isDirty();
      buttons.forEach((button) => button && (button.disabled = !dirty));
      if (onChange) onChange(dirty);
    },
  };
  root.addEventListener("input", () => watcher.update());
  root.addEventListener("change", () => watcher.update());
  watcher.snapshot();
  return watcher;
}

// Всплывающее окно поверх страницы (подробности видео и т.п.). guard —
// {isDirty(), save()}: если при закрытии есть несохранённые правки, окно
// спрашивает, сохранять ли их.
const Modal = {
  onClose: null,
  guard: null,

  show(html, onClose, guard = null) {
    this.close(false);
    const overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal"><div class="modal-body">${html}</div></div>`;
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.requestClose();
    });
    document.body.appendChild(overlay);
    this.animateHeight(overlay.querySelector(".modal"), overlay.querySelector(".modal-body"));
    this.onClose = onClose || null;
    this.guard = guard;
    return overlay.querySelector(".modal-body");
  },

  // Содержимое окна сменилось (например, "Загрузка…" -> подробности) – окно
  // не прыгает, а плавно раздвигается (или сжимается) до новой высоты.
  // Высота окна всегда плавно подстраивается под содержимое ("Загрузка…" ->
  // подробности, раскрытие строк, поля и т.п.): следим за настоящим размером
  // содержимого (ResizeObserver), а не угадываем его – без перелёта и рывка.
  // Новое содержимое после "Загрузка…" плавно проявляется.
  animateHeight(modal, body) {
    const cs = getComputedStyle(modal);
    const extra = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
      .reduce((sum, k) => sum + parseFloat(cs[k]), 0);
    modal.style.boxSizing = "border-box";
    let current = null;
    const done = () => {
      modal.style.transition = "";
      modal.style.overflow = "";
    };
    new ResizeObserver(() => {
      const target = body.offsetHeight + extra;
      if (current === null) {
        current = target;
        modal.style.height = `${target}px`;
        return;
      }
      if (Math.abs(target - current) < 1) return;
      const from = modal.offsetHeight; // видимая сейчас (в том числе посреди анимации)
      current = target;
      modal.style.transition = "none";
      modal.style.height = `${from}px`;
      modal.style.overflow = "hidden";
      modal.getBoundingClientRect();
      modal.style.transition = "height 0.3s cubic-bezier(0.22, 0.61, 0.36, 1)";
      modal.style.height = `${target}px`;
      modal.addEventListener("transitionend", done, { once: true });
    }).observe(body);
    // Первое настоящее содержимое (вместо "Загрузка…") – проявляется.
    new MutationObserver((_, observer) => {
      observer.disconnect();
      [...body.children].forEach((el) => el.classList.add("appear"));
    }).observe(body, { childList: true });
  },

  // Закрыть по крестику / клику мимо / Esc: с вопросом, если есть несохранённое.
  requestClose() {
    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    if (this.asking) return; // вопрос уже задан
    if (!this.guard || !this.guard.isDirty()) {
      this.close();
      return;
    }
    // "Нет" – закрыть без сохранения; клик мимо вопроса – отмена (окно остаётся).
    this.asking = true;
    askSave().then(async (answer) => {
      this.asking = false;
      if (!answer) return;
      if (answer === "save") await this.guard.save();
      this.close();
    });
  },

  close(runCallback = true) {
    const overlay = document.getElementById("modal-overlay");
    if (!overlay) return;
    // Плавно гаснет (стили .closing), а из поиска по id исчезает сразу –
    // новое окно можно открыть тут же.
    overlay.removeAttribute("id");
    overlay.classList.add("closing");
    setTimeout(() => overlay.remove(), 160);
    this.guard = null;
    const callback = this.onClose;
    this.onClose = null;
    if (runCallback && callback) callback();
  },
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("modal-overlay")) Modal.requestClose();
});
