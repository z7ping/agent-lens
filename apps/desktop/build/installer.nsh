!include "LogicLib.nsh"

; AgentLens Windows 安装/卸载策略：
; 1. 升级/重装由 electron-builder 依据稳定 appId/GUID 识别旧安装并清理旧程序文件。
; 2. 升级过程中始终保留 ~/.agent-lens/1.0，不询问删除数据。
; 3. 仅用户主动卸载时询问是否删除 AgentLens 本地数据，默认保留。
;
; 注意：本文件只处理 AgentLens 独立数据目录。Electron 自己的 APPDATA 目录仍由
; electron-builder 默认卸载逻辑管理；当前 deleteAppDataOnUninstall=false。

!macro customHeader
  ; 辅助安装器检测到已有安装时明确告诉用户这是升级，而不是要求先手工卸载。
  !pragma warning disable 6030
  LangString reinstallUpgrade 1033 "Setup will automatically upgrade the existing AgentLens installation. Local observation data will be preserved."
  LangString reinstallUpgrade 2052 "安装程序将自动升级现有 AgentLens，无需手动卸载；本地观测数据会保留。"
  !pragma warning enable 6030
!macroend

!macro customUnInstall
  ; electron-builder 在升级时会以更新模式执行卸载清理。此时绝不能询问或删除用户数据。
  ${IfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "是否同时删除 AgentLens 本地数据？$\r$\n$\r$\n选择“否”将保留 ~/.agent-lens/1.0 中的会话、观测数据库、证据与备份索引，之后重新安装仍可继续使用。$\r$\n$\r$\n仅在确定不再需要这些数据时选择“是”。" \
      /SD IDNO IDNO agentLensKeepData IDYES agentLensDeleteData

    agentLensDeleteData:
      DetailPrint "Deleting AgentLens local data: $PROFILE\.agent-lens\1.0"
      RMDir /r "$PROFILE\.agent-lens\1.0"
      Goto agentLensDataDone

    agentLensKeepData:
      DetailPrint "Keeping AgentLens local data: $PROFILE\.agent-lens\1.0"

    agentLensDataDone:
  ${EndIf}
!macroend
