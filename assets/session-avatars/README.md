# Session group avatars

Codex and Claude symbols are sourced from [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons), under the included license. Product names and marks belong to their respective owners. The labeled square backgrounds distinguish bridge session groups.

The PNGs are 512×512, rendered from the adjacent SVGs. `src/bot/group-avatar-images.ts` embeds these PNG bytes so the CLI bundle needs no runtime image library or asset directory. After changing a PNG, regenerate the corresponding base64 entry.
