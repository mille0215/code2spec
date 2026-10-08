var targetKeyList = dsm.getTargetKeyList();


for each (var targetKey in targetKeyList) {
    var btsInfo = dsm.getBtsInfo(targetKey);
    dtm.putVar("TEMPLATE_NAME", "TEST.csv");

    $utl.createHeaderLine("sh");
[DIEt]
cd [/DIEt]$(btsInfo.getValue('BTSID'));[DIEt]
ls -lt
exit
[/DIEt]
}