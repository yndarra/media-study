// Страницы приложения: объект Pages. Здесь – общее (обновление раз в
// несколько секунд); разделы дописываются в него из соседних файлов.
const Pages = {
  timer: null,

  stopRefresh() {
    clearInterval(this.timer);
    this.timer = null;
  },

  // Страница, которая показывает живой прогресс, перерисовывается раз в несколько секунд.
  refreshEvery(ms, fn) {
    this.stopRefresh();
    this.timer = setInterval(fn, ms);
  },
};
