@echo off
cd /d "%~dp0"
echo First close the application window, then press a key to stop its local database.
pause
"%~dp0runtime\pgsql\bin\pg_ctl.exe" -D "%~dp0.local\postgres-data" -m fast -w stop
pause
