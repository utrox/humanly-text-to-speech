# Installs the Humanly TTS helper for the current Windows user (no admin rights needed).
# It sets up Python packages in a private folder, downloads the Kokoro voice model (~350 MB),
# and registers the helper with Firefox.
# Native programs (pip, curl) write progress to stderr; check exit codes instead of stopping on it.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # makes downloads much faster in Windows PowerShell

$Name      = 'humanly_tts'
$ExtId     = 'humanly-tts@utrox.github.io'
$Dest      = Join-Path $env:LOCALAPPDATA 'HumanlyTTS'
$ModelBase = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1'
$Files = @(
  @{ Name = 'kokoro-v1.0.onnx'; Sha = 'beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a' },
  @{ Name = 'voices-v1.0.bin';  Sha = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' }
)

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host $text -ForegroundColor Red; exit 1 }

# 1. Find Python 3.10 or newer (the "py" launcher first; the Store alias "python" is ignored).
Step 'Looking for Python'
function Get-PyVersion([string]$exe, [string[]]$pre) {
  try {
    # No quotes inside -c: Windows PowerShell 5.1 strips them when calling programs.
    $v = & $exe @pre -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])' 2>$null
    if ($LASTEXITCODE -eq 0 -and "$v" -match '^\d+$' -and [int]"$v" -ge 310) { return [int]"$v" }
  } catch { }
  return 0
}
$PyExe = $null; $PyPre = @()
if (($v = Get-PyVersion 'py' @('-3')) -gt 0) { $PyExe = 'py'; $PyPre = @('-3') }
elseif (($v = Get-PyVersion 'python' @()) -gt 0) { $PyExe = 'python' }
if (-not $PyExe) {
  Write-Host 'Python 3.10 or newer was not found.'
  $answer = Read-Host 'Install Python 3.12 now with winget? (Y/n)'
  if ($answer -ne 'n') {
    winget install --id Python.Python.3.12 -e --scope user --accept-package-agreements --accept-source-agreements
    Fail 'Python was installed. Close this window and run install.bat again.'
  }
  Fail 'Install Python from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run install.bat again.'
}
Write-Host ("Using {0} {1} (Python {2}.{3})" -f $PyExe, ($PyPre -join ' '), [math]::Floor($v / 100), ($v % 100))

# 2. Private folder with its own Python environment.
Step "Setting up $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'humanly_tts_host.py') $Dest
$Venv = Join-Path $Dest 'venv'
$Py = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path $Py)) { & $PyExe @PyPre -m venv $Venv; if ($LASTEXITCODE) { Fail 'Could not create the Python environment.' } }

Step 'Installing the voice engine (a few minutes the first time)'
& $Py -m pip install --upgrade pip --quiet
& $Py -m pip install --quiet 'kokoro-onnx==0.6.1'
if ($LASTEXITCODE) { Fail 'Installing kokoro-onnx failed. Check your internet connection and run install.bat again.' }
# Swap in the DirectML build of ONNX Runtime so the voice can use the graphics card.
& $Py -m pip uninstall --yes --quiet onnxruntime
& $Py -m pip install --quiet onnxruntime-directml
if ($LASTEXITCODE) {
  Write-Host 'Graphics card support could not be installed; the helper will use the processor.' -ForegroundColor Yellow
  & $Py -m pip install --quiet onnxruntime
  if ($LASTEXITCODE) { Fail 'Installing ONNX Runtime failed.' }
}

# espeak-ng can't read its data from deep paths, so keep a copy at a short one.
$EspeakSrc = & $Py -c 'import espeakng_loader as e; print(e.get_data_path())'
if ($LASTEXITCODE -or -not (Test-Path "$EspeakSrc")) { Fail 'Could not find the espeak-ng pronunciation data.' }
$EspeakDst = Join-Path $Dest 'espeak-ng-data'
if (Test-Path $EspeakDst) { Remove-Item -Recurse -Force $EspeakDst }
Copy-Item -Recurse -Force "$EspeakSrc" $EspeakDst

# 3. Voice model files, checked against known fingerprints.
Step 'Downloading the voice model (about 350 MB)'
foreach ($f in $Files) {
  $path = Join-Path $Dest $f.Name
  $ok = (Test-Path $path) -and ((Get-FileHash $path -Algorithm SHA256).Hash.ToLower() -eq $f.Sha)
  if (-not $ok) {
    Write-Host "Downloading $($f.Name)..."
    & curl.exe -L --fail --progress-bar -o $path "$ModelBase/$($f.Name)"
    if ($LASTEXITCODE) { Invoke-WebRequest -Uri "$ModelBase/$($f.Name)" -OutFile $path }
    if ((Get-FileHash $path -Algorithm SHA256).Hash.ToLower() -ne $f.Sha) { Remove-Item $path; Fail "$($f.Name) did not download correctly. Run install.bat again." }
  } else { Write-Host "$($f.Name) already downloaded." }
}

# 4. Register with Firefox (native messaging).
Step 'Registering the helper with Firefox'
$Bat = Join-Path $Dest 'run_helper.bat'
Set-Content -Path $Bat -Encoding ASCII -Value "@echo off`r`n`"%~dp0venv\Scripts\python.exe`" `"%~dp0humanly_tts_host.py`" %*"
$Manifest = Join-Path $Dest "$Name.json"
$json = [ordered]@{
  name = $Name
  description = 'Humanly TTS voice helper'
  path = $Bat
  type = 'stdio'
  allowed_extensions = @($ExtId)
} | ConvertTo-Json
[System.IO.File]::WriteAllText($Manifest, $json, (New-Object System.Text.UTF8Encoding $false))
$Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$Name"
New-Item -Path $Key -Force | Out-Null
Set-Item -Path $Key -Value $Manifest

# 5. Self-test: load the voice and say a sentence.
Step 'Testing the voice (you should hear a sentence)'
& $Py (Join-Path $Dest 'humanly_tts_host.py') --selftest
if ($LASTEXITCODE) { Fail 'The self-test failed. The messages above say why.' }

Write-Host ''
Write-Host 'Done. Restart Firefox, open the reader and press play.' -ForegroundColor Green
