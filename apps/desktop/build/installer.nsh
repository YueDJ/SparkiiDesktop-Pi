!macro customInstall
  DetailPrint "Installing Portable Git runtime..."
  ExecWait '"$INSTDIR\resources\runtime\portable-git.7z.exe" -o"$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git" -y' $0
  DetailPrint "Portable Git runtime extraction exit code: $0"
!macroend

!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git"
!macroend
