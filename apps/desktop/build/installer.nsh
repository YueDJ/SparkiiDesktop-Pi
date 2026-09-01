!macro customInstall
  DetailPrint "Installing Portable Git runtime..."
  ExecWait '"$INSTDIR\resources\runtime\portable-git.7z.exe" -o"$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git" -y' $0
  DetailPrint "Portable Git runtime extraction exit code: $0"
  DetailPrint "Installing search tools..."
  CreateDirectory "$LOCALAPPDATA\SparkiiDesktop\runtime\tools"
  CopyFiles /SILENT "$INSTDIR\resources\runtime\tools\fd.exe" "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\fd.exe"
  CopyFiles /SILENT "$INSTDIR\resources\runtime\tools\rg.exe" "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\rg.exe"
  Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\fd.exe"
  Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\rg.exe"
  RMDir "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin"
!macroend

!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git"
  Delete "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\fd.exe"
  Delete "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\rg.exe"
  RMDir "$LOCALAPPDATA\SparkiiDesktop\runtime\tools"
  Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\fd.exe"
  Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\rg.exe"
  RMDir "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin"
!macroend
