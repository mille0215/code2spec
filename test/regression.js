'use strict';
// sample3.js の変換結果を基準とした回帰テスト
// node:test を使い、新たな依存パッケージは追加しない

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
