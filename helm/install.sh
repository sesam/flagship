#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/helm.py"

mkdir -p \
  "$HOME/.local/bin" \
  "$HOME/.config/opencode/skills/helm" \
  "$HOME/.config/opencode/commands" \
  "$HOME/.claude/skills/helm" \
  "$HOME/.claude/commands"

ln -sfn "$SCRIPT_DIR/helm.py" "$HOME/.local/bin/helm"
ln -sfn "$SCRIPT_DIR/skills/helm/SKILL.md" "$HOME/.config/opencode/skills/helm/SKILL.md"
ln -sfn "$SCRIPT_DIR/skills/helm/SKILL.md" "$HOME/.claude/skills/helm/SKILL.md"
ln -sfn "$SCRIPT_DIR/commands/helm.md" "$HOME/.config/opencode/commands/helm.md"
ln -sfn "$SCRIPT_DIR/commands/helm.md" "$HOME/.claude/commands/helm.md"

echo "Helm installed:"
echo "  CLI:              $HOME/.local/bin/helm -> $SCRIPT_DIR/helm.py"
echo "  OpenCode skill:   $HOME/.config/opencode/skills/helm/SKILL.md -> $SCRIPT_DIR/skills/helm/SKILL.md"
echo "  Claude skill:     $HOME/.claude/skills/helm/SKILL.md -> $SCRIPT_DIR/skills/helm/SKILL.md"
echo "  OpenCode command: $HOME/.config/opencode/commands/helm.md -> $SCRIPT_DIR/commands/helm.md"
echo "  Claude command:   $HOME/.claude/commands/helm.md -> $SCRIPT_DIR/commands/helm.md"

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    echo "Note: add \$HOME/.local/bin to PATH so 'helm' is available directly."
    ;;
esac
