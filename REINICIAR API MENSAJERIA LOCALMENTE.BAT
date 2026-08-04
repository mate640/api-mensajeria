@echo off

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

net stop "ServicioApiMensajeria"
net start "ServicioApiMensajeria"

echo.
echo Servicio reiniciado correctamente.
