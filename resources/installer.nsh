; Stitch installer theme — the app's dark look carried into the NSIS wizard.
; electron-builder includes this before MUI2 and its page list, so the defines
; below restyle the stock pages; functions live in customHeader (after MUI2).
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!define STITCH_BG "0E0C17"
!define STITCH_FIELD "1C1929"
!define STITCH_TEXT "F2EEF8"
!define STITCH_MUTED "9C95B0"
; COLORREFs (0x00BBGGRR) for the progress bar and window chrome.
!define STITCH_ACCENT_REF 0x006C8AF0
!define STITCH_TRACK_REF 0x00352226
!define STITCH_BG_REF 0x00170C0E

!define MUI_BGCOLOR "${STITCH_BG}"
!define MUI_TEXTCOLOR "${STITCH_TEXT}"
!define MUI_HEADER_TRANSPARENT_TEXT
; Classic check boxes so the finish page's "Launch Stitch" text takes our colours.
!define MUI_FORCECLASSICCONTROLS
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "Stop installing Stitch?"

InstProgressFlags smooth

!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT StitchGuiInit
  !define MUI_FINISHPAGE_TITLE "Stitch is ready"
  !define MUI_FINISHPAGE_TEXT "Stitch is installed. It checks GitHub for new versions on its own and asks before restarting to update.$\r$\n$\r$\nTip: point it at your Stability Matrix models in Settings → Models && storage."
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Stitch"
!else
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.StitchGuiInit
!endif

; ── Pages ────────────────────────────────────────────────────────────────────

; Per-user install: no admin prompt now or when updates install.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Stitch"
  !define MUI_WELCOMEPAGE_TEXT "Your local AI studio and story engine — consistent characters, scenes, video, music and voices, made on your own GPUs.$\r$\n$\r$\nSetup installs Stitch ${VERSION} for your account. No administrator rights needed, and future updates install themselves.$\r$\n$\r$\nClick Next to choose where it goes."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  ; Consumed by the progress page that follows.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW StitchInstFilesShow
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall Stitch"
  !define MUI_WELCOMEPAGE_TEXT "This removes the Stitch app from your computer.$\r$\n$\r$\nYour library, stories, characters, voices and settings stay where they are, so everything is waiting if you install Stitch again.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_UNPAGE_WELCOME
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.StitchInstFilesShow
!macroend

; ── Painting ─────────────────────────────────────────────────────────────────

; Dark title bar + caption colour (Windows 11), dark buttons, quiet chrome.
!macro StitchPaintOuter
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${STITCH_BG_REF}, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${STITCH_BG_REF}, i 4)'
  SetCtlColors $HWNDPARENT "${STITCH_TEXT}" "${STITCH_BG}"
  ; MUI toggles these separators per page, so collapse them instead of hiding.
  System::Call 'user32::SetWindowPos(p $mui.Line.Standard, p 0, i 0, i 0, i 0, i 0, i 0x16)'
  System::Call 'user32::SetWindowPos(p $mui.Line.FullWindow, p 0, i 0, i 0, i 0, i 0, i 0x16)'
  ; …and the etched rule under the header (control 1036).
  Push $R0
  GetDlgItem $R0 $HWNDPARENT 1036
  System::Call 'user32::SetWindowPos(p $R0, p 0, i 0, i 0, i 0, i 0, i 0x16)'
  Pop $R0
  SetCtlColors $mui.Branding.Text "${STITCH_MUTED}" "${STITCH_BG}"
  SetCtlColors $mui.Branding.Background "${STITCH_MUTED}" "${STITCH_BG}"
  System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Next, w "DarkMode_Explorer", p 0)'
  System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Back, w "DarkMode_Explorer", p 0)'
  System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Cancel, w "DarkMode_Explorer", p 0)'
!macroend

; Every control on the current inner page gets the dark palette.
!macro StitchPaintInner
  FindWindow $R9 "#32770" "" $HWNDPARENT
  SetCtlColors $R9 "${STITCH_TEXT}" "${STITCH_BG}"
  StrCpy $R8 0
  ${Do}
    FindWindow $R8 "" "" $R9 $R8
    ${If} $R8 == 0
      ${Break}
    ${EndIf}
    SetCtlColors $R8 "${STITCH_TEXT}" "${STITCH_BG}"
  ${Loop}
!macroend

!macro StitchPaintProgress
  !insertmacro StitchPaintInner
  GetDlgItem $R8 $R9 1004
  System::Call 'uxtheme::SetWindowTheme(p $R8, w " ", w " ")'
  SendMessage $R8 ${PBM_SETBARCOLOR} 0 ${STITCH_ACCENT_REF}
  SendMessage $R8 ${PBM_SETBKCOLOR} 0 ${STITCH_TRACK_REF}
  GetDlgItem $R8 $R9 1006
  SetCtlColors $R8 "${STITCH_MUTED}" "${STITCH_BG}"
  GetDlgItem $R8 $R9 1016
  SendMessage $R8 ${LVM_SETBKCOLOR} 0 ${STITCH_BG_REF}
  SendMessage $R8 ${LVM_SETTEXTBKCOLOR} 0 ${STITCH_BG_REF}
  SendMessage $R8 ${LVM_SETTEXTCOLOR} 0 0x00F8EEF2
!macroend

!ifndef PBM_SETBARCOLOR
  !define PBM_SETBARCOLOR 0x0409
!endif
!ifndef PBM_SETBKCOLOR
  !define PBM_SETBKCOLOR 0x2001
!endif
!ifndef LVM_SETBKCOLOR
  !define LVM_SETBKCOLOR 0x1001
!endif
!ifndef LVM_SETTEXTCOLOR
  !define LVM_SETTEXTCOLOR 0x1024
!endif
!ifndef LVM_SETTEXTBKCOLOR
  !define LVM_SETTEXTBKCOLOR 0x1026
!endif

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function StitchGuiInit
      !insertmacro StitchPaintOuter
    FunctionEnd

    ; The hidden install-mode page swallows a SHOW hook meant for the
    ; install-location page, so paint that page when NSIS first validates its
    ; folder (which happens as the page opens) — once per page instance.
    Var StitchDirPainted
    Function .onVerifyInstDir
      Push $R8
      Push $R9
      FindWindow $R9 "#32770" "" $HWNDPARENT
      GetDlgItem $R8 $R9 1019
      ${If} $R8 != 0
      ${AndIf} $R9 != $StitchDirPainted
        StrCpy $StitchDirPainted $R9
        Call StitchDirectoryShow
      ${EndIf}
      Pop $R9
      Pop $R8
    FunctionEnd

    Function StitchDirectoryShow
      !insertmacro StitchPaintInner
      ; Install folder field + Browse in the dark style; drop the etched group frame.
      GetDlgItem $R8 $R9 1019
      SetCtlColors $R8 "${STITCH_TEXT}" "${STITCH_FIELD}"
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_CFD", p 0)'
      GetDlgItem $R8 $R9 1001
      System::Call 'uxtheme::SetWindowTheme(p $R8, w "DarkMode_Explorer", p 0)'
      GetDlgItem $R8 $R9 1020
      ShowWindow $R8 ${SW_HIDE}
      GetDlgItem $R8 $R9 1023
      SetCtlColors $R8 "${STITCH_MUTED}" "${STITCH_BG}"
      GetDlgItem $R8 $R9 1024
      SetCtlColors $R8 "${STITCH_MUTED}" "${STITCH_BG}"
    FunctionEnd

    Function StitchInstFilesShow
      !insertmacro StitchPaintProgress
    FunctionEnd
  !else
    Function un.StitchGuiInit
      !insertmacro StitchPaintOuter
    FunctionEnd

    Function un.StitchInstFilesShow
      !insertmacro StitchPaintProgress
    FunctionEnd
  !endif
!macroend
