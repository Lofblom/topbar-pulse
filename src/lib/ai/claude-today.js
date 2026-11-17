#!/usr/bin/env -S gjs -m
// Today's Claude Code token usage split by kind, from the transcripts in
// ~/.claude/projects. Run as a separate gjs process so the shell never
// blocks on large files. Prints JSON:
//   {"input", "output", "cache_write", "cache_read", "requests"}
// Only files changed since midnight are read, and each reply counts once
// (resumed or forked transcripts repeat the same message id + request id).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
const root = GLib.build_filenamev([configDir, 'projects']);
const midnight = GLib.DateTime.new_now_local();
const since = GLib.DateTime.new_local(midnight.get_year(), midnight.get_month(), midnight.get_day_of_month(), 0, 0, 0).to_unix();
const sinceMs = since * 1000;

const tot = {input: 0, output: 0, cache_write: 0, cache_read: 0, requests: 0};
const seen = new Set();
const decoder = new TextDecoder();

function walk(dir) {
    let en;
    try {
        en = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return;
    }
    let info;
    while ((info = en.next_file(null)) !== null) {
        const path = GLib.build_filenamev([dir, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            walk(path);
        else if (info.get_name().endsWith('.jsonl') && info.get_attribute_uint64('time::modified') >= since)
            scan(path);
    }
    en.close(null);
}

function scan(path) {
    let bytes;
    try {
        [, bytes] = GLib.file_get_contents(path);
    } catch {
        return;
    }
    for (const line of decoder.decode(bytes).split('\n')) {
        if (!line.includes('"usage"') || !line.includes('"assistant"'))
            continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        if (d.type !== 'assistant')
            continue;
        const t = Date.parse(d.timestamp ?? '');
        if (!Number.isFinite(t) || t < sinceMs)
            continue;
        const msg = d.message ?? {};
        const key = `${msg.id}|${d.requestId}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const u = msg.usage ?? {};
        tot.input += u.input_tokens ?? 0;
        tot.output += u.output_tokens ?? 0;
        tot.cache_write += u.cache_creation_input_tokens ?? 0;
        tot.cache_read += u.cache_read_input_tokens ?? 0;
        tot.requests++;
    }
}

walk(root);
print(JSON.stringify(tot));
