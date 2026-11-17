// A small JSON-over-HTTP helper on libsoup 3 (part of every GNOME session).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {decoder} from './util.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'send_async');

export const USER_AGENT = 'TopbarPulse/1.0 (GNOME Shell extension)';

export function newSession(timeout = 15) {
    return new Soup.Session({user_agent: USER_AGENT, timeout});
}

// GET (or POST with a JSON body) and parse JSON. Never throws for HTTP
// errors: returns {status, data, text}.
//
// credentials: true marks a request that carries a sign-in token. It must
// use HTTPS (libsoup verifies the certificate against the system store) and
// never follows redirects, so the token can only reach the host named here.
export async function fetchJson(session, url, {headers = {}, method = 'GET', body = null, cancellable = null, credentials = false} = {}) {
    if (credentials && !url.startsWith('https://'))
        throw new Error('Refusing to send a sign-in over plain HTTP');
    const msg = Soup.Message.new(method, url);
    if (!msg)
        throw new Error(`Invalid URL: ${url}`);
    if (credentials)
        msg.set_flags(msg.get_flags() | Soup.MessageFlags.NO_REDIRECT);
    msg.request_headers.append('Accept', 'application/json');
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.append(k, v);
    if (body !== null)
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
    const text = decoder.decode(bytes.toArray());
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {}
    return {status: msg.get_status(), data, text, headers: msg.response_headers};
}
