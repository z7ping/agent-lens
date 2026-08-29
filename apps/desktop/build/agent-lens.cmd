@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "AGENT_LENS_DISTRIBUTION=desktop"
set "AGENT_LENS_INSTALLATION_EXECUTABLE=%~dp0AgentLens.exe"
set "AGENT_LENS_HOOK_ROOT=%~dp0resources\app.asar.unpacked\runtime\hooks"
"%~dp0AgentLens.exe" "%~dp0resources\app.asar.unpacked\runtime\cli.mjs" %*
set "AGENT_LENS_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %AGENT_LENS_EXIT_CODE%
