// What the internet sees: public IP and location (ipleak.net) and which DNS
// resolvers actually answer for this machine (bash.ws DNS leak test).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {fetchJson} from './http.js';

Gio._promisify(Gio.Resolver.prototype, 'lookup_by_name_async');

// {ip, country, countryCode, city, region, isp, asn, reverse}
export async function publicIp(session, cancellable) {
    const {status, data} = await fetchJson(session, 'https://ipleak.net/json/', {cancellable});
    if (status !== 200 || !data?.ip)
        throw new Error(`ipleak.net HTTP ${status}`);
    return {
        ip: data.ip,
        country: data.country_name ?? '',
        countryCode: data.country_code ?? '',
        city: data.city_name ?? '',
        region: data.region_name ?? '',
        isp: data.isp_name ?? '',
        asn: data.as_number ? `AS${data.as_number}` : '',
        reverse: data.reverse ?? '',
    };
}

// Resolve unique names under a bash.ws test id, then ask which resolvers
// were seen. Returns {ip: {...}, servers: [{ip, country, countryCode, org, asn}]}.
export async function dnsLeakTest(session, cancellable, lookups = 10) {
    const idRes = await fetchJson(session, 'https://bash.ws/id', {cancellable});
    const id = String(idRes.text ?? '').trim();
    if (!/^[0-9a-f]{8,}$/i.test(id))
        throw new Error('bash.ws did not hand out a test id');
    const resolver = Gio.Resolver.get_default();
    const jobs = [];
    for (let i = 1; i <= lookups; i++) {
        // The names do not resolve to anything; the lookup itself is the test.
        jobs.push(resolver.lookup_by_name_async(`${i}.${id}.bash.ws`, cancellable).catch(() => null));
    }
    await Promise.all(jobs);
    const {status, data} = await fetchJson(session, `https://bash.ws/dnsleak/test/${id}?json`, {cancellable});
    if (status !== 200 || !Array.isArray(data))
        throw new Error(`bash.ws HTTP ${status}`);
    const servers = [];
    let ip = null;
    for (const row of data) {
        const entry = {
            ip: row.ip ?? '',
            country: row.country_name ?? '',
            countryCode: String(row.country ?? '').toUpperCase(),
            org: row.org ?? '',
            asn: String(row.asn ?? '').split(' ')[0],
        };
        if (row.type === 'dns')
            servers.push(entry);
        else if (row.type === 'ip')
            ip = entry;
    }
    return {ip, servers};
}

// Regional-indicator flag for a two-letter country code ("SE" -> 🇸🇪).
export function flag(code) {
    const cc = String(code ?? '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc))
        return '';
    return String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function nowUnix() {
    return Math.floor(GLib.get_real_time() / 1e6);
}
