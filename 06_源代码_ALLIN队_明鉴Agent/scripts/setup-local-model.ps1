$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $root 'runtime'
$modelDir=Join-Path $runtime 'models'
New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
$model=Join-Path $modelDir 'Qwen3-1.7B-Q8_0.gguf'
if(-not(Test-Path -LiteralPath $model)){
  Write-Host 'Downloading official Qwen model (1.83 GB). Internet is needed only for setup.'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://modelscope.cn/models/Qwen/Qwen3-1.7B-GGUF/resolve/master/Qwen3-1.7B-Q8_0.gguf' -OutFile ($model+'.part') -TimeoutSec 3600
  $digest=(Get-FileHash -LiteralPath ($model+'.part') -Algorithm SHA256).Hash
  if($digest -ne '061B54DAADE076B5D3362DAC252678D17DA8C68F07560BE70818CACE6590CB1A'){throw 'Model SHA256 mismatch. Download not trusted.'}
  Move-Item -LiteralPath ($model+'.part') -Destination $model
}
$engine=Join-Path $runtime 'llama/llama-server.exe'
if(-not(Test-Path -LiteralPath $engine)){
  $zip=Join-Path $runtime 'llama-verified.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ggml-org/llama.cpp/releases/download/b11918/llama-b11918-bin-win-cpu-x64.zip?download=1' -OutFile $zip -TimeoutSec 180
  if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne 'FF1A38F2BAE1C9A1C36097B208A6BE4DD24C86417C63C60DAA77F6FCA8D8F8FA'){throw 'Engine SHA256 mismatch.'}
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $runtime 'llama') -Force
}
Write-Host 'Model and engine are installed.'
