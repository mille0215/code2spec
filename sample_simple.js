
function test() {
    var cellList = dsm.getCell("1");
[DIEt]<ManagedElement id="1">[/DIEt]
for each (var cell in cellList) {[DIEt]    <UtranCell>[/DIEt]dsm.dwrite(cell.getValue("id"));[DIEt]</UtranCell>
[/DIEt]
}
[DIEt]</ManagedElement>
[/DIEt]
}
