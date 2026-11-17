// Internet speed test on libsoup: downloads from a public test server,
// then uploads, each phase for a fixed time. Reports the
// running rate as it goes.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {isCancelled} from './util.js';
import {USER_AGENT} from './http.js';

// Public speed-test endpoints run for exactly this purpose.
// Tele2 throttles several connections from one address, so it gets one
// stream; Hetzner handles a few in parallel.
export const SERVERS = {
    'tele2': {name: 'Tele2 (Sweden)', down: 'http://speedtest.tele2.net/10GB.zip', streams: 1},
    'hetzner-fsn': {name: 'Hetzner (Germany)', down: 'https://fsn1-speed.hetzner.com/10GB.bin', streams: 2},
    'hetzner-hel': {name: 'Hetzner (Finland)', down: 'https://hel1-speed.hetzner.com/10GB.bin', streams: 2},
    'hetzner-ash': {name: 'Hetzner (USA East)', down: 'https://ash-speed.hetzner.com/10GB.bin', streams: 2},
    'hetzner-hil': {name: 'Hetzner (USA West)', down: 'https://hil-speed.hetzner.com/10GB.bin', streams: 2},
    'hetzner-sin': {name: 'Hetzner (Singapore)', down: 'https://sin-speed.hetzner.com/10GB.bin', streams: 2},
};
// Cloudflare's upload sink answers from the nearest data centre.
const UPLOAD_URL = 'https://speed.cloudflare.com/__up';

const UPLOAD_STREAMS = 2;
const PHASE_SECONDS = 8;
const WARMUP_SECONDS = 1.5;   // ignore TCP slow start
const UPLOAD_CHUNK = 4 * 1024 * 1024;

export class SpeedTest {
    constructor(serverId, onProgress) {
        this._server = SERVERS[serverId] ?? SERVERS['tele2'];
        this._onProgress = onProgress;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 20, max_conns_per_host: 6});
        this.result = {down: null, up: null, ping: null, server: this._server.name};
    }

    cancel() {
        this._cancellable.cancel();
        this._session.abort();
    }

    async run() {
        this.result.ping = await this._ping();
        this.result.down = await this._phase('down');
        if (this._cancellable.is_cancelled())
            return this.result;
        this.result.up = await this._phase('up');
        return this.result;
    }

    async _ping() {
        // Time a small HTTP request (after one warm-up to open the connection).
        const url = this._server.down;
        const once = async () => {
            const msg = Soup.Message.new('HEAD', url);
            const t0 = GLib.get_monotonic_time();
            await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
            return (GLib.get_monotonic_time() - t0) / 1000;
        };
        try {
            await once();
            const times = [];
            for (let i = 0; i < 3; i++)
                times.push(await once());
            return Math.min(...times);
        } catch {
            return null;
        }
    }

    _phase(kind) {
        return new Promise(resolve => {
            let bytes = 0;
            let measuredFrom = null, bytesAtStart = 0;
            const t0 = GLib.get_monotonic_time();
            const phaseCancel = new Gio.Cancellable();
            const cancelId = this._cancellable.connect(() => phaseCancel.cancel());
            const elapsed = () => (GLib.get_monotonic_time() - t0) / 1e6;
            const rate = () => {
                if (measuredFrom === null)
                    return elapsed() > 0 ? bytes * 8 / elapsed() / 1e6 : 0;
                const dt = elapsed() - measuredFrom;
                return dt > 0 ? (bytes - bytesAtStart) * 8 / dt / 1e6 : 0;
            };

            const tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                if (measuredFrom === null && elapsed() >= WARMUP_SECONDS) {
                    measuredFrom = elapsed();
                    bytesAtStart = bytes;
                }
                this._onProgress?.(kind, rate());
                if (elapsed() >= PHASE_SECONDS + WARMUP_SECONDS || phaseCancel.is_cancelled()) {
                    phaseCancel.cancel();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });

            const workers = [];
            const streams = kind === 'down' ? this._server.streams ?? 2 : UPLOAD_STREAMS;
            for (let i = 0; i < streams; i++)
                workers.push(kind === 'down' ? this._download(n => (bytes += n), phaseCancel) : this._upload(n => (bytes += n), phaseCancel));

            Promise.allSettled(workers).then(results => {
                GLib.source_remove(tick);
                this._cancellable.disconnect(cancelId);
                const anyOk = bytes > 0;
                const failed = results.every(r => r.status === 'rejected' && !isCancelled(r.reason));
                resolve(anyOk && !failed ? rate() : null);
            });
        });
    }

    async _download(add, cancellable) {
        const msg = Soup.Message.new('GET', this._server.down);
        try {
            const stream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
            if (msg.status_code !== 200)
                throw new Error(`HTTP ${msg.status_code}`);
            for (;;) {
                const chunk = await stream.read_bytes_async(256 * 1024, GLib.PRIORITY_DEFAULT, cancellable);
                const n = chunk.get_size();
                if (n === 0)
                    break;
                add(n);
            }
        } catch (e) {
            if (!isCancelled(e))
                throw e;
        }
    }

    async _upload(add, cancellable) {
        const body = new GLib.Bytes(new Uint8Array(UPLOAD_CHUNK));
        while (!cancellable.is_cancelled()) {
            const msg = Soup.Message.new('POST', UPLOAD_URL);
            msg.set_request_body_from_bytes('application/octet-stream', body);
            msg.connect('wrote-body-data', (_m, n) => add(n));
            try {
                await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
                if (msg.status_code >= 400)
                    throw new Error(`HTTP ${msg.status_code}`);
            } catch (e) {
                if (isCancelled(e))
                    return;
                throw e;
            }
        }
    }
}
