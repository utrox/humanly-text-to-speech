Humanly TTS helper
==================

Runs the natural Kokoro voice outside Firefox, where it can use all of your
processor cores or your graphics card. About 1 second per line instead of 30.

Install
-------
1. Unzip this folder anywhere.
2. Double-click install.bat.
   - Needs Python 3.10 or newer. If it's missing, the installer offers to install it.
   - Downloads the voice model (about 350 MB) and checks it.
   - Nothing needs admin rights. Everything goes into
     %LOCALAPPDATA%\HumanlyTTS
   - At the end you should hear a test sentence.
3. Restart Firefox. In the reader's menu (the ... button) the status line
   should say "Natural voice from the helper app".

Remove
------
Double-click uninstall.bat.

Troubleshooting
---------------
- Run this in a terminal to see what the helper does on its own:
  "%LOCALAPPDATA%\HumanlyTTS\venv\Scripts\python.exe" "%LOCALAPPDATA%\HumanlyTTS\humanly_tts_host.py" --selftest
- Force the processor instead of the graphics card: set the environment
  variable HUMANLY_TTS_CPU=1 and restart Firefox.
- Helper messages appear in Firefox's Browser Console (Ctrl+Shift+J).
