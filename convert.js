// =====================================================================
// テンプレート(Nashorn JavaScript) → 設計書CSV 変換スクリプト
//
// 使い方: node convert.js テンプレート.js [文字コード]
//   文字コード省略時は utf-8。Shift_JIS の場合は shift_jis を指定。
//
// 入力（このスクリプトと同じフォルダに置く）
//   mapping.tsv : 参照先ルール（取得式 → 参照先①②・プレースホルダ名）
//   dict.tsv    : 条件式の日本語辞書（任意。無くても動く）
// 出力（テンプレートと同じフォルダに作られる）
//   xxx_設計書.csv   : 行数/ループ/条件/出力される文字列/参照先①/参照先②/備考
//   xxx_条件一覧.tsv : まだ日本語化されていない条件式の一覧
//
// 処理の流れ
//   1. 設定        … 出力関数の定義
//   2. 読み込み    … テンプレート、mapping.tsv、dict.tsv
//   3. 前処理      … [DIEt]ブロックと for each を、解析できる形に置き換える
//   4. 構文解析    … acorn でコードを構文木（AST）にする
//   5. 変数の追跡  … 変数がどの式から作られたかを記録する
//   6. 行の組み立て… 構文木を上から順にたどり、設計書の行を作る
//   7. 書き出し    … CSV と条件一覧を出力する
// =====================================================================
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

// ---------------------------------------------------------------------
// 1. 設定：ファイル出力を行う関数の一覧
//   name    : 関数名（オブジェクト.メソッド、または関数名のみ）
//   newline : true なら出力後に改行する（設計書の行がそこで区切られる）
//   lookup  : true にすると「引数そのもの」ではなく「関数呼び出し全体」を
//             値の取得とみなす。例) $("KEY") が KEY という文字を出すのではなく
//             KEY に対応する値を出す関数である場合は true にし、
//             mapping.tsv に  \$\("([^"]+)"\)  のようなルールを書く。
// 出力関数が他にもあれば、ここに行を追加する。
// ---------------------------------------------------------------------
const OUTPUT_FUNCS = [
  { name: "dsm.dwrite",   newline: false, lookup: false },
  { name: "dsm.dwriteln", newline: true,  lookup: false },
  { name: "$",            newline: false, lookup: false },
];

// ---------------------------------------------------------------------
// 2. 読み込み
// ---------------------------------------------------------------------
const inFile = process.argv[2];
const enc = process.argv[3] || "utf-8";
if (!inFile) { console.log("使い方: node convert.js テンプレート.js [文字コード]"); process.exit(1); }

// テンプレート本体。改行コードは \n に統一しておく（行番号の計算を単純にするため）
const original = new TextDecoder(enc).decode(fs.readFileSync(inFile)).replace(/\r\n/g, "\n");

// 文字位置(offset)から行番号を求める
const lineOf = (src, offset) => src.slice(0, offset).split("\n").length;

// TSVを読む。1行目は見出しとして捨て、空行と # で始まる行は無視する
function readTsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith("#")).slice(1).map(l => l.split("\t"));
}

// 参照先ルール。列: ルールID / 照合パターン(正規表現) / 参照先① / 参照先② / プレースホルダ名
// 照合パターンは式全体に一致する必要がある（前後に ^ $ を付けて照合する）
const rules = readTsv(path.join(__dirname, "mapping.tsv")).map(c => ({
  id: c[0], re: new RegExp("^(?:" + c[1] + ")$"), ref1: c[2] || "", ref2: c[3] || "", name: c[4] || ""
}));

// 条件式の日本語辞書。列: 条件式 / 日本語
const dict = new Map(readTsv(path.join(__dirname, "dict.tsv")).map(c => [c[0], c[1]]));

// ---------------------------------------------------------------------
// 3. 前処理
//   [DIEt]や for each は標準のJavaScriptではないため、そのままでは解析できない。
//   行番号がずれないように注意しながら、解析できる形に置き換える。
// ---------------------------------------------------------------------
let diets;      // 退避した[DIEt]ブロック { line: 開始行, body: 中身 }
let forEachAt;  // for each だった for文の文字位置

// addSemicolon=true のときは、同じ行の直前にコードがある[DIEt]の前に ; を補う
//   例) $("")[DIEt]  →  $("");__DIET__(1);   （; が無いと2つの文がつながってしまう）
function preprocess(addSemicolon) {
  diets = [];
  forEachAt = new Set();

  // (a) [DIEt]〜[/DIEt] を __DIET__(番号); という関数呼び出しに置き換える。
  //     中身は diets に保管し、中身に含まれていた改行と同じ数の改行を残す。
  let code = original.replace(/\[DIEt\]([\s\S]*?)\[\/DIEt\]/g, (m, body, offset) => {
    diets.push({ line: lineOf(original, offset), body });
    let prefix = "";
    if (addSemicolon) {
      const before = original.slice(original.lastIndexOf("\n", offset - 1) + 1, offset).trim();
      if (before && !/[;{}]$/.test(before) && !/\[\/DIEt\]$/.test(before)) prefix = ";";
    }
    return prefix + "__DIET__(" + (diets.length - 1) + ");" + "\n".repeat((m.match(/\n/g) || []).length);
  });

  // (b) for each (x in list) → for (x in list)。
  //     each を同じ文字数の空白にするので位置はずれない。
  //     「元は for each だった」ことを位置で覚えておき、ループ列の表記に使う。
  code = code.replace(/\bfor(\s+)each(\s*\()/g, (m, s1, s2, offset) => {
    forEachAt.add(offset);
    return "for" + s1 + "    " + s2;
  });
  return code;
}

// ---------------------------------------------------------------------
// 4. 構文解析
//   まずそのまま解析し、失敗したら ; を補って再度試す。
// ---------------------------------------------------------------------
let code, ast;
try {
  code = preprocess(false);
  ast = acorn.parse(code, { ecmaVersion: 5, locations: true });
} catch (e1) {
  try {
    code = preprocess(true);
    ast = acorn.parse(code, { ecmaVersion: 5, locations: true });
  } catch (e2) {
    console.log("解析エラー:", e2.message);
    process.exit(1);
  }
}

// 構文木の一部分(ノード)に対応する元のコードを、空白を詰めて1行で返す
const src = n => code.slice(n.start, n.end).replace(/\s+/g, " ");

// ---------------------------------------------------------------------
// 5. 変数の追跡
//   var u = master.find("T_USER") のあとで u.get("NAME") と書かれた場合に、
//   u の正体までさかのぼって参照先を判定できるようにする。
// ---------------------------------------------------------------------

// 各変数が何回代入されるかを先に数える。
// 2回以上代入される変数は値が1つに決まらないので、固定文字列としては展開しない。
// （+= や ++ は「決まらない」扱いにするため 2 を足す）
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

// 変数名 → { node: 代入された式, each: for each のループ変数なら true }
// 構文木をたどりながら、その時点での最新の内容に更新していく。
const varMap = {};

// 式を「変数を取得元まで展開した文字列」にする。mapping.tsv との照合に使う。
//   例) u.get("NAME")  →  master.find("T_USER")[].get("NAME")
//   for each のループ変数は、要素を表す [] を付ける。
//   seen は同じ変数を無限にたどらないための記録。
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

// 出力される式を「断片」の並びに分解する。断片は次の2種類。
//   { text }                  … そのまま出力される固定文字
//   { ph, ref1, ref2, note }  … 値が埋め込まれる箇所（@@ph@@ になる）
function toFrags(n, depth) {
  depth = depth || 0;
  // 文字列や数値の直書きは固定文字
  if (n.type === "Literal") return [{ text: String(n.value) }];
  // "a" + x + "b" のような連結は、左右に分けてそれぞれ分解する
  if (n.type === "BinaryExpression" && n.operator === "+")
    return toFrags(n.left, depth).concat(toFrags(n.right, depth));
  // 1回だけ代入された変数で、中身が文字列や連結なら、その中身に置き換える
  if (n.type === "Identifier" && depth < 5) {
    const v = varMap[n.name];
    if (v && !v.each && assignCount[n.name] === 1 &&
        (v.node.type === "Literal" || (v.node.type === "BinaryExpression" && v.node.operator === "+")))
      return toFrags(v.node, depth + 1);
  }
  // それ以外は値の取得とみなし、展開した式を mapping.tsv のルールと照合する
  const ex = expand(n);
  for (const r of rules) {
    const m = ex.match(r.re);
    if (m) {
      // ルール中の $1, $2 を、正規表現の ( ) で捕まえた文字に置き換える
      const sub = t => t.replace(/\$(\d)/g, (_, d) => m[d] || "");
      return [{ ph: sub(r.name) || src(n), ref1: sub(r.ref1), ref2: sub(r.ref2), note: "" }];
    }
  }
  // どのルールにも当てはまらない場合は推測せず「要確認」にする
  return [{ ph: src(n), ref1: "要確認", ref2: "", note: "ルール未定義: " + ex }];
}

// ---------------------------------------------------------------------
// 6. 行の組み立て
// ---------------------------------------------------------------------
const rows = [];              // 完成した設計書の行
const condsSeen = new Set();  // 出てきた条件式（条件一覧の出力用）
let cur = null;               // いま組み立て中の行（改行が来るまで文字を足していく）
let ctx = { loops: [], conds: [], fn: "" }; // いまいる場所（どのループ・条件・関数の中か）

// 新しい行を作る。ループ列と条件列には、いまいる場所をそのまま入れる
function newRow(line) {
  return { line, loop: ctx.loops.join(" > "), cond: ctx.conds.join(" かつ "), text: "", ref1: [], ref2: [], note: ctx.fn ? ["関数 " + ctx.fn + " 内"] : [] };
}

// 組み立て中の行を確定させる
function emit(extraNote) {
  if (!cur) return;
  if (extraNote) cur.note.push(extraNote);
  rows.push(cur); cur = null;
}

// 断片を組み立て中の行に足す。固定文字に改行が含まれていれば、そこで行を区切る
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

// 改行が出力されたとき。何も溜まっていなければ空行として1行作る
function newline(line) {
  if (!cur) { cur = newRow(line); cur.note.push("空行"); }
  emit();
}

// 出力ではない処理（独自関数の呼び出しなど）を、備考だけの行として記録する
function noteRow(line, note) {
  emit("改行なし（次の出力に続く）");
  cur = newRow(line); cur.note.push(note); emit();
}

// 条件式を条件列用の文字にする。辞書にあれば日本語、無ければ式のまま
function condText(test) {
  const s = src(test);
  condsSeen.add(s);
  return dict.get(s) || s;
}

// ループ・条件・関数の中に入って body を処理し、終わったら元の場所に戻る。
// 出入りの時点で組み立て中の行があれば、ループ列や条件列が変わるためそこで区切る
function within(push, body) {
  emit("改行なし（次の出力に続く）");
  const saved = ctx;
  ctx = { loops: saved.loops.concat(push.loop || []), conds: saved.conds.concat(push.cond || []), fn: push.fn || saved.fn };
  [].concat(body).forEach(walk);
  emit("改行なし（次の出力に続く）");
  ctx = saved;
}

// 関数呼び出しが出力関数(OUTPUT_FUNCS)なら、その設定と第1引数を返す
function outputCall(e) {
  if (!e || e.type !== "CallExpression") return null;
  const c = e.callee;
  let name = null;
  if (c.type === "Identifier") name = c.name;
  else if (c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier") name = c.object.name + "." + c.property.name;
  const fn = OUTPUT_FUNCS.find(f => f.name === name);
  return fn ? { fn, arg: e.arguments[0] } : null;
}

// 構文木のノード（文）を1つ処理する。文の種類ごとに分岐する
function walk(n) {
  if (!n) return;
  const line = n.loc.start.line;
  switch (n.type) {
    case "EmptyStatement": return;                       // ; だけの文。何もしない
    case "BlockStatement": return n.body.forEach(walk);  // { ... } は中身を順に処理

    case "VariableDeclaration": // var x = 式;  → 変数の中身を記録するだけ（行は作らない）
      n.declarations.forEach(d => { if (d.init) varMap[d.id.name] = { node: d.init, each: false }; });
      return;

    case "ExpressionStatement": {
      let e = n.expression;

      // [DIEt]ブロック（前処理で __DIET__(番号) に置き換えたもの）→ 中身をそのまま出力
      if (e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "__DIET__") {
        const d = diets[e.arguments[0].value];
        return addFrag({ text: d.body }, d.line);
      }

      // x = $(...) のように、出力関数の戻り値を代入している形も出力として扱う
      let assignedTo = null;
      if (e.type === "AssignmentExpression" && outputCall(e.right)) { assignedTo = src(e.left); e = e.right; }

      // 出力関数（dsm.dwrite / dsm.dwriteln / $ など）
      const oc = outputCall(e);
      if (oc) {
        const frags = oc.fn.lookup ? toFrags(e) : (oc.arg ? toFrags(oc.arg) : []);
        frags.forEach(f => addFrag(f, line));
        if (assignedTo && cur) cur.note.push("戻り値を " + assignedTo + " に代入");
        if (oc.fn.newline) newline(line);
        return;
      }

      // x = 式;  → 変数の中身を記録するだけ（+= などは値が決まらないので記録しない）
      if (e.type === "AssignmentExpression" && e.left.type === "Identifier") {
        if (e.operator === "=") varMap[e.left.name] = { node: e.right, each: false };
        return;
      }

      // 上のどれでもない文（独自関数の呼び出しなど）は備考に残す
      return noteRow(line, "処理: " + src(n));
    }

    case "IfStatement": { // if / else。else 側は NOT(条件) と表記する
      const c = condText(n.test);
      within({ cond: c }, n.consequent);
      if (n.alternate) within({ cond: "NOT(" + c + ")" }, n.alternate);
      return;
    }

    case "ForInStatement": { // for (x in list) と for each (x in list)
      const each = forEachAt.has(n.start);
      const name = n.left.type === "VariableDeclaration" ? n.left.declarations[0].id.name : src(n.left);
      varMap[name] = { node: n.right, each }; // ループ変数の正体を記録
      return within({ loop: (each ? "for each " : "for ") + name + " in " + src(n.right) }, n.body);
    }

    case "ForStatement": // for (初期化; 条件; 更新)
      if (n.init && n.init.type === "VariableDeclaration") walk(n.init);
      return within({ loop: "for (" + [n.init, n.test, n.update].map(x => x ? src(x).replace(/;$/, "") : "").join("; ") + ")" }, n.body);

    case "WhileStatement": return within({ loop: "while (" + src(n.test) + ")" }, n.body);
    case "DoWhileStatement": return within({ loop: "do-while (" + src(n.test) + ")" }, n.body);

    case "SwitchStatement": // case ごとに条件として扱う
      return n.cases.forEach(c => within({ cond: src(n.discriminant) + (c.test ? " == " + src(c.test) : " が上記以外") }, c.consequent));

    case "TryStatement": // try の中は通常どおり、catch の中は「例外発生時」の条件付き
      walk(n.block);
      if (n.handler) within({ cond: "例外発生時" }, n.handler.body);
      if (n.finalizer) walk(n.finalizer);
      return;

    case "FunctionDeclaration": // テンプレート内で定義された関数。中身を処理し備考に関数名を付ける
      return within({ fn: n.id.name }, n.body);

    case "BreakStatement": return noteRow(line, "break（ループを抜ける）");
    case "ContinueStatement": return noteRow(line, "continue（次の繰り返しへ）");
    case "ReturnStatement": return noteRow(line, "return" + (n.argument ? " " + src(n.argument) : ""));
    default: return noteRow(line, "未対応の構文: " + src(n).slice(0, 80));
  }
}

// テンプレートの先頭から順に処理する
ast.body.forEach(walk);
emit("改行なし（ファイル末尾）");

// ---------------------------------------------------------------------
// 7. 書き出し
// ---------------------------------------------------------------------
// CSVの1項目。" で囲み、中の " は "" にする
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const header = ["行数", "ループ", "条件", "出力される文字列", "参照先①", "参照先②", "備考"];
const csv = [header.map(q).join(",")].concat(rows.map(r =>
  [r.line, r.loop, r.cond, r.text, r.ref1.join(" / "), r.ref2.join(" / "), r.note.join(" / ")].map(q).join(","))).join("\r\n");

const base = inFile.replace(/\.[^.]+$/, "");
// 先頭の ﻿(BOM) は、Excelで開いたときに文字化けさせないためのもの
fs.writeFileSync(base + "_設計書.csv", "﻿" + csv);
// 辞書に無い条件式だけを出す。「日本語」列を埋めて dict.tsv に追記すれば次回から反映される
const untranslated = [...condsSeen].filter(c => !dict.has(c));
fs.writeFileSync(base + "_条件一覧.tsv", "条件式\t日本語\n" + untranslated.map(c => c + "\t").join("\n"));

const todo = rows.filter(r => r.ref1.includes("要確認")).length;
console.log("設計書: " + rows.length + " 行 → " + base + "_設計書.csv");
console.log("要確認: " + todo + " 行 / 未翻訳の条件: " + untranslated.length + " 件");
