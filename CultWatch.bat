@echo off
title CultWatch - Situation Room
cd /d "%~dp0"
color 0E

echo.
echo   ================================================
echo      CultWatch  -  Happy's Humble Burger Cult
echo   ================================================
echo.

REM ---- 1. Make sure Node.js is installed ----
where node >nul 2>nul
if errorlevel 1 goto NO_NODE

REM ---- 2. First run? Install dependencies. Otherwise just launch. ----
if not exist "node_modules\electron\package.json" goto INSTALL
goto RUN


:NO_NODE
echo   Node.js is required to run CultWatch, and it isn't installed yet.
echo.
where winget >nul 2>nul
if errorlevel 1 goto NODE_MANUAL
echo   Installing Node.js automatically (via winget). Approve any
echo   Windows prompts that pop up...
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo   ------------------------------------------------
echo   Node.js is installed. Please CLOSE this window and
echo   double-click CultWatch.bat again to finish setup.
echo   ------------------------------------------------
echo.
pause
exit /b

:NODE_MANUAL
echo   Opening the Node.js download page in your browser.
echo   Run the installer (just keep clicking Next / Install),
echo   then double-click CultWatch.bat again.
echo.
start "" https://nodejs.org/en/download/prebuilt-installer
pause
exit /b


:INSTALL
echo   First-time setup: installing CultWatch.
echo   This downloads the app and can take a few minutes on a
echo   fast connection - grab a coffee. You only do this once.
echo.
call npm install
if errorlevel 1 goto INSTALL_FAIL
echo.
echo   Setup complete!
echo.
goto RUN

:INSTALL_FAIL
echo.
echo   Setup failed - this is almost always a flaky internet
echo   connection. Check your wifi and double-click CultWatch.bat
echo   again to retry.
echo.
pause
exit /b


:RUN
echo   Launching CultWatch...
echo   (You can minimize this black window - closing it closes the app.)
echo.
call npm start
if errorlevel 1 (
  echo.
  echo   CultWatch closed with an error. Take a screenshot of this
  echo   window and send it to Kaleb.
  echo.
  pause
)
exit /b
