@echo off
REM Cai ClaudeMon cho may nay. Nhap dup la chay, chay lai bao nhieu lan cung duoc.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (echo Xong.) else (echo Cai chua tron, ma loi %RC%. Doc thong bao o tren.)
pause
exit /b %RC%
