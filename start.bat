@echo off
chcp 65001 >nul
rem Запускает приложение (сервер без окна) и показывает страницу в браузере.
rem Можно просто дважды кликнуть по файлу. Это окно-лаунчер закрывается само.
rem
rem Если страница приложения уже открыта в браузере, новая вкладка не
rem открывается: открытая сама перезагрузится (самая свежая из копий),
rem как только поднимется новый сервер.
rem
rem Все видео и аудио – в папке data\ рядом с этим файлом (создаётся сама при
rem первом запуске; в git не попадает).

cd /d "%~dp0"
if not exist "data" mkdir "data"

rem Если приложение уже запущено (возможно, со старым кодом) - закрываем его,
rem иначе новая страница будет разговаривать со старым сервером.
rem Трогаются только процессы, запущенные командой media_study.web.run.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-m media_study.web.run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem Сервер – без окна консоли (pyw); журнал – data\server.log, его видно в
rem приложении (низ меню: "Журнал"), там же кнопка "Остановить".
start "" pyw -3.12 -m media_study.web.run --data-dir "data" --log-file "data\server.log"

rem Ждём, пока сервер поднимется и открытые вкладки успеют отметиться.
rem Код 1 - вкладка уже открыта (она перезагрузится сама), 0 - открываем новую.
powershell -NoProfile -Command "for ($i = 0; $i -lt 80; $i++) { try { $r = Invoke-RestMethod http://127.0.0.1:8000/api/clients -TimeoutSec 1; if ($r.ready) { if ($r.count -gt 0) { exit 1 } else { exit 0 } } } catch {}; Start-Sleep -Milliseconds 250 }; exit 0"
if errorlevel 1 exit /b 0
start "" "http://127.0.0.1:8000/"
exit /b 0
