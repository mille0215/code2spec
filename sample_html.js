var title = ctx.getValue("TITLE");
var users = master.find("T_USER");
[DIEt]
<html>
<head><title>[/DIEt]
dsm.dwrite(title);
[DIEt]</title></head>
<body>
[/DIEt]
for each (var u in users) {
  if (u.get("TYPE") == "1") {
    dsm.dwriteln("<p>管理者: " + u.get("NAME") + "</p>");
  } else {
    dsm.dwrite("<p>");
    dsm.dwrite(u.get("NAME"));
    dsm.dwriteln("</p>");
  }
  dsm.dwriteln(util.fmt(u.get("AGE")));
}
[DIEt]</body>
</html>
[/DIEt]