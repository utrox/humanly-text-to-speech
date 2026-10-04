# Third-party notices

Humanly Text to Speech is licensed under GPL-3.0-or-later (see [LICENSE](LICENSE)). It builds on the following
open-source work.

## Included in the add-on (.xpi)

| Component | License | Notes |
| --- | --- | --- |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) voice styles | Apache-2.0 | The English voice files in `voices/`. Model by hexgrad. |
| [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) | Apache-2.0 | Runs Kokoro in the browser. |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | Model loading and tokenization. |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | Runs the model (WebAssembly, WebGPU). |
| [phonemizer.js](https://github.com/xenova/phonemizer.js) | Apache-2.0 | Text to phonemes. Contains eSpeak NG compiled to WebAssembly. |
| [eSpeak NG](https://github.com/espeak-ng/espeak-ng) | GPL-3.0-or-later | Pronunciation rules and dictionaries, inside phonemizer.js. |
| [PDF.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF rendering and text extraction. |
| [SCOWL word lists](http://wordlist.aspell.net/) via [wordlist-english](https://github.com/jacksonrayhamilton/wordlist-english) | SCOWL license (permissive, keep copyright notice) | `words.txt`, used to repair scrambled PDF text. Copyright 2000–2016 Kevin Atkinson and contributors. |

## Downloaded at runtime

| Component | License | Source |
| --- | --- | --- |
| Kokoro-82M ONNX model (in-Firefox voice) | Apache-2.0 | [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |

## Installed by the helper (on the user's computer, not redistributed)

| Component | License |
| --- | --- |
| Kokoro-82M ONNX model and voices from [kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases) | Apache-2.0 |
| [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (DirectML build) | MIT |
| [phonemizer](https://github.com/bootphon/phonemizer) (Python) | GPL-3.0 |
| [espeakng-loader](https://github.com/thewh1teagle/espeakng-loader), bundling eSpeak NG | MIT / GPL-3.0-or-later |
| [NumPy](https://numpy.org/) | BSD-3-Clause |

## Development only

esbuild (MIT), jsdom (MIT), web-ext (MPL-2.0), fflate (MIT), Playwright (Apache-2.0).
