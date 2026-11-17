import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SERVICES, parseCustom, normalizeUrl} from './lib/ai/catalog.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, choices, subtitle = '') {
    const model = new Gtk.StringList();
    for (const [, text] of choices)
        model.append(text);
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        row.selected = Math.max(0, choices.findIndex(([v]) => v === settings.get_string(key)));
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    row.connect('notify::selected', () => {
        const v = choices[row.selected]?.[0];
        if (v && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    return row;
}

export default class TopbarPulsePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 760);
        window.search_enabled = true;
        window.add(this._topBarPage(settings));
        window.add(this._aiPage(settings, window));
        window.add(this._networkPage(settings));
        window.add(this._aboutPage());
    }

    // ---------------------------------------------------------- top bar

    _topBarPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Top bar'), icon_name: 'preferences-desktop-display-symbolic'});

        const show = new Adw.PreferencesGroup({title: _('Indicators')});
        show.add(switchRow(settings, 'show-system', _('System monitor'), _('CPU, GPU, memory, disk, sensors, processes')));
        show.add(switchRow(settings, 'show-ai', _('AI'), _('Subscription limits and quick launch')));
        show.add(switchRow(settings, 'show-network', _('Network'), _('Wi-Fi, public IP, VPN, DNS and speed test')));
        show.add(switchRow(settings, 'tighten-top-bar', _('Tighter top bar'),
            _('Less space between all icons on the right side of the top bar')));
        page.add(show);

        const sys = new Adw.PreferencesGroup({
            title: _('System monitor'),
            description: _('What the top bar shows. Everything is always in the menu. With everything off only the icon is shown.'),
        });
        sys.add(comboRow(settings, 'system-style', _('Style'), [
            ['labels', _('Text with labels')],
            ['compact', _('Colour-coded numbers')],
            ['bars', _('Small bars')],
        ]));
        sys.add(switchRow(settings, 'system-show-cpu', _('CPU'), _('Blue')));
        sys.add(switchRow(settings, 'system-show-gpu', _('GPU'), _('Purple')));
        sys.add(switchRow(settings, 'system-show-ram', _('RAM'), _('Green')));
        sys.add(switchRow(settings, 'system-show-temp', _('CPU temperature')));
        sys.add(switchRow(settings, 'system-show-icon', _('Show the icon'), _('The icon is always shown when nothing else is')));
        page.add(sys);

        const ai = new Adw.PreferencesGroup({title: _('AI')});
        ai.add(comboRow(settings, 'ai-style', _('Style'), [
            ['icon-percent', _('Icon and percentage')],
            ['icon', _('Icon only')],
            ['ring', _('Filling ring')],
        ], _('The percentage is the highest limit you are at right now')));
        page.add(ai);
        return page;
    }

    // --------------------------------------------------------------- AI

    _aiPage(settings, window) {
        const page = new Adw.PreferencesPage({title: _('AI'), icon_name: 'chat-message-new-symbolic'});

        const behaviour = new Adw.PreferencesGroup({title: _('Opening')});
        behaviour.add(comboRow(settings, 'ai-open-mode', _('Open web services as'), [
            ['app', _('App window')],
            ['browser', _('Browser tab')],
        ], _('App windows need Chromium, Chrome, Brave, Edge or Vivaldi; otherwise a tab is used. Services with a command-line tool get a terminal button in the menu.')));
        page.add(behaviour);

        const usage = new Adw.PreferencesGroup({
            title: _('Subscription limits'),
            description: _('Off until you turn them on. Each one uses the sign-in that the official command-line tool already keeps on this computer and asks only that company. The sign-in is never stored, logged or sent anywhere else, only over HTTPS with certificate checks and without redirects. The Claude and Copilot interfaces are unofficial and may stop working.'),
        });
        usage.add(switchRow(settings, 'ai-usage-claude', _('Claude Code'),
            _('Reads ~/.claude/.credentials.json and asks api.anthropic.com')));
        usage.add(switchRow(settings, 'ai-usage-codex', _('ChatGPT / Codex'),
            _('Asks the Codex CLI itself; Topbar Pulse never sees the sign-in')));
        usage.add(switchRow(settings, 'ai-usage-copilot', _('GitHub Copilot'),
            _('Runs “gh auth token” and asks api.github.com')));
        const spin = new Adw.SpinRow({
            title: _('Update every (minutes)'),
            adjustment: new Gtk.Adjustment({lower: 2, upper: 120, step_increment: 1}),
        });
        settings.bind('ai-refresh-minutes', spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        usage.add(spin);
        page.add(usage);

        const builtIn = new Adw.PreferencesGroup({title: _('Services'), description: _('Shown in the AI menu.')});
        const enabled = () => new Set(settings.get_strv('ai-services'));
        for (const svc of SERVICES) {
            const extras = [];
            if (svc.usage)
                extras.push(_('limits'));
            if (svc.cli)
                extras.push(_('CLI: %s').format(svc.cli));
            const row = new Adw.SwitchRow({title: svc.name, subtitle: [svc.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), ...extras].join(' · ')});
            row.add_prefix(this._serviceIcon(svc));
            row.active = enabled().has(svc.id);
            row.connect('notify::active', () => {
                const set = enabled();
                if (row.active)
                    set.add(svc.id);
                else
                    set.delete(svc.id);
                settings.set_strv('ai-services', SERVICES.map(s => s.id).filter(id => set.has(id)));
            });
            builtIn.add(row);
        }
        page.add(builtIn);

        const custom = new Adw.PreferencesGroup({
            title: _('Your own services'),
            description: _('Any AI chat on the web, or a command-line tool.'),
        });
        const addBtn = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Add service')});
        addBtn.add_css_class('flat');
        custom.set_header_suffix(addBtn);
        const rows = [];
        const rebuild = () => {
            for (const r of rows.splice(0))
                custom.remove(r);
            const list = parseCustom(settings.get_string('ai-custom-services'));
            if (list.length === 0) {
                const empty = new Adw.ActionRow({title: _('No services added yet'), sensitive: false});
                rows.push(empty);
                custom.add(empty);
            }
            for (const svc of list) {
                const row = new Adw.ActionRow({title: svc.name, subtitle: [svc.url, svc.cli].filter(Boolean).join(' · ')});
                const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Remove')});
                del.add_css_class('flat');
                del.connect('clicked', () => {
                    const next = parseCustom(settings.get_string('ai-custom-services')).filter(s => s.id !== svc.id);
                    settings.set_string('ai-custom-services', JSON.stringify(next.map(({id, name, url, cli}) => ({id, name, url, cli}))));
                });
                row.add_suffix(del);
                rows.push(row);
                custom.add(row);
            }
        };
        rebuild();
        const id = settings.connect('changed::ai-custom-services', rebuild);
        page.connect('destroy', () => settings.disconnect(id));
        addBtn.connect('clicked', () => this._addServiceDialog(settings, window));
        page.add(custom);
        return page;
    }

    _serviceIcon(svc) {
        if (svc.icon) {
            const path = this.dir.get_child('icons').get_child('ai').get_child(svc.icon).get_path();
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                return new Gtk.Image({file: path, pixel_size: 20});
        }
        const l = new Gtk.Label({label: svc.name.charAt(0), width_request: 20, height_request: 20});
        l.add_css_class('caption-heading');
        return l;
    }

    _addServiceDialog(settings, window) {
        const dialog = new Adw.AlertDialog({
            heading: _('Add AI service'),
            body: _('Give it a name and a web address, a command, or both.'),
        });
        const box = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        box.add_css_class('boxed-list');
        const name = new Adw.EntryRow({title: _('Name')});
        const url = new Adw.EntryRow({title: _('Web address (e.g. chat.example.com)')});
        const cli = new Adw.EntryRow({title: _('Command (optional, e.g. aider)')});
        box.append(name);
        box.append(url);
        box.append(cli);
        dialog.set_extra_child(box);
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('add', _('Add'));
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('add');
        const valid = () => name.text.trim() !== '' && (url.text.trim() !== '' || cli.text.trim() !== '');
        const sync = () => dialog.set_response_enabled('add', valid());
        for (const e of [name, url, cli])
            e.connect('changed', sync);
        sync();
        dialog.connect('response', (_d, response) => {
            if (response !== 'add' || !valid())
                return;
            const list = parseCustom(settings.get_string('ai-custom-services'));
            list.push({
                id: `custom-${GLib.uuid_string_random().slice(0, 8)}`,
                name: name.text.trim(),
                url: normalizeUrl(url.text),
                cli: cli.text.trim(),
            });
            settings.set_string('ai-custom-services', JSON.stringify(list.map(({id, name: n, url: u, cli: c}) => ({id, name: n, url: u, cli: c}))));
        });
        dialog.present(window);
    }

    // ---------------------------------------------------------- network

    _networkPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Network'), icon_name: 'network-wireless-symbolic'});

        const panel = new Adw.PreferencesGroup({title: _('Top bar')});
        panel.add(switchRow(settings, 'network-hide-gnome', _('Hide GNOME’s own network icon'),
            _('Avoids two network icons. The Wi-Fi button in Quick Settings stays.')));
        panel.add(comboRow(settings, 'network-show-country', _('Show the country of your public IP'), [
            ['never', _('Never')],
            ['vpn', _('When a VPN is active')],
            ['always', _('Always')],
        ]));
        page.add(panel);

        const pub = new Adw.PreferencesGroup({
            title: _('Public IP and DNS'),
            description: _('Shows the address, location and provider the internet sees (from ipleak.net), and which DNS servers really answer for you (DNS leak test from bash.ws). Re-checked when the network or VPN changes.'),
        });
        pub.add(switchRow(settings, 'network-public-ip', _('Check public IP and DNS')));
        page.add(pub);

        const dns = new Adw.PreferencesGroup({
            title: _('Custom DNS'),
            description: _('Servers for the “Custom” choice in the DNS menu, separated by spaces. IPv4 and IPv6 both work.'),
        });
        const entry = new Adw.EntryRow({title: _('DNS servers'), show_apply_button: true});
        entry.text = settings.get_string('network-custom-dns');
        entry.connect('apply', () => settings.set_string('network-custom-dns', entry.text.trim()));
        dns.add(entry);
        page.add(dns);

        const speed = new Adw.PreferencesGroup({
            title: _('Speed test'),
            description: _('Download from a public test server, upload to Cloudflare. Runs only when you press the button.'),
        });
        speed.add(comboRow(settings, 'speedtest-server', _('Server'), [
            ['tele2', _('Tele2 (Sweden)')],
            ['hetzner-fsn', _('Hetzner (Germany)')],
            ['hetzner-hel', _('Hetzner (Finland)')],
            ['hetzner-ash', _('Hetzner (USA East)')],
            ['hetzner-hil', _('Hetzner (USA West)')],
            ['hetzner-sin', _('Hetzner (Singapore)')],
        ]));
        page.add(speed);
        return page;
    }

    // ------------------------------------------------------------ about

    _aboutPage() {
        const page = new Adw.PreferencesPage({title: _('About'), icon_name: 'help-about-symbolic'});
        const group = new Adw.PreferencesGroup();
        const status = new Adw.StatusPage({
            icon_name: 'utilities-system-monitor-symbolic',
            title: 'Topbar Pulse',
            description: _('System monitor, network details and AI usage in the top bar.'),
        });
        group.add(status);
        const links = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({title: _('Source code and issues'), subtitle: this.metadata.url ?? '', activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () => Gtk.show_uri(null, this.metadata.url, 0));
        links.add(row);
        const credit = new Adw.ActionRow({
            title: _('Credits'),
            subtitle: _('Inspired by the Omarchy desktop; the AI usage endpoints follow Omarchy’s collectors (MIT). Service logos belong to their owners.'),
        });
        links.add(credit);
        page.add(group);
        page.add(links);
        return page;
    }
}
