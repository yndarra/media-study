// Строковые литералы JS с кириллицей – для tools/i18n_extract.py.
// Настоящий разбор (acorn), а не регулярки: регулярные выражения и
// вложенные шаблоны иначе сбивают поиск строк.
// Запуск: node i18n_js_strings.js <файл.js>… (ACORN_DIR – папка node_modules с acorn и acorn-walk)
// Вывод: JSON-массив строк; в шаблонах `…${x}…` вставка – символ \u0000.
const path = require("path");
const fs = require("fs");
const base = process.env.ACORN_DIR || "";
const acorn = require(path.join(base, "acorn"));
const walk = require(path.join(base, "acorn-walk"));

const out = [];
const cyr = /[А-Яа-яЁё]/;
for (const file of process.argv.slice(2)) {
  const code = fs.readFileSync(file, "utf8");
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" });
  walk.full(ast, (node) => {
    if (node.type === "Literal" && typeof node.value === "string" && cyr.test(node.value)) out.push(node.value);
    if (node.type === "TemplateLiteral") {
      const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("\u0000");
      if (cyr.test(text)) out.push(text);
    }
  });
}
process.stdout.write(JSON.stringify(out));
