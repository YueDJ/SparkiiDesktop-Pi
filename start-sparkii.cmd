@echo off
rem Sparkii Desktop dev launcher - double-click to open the app window
set "SPARKII_DATA_DIR=%APPDATA%\Sparkii\data"
cd /d "C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\apps\desktop"
start "" "C:\Users\YDJ\Desktop\SparkiiDesktop-Pi\node_modules\.pnpm\electron@43.4.1_supports-color@7.2.0\node_modules\electron\dist\electron.exe" .
