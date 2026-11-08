@echo off
setlocal
set LOGDIR=C:\Users\gsudh\Documents\projects\job-portal\scripts\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOGFILE=%LOGDIR%\%date:~-4,4%-%date:~-10,2%-%date:~-7,2%.log

echo [%date% %time%] Starting daily pipeline >> "%LOGFILE%"

REM 1. Start Docker Desktop if it isn't already running, then wait until the daemon responds.
docker info >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] Docker not running, starting Docker Desktop >> "%LOGFILE%"
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    :waitdocker
    timeout /t 5 >nul
    docker info >nul 2>&1
    if errorlevel 1 goto waitdocker
)
echo [%date% %time%] Docker is up >> "%LOGFILE%"

REM 2. Bring up the job-portal containers (no-op if already running).
cd /d "C:\Users\gsudh\Documents\projects\job-portal"
docker compose -p job-portal-live up -d >> "%LOGFILE%" 2>&1

REM 3. Start the submission runner if port 4100 isn't already listening.
netstat -ano | findstr ":4100" | findstr LISTENING >nul
if errorlevel 1 (
    echo [%date% %time%] Starting submission runner >> "%LOGFILE%"
    cd /d "C:\Users\gsudh\Documents\projects\job-portal-submission-runner"
    start "job-portal-submission-runner" /min cmd /c "node src\server.js >> ""%LOGFILE%"" 2>&1"
    timeout /t 5 >nul
)

REM 4. Give the app a moment to be reachable, then run the daily apply script.
timeout /t 5 >nul
cd /d "C:\Users\gsudh\Documents\projects\job-portal"
node scripts\daily-auto-apply.js >> "%LOGFILE%" 2>&1

echo [%date% %time%] Daily pipeline finished >> "%LOGFILE%"
endlocal
