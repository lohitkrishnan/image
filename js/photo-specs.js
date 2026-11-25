// Passport / ID photo specifications.
//
// Geometry is in millimetres, measured on the printed photo:
//   headMinMm / headMaxMm  chin-to-crown height range
//   crownMm                where the top of the head should sit, from the top edge
//   eyeFromBottomMm        optional [min, max] range for the eye line, from the bottom edge
// `digital` describes the file to upload (pixel size and file-size window), or null when the
// authority asks for something other than a cropped photo.
//
// Rules change. Each spec links to the official page so people can double-check before applying.

export const PHOTO_SPECS = [
    {
        id: 'in-passport',
        label: 'India passport (Passport Seva)',
        widthMm: 35,
        heightMm: 45,
        headMinMm: 36,
        headMaxMm: 38,
        crownMm: 3,
        eyeFromBottomMm: null,
        background: 'Plain white',
        digital: { width: 630, height: 810, maxKB: 250, minKB: null },
        notes: 'Passport Seva now asks for ICAO-compliant photos: a close-up of the head and top of the shoulders with the face filling about 80–85% of the photo. Upload a 630 × 810 px JPEG (keep it under 250 KB); prints are 35 × 45 mm.',
        source: 'https://www.passportindia.gov.in/',
    },
    {
        id: 'in-visa',
        label: 'India visa / e-Visa',
        widthMm: 51,
        heightMm: 51,
        headMinMm: 25,
        headMaxMm: 35,
        crownMm: 4.5,
        eyeFromBottomMm: [30, 35],
        background: 'Plain white or light',
        digital: { width: 600, height: 600, maxKB: 300, minKB: 10 },
        notes: 'Square JPEG between 350 × 350 and 1000 × 1000 px, 10–300 KB for the regular visa form (the e-Visa accepts up to 1 MB). Prints are 2 × 2 in (51 × 51 mm).',
        source: 'https://indianvisaonline.gov.in/visa/VSS_IMAGE.pdf',
    },
    {
        id: 'oci',
        label: 'OCI card',
        widthMm: 51,
        heightMm: 51,
        headMinMm: 25,
        headMaxMm: 35,
        crownMm: 5,
        eyeFromBottomMm: [28, 35],
        background: 'Plain white or light',
        digital: { width: 600, height: 600, maxKB: 200, minKB: null },
        notes: 'Online OCI uploads are square JPEGs of up to 200 KB. Prints are 2 × 2 in (51 × 51 mm).',
        source: 'https://ociservices.gov.in/',
    },
    {
        id: 'us',
        label: 'US passport / visa (2 × 2 in)',
        widthMm: 50.8,
        heightMm: 50.8,
        headMinMm: 25,
        headMaxMm: 35,
        crownMm: 5,
        eyeFromBottomMm: [28, 35],
        background: 'White or off-white',
        digital: { width: 600, height: 600, maxKB: null, minKB: null },
        notes: 'Digital photos are square, 600 × 600 to 1200 × 1200 px. The State Department asks that photos are not retouched or filtered; this tool only crops and resizes.',
        source: 'https://travel.state.gov/content/travel/en/passports/how-apply/photos.html',
    },
    {
        id: 'uk',
        label: 'UK passport (printed)',
        widthMm: 35,
        heightMm: 45,
        headMinMm: 29,
        headMaxMm: 34,
        crownMm: 4,
        eyeFromBottomMm: null,
        background: 'Plain light grey or cream',
        digital: null,
        notes: 'For printed photos only. For online applications GOV.UK wants your uncropped photo (at least 600 × 750 px, 50 KB–10 MB) and crops it itself, so upload the original there.',
        source: 'https://www.gov.uk/photos-for-passports',
    },
    {
        id: 'schengen',
        label: 'Schengen visa',
        widthMm: 35,
        heightMm: 45,
        headMinMm: 32,
        headMaxMm: 36,
        crownMm: 3.5,
        eyeFromBottomMm: null,
        background: 'Plain light (white or light grey)',
        digital: { width: 413, height: 531, maxKB: null, minKB: null },
        notes: 'Printed 35 × 45 mm with the face (chin to crown) 32–36 mm tall. Digital upload rules vary by country and visa centre.',
        source: 'https://www.auswaertiges-amt.de/en/visa-service',
    },
    {
        id: 'custom',
        label: 'Custom size',
        widthMm: 35,
        heightMm: 45,
        headMinMm: 30,
        headMaxMm: 36,
        crownMm: 4,
        eyeFromBottomMm: null,
        background: 'As required',
        digital: { width: 413, height: 531, maxKB: null, minKB: null },
        notes: 'Set the print size, head height and file limits your form asks for.',
        source: null,
        custom: true,
    },
];

export const PRINT_SHEETS = [
    { id: '4x6', label: '4 × 6 in photo print (10 × 15 cm)', widthMm: 152.4, heightMm: 101.6 },
    { id: 'a4', label: 'A4 paper (home printer)', widthMm: 210, heightMm: 297 },
];

/**
 * Best grid of photos on a sheet, trying both sheet orientations.
 * margin and gap are in mm. Returns { cols, rows, count, sheetW, sheetH, x0, y0, gap }.
 */
export function layoutSheet(sheet, photoW, photoH, { margin = 3, gap = 2 } = {}) {
    let best = null;
    for (const [sw, sh] of [[sheet.widthMm, sheet.heightMm], [sheet.heightMm, sheet.widthMm]]) {
        const cols = Math.floor((sw - 2 * margin + gap) / (photoW + gap));
        const rows = Math.floor((sh - 2 * margin + gap) / (photoH + gap));
        const count = Math.max(0, cols) * Math.max(0, rows);
        if (!best || count > best.count) {
            const usedW = cols * photoW + (cols - 1) * gap;
            const usedH = rows * photoH + (rows - 1) * gap;
            best = { cols, rows, count, sheetW: sw, sheetH: sh, x0: (sw - usedW) / 2, y0: (sh - usedH) / 2, gap };
        }
    }
    return best;
}
