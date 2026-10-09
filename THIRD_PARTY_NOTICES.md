# Third-party notices

Only components that ship with or are fetched by the engine's own runtime are listed.

## Kokoro TTS narration worker (optional)
| Component | Version | License | Source |
|---|---|---|---|
| kokoro-js | 1.2.1 | Apache-2.0 | https://github.com/hexgrad/kokoro (npm: kokoro-js) |
| @huggingface/transformers (dep of kokoro-js) | 3.8.1 | Apache-2.0 | npm |
| phonemizer (dep of kokoro-js) | 1.2.1 | Apache-2.0 | npm |
| onnxruntime-node (dep of transformers.js) | see package-lock.json | MIT | npm |
| Kokoro-82M ONNX model weights | onnx-community/Kokoro-82M-v1.0-ONNX | Apache-2.0 per the kokoro-js README ("Apache-licensed weights"); not independently re-verified from the model card | Hugging Face |

Used via `src/media/kokoroWorker.js`, a child process called by `src/media/narration.js`. Licenses for the npm packages were read from their installed `package.json` files.

**Model download (first use only):** the q8 ONNX model and tokenizer files are fetched from `huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX` into the Hugging Face transformers.js cache (default: inside `node_modules/@huggingface/transformers/.cache` on Node). Nothing else is downloaded.

## espeak-ng (fallback narration)
Invoked as an external CLI (GPL-3.0-or-later); not bundled or linked into this repository.

## Thumbnail canvas worker (primary thumbnail renderer; FFmpeg is the fallback)
| Component | Version | License | Source |
|---|---|---|---|
| @napi-rs/canvas | 1.0.10 (exact pin) | MIT (npm metadata and repo LICENSE file) | https://github.com/Brooooooklyn/canvas (npm: @napi-rs/canvas) |
| @napi-rs/canvas-<platform> prebuilt binaries | 1.0.10 | MIT (npm metadata) | npm; bundle Google Skia (BSD-3-Clause per skia.org; not independently re-verified from the binaries) |
| DejaVu Sans Bold (bundled font) | see assets/fonts/LICENSE-DejaVu.txt | DejaVu/Bitstream Vera license | already bundled |

Used via `src/media/thumbnailCanvasWorker.js`, a child process called by `src/media/thumbnail.js`. No network access, no image loading, no system fonts. Set `THUMBNAIL_RENDERER=ffmpeg` to bypass it.
