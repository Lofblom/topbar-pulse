"""Tiny .pot/.po helper: parse msgids from a .pot and write a .po from a dict."""
import json, re, sys

def unq(s):
    return json.loads(s)

def parse_pot(path):
    entries, cur, field = [], None, None
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('msgid '):
            cur = {'msgid': unq(line[6:])}
            field = 'msgid'
        elif line.startswith('msgstr '):
            field = 'msgstr'
            if cur is not None and cur['msgid']:
                entries.append(cur['msgid'])
        elif line.startswith('"') and field == 'msgid' and cur is not None:
            cur['msgid'] += unq(line)
    return entries

def quote(s):
    return json.dumps(s, ensure_ascii=False)

def write_po(path, lang, name, entries, tr):
    out = [f'# {name} translation of Topbar Pulse.', '#', 'msgid ""', 'msgstr ""',
           '"Project-Id-Version: Topbar Pulse\\n"', '"PO-Revision-Date: 2026-11-17 18:00+0100\\n"',
           '"Last-Translator: Topbar Pulse contributors\\n"', f'"Language-Team: {name}\\n"', f'"Language: {lang}\\n"',
           '"MIME-Version: 1.0\\n"', '"Content-Type: text/plain; charset=UTF-8\\n"',
           '"Content-Transfer-Encoding: 8bit\\n"', '']
    missing = []
    for m in entries:
        t = tr.get(m, '')
        if not t:
            missing.append(m)
        out += [f'msgid {quote(m)}', f'msgstr {quote(t)}', '']
    open(path, 'w', encoding='utf-8').write('\n'.join(out))
    return missing

if __name__ == '__main__':
    print(json.dumps(parse_pot(sys.argv[1]), ensure_ascii=False, indent=0))
