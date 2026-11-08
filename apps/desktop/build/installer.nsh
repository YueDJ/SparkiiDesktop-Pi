; ── 运行时内容版本（RUNTIME_VERSION）────────────────────────────────────────────
; 这是**运行时内容**的版本，不是 app 版本。仅当 resources\runtime\（portable-git /
; document-parse / tools）的内容真的变化时才递增。
;
; 为什么不再用 app 版本（M2 层2）：NSIS 的 VERSION 宏由 NsisTarget.js 注入为 appInfo.version
; （每个发版都变）。拿它当标记粒度 ⇒ 跨版本升级时标记必然 ≠ 新 app 版本 ⇒ 即使运行时
; 内容一字未变也会重解压几百 MB。设计 §7.8 要求的是「内容未变则跳过」。
;
; 本文件同时被安装器与卸载器编译单元 include（NsisTarget 的 sharedHeader），所以这个
; define 在 customInstall / customUnInstall 两侧都可见。
!define SPARKII_RUNTIME_VERSION "1"

; sec.7.8 Minor-4 (B-gate acceptance (6)): customInstall skips the runtime re-extraction
; when the marker already equals the packaged RUNTIME_VERSION; unchanged runtimes are NOT
; re-extracted. First-install behavior is identical to the previous macro (no marker =>
; run the original logic verbatim). This macro does NOT write install-result.json -- the
; detached watchdog is its single writer (sec.7.7 / interface contract sec.6).
; Cleanup scope unchanged; never extended to other data\ contents.
;
; Marker convention: one line, content = ${SPARKII_RUNTIME_VERSION}, no trailing newline
; (FileWrite appends nothing; pairs with the FileRead below).
; $0 keeps holding the ExecWait exit code as before; $7/$8/$9 are new registers used
; only inside this macro. Labels sparkii_runtime_deploy / sparkii_runtime_done live in
; the installer compilation unit only and do not collide with the existing skip_docparse.
!macro customInstall
  DetailPrint "Checking Sparkii runtime version marker..."
  ClearErrors
  FileOpen $9 "$LOCALAPPDATA\SparkiiDesktop\runtime\sparkii-runtime.version" r
  IfErrors sparkii_runtime_deploy
  FileRead $9 $8
  FileClose $9
  StrCmp $8 "${SPARKII_RUNTIME_VERSION}" sparkii_runtime_done
  DetailPrint "Runtime version marker differs from ${SPARKII_RUNTIME_VERSION}; redeploying runtime..."
  sparkii_runtime_deploy:
    ; Remove the old marker BEFORE deploying: an interrupted run leaves no marker, so
    ; the next install re-extracts instead of wrongly skipping (idempotent).
    Delete "$LOCALAPPDATA\SparkiiDesktop\runtime\sparkii-runtime.version"
    DetailPrint "Installing Portable Git runtime..."
    ExecWait '"$INSTDIR\resources\runtime\portable-git.7z.exe" -o"$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git" -y' $0
    DetailPrint "Portable Git runtime extraction exit code: $0"
    StrCpy $7 $0
    DetailPrint "Installing search tools..."
    CreateDirectory "$LOCALAPPDATA\SparkiiDesktop\runtime\tools"
    CopyFiles /SILENT "$INSTDIR\resources\runtime\tools\fd.exe" "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\fd.exe"
    CopyFiles /SILENT "$INSTDIR\resources\runtime\tools\rg.exe" "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\rg.exe"
    Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\fd.exe"
    Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\rg.exe"
    RMDir "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin"
    IfFileExists "$INSTDIR\resources\runtime\document-parse\sparkii-document-parse.7z.exe" 0 skip_docparse
      DetailPrint "Preparing document parse..."
      ExecWait '"$INSTDIR\resources\runtime\document-parse\sparkii-document-parse.7z.exe" -o"$LOCALAPPDATA\SparkiiDesktop\runtime\document-parse" -y' $0
      DetailPrint "Document parse extraction exit code: $0"
    skip_docparse:
    ; Write the marker only when Portable Git extraction succeeded (exit code 0 saved
    ; in $7 before the document-parse branch may overwrite $0); on failure the marker
    ; stays absent so a repeat install retries the extraction.
    StrCmp $7 "0" 0 sparkii_runtime_done
    ClearErrors
    FileOpen $9 "$LOCALAPPDATA\SparkiiDesktop\runtime\sparkii-runtime.version" w
    IfErrors sparkii_runtime_done
    FileWrite $9 "${SPARKII_RUNTIME_VERSION}"
    FileClose $9
    DetailPrint "Sparkii runtime version marker written (${SPARKII_RUNTIME_VERSION})."
  sparkii_runtime_done:
!macroend

; customUnInstall: cleanup scope kept verbatim (two runtime dirs + runtime\tools +
; data\pi-agent\bin + the version marker); NEVER extended to other data\ contents.
;
; M2 层1（§7.7 步骤 7 / M2 根因）：升级链路上旧卸载器由 installUtil.nsh:224/230 以
; `/S … --updated` 运行，并在新安装器的 customInstall **之前**执行（installSection.nsh:52
; 早于 :82）。原先这里无条件删运行时和标记 ⇒ customInstall 永远读不到标记 ⇒ 每次升级
; 重解压。现在加 `${ifNot} ${isUpdated}` 守卫：
;   - 升级（isUpdated=true）⇒ 跳过清理，运行时与标记原样留给新安装器的 customInstall 判定；
;   - 完整卸载（isUpdated=false）⇒ 行为与本修复前完全一致（清理范围不变）。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\SparkiiDesktop\runtime\portable-git"
    RMDir /r "$LOCALAPPDATA\SparkiiDesktop\runtime\document-parse"
    Delete "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\fd.exe"
    Delete "$LOCALAPPDATA\SparkiiDesktop\runtime\tools\rg.exe"
    RMDir "$LOCALAPPDATA\SparkiiDesktop\runtime\tools"
    Delete "$LOCALAPPDATA\SparkiiDesktop\runtime\sparkii-runtime.version"
    Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\fd.exe"
    Delete "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin\rg.exe"
    RMDir "$LOCALAPPDATA\SparkiiDesktop\data\pi-agent\bin"
  ${endif}
!macroend
