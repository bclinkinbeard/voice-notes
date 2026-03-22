#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${1:-signal}"
SESSION_NAME="${2:-tourdoc-${VARIANT}}"

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"

cd "$ROOT_DIR"

OUT_DIR="output/playwright/tour/${VARIANT}/mobile"
mkdir -p "$OUT_DIR" docs
DOC_PATH="docs/${VARIANT}-tour.md"

write_doc() {
  local note="$1"
  local image_ext="${2:-svg}"
  local image_block=""
  if [[ -f "$OUT_DIR/inbox.${image_ext}" ]]; then
    image_block=$(cat <<DOC
## Screens

### Inbox
![${VARIANT^} inbox](../${OUT_DIR}/inbox.${image_ext})

### Voice Capture
![${VARIANT^} voice capture](../${OUT_DIR}/voice.${image_ext})

### Quick Note
![${VARIANT^} quick note](../${OUT_DIR}/quick-note.${image_ext})

### Paste Link
![${VARIANT^} paste link](../${OUT_DIR}/paste-link.${image_ext})

### Ask
![${VARIANT^} ask view](../${OUT_DIR}/ask.${image_ext})

### Entity Drawer
![${VARIANT^} entity drawer](../${OUT_DIR}/entity.${image_ext})

### Vaults & Sync
![${VARIANT^} vault sheet](../${OUT_DIR}/vaults.${image_ext})

### Edit Entry
![${VARIANT^} edit entry](../${OUT_DIR}/edit.${image_ext})
DOC
)
  else
    image_block=$(cat <<DOC
## Screens

No tour images were generated.
DOC
)
  fi

  cat > "$DOC_PATH" <<DOC
# ${VARIANT^} Variant Tour

This tour captures the **${VARIANT^}** variant at a mobile viewport using the seeded demo vault.

${note}

${image_block}
DOC
}

render_fallback() {
  rm -f "$OUT_DIR"/*
  python scripts/render-tour_fallback.py "$VARIANT" "$OUT_DIR"
  write_doc "Tour artifacts were generated with the built-in SVG fallback renderer via \`scripts/capture-tour.sh ${VARIANT}\`." svg
  printf 'Rendered fallback tour for %s and wrote %s.\n' "$VARIANT" "$DOC_PATH"
}

if [[ ! -x "$PWCLI" ]]; then
  render_fallback
  exit 0
fi

pw_eval() {
  "$PWCLI" -s="$SESSION_NAME" eval "$1" >/dev/null
}

capture() {
  local destination="$1"
  local raw
  local source

  raw="$($PWCLI -s="$SESSION_NAME" screenshot)"
  source="$(printf '%s\n' "$raw" | grep -oE '\([^)]*\.(png|svg)\)' | tr -d '()' | head -n1)"

  if [[ -z "$source" ]]; then
    echo "Could not determine screenshot output path." >&2
    exit 1
  fi

  cp "$source" "$destination"
}

read -r -d '' INSTALL_HELPER_TEMPLATE <<'JS' || true
async () => {
  window.__tour = {
    wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    close(panelId, closeBtnId) {
      const panel = document.getElementById(panelId);
      if (panel && !panel.classList.contains('hidden')) {
        document.getElementById(closeBtnId).click();
      }
    },
    setCapture(mode) {
      const active = document.querySelector('#capture-actions .capture-action.active');
      if (active && active.dataset.action === mode) return;
      if (active) active.click();
      if (mode) {
        const next = document.querySelector('[data-action="' + mode + '"]');
        if (next) next.click();
      }
    },
    async setVariant(nextVariant) {
      const button = document.querySelector('.variant-chip[data-variant="' + nextVariant + '"]');
      if (button && !button.classList.contains('active')) button.click();
      await this.wait(100);
    },
    async setState(name) {
      this.close('vault-sheet', 'vault-close-btn');
      this.close('entity-drawer', 'entity-close-btn');
      this.close('editor-modal', 'editor-close-btn');
      await this.setVariant('__VARIANT__');

      const inboxTab = document.getElementById('tab-inbox');
      const askTab = document.getElementById('tab-ask');

      if (name === 'ask') {
        askTab.click();
        const input = document.getElementById('ask-input');
        input.value = 'What are we waiting on with Bathroom Remodel Project?';
        document.getElementById('ask-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } else if (name === 'entity') {
        inboxTab.click();
        this.setCapture('');
        const chip = Array.from(document.querySelectorAll('#active-projects .entity-chip'))
          .find((el) => el.textContent.includes('Bathroom'));
        if (chip) chip.click();
      } else if (name === 'vaults') {
        inboxTab.click();
        this.setCapture('');
        document.getElementById('settings-btn').click();
      } else if (name === 'edit') {
        inboxTab.click();
        this.setCapture('');
        const edit = Array.from(document.querySelectorAll('#timeline-list .ghost-btn'))
          .find((el) => el.textContent.trim() === 'Edit');
        if (edit) edit.click();
      } else {
        inboxTab.click();
        const captureMap = {
          inbox: '',
          voice: 'voice',
          'quick-note': 'text',
          'paste-link': 'link'
        };
        this.setCapture(captureMap[name] ?? '');
      }

      window.scrollTo(0, 0);
      await this.wait(250);
      return name;
    }
  };
  return true;
}
JS

INSTALL_HELPER="${INSTALL_HELPER_TEMPLATE//__VARIANT__/$VARIANT}"

if ! "$PWCLI" -s="$SESSION_NAME" resize 430 932 >/dev/null 2>&1; then
  render_fallback
  exit 0
fi

if ! pw_eval "async () => { if (window.location.search !== '?variant=$VARIANT') { window.location.href = window.location.origin + '/?variant=$VARIANT'; } return true; }"; then
  render_fallback
  exit 0
fi
sleep 1
if ! pw_eval "$INSTALL_HELPER"; then
  render_fallback
  exit 0
fi

states=(inbox voice quick-note paste-link ask entity vaults edit)
rm -f "$OUT_DIR"/*
for state in "${states[@]}"; do
  if ! pw_eval "async () => window.__tour.setState('$state')"; then
    render_fallback
    exit 0
  fi
  capture "$OUT_DIR/${state}.png"
done

write_doc "Capture command completed successfully via \`scripts/capture-tour.sh ${VARIANT}\`." png
printf 'Captured %s mobile states for %s and wrote %s.\n' "${#states[@]}" "$VARIANT" "$DOC_PATH"
