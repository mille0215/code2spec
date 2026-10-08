// loopcond.tsv によるループ列・条件列の変換を確かめる
var users = master.find("T_USER");
for each (var u in users) {
  if (u.get("TYPE") == '1' && u.get("AGE") > 20) {
    dsm.dwriteln(u.get("NAME"));
  } else {
    dsm.dwriteln("-");
  }
}
if (ctx.getValue("FLAG") == "1") {
  dsm.dwriteln("flag");
}
for (var i = 0; i < 3; i++) {
  dsm.dwriteln("i");
}
