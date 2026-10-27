$projectDir=Split-Path -Parent $PSScriptRoot
foreach($name in @('server','model')){
  $pidFile=Join-Path $projectDir ('.build/'+$name+'.pid')
  if(Test-Path -LiteralPath $pidFile){
    $taskPid=Get-Content -LiteralPath $pidFile
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$taskPid) -ErrorAction SilentlyContinue
    $expected=if($name -eq 'server'){'server.mjs'}else{'llama-server.exe'}
    if($process -and $process.CommandLine -like ('*'+$expected+'*')){Stop-Process -Id ([int]$taskPid) -ErrorAction SilentlyContinue}
  }
}
Write-Host 'Mingjian local processes stopped.'
