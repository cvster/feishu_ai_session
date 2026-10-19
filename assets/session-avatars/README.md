# Session group avatars

Codex and Claude symbols are sourced from [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons), under the included license. Product names and marks belong to their respective owners. The labeled square backgrounds distinguish bridge session groups.

The PNGs are 512×512, rendered from the adjacent SVGs. `src/bot/group-avatar-images.ts` embeds these PNG bytes so the CLI bundle needs no runtime image library or asset directory. After changing a PNG, regenerate the corresponding base64 entry.

ZCode uses its official 512×512 application icon, matching the locally installed desktop distribution (`resources/icon_512x512.png`). Upstream icon: [zai-org/ZCode packages/desktop/build/icon.png](https://github.com/zai-org/ZCode/blob/main/packages/desktop/build/icon.png). The upstream Apache-2.0 license is included as `LICENSE.zcode`; the ZCode name and mark remain their owner's property. The embedded map covers every registered tool.

Kilo uses the official extension's `assets/icons/kilo-dark.svg` (included as `kilo.svg`, under `LICENSE.kilo`), rendered to an opaque RGB 512×512 PNG with a yellow background and black mark. Do not copy `kilo-dark.png` from the extension: its white pixels and transparent cutouts become an all-white avatar on Feishu's white background. Regenerate the embedded Kilo base64 entry whenever this PNG changes.

DeepSeek Harness uses the official `FishLogo` path from `@deepseek-ai/dsh-client-ui-primitives`, under `LICENSE.dsh`. The adjacent `dsh.svg` adds an opaque blue background and a DSH label, then renders to 512×512 RGB PNG for the embedded map.
