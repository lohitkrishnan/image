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
3. **Edit & Annotate**: crop with aspect presets, rotate, flip, straighten, cut out a strip and
   join the rest, add borders or pad to square, adjust brightness, contrast, saturation and
   warmth, apply colour filters, and add text, arrows, boxes, highlights and blur/pixelate areas.
   Undo and redo, copy to clipboard, download as JPG, PNG or WebP.
4. **Images to PDF**: one PDF from many images (A4, Letter, Legal, A5 or each image's own shape),
   1–9 images per page, margins, and a quality setting that sizes images for print or email.
   Or one PDF per image in a .zip.
5. **Merge**: stitch images side by side, stacked or in a grid, with gaps, borders and a
   background colour.
6. **GIF**: make an animated slideshow (newsletter and chat sizes, crossfades, loop settings,
   live preview) or open a GIF to play it, step through frames and save frames.

Resize & Convert also makes circular avatars in bulk.

## How it works

Plain HTML, CSS and ES modules with no build step and no server code. Images are decoded with the
browser's own decoders (HEIC falls back to a WebAssembly decoder that is only fetched when
needed), processed on `<canvas>`, and saved with `canvas.toBlob`.

## Third-party code

| Component | Licence | Use |
| --- | --- | --- |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.23.5 (`vendor/libheif/`) | LGPL-3.0 (see `vendor/libheif/LICENSE`) | Decoding HEIC/HEIF photos when the browser can't |
| [jsPDF](https://github.com/parallax/jsPDF) 2.5.2 (`vendor/jspdf.umd.min.js`) | MIT | Images to PDF (loaded only when making a PDF) |
| [gifenc](https://github.com/mattdesl/gifenc) 1.0.3 (`vendor/gifenc/`) | MIT (see `vendor/gifenc/LICENSE.md`) | Encoding GIFs |
| [omggif](https://github.com/deanm/omggif) 1.0.10 (`vendor/omggif/`) | MIT (in the file header) | Decoding GIFs in the player |
| [Lora](https://github.com/cyrealtype/Lora-Cyrillic) (`fonts/`) | SIL Open Font License 1.1 | Headings |

All third-party files are served from this site; the page makes no requests to other servers
except the privacy-friendly GoatCounter page-view counter shared with lohitkrishnan.com, which
never receives images.

## Phones, offline use and installing

- On touch screens, finished files open a small sheet with **Share** (WhatsApp, Gmail, Files…)
  and **Save to device**; the main button of each tool stays pinned to the bottom of narrow
  screens; **Take photo** buttons open the camera. Desktop mouse users see none of this.
- iPhones and iPads can't create canvases above about 16 MP, so larger photos are reduced to
  fit there, with a message.
- `sw.js` caches the app (about 2.4 MB) on the first visit, so after that it opens and every
  tool works with no connection. `manifest.webmanifest` lets browsers offer **Install** or
  **Add to Home Screen**. Only the app's own files are cached; photos are never stored.

**Before every commit that changes a file the app loads**, regenerate the cache list and version:

```sh
python3 tools/update-sw.py
```

Otherwise visitors keep the previous version. When a new version is published, open copies of
the page offer a Reload button rather than refreshing under someone's work.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```
