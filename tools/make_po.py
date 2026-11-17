#!/usr/bin/env python3
"""Write po/<lang>.po for every language in tools/translations.py."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from po_util import parse_pot, write_po
from translations import LANGS

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
entries = parse_pot(os.path.join(root, 'po', 'topbar-pulse.pot'))
import re
SPEC = re.compile(r'%%|%[sd]')
bad = False
for lang, (name, table) in LANGS.items():
    missing = write_po(os.path.join(root, 'po', f'{lang}.po'), lang, name, entries, table)
    stale = [k for k in table if k not in entries]
    for k, v in table.items():
        if v and SPEC.findall(k) != SPEC.findall(v):
            print(f'{lang}: placeholder mismatch: {k!r} -> {v!r}')
            bad = True
    print(f'{lang}: {len(entries) - len(missing)}/{len(entries)} translated' + (f', missing: {missing[:5]}' if missing else '') + (f', unused: {stale[:5]}' if stale else ''))
    bad |= bool(missing)
sys.exit(1 if bad else 0)
