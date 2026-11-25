// Workspace 1: batch resize, compress and convert.

import {
    FORMATS, formatBytes, baseName, escapeHtml, downloadBlob, createCanvas, releaseCanvas,
    decodeImage, releaseSource, drawScaled, encodeToTarget, supportsWebpEncoding, wireDropzone,
} from './image-io.js';
import { createZip } from './zip.js';
import { makeLandscapeSample } from './samples.js';

const MAX_OUTPUT_PIXELS = 100e6; // beyond this most browsers can't allocate the canvas

const PRESETS = [
    { id: 'custom', label: 'Custom settings' },
    {
        id: 'under50', label: 'Compress under 50 KB (JPG)',
        s: { format: 'jpg', mode: 'original', minKB: null, maxKB: 50, allowShrink: true },
    },
    {
        id: 'under100', label: 'Compress under 100 KB (JPG)',
        s: { format: 'jpg', mode: 'original', minKB: null, maxKB: 100, allowShrink: true },
    },
    {
        id: 'exam-photo', label: 'Exam form photo: 200 × 230 px, 20–50 KB',
        s: { format: 'jpg', mode: 'exact', width: 200, height: 230, fit: 'cover', minKB: 20, maxKB: 50, allowShrink: false },
        note: 'Common for SSC, UPSC and bank exam forms. Each form has its own rules, so check the notification.',
    },
    {
        id: 'exam-sign', label: 'Exam form signature: 140 × 60 px, 10–20 KB',
        s: { format: 'jpg', mode: 'exact', width: 140, height: 60, fit: 'contain', minKB: 10, maxKB: 20, allowShrink: false },
        note: 'The signature is fitted with white borders, never cropped. Check your form\'s exact limits.',
    },
    {
        id: 'passport-seva', label: 'Passport Seva upload: 630 × 810 px, under 250 KB',
        s: { format: 'jpg', mode: 'exact', width: 630, height: 810, fit: 'cover', minKB: null, maxKB: 250, allowShrink: false },
        note: 'This only resizes. To frame the face correctly, use the Passport & ID Photo tab.',
    },
    {
        id: 'web', label: 'Website: max 1920 px, WebP',
        s: { format: 'webp', mode: 'longest', longest: 1920, minKB: null, maxKB: null, quality: 82, noUpscale: true },
    },
    {
        id: 'email', label: 'Email or WhatsApp: max 1600 px, under 500 KB',
        s: { format: 'jpg', mode: 'longest', longest: 1600, minKB: null, maxKB: 500, quality: 85, noUpscale: true, allowShrink: true },
    },
];

const MM_PER = { mm: 1, cm: 10, in: 25.4 };

let uid = 0;

export function initResizeWorkspace({ root, toast, sendToEditor }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const dropzone = $('rs-dropzone');
    const input = $('rs-file-input');
    const queueEl = $('rs-queue');
    const emptyEl = $('rs-empty-state');
    const summaryBar = $('rs-summary-bar');
    const summaryText = $('rs-summary-text');
    const runBtn = $('rs-run-btn');
    const clearBtn = $('rs-clear-btn');
    const dlAllBtn = $('rs-download-all-btn');
    const presetSel = $('rs-preset');
    const presetNote = $('rs-preset-note');
    const modeSel = $('rs-mode');
    const qualityRange = $('rs-quality');
    const qualityVal = $('rs-quality-val');
    const formatBtns = Array.from(root.querySelectorAll('[data-format]'));
    const fitBtns = Array.from(root.querySelectorAll('[data-fit]'));

    const webpOk = supportsWebpEncoding();
    if (!webpOk) {
        const b = formatBtns.find((x) => x.dataset.format === 'webp');
        b.disabled = true;
        b.title = 'This browser cannot save WebP images.';
    }

    const items = [];
    let busy = false;
    let format = 'jpg';
    let fit = 'cover';

    for (const p of PRESETS) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        presetSel.appendChild(o);
    }

    // ---------- Settings ----------

    function setFormat(f) {
        format = f;
        formatBtns.forEach((b) => {
            const on = b.dataset.format === f;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        $('rs-quality-row').hidden = f === 'png';
    }
    function setFit(f) {
        fit = f;
        fitBtns.forEach((b) => {
            const on = b.dataset.fit === f;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
    }

    function updateModeUI() {
        const m = modeSel.value;
        $('rs-size-longest').hidden = m !== 'longest';
        $('rs-size-exact').hidden = m !== 'exact';
        $('rs-size-percent').hidden = m !== 'percent';
        $('rs-size-print').hidden = m !== 'print';
        $('rs-fit-row').hidden = !(m === 'exact' || m === 'print');
        $('rs-noup-row').hidden = !(m === 'longest' || m === 'percent');
        if (m === 'print') {
            const { width, height } = printPixels();
            $('rs-print-px').textContent = width && height ? `= ${width} × ${height} px` : '';
        }
    }

    function num(id) {
        const v = parseFloat($(id).value);
        return Number.isFinite(v) && v > 0 ? v : null;
    }

    function printPixels() {
        const unit = MM_PER[$('rs-print-unit').value] || 10;
        const dpi = num('rs-dpi') || 300;
        const w = num('rs-print-w'), h = num('rs-print-h');
        if (!w || !h) return { width: null, height: null, dpi };
        return { width: Math.round((w * unit / 25.4) * dpi), height: Math.round((h * unit / 25.4) * dpi), dpi };
    }

    function readSettings() {
        const mode = modeSel.value;
        const s = {
            format,
            mode,
            fit,
            quality: Number(qualityRange.value) / 100,
            minKB: num('rs-min-kb'),
            maxKB: num('rs-max-kb'),
            allowShrink: $('rs-allow-shrink').checked,
            noUpscale: $('rs-no-upscale').checked,
            dpi: null,
        };
        if (mode === 'longest') s.longest = num('rs-longest');
        if (mode === 'exact') { s.width = num('rs-width'); s.height = num('rs-height'); }
        if (mode === 'percent') s.percent = num('rs-percent');
        if (mode === 'print') {
            const p = printPixels();
            s.width = p.width; s.height = p.height; s.dpi = p.dpi;
        }
        return s;
    }

    function validate(s) {
        if (s.mode === 'longest' && !s.longest) return 'Enter the longest side in pixels.';
        if ((s.mode === 'exact' || s.mode === 'print') && (!s.width || !s.height)) return 'Enter both width and height.';
        if (s.mode === 'percent' && !s.percent) return 'Enter a scale percentage.';
        if (s.minKB && s.maxKB && s.minKB >= s.maxKB) return 'The minimum file size must be smaller than the maximum.';
        return null;
    }

    function applyPreset(id) {
        const p = PRESETS.find((x) => x.id === id);
        presetNote.hidden = !p?.note;
        presetNote.textContent = p?.note || '';
        if (!p?.s) return;
        const s = p.s;
        setFormat(s.format === 'webp' && !webpOk ? 'jpg' : s.format);
        modeSel.value = s.mode;
        if (s.longest) $('rs-longest').value = s.longest;
        if (s.width) $('rs-width').value = s.width;
        if (s.height) $('rs-height').value = s.height;
        if (s.fit) setFit(s.fit);
        $('rs-min-kb').value = s.minKB ?? '';
        $('rs-max-kb').value = s.maxKB ?? '';
        if (s.allowShrink !== undefined) $('rs-allow-shrink').checked = s.allowShrink;
        if (s.noUpscale !== undefined) $('rs-no-upscale').checked = s.noUpscale;
        if (s.quality) qualityRange.value = s.quality;
        else qualityRange.value = 85;
        qualityVal.textContent = qualityRange.value;
        updateModeUI();
        invalidateResults();
    }

    function onSettingChanged() {
        if (presetSel.value !== 'custom') {
            presetSel.value = 'custom';
            presetNote.hidden = true;
        }
        updateModeUI();
        invalidateResults();
    }

    presetSel.addEventListener('change', () => applyPreset(presetSel.value));
    formatBtns.forEach((b) => b.addEventListener('click', () => { setFormat(b.dataset.format); onSettingChanged(); }));
    fitBtns.forEach((b) => b.addEventListener('click', () => { setFit(b.dataset.fit); onSettingChanged(); }));
    modeSel.addEventListener('change', onSettingChanged);
    qualityRange.addEventListener('input', () => { qualityVal.textContent = qualityRange.value; });
    qualityRange.addEventListener('change', onSettingChanged);
    for (const id of ['rs-longest', 'rs-width', 'rs-height', 'rs-percent', 'rs-print-w', 'rs-print-h', 'rs-print-unit', 'rs-dpi', 'rs-min-kb', 'rs-max-kb', 'rs-allow-shrink', 'rs-no-upscale']) {
        $(id).addEventListener('input', onSettingChanged);
        $(id).addEventListener('change', onSettingChanged);
    }
    $('rs-suffix').addEventListener('input', () => renderSummary());

    // ---------- Queue ----------

    async function handleFiles(files) {
        const list = Array.from(files);
        for (const file of list) {
            const item = { id: ++uid, file, name: file.name || 'pasted-image.png', size: file.size, status: 'loading', width: 0, height: 0, thumb: null, result: null, error: null };
            items.push(item);
            render();
            try {
                const dec = await decodeImage(file);
                item.width = dec.width;
                item.height = dec.height;
                item.via = dec.via;
                item.thumb = await makeThumb(dec.source);
                releaseSource(dec.source);
                item.status = 'ready';
            } catch (err) {
                item.status = 'error';
                item.error = err.message || String(err);
            }
            render();
        }
    }

    async function makeThumb(source) {
        const scale = Math.min(1, 160 / Math.max(source.width, source.height));
        const c = drawScaled(source, source.width * scale, source.height * scale);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
        releaseCanvas(c);
        return blob ? URL.createObjectURL(blob) : null;
    }

    function removeItem(id) {
        const i = items.findIndex((x) => x.id === id);
        if (i < 0) return;
        if (items[i].thumb) URL.revokeObjectURL(items[i].thumb);
        items.splice(i, 1);
        render();
    }

    function invalidateResults() {
        let changed = false;
        for (const it of items) {
            if (it.result || (it.status === 'error' && it.width)) {
                it.result = null;
                it.status = it.width ? 'ready' : it.status;
                it.error = it.width ? null : it.error;
                changed = true;
            }
        }
        if (changed) render();
    }

    function sourceFormatKey(item) {
        const t = (item.file.type || '').toLowerCase();
        if (t === 'image/png') return 'png';
        if (t === 'image/webp' && webpOk) return 'webp';
        return 'jpg';
    }

    function fmtLabel(item) {
        const t = (item.file.type || '').replace('image/', '').toUpperCase();
        if (t) return t === 'JPEG' ? 'JPG' : t;
        const ext = (item.name.split('.').pop() || '').toUpperCase();
        return ext || 'image';
    }

    function outName(item, fmtKey, suffix) {
        return `${baseName(item.name)}${suffix}.${FORMATS[fmtKey].ext}`;
    }

    function resultName(item) {
        const suffix = $('rs-suffix').value.replace(/[\\/:*?"<>|]/g, '');
        return outName(item, item.result.format, suffix);
    }

    function render() {
        queueEl.innerHTML = '';
        emptyEl.hidden = items.length > 0;
        for (const it of items) {
            const card = document.createElement('div');
            card.className = 'queue-card rs-card';
            if (it.result?.ok) card.classList.add('is-done');
            if (it.status === 'error' || (it.result && !it.result.ok)) card.classList.add('is-error');

            const thumb = it.thumb ? `<img class="rs-thumb" src="${it.thumb}" alt="" />` : '<div class="rs-thumb rs-thumb-empty" aria-hidden="true"></div>';
            const meta = it.width ? `${it.width} × ${it.height} px · ${formatBytes(it.size)} · ${escapeHtml(fmtLabel(it))}${it.via === 'libheif' ? ' (decoded with libheif)' : ''}` : formatBytes(it.size);
            let resultHtml = '';
            if (it.result) {
                const r = it.result;
                const pct = Math.round((1 - r.bytes.length / it.size) * 100);
                const pill = pct >= 0 ? `<span class="delta-pill is-saved">−${pct}%</span>` : `<span class="delta-pill">+${-pct}%</span>`;
                const q = r.quality != null && FORMATS[r.format].lossy ? ` · quality ${Math.round(r.quality * 100)}` : '';
                resultHtml = `<div class="queue-result">→ <strong>${r.width} × ${r.height} px · ${formatBytes(r.bytes.length)} ${FORMATS[r.format].label}</strong>${q} ${pill}</div>`;
                if (r.note) resultHtml += `<div class="queue-status ${r.ok ? '' : 'is-error'}">${escapeHtml(r.note)}</div>`;
            }
            let status = '';
            if (it.status === 'loading') status = '<div class="queue-status">Reading…</div>';
            else if (it.status === 'working') status = '<div class="queue-status">Processing…</div>';
            else if (it.status === 'error') status = `<div class="queue-status is-error">${escapeHtml(it.error || 'Failed')}</div>`;

            card.innerHTML = `
                ${thumb}
                <div class="queue-card-main">
                    <div class="queue-card-title-row"><strong class="queue-filename" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</strong></div>
                    <div class="queue-meta">${meta}</div>
                    ${resultHtml}${status}
                </div>
                <div class="queue-card-btns">
                    ${it.result ? '<button type="button" class="btn btn-primary btn-xs" data-act="dl">Download</button>' : ''}
                    ${it.width ? '<button type="button" class="btn btn-ghost btn-xs" data-act="edit" title="Open in Edit &amp; Annotate">Edit</button>' : ''}
                    <button type="button" class="btn btn-ghost btn-xs" data-act="rm" aria-label="Remove ${escapeHtml(it.name)}">✕</button>
                </div>`;
            card.querySelector('[data-act="rm"]').addEventListener('click', () => removeItem(it.id));
            card.querySelector('[data-act="dl"]')?.addEventListener('click', () => {
                const r = it.result;
                downloadBlob(r.bytes, resultName(it), FORMATS[r.format].mime);
            });
            card.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
                const file = it.result
                    ? new File([it.result.bytes], resultName(it), { type: FORMATS[it.result.format].mime })
                    : it.file;
                sendToEditor(file);
            });
            if (busy) card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            queueEl.appendChild(card);
        }
        renderSummary();
    }

    function renderSummary() {
        const ready = items.filter((x) => x.width);
        const done = items.filter((x) => x.result);
        runBtn.disabled = busy || ready.length === 0;
        runBtn.textContent = busy ? 'Processing…' : ready.length > 1 ? `Process ${ready.length} Images` : 'Process Image';
        clearBtn.disabled = busy || items.length === 0;
        summaryBar.hidden = done.length === 0;
        dlAllBtn.disabled = busy || done.length === 0;
        dlAllBtn.textContent = done.length > 1 ? `Download All (.zip)` : 'Download';
        if (done.length) {
            const before = done.reduce((a, x) => a + x.size, 0);
            const after = done.reduce((a, x) => a + x.result.bytes.length, 0);
            const pct = Math.round((1 - after / before) * 100);
            summaryText.textContent = `${done.length} image${done.length === 1 ? '' : 's'}: ${formatBytes(before)} → ${formatBytes(after)} (${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%)`;
        }
    }

    // ---------- Processing ----------

    function targetGeometry(srcW, srcH, s) {
        let w = srcW, h = srcH;
        let src = { sx: 0, sy: 0, sw: srcW, sh: srcH };
        let dst = null; // placement within the output for "contain"
        if (s.mode === 'longest') {
            let k = s.longest / Math.max(srcW, srcH);
            if (s.noUpscale) k = Math.min(1, k);
            w = srcW * k; h = srcH * k;
        } else if (s.mode === 'percent') {
            let k = s.percent / 100;
            if (s.noUpscale) k = Math.min(1, k);
            w = srcW * k; h = srcH * k;
        } else if (s.mode === 'exact' || s.mode === 'print') {
            w = s.width; h = s.height;
            if (s.fit === 'cover') {
                const k = Math.max(w / srcW, h / srcH);
                const sw = w / k, sh = h / k;
                src = { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
            } else if (s.fit === 'contain') {
                const k = Math.min(w / srcW, h / srcH);
                const dw = srcW * k, dh = srcH * k;
                dst = { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
            }
        }
        return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), src, dst };
    }

    function render1(source, g, background) {
        if (!g.dst) {
            return drawScaled(source, g.w, g.h, { ...g.src, background });
        }
        const inner = drawScaled(source, Math.max(1, Math.round(g.dst.w)), Math.max(1, Math.round(g.dst.h)));
        const out = createCanvas(g.w, g.h);
        const ctx = out.getContext('2d');
        if (background) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, g.w, g.h);
        }
        ctx.drawImage(inner, Math.round(g.dst.x), Math.round(g.dst.y));
        releaseCanvas(inner);
        return out;
    }

    async function processAll() {
        const s = readSettings();
        const problem = validate(s);
        if (problem) {
            toast(problem, 'warn');
            return;
        }
        const todo = items.filter((x) => x.width);
        if (!todo.length) return;
        busy = true;
        for (const it of todo) { it.result = null; it.status = 'queued'; }
        render();

        let failures = 0;
        for (const it of todo) {
            it.status = 'working';
            render();
            let dec = null, canvas = null;
            try {
                const fmtKey = s.format === 'same' ? sourceFormatKey(it) : s.format;
                const g = targetGeometry(it.width, it.height, s);
                if (g.w * g.h > MAX_OUTPUT_PIXELS) throw new Error(`${g.w} × ${g.h} px is too large for the browser to create.`);
                dec = await decodeImage(it.file);
                const bg = FORMATS[fmtKey].alpha ? null : '#ffffff';
                canvas = render1(dec.source, g, bg);
                releaseSource(dec.source);
                dec = null;
                const r = await encodeToTarget(canvas, {
                    format: fmtKey,
                    quality: s.quality,
                    maxBytes: s.maxKB ? Math.floor(s.maxKB * 1024) : null,
                    minBytes: s.minKB ? Math.ceil(s.minKB * 1024) : null,
                    allowDownscale: s.allowShrink,
                    dpi: s.dpi,
                });
                let note = r.note;
                if (r.scaled) note = `Made smaller (${r.width} × ${r.height} px) to fit the file-size limit. ${note}`.trim();
                if (s.mode === 'longest' && s.noUpscale && Math.max(it.width, it.height) < s.longest && !r.scaled) {
                    note = `Already smaller than ${s.longest} px, so kept at its size. ${note}`.trim();
                }
                it.result = { bytes: r.bytes, width: r.width, height: r.height, format: fmtKey, quality: r.quality, ok: r.ok, note };
                if (!r.ok) failures++;
                it.status = 'done';
            } catch (err) {
                it.status = 'error';
                it.error = err.message || String(err);
                failures++;
            } finally {
                if (dec) releaseSource(dec.source);
                if (canvas) releaseCanvas(canvas);
            }
            render();
            await new Promise((r) => setTimeout(r, 0));
        }
        busy = false;
        render();
        if (failures) toast(`${failures} image${failures === 1 ? '' : 's'} didn't fully meet the settings. See the notes on each.`, 'warn');
        else toast(`Done. ${todo.length} image${todo.length === 1 ? '' : 's'} ready to download.`, 'ok');
    }

    function downloadAll() {
        const done = items.filter((x) => x.result);
        if (!done.length) return;
        if (done.length === 1) {
            const r = done[0].result;
            downloadBlob(r.bytes, resultName(done[0]), FORMATS[r.format].mime);
            return;
        }
        try {
            const zip = createZip(done.map((x) => ({ name: resultName(x), data: x.result.bytes })));
            downloadBlob(zip, 'images.zip', 'application/zip');
        } catch (err) {
            toast(err.message || String(err), 'error');
        }
    }

    runBtn.addEventListener('click', processAll);
    dlAllBtn.addEventListener('click', downloadAll);
    clearBtn.addEventListener('click', () => {
        for (const it of items) if (it.thumb) URL.revokeObjectURL(it.thumb);
        items.length = 0;
        render();
    });
    $('rs-sample-btn').addEventListener('click', async () => {
        const btn = $('rs-sample-btn');
        btn.disabled = true;
        try {
            await handleFiles([await makeLandscapeSample()]);
        } finally {
            btn.disabled = false;
        }
    });
    wireDropzone(dropzone, input, handleFiles);

    setFormat('jpg');
    setFit('cover');
    updateModeUI();
    render();

    return { handleFiles };
}
