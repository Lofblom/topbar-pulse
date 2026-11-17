// AI indicator: usage limits for the subscriptions set up on this machine,
// and a launcher for every AI service the user picked (web app window,
// browser tab, or the service's CLI in a terminal).

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
    isCancelled, debug, findProgram, clamp01, fmtTokens, fmtResetIn, label, hbox, vbox, Meter,
    openUri, openAppWindow, openInTerminal,
} from '../util.js';
import {newSession} from '../http.js';
import {allServices, normalizeUrl} from './catalog.js';
import {READERS, claudeToday} from './usage.js';

const MIN_REFRESH_SEC = 60;

export const AiIndicator = GObject.registerClass(
class AiIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, _('AI'), false);
        this._ext = ext;
        this._settings = ext.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._session = newSession();
        this._usage = {};       // reader id -> result
        this._errors = {};
        this._today = null;
        this._lastRefresh = 0;
        this._maxPct = -1;
        this.add_style_class_name('tp-compact');

        const box = hbox('panel-status-menu-box tp-tight');
        this._icon = new St.Icon({gicon: ext.icon('ai-symbolic.svg'), style_class: 'system-status-icon'});
        this._ring = new St.DrawingArea({style_class: 'tp-ring', y_align: Clutter.ActorAlign.CENTER});
        this._ring.connect('repaint', a => this._paintRing(a));
        this._barLabel = label('', 'tp-bar-label');
        this._barLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._icon);
        box.add_child(this._ring);
        box.add_child(this._barLabel);
        this.add_child(box);

        this._usageSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._usageSection);
        this._openSep = new PopupMenu.PopupSeparatorMenuItem(_('Open'));
        this.menu.addMenuItem(this._openSep);
        this._openSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._openSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Refresh'), () => this._refresh(true));
        this.menu.addAction(_('Topbar Pulse settings…'), () => ext.openPreferences());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(false);
        });

        this._settingsIds = ['ai-services', 'ai-custom-services', 'ai-open-mode', 'ai-track-usage']
            .map(k => this._settings.connect(`changed::${k}`, () => {
                this._buildOpenList();
                this._render();
                this._lastRefresh = 0;
                this._refresh(true);
            }));
        this._settingsIds.push(this._settings.connect('changed::ai-style', () => this._applyStyle()));

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            const every = Math.max(2, this._settings.get_int('ai-refresh-minutes')) * 60;
            if (GLib.get_monotonic_time() / 1e6 - this._lastRefresh >= every)
                this._refresh(true);
            return GLib.SOURCE_CONTINUE;
        });

        this._buildOpenList();
        this._applyStyle();
        this._render();
        this._startupId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._startupId = 0;
            this._refresh(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _services() {
        const enabled = new Set(this._settings.get_strv('ai-services'));
        return allServices(this._settings.get_string('ai-custom-services'))
            .filter(s => enabled.has(s.id) || s.custom);
    }

    // --------------------------------------------------------------- data

    async _refresh(force) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._busy || (!force && now - this._lastRefresh < MIN_REFRESH_SEC))
            return;
        if (force && now - this._lastRefresh < 10)
            return;
        this._busy = true;
        this._lastRefresh = now;
        const track = this._settings.get_boolean('ai-track-usage');
        const readers = track ? [...new Set(this._services().map(s => s.usage).filter(Boolean))] : [];
        debug('refresh readers', readers.join(','));
        const jobs = readers.map(async id => {
            try {
                const res = await READERS[id](this._session, this._cancellable);
                debug(`usage ${id}:`, JSON.stringify(res));
                if (res?.rateLimited && this._usage[id]) {
                    this._usage[id].stale = true;   // keep the last numbers
                } else {
                    this._usage[id] = res;
                }
                delete this._errors[id];
            } catch (e) {
                if (isCancelled(e))
                    return;
                debug(`usage ${id} failed:`, e.message);
                this._errors[id] = e.message;
                if (this._usage[id])
                    this._usage[id].stale = true;
            }
            if (!this._cancellable.is_cancelled())
                this._render();
        });
        if (readers.includes('claude')) {
            jobs.push(claudeToday(this._ext.dir, this._cancellable)
                .then(t => (this._today = t)).catch(() => null));
        }
        for (const id of Object.keys(this._usage)) {
            if (!readers.includes(id))
                delete this._usage[id];
        }
        await Promise.all(jobs);
        this._busy = false;
        if (!this._cancellable.is_cancelled())
            this._render();
    }

    // ----------------------------------------------------------------- UI

    _badge(service, size = 16) {
        if (service.icon) {
            const file = this._ext.dir.get_child('icons').get_child('ai').get_child(service.icon);
            if (file.query_exists(null))
                return new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size});
        }
        const letter = (service.name || '?').trim().charAt(0).toUpperCase();
        return new St.Label({
            text: letter,
            style_class: 'tp-badge',
            style: `background-color: ${service.color ?? '#6b7280'};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _render() {
        this._usageSection.removeAll();
        let maxPct = -1;
        const services = this._services();
        for (const svc of services) {
            const u = svc.usage ? this._usage[svc.usage] : null;
            const err = svc.usage ? this._errors[svc.usage] : null;
            if (!u && !err)
                continue;
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const col = vbox('tp-sec', {x_expand: true});
            const head = hbox('tp-head');
            head.add_child(this._badge(svc));
            head.add_child(label(svc.name, 'tp-sec-title'));
            if (u?.plan)
                head.add_child(label(u.plan, 'tp-dim'));
            col.add_child(head);
            for (const l of u?.limits ?? []) {
                const m = new Meter(l.title, 130);
                const pct = clamp01(l.percent);
                maxPct = Math.max(maxPct, pct);
                m.set(pct, `${Math.round(l.percent * 100)}%`, [l.detail, fmtResetIn(l.resetsAt)].filter(Boolean).join(' · '));
                col.add_child(m.actor);
            }
            if (svc.usage === 'claude' && this._today) {
                const t = this._today;
                const fresh = t.input + t.output + t.cache_write;
                col.add_child(label(_('Today: %s new tokens (%s written by Claude)').format(fmtTokens(fresh), fmtTokens(t.output)), 'tp-dim'));
                if (t.cache_read > 0) {
                    const l = label(_('+ %s re-read from cache – the conversation is sent again at every step').format(fmtTokens(t.cache_read)), 'tp-dim tp-small');
                    l.clutter_text.line_wrap = true;
                    col.add_child(l);
                }
            }
            const note = u?.note || (err ? _('Could not update: %s').format(err) : '');
            if (note)
                col.add_child(label(note, 'tp-warn'));
            else if (u?.stale)
                col.add_child(label(_('Showing the last known numbers'), 'tp-dim tp-small'));
            item.add_child(col);
            this._usageSection.addMenuItem(item);
        }
        this._maxPct = maxPct;
        this._barLabel.text = maxPct >= 0 ? `${Math.round(maxPct * 100)}%` : '';
        this._applyStyle();
    }

    _buildOpenList() {
        this._openSection.removeAll();
        const mode = this._settings.get_string('ai-open-mode');
        const services = this._services();
        this._openSep.visible = services.length > 0;
        for (const svc of services) {
            const item = new PopupMenu.PopupBaseMenuItem();
            item.add_child(this._badge(svc));
            item.add_child(label(svc.name, null, {x_expand: true}));
            const cliPath = svc.cli ? findProgram(svc.cli) : null;
            if (svc.url) {
                item.connect('activate', () => {
                    const url = normalizeUrl(svc.url);
                    if (mode === 'browser')
                        openUri(url);
                    else
                        openAppWindow(url);
                });
            } else if (cliPath) {
                item.connect('activate', () => openInTerminal([cliPath]));
            }
            if (cliPath && svc.url) {
                const btn = new St.Button({
                    style_class: 'tp-icon-button',
                    child: new St.Icon({icon_name: 'utilities-terminal-symbolic', icon_size: 14}),
                    can_focus: true,
                    accessible_name: _('Open %s in a terminal').format(svc.cli),
                });
                btn.connect('clicked', () => {
                    this.menu.close();
                    openInTerminal([cliPath]);
                });
                item.add_child(btn);
            }
            this._openSection.addMenuItem(item);
        }
    }

    _applyStyle() {
        const style = this._settings.get_string('ai-style');
        this._icon.visible = style !== 'ring';
        this._ring.visible = style === 'ring';
        this._barLabel.visible = style === 'icon-percent' && this._barLabel.text !== '';
        this._ring.queue_repaint();
    }

    _paintRing(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const r = Math.min(w, h) / 2 - 2;
        const cx = w / 2, cy = h / 2;
        const pct = clamp01(this._maxPct);
        const fg = this.get_theme_node().get_foreground_color();
        cr.setLineWidth(2.5);
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, 0.3);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();
        if (pct > 0) {
            const [rr, gg, bb] = pct >= 0.9 ? [0.90, 0.33, 0.29] : pct >= 0.7 ? [0.94, 0.70, 0.35]
                : [fg.red / 255, fg.green / 255, fg.blue / 255];
            cr.setSourceRGBA(rr, gg, bb, 1);
            cr.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.max(0.08, pct) * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        for (const id of [this._timer, this._startupId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._startupId = 0;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        super.destroy();
    }
});
