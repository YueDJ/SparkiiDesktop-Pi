# ============================================================================
# Task 0 / B-gate MANUAL Windows verification script.
# DO NOT RUN THIS ON THE DEVELOPMENT MACHINE'S REAL INSTALLATION.
#
# This script is a REPRODUCIBLE TEMPLATE for a human operator on an isolated
# Windows 10/11 test VM or a spare test user profile. The main agent did NOT
# execute it: /S reinstall, customUnInstall, MOTW/SmartScreen and UAC involve
# real GUI / real installation behaviour and would overwrite the existing
# Sparkii install at D:\software\SparkiiPi or mutate the real
# %LOCALAPPDATA%\SparkiiDesktop\data. That is explicitly forbidden by the
# kickoff prompt section 2.
#
# Read-only part (safe anywhere): section 1 below only READS the registry.
# Active part (isolated VM ONLY): sections 2-4 use a temp install dir, a temp
# SPARKII_DATA_DIR and a COPY of the installer.
# ============================================================================

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 1. READ-ONLY: current installation location (safe on any machine)
# ---------------------------------------------------------------------------
$uninstall = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' `
  -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*Sparkii*' } |
  Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, PSChildName

$uninstall | Format-List

# Design section 7.7 says read InstallLocation. Measured on the dev machine:
#   InstallLocation is EMPTY, UninstallString is
#   "D:\software\SparkiiPi\Uninstall Sparkii.exe" /currentuser
# Therefore the implementation MUST fall back to deriving the dir from
# UninstallString when InstallLocation is empty. Verify that fallback here:
foreach ($entry in $uninstall) {
  $derived = $null
  if ($entry.InstallLocation) { $derived = $entry.InstallLocation }
  elseif ($entry.UninstallString) {
    $m = [regex]::Match($entry.UninstallString, '^\s*"([^"]+\.exe)"')
    if ($m.Success) { $derived = Split-Path -Parent $m.Groups[1].Value }
  }
  Write-Output ("appId={0} InstallLocation='{1}' derived='{2}'" -f $entry.PSChildName, $entry.InstallLocation, $derived)
}

# ---------------------------------------------------------------------------
# 2. ACTIVE (isolated VM / spare test user ONLY)
#    Copy the installer, install into a TEMP dir with /S, no real data touched.
#    /D MUST be the LAST argument and MUST NOT be quoted, even with spaces.
# ---------------------------------------------------------------------------
# $installer = 'C:\path\to\Sparkii-0.1.0-win-x64.exe'
# $isoRoot   = Join-Path $env:TEMP 'sparkii-task0-isolated'
# $targetDir = Join-Path $isoRoot 'install-target'
# $isoData   = Join-Path $isoRoot 'data'
# New-Item -ItemType Directory -Force -Path $targetDir, $isoData | Out-Null
# $env:SPARKII_DATA_DIR = $isoData
# Copy-Item -LiteralPath $installer -Destination (Join-Path $isoRoot 'installer.exe') -Force
# $p = Start-Process -FilePath (Join-Path $isoRoot 'installer.exe') `
#      -ArgumentList @('/S', "/D=$targetDir") -Wait -PassThru
# Write-Output ("NSIS /S exitCode={0}" -f $p.ExitCode)
# # /S with perMachine:false should NOT trigger a UAC prompt. Record whether
# # one appeared; this is a HUMAN observation, not an automatable assertion.

# ---------------------------------------------------------------------------
# 3. ACTIVE (isolated VM ONLY): install directory consistency
# ---------------------------------------------------------------------------
# Get-ChildItem -LiteralPath $targetDir | Select-Object Name, Length | Format-Table
# $after = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' `
#   -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Sparkii*' }
# $after | Select-Object DisplayName, InstallLocation, UninstallString | Format-List
# # Assert: installed files land under $targetDir, not under a second default
# # path; shortcuts point at $targetDir; no duplicate installation exists.

# ---------------------------------------------------------------------------
# 4. ACTIVE (isolated VM ONLY): MOTW / SmartScreen / "unknown publisher"
# ---------------------------------------------------------------------------
# Get-Item -LiteralPath (Join-Path $isoRoot 'installer.exe') -Stream * |
#   Select-Object Stream, Length | Format-Table
# # Zone.Identifier presence depends on how the file was obtained. A file
# # written by Node fs (as electron-updater does) may have NO such stream.
# # SmartScreen / "unknown publisher" is a GUI observation: run the copied
# # installer by double-click (ShellExecuteEx) AND by Start-Process
# # (CreateProcess) and record whether a warning appears in each case.
# # Do NOT generalise from the dev machine.

# ---------------------------------------------------------------------------
# 5. CLEANUP (isolated VM ONLY; operator decides)
# ---------------------------------------------------------------------------
# Remove-Item -LiteralPath $isoRoot -Recurse -Force
# # NEVER point this at %LOCALAPPDATA%\SparkiiDesktop\data or at the real
# # install directory. Never run customUnInstall on the dev machine.
