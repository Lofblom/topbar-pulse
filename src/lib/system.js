// System monitor: CPU, GPU, memory, storage, network throughput, sensors,
// battery and the busiest processes. Reads /proc and /sys directly; NVIDIA
// through nvidia-smi when present.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    isCancelled, read, readNum, exists, listDir, natural, decimal, fmtBytes, fmtRate, clamp01,
    label, vbox, hbox, Meter, kvRow, findProgram, openInTerminal, notifyError,
} from './util.js';

const SAMPLE_SEC = 2;
const HISTORY = 60;          // two minutes of history in the graphs
const TOP_PROCS = 6;
const CLK_TCK = 100;
const PAGE_SIZE = 4096;

const COLORS = {
    cpu: [0.38, 0.63, 0.92],
    gpu: [0.75, 0.38, 0.80],
    ram: [0.34, 0.78, 0.52],
};
const CSS_COLORS = {cpu: '#78aeed', gpu: '#dc8add', ram: '#8ff0a4'};

function fmtGB(kb) {
    return decimal(kb / 1024 / 1024);
}

// Area graph of the history (0–100).
class Graph {
    constructor(color) {
        this.data = [];
        this.color = color;
        this.actor = new St.DrawingArea({style_class: 'tp-graph', x_expand: true});
        this._repaintId = this.actor.connect('repaint', a => this._paint(a));
    }

    destroy() {
        if (this._repaintId)
            this.actor.disconnect(this._repaintId);
        this._repaintId = 0;
        this.actor.destroy();
        this.actor = null;
    }

    push(v) {
        this.data.push(v);
        if (this.data.length > HISTORY)
            this.data.shift();
        if (this.actor?.mapped)
            this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [r, g, b] = this.color;
        const fg = area.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.06);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        const n = this.data.length;
        if (n > 1) {
            const step = w / (HISTORY - 1);
            const x0 = w - (n - 1) * step;
            const y = v => h - clamp01(v / 100) * (h - 2) - 1;
            cr.moveTo(x0, h);
            this.data.forEach((v, i) => cr.lineTo(x0 + i * step, y(v)));
            cr.lineTo(w, h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.30);
            cr.fillPreserve();
            cr.newPath();
            this.data.forEach((v, i) => (i === 0 ? cr.moveTo : cr.lineTo).call(cr, x0 + i * step, y(v)));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            cr.stroke();
        }
        cr.$dispose();
    }
}

// One bar per CPU thread.
class CoreBars {
    constructor() {
        this.values = [];
        this.actor = new St.DrawingArea({style_class: 'tp-cores', x_expand: true});
        this._repaintId = this.actor.connect('repaint', a => this._paint(a));
    }

    destroy() {
        if (this._repaintId)
            this.actor.disconnect(this._repaintId);
        this._repaintId = 0;
        this.actor.destroy();
        this.actor = null;
    }

    set(values) {
        this.values = values;
        if (this.actor?.mapped)
            this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const n = this.values.length;
        if (n > 0) {
            const gap = 3;
            const bw = (w - gap * (n - 1)) / n;
            const [r, g, b] = COLORS.cpu;
            const fg = area.get_theme_node().get_foreground_color();
            this.values.forEach((v, i) => {
                const x = i * (bw + gap);
                cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.09);
                cr.rectangle(x, 0, bw, h);
                cr.fill();
                const bh = clamp01(v / 100) * h;
                cr.setSourceRGBA(r, g, b, 0.9);
                cr.rectangle(x, h - bh, bw, bh);
                cr.fill();
            });
        }
        cr.$dispose();
    }
}

// ------------------------------------------------------ hardware discovery

async function discoverHardware(c) {
    const hw = {
        cpuModel: '',
        cpuTemp: null,
        nvmeTemp: null,
        fans: [],
        freqPaths: [],
        batteries: [],
        gpu: null,
    };

    const cpuinfo = await read('/proc/cpuinfo', c) ?? '';
    const m = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
    if (m)
        hw.cpuModel = m[1].replace(/\((R|TM)\)/g, '').replace(/\s+/g, ' ').trim();

    for (const cpu of (await listDir('/sys/devices/system/cpu', c)).filter(n => /^cpu\d+$/.test(n))) {
        const p = `/sys/devices/system/cpu/${cpu}/cpufreq/scaling_cur_freq`;
        if (exists(p))
            hw.freqPaths.push(p);
    }

    for (const h of (await listDir('/sys/class/hwmon', c)).sort(natural)) {
        const base = `/sys/class/hwmon/${h}`;
        const name = (await read(`${base}/name`, c) ?? '').trim();
        if (!hw.cpuTemp && ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'].includes(name))
            hw.cpuTemp = `${base}/temp1_input`;
        if (!hw.nvmeTemp && name === 'nvme')
            hw.nvmeTemp = `${base}/temp1_input`;
        const fans = (await listDir(base, c)).filter(f => /^fan\d+_input$/.test(f)).sort(natural);
        if (!hw.fans.length)
            hw.fans = fans.map(f => `${base}/${f}`);
    }

    for (const ps of (await listDir('/sys/class/power_supply', c)).sort(natural)) {
        const base = `/sys/class/power_supply/${ps}`;
        if ((await read(`${base}/type`, c) ?? '').trim() === 'Battery')
            hw.batteries.push(base);
    }

    for (const card of (await listDir('/sys/class/drm', c)).filter(n => /^card\d+$/.test(n)).sort(natural)) {
        const base = `/sys/class/drm/${card}`;
        let driver = '';
        try {
            driver = GLib.path_get_basename(GLib.file_read_link(`${base}/device/driver`));
        } catch {}
        if (exists(`${base}/device/gpu_busy_percent`)) {
            const hwmon = (await listDir(`${base}/device/hwmon`, c))[0];
            hw.gpu = {
                kind: 'busy', driver,
                busy: `${base}/device/gpu_busy_percent`,
                temp: hwmon ? `${base}/device/hwmon/${hwmon}/temp1_input` : null,
                vramUsed: `${base}/device/mem_info_vram_used`,
                vramTotal: `${base}/device/mem_info_vram_total`,
            };
        } else if (exists(`${base}/gt/gt0/rc6_residency_ms`)) {
            hw.gpu = {
                kind: 'idle', driver,
                idle: `${base}/gt/gt0/rc6_residency_ms`,
                freq: `${base}/gt_act_freq_mhz`,
                maxFreq: await readNum(`${base}/gt_max_freq_mhz`, c),
            };
        } else if (exists(`${base}/device/tile0/gt0/gtidle/idle_residency_ms`)) {
            const gt = `${base}/device/tile0/gt0`;
            hw.gpu = {
                kind: 'idle', driver,
                idle: `${gt}/gtidle/idle_residency_ms`,
                freq: `${gt}/freq0/act_freq`,
                maxFreq: await readNum(`${gt}/freq0/max_freq`, c),
            };
        } else if (driver === 'nvidia') {
            hw.gpu = {kind: 'nvidia', driver};
        }
        if (hw.gpu)
            break;
    }
    return hw;
}

// --------------------------------------------------------------- indicator

export const SystemIndicator = GObject.registerClass(
class SystemIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, _('System monitor'), false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._barValues = {};
        this.add_style_class_name('tp-compact');
        this._cancellable = new Gio.Cancellable();
        this._hw = null;
        this._prev = null;
        this._prevProcs = null;
        this._nvidia = null;
        this._gpuName = '';

        const box = hbox('panel-status-menu-box tp-tight');
        this._iconActor = new St.Icon({icon_name: 'utilities-system-monitor-symbolic', style_class: 'system-status-icon'});
        box.add_child(this._iconActor);
        this._miniBars = new St.DrawingArea({style_class: 'tp-minibars', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._miniBarsId = this._miniBars.connect('repaint', a => this._paintMiniBars(a));
        box.add_child(this._miniBars);
        this._barLabels = {};
        for (const key of ['cpu', 'gpu', 'ram', 'temp']) {
            const l = label('', 'tp-bar-label', {visible: false});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._barLabels[key] = l;
            box.add_child(l);
        }
        this.add_child(box);
        this._settingsId = this._settings.connect('changed', () => this._updateBar());
        this._drmFds = [];
        this._drmPrev = null;
        this._start().catch(e => {
            if (!isCancelled(e))
                console.warn(`Topbar Pulse: system monitor: ${e.message}`);
        });
    }

    async _start() {
        this._hw = await discoverHardware(this._cancellable);
        this._buildMenu();
        this._findGpuName();
        this._scanDrmClients();
        this._drmTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._scanDrmClients();
            return GLib.SOURCE_CONTINUE;
        });
        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._prevProcs = null;
                this._sample();
            }
        });
        this._sample();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAMPLE_SEC, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _section(title, subtitle = '') {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox('tp-sec', {x_expand: true});
        const head = hbox('tp-head');
        head.add_child(label(title, 'tp-sec-title'));
        const sub = label(subtitle, 'tp-dim');
        head.add_child(sub);
        box.add_child(head);
        item.add_child(box);
        this.menu.addMenuItem(item);
        return {item, box, sub};
    }

    _valueRow(box) {
        const row = hbox('tp-head');
        const big = label('–', 'tp-big');
        const detail = label('', 'tp-dim');
        row.add_child(big);
        row.add_child(detail);
        box.add_child(row);
        return {big, detail};
    }

    _buildMenu() {
        // CPU
        const cpu = this._section(_('Processor'), this._hw.cpuModel);
        this._cpu = this._valueRow(cpu.box);
        this._cpuGraph = new Graph(COLORS.cpu);
        cpu.box.add_child(this._cpuGraph.actor);
        this._cores = new CoreBars();
        cpu.box.add_child(this._cores.actor);

        // GPU
        if (this._hw.gpu) {
            const gpu = this._section(_('Graphics'), this._hw.gpu.driver);
            this._gpuSub = gpu.sub;
            this._gpu = this._valueRow(gpu.box);
            this._gpuGraph = new Graph(COLORS.gpu);
            gpu.box.add_child(this._gpuGraph.actor);
        }

        // Memory
        const mem = this._section(_('Memory'));
        this._ram = this._valueRow(mem.box);
        this._ramGraph = new Graph(COLORS.ram);
        mem.box.add_child(this._ramGraph.actor);
        this._swapMeter = new Meter(_('Swap'));
        mem.box.add_child(this._swapMeter.actor);

        // Storage & network
        const io = this._section(_('Storage & network'));
        this._diskMeter = new Meter(_('Disk /'));
        io.box.add_child(this._diskMeter.actor);
        this._diskRate = label('', 'tp-kv-val');
        io.box.add_child(this._diskRate);
        this._netRate = label('', 'tp-kv-val');
        io.box.add_child(this._netRate);

        // Sensors & power
        if (this._hw.fans.length || this._hw.batteries.length || this._hw.nvmeTemp) {
            const sens = this._section(_('Sensors & power'));
            this._sensors = vbox(null);
            sens.box.add_child(this._sensors);
        }

        // Processes
        const procs = this._section(_('Busiest processes'), _('share of the whole CPU'));
        this._procBox = vbox(null);
        procs.box.add_child(this._procBox);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Topbar Pulse settings…'), () => this._ext.openPreferences());
        this._monitorApp = findProgram('gnome-system-monitor') ? ['gnome-system-monitor']
            : findProgram('btop') ? ['terminal', 'btop'] : findProgram('htop') ? ['terminal', 'htop'] : null;
        if (this._monitorApp) {
            this.menu.addAction(_('Open system monitor'), () => {
                const [first, ...rest] = this._monitorApp;
                if (first === 'terminal')
                    openInTerminal([findProgram(rest[0])]);
                else
                    GLib.spawn_command_line_async(first);
            });
        }
    }

    // The panel text as configured: labels, colour-coded numbers or bars.
    _updateBar() {
        const st = this._settings;
        const style = st.get_string('system-style');
        const show = {
            cpu: st.get_boolean('system-show-cpu'),
            gpu: st.get_boolean('system-show-gpu') && !!this._hw?.gpu,
            ram: st.get_boolean('system-show-ram'),
            temp: st.get_boolean('system-show-temp'),
        };
        const v = this._barValues;
        const prefix = {cpu: 'CPU ', gpu: 'GPU ', ram: 'RAM '};
        let any = false;
        for (const key of ['cpu', 'gpu', 'ram', 'temp']) {
            const l = this._barLabels[key];
            const has = v[key] !== undefined && show[key];
            let visible = has;
            if (key !== 'temp' && style === 'bars')
                visible = false;
            if (has) {
                any = true;
                l.text = key === 'temp' ? `${Math.round(v.temp)}°`
                    : `${style === 'labels' ? prefix[key] : ''}${Math.round(v[key])}%`;
                l.set_style(style === 'compact' && key !== 'temp' ? `color: ${CSS_COLORS[key]};` : null);
            }
            l.visible = visible;
        }
        this._barKeys = ['cpu', 'gpu', 'ram'].filter(k => show[k] && v[k] !== undefined);
        this._miniBars.visible = style === 'bars' && this._barKeys.length > 0;
        if (this._miniBars.visible) {
            this._miniBars.set_style(`width: ${this._barKeys.length * 7 - 2}px;`);
            this._miniBars.queue_repaint();
        }
        this._iconActor.visible = st.get_boolean('system-show-icon') || !any;
    }

    _paintMiniBars(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const keys = this._barKeys ?? [];
        const bw = (w - 2 * (keys.length - 1)) / Math.max(1, keys.length);
        keys.forEach((k, i) => {
            const x = i * (bw + 2);
            cr.setSourceRGBA(1, 1, 1, 0.22);
            cr.rectangle(x, 0, bw, h);
            cr.fill();
            const [r, g, b] = COLORS[k];
            const bh = Math.max(1, clamp01((this._barValues[k] ?? 0) / 100) * h);
            cr.setSourceRGBA(r, g, b, 1);
            cr.rectangle(x, h - bh, bw, bh);
            cr.fill();
        });
        cr.$dispose();
    }

    async _findGpuName() {
        try {
            const proc = Gio.Subprocess.new(['lspci'], Gio.SubprocessFlags.STDOUT_PIPE);
            const [out] = await proc.communicate_utf8_async(null, this._cancellable);
            const line = (out ?? '').split('\n').find(l => / (VGA compatible|3D|Display) controller/.test(l));
            if (line && this._gpuSub) {
                this._gpuName = line.slice(line.indexOf(': ', 8) + 2)
                    .replace(/ Corporation| Technologies| \(rev \w+\)/g, '')
                    .replace(/\[AMD\/ATI\] /, '').trim();
                this._gpuSub.text = `${this._gpuName} · ${this._hw.gpu.driver}`;
            }
        } catch {}
    }

    async _pollNvidia() {
        if (this._nvidiaBusy)
            return;
        this._nvidiaBusy = true;
        try {
            const proc = Gio.Subprocess.new(['nvidia-smi',
                '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.gr',
                '--format=csv,noheader,nounits'], Gio.SubprocessFlags.STDOUT_PIPE);
            const [out] = await proc.communicate_utf8_async(null, this._cancellable);
            const [util, temp, used, total, clock] = (out ?? '').split('\n')[0].split(',').map(s => Number(s.trim()));
            this._nvidia = {util, temp, used, total, clock};
        } catch {
            this._nvidia = null;
        }
        this._nvidiaBusy = false;
    }

    _sample() {
        if (this._sampling)
            return;
        this._sampling = true;
        this._sampleAsync().catch(e => {
            if (!isCancelled(e))
                console.warn(`Topbar Pulse: system sample: ${e.message}`);
        }).finally(() => {
            this._sampling = false;
        });
    }

    async _sampleAsync() {
        const c = this._cancellable;
        const now = GLib.get_monotonic_time() / 1e6;
        const [stat, loadavg, meminfo, diskstats, netdev] = await Promise.all(
            ['/proc/stat', '/proc/loadavg', '/proc/meminfo', '/proc/diskstats', '/proc/net/dev'].map(p => read(p, c)));
        const cur = {t: now, cpu: {}, gpuIdle: null, diskR: 0, diskW: 0, netRx: 0, netTx: 0};
        const prev = this._prev;
        const dt = prev ? now - prev.t : 0;

        // --- CPU
        const usage = {};
        for (const l of (stat ?? '').split('\n')) {
            if (!l.startsWith('cpu'))
                continue;
            const p = l.trim().split(/\s+/);
            const n = p.slice(1, 9).map(Number);
            const idle = n[3] + n[4];
            const total = n.reduce((a, b) => a + b, 0);
            cur.cpu[p[0]] = {idle, total};
            const q = prev?.cpu[p[0]];
            if (q && total > q.total)
                usage[p[0]] = 100 * (1 - (idle - q.idle) / (total - q.total));
        }
        const cpuPct = usage.cpu;
        const cores = Object.keys(usage).filter(k => k !== 'cpu').sort(natural).map(k => usage[k]);
        const freqs = (await Promise.all(this._hw.freqPaths.map(p => readNum(p, c)))).filter(v => v !== null);
        const freqGHz = freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length / 1e6 : null;
        const cpuTemp = await readNum(this._hw.cpuTemp, c);
        const load = (loadavg ?? '').split(' ').slice(0, 3).map(Number);

        // --- GPU
        const gpu = this._hw.gpu;
        let gpuPct = null, gpuDetail = '';
        if (gpu?.kind === 'busy') {
            gpuPct = await readNum(gpu.busy, c);
            const parts = [];
            const t = await readNum(gpu.temp, c);
            if (t !== null)
                parts.push(`${Math.round(t / 1000)} °C`);
            const [vu, vt] = await Promise.all([readNum(gpu.vramUsed, c), readNum(gpu.vramTotal, c)]);
            if (vu !== null && vt)
                parts.push(`VRAM ${decimal(vu / 2 ** 30)} / ${decimal(vt / 2 ** 30)} GB`);
            gpuDetail = parts.join(' · ');
        } else if (gpu?.kind === 'idle') {
            // Actual busy time per engine (render, video, …) summed over every
            // client, from /proc/<pid>/fdinfo – the source intel_gpu_top/nvtop use.
            const engines = await this._sampleDrmEngines(dt);
            if (engines) {
                gpuPct = Math.max(0, ...Object.values(engines));
                const names = {render: _('3D'), video: _('Video'), 'video-enhance': _('Video enhance'), compute: _('Compute'), copy: _('Copy')};
                const busy = Object.entries(engines).filter(([, v]) => v >= 1)
                    .sort((a, b) => b[1] - a[1]).slice(0, 3)
                    .map(([k, v]) => `${names[k] ?? k} ${Math.round(v)} %`);
                gpuDetail = busy.join(' · ');
            }
            const f = await readNum(gpu.freq, c);
            if (f !== null)
                gpuDetail = [gpuDetail, gpu.maxFreq ? `${Math.round(f)} / ${Math.round(gpu.maxFreq)} MHz` : `${Math.round(f)} MHz`].filter(Boolean).join(' · ');
        } else if (gpu?.kind === 'nvidia') {
            this._pollNvidia();
            const n = this._nvidia;
            if (n) {
                gpuPct = n.util;
                gpuDetail = `${n.clock} MHz · ${n.temp} °C · VRAM ${decimal(n.used / 1024)} / ${decimal(n.total / 1024)} GB`;
            }
        }

        // --- Memory
        const mi = {};
        for (const l of (meminfo ?? '').split('\n')) {
            const m = l.match(/^(\w+):\s+(\d+)/);
            if (m)
                mi[m[1]] = Number(m[2]);
        }
        const memUsed = (mi.MemTotal ?? 0) - (mi.MemAvailable ?? 0);
        const ramPct = mi.MemTotal ? 100 * memUsed / mi.MemTotal : null;
        const swapUsed = (mi.SwapTotal ?? 0) - (mi.SwapFree ?? 0);

        // --- Disk and network (counters)
        for (const l of (diskstats ?? '').split('\n')) {
            const p = l.trim().split(/\s+/);
            if (p.length > 9 && /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/.test(p[2])) {
                cur.diskR += Number(p[5]) * 512;
                cur.diskW += Number(p[9]) * 512;
            }
        }
        for (const l of (netdev ?? '').split('\n').slice(2)) {
            const [name, rest] = l.split(':');
            if (!rest)
                continue;
            const iface = name.trim();
            if (/^(lo|veth|docker|br-|virbr|tailscale|wg)/.test(iface))
                continue;
            const p = rest.trim().split(/\s+/).map(Number);
            cur.netRx += p[0];
            cur.netTx += p[8];
        }

        this._prev = cur;

        if (c.is_cancelled())
            return;

        // --- Panel
        if (cpuPct !== undefined)
            this._barValues.cpu = cpuPct;
        if (gpuPct !== null)
            this._barValues.gpu = gpuPct;
        if (ramPct !== null)
            this._barValues.ram = ramPct;
        if (cpuTemp !== null)
            this._barValues.temp = cpuTemp / 1000;
        this._updateBar();

        // --- History (always, so graphs are full when the menu opens)
        if (cpuPct !== undefined)
            this._cpuGraph.push(cpuPct);
        if (gpuPct !== null)
            this._gpuGraph?.push(gpuPct);
        if (ramPct !== null)
            this._ramGraph.push(ramPct);

        if (!this.menu.isOpen)
            return;

        // --- Menu
        this._cpu.big.text = cpuPct !== undefined ? `${Math.round(cpuPct)} %` : '–';
        const cpuDetail = [];
        if (freqGHz)
            cpuDetail.push(`${decimal(freqGHz)} GHz`);
        if (cpuTemp !== null)
            cpuDetail.push(`${Math.round(cpuTemp / 1000)} °C`);
        if (load.length === 3 && load.every(Number.isFinite))
            cpuDetail.push(_('load %s').format(load.map(v => decimal(v, 2)).join(' ')));
        cpuDetail.push(_('%s threads').format(cores.length || '?'));
        this._cpu.detail.text = cpuDetail.join(' · ');
        this._cores.set(cores);

        if (this._gpu) {
            this._gpu.big.text = gpuPct !== null ? `${Math.round(gpuPct)} %` : '–';
            this._gpu.detail.text = gpuDetail;
        }

        if (ramPct !== null) {
            this._ram.big.text = `${Math.round(ramPct)} %`;
            const cache = ((mi.Cached ?? 0) + (mi.Buffers ?? 0)) / 1024 / 1024;
            this._ram.detail.text = _('%s / %s GB used · %s GB cache').format(fmtGB(memUsed), fmtGB(mi.MemTotal), decimal(cache));
        }
        if (mi.SwapTotal) {
            this._swapMeter.actor.visible = true;
            this._swapMeter.set(swapUsed / mi.SwapTotal, '', `${fmtGB(swapUsed)} / ${fmtGB(mi.SwapTotal)} GB`);
        } else {
            this._swapMeter.actor.visible = false;
        }

        try {
            const info = await Gio.File.new_for_path('/').query_filesystem_info_async('filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, c);
            const size = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            this._diskMeter.set((size - free) / size, '', `${fmtBytes(size - free)} / ${fmtBytes(size)}`);
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }

        if (prev && dt > 0) {
            this._diskRate.text = _('Disk: read %s · write %s').format(fmtRate((cur.diskR - prev.diskR) / dt), fmtRate((cur.diskW - prev.diskW) / dt));
            this._netRate.text = _('Network: ↓ %s · ↑ %s').format(fmtRate((cur.netRx - prev.netRx) / dt), fmtRate((cur.netTx - prev.netTx) / dt));
        }

        if (this._sensors)
            await this._renderSensors();

        await this._renderProcs(now, mi.MemTotal ?? 0, Math.max(1, cores.length));
    }

    async _renderSensors() {
        const c = this._cancellable;
        const rows = [];
        const rpms = await Promise.all(this._hw.fans.map(p => readNum(p, c)));
        rpms.forEach((rpm, i) => {
            if (rpm !== null)
                rows.push([this._hw.fans.length > 1 ? _('Fan %d').format(i + 1) : _('Fan'), `${rpm} rpm`]);
        });
        const nvme = await readNum(this._hw.nvmeTemp, c);
        if (nvme !== null)
            rows.push(['NVMe', `${Math.round(nvme / 1000)} °C`]);
        for (const b of this._hw.batteries) {
            const [cap, statusText, power, current, voltage] = await Promise.all([
                readNum(`${b}/capacity`, c), read(`${b}/status`, c), readNum(`${b}/power_now`, c),
                readNum(`${b}/current_now`, c), readNum(`${b}/voltage_now`, c)]);
            const status = (statusText ?? '').trim();
            let watts = power;
            if (watts === null)
                watts = current !== null && voltage !== null ? current * voltage / 1e6 : null;
            const st = {Charging: _('charging'), Discharging: _('discharging'), Full: _('full'), 'Not charging': _('not charging')}[status] ?? status.toLowerCase();
            let text = `${cap ?? '?'} % · ${st}`;
            if (watts)
                text += ` · ${decimal(watts / 1e6)} W`;
            rows.push([_('Battery'), text]);
        }
        this._sensors.destroy_all_children();
        for (const [k, v] of rows) {
            this._sensors.add_child(kvRow(k, v));
        }
    }

    async _renderProcs(now, memTotalKb, ncpu) {
        const c = this._cancellable;
        const cur = new Map();
        const list = [];
        const prev = this._prevProcs;
        const dt = prev ? now - prev.t : 0;
        const pids = (await listDir('/proc', c)).filter(pid => /^\d+$/.test(pid));
        const stats = await Promise.all(pids.map(pid => read(`/proc/${pid}/stat`, c)));
        pids.forEach((pid, i) => {
            const t = stats[i];
            if (!t)
                return;
            const close = t.lastIndexOf(')');
            const comm = t.slice(t.indexOf('(') + 1, close);
            const rest = t.slice(close + 2).split(' ');
            const ticks = Number(rest[11]) + Number(rest[12]);
            const rssKb = Number(rest[21]) * PAGE_SIZE / 1024;
            cur.set(pid, ticks);
            const before = prev?.ticks.get(pid);
            if (before !== undefined && dt > 0) {
                const pct = 100 * (ticks - before) / CLK_TCK / dt / ncpu;
                list.push({comm, pct, rssKb});
            }
        });
        this._prevProcs = {t: now, ticks: cur};

        this._procBox.destroy_all_children();
        if (!prev) {
            this._procBox.add_child(label(_('Measuring…'), 'tp-dim'));
            return;
        }
        list.sort((a, b) => b.pct - a.pct || b.rssKb - a.rssKb);
        for (const p of list.slice(0, TOP_PROCS)) {
            const row = hbox('tp-kv');
            row.add_child(label(p.comm, 'tp-proc-name'));
            row.add_child(label(`${decimal(p.pct)} %`, 'tp-proc-num'));
            const mem = p.rssKb >= 1024 * 1024 ? `${decimal(p.rssKb / 1024 / 1024)} GB` : `${Math.round(p.rssKb / 1024)} MB`;
            row.add_child(label(mem, 'tp-proc-num'));
            if (memTotalKb)
                row.add_child(label(_('%s %% RAM').format(decimal(100 * p.rssKb / memTotalKb)), 'tp-dim tp-small'));
            this._procBox.add_child(row);
        }
    }

    // Which /proc/*/fd entries point at a GPU (cheap: ~15 ms).
    async _scanDrmClients() {
        if (this._drmScanBusy)
            return;
        this._drmScanBusy = true;
        try {
            const proc = Gio.Subprocess.new(['sh', '-c',
                "find /proc/[0-9]*/fd -lname '/dev/dri/*' -printf '%h/%f\\n' 2>/dev/null"],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const [out] = await proc.communicate_utf8_async(null, this._cancellable);
            this._drmFds = (out ?? '').split('\n').filter(Boolean).map(p => p.replace('/fd/', '/fdinfo/'));
        } catch {}
        this._drmScanBusy = false;
    }

    // Busy share (0–100) per GPU engine since the previous sample.
    async _sampleDrmEngines(dt) {
        const clients = new Map();
        const texts = await Promise.all(this._drmFds.map(p => read(p, this._cancellable)));
        for (const t of texts) {
            if (!t)
                continue;
            const id = t.match(/^drm-client-id:\s*(\d+)/m);
            if (!id || clients.has(id[1]))
                continue;
            const eng = {};
            for (const m of t.matchAll(/^drm-engine-([\w-]+):\s*(\d+) ns/gm))
                eng[m[1]] = Number(m[2]);
            for (const m of t.matchAll(/^drm-engine-capacity-([\w-]+):\s*(\d+)/gm))
                eng[`cap:${m[1]}`] = Number(m[2]);
            clients.set(id[1], eng);
        }
        const prev = this._drmPrev;
        this._drmPrev = clients;
        if (!prev || dt <= 0 || clients.size === 0)
            return null;
        const busy = {};
        for (const [id, eng] of clients) {
            const before = prev.get(id);
            if (!before)
                continue;
            for (const [k, v] of Object.entries(eng)) {
                if (k.startsWith('cap:') || before[k] === undefined || v < before[k])
                    continue;
                const cap = eng[`cap:${k}`] || 1;
                busy[k] = (busy[k] ?? 0) + (v - before[k]) / cap;
            }
        }
        for (const k of Object.keys(busy))
            busy[k] = Math.min(100, 100 * busy[k] / (dt * 1e9));
        return busy;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timer)
            GLib.source_remove(this._timer);
        if (this._drmTimer)
            GLib.source_remove(this._drmTimer);
        this._timer = this._drmTimer = 0;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        if (this._openId)
            this.menu.disconnect(this._openId);
        this._openId = 0;
        if (this._miniBarsId)
            this._miniBars.disconnect(this._miniBarsId);
        this._miniBarsId = 0;
        for (const g of [this._cpuGraph, this._gpuGraph, this._ramGraph, this._cores])
            g?.destroy();
        this._cpuGraph = this._gpuGraph = this._ramGraph = this._cores = null;
        super.destroy();
    }
});
