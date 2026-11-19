; Custom NSIS hooks. electron-builder picks this file up automatically (nsis.include defaults to build/installer.nsh).

; On install, the one-click installer saves a copy of itself to
; %LOCALAPPDATA%\<name>-updater\installer.exe (about 120 MB), and the stock uninstaller never removes it.
; Remove it on a real uninstall only: during an upgrade the old version is uninstalled with
; --updated, and the new installer has already written its own copy there.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !ifdef APP_INSTALLER_STORE_FILE
      ; perMachine is false, so $LOCALAPPDATA is the current user's, the same place the installer wrote to.
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
      ; Not /r: this only removes the folder if it's now empty, so a bad path can never delete anything else.
      RMDir "$R0"
    !endif
  ${endIf}
!macroend
