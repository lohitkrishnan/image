// Workspace 5: merge (stitch) images side by side, stacked, or in a grid.

import { FORMATS, formatBytes, downloadBlob, createCanvas, releaseCanvas, decodeImage, releaseSource, drawScaled, encodeCanvas, supportsWebpEncoding, wireDropzone } from './image-io.js';
import { createImageList } from './image-list.js';

const MAX_PIXELS = 100e6;

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Lay out images (natural sizes) into one canvas. Gap and border stay at their pixel values;
 * images shrink so the longest side of the result is at most maxSide.
 * Returns { W, H, rects: [{ x, y, w, h, crop }] }.
 */
export function layoutMerge(sizes, o) {
    const n = sizes.length;
    const { gap, pad } = o;
    const build = (s) => {
        const rects = [];
        if (o.dir === 'grid') {
            const cols = Math.max(1, Math.min(o.cols, n));
            const rows = Math.ceil(n / cols);
            const cw = median(sizes.map((z) => z.w)) * s;
            const ch = cw / median(sizes.map((z) => z.w / z.h));
            sizes.forEach((z, i) => {
                const cx = pad + (i % cols) * (cw + gap), cy = pad + Math.floor(i / cols) * (ch + gap);
                if (o.fit === 'cover') {
                    const k = Math.max(cw / z.w, ch / z.h);
                    const sw = cw / k, sh = ch / k;
                    rects.push({ x: cx, y: cy, w: cw, h: ch, crop: { sx: (z.w - sw) / 2, sy: (z.h - sh) / 2, sw, sh } });
                } else {
                    const k = Math.min(cw / z.w, ch / z.h);
                    rects.push({ x: cx + (cw - z.w * k) / 2, y: cy + (ch - z.h * k) / 2, w: z.w * k, h: z.h * k, crop: null });
                }
            });
            return { W: 2 * pad + cols * cw + (cols - 1) * gap, H: 2 * pad + rows * ch + (rows - 1) * gap, rects };
        }
        const row = o.dir === 'row';
        // Main axis: along the join. Cross axis: the shared height (row) or width (column).
        const cross = (z) => (row ? z.h : z.w);
        const main = (z) => (row ? z.w : z.h);
        const target = o.match ? Math.min(...sizes.map(cross)) : Math.max(...sizes.map(cross));
        let pos = pad;
        const crossSize = target * s;
        for (const z of sizes) {
            const k = (o.match ? target / cross(z) : 1) * s;
            const m = main(z) * k, c = cross(z) * k;
            const off = o.align === 'start' ? 0 : o.align === 'end' ? crossSize - c : (crossSize - c) / 2;
            rects.push(row ? { x: pos, y: pad + off, w: m, h: c, crop: null } : { x: pad + off, y: pos, w: c, h: m, crop: null });
            pos += m + gap;
        }
        const mainTotal = pos - gap + pad;
        return row ? { W: mainTotal, H: crossSize + 2 * pad, rects } : { W: crossSize + 2 * pad, H: mainTotal, rects };
    };
    const unit = build(1);
    if (!o.maxSide || Math.max(unit.W, unit.H) <= o.maxSide) return round(unit);
    // Fixed parts (gaps and border) don't scale; solve for the image scale along the longer side.
    const zero = build(0);
    const longW = unit.W >= unit.H;
    const fixed = longW ? zero.W : zero.H;
    const content = (longW ? unit.W : unit.H) - fixed;
    const s = Math.max(0.01, (o.maxSide - fixed) / content);
    return round(build(s));
}

function round(l) {
    return { W: Math.max(1, Math.round(l.W)), H: Math.max(1, Math.round(l.H)), rects: l.rects };
}

export function initMergeWorkspace({ root, toast }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const preview = $('mg-preview');
    const webpOk = supportsWebpEncoding();
    const o = { dir: 'row', fit: 'cover', align: 'center', bg: '#ffffff', format: 'jpg' };
    let busy = false;

    const list = createImageList({ container: $('mg-list'), toast, onChange: update });

    function seg(attr, key) {
        const btns = Array.from(root.querySelectorAll(`[data-${attr}]`));
        btns.forEach((b) => b.addEventListener('click', () => {
            btns.forEach((x) => {
                const on = x === b;
                x.classList.toggle('is-active', on);
                x.setAttribute('aria-pressed', String(on));
            });
            o[key] = b.dataset[attr];
            update();
        }));
        return btns;
    }
    seg('mgdir', 'dir');
    seg('mgfit', 'fit');
    seg('mgalign', 'align');
    const fmtBtns = seg('mgformat', 'format');
    if (!webpOk) fmtBtns.find((b) => b.dataset.mgformat === 'webp').disabled = true;

    const bgBtns = Array.from(root.querySelectorAll('[data-mgbg]'));
    const setBg = (v, btn) => {
        o.bg = v;
        bgBtns.forEach((b) => {
            const on = b === btn;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        $('mg-bg-custom').classList.toggle('is-active', !btn);
        update();
    };
    bgBtns.forEach((b) => b.addEventListener('click', () => setBg(b.dataset.mgbg, b)));
    $('mg-bg-custom').addEventListener('input', () => setBg($('mg-bg-custom').value, null));

    for (const id of ['mg-cols', 'mg-max', 'mg-match']) $(id).addEventListener('input', update);
    $('mg-gap').addEventListener('input', update);
    $('mg-pad').addEventListener('input', update);

    function options() {
        return {
            ...o,
            cols: Math.max(1, parseInt($('mg-cols').value, 10) || 2),
            match: $('mg-match').checked,
            gap: Number($('mg-gap').value),
            pad: Number($('mg-pad').value),
            maxSide: Math.max(100, parseInt($('mg-max').value, 10) || 4000),
        };
    }

    function effectiveBg(opt) {
        return opt.bg === 'transparent' && !FORMATS[opt.format].alpha ? '#ffffff' : opt.bg;
    }

    function update() {
        const items = list.items;
        const opt = options();
        $('mg-cols-group').hidden = opt.dir !== 'grid';
        $('mg-match-group').hidden = opt.dir === 'grid';
        $('mg-match-text').textContent = opt.dir === 'col' ? 'Make all images the same width' : 'Make all images the same height';
        $('mg-align-row').hidden = opt.match;
        $('mg-gap-val').textContent = `${opt.gap} px`;
        $('mg-pad-val').textContent = `${opt.pad} px`;
        $('mg-run-btn').disabled = busy || items.length < 2 || list.busy;
        if (!busy) $('mg-run-btn').textContent = 'Download Merged Image';
        $('mg-clear-btn').disabled = busy || !items.length;
        $('mg-reverse-btn').disabled = busy || items.length < 2;
        if (!items.length) {
            $('mg-preview-wrap').hidden = true;
            $('mg-desc').textContent = 'Add two or more images.';
            return;
        }
        const lay = layoutMerge(items.map((it) => ({ w: it.width, h: it.height })), opt);
        let desc = `Result: ${lay.W} × ${lay.H} px ${FORMATS[opt.format].label}.`;
        if (opt.bg === 'transparent' && !FORMATS[opt.format].alpha) desc += ' JPG has no transparency, so the background will be white.';
        if (lay.W * lay.H > MAX_PIXELS) desc += ' That is too large for the browser; lower the longest side.';
        $('mg-desc').textContent = items.length < 2 ? 'Add at least one more image.' : desc;
        drawPreview(items, opt, lay);
    }

    function drawPreview(items, opt, lay) {
        $('mg-preview-wrap').hidden = false;
        const box = $('mg-preview-wrap').getBoundingClientRect();
        const maxW = Math.max(200, (box.width || 760) - 2);
        const k = Math.min(maxW / lay.W, 520 / lay.H, 1);
        const dpr = window.devicePixelRatio || 1;
        preview.width = Math.max(1, Math.round(lay.W * k * dpr));
        preview.height = Math.max(1, Math.round(lay.H * k * dpr));
        preview.style.width = `${Math.round(lay.W * k)}px`;
        preview.style.height = `${Math.round(lay.H * k)}px`;
        const c = preview.getContext('2d');
        const s = k * dpr;
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, preview.width, preview.height);
        const bg = effectiveBg(opt);
        preview.classList.toggle('is-transparent', bg === 'transparent');
        if (bg !== 'transparent') {
            c.fillStyle = bg;
            c.fillRect(0, 0, preview.width, preview.height);
        }
        c.imageSmoothingQuality = 'high';
        items.forEach((it, i) => {
            const r = lay.rects[i];
            const p = it.preview, pk = p.width / it.width;
            if (r.crop) c.drawImage(p, r.crop.sx * pk, r.crop.sy * pk, r.crop.sw * pk, r.crop.sh * pk, r.x * s, r.y * s, r.w * s, r.h * s);
            else c.drawImage(p, r.x * s, r.y * s, r.w * s, r.h * s);
        });
    }

    async function run() {
        const items = list.items;
        if (items.length < 2 || busy) return;
        const opt = options();
        const lay = layoutMerge(items.map((it) => ({ w: it.width, h: it.height })), opt);
        if (lay.W * lay.H > MAX_PIXELS) {
            toast('The merged image would be too large. Lower the longest side.', 'warn');
            return;
        }
        busy = true;
        update();
        const btn = $('mg-run-btn');
        let out = null;
        try {
            out = createCanvas(lay.W, lay.H);
            const c = out.getContext('2d');
            const bg = effectiveBg(opt);
            if (bg !== 'transparent') {
                c.fillStyle = bg;
                c.fillRect(0, 0, lay.W, lay.H);
            }
            for (let i = 0; i < items.length; i++) {
                btn.textContent = `Merging ${i + 1} of ${items.length}…`;
                const r = lay.rects[i];
                const dec = await decodeImage(items[i].file);
                const crop = r.crop || {};
                const piece = drawScaled(dec.source, r.w, r.h, crop);
                releaseSource(dec.source);
                c.drawImage(piece, Math.round(r.x), Math.round(r.y));
                releaseCanvas(piece);
                await new Promise((res) => setTimeout(res, 0));
            }
            const bytes = await encodeCanvas(out, { format: opt.format, quality: 0.9 });
            downloadBlob(bytes, `merged.${FORMATS[opt.format].ext}`, FORMATS[opt.format].mime);
            toast(`Saved ${lay.W} × ${lay.H} px, ${formatBytes(bytes.length)}.`, 'ok');
        } catch (err) {
            toast(err.message || String(err), 'error');
        } finally {
            releaseCanvas(out);
            busy = false;
            update();
        }
    }

    $('mg-run-btn').addEventListener('click', run);
    $('mg-clear-btn').addEventListener('click', () => list.clear());
    $('mg-reverse-btn').addEventListener('click', () => list.reverse());
    wireDropzone($('mg-dropzone'), $('mg-file-input'), (files) => list.add(files));
    new ResizeObserver(() => { if (!root.hidden && list.items.length) update(); }).observe($('mg-preview-wrap'));
    update();

    return {
        handleFiles: (files) => list.add(files),
        onShow: () => update(),
    };
}
