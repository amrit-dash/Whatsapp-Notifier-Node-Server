@echo off
:: BatchGotAdmin
:-------------------------------------
REM  --> Check for permissions
>nul 2>&1 "%SYSTEMROOT%\\system32\\cacls.exe" "%SYSTEMROOT%\\system32\\config\\system"

REM --> If error flag set, we do not have admin.
if '%errorlevel%' NEQ '0' (
    echo Requesting administrative privileges...
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\\getadmin.vbs"

    "%temp%\\getadmin.vbs"
    exit /B

:gotAdmin
    if exist "%temp%\\getadmin.vbs" ( del "%temp%\\getadmin.vbs" )
    pushd "%CD%"
    CD /D "%~dp0"
:--------------------------------------

:: Main script starts here
echo.
echo =================================================================
echo  WhatsApp Notifier Server - Installer & Updater
echo =================================================================
echo.

:: Check if this is a first-time setup by looking for the session folder
set FIRST_RUN=0
if NOT exist ".wwebjs_auth" (
    set FIRST_RUN=1
)

echo [+] Checking for PM2...
where pm2 >nul 2>&1
if %errorlevel% neq 0 (
    echo    PM2 not found. Installing it now...
    npm install -g pm2
) else (
    echo    PM2 is already installed.
)

echo.
echo [+] Stopping and removing any old version of the service.
echo [i] Errors here are normal if this is a first-time install.
pm2 stop whatsapp-notifier
pm2 delete whatsapp-notifier
echo    Cleanup complete.

echo.
echo [+] Starting the new version of the server...
:: Assumes the executable is in the same directory and is named based on package.json
pm2 start whatsapp-keyword-notifier.exe --name "whatsapp-notifier"

echo.
echo [+] Setting up the service to run on system startup...
pm2 startup

echo.
echo [+] Saving the service list so it survives reboots...
pm2 save

:: If it's the first run, show the logs so the user can see the QR code
if %FIRST_RUN%==1 (
    echo.
    echo [!] This appears to be a first-time setup.
    echo [!] Displaying logs now. Please scan the QR code with your phone.
    echo [!] Once the client is ready, press CTRL+C to exit the log view.
    echo.
    pm2 logs whatsapp-notifier
)


echo.
echo =================================================================
echo  Setup & Update Complete!
echo =================================================================
echo.
echo The latest version of your server is now running.
echo It will automatically restart if it crashes or if the system reboots.
echo.
echo Useful commands:
echo   - To see server logs: pm2 logs whatsapp-notifier
echo   - To stop the server: pm2 stop whatsapp-notifier
echo.

pause 