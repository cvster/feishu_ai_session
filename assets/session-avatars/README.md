# Session group avatars

Codex and Claude symbols are sourced from [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons), under the included license. Product names and marks belong to their respective owners. The labeled square backgrounds distinguish bridge session groups.

The PNGs are 512×512, rendered from the adjacent SVGs. `src/bot/group-avatar-images.ts` embeds these PNG bytes so the CLI bundle needs no runtime image library or asset directory. After changing a PNG, regenerate the corresponding base64 entry.

ZCode uses its official 512×512 application icon, matching the locally installed desktop distribution (`resources/icon_512x512.png`). Upstream icon: [zai-org/ZCode packages/desktop/build/icon.png](https://github.com/zai-org/ZCode/blob/main/packages/desktop/build/icon.png). The upstream Apache-2.0 license is included as `LICENSE.zcode`; the ZCode name and mark remain their owner's property. The embedded map covers every registered tool.
