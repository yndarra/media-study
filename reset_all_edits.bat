@echo off
chcp 65001 >nul
rem Полный сброс проекта к результату этапа 1: все ручные правки фрагментов
rem (границы, текст, удаления, объединения, разделения, запас) отбрасываются,
rem манифест собирается заново из уже готовых файлов проекта - без скачивания
rem и без распознавания речи. Затем редактор перезапускается.
rem Текущий манифест не теряется: он сохраняется рядом как manifest.bak-<дата-время>.json.
rem
rem Необязательный первый аргумент - папка проекта (data\<id>);
rem по умолчанию - текущее тестовое видео.

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

echo Все правки фрагментов в %PROJECT_DIR% будут сброшены к результату этапа 1.
echo Текущий манифест сохранится рядом как резервная копия manifest.bak-...json
echo.
rem Цифры, а не буквы - чтобы подтверждение работало в любой раскладке.
choice /c 12 /n /m "1 - сбросить, 2 - отмена: "
if errorlevel 2 exit /b 0

rem Редактор закрывается, чтобы он не пересохранил старый манифест и не
rem держал в памяти историю правок, которой больше нет.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-m webapp.run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

py -3.12 -m phase1_ingest.rebuild --project-dir "%PROJECT_DIR%"
if errorlevel 1 (
    echo.
    echo Пересборка не удалась - редактор не запускаю, манифест не тронут.
    pause
    exit /b 1
)

call "%~dp0open_editor.bat" "%PROJECT_DIR%"
exit /b 0
