@echo off
setlocal EnableExtensions
title XVault - FFmpeg Animation Helper
cd /d "%~dp0"
cls
echo ============================================================
echo             XVault Animation Helper
echo ============================================================
echo.
rem Windows ships a "python.exe" Store shortcut that only opens the Microsoft Store (exit code 49).
rem Accept a candidate only if it really runs.
set "PYTHON="
for %%C in ("py -3" "python" "python3") do if not defined PYTHON (%%~C -c "import sys" >nul 2>nul && set "PYTHON=%%~C")
if not defined PYTHON for /d %%D in ("%LOCALAPPDATA%\Python\pythoncore-*" "%LOCALAPPDATA%\Programs\Python\Python3*" "%ProgramFiles%\Python3*") do if not defined PYTHON if exist "%%~D\python.exe" ("%%~D\python.exe" -c "import sys" >nul 2>nul && set "PYTHON="%%~D\python.exe"")
if not defined PYTHON (
  echo [ERROR] No working Python 3 was found.
  echo         Windows' built-in python.exe is only a Microsoft Store shortcut.
  echo         Install Python from https://www.python.org/downloads/ and tick "Add python.exe to PATH",
  echo         or run:  winget install Python.Python.3.12
  pause
  exit /b 1
)
if not exist "%~dp0xvault_ffmpeg_helper.py" (echo [ERROR] xvault_ffmpeg_helper.py missing.&pause&exit /b 1)
echo [OK] Python:
%PYTHON% --version
echo.
where ffmpeg.exe >nul 2>nul && (echo [OK] FFmpeg found in PATH.) || (if exist "%~dp0ffmpeg.exe" (echo [OK] Local ffmpeg.exe found.) else echo [WARNING] FFmpeg not found yet. Run setup_helper.bat to install it.)
if exist "%~dp0config.json" (echo [OK] config.json found.) else echo [WARNING] Run setup_helper.bat first.
echo.
echo Local status bridge: http://127.0.0.1:17843/status
echo Keep this window open. Press Ctrl+C to stop.
echo ============================================================
echo.
%PYTHON% -u "%~dp0xvault_ffmpeg_helper.py"
set "EC=%ERRORLEVEL%"
echo.
echo Helper stopped with exit code %EC%.
pause
exit /b %EC%
