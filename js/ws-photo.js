// Workspace 2: passport, visa and ID photos.
//
// The photo is positioned under a fixed frame measured in millimetres. Guides show where the
// top of the head, the chin and (where specified) the eyes must fall, so the head ends up the
// size the authority asks for. Output is a digital file at the spec's pixel size and file-size
// window, and/or a print sheet at 300 DPI. Nothing is retouched.

import {
    escapeHtml, formatBytes, downloadBlob, createCanvas, releaseCanvas, decodeImage, releaseSource,
    drawScaled, encodeCanvas, encodeToTarget, wireDropzone,
} from './image-io.js';
import { PHOTO_SPECS, PRINT_SHEETS, layoutSheet } from './photo-specs.js';
import { makePortraitSample } from './samples.js';

const PRINT_DPI = 300;
const ZOOM_MIN = -1; // log2 of the zoom relative to "cover"
const ZOOM_MAX = 3;

export function initPhotoWorkspace({ root, toast }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const stage = $('ph-stage');
    const canvas = $('ph-canvas');
    const ctx = canvas.getContext('2d');
    const zoomRange = $('ph-zoom');
    const rotRange = $('ph-rotate');
    const specSel = $('ph-spec');
    const sheetSel = $('ph-sheet');
    const bgCheck = $('ph-bg-check');

    for (const s of PHOTO_SPECS) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.label;
        specSel.appendChild(o);
    }
    for (const s of PRINT_SHEETS) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.label;
        sheetSel.appendChild(o);
    }

    // Image placement in frame millimetres: centre (cx, cy), mm per source pixel, rotation.
    let img = null; // { source, width, height, name }
    let place = { cx: 0, cy: 0, mmPerPx: 1, rot: 0 };
    let coverMmPerPx = 1;
    let view = { ppm: 1, fx: 0, fy: 0, cssW: 0, cssH: 0 }; // display px per mm and frame origin
    let bgTimer = null;
    let busy = false;

    // ---------- Spec ----------

    function currentSpec() {
        const base = PHOTO_SPECS.find((s) => s.id === specSel.value) || PHOTO_SPECS[0];
        if (!base.custom) return base;
        const n = (id, d) => {
            const v = parseFloat($(id).value);
            return Number.isFinite(v) && v > 0 ? v : d;
        };
        const widthMm = n('ph-c-w', 35), heightMm = n('ph-c-h', 45);
        let headMinMm = n('ph-c-hmin', 30), headMaxMm = n('ph-c-hmax', 36);
        if (headMinMm > headMaxMm) [headMinMm, headMaxMm] = [headMaxMm, headMinMm];
        headMaxMm = Math.min(headMaxMm, heightMm * 0.95);
        headMinMm = Math.min(headMinMm, headMaxMm);
        const crownMm = Math.max(1, Math.min(heightMm * 0.12, heightMm - headMaxMm - 1));
        const minKB = n('ph-c-min', null), maxKB = n('ph-c-max', null);
        return {
            ...base,
            widthMm, heightMm, headMinMm, headMaxMm, crownMm,
            digital: { width: Math.round(n('ph-c-pw', 413)), height: Math.round(n('ph-c-ph', 531)), minKB, maxKB },
        };
    }

    function renderSpecInfo() {
        const s = currentSpec();
        $('ph-custom').hidden = !s.custom;
        const head = `head ${s.headMinMm}–${s.headMaxMm} mm (chin to top of head)`;
        const parts = [
            `<div><strong>${s.widthMm} × ${s.heightMm} mm</strong> · ${head}</div>`,
            s.background ? `<div>Background: ${escapeHtml(s.background)}</div>` : '',
            s.notes ? `<p class="field-note">${escapeHtml(s.notes)}</p>` : '',
            s.source ? `<a class="spec-link" href="${escapeHtml(s.source)}" target="_blank" rel="noopener noreferrer">Official rules ↗</a>` : '',
        ];
        $('ph-spec-info').innerHTML = parts.join('');
        $('ph-legend-eyes').hidden = !s.eyeFromBottomMm;

        const d = s.digital;
        if (d) {
            const kb = d.minKB && d.maxKB ? `${d.minKB}–${d.maxKB} KB` : d.maxKB ? `under ${d.maxKB} KB` : d.minKB ? `at least ${d.minKB} KB` : 'best quality';
            $('ph-digital-desc').textContent = `JPEG, ${d.width} × ${d.height} px, ${kb}.`;
        } else {
            const w = Math.round(s.widthMm / 25.4 * 600), h = Math.round(s.heightMm / 25.4 * 600);
            $('ph-digital-desc').textContent = `This service doesn't take a pre-cropped upload (see the rules above). This saves the framed photo as a ${w} × ${h} px JPEG (600 DPI) for your records or a photo shop.`;
        }
        renderSheetInfo();
        fitView();
        draw();
        scheduleBgCheck();
    }

    function renderSheetInfo() {
        const s = currentSpec();
        const sheet = PRINT_SHEETS.find((x) => x.id === sheetSel.value) || PRINT_SHEETS[0];
        const lay = layoutSheet(sheet, s.widthMm, s.heightMm);
        $('ph-sheet-desc').textContent = lay.count
            ? `${lay.count} photos (${lay.cols} × ${lay.rows}) at ${PRINT_DPI} DPI. Print at 100% / actual size, not "fit to page".`
            : 'The photo is too big for this paper.';
        $('ph-download-sheet').disabled = !img || !lay.count;
    }

    specSel.addEventListener('change', () => { resetPlacement(); renderSpecInfo(); });
    sheetSel.addEventListener('change', renderSheetInfo);
    for (const id of ['ph-c-w', 'ph-c-h', 'ph-c-hmin', 'ph-c-hmax', 'ph-c-pw', 'ph-c-ph', 'ph-c-min', 'ph-c-max']) {
        $(id).addEventListener('input', renderSpecInfo);
    }

    // ---------- Geometry ----------

    function fitView() {
        const rect = stage.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        const s = currentSpec();
        const pad = 0.12;
        const ppm = Math.min(rect.width * (1 - 2 * pad) / s.widthMm, rect.height * (1 - 2 * pad) / s.heightMm);
        view = { ppm, fx: (rect.width - s.widthMm * ppm) / 2, fy: (rect.height - s.heightMm * ppm) / 2, cssW: rect.width, cssH: rect.height, dpr };
        return true;
    }

    function computeCover() {
        const s = currentSpec();
        const rot = Math.abs(place.rot * Math.PI / 180);
        // Cover the frame even when rotated: use the rotated frame's bounding box.
        const bw = s.widthMm * Math.cos(rot) + s.heightMm * Math.sin(rot);
        const bh = s.widthMm * Math.sin(rot) + s.heightMm * Math.cos(rot);
        coverMmPerPx = Math.max(bw / img.width, bh / img.height);
    }

    function zoomLog() {
        return Math.log2(place.mmPerPx / coverMmPerPx);
    }

    function syncZoomRange() {
        const t = (zoomLog() - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
        zoomRange.value = String(Math.round(Math.max(0, Math.min(1, t)) * 1000));
    }

    function resetPlacement() {
        if (!img) return;
        const s = currentSpec();
        place.rot = 0;
        rotRange.value = '0';
        $('ph-rotate-val').textContent = '0°';
        computeCover();
        place.mmPerPx = coverMmPerPx;
        place.cx = s.widthMm / 2;
        place.cy = s.heightMm / 2;
        syncZoomRange();
    }

    /** Set zoom, keeping the image point under (mx, my) (frame mm) fixed. */
    function zoomTo(mmPerPx, mx, my) {
        const minS = coverMmPerPx * 2 ** ZOOM_MIN, maxS = coverMmPerPx * 2 ** ZOOM_MAX;
        const next = Math.max(minS, Math.min(maxS, mmPerPx));
        const k = next / place.mmPerPx;
        place.cx = mx + (place.cx - mx) * k;
        place.cy = my + (place.cy - my) * k;
        place.mmPerPx = next;
        syncZoomRange();
        draw();
        scheduleBgCheck();
    }

    function screenToMm(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        return { x: (clientX - r.left - view.fx) / view.ppm, y: (clientY - r.top - view.fy) / view.ppm };
    }

    /** True when the whole frame is covered by the photo. */
    function frameCovered() {
        if (!img) return false;
        const s = currentSpec();
        const a = -place.rot * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const hw = img.width / 2 + 0.5, hh = img.height / 2 + 0.5;
        for (const [x, y] of [[0, 0], [s.widthMm, 0], [0, s.heightMm], [s.widthMm, s.heightMm]]) {
            const dx = (x - place.cx) / place.mmPerPx, dy = (y - place.cy) / place.mmPerPx;
            const ix = dx * cos - dy * sin, iy = dx * sin + dy * cos;
            if (Math.abs(ix) > hw || Math.abs(iy) > hh) return false;
        }
        return true;
    }

    // ---------- Drawing ----------

    function drawPhoto(c, ppmX, ppmY, ox, oy, source, srcScale = 1) {
        c.save();
        c.translate(ox + place.cx * ppmX, oy + place.cy * ppmY);
        c.rotate(place.rot * Math.PI / 180);
        c.scale(place.mmPerPx * ppmX / srcScale, place.mmPerPx * ppmY / srcScale);
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(source, -source.width / 2, -source.height / 2);
        c.restore();
    }

    function draw() {
        if (!img || !view.cssW) return;
        const s = currentSpec();
        const { ppm, fx, fy, cssW, cssH, dpr } = view;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        ctx.fillStyle = dark ? '#1d1c1a' : '#ebe8e1';
        ctx.fillRect(0, 0, cssW, cssH);

        // Empty frame area shows as white, as it will in the output.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(fx, fy, s.widthMm * ppm, s.heightMm * ppm);
        drawPhoto(ctx, ppm, ppm, fx, fy, img.source);

        // Dim everything outside the frame.
        ctx.beginPath();
        ctx.rect(0, 0, cssW, cssH);
        ctx.rect(fx, fy, s.widthMm * ppm, s.heightMm * ppm);
        ctx.fillStyle = 'rgba(20, 18, 16, 0.62)';
        ctx.fill('evenodd');

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(fx - 0.75, fy - 0.75, s.widthMm * ppm + 1.5, s.heightMm * ppm + 1.5);

        if ($('ph-guides').checked) drawGuides(s);

        // Size label under the frame.
        ctx.fillStyle = dark ? '#cfc9bf' : '#4a463f';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${s.widthMm} × ${s.heightMm} mm`, cssW / 2, fy + s.heightMm * ppm + 18);
    }

    function drawGuides(s) {
        const { ppm, fx, fy } = view;
        const X = (mm) => fx + mm * ppm;
        const Y = (mm) => fy + mm * ppm;
        const left = X(0), right = X(s.widthMm);

        // Chin band
        const chinTop = s.crownMm + s.headMinMm, chinBot = s.crownMm + s.headMaxMm;
        ctx.fillStyle = 'rgba(22, 163, 74, 0.28)';
        ctx.fillRect(left, Y(chinTop), right - left, Math.max(2, (chinBot - chinTop) * ppm));
        ctx.strokeStyle = 'rgba(22, 163, 74, 0.95)';
        ctx.lineWidth = 1;
        ctx.strokeRect(left, Y(chinTop), right - left, Math.max(2, (chinBot - chinTop) * ppm));

        // Eye band
        if (s.eyeFromBottomMm) {
            const [eMin, eMax] = s.eyeFromBottomMm;
            const top = s.heightMm - eMax, bot = s.heightMm - eMin;
            ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
            ctx.fillRect(left, Y(top), right - left, (bot - top) * ppm);
            ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(left, Y(top), right - left, (bot - top) * ppm);
            ctx.setLineDash([]);
        }

        // Crown line
        ctx.strokeStyle = '#ff8c00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left, Y(s.crownMm));
        ctx.lineTo(right, Y(s.crownMm));
        ctx.stroke();

        // Centre line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(X(s.widthMm / 2), Y(0));
        ctx.lineTo(X(s.widthMm / 2), Y(s.heightMm));
        ctx.stroke();

        // Head outline hint
        const headH = (s.headMinMm + s.headMaxMm) / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.ellipse(X(s.widthMm / 2), Y(s.crownMm + headH / 2), headH * 0.37 * ppm, headH / 2 * ppm, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // ---------- Output ----------

    /** Render the framed photo at pxW × pxH, filling uncovered areas with white. */
    function renderOutput(pxW, pxH, { fill = '#ffffff', readback = false } = {}) {
        const s = currentSpec();
        const ppmX = pxW / s.widthMm, ppmY = pxH / s.heightMm;
        // Pre-shrink very large photos so the final draw isn't a huge single-step reduction.
        const outPerSrc = place.mmPerPx * Math.max(ppmX, ppmY);
        let source = img.source, srcScale = 1, temp = null;
        if (outPerSrc < 0.5) {
            srcScale = Math.min(1, outPerSrc * 2);
            temp = drawScaled(img.source, img.width * srcScale, img.height * srcScale);
            source = temp;
        }
        const out = createCanvas(pxW, pxH);
        const c = out.getContext('2d', readback ? { willReadFrequently: true } : undefined);
        if (fill) {
            c.fillStyle = fill;
            c.fillRect(0, 0, pxW, pxH);
        }
        drawPhoto(c, ppmX, ppmY, 0, 0, source, srcScale);
        if (temp) releaseCanvas(temp);
        return out;
    }

    function safeLabel(s) {
        return s.id.replace(/[^a-z0-9-]/gi, '');
    }

    async function downloadDigital() {
        if (!img || busy) return;
        busy = true;
        const btn = $('ph-download-digital');
        btn.disabled = true;
        try {
            const s = currentSpec();
            if (s.digital?.minKB && s.digital?.maxKB && s.digital.minKB >= s.digital.maxKB) {
                toast('The minimum file size must be smaller than the maximum.', 'warn');
                return;
            }
            let w, h, maxBytes = null, minBytes = null;
            if (s.digital) {
                ({ width: w, height: h } = s.digital);
                maxBytes = s.digital.maxKB ? Math.floor(s.digital.maxKB * 1024) : null;
                minBytes = s.digital.minKB ? Math.ceil(s.digital.minKB * 1024) : null;
            } else {
                w = Math.round(s.widthMm / 25.4 * 600);
                h = Math.round(s.heightMm / 25.4 * 600);
            }
            const out = renderOutput(w, h);
            const dpi = Math.round(w / (s.widthMm / 25.4));
            const r = await encodeToTarget(out, { format: 'jpg', quality: 0.92, maxBytes, minBytes, allowDownscale: false, dpi });
            releaseCanvas(out);
            downloadBlob(r.bytes, `${safeLabel(s)}-photo-${w}x${h}.jpg`, 'image/jpeg');
            if (!r.ok) toast(r.note || 'The file is outside the size limits.', 'warn');
            else toast(`Saved ${w} × ${h} px, ${formatBytes(r.bytes.length)}.`, 'ok');
            if (!frameCovered()) toast('Part of the frame had no photo and was filled with white.', 'warn');
        } catch (err) {
            toast(err.message || String(err), 'error');
        } finally {
            busy = false;
            btn.disabled = !img;
        }
    }

    async function downloadSheet() {
        if (!img || busy) return;
        busy = true;
        const btn = $('ph-download-sheet');
        btn.disabled = true;
        try {
            const s = currentSpec();
            const sheet = PRINT_SHEETS.find((x) => x.id === sheetSel.value) || PRINT_SHEETS[0];
            const lay = layoutSheet(sheet, s.widthMm, s.heightMm);
            if (!lay.count) throw new Error('The photo is too big for this paper.');
            const px = (mm) => Math.round(mm / 25.4 * PRINT_DPI);
            const pw = px(s.widthMm), ph = px(s.heightMm);
            const photo = renderOutput(pw, ph);
            const out = createCanvas(px(lay.sheetW), px(lay.sheetH));
            const c = out.getContext('2d');
            c.fillStyle = '#ffffff';
            c.fillRect(0, 0, out.width, out.height);
            c.strokeStyle = '#b8b4ac';
            c.lineWidth = 1;
            for (let r = 0; r < lay.rows; r++) {
                for (let col = 0; col < lay.cols; col++) {
                    const x = px(lay.x0 + col * (s.widthMm + lay.gap));
                    const y = px(lay.y0 + r * (s.heightMm + lay.gap));
                    c.drawImage(photo, x, y);
                    c.strokeRect(x - 0.5, y - 0.5, pw + 1, ph + 1); // cutting guide
                }
            }
            releaseCanvas(photo);
            const bytes = await encodeCanvas(out, { format: 'jpg', quality: 0.95, dpi: PRINT_DPI });
            releaseCanvas(out);
            downloadBlob(bytes, `${safeLabel(s)}-photos-${sheet.id}.jpg`, 'image/jpeg');
            toast(`Saved a ${sheet.id === 'a4' ? 'A4' : '4 × 6 in'} sheet with ${lay.count} photos. Print at actual size.`, 'ok');
        } catch (err) {
            toast(err.message || String(err), 'error');
        } finally {
            busy = false;
            renderSheetInfo();
        }
    }

    // ---------- Background check ----------

    function scheduleBgCheck() {
        clearTimeout(bgTimer);
        bgTimer = setTimeout(checkBackground, 250);
    }

    function checkBackground() {
        if (!img) {
            bgCheck.textContent = '';
            bgCheck.className = 'bg-check';
            return;
        }
        const s = currentSpec();
        const w = 70, h = Math.round(70 * s.heightMm / s.widthMm);
        // Leave uncovered areas transparent so only real photo pixels are judged.
        const small = renderOutput(w, h, { fill: null, readback: true });
        const data = small.getContext('2d').getImageData(0, 0, w, h).data;
        releaseCanvas(small);
        // Sample the top corners, where there should only be background.
        const samples = [];
        const regionH = Math.max(2, Math.round(h * 0.1));
        const regionW = Math.max(2, Math.round(w * 0.16));
        for (const x0 of [0, w - regionW]) {
            for (let y = 0; y < regionH; y++) {
                for (let x = x0; x < x0 + regionW; x++) {
                    const i = (y * w + x) * 4;
                    if (data[i + 3] > 200) samples.push([data[i], data[i + 1], data[i + 2]]);
                }
            }
        }
        const covered = frameCovered();
        if (samples.length < 6) {
            bgCheck.className = 'bg-check is-warn';
            bgCheck.textContent = 'The top corners of the frame have no photo, so the background can\'t be checked. Zoom in or move the photo so it fills the frame.';
            return;
        }
        let sumL = 0, sumS = 0;
        const ls = [];
        for (const [r, g, b] of samples) {
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            sumL += l;
            sumS += mx ? (mx - mn) / mx : 0;
            ls.push(l);
        }
        const meanL = sumL / samples.length, meanS = sumS / samples.length;
        const sd = Math.sqrt(ls.reduce((a, l) => a + (l - meanL) ** 2, 0) / ls.length);
        const issues = [];
        if (meanL < 175) issues.push('looks darker than a white or off-white wall');
        if (meanS > 0.14) issues.push('looks coloured');
        if (sd > 22) issues.push('looks uneven or busy');
        if (issues.length) {
            bgCheck.className = 'bg-check is-warn';
            bgCheck.textContent = `Background ${issues.join(' and ')}. Most documents need a plain, light background with no shadows.`;
        } else {
            bgCheck.className = 'bg-check is-ok';
            bgCheck.textContent = 'Background near the top looks plain and light.';
        }
        if (!covered) {
            bgCheck.className = 'bg-check is-warn';
            bgCheck.textContent = `${issues.length ? bgCheck.textContent : 'The visible background looks plain and light.'} Part of the frame has no photo and will be filled with white.`;
        }
    }

    // ---------- Loading ----------

    async function loadFile(file) {
        try {
            const dec = await decodeImage(file);
            if (img) releaseSource(img.source);
            img = { source: dec.source, width: dec.width, height: dec.height, name: file.name };
            $('ph-dropzone').hidden = true;
            $('ph-workarea').hidden = false;
            $('ph-download-digital').disabled = false;
            fitView();
            resetPlacement();
            renderSpecInfo();
            stage.focus({ preventScroll: true });
            if (Math.min(dec.width, dec.height) < 600) {
                toast('This photo is quite small; the result may look soft. Use the original camera photo if you can.', 'warn');
            }
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
    }

    function handleFiles(files) {
        if (files.length) loadFile(files[0]);
    }

    // ---------- Interaction ----------

    const pointers = new Map();
    let gesture = null;

    stage.addEventListener('pointerdown', (e) => {
        if (!img) return;
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        startGesture();
        e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId) || !gesture) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const pts = [...pointers.values()];
        if (pts.length === 1 && gesture.kind === 'pan') {
            place.cx = gesture.cx + (pts[0].x - gesture.x) / view.ppm;
            place.cy = gesture.cy + (pts[0].y - gesture.y) / view.ppm;
            draw();
        } else if (pts.length >= 2 && gesture.kind === 'pinch') {
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            const mid = screenToMm((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
            // Pan with the midpoint, then zoom around it.
            place.cx = gesture.cx + (mid.x - gesture.mid.x);
            place.cy = gesture.cy + (mid.y - gesture.mid.y);
            const target = gesture.s * (d / gesture.d);
            place.mmPerPx = gesture.s;
            zoomTo(target, mid.x, mid.y);
        }
    });
    const endPointer = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        startGesture();
        if (!pointers.size) scheduleBgCheck();
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    function startGesture() {
        const pts = [...pointers.values()];
        if (pts.length === 1) {
            gesture = { kind: 'pan', x: pts[0].x, y: pts[0].y, cx: place.cx, cy: place.cy };
        } else if (pts.length >= 2) {
            gesture = {
                kind: 'pinch',
                d: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
                mid: screenToMm((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2),
                cx: place.cx, cy: place.cy, s: place.mmPerPx,
            };
        } else {
            gesture = null;
        }
    }

    stage.addEventListener('wheel', (e) => {
        if (!img) return;
        e.preventDefault();
        const p = screenToMm(e.clientX, e.clientY);
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomTo(place.mmPerPx * Math.exp(-delta * 0.0015), p.x, p.y);
    }, { passive: false });

    stage.addEventListener('keydown', (e) => {
        if (!img) return;
        const s = currentSpec();
        const step = e.shiftKey ? 2 : 0.4;
        let handled = true;
        if (e.key === 'ArrowLeft') place.cx -= step;
        else if (e.key === 'ArrowRight') place.cx += step;
        else if (e.key === 'ArrowUp') place.cy -= step;
        else if (e.key === 'ArrowDown') place.cy += step;
        else if (e.key === '+' || e.key === '=') { zoomTo(place.mmPerPx * 1.04, s.widthMm / 2, s.heightMm / 2); return void e.preventDefault(); }
        else if (e.key === '-' || e.key === '_') { zoomTo(place.mmPerPx / 1.04, s.widthMm / 2, s.heightMm / 2); return void e.preventDefault(); }
        else handled = false;
        if (handled) {
            e.preventDefault();
            draw();
            scheduleBgCheck();
        }
    });

    zoomRange.addEventListener('input', () => {
        const s = currentSpec();
        const t = Number(zoomRange.value) / 1000;
        const target = coverMmPerPx * 2 ** (ZOOM_MIN + t * (ZOOM_MAX - ZOOM_MIN));
        zoomTo(target, s.widthMm / 2, s.heightMm / 2);
    });

    rotRange.addEventListener('input', () => {
        if (!img) return;
        place.rot = Number(rotRange.value) / 10;
        $('ph-rotate-val').textContent = `${place.rot.toFixed(1)}°`;
        const before = coverMmPerPx;
        computeCover();
        // Keep the same relative zoom as the cover size changes with rotation.
        place.mmPerPx *= coverMmPerPx / before;
        syncZoomRange();
        draw();
        scheduleBgCheck();
    });

    $('ph-guides').addEventListener('change', draw);
    $('ph-reset-btn').addEventListener('click', () => { resetPlacement(); draw(); scheduleBgCheck(); });
    $('ph-download-digital').addEventListener('click', downloadDigital);
    $('ph-download-sheet').addEventListener('click', downloadSheet);

    const input = $('ph-file-input');
    wireDropzone($('ph-dropzone'), input, handleFiles);
    $('ph-open-btn').addEventListener('click', () => input.click());
    $('ph-sample-btn').addEventListener('click', async () => loadFile(await makePortraitSample()));

    // Dropping a new photo onto the framing area replaces it.
    stage.addEventListener('dragover', (e) => e.preventDefault());
    stage.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = [...(e.dataTransfer?.files || [])].find((x) => /^image\//.test(x.type) || /\.(heic|heif)$/i.test(x.name));
        if (f) loadFile(f);
    });

    new ResizeObserver(() => {
        if (!root.hidden && fitView()) draw();
    }).observe(stage);
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    renderSpecInfo();

    return {
        handleFiles,
        onShow() {
            requestAnimationFrame(() => { if (fitView()) draw(); });
        },
    };
}
