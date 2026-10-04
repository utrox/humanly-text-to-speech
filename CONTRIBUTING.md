# Contributing

Thanks for helping. This file covers building, testing, how the code fits together, and releasing.

## Setup

You need [Node.js](https://nodejs.org/) 20 or newer. For the browser tests you also need Python 3 with
Playwright; for the helper, Python 3.10+.

```sh
npm install
npm run build        # bundles everything into dist/
npm test             # unit tests
```

## Trying your build

- **Quick test:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and
  pick `dist/manifest.json`. It stays until Firefox restarts. `npm start` does the same in a fresh
  Firefox profile via web-ext.
- **Permanent install:** Firefox only installs signed add-ons. Sign your build as an unlisted
  ("self-distributed") add-on on addons.mozilla.org, see [Releasing](#releasing). Firefox Developer
  Edition, Nightly and ESR can also install unsigned add-ons after setting
  `xpinstall.signatures.required` to `false` in `about:config`.

## Tests

| Command | What it checks |
| --- | --- |
| `npm test` | Sentence splitting, PDF text repair, the speech/static detector, the voice engine queue and engine selection (Node, no browser needed) |
| `npm run test:browser` | The built add-on in Chromium with the Firefox APIs mocked: main-text detection, click-to-jump, highlighting, the player, the PDF viewer. Needs `pip install playwright` and `python -m playwright install chromium`. Add `--screenshots` to refresh `docs/screenshots/`. |
| `npm run test:helper` | The helper's native-messaging protocol with the real voice. Needs `pip install kokoro-onnx` and the model files from the [kokoro-onnx release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1) (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) placed in `helper/`. |
| `npm run lint` | Mozilla's add-on linter on `dist/`. Warnings about `innerHTML` (the player's fixed template) and code inside bundled libraries are expected. |

The voice itself can only be checked by listening, in Firefox.

## How it works

```
src/
  content.js      Injected into a page on demand; creates the reader.
  reader.js       Reader controller and floating player (shared by pages and the PDF viewer).
  segment.js      Finds the main text, splits it into sentences (Intl.Segmenter plus abbreviation
                  fixes) and wraps each sentence in <nr-s> elements; unwrapping restores the page.
  background.js   Picks the voice engine, keeps a synthesis queue (current sentence first, the next
                  three prepared ahead), caches audio, plays it, opens PDFs in the viewer.
  tts-worker.js   Kokoro inside Firefox (kokoro-js / Transformers.js / ONNX Runtime WebAssembly).
  audio-check.js  Tells speech from static; used to reject broken graphics-card output.
  viewer.js       PDF viewer built on pdf.js; feeds each page's text layer to the reader.
  pua-fix.js      Repairs PDF text whose fonts map letters to private-use placeholder characters.
  settings.js     Defaults and the voice list.
helper/
  humanly_tts_host.py   Native-messaging host: Kokoro via kokoro-onnx + ONNX Runtime
                           (DirectML or CUDA when available, otherwise all CPU cores).
  install.ps1 / .bat       Per-user Windows installer: Python env, model download with SHA-256
                           check, Firefox registration (HKCU\Software\Mozilla\NativeMessagingHosts).
static/           manifest.json, pages, icons.
tools/            Word list for pua-fix.js, release packaging.
```

**Voice engines.** `background.js` treats the helper and the in-Firefox workers the same way: each
receives `synth` jobs and returns audio. The helper is reached with `browser.runtime.connectNative`
and sends 16-bit PCM in base64 parts below Firefox's 1 MB message limit. If the helper stops, reading
continues with the Windows voice (`speechSynthesis`).

**Why a helper?** Firefox extension pages can't be cross-origin isolated
([bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)), so WebAssembly can't use
threads. Measured with the real model, single-threaded WebAssembly is about 5× slower than native
single-threaded code, roughly 2 seconds of computing per second of speech. Firefox's WebGPU (Windows,
Firefox 141+) can run the model but has produced static on real hardware.

**Changing the add-on ID.** The ID in `static/manifest.json` (`browser_specific_settings.gecko.id`)
must match `$ExtId` in `helper/install.ps1`, or Firefox won't let the add-on talk to the helper. Change
both together. Forks that publish their own signed build need their own ID.

## Code style

Plain modern JavaScript (ES modules, no framework), bundled with esbuild. Two-space indentation,
single quotes, semicolons. Keep comments for things the code can't say. User-facing text uses
sentence case, says what happened and what to do, and avoids jargon.

## Releasing

1. Update the version in `static/manifest.json` and `package.json`, and add a section to
   `CHANGELOG.md`.
2. Commit, tag (`git tag v1.4.0`) and push the tag. The **Release** workflow tests, builds and
   attaches `humanly-tts-<version>.xpi` and `humanly-tts-helper.zip` to a GitHub release.
3. Sign the add-on so people can install it:
   - Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
   - Add them to the repository as the secrets `AMO_API_KEY` and `AMO_API_SECRET`. The workflow then
     signs the build as an unlisted add-on and attaches the signed `.xpi` instead.
   - Or sign by hand: `npx web-ext sign --channel unlisted --source-dir dist --api-key … --api-secret …`
   - Because the add-on ships bundled code, Mozilla may ask for the source. Upload a zip of this
     repository; the build steps above reproduce `dist/` exactly.

To build release files locally: `npm run package` (writes to `out/`).
