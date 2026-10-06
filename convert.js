// テンプレート(Nashorn JS) → 設計書CSV 変換スクリプト（試作）
// 使い方: node convert.js テンプレート.js [文字コード]
//   文字コード省略時は utf-8。Shift_JIS の場合は shift_jis を指定。
// 同じフォルダの mapping.tsv（参照先ルール）と dict.tsv（条件の日本語辞書・任意）を読む。
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const inFile = process.argv[2];
const enc = process.argv[3] || "utf-8";
if (!inFile) { console.log("使い方: node convert.js テンプレート.js [文字コード]"); process.exit(1); }

const original = new TextDecoder(enc).decode(fs.readFileSync(inFile)).replace(/\r\n/g, "\n");
const lineOf = (src, offset) => src.slice(0, offset).split("\n").length;

// ---------- 設定ファイル ----------
function readTsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("#")).slice(1).map(l => l.split("\t"));
}
const rules = readTsv(path.join(__dirname, "mapping.tsv")).map(c => ({
  id: c[0], re: new RegExp("^(?:" + c[1] + ")$"), ref1: c[2] || "", ref2: c[3] || "", name: c[4] || ""
}));
const dict = new Map(readTsv(path.join(__dirname, "dict.tsv")).map(c => [c[0], c[1]]));

// ---------- 前処理 ----------
// 1. [DIEt]〜[/DIEt] を退避し __DIET__(n); に置換（改行数は維持）
const diets = [];
let code = original.replace(/\[DIEt\]([\s\S]*?)\[\/DIEt\]/g, (m, body, offset) => {
  diets.push({ line: lineOf(original, offset), body });
  return "__DIET__(" + (diets.length - 1) + ");" + "\n".repeat((m.match(/\n/g) || []).length);
});
// 2. for each → for（文字数維持）。位置を記録
const forEachAt = new Set();
code = code.replace(/\bfor(\s+)each(\s*\()/g, (m, s1, s2, offset) => {
  forEachAt.add(offset);
  return "for" + s1 + "    " + s2;
});

let ast;
try {
  ast = acorn.parse(code, { ecmaVersion: 5, locations: true });
} catch (e) {
  console.log("解析エラー:", e.message);
  process.exit(1);
}
const src = n => code.slice(n.start, n.end).replace(/\s+/g, " ");

// ---------- 変数の追跡 ----------
const assignCount = {};
(function visit(n) {
  if (!n || typeof n.type !== "string") return;
  if (n.type === "VariableDeclarator" && n.init) assignCount[n.id.name] = (assignCount[n.id.name] || 0) + 1;
  if (n.type === "AssignmentExpression" && n.left.type === "Identifier")
    assignCount[n.left.name] = (assignCount[n.left.name] || 0) + (n.operator === "=" ? 1 : 2);
  if (n.type === "UpdateExpression" && n.argument.type === "Identifier")
    assignCount[n.argument.name] = (assignCount[n.argument.name] || 0) + 2;
  for (const k in n) {
    const v = n[k];
    if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === "string") visit(v);
  }
})(ast);
const varMap = {}; // 変数名 → { node, each }

// 式を、変数を取得元まで展開した文字列にする（ルール照合用）
function expand(n, seen) {
  seen = seen || new Set();
  switch (n.type) {
    case "Literal": return typeof n.value === "string" ? JSON.stringify(n.value) : String(n.raw);
    case "Identifier": {
      const v = varMap[n.name];
      if (v && !seen.has(n.name) && /^(Call|Member)Expression$|^Identifier$/.test(v.node.type)) {
        const s2 = new Set(seen); s2.add(n.name);
        return expand(v.node, s2) + (v.each ? "[]" : "");
      }
      return n.name;
    }
    case "MemberExpression":
      return expand(n.object, seen) + (n.computed ? "[" + expand(n.property, seen) + "]" : "." + n.property.name);
    case "CallExpression":
      return expand(n.callee, seen) + "(" + n.arguments.map(a => expand(a, seen)).join(", ") + ")";
    default: return src(n);
  }
}

// 式 → 出力断片（固定文字 or プレースホルダ）
function toFrags(n, depth) {
  depth = depth || 0;
  if (n.type === "Literal") return [{ text: String(n.value) }];
  if (n.type === "BinaryExpression" && n.operator === "+")
    return toFrags(n.left, depth).concat(toFrags(n.right, depth));
  if (n.type === "Identifier" && depth < 5) {
    const v = varMap[n.name];
    if (v && !v.each && assignCount[n.name] === 1 &&
        (v.node.type === "Literal" || (v.node.type === "BinaryExpression" && v.node.operator === "+")))
      return toFrags(v.node, depth + 1);
  }
  const ex = expand(n);
  for (const r of rules) {
    const m = ex.match(r.re);
    if (m) {
      const sub = t => t.replace(/\$(\d)/g, (_, d) => m[d] || "");
      return [{ ph: sub(r.name) || src(n), ref1: sub(r.ref1), ref2: sub(r.ref2), note: "" }];
    }
  }
  return [{ ph: src(n), ref1: "要確認", ref2: "", note: "ルール未定義: " + ex }];
}

// ---------- 行の組み立て ----------
const rows = [];
const condsSeen = new Set();
let cur = null;
let ctx = { loops: [], conds: [], fn: "" };

function newRow(line) {
  return { line, loop: ctx.loops.join(" > "), cond: ctx.conds.join(" かつ "), text: "", ref1: [], ref2: [], note: ctx.fn ? ["関数 " + ctx.fn + " 内"] : [] };
}
function emit(extraNote) {
  if (!cur) return;
  if (extraNote) cur.note.push(extraNote);
  rows.push(cur); cur = null;
}
function addFrag(f, line) {
  if (f.text !== undefined) {
    const parts = f.text.split("\n");
    parts.forEach((p, i) => {
      if (p !== "") { cur = cur || newRow(line + i); cur.text += p; }
      if (i < parts.length - 1) newline(line + i);
    });
  } else {
    cur = cur || newRow(line);
    cur.text += "@@" + f.ph + "@@";
    if (f.ref1) cur.ref1.push(f.ref1);
    if (f.ref2) cur.ref2.push(f.ref2);
    if (f.note) cur.note.push(f.note);
  }
}
function newline(line) {
  if (!cur) { cur = newRow(line); cur.note.push("空行"); }
  emit();
}
function noteRow(line, note) {
  emit("改行なし（次の出力に続く）");
  cur = newRow(line); cur.note.push(note); emit();
}
function condText(test) {
  const s = src(test);
  condsSeen.add(s);
  return dict.get(s) || s;
}
function within(push, body) {
  emit("改行なし（次の出力に続く）");
  const saved = ctx;
  ctx = { loops: saved.loops.concat(push.loop || []), conds: saved.conds.concat(push.cond || []), fn: push.fn || saved.fn };
  [].concat(body).forEach(walk);
  emit("改行なし（次の出力に続く）");
  ctx = saved;
}

function walk(n) {
  if (!n) return;
  const line = n.loc.start.line;
  switch (n.type) {
    case "EmptyStatement": return;
    case "BlockStatement": return n.body.forEach(walk);
    case "VariableDeclaration":
      n.declarations.forEach(d => { if (d.init) varMap[d.id.name] = { node: d.init, each: false }; });
      return;
    case "ExpressionStatement": {
      const e = n.expression;
      if (e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "__DIET__") {
        const d = diets[e.arguments[0].value];
        return addFrag({ text: d.body }, d.line);
      }
      if (e.type === "CallExpression" && e.callee.type === "MemberExpression" &&
          e.callee.object.name === "dsm" && /^dwrite(ln)?$/.test(e.callee.property.name)) {
        if (e.arguments[0]) toFrags(e.arguments[0]).forEach(f => addFrag(f, line));
        if (e.callee.property.name === "dwriteln") newline(line);
        return;
      }
      if (e.type === "AssignmentExpression" && e.left.type === "Identifier") {
        if (e.operator === "=") varMap[e.left.name] = { node: e.right, each: false };
        return;
      }
      return noteRow(line, "処理: " + src(n));
    }
    case "IfStatement": {
      const c = condText(n.test);
      within({ cond: c }, n.consequent);
      if (n.alternate) within({ cond: "NOT(" + c + ")" }, n.alternate);
      return;
    }
    case "ForInStatement": {
      const each = forEachAt.has(n.start);
      const name = n.left.type === "VariableDeclaration" ? n.left.declarations[0].id.name : src(n.left);
      varMap[name] = { node: n.right, each };
      return within({ loop: (each ? "for each " : "for ") + name + " in " + src(n.right) }, n.body);
    }
    case "ForStatement":
      if (n.init && n.init.type === "VariableDeclaration") walk(n.init);
      return within({ loop: "for (" + [n.init, n.test, n.update].map(x => x ? src(x).replace(/;$/, "") : "").join("; ") + ")" }, n.body);
    case "WhileStatement": return within({ loop: "while (" + src(n.test) + ")" }, n.body);
    case "DoWhileStatement": return within({ loop: "do-while (" + src(n.test) + ")" }, n.body);
    case "SwitchStatement":
      return n.cases.forEach(c => within({ cond: src(n.discriminant) + (c.test ? " == " + src(c.test) : " が上記以外") }, c.consequent));
    case "TryStatement":
      walk(n.block);
      if (n.handler) within({ cond: "例外発生時" }, n.handler.body);
      if (n.finalizer) walk(n.finalizer);
      return;
    case "FunctionDeclaration": return within({ fn: n.id.name }, n.body);
    case "BreakStatement": return noteRow(line, "break（ループを抜ける）");
    case "ContinueStatement": return noteRow(line, "continue（次の繰り返しへ）");
    case "ReturnStatement": return noteRow(line, "return" + (n.argument ? " " + src(n.argument) : ""));
    default: return noteRow(line, "未対応の構文: " + src(n).slice(0, 80));
  }
}
ast.body.forEach(walk);
emit("改行なし（ファイル末尾）");

// ---------- 出力 ----------
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const header = ["行数", "ループ", "条件", "出力される文字列", "参照先①", "参照先②", "備考"];
const csv = [header.map(q).join(",")].concat(rows.map(r =>
  [r.line, r.loop, r.cond, r.text, r.ref1.join(" / "), r.ref2.join(" / "), r.note.join(" / ")].map(q).join(","))).join("\r\n");
const base = inFile.replace(/\.[^.]+$/, "");
fs.writeFileSync(base + "_設計書.csv", "\uFEFF" + csv);
fs.writeFileSync(base + "_条件一覧.tsv", "条件式\t日本語\n" + [...condsSeen].filter(c => !dict.has(c)).map(c => c + "\t").join("\n"));

const todo = rows.filter(r => r.ref1.includes("要確認")).length;
console.log("設計書: " + rows.length + " 行 → " + base + "_設計書.csv");
console.log("要確認: " + todo + " 行 / 未翻訳の条件: " + [...condsSeen].filter(c => !dict.has(c)).length + " 件");