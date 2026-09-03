#!/usr/bin/env bash
#
# dev-deploy.sh — Build and deploy opencode-acp to the local opencode plugin cache.
#
# This is the canonical "one command" for local development:
#   1. Cleans dist/
#   2. Builds (tsup bundle + tsc declaration types)
#   3. Copies dist/ + config/ + package.json to the opencode plugin cache
#
# opencode resolves "opencode-acp@latest" to:
#   ~/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp/
#
# Usage:
#   ./scripts/dev-deploy.sh           # Build + deploy (default)
#   ./scripts/dev-deploy.sh --no-build # Deploy existing dist/ only
#   ./scripts/dev-deploy.sh --check    # Build + deploy + run tests first
#
# After deploying, restart opencode to load the new code.
#
set -euo pipefail

# ── Ensure node/npm are in PATH (detect common install locations) ──────────
shopt -s nullglob
if ! command -v npm &>/dev/null; then
    for candidate in \
        "$HOME/.local/share/fnm/aliases/default/bin" \
        "$HOME/.nvm/versions/node"/*/bin \
        "$HOME/.local/lib/node"*/bin \
        "$HOME/.volta/bin" \
        /usr/local/bin /usr/bin; do
        if [[ -x "$candidate/npm" ]] || [[ -x "$candidate/node" ]]; then
            export PATH="$candidate:$PATH"
            break
        fi
    done
fi
shopt -u nullglob

# ── Paths (all relative, no hardcoded user dirs) ───────────────────────────

# Project root = parent of scripts/ directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# opencode plugin cache (uses $HOME, works for any user)
DEPLOY_TARGET="$HOME/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp"

# Legacy resolution path. Older opencode versions resolve "opencode-acp@latest" to
# ~/.cache/opencode/node_modules/opencode-acp/ instead of the packages/@latest path.
# If this directory exists, keep it in sync so deploys take effect regardless of
# which resolution path the running opencode uses. (See AGENTS.md §3.4.)
LEGACY_TARGET="$HOME/.cache/opencode/node_modules/opencode-acp"

# User-editable ACM configuration and prompt paths.
ACM_CONFIG_DIR="$HOME/.config/opencode/acm"
ACM_PROMPTS_DIR="$ACM_CONFIG_DIR/prompts"

# ── Helpers ────────────────────────────────────────────────────────────────

# Node on Windows does not understand Git Bash paths such as /c/Users/...;
# convert paths passed through require() when running under Git Bash.
node_path() {
    if command -v cygpath &>/dev/null; then
        cygpath -w "$1"
    else
        printf '%s\n' "$1"
    fi
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()  { echo -e "${CYAN}[STEP]${NC} $1"; }

install_runtime_dependencies() {
    local target="$1"

    step "Installing runtime dependencies in: $target"
    rm -rf "$target/node_modules"
    rm -f "$target/package-lock.json" "$target/npm-shrinkwrap.json"
    (cd "$target" && npm install \
        --omit=dev \
        --include=peer \
        --ignore-scripts \
        --package-lock=false \
        --no-audit \
        --no-fund) \
        || error "Failed to install runtime dependencies in $target"
}

# ── Pre-flight checks ─────────────────────────────────────────────────────

[[ -f "$PROJECT_ROOT/package.json" ]] || error "Not a valid project: missing package.json (looked in $PROJECT_ROOT)"

cd "$PROJECT_ROOT"

# Parse args
RUN_BUILD=true
RUN_TESTS=false
for arg in "$@"; do
    case "$arg" in
        --no-build) RUN_BUILD=false ;;
        --check)    RUN_TESTS=true ;;
        *)          error "Unknown argument: $arg\nUsage: $0 [--no-build|--check]" ;;
    esac
done

# ── Step 1: Tests (optional, --check) ─────────────────────────────────────

if [[ "$RUN_TESTS" == "true" ]]; then
    step "Running tests..."
    npm run test || error "Tests failed"
    info "Tests passed"
fi

# ── Step 2: Type check ────────────────────────────────────────────────────

if [[ "$RUN_BUILD" == "true" ]]; then
    step "Type checking..."
    npm run typecheck || error "Type check failed"
    info "Type check OK"
fi

# ── Step 3: Build ─────────────────────────────────────────────────────────

if [[ "$RUN_BUILD" == "true" ]]; then
    step "Building (tsup + tsc --emitDeclarationOnly)..."
    npm run build || error "Build failed"

    [[ -f "$PROJECT_ROOT/dist/index.js" ]] \
        || error "Build completed but dist/index.js not found"
    info "Build OK ($(du -h "$PROJECT_ROOT/dist/index.js" | cut -f1))"
else
    step "Skipping build (--no-build)"
    [[ -d "$PROJECT_ROOT/dist" ]] \
        || error "dist/ not found — run without --no-build first"
fi

# ── Step 4: Local development version marker ──────────────────────────────
# Keep local deployments visibly distinct and newer than registry releases so
# OpenCode does not replace the development build during startup.

PROJECT_PACKAGE_JSON="$(node_path "$PROJECT_ROOT/package.json")"
LOCAL_VER=$(ACP_PACKAGE_JSON="$PROJECT_PACKAGE_JSON" node -p "require(process.env.ACP_PACKAGE_JSON).version" 2>/dev/null || echo "?")
DEPLOY_VER="9.9.9"
info "Using local development version marker: v$DEPLOY_VER (source: v$LOCAL_VER)"

# ── Step 5: Deploy ────────────────────────────────────────────────────────

step "Deploying to: $DEPLOY_TARGET"

if [[ ! -d "$DEPLOY_TARGET" ]]; then
    warn "Target directory doesn't exist. Creating..."
    mkdir -p "$DEPLOY_TARGET/dist"
fi

info "Deploying version: v$DEPLOY_VER"

# Copy compiled code, package metadata, and the bundled configuration only.
# Prompt files live exclusively in the global ACM configuration directory.
cp -r "$PROJECT_ROOT/dist/"* "$DEPLOY_TARGET/dist/"
rm -rf "$DEPLOY_TARGET/config"
mkdir -p "$DEPLOY_TARGET/config"
cp "$PROJECT_ROOT/config/acp.jsonc" "$DEPLOY_TARGET/config/acp.jsonc"
cp "$PROJECT_ROOT/package.json" "$DEPLOY_TARGET/package.json"

# Patch version in deployed package.json if bumped (don't touch source tree)
if [[ "$DEPLOY_VER" != "$LOCAL_VER" ]]; then
    ACP_PACKAGE_JSON="$(node_path "$DEPLOY_TARGET/package.json")" node -e "
        const fs = require('fs');
        const p = process.env.ACP_PACKAGE_JSON;
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        pkg.version = '$DEPLOY_VER';
        delete pkg.devDependencies;
        fs.writeFileSync(p, JSON.stringify(pkg, null, 4) + '\n');
    "
    info "Patched deployed version to v$DEPLOY_VER"
fi

install_runtime_dependencies "$DEPLOY_TARGET"

# Verify
DEPLOYED_PACKAGE_JSON="$(node_path "$DEPLOY_TARGET/package.json")"
DEPLOYED_VER=$(ACP_PACKAGE_JSON="$DEPLOYED_PACKAGE_JSON" node -p "require(process.env.ACP_PACKAGE_JSON).version" 2>/dev/null || echo "?")
[[ "$DEPLOYED_VER" == "$DEPLOY_VER" ]] \
    || error "Version mismatch after deploy (expected $DEPLOY_VER, got $DEPLOYED_VER)"

# Sync the legacy resolution path if it exists (see comment on LEGACY_TARGET).
if [[ -d "$LEGACY_TARGET/dist" ]]; then
    cp -r "$PROJECT_ROOT/dist/"* "$LEGACY_TARGET/dist/"
    rm -rf "$LEGACY_TARGET/config"
    mkdir -p "$LEGACY_TARGET/config"
    cp "$PROJECT_ROOT/config/acp.jsonc" "$LEGACY_TARGET/config/acp.jsonc"
    cp "$PROJECT_ROOT/package.json" "$LEGACY_TARGET/package.json"
    if [[ "$DEPLOY_VER" != "$LOCAL_VER" ]]; then
        ACP_PACKAGE_JSON="$(node_path "$LEGACY_TARGET/package.json")" node -e "
            const fs = require('fs');
            const p = process.env.ACP_PACKAGE_JSON;
            const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
            pkg.version = '$DEPLOY_VER';
            delete pkg.devDependencies;
            fs.writeFileSync(p, JSON.stringify(pkg, null, 4) + '\n');
        "
    fi
    install_runtime_dependencies "$LEGACY_TARGET"
    LEGACY_PACKAGE_JSON="$(node_path "$LEGACY_TARGET/package.json")"
    LEGACY_VER=$(ACP_PACKAGE_JSON="$LEGACY_PACKAGE_JSON" node -p "require(process.env.ACP_PACKAGE_JSON).version" 2>/dev/null || echo "?")
    [[ "$LEGACY_VER" == "$DEPLOY_VER" ]] \
        || warn "Legacy path synced but version mismatch (expected $DEPLOY_VER, got $LEGACY_VER)"
    info "Legacy path also synced: v$LEGACY_VER"
else
    info "No legacy install at $LEGACY_TARGET — skipping sync"
fi

# ── Step 6: Initialize user-editable ACM files ─────────────────────────────
# Prompt files have one runtime location. Deploy missing defaults without
# overwriting user edits, and remove obsolete files that no runtime path reads.

step "Initializing ACM config directory: $ACM_CONFIG_DIR"
mkdir -p "$ACM_PROMPTS_DIR"

if [[ ! -f "$ACM_CONFIG_DIR/acp.jsonc" && ! -f "$ACM_CONFIG_DIR/acp.json" ]]; then
    cp "$PROJECT_ROOT/config/acp.jsonc" "$ACM_CONFIG_DIR/acp.jsonc"
    info "Created ACM config: $ACM_CONFIG_DIR/acp.jsonc"
fi

for prompt_name in \
    system \
    compress-range \
    context-limit-nudge \
    subagent-extension \
    decompress-extension \
    protected-tools \
    compression-request; do
    prompt_path="$ACM_PROMPTS_DIR/$prompt_name.md"
    if [[ ! -f "$prompt_path" ]]; then
        cp "$PROJECT_ROOT/config/prompts/$prompt_name.md" "$prompt_path"
    fi
done

rm -f \
    "$ACM_PROMPTS_DIR/turn-nudge.md" \
    "$ACM_PROMPTS_DIR/iteration-nudge.md" \
    "$ACM_PROMPTS_DIR/how-to-compress.md"

info "ACM prompts: $ACM_PROMPTS_DIR"

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  ✅ Deployed: v$DEPLOYED_VER${NC}"
echo -e "${GREEN}  Path: $DEPLOY_TARGET${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "⚠️  Restart opencode for changes to take effect."
echo ""
echo "Edit global config:"
echo "  $ACM_CONFIG_DIR/acp.jsonc"
echo "Edit global prompts:"
echo "  $ACM_PROMPTS_DIR/<prompt>.md"
echo ""
echo "Verify the deployed bundle has your changes:"
echo "  grep -c '<your-feature>' $DEPLOY_TARGET/dist/index.js"
echo ""
echo "ACP debug logs:"
echo "  ~/.config/opencode/logs/acp/context/<session_id>/"
echo "  ~/.config/opencode/logs/acp/daily/\$(date +%F).log"
