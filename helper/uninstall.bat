@echo off
rem Removes the Humanly TTS helper and its voice model.
reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\humanly_tts" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\HumanlyTTS"
echo The Humanly TTS helper was removed.
pause
