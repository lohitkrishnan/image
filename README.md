# Image Studio

Resize, compress and convert images, make passport and visa photos, and edit or annotate
pictures, entirely in your browser. Photos are never uploaded: everything runs on your device.

Live at **https://lohitkrishnan.com/image/**

## Workspaces

1. **Resize, Compress & Convert**: batch resize (longest side, exact size with crop or borders,
   percentage, or print size at a DPI), convert to JPG, PNG or WebP, and hit a file-size window
   (for example 20–50 KB for exam forms). Presets cover common Indian form requirements. Opens
   iPhone HEIC photos. Saved files don't carry the original's location or camera details.
2. **Passport & ID Photo**: line the head up against guides for India passport and visa, OCI, US,
   UK and Schengen photos (or custom sizes), then save the upload file at the required pixel size
   and file size, or a 4 × 6 in / A4 print sheet at 300 DPI. It only crops and resizes.
3. **Edit & Annotate**: crop with aspect presets, rotate, flip, straighten, adjust brightness,
   contrast and saturation, and add text, arrows, boxes, highlights and blur/pixelate areas.
   Undo and redo, copy to clipboard, download as JPG, PNG or WebP.

## How it works

Plain HTML, CSS and ES modules with no build step and no server code. Images are decoded with the
browser's own decoders (HEIC falls back to a WebAssembly decoder that is only fetched when
needed), processed on `<canvas>`, and saved with `canvas.toBlob`.

## Third-party code

| Component | Licence | Use |
| --- | --- | --- |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.23.5 (`vendor/libheif/`) | LGPL-3.0 (see `vendor/libheif/LICENSE`) | Decoding HEIC/HEIF photos when the browser can't |
| [Lora](https://github.com/cyrealtype/Lora-Cyrillic) (`fonts/`) | SIL Open Font License 1.1 | Headings |

All third-party files are served from this site; the page makes no requests to other servers
except the privacy-friendly GoatCounter page-view counter shared with lohitkrishnan.com, which
never receives images.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```
