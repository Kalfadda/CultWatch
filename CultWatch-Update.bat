@echo off
title CultWatch - Update
cd /d "%~dp0"
color 0B

echo.
echo   ================================================
echo      CultWatch  -  Update to the latest version
echo   ================================================
echo.

REM ---- Needs git (this folder must have been git-cloned) ----
where git >nul 2>nul
if errorlevel 1 goto NO_GIT
if not exist ".git" goto NOT_REPO

REM ---- Needs Node.js to reinstall/launch ----
where node >nul 2>nul
if errorlevel 1 goto NO_NODE

echo   Checking for updates...
echo.
git pull --ff-only
if errorlevel 1 goto PULL_FAIL

echo.
echo   Updating components (installs anything new)...
echo.
call npm install
if errorlevel 1 goto INSTALL_FAIL

echo.
echo   Up to date! Launching CultWatch...
echo   (You can minimize this black window - closing it closes the app.)
echo.
call npm start
exit /b


:NO_GIT
echo   This updater needs Git, which isn't installed.
echo   Opening the Git download page - install it (keep clicking
echo   Next), then double-click CultWatch-Update.bat again.
echo.
start "" https://git-scm.com/download/win
pause
exit /b

:NOT_REPO
echo   This folder wasn't set up with "git clone", so it can't
echo   auto-update. Ask Kaleb for the clone link, or just replace
echo   this folder with the newest copy.
echo.
pause
exit /b

:NO_NODE
echo   Node.js isn't installed. Double-click CultWatch.bat first -
echo   it will set everything up - then use this updater.
echo.
pause
exit /b

:PULL_FAIL
echo.
echo   Couldn't pull the latest version. Usually this means either:
echo     - no internet right now, or
echo     - you edited files in this folder (the update can't merge).
echo   If you didn't change anything, just try again in a minute.
echo.
pause
exit /b

:INSTALL_FAIL
echo.
echo   Downloaded the update but couldn't finish installing it -
echo   almost always a flaky connection. Run this again to retry.
echo.
pause
exit /b
