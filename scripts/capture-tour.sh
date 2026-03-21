#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${1:-tourdoc}"

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"

cd "$ROOT_DIR"

mkdir -p output/playwright/tour/mobile

pw_eval() {
  "$PWCLI" -s="$SESSION_NAME" eval "$1" >/dev/null
}

capture() {
  local destination="$1"
  local raw
  local source

  raw="$("$PWCLI" -s="$SESSION_NAME" screenshot)"
  source="$(printf '%s\n' "$raw" | grep -oE '\([^)]*\.png\)' | tr -d '()' | head -n1)"

  if [[ -z "$source" ]]; then
    echo "Could not determine screenshot output path." >&2
    exit 1
  fi

  cp "$source" "$destination"
}

read -r -d '' INSTALL_HELPER <<'JS' || true
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
    async setState(name) {
      this.close('vault-sheet', 'vault-close-btn');
      this.close('entity-drawer', 'entity-close-btn');
      this.close('editor-modal', 'editor-close-btn');

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
      await this.wait(200);
      return name;
    }
  };
  return true;
}
JS

pw_eval "$INSTALL_HELPER"

states=(inbox voice quick-note paste-link ask entity vaults edit)

rm -f output/playwright/tour/mobile/*.png

"$PWCLI" -s="$SESSION_NAME" resize 430 932 >/dev/null
for state in "${states[@]}"; do
  pw_eval "async () => window.__tour.setState('$state')"
  capture "output/playwright/tour/mobile/${state}.png"
done

printf 'Captured %s mobile states.\n' "${#states[@]}"
