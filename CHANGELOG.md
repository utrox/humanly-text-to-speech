# Changelog

## 1.4.0

- Renamed to Humanly Text to Speech ("Humanly TTS" for short), with a new add-on ID
  (`humanly-tts@utrox.github.io`). Firefox treats it as a new add-on, so settings start fresh. The
  helper is now registered as `humanly_tts` and installs to `%LOCALAPPDATA%\HumanlyTTS`; helpers
  installed by earlier versions can be removed with their own `uninstall.bat`.
- Declares in the manifest that no user data is collected.

## 1.3.0

- Added the voice helper for Windows: the natural voice runs outside Firefox on all processor cores
  (or the graphics card through DirectML when it works), about 1 second per sentence.
- Added the Windows voice as an instant engine, used automatically when the helper isn't installed.
- Added a "Voice engine" choice in the player and the helper status on the options page.
- If the helper stops, reading continues with the Windows voice.

## 1.2.0

- Detects static from the graphics card (Firefox WebGPU) and switches to the processor automatically.

## 1.1.0

- PDFs with scrambled text (letters stored as placeholder characters) are repaired, including
  ligatures such as "fi".
- Headings in PDFs are read as separate sentences; repeated headers and footers are skipped.
- The in-Firefox voice runs several workers in parallel and splits long sentences at commas.

## 1.0.0

- First version: read-aloud for web pages and PDFs with sentence highlighting, click-to-jump, a
  floating player, main-text detection and a built-in PDF viewer.
