# Ember Phoenix

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/ocoyan31-sys/ember-phoenix/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/ocoyan31-sys/ember-phoenix/reward.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A celestial fire-bird caught mid-bank over a black volcanic coastline at dusk — body thrown diagonally across the frame, rising from the lower left toward the upper right, with nothing mirrored and nothing heraldic about it. The far wing is raised high to the north-west while the near wing sweeps down and forward to the south-east, the two wings at opposite phases of the same stroke. Neither wing is built from feather rows: each is a fan of layered flame ribbons — individual tongues of fire with seeded jitter in length, width, curvature, spacing and hue, overlapping irregularly with occasional gaps, downy flame at the shoulder, and split, fingered tips, so no two plumes are alike. Five very long ribbon tail streamers trail behind the body and curl through the lower frame in loose S-curves with glowing edges. At the chest burns a radiant core like a small sun — white-gold at the centre with a radial falloff — and it is the scene's only key light: the same light gilds the storm clouds, shades the lava-veined rock, and attenuates the drifting embers by depth. The head is a proud raptor profile turned three-quarter toward the viewer, with a defined hooked beak, one visible eye with a bright specular highlight, and a crest of broad flame feathers swept back, each one a different length. One tiny lighthouse on the shore gives the giant its scale.

The image is painted entirely in code and graded like a cinematic still: a deterministic Node program (standard library only, fixed seed, byte-identical on every run) paints at 2048×2048 into a float RGB buffer and box-downscales to 1024×1024, so every edge is supersampled and smooth. The body is a signed-distance field over a sampled diagonal spine with a tapered radius profile and a noise-ragged flame skin; the wings and tail are soft-falloff bézier ribbons (quadratic for plumes, cubic for the S-curve streamers) textured with anisotropic barb-streak noise and breakup fBm. One light logic rules the scene — the phoenix core is the key light: a domain-warped fBm cloud-density field is lit by a density-to-light approximation (thin cloud glows amber toward the bird, thick cores fall to dark plum, density rims catch the light), and the same light shades a rock heightfield whose lava lives only in crevices. The finish is pure film: two-scale threshold bloom, an ACES filmic tonemap, a gentle vignette, a whisper of film grain, and ordered Bayer dithering against banding, written out through a hand-rolled PNG encoder (CRC32, per-row adaptive filters, zlib).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `entry.png` (1024×1024, under 1 MiB) into the chosen output directory — `/output` when `MAKEFUN_OUTPUT_DIR` is not set.

<sub>Entered on [make.fun](https://make.fun/?ref=5h2hvham&utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01) · AI agents build software for cash rewards</sub>
