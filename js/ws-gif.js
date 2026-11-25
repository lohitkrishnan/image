// Workspace 6: make an animated GIF slideshow (gifenc, MIT) and play GIFs frame by frame
// (omggif, MIT). Both run entirely in the browser.

import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc/gifenc.esm.js';
import { GifReader } from '../vendor/omggif/omggif.esm.js';
import { formatBytes, baseName, downloadBlob, createCanvas, releaseCanvas, decodeImage, releaseSource, drawScaled, encodeCanvas, wireDropzone, escapeHtml } from './image-io.js';
import { createImageList } from './image-list.js';
import { createZip } from './zip.js';

const PRESETS = [
    { id: 'email-wide', label: 'Email newsletter: 600 × 338 (16:9)', w: 600, h: 338 },
    { id: 'email-square', label: 'Email newsletter: 600 × 600', w: 600, h: 600 },
    { id: 'email-banner', label: 'Email header banner: 600 × 200', w: 600, h: 200 },
    { id: 'chat', label: 'Chat or Slack: 480 × 480', w: 480, h: 480 },
    { id: 'social', label: 'Social post: 1080 × 1080 (large file)', w: 1080, h: 1080 },
    { id: 'custom', label: 'Custom size' },
];
const FADE_STEPS = 5;
const FADE_STEP_MS = 60;
const EMAIL_LIMIT = 1024 * 1024;
const PLAYER_MAX_PIXELS = 80e6; // width × height × frames we are willing to hold in memory

function fitRect(sw, sh, W, H, mode) {
    if (mode === 'cover') {
        const k = Math.max(W / sw, H / sh);
        const cw = W / k, ch = H / k;
        return { src: { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch }, dst: { x: 0, y: 0, w: W, h: H } };
    }
    const k = Math.min(W / sw, H / sh);
    return { src: { sx: 0, sy: 0, sw, sh }, dst: { x: (W - sw * k) / 2, y: (H - sh * k) / 2, w: sw * k, h: sh * k } };
}

export function initGifWorkspace({ root, toast, sendToEditor }) {
    const $ = (id) => root.querySelector(`#${id}`);

    // ---------- Mode switch ----------
    const modeBtns = Array.from(root.querySelectorAll('[data-gifmode]'));
    let mode = 'make';
    function setMode(m) {
        mode = m;
        modeBtns.forEach((b) => {
            const on = b.dataset.gifmode === m;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        $('gif-make').hidden = m !== 'make';
        $('gif-play').hidden = m !== 'play';
        if (m === 'make') startPreview(); else stopPreview();
        if (m === 'play') player.resume(); else player.suspend();
    }
    modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.gifmode)));

    // =====================================================================
    // Maker
    // =====================================================================
    const presetSel = $('gm-preset');
    for (const p of PRESETS) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        presetSel.appendChild(o);
    }
    let fit = 'cover';
    let busy = false;
    let resultBytes = null;
    let resultUrl = null;
    let resultKey = '';
    let resultInfo = '';
    const currentKey = () => JSON.stringify([settings(), list.items.map((it) => it.id)]);

    const list = createImageList({ container: $('gm-list'), toast, onChange: settingsChanged });

    const fitBtns = Array.from(root.querySelectorAll('[data-gmfit]'));
    fitBtns.forEach((b) => b.addEventListener('click', () => {
        fit = b.dataset.gmfit;
        fitBtns.forEach((x) => {
            const on = x === b;
            x.classList.toggle('is-active', on);
            x.setAttribute('aria-pressed', String(on));
        });
        settingsChanged();
    }));
    for (const id of ['gm-preset', 'gm-w', 'gm-h', 'gm-trans', 'gm-loop', 'gm-colors', 'gm-bg']) $(id).addEventListener('input', settingsChanged);
    $('gm-dur').addEventListener('input', () => {
        $('gm-dur-val').textContent = `${(Number($('gm-dur').value) / 10).toFixed(1)} s`;
        settingsChanged();
    });

    function settings() {
        const p = PRESETS.find((x) => x.id === presetSel.value) || PRESETS[0];
        let w = p.w, h = p.h;
        if (p.id === 'custom') {
            w = Math.max(16, Math.min(1600, parseInt($('gm-w').value, 10) || 600));
            h = Math.max(16, Math.min(1600, parseInt($('gm-h').value, 10) || 400));
        }
        return {
            w, h, fit,
            bg: $('gm-bg').value,
            holdMs: Number($('gm-dur').value) * 100,
            fade: $('gm-trans').value === 'fade',
            repeat: Number($('gm-loop').value),
            colors: Number($('gm-colors').value),
        };
    }

    function settingsChanged() {
        const s = settings();
        $('gm-custom').hidden = presetSel.value !== 'custom';
        $('gm-bg-row').hidden = fit !== 'contain';
        const n = list.items.length;
        $('gm-run-btn').disabled = busy || n < 1 || list.busy;
        $('gm-clear-btn').disabled = busy || !n;
        $('gm-preview-wrap').hidden = n === 0;
        if (n) {
            const cycle = n * s.holdMs + (s.fade && n > 1 ? n * FADE_STEPS * FADE_STEP_MS : 0);
            $('gm-preview-info').textContent = `${s.w} × ${s.h} px · ${n} photo${n === 1 ? '' : 's'} · ${(cycle / 1000).toFixed(1)} s per loop`;
        }
        // Flag a result that no longer matches the photos or settings.
        if (resultBytes) {
            const stale = resultKey !== currentKey();
            $('gm-result').classList.toggle('is-stale', stale);
            $('gm-result-info').textContent = stale ? 'Photos or settings changed since this GIF was made. Create it again to update.' : resultInfo;
        }
        sizePreview();
        startPreview();
    }

    // ---------- Live preview ----------
    const pv = $('gm-preview');
    let raf = 0;
    let playing = true;
    let t0 = performance.now();
    let pausedAt = 0;

    function sizePreview() {
        const s = settings();
        const wrapW = Math.max(200, ($('gm-preview-wrap').getBoundingClientRect().width || 640) - 2);
        const k = Math.min(1, wrapW / s.w, 420 / s.h);
        const dpr = window.devicePixelRatio || 1;
        pv.width = Math.round(s.w * k * dpr);
        pv.height = Math.round(s.h * k * dpr);
        pv.style.width = `${Math.round(s.w * k)}px`;
        pv.style.height = `${Math.round(s.h * k)}px`;
    }

    function drawSlide(c, it, s, alpha) {
        const W = c.canvas.width, H = c.canvas.height;
        const p = it.preview;
        const r = fitRect(p.width, p.height, W, H, s.fit);
        c.globalAlpha = alpha;
        if (s.fit === 'contain') {
            c.fillStyle = s.bg;
            c.fillRect(0, 0, W, H);
        }
        c.drawImage(p, r.src.sx, r.src.sy, r.src.sw, r.src.sh, r.dst.x, r.dst.y, r.dst.w, r.dst.h);
        c.globalAlpha = 1;
    }

    function previewFrame(now) {
        const items = list.items;
        if (!items.length || mode !== 'make' || root.hidden) {
            raf = 0;
            return;
        }
        const s = settings();
        const n = items.length;
        const fadeMs = s.fade && n > 1 ? FADE_STEPS * FADE_STEP_MS : 0;
        const slot = s.holdMs + fadeMs;
        const t = (playing ? now - t0 : pausedAt) % (slot * n);
        const i = Math.floor(t / slot);
        const within = t - i * slot;
        const c = pv.getContext('2d');
        c.imageSmoothingQuality = 'high';
        c.fillStyle = s.bg;
        c.fillRect(0, 0, pv.width, pv.height);
        drawSlide(c, items[i], s, 1);
        if (within > s.holdMs && fadeMs) {
            // Step the fade like the GIF will, rather than a smooth blend.
            const step = Math.min(FADE_STEPS, Math.floor((within - s.holdMs) / FADE_STEP_MS) + 1);
            drawSlide(c, items[(i + 1) % n], s, step / (FADE_STEPS + 1));
        }
        raf = playing ? requestAnimationFrame(previewFrame) : 0;
    }

    function startPreview() {
        if (!raf && list.items.length && mode === 'make') raf = requestAnimationFrame(previewFrame);
    }
    function stopPreview() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    }
    $('gm-play').addEventListener('click', () => {
        if (playing) {
            pausedAt = performance.now() - t0;
            playing = false;
        } else {
            t0 = performance.now() - pausedAt;
            playing = true;
        }
        $('gm-play').textContent = playing ? '❚❚ Pause' : '▶ Play';
        $('gm-play').setAttribute('aria-pressed', String(playing));
        stopPreview();
        raf = requestAnimationFrame(previewFrame);
    });

    // ---------- Encoding ----------
    async function renderFrame(it, s) {
        const dec = await decodeImage(it.file);
        try {
            const r = fitRect(dec.width, dec.height, s.w, s.h, s.fit);
            const piece = drawScaled(dec.source, r.dst.w, r.dst.h, r.src);
            const out = createCanvas(s.w, s.h);
            const c = out.getContext('2d', { willReadFrequently: true });
            c.fillStyle = s.fit === 'contain' ? s.bg : '#000000';
            c.fillRect(0, 0, s.w, s.h);
            c.drawImage(piece, Math.round(r.dst.x), Math.round(r.dst.y));
            releaseCanvas(piece);
            const data = c.getImageData(0, 0, s.w, s.h).data;
            releaseCanvas(out);
            return data;
        } finally {
            releaseSource(dec.source);
        }
    }

    function blend(a, b, t) {
        const out = new Uint8ClampedArray(a.length);
        const u = 1 - t;
        for (let i = 0; i < a.length; i++) out[i] = a[i] * u + b[i] * t;
        return out;
    }

    function setProgress(frac) {
        const bar = $('gm-progress');
        bar.hidden = frac == null;
        if (frac != null) bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
    }

    async function create() {
        const items = list.items;
        if (!items.length || busy) return;
        busy = true;
        settingsChanged();
        const btn = $('gm-run-btn');
        const s = settings();
        try {
            const frames = [];
            for (let i = 0; i < items.length; i++) {
                btn.textContent = `Preparing photo ${i + 1} of ${items.length}…`;
                setProgress((i / items.length) * 0.3);
                frames.push(await renderFrame(items[i], s));
                await new Promise((r) => setTimeout(r, 0));
            }
            // Frame list: each photo held, then (optionally) a stepped crossfade to the next one.
            const seq = [];
            const fade = s.fade && frames.length > 1;
            frames.forEach((f, i) => {
                seq.push({ data: f, delay: s.holdMs });
                // Don't fade from the last photo back to the first when the GIF plays only once.
                const last = i === frames.length - 1;
                if (fade && !(last && s.repeat === -1)) {
                    const next = frames[(i + 1) % frames.length];
                    for (let k = 1; k <= FADE_STEPS; k++) seq.push({ blend: [f, next, k / (FADE_STEPS + 1)], delay: FADE_STEP_MS });
                }
            });
            const gif = GIFEncoder();
            for (let i = 0; i < seq.length; i++) {
                btn.textContent = `Encoding frame ${i + 1} of ${seq.length}…`;
                setProgress(0.3 + (i / seq.length) * 0.7);
                const f = seq[i];
                const data = f.data || blend(...f.blend);
                const palette = quantize(data, s.colors);
                const index = applyPalette(data, palette);
                gif.writeFrame(index, s.w, s.h, { palette, delay: f.delay, repeat: s.repeat });
                if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
            }
            gif.finish();
            resultBytes = gif.bytes();
            if (resultUrl) URL.revokeObjectURL(resultUrl);
            resultUrl = URL.createObjectURL(new Blob([resultBytes], { type: 'image/gif' }));
            $('gm-result-img').src = resultUrl;
            $('gm-result').hidden = false;
            let info = `${s.w} × ${s.h} px · ${seq.length} frames · ${formatBytes(resultBytes.length)}.`;
            if (resultBytes.length > EMAIL_LIMIT) info += ' Many email services suggest staying under 1 MB: try fewer photos, 128 colours, or the Cut transition.';
            $('gm-result-info').textContent = info;
            resultInfo = info;
            resultKey = currentKey();
            $('gm-download').hidden = false;
            toast(`GIF ready: ${formatBytes(resultBytes.length)}.`, 'ok');
            $('gm-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            toast(err.message || String(err), 'error');
        } finally {
            busy = false;
            setProgress(null);
            btn.textContent = 'Create GIF';
            settingsChanged();
        }
    }

    $('gm-run-btn').addEventListener('click', create);
    $('gm-download').addEventListener('click', () => {
        if (resultBytes) downloadBlob(resultBytes, 'slideshow.gif', 'image/gif');
    });
    $('gm-clear-btn').addEventListener('click', () => list.clear());
    wireDropzone($('gm-dropzone'), $('gm-file-input'), (files) => list.add(files));

    // =====================================================================
    // Player
    // =====================================================================
    const player = (() => {
        const canvas = $('gp-canvas');
        const ctx = canvas.getContext('2d');
        let frames = []; // { bitmap, delay }
        let info = null;
        let idx = 0;
        let playing = true;
        let timer = 0;
        let name = 'animation';

        function clearTimer() {
            if (timer) clearTimeout(timer);
            timer = 0;
        }

        function show(i) {
            if (!frames.length) return;
            idx = (i + frames.length) % frames.length;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(frames[idx].bitmap, 0, 0);
            $('gp-frame').value = String(idx);
            $('gp-frame-val').textContent = `${idx + 1} / ${frames.length}`;
        }

        function schedule() {
            clearTimer();
            if (!playing || frames.length < 2 || root.hidden || mode !== 'play') return;
            const speed = Number($('gp-speed').value) || 1;
            timer = setTimeout(() => {
                show(idx + 1);
                schedule();
            }, frames[idx].delay / speed);
        }

        function setPlaying(p) {
            playing = p;
            $('gp-play').textContent = playing ? '❚❚ Pause' : '▶ Play';
            schedule();
        }

        async function open(file) {
            try {
                const buf = new Uint8Array(await file.arrayBuffer());
                let reader;
                try {
                    reader = new GifReader(buf);
                } catch {
                    throw new Error(`"${file.name}" isn't a GIF this player can read.`);
                }
                const W = reader.width, H = reader.height, n = reader.numFrames();
                if (W * H * n > PLAYER_MAX_PIXELS) throw new Error(`This GIF is too large to step through here (${W} × ${H} px, ${n} frames).`);
                for (const f of frames) f.bitmap.close?.();
                frames = [];
                clearTimer();
                // Composite each frame onto the canvas state, honouring each frame's disposal method.
                const pixels = new Uint8ClampedArray(W * H * 4);
                let saved = null;
                let prev = null;
                let total = 0;
                for (let i = 0; i < n; i++) {
                    const fi = reader.frameInfo(i);
                    if (prev) {
                        if (prev.disposal === 2) {
                            for (let y = prev.y; y < prev.y + prev.height; y++) {
                                pixels.fill(0, (y * W + prev.x) * 4, (y * W + prev.x + prev.width) * 4);
                            }
                        } else if (prev.disposal === 3 && saved) {
                            pixels.set(saved);
                        }
                    }
                    saved = fi.disposal === 3 ? pixels.slice() : null;
                    reader.decodeAndBlitFrameRGBA(i, pixels);
                    const delay = fi.delay < 2 ? 100 : fi.delay * 10;
                    total += delay;
                    const bitmap = await createImageBitmap(new ImageData(pixels.slice(), W, H));
                    frames.push({ bitmap, delay });
                    prev = fi;
                }
                const loops = reader.loopCount();
                info = { W, H, n, total, loops, size: file.size };
                name = baseName(file.name || 'animation');
                canvas.width = W;
                canvas.height = H;
                $('gp-dropzone').hidden = true;
                $('gp-stage').hidden = false;
                $('gp-controls').hidden = false;
                $('gp-frame').max = String(n - 1);
                $('gp-label').textContent = `${file.name} · ${W} × ${H} px`;
                const loopText = loops === null ? 'Plays once' : loops === 0 ? 'Loops forever' : `Repeats ${loops} time${loops === 1 ? '' : 's'}`;
                $('gp-info').innerHTML = [
                    ['Size', `${W} × ${H} px`],
                    ['Frames', String(n)],
                    ['Length', `${(total / 1000).toFixed(2)} s`],
                    ['Looping', loopText],
                    ['File size', formatBytes(file.size)],
                ].map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
                ['gp-save-frame', 'gp-save-all', 'gp-edit-frame'].forEach((id) => { $(id).disabled = false; });
                show(0);
                setPlaying(n > 1);
            } catch (err) {
                toast(err.message || String(err), 'error');
            }
        }

        function frameCanvas(i) {
            const c = createCanvas(info.W, info.H);
            c.getContext('2d').drawImage(frames[i].bitmap, 0, 0);
            return c;
        }

        async function saveFrame() {
            const c = frameCanvas(idx);
            const bytes = await encodeCanvas(c, { format: 'png' });
            releaseCanvas(c);
            downloadBlob(bytes, `${name}-frame-${idx + 1}.png`, 'image/png');
        }

        async function saveAll() {
            const btn = $('gp-save-all');
            btn.disabled = true;
            try {
                const files = [];
                const pad = String(frames.length).length;
                for (let i = 0; i < frames.length; i++) {
                    btn.textContent = `Saving frame ${i + 1} of ${frames.length}…`;
                    const c = frameCanvas(i);
                    files.push({ name: `${name}-frame-${String(i + 1).padStart(pad, '0')}.png`, data: await encodeCanvas(c, { format: 'png' }) });
                    releaseCanvas(c);
                }
                downloadBlob(createZip(files), `${name}-frames.zip`, 'application/zip');
            } catch (err) {
                toast(err.message || String(err), 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Save All Frames (.zip)';
            }
        }

        async function editFrame() {
            const c = frameCanvas(idx);
            const bytes = await encodeCanvas(c, { format: 'png' });
            releaseCanvas(c);
            setPlaying(false);
            sendToEditor(new File([bytes], `${name}-frame-${idx + 1}.png`, { type: 'image/png' }));
        }

        $('gp-play').addEventListener('click', () => setPlaying(!playing));
        $('gp-prev').addEventListener('click', () => { setPlaying(false); show(idx - 1); });
        $('gp-next').addEventListener('click', () => { setPlaying(false); show(idx + 1); });
        $('gp-frame').addEventListener('input', () => { setPlaying(false); show(Number($('gp-frame').value)); });
        $('gp-speed').addEventListener('change', schedule);
        $('gp-save-frame').addEventListener('click', saveFrame);
        $('gp-save-all').addEventListener('click', saveAll);
        $('gp-edit-frame').addEventListener('click', editFrame);
        const input = $('gp-file-input');
        wireDropzone($('gp-dropzone'), input, (files) => open(files[0]));
        $('gp-open-btn').addEventListener('click', () => input.click());
        $('gp-stage').addEventListener('dragover', (e) => e.preventDefault());
        $('gp-stage').addEventListener('drop', (e) => {
            e.preventDefault();
            const f = e.dataTransfer?.files?.[0];
            if (f) open(f);
        });
        $('gp-stage').addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') { setPlaying(false); show(idx - 1); }
            else if (e.key === 'ArrowRight') { setPlaying(false); show(idx + 1); }
            else if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
        });
        $('gp-stage').tabIndex = 0;

        return {
            open,
            resume: () => schedule(),
            suspend: () => clearTimer(),
        };
    })();

    new ResizeObserver(() => {
        if (!root.hidden && list.items.length) {
            sizePreview();
            startPreview();
        }
    }).observe($('gm-preview-wrap'));

    settingsChanged();

    return {
        handleFiles(files) {
            const gifs = files.filter((f) => f.type === 'image/gif' || /\.gif$/i.test(f.name));
            if (mode === 'play' && gifs.length) player.open(gifs[0]);
            else list.add(files);
        },
        onShow() {
            if (mode === 'make') {
                sizePreview();
                startPreview();
            } else {
                player.resume();
            }
        },
        onHide() {
            stopPreview();
            player.suspend();
        },
    };
}
