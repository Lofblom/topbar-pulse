// Usage readers for AI subscriptions. Each is off until the user turns it on
// in the preferences. A reader uses the sign-in the official CLI already
// keeps on this machine and asks only that provider for the current limits.
//
// How sign-ins are handled:
//  - read at the moment of the request, kept only in a local variable,
//    never stored, cached, logged or shown;
//  - sent only as an Authorization header to the provider's fixed HTTPS
//    address, with certificate checks and no redirects (http.js);
//  - Codex: the extension never sees the sign-in at all; the Codex CLI's
//    own app-server makes the request.
// The Claude and Copilot endpoints are unofficial and may change.
//
// A reader returns null when the service is not set up here, otherwise
//   {plan, limits: [{title, percent (0–1), resetsAt}], note, stale}
//
// Endpoints and parsing follow Omarchy's agent usage collectors (MIT).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {readJson, findProgram, run, decoder, encoder} from '../util.js';
import {fetchJson} from '../http.js';

// ------------------------------------------------------------------ Claude

const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage';

function claudeDir() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

// The credentials keep the tier the token was minted with; the CLI's profile
// is refreshed against the account, so its tier is asked first. The plan
// leads and the multiplier qualifies it ("Max 5x", "Team 5x").
function claudeProfileTier() {
    const dir = claudeDir();
    const legacy = GLib.build_filenamev([dir, '.config.json']);
    const isDefault = !GLib.getenv('CLAUDE_CONFIG_DIR');
    const path = GLib.file_test(legacy, GLib.FileTest.EXISTS) ? legacy
        : isDefault ? GLib.build_filenamev([GLib.get_home_dir(), '.claude.json'])
            : GLib.build_filenamev([dir, '.claude.json']);
    const acc = readJson(path)?.oauthAccount ?? {};
    return String(acc.userRateLimitTier || acc.organizationRateLimitTier || '');
}

function claudePlan(o) {
    let tier = claudeProfileTier();
    if (!/max_\d+x/i.test(tier))
        tier = String(o.rateLimitTier ?? '');
    const sub = String(o.subscriptionType ?? '');
    const plan = sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : '';
    const m = tier.match(/max_(\d+x)/i);
    return m ? `${plan || 'Max'} ${m[1]}` : plan;
}

function windowWord(kind) {
    const k = String(kind).toLowerCase();
    if (k.includes('month'))
        return _('month');
    if (k.includes('week') || k.includes('day'))
        return _('week');
    if (k.includes('hour') || k.includes('session'))
        return _('session');
    return '';
}

export async function claudeUsage(session, cancellable) {
    const creds = readJson(GLib.build_filenamev([claudeDir(), '.credentials.json']))?.claudeAiOauth;
    if (!creds?.accessToken)
        return null;
    const plan = claudePlan(creds);
    // Only Claude Code refreshes its own token; using a stale one would fail.
    if (creds.expiresAt && creds.expiresAt < Date.now())
        return {plan, limits: [], stale: true, note: _('Sign-in has expired. Start Claude Code once to renew it.')};

    const {status, data} = await fetchJson(session, CLAUDE_USAGE, {
        cancellable,
        credentials: true,
        headers: {'Authorization': `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20'},
    });
    if (status === 401 || status === 403)
        return {plan, limits: [], stale: true, note: _('Not signed in. Run “claude” and sign in.')};
    if (status === 429)
        return {plan, limits: [], stale: true, rateLimited: true};
    if (status !== 200 || !data)
        throw new Error(`Anthropic HTTP ${status}`);

    const limits = [];
    const pct = v => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) / 100 : null);
    const add = (title, bucket) => {
        const p = pct(bucket?.utilization);
        if (p !== null)
            limits.push({title, percent: p, resetsAt: bucket.resets_at ?? ''});
    };
    add(_('Session (5 h)'), data.five_hour);
    add(_('Week'), data.seven_day);
    // Model-scoped allowances (e.g. a weekly limit only one model draws from)
    const seen = new Set();
    for (const e of Array.isArray(data.limits) ? data.limits : []) {
        const model = e?.scope?.model;
        const name = String(model?.display_name ?? model?.id ?? '').trim();
        const kind = String(e?.kind ?? '');
        const p = pct(e?.percent);
        if (!name || p === null || seen.has(`${name}|${kind}`))
            continue;
        seen.add(`${name}|${kind}`);
        const w = windowWord(kind);
        limits.push({title: w ? `${name} (${w})` : name, percent: p, resetsAt: e.resets_at ?? ''});
    }
    return {plan, limits};
}

// Today's tokens from the transcripts, in a separate gjs process.
export async function claudeToday(extDir, cancellable) {
    const script = extDir.get_child('lib').get_child('ai').get_child('claude-today.js').get_path();
    const gjs = findProgram('gjs') ?? 'gjs';
    const r = await run([gjs, '-m', script], cancellable);
    return r.ok ? JSON.parse(r.out) : null;
}

// ------------------------------------------------------------------- Codex

function codexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

const CODEX_PLANS = {plus: 'Plus', pro: 'Pro', promax: 'Pro', team: 'Business', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', go: 'Go', free: 'Free'};

function codexWindowTitle(mins) {
    if (mins === 300)
        return _('Session (5 h)');
    if (mins === 10080)
        return _('Week');
    if (mins >= 28 * 1440)
        return _('Month');
    if (mins && mins % 60 === 0)
        return _('%d h window').format(mins / 60);
    return _('Limit');
}

// Ask the Codex CLI's own app-server (JSON-RPC over stdio) for the limits.
export async function codexUsage(cancellable) {
    const auth = readJson(GLib.build_filenamev([codexHome(), 'auth.json']));
    const codex = findProgram('codex');
    if (!auth || !codex)
        return null;
    const chatgpt = auth.auth_mode ? auth.auth_mode !== 'apikey' : !!auth.tokens;
    if (!chatgpt)
        return null;   // API-key login: no plan limits to show

    const proc = Gio.Subprocess.new([codex, '-s', 'read-only', '-a', 'on-request', 'app-server'],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const inner = new Gio.Cancellable();
    const outerId = cancellable?.connect(() => inner.cancel());
    const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
        inner.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const stdin = proc.get_stdin_pipe();
    const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const send = obj => stdin.write_all_async(encoder.encode(`${JSON.stringify(obj)}\n`), GLib.PRIORITY_DEFAULT, inner);
    const waitFor = async id => {
        for (;;) {
            const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, inner);
            if (line === null)
                throw new Error('codex app-server closed');
            let msg;
            try {
                msg = JSON.parse(decoder.decode(line));
            } catch {
                continue;
            }
            if (msg.id === id)
                return msg;
        }
    };
    try {
        await send({id: 1, method: 'initialize', params: {clientInfo: {name: 'topbar-pulse', version: '1'}}});
        await waitFor(1);
        await send({method: 'initialized', params: {}});
        await send({id: 2, method: 'account/rateLimits/read', params: {}});
        const res = await waitFor(2);
        if (res.error)
            return {plan: '', limits: [], stale: true, note: _('Codex could not read the limits. Run “codex” and sign in.')};
        const result = res.result ?? {};
        let buckets = [];
        if (result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object')
            buckets = Object.entries(result.rateLimitsByLimitId).sort(([a], [b]) => (a !== 'codex') - (b !== 'codex'));
        else if (result.rateLimits)
            buckets = [['codex', result.rateLimits]];
        const limits = [];
        let plan = '';
        for (const [id, b] of buckets) {
            plan ||= b?.planType ?? '';
            const general = id === 'codex' || buckets.length === 1;
            const prefix = general ? '' : `${b?.limitName || id} `;
            for (const w of [b?.primary, b?.secondary]) {
                const used = Number(w?.usedPercent);
                if (!Number.isFinite(used))
                    continue;
                const reset = Number(w.resetsAt);
                limits.push({
                    title: prefix + codexWindowTitle(Number(w.windowDurationMins)),
                    percent: Math.max(0, used) / 100,
                    resetsAt: reset > 0 ? reset : '',
                });
            }
        }
        return {plan: CODEX_PLANS[String(plan).toLowerCase()] ?? plan, limits};
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return {plan: '', limits: [], stale: true, note: _('Codex did not answer in time.')};
    } finally {
        GLib.source_remove(timeout);
        if (outerId)
            cancellable.disconnect(outerId);
        proc.force_exit();
    }
}

// ----------------------------------------------------------------- Copilot

const COPILOT_PLANS = {individual: 'Pro', individual_pro: 'Pro+', business: 'Business', enterprise: 'Enterprise', free: 'Free'};

async function githubToken(cancellable) {
    for (const v of ['COPILOT_QUOTA_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
        if (GLib.getenv(v))
            return GLib.getenv(v);
    }
    const gh = findProgram('gh');
    if (!gh)
        return null;
    // gh may wait on a locked keyring; never let that hold up the menu.
    const inner = new Gio.Cancellable();
    const outerId = cancellable?.connect(() => inner.cancel());
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        inner.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const r = await run([gh, 'auth', 'token'], inner);
        return r.ok ? r.out.trim() : null;
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return null;
    } finally {
        if (!inner.is_cancelled())
            GLib.source_remove(timer);
        if (outerId)
            cancellable.disconnect(outerId);
    }
}

export async function copilotUsage(session, cancellable) {
    const token = await githubToken(cancellable);
    if (!token)
        return null;
    const {status, data} = await fetchJson(session, 'https://api.github.com/copilot_internal/user', {
        cancellable,
        credentials: true,
        headers: {'Authorization': `Bearer ${token}`},
    });
    if (status === 401 || status === 404)
        return null;   // not a Copilot user
    if (status !== 200 || !data)
        throw new Error(`GitHub HTTP ${status}`);
    const plan = COPILOT_PLANS[String(data.copilot_plan ?? '').toLowerCase()] ?? '';
    const snap = data.quota_snapshots?.premium_interactions;
    const limits = [];
    if (snap && snap.unlimited !== true) {
        const ent = Number(snap.entitlement);
        let used = Number(snap.credits_used);
        if (!Number.isFinite(used)) {
            const remaining = Number(snap.remaining ?? snap.quota_remaining);
            const pctLeft = Number(snap.percent_remaining);
            if (Number.isFinite(remaining) && ent > 0)
                used = Math.max(0, ent - remaining);
            else if (Number.isFinite(pctLeft) && ent > 0)
                used = ent * Math.max(0, 100 - pctLeft) / 100;
        }
        if (ent > 0 && Number.isFinite(used))
            limits.push({title: _('Premium requests'), percent: used / ent, resetsAt: data.quota_reset_date_utc ?? '', detail: `${Math.round(used)} / ${Math.round(ent)}`});
    }
    return {plan, limits, note: snap?.unlimited ? _('Unlimited premium requests') : ''};
}

export const READERS = {
    claude: (session, c) => claudeUsage(session, c),
    codex: (_session, c) => codexUsage(c),
    copilot: (session, c) => copilotUsage(session, c),
};
