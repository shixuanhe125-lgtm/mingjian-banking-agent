$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
$runtimeDir=Join-Path $projectDir 'runtime'
$logDir=Join-Path $projectDir '.build'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$nodePath=Join-Path $runtimeDir 'node.exe'
if(-not(Test-Path -LiteralPath $nodePath)){
  $nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
  if(-not $nodeCommand){throw 'Node.js 24 is required. Install Node.js 24 or use the complete product folder.'}
  $nodePath=$nodeCommand.Source
}
$model=Join-Path $runtimeDir 'models/Qwen3-1.7B-Q8_0.gguf'
$engine=Join-Path $runtimeDir 'llama/llama-server.exe'
if(-not(Test-Path -LiteralPath $model) -or -not(Test-Path -LiteralPath $engine)){
  & (Join-Path $PSScriptRoot 'setup-local-model.ps1')
}
$keyFile=Join-Path $runtimeDir 'model.key'
if(-not(Test-Path -LiteralPath $keyFile)){
  $bytes=New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [System.IO.File]::WriteAllText($keyFile,([System.BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()))
}
$engineKey=Join-Path (Split-Path $engine) 'model.key'
Copy-Item -LiteralPath $keyFile -Destination $engineKey -Force
$health=$null
try{$health=Invoke-RestMethod 'http://127.0.0.1:8790/health' -TimeoutSec 2}catch{}
if(-not $health){
  Write-Host 'Loading local Qwen model. This normally takes 5-30 seconds...'
  $modelProcess=Start-Process -FilePath $engine -ArgumentList @('-m',('"'+$model+'"'),'--host','127.0.0.1','--port','8790','-c','4096','-t','6','-ngl','0','--parallel','1','--alias','mingjian-qwen','--no-ui','--reasoning','off','--api-key-file','model.key','--cors-origins','http://127.0.0.1:8787') -WorkingDirectory (Split-Path $engine) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'model.log') -RedirectStandardError (Join-Path $logDir 'model-error.log') -PassThru
  Set-Content -LiteralPath (Join-Path $logDir 'model.pid') -Value $modelProcess.Id
  for($i=0;$i -lt 90;$i++){
    Start-Sleep -Seconds 1
    try{$health=Invoke-RestMethod 'http://127.0.0.1:8790/health' -TimeoutSec 2;if($health.status -eq 'ok'){break}}catch{}
    if($modelProcess.HasExited){throw 'Model engine exited. See .build/model-error.log'}
  }
  if(-not $health){throw 'Model loading timed out. See .build/model-error.log'}
}
$web=$null
try{$web=Invoke-RestMethod 'http://127.0.0.1:8787/api/session' -TimeoutSec 2}catch{}
if(-not $web){
  $env:BANK_AGENT_MODE='llm'
  $appProcess=Start-Process -FilePath $nodePath -ArgumentList 'server.mjs' -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log') -PassThru
  Set-Content -LiteralPath (Join-Path $logDir 'server.pid') -Value $appProcess.Id
  for($i=0;$i -lt 15;$i++){Start-Sleep -Seconds 1;try{$web=Invoke-RestMethod 'http://127.0.0.1:8787/api/session' -TimeoutSec 2;if($web){break}}catch{}}
}
if(-not $web){throw 'Bank service failed to start. See .build/server-error.log'}
Start-Process 'http://127.0.0.1:8787/'
Write-Host 'Mingjian Agent is ready. The browser is open.'
Write-Host 'Use the stop shortcut to stop both local processes.'
