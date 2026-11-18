@echo off
if not exist "%~dp0..\dist\src\cli\main.js" goto notbuilt
node "%~dp0..\dist\src\cli\main.js" %*
exit /b %errorlevel%
:notbuilt
echo vconv is not built: run "npm install && npm run build" in %~dp0.. 1>&2
exit /b 2
