param([string]$OutputDir)
$ErrorActionPreference='Stop'
$projectDir=Split-Path -Parent $PSScriptRoot
if(-not $OutputDir){$OutputDir=Join-Path $projectDir '.build/narration'}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$scenes=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'demo-scenes.json') -Raw -Encoding utf8 | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$voice=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.SelectVoice('Microsoft Huihui Desktop')
  $voice.Rate=1
  for($i=0;$i -lt $scenes.Count;$i++) {
    $audioPath=Join-Path $OutputDir ('scene-'+$i+'.wav')
    $voice.SetOutputToWaveFile($audioPath)
    $voice.Speak($scenes[$i].narration)
    $voice.SetOutputToNull()
  }
} finally { $voice.Dispose() }
Write-Output ('Narration files: '+$scenes.Count)
