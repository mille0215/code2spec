// cellTbl の引数がシングルクォート・ダブルクォートのどちらでもルール R003 に一致することを確かめる
dsm.dwriteln(cellTbl('A1'));
dsm.dwriteln(cellTbl("B2"));
$("x=" + cellTbl('C3') + "\n");
var c = cellTbl('D4');
dsm.dwriteln(c);
