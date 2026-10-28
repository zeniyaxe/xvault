@echo off
rem Double-click launcher: .ps1 files open in an editor by default, this runs the setup properly.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_remote.ps1"
pause
