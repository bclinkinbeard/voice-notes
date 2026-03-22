#!/usr/bin/env python3
from pathlib import Path
from textwrap import wrap
import sys

WIDTH = 430
HEIGHT = 932
PADDING = 16

VARIANTS = {
    'signal': {
        'bg': '#0f1418', 'surface': '#171d22', 'surface2': '#1d252d', 'line': '#2c3640',
        'text': '#f2f4f6', 'muted': '#93a0aa', 'accent': '#65d2a2', 'accent_ink': '#082117'
    },
    'ledger': {
        'bg': '#f3f4f1', 'surface': '#ffffff', 'surface2': '#fbfbf9', 'line': '#dde2d8',
        'text': '#17201b', 'muted': '#647068', 'accent': '#2c7a57', 'accent_ink': '#ffffff'
    },
    'atlas': {
        'bg': '#101317', 'surface': '#171c22', 'surface2': '#1e252d', 'line': '#2e3c4a',
        'text': '#f4f6f9', 'muted': '#92a0ae', 'accent': '#7eb5ff', 'accent_ink': '#0a1c34'
    },
    'nocturne': {
        'bg': '#0b0d10', 'surface': '#12161b', 'surface2': '#171c22', 'line': '#343c47',
        'text': '#f5f7fa', 'muted': '#8e99a4', 'accent': '#f0c15b', 'accent_ink': '#231606'
    }
}

STATES = ['inbox', 'voice', 'quick-note', 'paste-link', 'ask', 'entity', 'vaults', 'edit']


def esc(value: str) -> str:
    return (value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def text(x, y, value, size=14, weight=500, fill='#fff', anchor='start'):
    return f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}" font-family="Inter, Arial, sans-serif">{esc(value)}</text>'


def rect(x, y, w, h, fill, stroke='none', radius=18, extra=''):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" {extra}/>'


def line(x1, y1, x2, y2, stroke, width=1):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" stroke-width="{width}" />'


def multiline(x, y, value, max_chars, line_height, size, fill, weight=400):
    parts = wrap(value, max_chars)
    return ''.join(text(x, y + i * line_height, part, size=size, weight=weight, fill=fill) for i, part in enumerate(parts))


def chip(x, y, w, h, label, fill, stroke, color, active=False):
    bg = fill if active else 'transparent'
    st = stroke if not active else fill
    return rect(x, y, w, h, bg, st, 999) + text(x + w / 2, y + h / 2 + 5, label, 13, 700 if active else 500, color, 'middle')


def card(x, y, w, h, fill, stroke, title=None, kicker=None, body=None, tokens=None, palette=None):
    parts = [rect(x, y, w, h, fill, stroke, 22)]
    cy = y + 22
    if kicker:
        parts.append(text(x + 16, cy, kicker.upper(), 11, 700, palette['accent']))
        cy += 18
    if title:
        parts.append(text(x + 16, cy, title, 17, 700, palette['text']))
        cy += 22
    if body:
        parts.append(multiline(x + 16, cy, body, 34, 18, 13, palette['muted']))
        cy += 18 * len(wrap(body, 34)) + 6
    if tokens:
        tx = x + 16
        ty = y + h - 36
        for token in tokens:
            tw = max(54, len(token) * 7 + 18)
            parts.append(rect(tx, ty, tw, 24, palette['surface'], 'none', 999))
            parts.append(text(tx + tw / 2, ty + 16, token, 11, 600, palette['text'], 'middle'))
            tx += tw + 8
    return ''.join(parts)


def build_svg(variant, state):
    p = VARIANTS[variant]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">',
        rect(0, 0, WIDTH, HEIGHT, p['bg'], radius=0),
        rect(8, 8, WIDTH - 16, HEIGHT - 16, p['bg'], p['line'], 30),
    ]

    y = 24
    shell_x = 20
    shell_w = WIDTH - 40

    # Topbar
    parts.append(rect(shell_x, y, shell_w, 88, p['surface'], p['line'], 24))
    parts.append(text(shell_x + 18, y + 24, 'FAST CAPTURE SYSTEM' if variant == 'signal' else ('STRUCTURED PERSONAL RECORD' if variant == 'ledger' else ('MAPS WORK IN MOTION' if variant == 'atlas' else 'QUIET MODE FOR LONG SESSIONS')), 10, 700, p['muted']))
    parts.append(text(shell_x + 18, y + 50, 'LifeOS Capture', 28, 700, p['text']))
    parts.append(text(shell_x + 18, y + 72, variant.capitalize(), 13, 500, p['muted']))
    bx = shell_x + shell_w - 72
    for label in ['Vault', 'Sync', 'Vaults']:
        bw = 56 if label != 'Vaults' else 64
        parts.append(chip(bx, y + 22, bw, 34, label, p['surface2'], p['line'], p['text'], False))
        bx -= bw + 8

    # Hero
    y = 124
    parts.append(rect(shell_x, y, shell_w, 112, p['surface'], p['line'], 24))
    parts.append(multiline(shell_x + 18, y + 28, {
        'signal': 'A crisp command-center layout that keeps capture, scan, and search obvious within seconds.',
        'ledger': 'A clean notebook-like layout that feels reliable, quiet, and easy to scan.',
        'atlas': 'A wider dashboard that surfaces projects and topics earlier for faster orientation.',
        'nocturne': 'A denser dark variant with restrained highlights and strong contrast for focus.'
    }[variant], 48, 18, 13, p['muted']))
    parts.append(chip(shell_x + 18, y + 64, 76, 34, 'Inbox', p['accent'], p['accent'], p['accent_ink'], state != 'ask'))
    parts.append(chip(shell_x + 102, y + 64, 64, 34, 'Ask', p['accent'], p['line'], p['accent_ink'] if state == 'ask' else p['text'], state == 'ask'))
    vx = shell_x + shell_w - 76
    for label in ['Nocturne', 'Atlas', 'Ledger', 'Signal']:
        vw = max(62, len(label) * 7 + 18)
        active = label.lower() == variant
        color = p['accent_ink'] if active else p['text']
        parts.append(chip(vx, y + 64, vw, 34, label, p['accent'], p['line'], color, active))
        vx -= vw + 8

    y = 252
    left_w = 180 if variant == 'atlas' else 198
    right_x = shell_x + left_w + 16
    right_w = shell_w - left_w - 16

    # Left capture panel
    capture_h = 210 if state in ('voice', 'quick-note', 'paste-link') else 164
    parts.append(rect(shell_x, y, left_w, capture_h, p['surface'], p['line'], 24))
    parts.append(text(shell_x + 16, y + 28, 'Capture now', 18, 700, p['text']))
    parts.append(text(shell_x + 16, y + 48, 'Common actions stay first.', 12, 500, p['muted']))
    actions = [('Voice', state == 'voice'), ('Quick Note', state == 'quick-note'), ('Paste Link', state == 'paste-link')]
    ax, ay = shell_x + 16, y + 66
    for i, (label, active) in enumerate(actions):
        aw = left_w - 32 if variant == 'atlas' else left_w - 32
        parts.append(chip(ax, ay + i * 42, aw, 34, label, p['accent'], p['line'], p['accent_ink'] if active else p['text'], active))
    parts.append(chip(shell_x + 16, y + 66 + 3 * 42, (left_w - 40) // 2, 30, 'Attach file', p['surface2'], p['line'], p['text'], False))
    parts.append(chip(shell_x + 24 + (left_w - 40) // 2, y + 66 + 3 * 42, (left_w - 40) // 2, 30, 'Add photo', p['surface2'], p['line'], p['text'], False))

    if state == 'voice':
        parts.append(text(shell_x + left_w / 2, y + 192, '0:18', 26, 700, p['accent'], 'middle'))
        parts.append(rect(shell_x + 24, y + 198, left_w - 48, 22, p['surface2'], p['line'], 12))
    elif state == 'quick-note':
        parts.append(rect(shell_x + 16, y + 192, left_w - 32, 74, p['surface2'], p['line'], 16))
        parts.append(multiline(shell_x + 26, y + 218, 'Tile samples look strong. Waiting on plumber estimate before ordering.', 22, 16, 12, p['muted']))
        parts.append(chip(shell_x + 16, y + 274, left_w - 32, 32, 'Save entry', p['accent'], p['accent'], p['accent_ink'], True))
        capture_h = 322
    elif state == 'paste-link':
        parts.append(rect(shell_x + 16, y + 192, left_w - 32, 34, p['surface2'], p['line'], 12))
        parts.append(text(shell_x + 26, y + 214, 'https://example.com/permit-update', 11, 500, p['muted']))
        parts.append(rect(shell_x + 16, y + 236, left_w - 32, 56, p['surface2'], p['line'], 16))
        parts.append(text(shell_x + 26, y + 262, 'Permit note + why it matters', 12, 500, p['muted']))
        parts.append(chip(shell_x + 16, y + 300, left_w - 32, 32, 'Save link', p['accent'], p['accent'], p['accent_ink'], True))
        capture_h = 348

    # right rail cards
    fy = y
    if state not in ('entity', 'vaults', 'edit'):
        parts.append(card(right_x, fy, right_w, 102, p['surface'], p['line'], 'Current Projects', body='Bathroom Remodel, Nutrition Reset, Q2 Planning', tokens=['Bathroom', 'Nutrition'], palette=p))
        parts.append(card(right_x, fy + 116, right_w, 102, p['surface'], p['line'], 'Topics In Motion', body='permits, meals, backlog cleanup, relay sync', tokens=['Permits', 'Meals'], palette=p))

    # timeline or ask content
    timeline_y = y + 180 if variant == 'atlas' else y + capture_h + 16
    timeline_x = shell_x if variant != 'atlas' else right_x
    timeline_w = shell_w if variant != 'atlas' else right_w
    if state == 'ask':
        timeline_y = 252
        timeline_x = shell_x
        timeline_w = shell_w
        parts.append(rect(timeline_x, timeline_y, timeline_w, 388, p['surface'], p['line'], 24))
        parts.append(rect(timeline_x + 16, timeline_y + 18, timeline_w - 32, 78, p['surface2'], p['line'], 18))
        parts.append(multiline(timeline_x + 28, timeline_y + 44, 'What are we waiting on with Bathroom Remodel Project?', 44, 18, 14, p['text'], 600))
        parts.append(chip(timeline_x + 16, timeline_y + 106, timeline_w - 32, 34, 'Run query', p['accent'], p['accent'], p['accent_ink'], True))
        parts.append(rect(timeline_x + 16, timeline_y + 154, timeline_w - 32, 82, p['accent'], p['accent'], 18, 'fill-opacity="0.14"'))
        parts.append(multiline(timeline_x + 28, timeline_y + 184, 'Still waiting on the plumber estimate and permit confirmation. Tile samples are ready once those unblock.', 46, 18, 13, p['text']))
        parts.append(card(timeline_x + 16, timeline_y + 250, timeline_w - 32, 112, p['surface2'], p['line'], 'Matched entries', kicker='Recent stream', body='Bathroom remodel update. Waiting on permit approval. Next step is confirm tile samples.', tokens=['Project', 'Waiting on'], palette=p))
    else:
        parts.append(rect(timeline_x, timeline_y, timeline_w, 280 if state == 'inbox' else 236, p['surface'], p['line'], 24))
        parts.append(text(timeline_x + 16, timeline_y + 26, 'Recent stream', 11, 700, p['muted']))
        parts.append(text(timeline_x + 16, timeline_y + 48, 'Inbox Timeline', 18, 700, p['text']))
        parts.append(card(timeline_x + 16, timeline_y + 62, timeline_w - 32, 92, p['surface2'], p['line'], 'Bathroom remodel update', kicker='Text', body='Waiting on permit approval. Next step is confirm tile samples.', tokens=['Bathroom', 'Edit'], palette=p))
        parts.append(card(timeline_x + 16, timeline_y + 164, timeline_w - 32, 92, p['surface2'], p['line'], 'Protein target check-in', kicker='Text', body='Meal prep slipped this week. Need a simpler lunch plan.', tokens=['Nutrition'], palette=p))

    # Overlays
    if state in ('entity', 'vaults', 'edit'):
        parts.append(rect(0, 0, WIDTH, HEIGHT, '#000000', radius=0, extra='fill-opacity="0.45"'))
        oy = 360
        oh = 430 if state == 'vaults' else 320
        parts.append(rect(12, oy, WIDTH - 24, oh, p['surface'], p['line'], 26))
        title_map = {'entity': 'Bathroom Remodel Project', 'vaults': 'Vaults & Sync', 'edit': 'Edit entry text'}
        body_map = {
            'entity': 'Waiting on permit approval and plumber estimate. Recent captures keep the project active.',
            'vaults': 'Personal Vault\nRelay URL\nGenerate invite\nJoin vault',
            'edit': 'Bathroom remodel update. Waiting on permit approval. Next step is confirm tile samples.'
        }
        parts.append(text(30, oy + 32, title_map[state], 20, 700, p['text']))
        if state == 'entity':
            parts.append(multiline(30, oy + 64, body_map[state], 36, 18, 13, p['muted']))
            parts.append(card(28, oy + 122, WIDTH - 56, 126, p['surface2'], p['line'], 'Related entries', body='Bathroom remodel update. Waiting on permit approval. Next step is confirm tile samples.', tokens=['project', 'waiting_on'], palette=p))
        elif state == 'vaults':
            for i, label in enumerate(['Active vault', 'Vault name', 'Relay URL', 'Invite code', 'Join from invite']):
                yy = oy + 64 + i * 58
                parts.append(text(30, yy, label, 12, 600, p['muted']))
                parts.append(rect(28, yy + 10, WIDTH - 56, 34, p['surface2'], p['line'], 12))
            parts.append(chip(28, oy + oh - 54, WIDTH - 56, 34, 'Save vault', p['accent'], p['accent'], p['accent_ink'], True))
        else:
            parts.append(rect(28, oy + 64, WIDTH - 56, 146, p['surface2'], p['line'], 18))
            parts.append(multiline(42, oy + 94, body_map[state], 38, 18, 13, p['muted']))
            parts.append(chip(28, oy + 226, WIDTH - 56, 34, 'Append correction', p['accent'], p['accent'], p['accent_ink'], True))

    parts.append('</svg>')
    return ''.join(parts)


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: render-tour_fallback.py <variant> <output-dir>')
    variant = sys.argv[1]
    out_dir = Path(sys.argv[2])
    if variant not in VARIANTS:
        raise SystemExit(f'unknown variant: {variant}')
    out_dir.mkdir(parents=True, exist_ok=True)
    for state in STATES:
        (out_dir / f'{state}.svg').write_text(build_svg(variant, state), encoding='utf-8')
    print(f'rendered {len(STATES)} fallback tour screens for {variant} into {out_dir}')


if __name__ == '__main__':
    main()
