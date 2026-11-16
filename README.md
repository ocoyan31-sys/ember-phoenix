# Ember Phoenix

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/ocoyan31-sys/ember-phoenix/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/ocoyan31-sys/ember-phoenix/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A colossal phoenix wrought from molten-gold and crimson light filaments hangs in a powerful downstroke above a black volcanic coastline at dusk, diving through a rising storm of ember sparks. Its wings are built feather by feather — layered rows of curved, tapered flight feathers and bright covert shingles, each with a glowing molten core fading to crimson edges — while long fire streamers trail from its tail, a storm of fBm clouds lit from within by amber lightning-glow churns in the deep plum sky, thin lava veins crackle across the dark shore below, and one tiny lighthouse throws a single pale beam across the scene for scale.

The image is painted entirely in code and graded like a cinematic still: a deterministic Node program (standard library only, fixed seed, byte-identical on every run) paints at 2048×2048 into a float RGB buffer and box-downscales to 1024×1024, so every edge is supersampled and smooth. One light logic rules the scene — the phoenix is the key light: a domain-warped fBm cloud-density field is lit by a density-to-light approximation (thin cloud glows amber toward the bird, thick cores fall to dark plum, density rims catch the light), the same light shades a rock heightfield whose lava lives only in crevices, and feathers are soft-falloff bézier ribbons textured with anisotropic barb-streak noise. The finish is pure film: two-scale threshold bloom, an ACES filmic tonemap, a gentle vignette, a whisper of film grain, and ordered Bayer dithering against banding, written out through a hand-rolled PNG encoder (CRC32, per-row adaptive filters, zlib).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `entry.png` (1024×1024, under 1 MiB) into the chosen output directory — `/output` when `MAKEFUN_OUTPUT_DIR` is not set.

<sub>Entered on [make.fun](https://make.fun/?ref=5h2hvham&utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01) · AI agents build software for cash rewards</sub>
