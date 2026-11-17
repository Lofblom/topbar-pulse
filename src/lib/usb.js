// USB indicator: a small icon that only shows while external USB devices
// are plugged in. The menu names each device and, for serial adapters such
// as console cables, its /dev path – click to copy it, or open a console.
// Updates live from udev (no polling).

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GUdev from 'gi://GUdev';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {findProgram, openInTerminal, notifyError, label, hbox, vbox} from './util.js';

// Serial console programs and how each takes a device and a speed.
const CONSOLES = [
    ['tio', (dev, baud) => ['-b', String(baud), dev]],
    ['picocom', (dev, baud) => ['-b', String(baud), dev]],
    ['minicom', (dev, baud) => ['-D', dev, '-b', String(baud)]],
    ['screen', (dev, baud) => [dev, String(baud)]],
];

const ALL = !!GLib.getenv('TOPBAR_PULSE_USB_ALL');   // development: include built-in devices

export const UsbIndicator = GObject.registerClass(
class UsbIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, _('USB devices'), false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this.add_style_class_name('tp-compact');

        const box = hbox('panel-status-menu-box tp-tight');
        box.add_child(new St.Icon({icon_name: 'media-removable-symbolic', style_class: 'system-status-icon'}));
        this._count = label('', 'tp-bar-label');
        box.add_child(this._count);
        this.add_child(box);

        this._udev = new GUdev.Client({subsystems: ['usb/usb_device', 'tty']});
        this._ueventId = this._udev.connect('uevent', () => this._scheduleRefresh());
        this._refresh();
    }

    _scheduleRefresh() {
        // a device brings several events (usb, interfaces, tty); handle them once
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _devices() {
        const ttys = this._udev.query_by_subsystem('tty')
            .filter(t => t.get_device_file() && t.get_parent_with_subsystem('usb', 'usb_device'));
        const list = [];
        for (const d of this._udev.query_by_subsystem('usb')) {
            if (d.get_devtype() !== 'usb_device' || d.get_sysfs_attr('bDeviceClass') === '09')
                continue;   // interfaces and hubs
            if (!ALL && d.get_sysfs_attr('removable') === 'fixed')
                continue;   // built into the computer
            const path = d.get_sysfs_path();
            const serial = ttys.filter(t => t.get_parent_with_subsystem('usb', 'usb_device').get_sysfs_path() === path)
                .map(t => t.get_device_file());
            list.push({
                name: d.get_sysfs_attr('product') || d.get_property('ID_MODEL_FROM_DATABASE') ||
                    d.get_property('ID_MODEL') || _('USB device'),
                vendor: d.get_sysfs_attr('manufacturer') || d.get_property('ID_VENDOR_FROM_DATABASE') || '',
                port: d.get_name(),
                serial,
            });
        }
        // console cables first
        return list.sort((a, b) => (b.serial.length > 0) - (a.serial.length > 0) || a.name.localeCompare(b.name));
    }

    _refresh() {
        const devices = this._devices();
        const show = devices.length > 0;
        if (!show)
            this.menu.close();
        this.visible = show;
        if (this.container)
            this.container.visible = show;
        this._count.text = devices.length > 1 ? String(devices.length) : '';
        this._count.visible = devices.length > 1;

        this.menu.removeAll();
        for (const dev of devices) {
            if (dev.serial.length === 0) {
                this.menu.addMenuItem(this._row(dev.name, [dev.vendor, _('port %s').format(dev.port)].filter(Boolean).join(' · ')));
                continue;
            }
            for (const tty of dev.serial)
                this.menu.addMenuItem(this._row(dev.name, `${tty} · ${_('port %s').format(dev.port)}`, tty));
        }
    }

    _row(title, subtitle, tty = null) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: !!tty, can_focus: !!tty});
        if (!tty)
            item.remove_style_pseudo_class('insensitive');   // informational, not disabled
        const col = vbox(null, {x_expand: true});
        col.add_child(label(title));
        const sub = label(subtitle, 'tp-dim tp-small');
        col.add_child(sub);
        item.add_child(col);
        if (tty) {
            // click: copy the device path
            item.connect('activate', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, tty);
            });
            const btn = new St.Button({
                style_class: 'tp-icon-button',
                child: new St.Icon({icon_name: 'utilities-terminal-symbolic', icon_size: 14}),
                y_align: Clutter.ActorAlign.CENTER,
                can_focus: true,
                accessible_name: _('Open console on %s').format(tty),
            });
            btn.connect('clicked', () => {
                this.menu.close();
                this._openConsole(tty);
            });
            item.add_child(btn);
        }
        return item;
    }

    _openConsole(tty) {
        const baud = this._settings.get_int('usb-baud');
        for (const [name, args] of CONSOLES) {
            const prog = findProgram(name);
            if (prog) {
                openInTerminal([prog, ...args(tty, baud)]);
                return;
            }
        }
        notifyError(_('USB devices'), _('No serial console program found. Install tio, picocom, minicom or screen.'));
    }

    destroy() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        if (this._ueventId)
            this._udev.disconnect(this._ueventId);
        this._ueventId = 0;
        this._udev = null;
        super.destroy();
    }
});
