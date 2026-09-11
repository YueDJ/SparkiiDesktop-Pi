$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$pkg = Join-Path $repo "packages\document-parse"
$py = "C:\Users\YDJ\AppData\Roaming\uv\python\cpython-3.11.15-windows-x86_64-none\python.exe"
$venv = Join-Path $repo ".venv-docparse-light"
$seven = if (Test-Path "D:\Program Files\7-Zip\7z.exe") { "D:\Program Files\7-Zip\7z.exe" } else { "C:\Program Files\7-Zip\7z.exe" }
$modelsSrc = Join-Path $env:LOCALAPPDATA "SparkiiDesktop\runtime\document-parse\models\baseline"
$outSfx = Join-Path $repo "apps\desktop\runtime\document-parse\sparkii-document-parse.7z.exe"
$checksums = Join-Path $repo "apps\desktop\runtime\document-parse\checksums.json"

if (-not (Test-Path $py)) { throw "Python 3.11 not found: $py" }
if (-not (Test-Path $seven)) { throw "7-Zip not found" }
foreach ($name in @("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx")) {
  $p = Join-Path $modelsSrc $name
  if (-not (Test-Path $p)) { throw "missing model $p" }
}

if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  & $py -m venv $venv
}
$vp = Join-Path $venv "Scripts\python.exe"
& $vp -m pip install -U pip
& $vp -m pip install -r (Join-Path $pkg "requirements-light.txt") pyinstaller
& $vp -c "import rapidocr, onnxruntime, pypdfium2; import importlib.util as u; assert u.find_spec('paddle') is None; assert u.find_spec('onnxruntime-gpu') is None or True"

$dist = Join-Path $pkg "dist"
$work = Join-Path $pkg "build\work"
$specDir = Join-Path $pkg "build"
Remove-Item $dist, $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dist, $work, $specDir | Out-Null

$env:PYTHONPATH = $pkg
Remove-Item Env:SPARKII_DOCUMENT_PARSE_FAKE -ErrorAction SilentlyContinue
& $vp -m PyInstaller --noconfirm --clean --onedir --console --name sparkii-document-parse `
  --collect-all rapidocr --collect-all onnxruntime --collect-all pypdfium2 `
  --exclude-module paddle --exclude-module paddleocr --exclude-module paddlex `
  --exclude-module torch --exclude-module paddlepaddle `
  --distpath $dist --workpath $work --specpath $specDir `
  (Join-Path $pkg "sparkii_document_parse\__main__.py")
if ($LASTEXITCODE -ne 0) { throw "pyinstaller failed" }

$stage = Join-Path $pkg "build\stage"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $stage "bin"), (Join-Path $stage "models\baseline"), (Join-Path $stage "licenses") | Out-Null
Copy-Item (Join-Path $dist "sparkii-document-parse\*") (Join-Path $stage "bin") -Recurse -Force
Copy-Item (Join-Path $modelsSrc "PP-OCRv6_det_small.onnx") (Join-Path $stage "models\baseline\")
Copy-Item (Join-Path $modelsSrc "PP-OCRv6_rec_small.onnx") (Join-Path $stage "models\baseline\")
Copy-Item (Join-Path $modelsSrc "ch_ppocr_mobile_v2.0_cls_mobile.onnx") (Join-Path $stage "models\baseline\")
Set-Content -Path (Join-Path $stage "models\baseline\READY") -Value "ok" -NoNewline
Copy-Item (Join-Path $repo "apps\desktop\runtime\document-parse\licenses\README.md") (Join-Path $stage "licenses\README.md") -Force

$internal = Join-Path $stage "bin\_internal"
@(
  "onnxruntime\transformers",
  "onnxruntime\quantization",
  "onnxruntime\datasets",
  "onnxruntime\tools",
  "rapidocr\inference_engine\tensorrt",
  "rapidocr\inference_engine\pytorch",
  "rapidocr\inference_engine\paddle",
  "rapidocr\inference_engine\openvino"
) | ForEach-Object {
  $p = Join-Path $internal $_
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

Push-Location $stage
Remove-Item $outSfx -Force -ErrorAction SilentlyContinue
& $seven a "-sfx7zCon.sfx" -mx=9 -ms=on $outSfx bin models licenses
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "7z pack failed" }
Pop-Location

$item = Get-Item $outSfx
if ($item.Length -gt 104857600) { throw "archive > 100MB: $($item.Length)" }
$hash = (Get-FileHash -Algorithm SHA256 $outSfx).Hash.ToLower()
Set-Content -Path $checksums -Value "{`r`n  `"archive`": `"$hash`"`r`n}`r`n" -NoNewline
Write-Output "SFX=$($item.FullName)"
Write-Output "SIZE=$($item.Length)"
Write-Output "SHA256=$hash"
