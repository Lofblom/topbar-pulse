// Development only (not shipped): runs when TOPBAR_PULSE_SELFTEST=<dir> is
// set in a nested shell. Screenshots the panel in each style and every menu.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

async function shoot(path) {
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

// ---- demo mode (TOPBAR_PULSE_DEMO=1): README screenshots without the
// developer's own network details. Everything shown on the network side is
// example data from documentation ranges; system and AI values are live.

function hideDevkitClutter() {
    Main.overview.hide();
    for (const ind of Object.values(Main.panel.statusArea)) {
        if (ind?.has_style_class_name?.('screen-sharing-indicator') || ind?.has_style_class_name?.('screen-recording-indicator'))
            ind.container?.hide();
    }
    Main.panel.statusArea.quickSettings?._remoteAccess?.hide();
}

async function demoNetwork(net) {
    const {encodeQr, wifiQrText} = await import('./qr.js');
    const collect = net._collect.bind(net);
    net._collect = () => {
        const s = collect();
        if (s.type === 'wifi')
            s.ssid = 'Home Wi-Fi';
        Object.assign(s, {ip: '192.168.1.42', prefix: 24, gateway: '192.168.1.1', nameservers: ['10.64.0.1']});
        s.vpn = ['Mullvad (WireGuard)'];
        return s;
    };
    net._settings.set_string('network-home-asn', 'AS64500|Example Fibre AB');
    net._pingAll = async () => {
        net._pings = {router: 2.1, internet: 6.8};
    };
    net._checkPublicIp = async () => {
        net._public = {ip: '198.51.100.23', country: 'Sweden', countryCode: 'SE', city: 'Stockholm', region: '', isp: 'Mullvad VPN AB', asn: 'AS39351', reverse: ''};
        net._publicAt = Math.floor(Date.now() / 1000);
        net._renderBar();
        net._renderPublic();
    };
    net._checkDns = async () => {
        const srv = {ip: '', country: 'Sweden', countryCode: 'SE', org: 'Mullvad VPN AB', asn: 'AS39351'};
        net._dns = {ip: null, servers: [srv, srv, srv, srv]};
        net._renderPublic();
    };
    net._demoQr = () => {
        net._qrRows = encodeQr(wifiQrText('Home Wi-Fi', 'correct-horse-battery', 'WPA'));
        net._qrCaption.text = 'Home Wi-Fi\nPassword: correct-horse-battery';
        net._qrBox.visible = true;
        net._qrBtn.add_style_class_name('selected');
        net._qrArea.queue_repaint();
    };
    net._checkPublicIp();
    net._checkDns();
}

async function runDemo(ext, dir) {
    const st = ext.getSettings();
    st.set_strv('ai-services', ['claude', 'chatgpt', 'gemini', 'copilot', 'mistral', 'perplexity']);
    st.set_string('ai-custom-services', JSON.stringify([{id: 'custom-demo', name: 'Open WebUI (local)', url: 'http://localhost:3000', cli: ''}]));
    st.set_boolean('tighten-top-bar', true);
    const ind = ext._indicators;
    await demoNetwork(ind.network);
    await wait(10000);
    hideDevkitClutter();
    await wait(1500);
    for (const style of ['compact', 'labels', 'bars']) {
        st.set_string('system-style', style);
        st.set_string('ai-style', {compact: 'icon-percent', labels: 'icon-percent', bars: 'ring'}[style]);
        await wait(2500);
        await shoot(`${dir}/panel-${style}.png`);
    }
    st.set_string('system-style', 'compact');
    st.set_string('ai-style', 'icon-percent');
    await wait(1500);

    ind.system.menu.open(false);
    await wait(7000);
    await shoot(`${dir}/menu-system.png`);
    ind.system.menu.close(false);
    await wait(800);

    ind.ai.menu.open(false);
    await wait(6000);
    await shoot(`${dir}/menu-ai.png`);
    ind.ai.menu.close(false);
    await wait(800);

    const net = ind.network;
    net.menu.open(false);
    await wait(5000);
    net._speedtest();
    await wait(24000);
    await shoot(`${dir}/menu-network.png`);
    net._demoQr();
    // only the sharing part: hide everything above the band/DNS rows
    const hidden = [];
    for (const it of net.menu._getMenuItems()) {
        if (it === net._bandSub)
            break;
        it.hide();
        hidden.push(it);
    }
    await wait(1500);
    await shoot(`${dir}/menu-network-qr.png`);
    hidden.forEach(it => it.show());
    net.menu.close(false);
    await wait(800);

    ext.openPreferences();
    await wait(6000);
    // Fit the preferences window below the top bar.
    const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    for (const actor of global.get_window_actors()) {
        const w = actor.meta_window;
        if (w?.get_wm_class?.() === 'org.gnome.Shell.Extensions') {
            const width = 640, height = Math.min(1000, area.height - 60);
            w.move_resize_frame(false, area.x + Math.round((area.width - width) / 2), area.y + 30, width, height);
        }
    }
    await wait(1500);
    await shoot(`${dir}/prefs.png`);
}

export async function run(ext, dir) {
    if (GLib.getenv('TOPBAR_PULSE_DEMO')) {
        try {
            await runDemo(ext, dir);
            console.log('topbar-pulse selftest: done');
        } catch (e) {
            console.error(`topbar-pulse selftest: ${e.message}\n${e.stack}`);
        } finally {
            await shoot(`${dir}/done.png`);
        }
        return;
    }
    const st = ext.getSettings();
    try {
        st.set_string('ai-custom-services', JSON.stringify([{id: 'custom-test', name: 'Aider', url: '', cli: 'aider'}]));
        await wait(12000);
        const qs = Main.panel.statusArea.quickSettings;
        console.log(`topbar-pulse selftest: gnome network icon hidden=${qs?._network ? !qs._network.visible : 'n/a'}`);
        await shoot(`${dir}/panel-compact.png`);
        st.set_string('system-style', 'labels');
        st.set_string('ai-style', 'ring');
        st.set_boolean('tighten-top-bar', true);
        await wait(2500);
        await shoot(`${dir}/panel-labels-ring-tight.png`);
        st.set_string('system-style', 'bars');
        st.set_string('ai-style', 'icon');
        await wait(2500);
        await shoot(`${dir}/panel-bars.png`);
        st.reset('system-style');
        st.reset('ai-style');
        await wait(1000);
        const ind = ext._indicators;
        for (const name of ['ai', 'system', 'network']) {
            ind[name].menu.open(false);
            await wait(name === 'network' ? 9000 : 6000);
            await shoot(`${dir}/menu-${name}.png`);
            if (name === 'network') {
                ind.network._checkDns(true);
                await wait(9000);
                await shoot(`${dir}/menu-network-dns.png`);
                ind.network._speedtest();
                await wait(24000);
                await shoot(`${dir}/menu-network-speed.png`);
            }
            ind[name].menu.close(false);
            await wait(1000);
        }
        ext.openPreferences();
        await wait(7000);
        await shoot(`${dir}/prefs.png`);
        console.log('topbar-pulse selftest: done');
    } catch (e) {
        console.error(`topbar-pulse selftest: ${e.message}\n${e.stack}`);
    } finally {
        await shoot(`${dir}/done.png`);
    }
}
