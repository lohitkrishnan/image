// Shared image input/output for Image Studio. Everything runs in the browser: files are
// decoded, resized and re-encoded locally and never uploaded.

import { crc32 } from './zip.js';
import { deliverFile } from './mobile.js';

export const FORMATS = {
    jpg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG', lossy: true, alpha: false },
    png: { mime: 'image/png', ext: 'png', label: 'PNG', lossy: false, alpha: true },
    webp: { mime: 'image/webp', ext: 'webp', label: 'WebP', lossy: true, alpha: true },
};

export const ACCEPT = 'image/*,.heic,.heif';

// iPhones and iPads refuse to create canvases above about 16.7 million pixels (a 48 MP photo is
// three times that). Other browsers manage far more; 100 MP keeps memory use reasonable.
export const IS_IOS = typeof navigator !== 'undefined'
    && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const MAX_CANVAS_PIXELS = IS_IOS ? 16_000_000 : 100_000_000;

/** Fires 'reduced' events ({ detail: { name, from, to } }) when a photo is shrunk to fit MAX_CANVAS_PIXELS. */
export const imageNotices = new EventTarget();

export function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function baseName(filename) {
    const name = (filename || 'image').split(/[\\/]/).pop();
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? name.slice(0, dot) : name) || 'image';
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function downloadBlob(data, filename, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    deliverFile(blob, filename);
}

export function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
}

export function releaseCanvas(c) {
    if (c && c.width) {
        c.width = 0;
        c.height = 0;
    }
}

// ---------- Decoding ----------

function looksLikeHeic(file, head) {
    const name = (file.name || '').toLowerCase();
    if (/\.(heic|heif|hif)$/.test(name) || /image\/hei[cf]/.test(file.type || '')) return true;
    if (head && head.length >= 12) {
        const box = String.fromCharCode(...head.subarray(4, 12));
        return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(box);
    }
    return false;
}

function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(el);
    });
}

// libheif (LGPL-3.0, ~1.5 MB of WebAssembly) is only fetched the first time a HEIC/HEIF photo
// can't be decoded natively (Safari decodes HEIC itself; Chrome on Windows/Android does not).
let libheifPromise = null;
function loadLibheif() {
    if (!libheifPromise) {
        libheifPromise = (async () => {
            if (!window.libheif) await loadScriptOnce('./vendor/libheif/libheif.js');
            const res = await fetch('./vendor/libheif/libheif.wasm');
            if (!res.ok) throw new Error('Could not load the HEIC decoder.');
            const wasmBinary = await res.arrayBuffer();
            return await window.libheif({ wasmBinary });
        })().catch((err) => {
            libheifPromise = null;
            throw err;
        });
    }
    return libheifPromise;
}

async function decodeHeic(buffer) {
    const lib = await loadLibheif();
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(new Uint8Array(buffer));
    if (!images || images.length === 0) throw new Error('This HEIC file contains no image.');
    const img = images[0]; // the primary image
    const w = img.get_width();
    const h = img.get_height();
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(w, h);
    await new Promise((resolve, reject) => {
        img.display(imageData, (displayData) => (displayData ? resolve() : reject(new Error('Could not decode this HEIC photo.'))));
    });
    ctx.putImageData(imageData, 0, 0);
    for (const i of images) {
        try { i.free?.(); } catch { /* ignore */ }
    }
    return canvas;
}

async function decodeWithImgElement(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        const c = createCanvas(img.naturalWidth, img.naturalHeight);
        c.getContext('2d').drawImage(img, 0, 0);
        return c;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Decode a File/Blob into a drawable source, honouring EXIF orientation.
 * Returns { source, width, height, via }. `source` is an ImageBitmap or canvas.
 */
async function decodeImageRaw(file) {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const heic = looksLikeHeic(file, head);
    try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bmp, width: bmp.width, height: bmp.height, via: 'native' };
    } catch {
        // fall through
    }
    if (heic) {
        const canvas = await decodeHeic(await file.arrayBuffer());
        return { source: canvas, width: canvas.width, height: canvas.height, via: 'libheif' };
    }
    try {
        const canvas = await decodeWithImgElement(file);
        return { source: canvas, width: canvas.width, height: canvas.height, via: 'img' };
    } catch {
        throw new Error(`"${file.name || 'This file'}" isn't an image this browser can open.`);
    }
}

export async function decodeImage(file) {
    const dec = await decodeImageRaw(file);
    if (dec.width * dec.height <= MAX_CANVAS_PIXELS) return dec;
    // Too big for this device's canvases: work on a reduced copy and say so.
    const k = Math.sqrt(MAX_CANVAS_PIXELS / (dec.width * dec.height)) * 0.98;
    const w = Math.floor(dec.width * k), h = Math.floor(dec.height * k);
    const reduced = drawScaled(dec.source, w, h);
    releaseSource(dec.source);
    imageNotices.dispatchEvent(new CustomEvent('reduced', { detail: { name: file.name || 'image', from: [dec.width, dec.height], to: [w, h] } }));
    return { source: reduced, width: w, height: h, via: dec.via, reducedFrom: [dec.width, dec.height] };
}

export function releaseSource(src) {
    if (!src) return;
    if (typeof src.close === 'function') src.close();
    else releaseCanvas(src);
}

// ---------- Resizing ----------

/**
 * Draw `source` (or a sub-rectangle of it) into a new w×h canvas with good downscaling quality.
 * Large reductions are done in halving steps, which avoids the aliasing of a single big jump.
 */
export function drawScaled(source, w, h, { sx = 0, sy = 0, sw, sh, background = null } = {}) {
    sw = sw ?? source.width;
    sh = sh ?? source.height;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));

    let cur = source;
    let cx = sx, cy = sy, cw = sw, ch = sh;
    const temps = [];
    while (cw / 2 >= w * 1.05 && ch / 2 >= h * 1.05) {
        const nw = Math.max(w, Math.round(cw / 2));
        const nh = Math.max(h, Math.round(ch / 2));
        const t = createCanvas(nw, nh);
        const tctx = t.getContext('2d');
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
        temps.push(t);
        cur = t;
        cx = 0; cy = 0; cw = nw; ch = nh;
    }

    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, w, h);
    temps.forEach(releaseCanvas);
    return out;
}

/** Composite onto an opaque background (JPEG has no transparency). */
export function flatten(canvas, color = '#ffffff') {
    const out = createCanvas(canvas.width, canvas.height);
    const ctx = out.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return out;
}

// ---------- Encoding ----------

function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode this image.'))), mime, quality);
    });
}

// Record the DPI so print/layout apps use the intended physical size.
export function setJpegDpi(bytes, dpi) {
    // JFIF APP0: FF D8 FF E0 len(2) "JFIF\0" version(2) units(1) Xdensity(2) Ydensity(2)
    if (bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[6] === 0x4a && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
        bytes[13] = 1;
        bytes[14] = (dpi >> 8) & 0xff;
        bytes[15] = dpi & 0xff;
        bytes[16] = (dpi >> 8) & 0xff;
        bytes[17] = dpi & 0xff;
    }
    return bytes;
}

export function setPngDpi(bytes, dpi) {
    // Insert a pHYs chunk (pixels per metre) right after IHDR (8-byte signature + 25-byte IHDR).
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
    view.setUint32(8, ppm);
    view.setUint32(12, ppm);
    chunk[16] = 1; // unit: metre
    view.setUint32(17, crc32(chunk.subarray(4, 17)));
    const out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, 33), 0);
    out.set(chunk, 33);
    out.set(bytes.subarray(33), 33 + chunk.length);
    return out;
}

export function supportsWebpEncoding() {
    const c = createCanvas(1, 1);
    return c.toDataURL('image/webp').startsWith('data:image/webp');
}

/** Encode a canvas. Returns Uint8Array. JPEG input should already be flattened. */
export async function encodeCanvas(canvas, { format = 'jpg', quality = 0.9, dpi = null } = {}) {
    const f = FORMATS[format] || FORMATS.jpg;
    const blob = await canvasToBlob(canvas, f.mime, f.lossy ? quality : undefined);
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (dpi) {
        if (format === 'jpg') bytes = setJpegDpi(bytes, Math.round(dpi));
        else if (format === 'png') bytes = setPngDpi(bytes, Math.round(dpi));
    }
    return bytes;
}

/**
 * Encode as close to a file-size window as possible, keeping as much quality as it can.
 * - Lossy formats: binary-search the quality; if even the lowest useful quality is too big
 *   and downscaling is allowed, shrink the pixel size and search again.
 * - PNG is lossless, so the only lever is pixel size.
 * Returns { bytes, width, height, quality, note, ok }.
 */
export async function encodeToTarget(canvas, { format = 'jpg', maxBytes = null, minBytes = null, quality = 0.9, allowDownscale = true, dpi = null } = {}) {
    const f = FORMATS[format] || FORMATS.jpg;
    let work = canvas;
    let scaled = false;
    const notes = [];

    const done = (bytes, q, ok = true) => {
        // A small JPEG can't always reach a form's minimum file size, even at top quality. Forms
        // only check the size, so add an invisible comment section; the picture is unchanged.
        if (format === 'jpg' && minBytes && bytes.length < minBytes && (!maxBytes || minBytes < maxBytes)) {
            const target = maxBytes ? Math.min(maxBytes, minBytes + 512) : minBytes + 512;
            const added = target - bytes.length;
            bytes = padJpeg(bytes, target);
            notes.length = 0;
            notes.push(`Padded with ${formatBytes(added)} of blank file data to reach the ${formatBytes(minBytes)} minimum. The picture itself is unchanged.`);
            ok = true;
        }
        const result = { bytes, width: work.width, height: work.height, quality: q, note: notes.join(' '), ok, scaled };
        if (work !== canvas) releaseCanvas(work);
        return result;
    };

    if (!maxBytes && !minBytes) {
        return done(await encodeCanvas(work, { format, quality, dpi }), quality);
    }

    for (let attempt = 0; attempt < 8; attempt++) {
        if (!f.lossy) {
            const bytes = await encodeCanvas(work, { format, dpi });
            if (!maxBytes || bytes.length <= maxBytes) {
                if (minBytes && bytes.length < minBytes) notes.push(`PNG is lossless, so it can't be made bigger than ${formatBytes(bytes.length)} at this size.`);
                return done(bytes, null, !minBytes || bytes.length >= minBytes);
            }
            if (!allowDownscale) {
                notes.push(`A PNG this size can't get under ${formatBytes(maxBytes)} without resizing. Try JPG or WebP.`);
                return done(bytes, null, false);
            }
            const factor = Math.max(0.3, Math.sqrt(maxBytes / bytes.length) * 0.95);
            const next = drawScaled(work, work.width * factor, work.height * factor);
            if (work !== canvas) releaseCanvas(work);
            work = next;
            scaled = true;
            continue;
        }

        // Lossy: find the highest quality whose size is within the limit.
        const ceiling = Math.min(0.95, Math.max(0.5, quality));
        const top = await encodeCanvas(work, { format, quality: ceiling, dpi });
        if (!maxBytes || top.length <= maxBytes) {
            if (minBytes && top.length < minBytes) {
                // Try the very top of the quality range before giving up on the minimum.
                const max = await encodeCanvas(work, { format, quality: 1, dpi });
                if (!maxBytes || max.length <= maxBytes) {
                    if (max.length < minBytes) {
                        notes.push(`At ${work.width} × ${work.height} px even the best quality is only ${formatBytes(max.length)}, under the ${formatBytes(minBytes)} minimum. Plain or very simple images stay small; a normal camera photo is usually big enough.`);
                        return done(max, 1, false);
                    }
                    return done(max, 1);
                }
            }
            return done(top, ceiling);
        }

        let lo = 0.08, hi = ceiling;
        let best = null, bestQ = null;
        for (let i = 0; i < 7; i++) {
            const mid = (lo + hi) / 2;
            const b = await encodeCanvas(work, { format, quality: mid, dpi });
            if (b.length <= maxBytes) {
                best = b; bestQ = mid; lo = mid;
            } else {
                hi = mid;
            }
        }
        if (!best) {
            const floor = await encodeCanvas(work, { format, quality: 0.08, dpi });
            if (floor.length <= maxBytes) {
                best = floor; bestQ = 0.08;
            } else {
                if (!allowDownscale) {
                    notes.push(`Couldn't get under ${formatBytes(maxBytes)} at ${work.width}×${work.height} px without resizing.`);
                    return done(floor, 0.08, false);
                }
                const factor = Math.max(0.3, Math.sqrt(maxBytes / floor.length) * 0.92);
                const next = drawScaled(work, work.width * factor, work.height * factor);
                if (work !== canvas) releaseCanvas(work);
                work = next;
                scaled = true;
                continue;
            }
        }
        if (bestQ < 0.45 && allowDownscale && attempt < 7) {
            // Very low quality looks blocky; a smaller image at decent quality looks better.
            // Estimate the size that fits at quality 0.6 and try again from there.
            const at60 = await encodeCanvas(work, { format, quality: 0.6, dpi });
            const factor = Math.max(0.3, Math.min(0.92, Math.sqrt(maxBytes / at60.length) * 0.95));
            const next = drawScaled(work, work.width * factor, work.height * factor);
            if (work !== canvas) releaseCanvas(work);
            work = next;
            scaled = true;
            continue;
        }
        if (minBytes && best.length < minBytes) {
            notes.push(`Couldn't land between ${formatBytes(minBytes)} and ${formatBytes(maxBytes)}; result is ${formatBytes(best.length)}.`);
            return done(best, bestQ, false);
        }
        return done(best, bestQ);
    }
    notes.push('Gave up after several attempts.');
    const last = await encodeCanvas(work, { format, quality: 0.5, dpi });
    return done(last, 0.5, false);
}

/**
 * Grow a JPEG to exactly `targetLength` bytes by inserting comment (COM) segments before the
 * end-of-image marker. Decoders ignore comments, so the image is unchanged.
 */
export function padJpeg(bytes, targetLength) {
    const end = bytes.length - 2;
    if (bytes[end] !== 0xff || bytes[end + 1] !== 0xd9 || targetLength <= bytes.length) return bytes;
    const out = new Uint8Array(targetLength);
    out.set(bytes.subarray(0, end), 0);
    let pos = end;
    let need = targetLength - bytes.length;
    while (need > 0) {
        // Each segment: FF FE + 2-byte length (which counts itself) + payload; at least 4 bytes.
        let seg = Math.min(need, 65535 + 2);
        if (need - seg > 0 && need - seg < 4) seg -= 4; // leave room for a final valid segment
        seg = Math.max(seg, 4);
        const len = seg - 2;
        out[pos] = 0xff;
        out[pos + 1] = 0xfe;
        out[pos + 2] = (len >> 8) & 0xff;
        out[pos + 3] = len & 0xff;
        out.fill(0x20, pos + 4, pos + seg); // spaces
        pos += seg;
        need -= seg;
    }
    out[pos] = 0xff;
    out[pos + 1] = 0xd9;
    return out;
}

// ---------- File intake helpers ----------

export function filesFromDataTransfer(dt) {
    const out = [];
    if (dt?.files) {
        for (const f of dt.files) out.push(f);
    }
    return out.filter((f) => /^image\//.test(f.type) || /\.(heic|heif|hif|jpe?g|png|webp|gif|bmp|avif|tiff?)$/i.test(f.name));
}

export function wireDropzone(zone, input, onFiles) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.click();
        }
    });
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('is-dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('is-dragover');
        const files = filesFromDataTransfer(e.dataTransfer);
        if (files.length) onFiles(files);
    });
    input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length) onFiles(files);
    });
}
