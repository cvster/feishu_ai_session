#!/usr/bin/env bash
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo '需要先安装 Node.js >=20.12（推荐 Node 24，含 npm），再运行本脚本。https://nodejs.org/en/download' >&2
  exit 1
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec node tools/install.mjs "$@"
