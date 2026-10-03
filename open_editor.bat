@echo off
chcp 65001 >nul
rem Запускает веб-редактор фрагментов в отдельном окне и показывает страницу.
rem Можно просто дважды кликнуть по файлу. Это окно-лаунчер закрывается само;
rem окно сервера остаётся (закрыть его = остановить редактор).
rem
rem Если страница редактора уже открыта в браузере, новая вкладка не
rem открывается: открытая сама перезагрузится (самая свежая из копий),
rem как только поднимется новый сервер.
rem
rem Необязательный первый аргумент - папка проекта (data\<id>);
rem по умолчанию открывается текущее тестовое видео.

cd /d "%~dp0"
set "PROJECT_DIR=%~1"
rem Без аргумента - последнее обработанное видео (data\current_project.txt).
rem Другое видео: перетащите его папку из data\ на этот файл.
if "%PROJECT_DIR%"=="" if exist "data\current_project.txt" set /p PROJECT_DIR=<"data\current_project.txt"
if "%PROJECT_DIR%"=="" set "PROJECT_DIR=gTKS8SAwUzE"
if not exist "%PROJECT_DIR%\manifest.json" if exist "data\%PROJECT_DIR%\manifest.json" set "PROJECT_DIR=data\%PROJECT_DIR%"

if not exist "%PROJECT_DIR%\manifest.json" (
    echo Не найден проект: %PROJECT_DIR%
    pause
    exit /b 1
)

rem Если редактор уже запущен (возможно, со старым кодом) - закрываем его,
rem иначе новая страница будет разговаривать со старым сервером.
rem Трогаются только процессы, запущенные командой webapp.run.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-m webapp.run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem Сервер – без окна консоли (pyw); журнал – data\server.log, его видно в
rem приложении (низ меню: "Журнал"), там же кнопка "Остановить".
start "" pyw -3.12 -m webapp.run --project-dir "%PROJECT_DIR%" --log-file "data\server.log"

rem Ждём, пока сервер поднимется и открытые вкладки успеют отметиться.
rem Код 1 - вкладка уже открыта (она перезагрузится сама), 0 - открываем новую.
powershell -NoProfile -Command "for ($i = 0; $i -lt 80; $i++) { try { $r = Invoke-RestMethod http://127.0.0.1:8000/api/clients -TimeoutSec 1; if ($r.ready) { if ($r.count -gt 0) { exit 1 } else { exit 0 } } } catch {}; Start-Sleep -Milliseconds 250 }; exit 0"
if errorlevel 1 exit /b 0
start "" "http://127.0.0.1:8000/"
exit /b 0
