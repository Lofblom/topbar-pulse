// Topbar Pulse – system monitor, network details and AI usage in the
// GNOME top bar.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SystemIndicator} from './lib/system.js';
import {NetworkIndicator} from './lib/network.js';
import {AiIndicator} from './lib/ai/indicator.js';

const INDICATORS = [
    ['system', 'show-system', SystemIndicator],
    ['ai', 'show-ai', AiIndicator],
    ['network', 'show-network', NetworkIndicator],
];

export default class TopbarPulseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicators = {};
        this._ids = INDICATORS.map(([, key]) =>
            this._settings.connect(`changed::${key}`, () => this._sync()));
        this._ids.push(this._settings.connect('changed::tighten-top-bar', () => this._syncTight()));
        this._sync();
        this._syncTight();

        const selftest = GLib.getenv('TOPBAR_PULSE_SELFTEST');
        if (selftest)
            import('./lib/selftest.js').then(m => m.run(this, selftest)).catch(e => console.error(e));
    }

    // Create or remove each indicator to match the settings, keeping order.
    _sync() {
        INDICATORS.forEach(([name, key, Klass], index) => {
            const want = this._settings.get_boolean(key);
            const have = this._indicators[name];
            if (want && !have) {
                const ind = new Klass(this);
                this._indicators[name] = ind;
                Main.panel.addToStatusArea(`${this.uuid}-${name}`, ind, index, 'right');
            } else if (!want && have) {
                have.destroy();
                delete this._indicators[name];
            }
        });
    }

    _syncTight() {
        if (this._settings.get_boolean('tighten-top-bar'))
            Main.panel.add_style_class_name('tp-tight-panel');
        else
            Main.panel.remove_style_class_name('tp-tight-panel');
    }

    disable() {
        Main.panel.remove_style_class_name('tp-tight-panel');
        for (const id of this._ids ?? [])
            this._settings.disconnect(id);
        this._ids = null;
        for (const ind of Object.values(this._indicators ?? {}))
            ind.destroy();
        this._indicators = null;
        this._settings = null;
    }

    icon(name) {
        return new Gio.FileIcon({file: this.dir.get_child('icons').get_child(name)});
    }
}
