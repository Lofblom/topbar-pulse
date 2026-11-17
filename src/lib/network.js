// Network indicator: connection details from NetworkManager, public IP and
// DNS leak check, Wi-Fi band and DNS provider, speed test and Wi-Fi sharing
// by QR code.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import NM from 'gi://NM';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    run, isCancelled, notifyError, findProgram, readNum, listDir, decimal, fmtBytes, fmtRate,
    label, hbox, vbox, kvRow, spawn,
} from './util.js';
import {newSession} from './http.js';
import {publicIp, dnsLeakTest, flag, nowUnix} from './netinfo.js';
import {SpeedTest} from './speedtest.js';
import {encodeQr, wifiQrText} from './qr.js';

Gio._promisify(NM.Client, 'new_async', 'new_finish');

const IDLE_SEC = 5;
const OPEN_SEC = 2;
const PUBLIC_IP_MAX_AGE = 120;

const DNS_PRESETS = {
    auto: null,
    cloudflare: {name: 'Cloudflare', v4: ['1.1.1.1', '1.0.0.1'], v6: ['2606:4700:4700::1111', '2606:4700:4700::1001']},
    google: {name: 'Google', v4: ['8.8.8.8', '8.8.4.4'], v6: ['2001:4860:4860::8888', '2001:4860:4860::8844']},
    quad9: {name: 'Quad9', v4: ['9.9.9.9', '149.112.112.112'], v6: ['2620:fe::fe', '2620:fe::9']},
    mullvad: {name: 'Mullvad', v4: ['194.242.2.2'], v6: ['2a07:e340::2']},
};

// Interfaces made by VPN apps that NetworkManager does not manage.
const VPN_IFACE = /^(wg|tun|tap|proton|mullvad|nordlynx|ivpn|pvpn|ppp|utun|ipsec)/;

function bandOfFreq(mhz) {
    if (!mhz)
        return null;
    if (mhz < 2500)
        return '2.4';
    if (mhz < 5925)
        return '5';
    if (mhz < 7125)
        return '6';
    return null;
}

const NM_BAND = {'2.4': 'bg', '5': 'a', '6': '6GHz'};
const BAND_FROM_NM = {bg: '2.4', a: '5', '6GHz': '6'};

function fmtBand(b) {
    return b === 'auto' ? _('Automatic') : `${decimal(Number(b), b === '2.4' ? 1 : 0)} GHz`;
}

function ssidString(ap) {
    const bytes = ap?.get_ssid();
    return bytes ? NM.utils_ssid_to_utf8(bytes.get_data()) : '';
}

export const NetworkIndicator = GObject.registerClass(
class NetworkIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, _('Network'), false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._session = newSession();
        this._client = null;
        this._status = {};
        this._traffic = null;
        this._pings = {};
        this._public = null;
        this._publicAt = 0;
        this._dns = null;
        this._vpnWas = null;
        this.add_style_class_name('tp-compact');

        // ---- panel button
        const box = hbox('panel-status-menu-box tp-tight');
        this._icon = new St.Icon({icon_name: 'network-wireless-symbolic', style_class: 'system-status-icon'});
        this._vpnIcon = new St.Icon({icon_name: 'network-vpn-symbolic', style_class: 'system-status-icon', visible: false});
        this._countryLabel = label('', 'tp-bar-label', {visible: false});
        box.add_child(this._icon);
        box.add_child(this._vpnIcon);
        box.add_child(this._countryLabel);
        this.add_child(box);

        // ---- menu
        this._detailsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._details = vbox('tp-sec', {x_expand: true});
        this._detailsItem.add_child(this._details);
        this.menu.addMenuItem(this._detailsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Internet')));
        this._publicItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._publicBox = vbox('tp-sec', {x_expand: true});
        this._publicItem.add_child(this._publicBox);
        this.menu.addMenuItem(this._publicItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._bandSub = new PopupMenu.PopupSubMenuMenuItem(_('Wi-Fi band'));
        this.menu.addMenuItem(this._bandSub);
        this._dnsSub = new PopupMenu.PopupSubMenuMenuItem(_('DNS'));
        this.menu.addMenuItem(this._dnsSub);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const actions = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const col = vbox('tp-sec', {x_expand: true});
        const buttons = hbox('tp-buttons');
        this._speedBtn = this._button(_('Speed test'), () => this._speedtest());
        this._leakBtn = this._button(_('Check DNS'), () => this._checkDns(true));
        this._qrBtn = this._button(_('Share Wi-Fi'), () => this._toggleQr());
        buttons.add_child(this._speedBtn);
        buttons.add_child(this._leakBtn);
        buttons.add_child(this._qrBtn);
        col.add_child(buttons);
        this._speedLabel = label('', 'tp-kv-val', {visible: false});
        col.add_child(this._speedLabel);
        this._qrBox = vbox('tp-qr-box', {visible: false, x_align: Clutter.ActorAlign.CENTER});
        this._qrArea = new St.DrawingArea({style_class: 'tp-qr', x_align: Clutter.ActorAlign.CENTER});
        this._qrRows = [];
        this._qrArea.connect('repaint', a => this._paintQr(a));
        this._qrBox.add_child(this._qrArea);
        this._qrCaption = label('', 'tp-dim', {x_align: Clutter.ActorAlign.CENTER});
        this._qrBox.add_child(this._qrCaption);
        col.add_child(this._qrBox);
        actions.add_child(col);
        this.menu.addMenuItem(actions);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Network settings'), () => spawn(['gnome-control-center', this._status.type === 'ethernet' ? 'network' : 'wifi']));
        this.menu.addAction(_('Topbar Pulse settings…'), () => ext.openPreferences());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._poll(true);
                this._startTimer(OPEN_SEC);
                if (nowUnix() - this._publicAt > PUBLIC_IP_MAX_AGE)
                    this._checkPublicIp();
            } else {
                this._startTimer(IDLE_SEC);
                this._qrBox.visible = false;
                this._qrBtn.remove_style_class_name('selected');
            }
        });

        this._settingsIds = [
            this._settings.connect('changed::network-show-country', () => this._renderBar()),
            this._settings.connect('changed::network-public-ip', () => this._renderPublic()),
            this._settings.connect('changed::network-hide-gnome', () => this._syncGnomeIcon()),
        ];

        this._initClient();
        this._startTimer(IDLE_SEC);
    }

    async _initClient() {
        try {
            this._client = await NM.Client.new_async(this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
            console.warn(`Topbar Pulse: NetworkManager unavailable: ${e.message}`);
        }
        if (this._client) {
            this._clientIds = [
                this._client.connect('notify::primary-connection', () => this._networkChanged()),
                this._client.connect('active-connection-added', () => this._networkChanged()),
                this._client.connect('active-connection-removed', () => this._networkChanged()),
            ];
        }
        this._syncGnomeIcon();
        // the VPN state must be known before the public IP is judged
        await this._poll(false);
        this._checkPublicIp();
    }

    _networkChanged() {
        // Let addresses and routes settle before asking the internet.
        if (this._changeId)
            GLib.source_remove(this._changeId);
        this._changeId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            this._changeId = 0;
            this._poll(false).then(() => this._checkPublicIp());
            return GLib.SOURCE_REMOVE;
        });
    }

    _button(text, cb) {
        const b = new St.Button({label: text, style_class: 'tp-button', can_focus: true});
        b.connect('clicked', cb);
        return b;
    }

    _startTimer(sec) {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
            this._poll(this.menu.isOpen);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ------------------------------------------------------------ status

    _physicalDevice() {
        const devices = this._client?.get_devices() ?? [];
        const active = devices.filter(d => d.get_state() === NM.DeviceState.ACTIVATED &&
            [NM.DeviceType.WIFI, NM.DeviceType.ETHERNET].includes(d.get_device_type()));
        return active.find(d => d.get_active_connection()?.get_default()) ?? active[0] ?? null;
    }

    // VPNs NetworkManager knows about (synchronous, from its cached state).
    _vpnState() {
        const names = [];
        for (const ac of this._client?.get_active_connections() ?? []) {
            const type = ac.get_connection_type();
            if (ac.get_vpn() || type === 'wireguard' || type === 'vpn')
                names.push(ac.get_id());
        }
        return names;
    }

    // Interfaces made by VPN apps outside NetworkManager (Mullvad, Proton …).
    async _vpnInterfaces() {
        const c = this._cancellable;
        const ifaces = (await listDir('/sys/class/net', c)).filter(i => VPN_IFACE.test(i));
        const up = await Promise.all(ifaces.map(i => readNum(`/sys/class/net/${i}/carrier`, c)));
        return ifaces.filter((_i, n) => up[n] === 1);
    }

    _collect() {
        const s = {type: null};
        const dev = this._physicalDevice();
        if (dev) {
            const ac = dev.get_active_connection();
            s.iface = dev.get_iface();
            s.conn = ac?.get_id() ?? '';
            s.uuid = ac?.get_uuid() ?? '';
            s.remote = ac?.get_connection() ?? null;
            if (dev.get_device_type() === NM.DeviceType.WIFI) {
                s.type = 'wifi';
                const ap = dev.get_active_access_point();
                s.ssid = ssidString(ap);
                s.strength = ap?.get_strength() ?? null;
                s.freq = ap?.get_frequency() ?? null;
                s.bitrate = dev.get_bitrate() ? Math.round(dev.get_bitrate() / 1000) : null;
                s.bands = [...new Set(dev.get_access_points()
                    .filter(a => ssidString(a) === s.ssid)
                    .map(a => bandOfFreq(a.get_frequency()))
                    .filter(Boolean))].sort((a, b) => Number(a) - Number(b));
            } else {
                s.type = 'ethernet';
                s.speed = dev.get_speed?.() || null;
            }
            const ip4 = dev.get_ip4_config();
            const addr = ip4?.get_addresses()?.[0];
            if (addr) {
                s.ip = addr.get_address();
                s.prefix = addr.get_prefix();
            }
            s.gateway = ip4?.get_gateway() || '';
            s.nameservers = ip4?.get_nameservers?.() ?? [];
        }
        s.vpn = this._vpnState();
        return s;
    }

    // One poll at a time; a caller arriving mid-poll waits for that one, so
    // whoever awaits _poll() always sees fresh status (including the VPN).
    _poll(open) {
        if (!this._pollPromise) {
            this._pollPromise = this._pollAsync(open).catch(e => {
                if (!isCancelled(e))
                    console.warn(`Topbar Pulse: network poll: ${e.message}`);
            }).finally(() => {
                this._pollPromise = null;
            });
        }
        return this._pollPromise;
    }

    async _pollAsync(open) {
        const c = this._cancellable;
        const s = this._collect();
        s.vpn = [...new Set([...s.vpn, ...await this._vpnInterfaces()])];
        this._status = s;

        if (s.iface) {
            const [rx, tx] = await Promise.all([
                readNum(`/sys/class/net/${s.iface}/statistics/rx_bytes`, c),
                readNum(`/sys/class/net/${s.iface}/statistics/tx_bytes`, c)]);
            const t = GLib.get_monotonic_time() / 1e6;
            const prev = this._traffic;
            this._traffic = {iface: s.iface, rx, tx, t};
            if (prev?.iface === s.iface && t > prev.t)
                this._traffic.rate = {rx: (rx - prev.rx) / (t - prev.t), tx: (tx - prev.tx) / (t - prev.t)};
        }

        const vpnOn = s.vpn.length > 0;
        if (this._vpnWas !== null && this._vpnWas !== vpnOn)
            this._networkChanged();
        this._vpnWas = vpnOn;

        this._renderBar();
        if (!open)
            return;
        this._renderDetails();
        this._pingAll();
        if (!this._menuBuiltFor || this._menuBuiltFor !== s.uuid) {
            this._menuBuiltFor = s.uuid;
            this._buildBandMenu();
            this._buildDnsMenu();
        }
    }

    async _pingAll() {
        const ping = findProgram('ping');
        if (!ping || this._pinging)
            return;
        this._pinging = true;
        const one = async host => {
            try {
                const r = await run([ping, '-n', '-c', '1', '-W', '2', host], this._cancellable);
                const m = r.out.match(/time[=<]([\d.]+)/);
                return m ? Number(m[1]) : null;
            } catch {
                return null;
            }
        };
        const [router, internet] = await Promise.all([
            this._status.gateway ? one(this._status.gateway) : null,
            one('1.1.1.1'),
        ]);
        this._pings = {router, internet};
        this._pinging = false;
        if (this.menu.isOpen)
            this._renderDetails();
    }

    _renderBar() {
        const s = this._status;
        if (s.type === 'wifi') {
            const q = s.strength ?? 0;
            const lvl = q >= 80 ? 'excellent' : q >= 55 ? 'good' : q >= 30 ? 'ok' : 'weak';
            this._icon.icon_name = `network-wireless-signal-${lvl}-symbolic`;
        } else if (s.type === 'ethernet') {
            this._icon.icon_name = 'network-wired-symbolic';
        } else {
            this._icon.icon_name = 'network-offline-symbolic';
        }
        const vpnOn = s.vpn?.length > 0;
        this._vpnIcon.visible = vpnOn;
        const mode = this._settings.get_string('network-show-country');
        const cc = this._public?.countryCode;
        const show = cc && this._settings.get_boolean('network-public-ip') &&
            (mode === 'always' || (mode === 'vpn' && vpnOn));
        this._countryLabel.text = show ? cc : '';
        this._countryLabel.visible = !!show;
    }

    _renderDetails() {
        const s = this._status;
        const rows = [];
        if (!this._client) {
            rows.push([_('Status'), _('NetworkManager is not available')]);
        } else if (!s.type) {
            rows.push([_('Status'), _('Not connected')]);
        } else {
            if (s.type === 'wifi') {
                rows.push([_('Network'), s.ssid || '–']);
                if (s.strength !== null)
                    rows.push([_('Signal'), `${s.strength} %`]);
                const band = bandOfFreq(s.freq);
                if (band)
                    rows.push([_('Band'), `${fmtBand(band)} (${s.freq} MHz)`]);
                if (s.bitrate)
                    rows.push([_('Link speed'), `${s.bitrate} Mbit/s`]);
            } else {
                rows.push([_('Connection'), s.speed ? _('Cable, %d Mbit/s').format(s.speed) : _('Cable')]);
            }
            rows.push([_('Device'), s.iface]);
            if (s.ip)
                rows.push([_('IP address'), s.prefix ? `${s.ip}/${s.prefix}` : s.ip]);
            if (s.gateway)
                rows.push([_('Gateway'), s.gateway]);
            if (s.nameservers?.length)
                rows.push([_('DNS servers'), s.nameservers.join(', ')]);
            const p = this._pings;
            if (p.router !== undefined && s.gateway)
                rows.push([_('Ping router'), p.router !== null ? `${decimal(p.router)} ms` : '–']);
            if (p.internet !== undefined)
                rows.push([_('Ping internet'), p.internet !== null ? `${decimal(p.internet)} ms` : _('no answer')]);
            const tr = this._traffic;
            if (tr?.rate)
                rows.push([_('Traffic'), `↓ ${fmtRate(tr.rate.rx)}  ↑ ${fmtRate(tr.rate.tx)}  (${_('total')} ↓ ${fmtBytes(tr.rx)} ↑ ${fmtBytes(tr.tx)})`]);
        }
        if (s.vpn?.length)
            rows.push([_('VPN'), s.vpn.join(', ')]);
        this._details.destroy_all_children();
        for (const [k, v] of rows)
            this._details.add_child(kvRow(k, v));
        this._bandSub.visible = s.type === 'wifi' && (s.bands?.length ?? 0) > 0;
        this._qrBtn.visible = s.type === 'wifi';
        this._dnsSub.visible = !!s.uuid;
    }

    // ------------------------------------------------- public IP and DNS

    async _checkPublicIp() {
        if (!this._settings.get_boolean('network-public-ip') || this._publicBusy)
            return;
        this._publicBusy = true;
        try {
            this._public = await publicIp(this._session, this._cancellable);
            this._publicAt = nowUnix();
            this._publicError = null;
            // Remember the provider seen without VPN, to recognise DNS leaks later.
            if (!this._status.vpn?.length && this._public.asn)
                this._settings.set_string('network-home-asn', `${this._public.asn}|${this._public.isp}`);
        } catch (e) {
            if (isCancelled(e))
                return;
            this._public = null;
            this._publicError = e.message;
        }
        this._publicBusy = false;
        this._renderBar();
        this._renderPublic();
        // A VPN change is exactly when a DNS leak matters.
        if (this._status.vpn?.length && !this._dnsBusy)
            this._checkDns(false);
    }

    async _checkDns(user) {
        if (this._dnsBusy || (!user && !this._settings.get_boolean('network-public-ip')))
            return;
        this._dnsBusy = true;
        this._leakBtn.label = _('Checking…');
        this._leakBtn.reactive = false;
        try {
            this._dns = await dnsLeakTest(this._session, this._cancellable);
            this._dnsError = null;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._dns = null;
            this._dnsError = e.message;
        }
        this._dnsBusy = false;
        this._leakBtn.label = _('Check DNS');
        this._leakBtn.reactive = true;
        this._renderPublic();
    }

    _renderPublic() {
        const box = this._publicBox;
        box.destroy_all_children();
        if (!this._settings.get_boolean('network-public-ip')) {
            box.add_child(label(_('Public IP check is turned off in the settings.'), 'tp-dim tp-small'));
            this._leakBtn.visible = false;
            return;
        }
        this._leakBtn.visible = true;
        const p = this._public;
        if (p) {
            const place = [p.city, p.country].filter(Boolean).join(', ');
            box.add_child(kvRow(_('Public IP'), p.ip));
            box.add_child(kvRow(_('Location'), `${flag(p.countryCode)} ${place}`.trim()));
            box.add_child(kvRow(_('Provider'), [p.isp, p.asn].filter(Boolean).join(' · ')));
            if (p.reverse)
                box.add_child(kvRow(_('Host name'), p.reverse));
        } else if (this._publicError) {
            box.add_child(label(_('Could not reach ipleak.net (%s)').format(this._publicError), 'tp-warn'));
        } else {
            box.add_child(label(_('Checking public IP…'), 'tp-dim'));
        }

        const d = this._dns;
        if (d) {
            const groups = new Map();
            for (const srv of d.servers) {
                const key = `${srv.org}|${srv.countryCode}`;
                const g = groups.get(key) ?? {org: srv.org, cc: srv.countryCode, asn: srv.asn, n: 0};
                g.n++;
                groups.set(key, g);
            }
            const text = [...groups.values()]
                .map(g => `${flag(g.cc)} ${g.org || '?'}${g.n > 1 ? ` ×${g.n}` : ''}`).join('\n');
            box.add_child(kvRow(_('DNS resolvers'), text || '–'));
            box.add_child(this._verdict(d));
        } else if (this._dnsError) {
            box.add_child(label(_('DNS check failed (%s)').format(this._dnsError), 'tp-warn'));
        }
        box.add_child(label(_('Data from ipleak.net and bash.ws'), 'tp-dim tp-small'));
    }

    _verdict(d) {
        const vpnOn = this._status.vpn?.length > 0;
        const home = this._settings.get_string('network-home-asn').split('|');
        const homeAsn = home[0] || '';
        const homeIsp = home[1] || '';
        const exitAsn = this._public?.asn || d.ip?.asn || '';
        const leaking = vpnOn && homeAsn && homeAsn !== exitAsn && d.servers.some(s => s.asn === homeAsn);
        let text, cls;
        if (leaking) {
            text = _('⚠ Possible DNS leak: lookups go through %s, your usual provider, outside the VPN.').format(homeIsp || homeAsn);
            cls = 'tp-warn';
        } else if (vpnOn) {
            text = _('✓ No DNS leak found: lookups do not go through your usual provider.');
            cls = 'tp-ok';
        } else {
            text = _('No VPN active. DNS lookups are visible to the resolvers above.');
            cls = 'tp-dim tp-small';
        }
        const l = label(text, cls);
        l.clutter_text.line_wrap = true;
        return l;
    }

    // -------------------------------------------------------------- band

    _buildBandMenu() {
        const s = this._status;
        this._bandSub.menu.removeAll();
        if (s.type !== 'wifi' || !s.remote)
            return;
        const nmBand = s.remote.get_setting_wireless()?.get_band() ?? null;
        const selected = BAND_FROM_NM[nmBand] ?? 'auto';
        const now = bandOfFreq(s.freq);
        this._bandSub.label.text = _('Wi-Fi band: %s').format(fmtBand(selected)) +
            (selected === 'auto' && now ? ` (${_('now %s').format(fmtBand(now))})` : '');
        for (const b of ['auto', ...(s.bands ?? [])]) {
            const it = new PopupMenu.PopupMenuItem(fmtBand(b));
            it.setOrnament(b === selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NO_DOT);
            it.connect('activate', () => this._setBand(b));
            this._bandSub.menu.addMenuItem(it);
        }
    }

    async _setBand(b) {
        const nmcli = findProgram('nmcli');
        const uuid = this._status.uuid;
        if (!nmcli || !uuid)
            return;
        const value = b === 'auto' ? '' : NM_BAND[b];
        try {
            let r = await run([nmcli, 'connection', 'modify', 'uuid', uuid, '802-11-wireless.band', value], this._cancellable);
            if (r.ok)
                r = await run([nmcli, 'connection', 'up', 'uuid', uuid], this._cancellable);
            if (!r.ok)
                notifyError(_('Wi-Fi band'), r.err.trim() || _('Could not change band'));
        } catch (e) {
            if (!isCancelled(e))
                notifyError(_('Wi-Fi band'), e.message);
        }
        this._menuBuiltFor = null;
    }

    // --------------------------------------------------------------- DNS

    _currentDnsPreset() {
        const s4 = this._status.remote?.get_setting_ip4_config();
        if (!s4 || !s4.get_ignore_auto_dns() || s4.get_num_dns() === 0)
            return 'auto';
        const first = s4.get_dns(0);
        for (const [id, p] of Object.entries(DNS_PRESETS)) {
            if (p?.v4.includes(first))
                return id;
        }
        return 'custom';
    }

    _buildDnsMenu() {
        this._dnsSub.menu.removeAll();
        if (!this._status.remote)
            return;
        const current = this._currentDnsPreset();
        const names = {auto: _('Automatic (from network)'), custom: _('Custom')};
        const label_ = id => names[id] ?? DNS_PRESETS[id].name;
        this._dnsSub.label.text = _('DNS: %s').format(label_(current));
        const custom = this._settings.get_string('network-custom-dns').trim();
        const ids = [...Object.keys(DNS_PRESETS), ...(custom ? ['custom'] : [])];
        for (const id of ids) {
            const text = id === 'custom' ? `${_('Custom')} (${custom})` : label_(id);
            const it = new PopupMenu.PopupMenuItem(text);
            it.setOrnament(id === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NO_DOT);
            it.connect('activate', () => this._setDns(id));
            this._dnsSub.menu.addMenuItem(it);
        }
        if (!custom) {
            const it = new PopupMenu.PopupMenuItem(_('Custom…'));
            it.connect('activate', () => this._ext.openPreferences());
            this._dnsSub.menu.addMenuItem(it);
        }
    }

    async _setDns(id) {
        const nmcli = findProgram('nmcli');
        const {uuid, iface, remote} = this._status;
        if (!nmcli || !uuid)
            return;
        let v4 = [], v6 = [];
        if (id === 'custom') {
            for (const a of this._settings.get_string('network-custom-dns').split(/[\s,]+/).filter(Boolean))
                (a.includes(':') ? v6 : v4).push(a);
        } else if (DNS_PRESETS[id]) {
            v4 = DNS_PRESETS[id].v4;
            v6 = DNS_PRESETS[id].v6;
        }
        const manual = id !== 'auto';
        const args = [nmcli, 'connection', 'modify', 'uuid', uuid,
            'ipv4.dns', v4.join(' '), 'ipv4.ignore-auto-dns', manual ? 'yes' : 'no'];
        const m6 = remote?.get_setting_ip6_config()?.get_method();
        if (m6 && !['disabled', 'ignore'].includes(m6))
            args.push('ipv6.dns', v6.join(' '), 'ipv6.ignore-auto-dns', manual ? 'yes' : 'no');
        try {
            let r = await run(args, this._cancellable);
            if (r.ok && iface)
                r = await run([nmcli, 'device', 'reapply', iface], this._cancellable);
            if (!r.ok)
                notifyError(_('DNS'), r.err.trim() || _('Could not change DNS'));
        } catch (e) {
            if (!isCancelled(e))
                notifyError(_('DNS'), e.message);
        }
        this._menuBuiltFor = null;
        this._dns = null;
        this._networkChanged();
    }

    // -------------------------------------------------------- speed test

    async _speedtest() {
        if (this._speed) {
            this._speed.cancel();
            return;
        }
        const server = this._settings.get_string('speedtest-server');
        const fmt = v => (v === null || v === undefined ? '–' : `${Math.round(v)} Mbit/s`);
        const res = {down: null, up: null};
        const show = phase => {
            const what = phase === 'down' ? _('Measuring download…') : phase === 'up' ? _('Measuring upload…') : '';
            this._speedLabel.text = `${what} ↓ ${fmt(res.down)}   ↑ ${fmt(res.up)}`.trim();
            this._speedLabel.visible = true;
        };
        this._speed = new SpeedTest(server, (phase, mbps) => {
            res[phase] = mbps;
            show(phase);
        });
        this._speedBtn.label = _('Stop');
        show('down');
        try {
            const r = await this._speed.run();
            res.down = r.down;
            res.up = r.up;
            let text = `↓ ${fmt(r.down)}   ↑ ${fmt(r.up)}`;
            if (r.ping !== null)
                text += `   ${_('latency')} ${Math.round(r.ping)} ms`;
            text += `\n${_('Server: %s').format(r.server)}`;
            if (r.down === null)
                text += `   ${_('(test failed)')}`;
            this._speedLabel.text = text;
        } catch (e) {
            if (!isCancelled(e))
                this._speedLabel.text = _('Speed test failed: %s').format(e.message);
        }
        this._speed = null;
        this._speedBtn.label = _('Speed test');
    }

    // ------------------------------------------------------- Wi-Fi share

    async _toggleQr() {
        if (this._qrBox.visible) {
            this._qrBox.visible = false;
            this._qrBtn.remove_style_class_name('selected');
            return;
        }
        const {ssid, uuid, remote} = this._status;
        const sec = remote?.get_setting_wireless_security();
        const km = sec?.get_key_mgmt() ?? 'none';
        let type = 'nopass', password = '';
        if (sec && km !== 'none' && km !== 'owe')
            type = 'WPA';
        if (km === 'none' && sec?.get_wep_key(0))
            type = 'WEP';
        if (/eap|ieee8021x/.test(km)) {
            notifyError(_('Share Wi-Fi'), _('Enterprise networks have no shareable password.'));
            return;
        }
        if (type !== 'nopass') {
            const nmcli = findProgram('nmcli');
            const field = type === 'WEP' ? '802-11-wireless-security.wep-key0' : '802-11-wireless-security.psk';
            const r = nmcli ? await run([nmcli, '-s', '-e', 'no', '-g', field, 'connection', 'show', 'uuid', uuid], this._cancellable) : null;
            password = r?.ok ? r.out.trim() : '';
            if (!password) {
                notifyError(_('Share Wi-Fi'), _('The Wi-Fi password could not be read.'));
                return;
            }
        }
        try {
            this._qrRows = encodeQr(wifiQrText(ssid, password, type));
        } catch (e) {
            notifyError(_('Share Wi-Fi'), e.message);
            return;
        }
        this._qrCaption.text = password ? `${ssid}\n${_('Password: %s').format(password)}` : ssid;
        this._qrBox.visible = true;
        this._qrBtn.add_style_class_name('selected');
        this._qrArea.queue_repaint();
    }

    _paintQr(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const size = Math.min(w, h);
        cr.setSourceRGB(1, 1, 1);
        cr.paint();
        const rows = this._qrRows;
        const n = rows.length;
        if (n > 0) {
            const quiet = 2;
            const cell = Math.floor(size / (n + quiet * 2));
            const off = Math.floor((size - cell * n) / 2);
            cr.setSourceRGB(0, 0, 0);
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    if (rows[y][x] === '1')
                        cr.rectangle(off + x * cell, off + y * cell, cell, cell);
                }
            }
            cr.fill();
        }
        cr.$dispose();
    }

    // ------------------------------------------- GNOME's own network icon

    _syncGnomeIcon() {
        const ind = Main.panel.statusArea.quickSettings?._network ?? null;
        if (!ind) {
            if (!this._retryId && (this._retries = (this._retries ?? 0) + 1) <= 30) {
                this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    this._retryId = 0;
                    this._syncGnomeIcon();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        // Only hide GNOME's icon when ours can stand in for it.
        const hide = this._settings.get_boolean('network-hide-gnome') && !!this._client;
        if (hide && !this._gnomeVisId) {
            this._gnomeInd = ind;
            this._gnomeVisId = ind.connect('notify::visible', () => {
                if (ind.visible)
                    ind.hide();
            });
            ind.hide();
        } else if (!hide && this._gnomeVisId) {
            this._restoreGnomeIcon();
        }
    }

    _restoreGnomeIcon() {
        const ind = this._gnomeInd;
        if (!ind || !this._gnomeVisId)
            return;
        ind.disconnect(this._gnomeVisId);
        this._gnomeVisId = 0;
        if (typeof ind._syncIndicatorsVisible === 'function')
            ind._syncIndicatorsVisible();
        else
            ind.show();
    }

    destroy() {
        this._cancellable.cancel();
        this._speed?.cancel();
        this._session.abort();
        for (const id of [this._timer, this._retryId, this._changeId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._retryId = this._changeId = 0;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        for (const id of this._clientIds ?? [])
            this._client.disconnect(id);
        this._restoreGnomeIcon();
        super.destroy();
    }
});
