// Shared helpers for Topbar Pulse: processes, files, formatting, widgets
// and launching apps, browsers and terminals.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');

export const decoder = new TextDecoder();

// Set TOPBAR_PULSE_DEBUG=1 in the environment to log what the indicators fetch.
const DEBUG = !!GLib.getenv('TOPBAR_PULSE_DEBUG');
export function debug(...args) {
    if (DEBUG)
        console.log('topbar-pulse:', ...args);
}
export const encoder = new TextEncoder();

// ------------------------------------------------------------- processes

export function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export async function run(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    return {ok: proc.get_successful(), out: stdout ?? '', err: stderr ?? ''};
}

export function notifyError(title, body) {
    Main.notifyError(title, body);
}

export function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        return true;
    } catch (e) {
        notifyError('Topbar Pulse', _('Could not start %s: %s').format(argv[0], e.message));
        return false;
    }
}

// GNOME Shell does not see PATH additions made in ~/.bashrc (mise, nvm, npm,
// bun, cargo …), so CLIs installed there are looked up explicitly.
const EXTRA_BIN_DIRS = [
    '.local/bin',
    '.local/share/mise/shims',
    '.npm-global/bin',
    '.bun/bin',
    '.volta/bin',
    '.cargo/bin',
    '.deno/bin',
    'go/bin',
    '.local/share/pnpm',
];

export function findProgram(name) {
    const inPath = GLib.find_program_in_path(name);
    if (inPath)
        return inPath;
    const home = GLib.get_home_dir();
    for (const dir of EXTRA_BIN_DIRS) {
        const p = GLib.build_filenamev([home, dir, name]);
        if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
            return p;
    }
    for (const dir of ['/usr/local/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin']) {
        const p = GLib.build_filenamev([dir, name]);
        if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE))
            return p;
    }
    return null;
}

// ------------------------------------------------------------------ files

// All file access is asynchronous so GNOME Shell never waits on a file.
// A cancelled read rethrows (so callers stop touching destroyed widgets);
// any other failure returns null.

export async function read(path, cancellable = null) {
    if (!path)
        return null;
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

export async function readNum(path, cancellable = null) {
    const t = await read(path, cancellable);
    if (t === null)
        return null;
    const n = Number(t.trim());
    return Number.isFinite(n) ? n : null;
}

export async function readJson(path, cancellable = null) {
    const t = await read(path, cancellable);
    if (t === null)
        return null;
    try {
        return JSON.parse(t);
    } catch {
        return null;
    }
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

export async function listDir(path, cancellable = null) {
    const out = [];
    try {
        const en = await Gio.File.new_for_path(path).enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
        for (;;) {
            const infos = await en.next_files_async(200, GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0)
                break;
            for (const info of infos)
                out.push(info.get_name());
        }
        await en.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (isCancelled(e))
            throw e;
    }
    return out;
}

export function natural(a, b) {
    return a.localeCompare(b, undefined, {numeric: true});
}

// ------------------------------------------------------------- formatting

export function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

// Locale-aware number with a fixed number of decimals ("1,5" in Swedish).
export function decimal(n, digits = 1) {
    return Number(n).toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits});
}

export function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1e12)
        return `${decimal(n / 1e12)} TB`;
    if (n >= 1e9)
        return `${decimal(n / 1e9)} GB`;
    if (n >= 1e6)
        return `${decimal(n / 1e6)} MB`;
    return `${Math.round(n / 1e3)} kB`;
}

export function fmtRate(bps) {
    if (bps >= 1e6)
        return `${decimal(bps / 1e6)} MB/s`;
    if (bps >= 1e3)
        return `${Math.round(bps / 1e3)} kB/s`;
    return `${Math.round(bps)} B/s`;
}

export function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e9)
        return `${decimal(n / 1e9)} G`;
    if (n >= 1e6)
        return `${decimal(n / 1e6)} M`;
    if (n >= 1e3)
        return `${Math.round(n / 1e3)} k`;
    return String(Math.round(n));
}

export function unixFromIso(iso) {
    if (!iso)
        return null;
    if (typeof iso === 'number')
        return iso > 1e12 ? Math.floor(iso / 1000) : iso;
    const dt = GLib.DateTime.new_from_iso8601(String(iso), null);
    return dt ? dt.to_unix() : null;
}

// "resets in 4 d 3 h" / "resets in 2 h 10 min" / "resets in 5 min"
export function fmtResetIn(when) {
    const t = unixFromIso(when);
    if (t === null)
        return '';
    const s = Math.max(0, t - Math.floor(Date.now() / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    let span;
    if (d > 0)
        span = _('%d d %d h').format(d, h);
    else if (h > 0)
        span = _('%d h %d min').format(h, m);
    else
        span = _('%d min').format(m);
    return _('resets in %s').format(span);
}

// ---------------------------------------------------------------- widgets

export function label(text, style_class = null, extra = {}) {
    return new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER, ...extra});
}

export function vbox(style_class, extra = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class, ...extra});
}

export function hbox(style_class, extra = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, style_class, ...extra});
}

// A rounded meter with a title before it and a text after it.
export class Meter {
    constructor(title, width = 200) {
        this._width = width;
        this.actor = hbox('tp-meter-row');
        this.title = label(title, 'tp-meter-title');
        this.actor.add_child(this.title);
        this._track = hbox('tp-track', {y_align: Clutter.ActorAlign.CENTER, style: `width: ${width}px;`});
        this._fill = new St.Widget({style_class: 'tp-fill'});
        this._track.add_child(this._fill);
        this.actor.add_child(this._track);
        this._pct = label('', 'tp-meter-pct');
        this.actor.add_child(this._pct);
        this._text = label('', 'tp-dim tp-small');
        this.actor.add_child(this._text);
    }

    set(frac, pctText, text = '') {
        const f = clamp01(frac);
        this._fill.set_style(`width: ${Math.max(f > 0 ? 3 : 0, Math.round(f * this._width))}px;`);
        this._fill.style_class = `tp-fill${f >= 0.9 ? ' alarm' : f >= 0.7 ? ' warn' : ''}`;
        this._pct.text = pctText ?? '';
        this._pct.visible = !!pctText;
        this._text.text = text;
    }
}

export function kvRow(key, value) {
    const row = hbox('tp-kv');
    row.add_child(label(key, 'tp-kv-key'));
    const v = label(value, 'tp-kv-val');
    v.clutter_text.line_wrap = true;
    row.add_child(v);
    return row;
}

// --------------------------------------------------------------- launching

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        return true;
    } catch (e) {
        notifyError('Topbar Pulse', _('Could not open %s: %s').format(uri, e.message));
        return false;
    }
}

// Chromium-family browsers can open a site as its own app window (--app).
const APP_BROWSERS = [
    'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'brave',
    'microsoft-edge-stable', 'microsoft-edge', 'vivaldi-stable', 'vivaldi', 'helium-browser', 'thorium-browser',
];

export function appBrowser() {
    for (const b of APP_BROWSERS) {
        const p = findProgram(b);
        if (p)
            return p;
    }
    return null;
}

export function openAppWindow(url) {
    const browser = appBrowser();
    if (browser && spawn([browser, `--app=${url}`]))
        return true;
    return openUri(url);
}

// Terminals and how each one takes a command to run.
const TERMINALS = [
    ['xdg-terminal-exec', []],
    ['kgx', ['--']],
    ['ptyxis', ['--']],
    ['gnome-terminal', ['--']],
    ['konsole', ['-e']],
    ['kitty', []],
    ['alacritty', ['-e']],
    ['ghostty', ['-e']],
    ['wezterm', ['start', '--']],
    ['foot', []],
    ['tilix', ['-e']],
    ['xfce4-terminal', ['-x']],
    ['xterm', ['-e']],
];

export function terminalCommand(argv) {
    for (const [name, prefix] of TERMINALS) {
        const p = findProgram(name);
        if (p)
            return [p, ...prefix, ...argv];
    }
    return null;
}

export function openInTerminal(argv) {
    const cmd = terminalCommand(argv);
    if (!cmd) {
        notifyError('Topbar Pulse', _('No terminal emulator was found.'));
        return false;
    }
    return spawn(cmd);
}

// ------------------------------------------------------------------ http

export async function readAll(stream, cancellable, limit = 4_000_000) {
    const chunks = [];
    let size = 0;
    for (;;) {
        const bytes = await stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable);
        const n = bytes.get_size();
        if (n === 0)
            break;
        chunks.push(bytes.toArray());
        size += n;
        if (size > limit)
            break;
    }
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}
