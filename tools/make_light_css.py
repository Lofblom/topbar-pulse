#!/usr/bin/env python3
"""Generate src/stylesheet-light.css (and -dark.css) from src/stylesheet.css.

GNOME Shell 47+ loads stylesheet-light.css or stylesheet-dark.css to match
the shell's style; stylesheet.css (dark) stays as the fallback. The top bar
is dark in both styles, so only menu colours are flipped.
"""
import os, re
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src')
src = open(os.path.join(root, 'stylesheet.css'), encoding='utf-8').read()

# panel rules (#panel …) keep their colours; everything else is a menu rule
def flip(block):
    block = re.sub(r'rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)',
                   lambda m: f'rgba(0, 0, 0, {float(m.group(1)) * 0.85:.2f})', block)
    return (block.replace('#8ff0a4', '#1b7a3a')    # ok text
                 .replace('#f0b35a', '#9a5b00'))   # warning text

out = []
for rule in re.split(r'(?<=\})', src):
    out.append(rule if rule.strip().startswith('#panel') else flip(rule))
light = ''.join(out)
header = '/* generated from stylesheet.css by tools/make_light_css.py – do not edit */\n'
open(os.path.join(root, 'stylesheet-light.css'), 'w', encoding='utf-8').write(header + light)
open(os.path.join(root, 'stylesheet-dark.css'), 'w', encoding='utf-8').write(header + src)
