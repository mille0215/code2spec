'use strict';
// sample3.js の変換結果を基準とした回帰テスト
// node:test を使い、新たな依存パッケージは追加しない

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

test('sample.js の変換結果が期待値と一致する', () => {
  // convert.js を実行してコンソール出力を取得する
  const stdout = execSync('node convert.js sample.js', {
    cwd: ROOT,
    encoding: 'utf8',
  });

  // HANDOVER.md「検証済みの結果」と照合する
  assert.match(stdout, /設計書: 10 行/, 'row count');
  assert.match(stdout, /要確認: 1 行 \/ 未翻訳の条件: 1 件/, 'todo count');

  // 設計書 CSV の内容（BOM 付き UTF-8、CRLF）をバイト単位で期待値と比較する
  const csvActual = fs.readFileSync(path.join(ROOT, 'sample_設計書.csv'));
  const csvExpected = fs.readFileSync(path.join(FIXTURES, 'sample.csv'));
  assert.deepStrictEqual(csvActual, csvExpected, '設計書 CSV の内容が期待値と一致しない');

  // 条件一覧 TSV の内容を期待値と比較する
  const tsvActual = fs.readFileSync(path.join(ROOT, 'sample_条件一覧.tsv'), 'utf8');
  const tsvExpected = fs.readFileSync(path.join(FIXTURES, 'sample.tsv'), 'utf8');
  assert.strictEqual(tsvActual, tsvExpected, '条件一覧 TSV の内容が期待値と一致しない');
});

test('cellTbl はシングルクォートでもダブルクォートでもルールに一致する', () => {
  // 出力ファイルがリポジトリ内に残らないよう、一時フォルダにコピーして変換する
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dietcode2spec-'));
  try {
    fs.copyFileSync(path.join(FIXTURES, 'celltbl.js'), path.join(tmp, 'celltbl.js'));
    const stdout = execSync('node "' + path.join(ROOT, 'convert.js') + '" celltbl.js', {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.match(stdout, /要確認: 0 行/, 'すべての cellTbl がルールに一致すること');

    // 行数,ループ,条件,出力される文字列,参照先①,参照先②,備考
    const lines = fs.readFileSync(path.join(tmp, 'celltbl_設計書.csv'), 'utf8').split('\r\n').slice(1);
    assert.deepStrictEqual(lines, [
      '"2","","","@@A1@@","cellTbl","A1",""',
      '"3","","","@@B2@@","cellTbl","B2",""',
      '"4","","","x=@@C3@@","cellTbl","C3",""',
      '"6","","","@@D4@@","cellTbl","D4",""',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loopcond.tsv のルールでループ列・条件列が変換される', () => {
  // convert.js は自分と同じフォルダのルールファイルを読むため、
  // テスト用の loopcond.tsv と一緒に一時フォルダへコピーして実行する
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dietcode2spec-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'convert.js'), path.join(tmp, 'convert.js'));
    fs.copyFileSync(path.join(ROOT, 'mapping.tsv'), path.join(tmp, 'mapping.tsv'));
    fs.copyFileSync(path.join(FIXTURES, 'loopcond.tsv'), path.join(tmp, 'loopcond.tsv'));
    fs.copyFileSync(path.join(FIXTURES, 'loopcond.js'), path.join(tmp, 'loopcond.js'));
    const stdout = execSync('node convert.js loopcond.js', {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }, // acorn をリポジトリから読む
    });
    assert.match(stdout, /未翻訳の条件: 1 件/, 'ルールに一致しない条件だけが条件一覧に残ること');

    // 行数,ループ,条件,出力される文字列,参照先①,参照先②,備考
    const lines = fs.readFileSync(path.join(tmp, 'loopcond_設計書.csv'), 'utf8').split('\r\n').slice(1);
    assert.deepStrictEqual(lines, [
      // ループは取得元のオブジェクト名に、条件は値の取得を @@名前@@ にしたうえで日本語に変換される
      '"5","T_USER","TYPE が 1 かつ @@AGE@@ > 20","@@NAME@@","T_USER","NAME",""',
      '"7","T_USER","NOT(TYPE が 1 かつ @@AGE@@ > 20)","-","","",""',
      // ルールに一致しない条件・ループは元の表記のまま
      '"11","","ctx.getValue(""FLAG"") == ""1""","flag","","",""',
      '"14","for (var i = 0; i < 3; i++)","","i","","",""',
    ]);

    const tsv = fs.readFileSync(path.join(tmp, 'loopcond_条件一覧.tsv'), 'utf8');
    assert.strictEqual(tsv, '条件式\t日本語\nctx.getValue("FLAG") == "1"\t');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('proc.tsv のルールで処理の行を除外・置き換えできる', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dietcode2spec-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'convert.js'), path.join(tmp, 'convert.js'));
    fs.copyFileSync(path.join(ROOT, 'mapping.tsv'), path.join(tmp, 'mapping.tsv'));
    fs.copyFileSync(path.join(FIXTURES, 'proc.tsv'), path.join(tmp, 'proc.tsv'));
    fs.copyFileSync(path.join(FIXTURES, 'proc.js'), path.join(tmp, 'proc.js'));
    execSync('node convert.js proc.js', {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }, // acorn をリポジトリから読む
    });

    // 行数,ループ,条件,出力される文字列,参照先①,参照先②,備考
    const lines = fs.readFileSync(path.join(tmp, 'proc_設計書.csv'), 'utf8').split('\r\n').slice(1);
    assert.deepStrictEqual(lines, [
      // 除外ルールに一致した dtm.putVar は行を作らず、前後の出力も区切らない
      '"1","","","ab","","",""',
      // 変換後の文字があるルールは、その文字を出力される文字列にした行になる
      '"4","","","【ヘッダー行: sh】","","","処理: $utl.createHeaderLine(""sh"");"',
      // ルールに一致しない処理は従来どおり備考だけの行
      '"5","","","","","","処理: other.call();"',
      '"6","","","c","","",""',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('要確認の式からマッピング候補が作られ、mapping.tsv に貼れば一致する', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dietcode2spec-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'convert.js'), path.join(tmp, 'convert.js'));
    fs.copyFileSync(path.join(ROOT, 'mapping.tsv'), path.join(tmp, 'mapping.tsv'));
    fs.copyFileSync(path.join(FIXTURES, 'mapcand.js'), path.join(tmp, 'mapcand.js'));
    const run = () => execSync('node convert.js mapcand.js', {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }, // acorn をリポジトリから読む
    });
    assert.match(run(), /マッピング候補: 2 件/);

    // 文字列だけが違う式は1つの照合パターンにまとまる
    const cand = fs.readFileSync(path.join(tmp, 'mapcand_マッピング候補.tsv'), 'utf8').split('\n');
    assert.deepStrictEqual(cand.slice(1), [
      'TMP001\tfoo\\.get\\("([^"]*)"\\)\t要記入\t$1\t$1\t2\tfoo.get("A") | foo.get("B")',
      'TMP002\tbar\\(\\)\t要記入\t\t\t1\tbar()',
    ]);

    // 参照先①を書き換えて mapping.tsv に貼り付けると、要確認が無くなる
    fs.appendFileSync(path.join(tmp, 'mapping.tsv'), cand.slice(1).map(l => l.replace('要記入', 'FOO')).join('\n') + '\n');
    assert.match(run(), /要確認: 0 行/);
    const lines = fs.readFileSync(path.join(tmp, 'mapcand_設計書.csv'), 'utf8').split('\r\n').slice(1);
    assert.deepStrictEqual(lines, [
      '"1","","","@@A@@","FOO","A",""',
      '"2","","","@@B@@","FOO","B",""',
      '"3","","","@@bar()@@","FOO","",""',
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
