// Sample images drawn on the fly, so the app ships no stock photos and needs no network.

import { createCanvas, releaseCanvas } from './image-io.js';

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function addGrain(ctx, w, h, amount, seed) {
    const rand = rng(seed);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const n = (rand() - 0.5) * amount;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
}

function toFile(canvas, name, quality = 0.92) {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => {
            releaseCanvas(canvas);
            resolve(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
        }, 'image/jpeg', quality);
    });
}

/** A detailed 3000×2000 landscape: big enough for resizing and compression to be meaningful. */
export async function makeLandscapeSample() {
    const w = 3000, h = 2000;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const rand = rng(7);

    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, '#3d6fb6');
    sky.addColorStop(0.6, '#9cc3e6');
    sky.addColorStop(1, '#f6d7a7');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Sun
    const sun = ctx.createRadialGradient(w * 0.72, h * 0.42, 10, w * 0.72, h * 0.42, 260);
    sun.addColorStop(0, 'rgba(255,250,220,1)');
    sun.addColorStop(0.25, 'rgba(255,230,160,0.9)');
    sun.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);

    // Clouds
    for (let i = 0; i < 26; i++) {
        const cx = rand() * w, cy = rand() * h * 0.35, r = 60 + rand() * 140;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.35})`;
        for (let k = 0; k < 6; k++) {
            ctx.beginPath();
            ctx.ellipse(cx + (rand() - 0.5) * r * 2, cy + (rand() - 0.5) * r * 0.4, r, r * 0.45, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Mountain ranges
    const ranges = [
        { base: 0.55, amp: 0.2, color: '#6d7fa3' },
        { base: 0.62, amp: 0.16, color: '#4d6b6e' },
        { base: 0.7, amp: 0.1, color: '#355f3e' },
    ];
    for (const r of ranges) {
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.moveTo(0, h);
        let y = h * r.base;
        for (let x = 0; x <= w; x += 12) {
            y += (rand() - 0.5) * 38;
            y = Math.min(h * (r.base + r.amp * 0.3), Math.max(h * (r.base - r.amp), y));
            ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
    }

    // Lake
    const lake = ctx.createLinearGradient(0, h * 0.74, 0, h);
    lake.addColorStop(0, '#7fa9cf');
    lake.addColorStop(1, '#2d4f73');
    ctx.fillStyle = lake;
    ctx.fillRect(0, h * 0.76, w, h * 0.24);
    for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `rgba(255,255,255,${rand() * 0.25})`;
        ctx.fillRect(rand() * w, h * 0.76 + rand() * h * 0.24, 20 + rand() * 90, 2);
    }

    // Trees along the shore
    for (let i = 0; i < 160; i++) {
        const x = rand() * w, base = h * (0.74 + rand() * 0.04), th = 60 + rand() * 140;
        ctx.fillStyle = `hsl(${120 + rand() * 30}, ${30 + rand() * 25}%, ${14 + rand() * 14}%)`;
        ctx.beginPath();
        ctx.moveTo(x, base - th);
        ctx.lineTo(x - th * 0.28, base);
        ctx.lineTo(x + th * 0.28, base);
        ctx.closePath();
        ctx.fill();
    }

    addGrain(ctx, w, h, 14, 11);
    return toFile(c, 'sample-landscape.jpg');
}

/**
 * An illustrated head-and-shoulders portrait on a plain wall, deliberately framed loosely so
 * there is something to line up in the passport tool. Not a real person.
 */
export async function makePortraitSample() {
    const w = 1500, h = 2000;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');

    const wall = ctx.createLinearGradient(0, 0, w, h);
    wall.addColorStop(0, '#f4f4f2');
    wall.addColorStop(1, '#e6e6e3');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.53, headCy = h * 0.42, headRx = 210, headRy = 285;

    // Shoulders / shirt
    ctx.fillStyle = '#2f4a6d';
    ctx.beginPath();
    ctx.moveTo(cx - 620, h);
    ctx.bezierCurveTo(cx - 600, h * 0.74, cx - 330, h * 0.66, cx - 120, h * 0.64);
    ctx.lineTo(cx + 120, h * 0.64);
    ctx.bezierCurveTo(cx + 330, h * 0.66, cx + 600, h * 0.74, cx + 620, h);
    ctx.closePath();
    ctx.fill();
    // Collar
    ctx.fillStyle = '#f3f1ea';
    ctx.beginPath();
    ctx.moveTo(cx - 130, h * 0.64);
    ctx.lineTo(cx, h * 0.72);
    ctx.lineTo(cx + 130, h * 0.64);
    ctx.closePath();
    ctx.fill();

    const skin = '#c98f6a';
    // Neck
    ctx.fillStyle = '#b67c59';
    ctx.fillRect(cx - 95, headCy + headRy * 0.6, 190, h * 0.64 - (headCy + headRy * 0.6) + 20);
    // Ears
    ctx.fillStyle = skin;
    for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + s * headRx * 0.98, headCy + 10, 38, 70, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    // Head
    ctx.beginPath();
    ctx.ellipse(cx, headCy, headRx, headRy, 0, 0, Math.PI * 2);
    ctx.fill();
    // Hair: one cap shape, clipped above the forehead line.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, headCy - headRy * 0.36);
    ctx.clip();
    ctx.fillStyle = '#2b1d16';
    ctx.beginPath();
    ctx.ellipse(cx, headCy - headRy * 0.42, headRx * 1.05, headRy * 0.66, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Eyes
    const eyeY = headCy - 10;
    for (const s of [-1, 1]) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(cx + s * 78, eyeY, 34, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#3a2618';
        ctx.beginPath();
        ctx.arc(cx + s * 78, eyeY, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2b1d16';
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(cx + s * 40, eyeY - 48);
        ctx.quadraticCurveTo(cx + s * 80, eyeY - 62, cx + s * 120, eyeY - 46);
        ctx.stroke();
    }
    // Nose and mouth
    ctx.strokeStyle = '#9a6446';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx - 6, eyeY + 30);
    ctx.quadraticCurveTo(cx - 26, eyeY + 100, cx + 4, eyeY + 112);
    ctx.stroke();
    ctx.strokeStyle = '#8a3f3a';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(cx - 60, eyeY + 168);
    ctx.quadraticCurveTo(cx, eyeY + 182, cx + 60, eyeY + 168);
    ctx.stroke();

    addGrain(ctx, w, h, 8, 5);
    return toFile(c, 'sample-portrait.jpg');
}
