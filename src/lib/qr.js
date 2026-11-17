// Minimal QR code encoder (ISO/IEC 18004): byte mode, error correction
// level M, versions 1–20, automatic mask choice. Enough for Wi-Fi sharing
// strings. No dependencies, works in both GNOME Shell and plain gjs.
//
// encodeQr(text) -> array of strings of '0'/'1' (no quiet zone).

// [ecc codewords per block, group1 blocks, group1 data cw, group2 blocks, group2 data cw]
const EC_M = [
    null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42], [28, 7, 45, 3, 46],
    [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
];

const ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90],
];

// ---- GF(256) arithmetic, polynomial 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100)
            x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++)
        EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        const next = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
            next[j] ^= poly[j];
            next[j + 1] ^= gmul(poly[j], EXP[i]);
        }
        poly = next;
    }
    return poly;
}

function rsRemainder(data, degree) {
    const gen = rsGenerator(degree);
    const res = new Array(degree).fill(0);
    for (const b of data) {
        const factor = b ^ res.shift();
        res.push(0);
        for (let i = 0; i < degree; i++)
            res[i] ^= gmul(gen[i + 1], factor);
    }
    return res;
}

// ---- data encoding
function dataCapacity(v) {
    const [, b1, d1, b2, d2] = EC_M[v];
    return b1 * d1 + b2 * d2;
}

function encodeData(bytes) {
    for (let v = 1; v < EC_M.length; v++) {
        const capBits = dataCapacity(v) * 8;
        const countBits = v < 10 ? 8 : 16;
        if (4 + countBits + bytes.length * 8 > capBits)
            continue;
        const bits = [];
        const put = (val, n) => {
            for (let i = n - 1; i >= 0; i--)
                bits.push((val >>> i) & 1);
        };
        put(0b0100, 4);
        put(bytes.length, countBits);
        for (const b of bytes)
            put(b, 8);
        put(0, Math.min(4, capBits - bits.length));
        while (bits.length % 8)
            bits.push(0);
        const cw = [];
        for (let i = 0; i < bits.length; i += 8)
            cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
        for (let pad = 0; cw.length < capBits / 8; pad++)
            cw.push(pad % 2 ? 0x11 : 0xec);
        return {version: v, codewords: cw};
    }
    throw new Error('Text too long for a QR code');
}

function interleave(version, data) {
    const [ecLen, b1, d1, b2, d2] = EC_M[version];
    const blocks = [];
    let off = 0;
    for (let i = 0; i < b1 + b2; i++) {
        const len = i < b1 ? d1 : d2;
        const d = data.slice(off, off + len);
        off += len;
        blocks.push({d, e: rsRemainder(d, ecLen)});
    }
    const out = [];
    const maxD = Math.max(d1, d2);
    for (let i = 0; i < maxD; i++) {
        for (const b of blocks) {
            if (i < b.d.length)
                out.push(b.d[i]);
        }
    }
    for (let i = 0; i < ecLen; i++) {
        for (const b of blocks)
            out.push(b.e[i]);
    }
    return out;
}

// ---- matrix
function bchFormat(data) {
    let d = data << 10;
    for (let i = 14; i >= 10; i--) {
        if ((d >>> i) & 1)
            d ^= 0x537 << (i - 10);
    }
    return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(v) {
    let d = v << 12;
    for (let i = 17; i >= 12; i--) {
        if ((d >>> i) & 1)
            d ^= 0x1f25 << (i - 12);
    }
    return (v << 12) | d;
}

const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    r => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function buildBase(version) {
    const n = version * 4 + 17;
    const m = Array.from({length: n}, () => new Array(n).fill(null));
    const fn = Array.from({length: n}, () => new Array(n).fill(false));
    const set = (r, c, v) => {
        m[r][c] = v;
        fn[r][c] = true;
    };
    const finder = (r0, c0) => {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const rr = r0 + r, cc = c0 + c;
                if (rr < 0 || cc < 0 || rr >= n || cc >= n)
                    continue;
                const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
                    (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
                set(rr, cc, inRing ? 1 : 0);
            }
        }
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) {
        set(6, i, i % 2 === 0 ? 1 : 0);
        set(i, 6, i % 2 === 0 ? 1 : 0);
    }
    const al = ALIGN[version];
    const first = al[0], last = al[al.length - 1];
    for (const r of al) {
        for (const c of al) {
            // only the three positions under the finder patterns are skipped
            if ((r === first && c === first) || (r === first && c === last) || (r === last && c === first))
                continue;
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++)
                    set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
            }
        }
    }
    set(n - 8, 8, 1); // dark module
    // reserve format areas
    for (let i = 0; i < 9; i++) {
        if (!fn[8][i])
            set(8, i, 0);
        if (!fn[i][8])
            set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
        if (!fn[8][n - 1 - i])
            set(8, n - 1 - i, 0);
        if (!fn[n - 1 - i][8])
            set(n - 1 - i, 8, 0);
    }
    if (version >= 7) {
        const bits = bchVersion(version);
        for (let i = 0; i < 18; i++) {
            const bit = (bits >>> i) & 1;
            set(Math.floor(i / 3), n - 11 + (i % 3), bit);
            set(n - 11 + (i % 3), Math.floor(i / 3), bit);
        }
    }
    return {n, m, fn};
}

function placeData(base, codewords) {
    const {n, m, fn} = base;
    const bits = [];
    for (const cw of codewords) {
        for (let i = 7; i >= 0; i--)
            bits.push((cw >>> i) & 1);
    }
    let k = 0;
    let upward = true;
    for (let col = n - 1; col > 0; col -= 2) {
        if (col === 6)
            col--;
        for (let i = 0; i < n; i++) {
            const r = upward ? n - 1 - i : i;
            for (let dc = 0; dc < 2; dc++) {
                const c = col - dc;
                if (fn[r][c])
                    continue;
                m[r][c] = k < bits.length ? bits[k] : 0;
                k++;
            }
        }
        upward = !upward;
    }
}

function applyMask(base, maskIdx) {
    const {n, m, fn} = base;
    const out = m.map(row => row.slice());
    const f = MASKS[maskIdx];
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!fn[r][c] && f(r, c))
                out[r][c] ^= 1;
        }
    }
    // format info: EC level M = 00
    const bits = bchFormat((0b00 << 3) | maskIdx);
    const bit = i => (bits >>> i) & 1;
    // first copy around the top-left finder
    for (let i = 0; i <= 5; i++)
        out[i][8] = bit(i);
    out[7][8] = bit(6);
    out[8][8] = bit(7);
    out[8][7] = bit(8);
    for (let i = 9; i < 15; i++)
        out[8][14 - i] = bit(i);
    // second copy split between the other two finders
    for (let i = 0; i < 8; i++)
        out[8][n - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++)
        out[n - 15 + i][8] = bit(i);
    out[n - 8][8] = 1;
    return out;
}

function penalty(m) {
    const n = m.length;
    let p = 0;
    const lineRuns = get => {
        for (let a = 0; a < n; a++) {
            let run = 1;
            for (let b = 1; b < n; b++) {
                if (get(a, b) === get(a, b - 1)) {
                    run++;
                } else {
                    if (run >= 5)
                        p += run - 2;
                    run = 1;
                }
            }
            if (run >= 5)
                p += run - 2;
        }
    };
    lineRuns((a, b) => m[a][b]);
    lineRuns((a, b) => m[b][a]);
    for (let r = 0; r < n - 1; r++) {
        for (let c = 0; c < n - 1; c++) {
            const v = m[r][c];
            if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1])
                p += 3;
        }
    }
    const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let a = 0; a < n; a++) {
        for (let b = 0; b <= n - 11; b++) {
            let h1 = true, h2 = true, v1 = true, v2 = true;
            for (let k = 0; k < 11; k++) {
                if (m[a][b + k] !== pat1[k])
                    h1 = false;
                if (m[a][b + k] !== pat2[k])
                    h2 = false;
                if (m[b + k][a] !== pat1[k])
                    v1 = false;
                if (m[b + k][a] !== pat2[k])
                    v2 = false;
            }
            p += 40 * (h1 + h2 + v1 + v2);
        }
    }
    let dark = 0;
    for (const row of m) {
        for (const v of row)
            dark += v;
    }
    p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return p;
}

export function encodeQr(text) {
    const bytes = new TextEncoder().encode(text);
    const {version, codewords} = encodeData(bytes);
    const all = interleave(version, codewords);
    const base = buildBase(version);
    placeData(base, all);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        const candidate = applyMask(base, mask);
        const score = penalty(candidate);
        if (score < bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best.map(row => row.join(''));
}

// Wi-Fi network string as phones expect it.
export function wifiQrText(ssid, password, security) {
    const esc = s => String(s).replace(/([\\;,:"])/g, '\\$1');
    const t = security === 'nopass' ? 'nopass' : security;
    let out = `WIFI:T:${t};S:${esc(ssid)};`;
    if (t !== 'nopass')
        out += `P:${esc(password)};`;
    return `${out};`;
}
