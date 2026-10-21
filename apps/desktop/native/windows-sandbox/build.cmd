@echo off
setlocal
set "ROOT=%~dp0"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Windows sandbox build requires Visual Studio C++ Build Tools. 1>&2
  exit /b 1
)
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%I"
if not defined VSPATH (
  echo Visual Studio C++ Build Tools installation not found. 1>&2
  exit /b 1
)
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if not exist "%ROOT%bin" mkdir "%ROOT%bin"
if not exist "%ROOT%bin\obj" mkdir "%ROOT%bin\obj"
cl.exe /nologo /O2 /EHsc /std:c++17 /MT /Fo:"%ROOT%bin\obj\\" /Fe:"%ROOT%bin\SparkiiSandbox.exe" "%ROOT%SparkiiSandbox.cpp" /link userenv.lib advapi32.lib
if errorlevel 1 exit /b 1
cl.exe /nologo /O2 /EHsc /std:c++17 /MT /Fo:"%ROOT%bin\obj\\" /Fe:"%ROOT%bin\SandboxProbe.exe" "%ROOT%SandboxProbe.cpp" /link ws2_32.lib
if errorlevel 1 exit /b 1
endlocal
