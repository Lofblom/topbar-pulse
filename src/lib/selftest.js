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

export async function run(ext, dir) {
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
