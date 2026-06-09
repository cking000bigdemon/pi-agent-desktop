; Custom NSIS include — auto-loaded by electron-builder if present at build/installer.nsh.
;
; Goal: make the installer DEFAULT to the D: drive instead of %LOCALAPPDATA%
; (the per-user default). electron-builder's generated .onInit seeds $INSTDIR
; from the InstallLocation registry value; the preInit macro runs before that,
; so writing InstallLocation here changes the directory the install page shows.
; allowToChangeInstallationDirectory is on, so the user can still pick another.
;
; perMachine is false (per-user, no elevation), so the value is read from HKCU;
; the HKLM writes are harmless no-ops when not elevated and are kept only so the
; default also applies if a build is ever switched to per-machine.

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Program Files\${PRODUCT_NAME}"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Program Files\${PRODUCT_NAME}"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Program Files\${PRODUCT_NAME}"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Program Files\${PRODUCT_NAME}"
!macroend
