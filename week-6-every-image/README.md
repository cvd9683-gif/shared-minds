# Every Image

Shared Minds · Week 6. Open [`index.html`](index.html) through a local server (`python3 -m http.server`
from the repo root, then go to `/week-6-every-image/`). It needs no build step to run.

A square of static, 32 × 32 pixels. Every pixel is a whole picture: that picture's colours averaged
down to one dot. Hover to peek inside a pixel, click to fall into it. Almost every pixel holds more
static, because almost every possible picture is noise. A few hold pictures that people asked an AI
to make. The sound guide hisses over static and clears into a tone as you get near one.

Inside an AI picture the rule keeps going: each of its pixels is another AI picture with that
average colour. **See its pixels** shows the picture as a mosaic of them.

## The numbers

- A 32 × 32 picture has 1,024 pixels, and each can be any of 16,777,216 colours. That's
  16,777,216<sup>1,024</sup> ≈ 10<sup>7,398</sup> possible pictures, nearly all of them static.
- An AI picture has an address too: its prompt and its seed. Same prompt, same seed, same picture,
  every time. Stable Diffusion has about 4.3 billion seeds, times every prompt anyone could write.
  That's a sliver of pixel space: the part that looks like things people have already made.

## How it works

- **Pictures inside pixels.** A static picture is made from a seed and a colour: 1,024 random pixels
  that average out near the colour you clicked. A few of its pixels are salted with AI pictures,
  each on a pixel the colour of its own average. In real pixel space the odds of landing on a
  meaningful picture are effectively zero; the salting is what makes this one explorable.
- **The atlas.** The AI pictures come from [DiffusionDB](https://poloclub.github.io/diffusiondb/), about
  14 million Stable Diffusion images shared on a public Discord, each with its prompt and seed.
- **CLIP and UMAP.** CLIP turns each picture into 512 numbers by what it shows. UMAP flattens those
  numbers onto the map in the corner, so pictures that mean similar things sit together. The map
  starts dark; pictures appear on it as you find them. CLIP also picks each picture's six closest
  neighbours in meaning.
- **Sound.** Over static, the hiss clears into a tone the closer your cursor is to a pixel that holds a
  picture. The pitch comes from where that picture sits on the map, so similar pictures sound similar.

## Building the atlas

Until the atlas is built, the page runs on a small demo set of drawings placed by colour. To fill it
with real AI pictures, run this once on your own machine (it downloads a DiffusionDB part of several
hundred MB and the CLIP model, about 350 MB):

```sh
cd week-6-every-image/tools
npm install
node build-atlas.mjs                        # 400 pictures from DiffusionDB part 1
node build-atlas.mjs --parts 1,2 --limit 800
node build-atlas.mjs --from ~/Pictures/ai   # or any folder of your own images
```

It writes `atlas/atlas.json` and a 256 × 256 thumbnail of each picture to `atlas/images/`. Commit
both. DiffusionDB is unfiltered, so the script drops pictures by prompt words and by asking CLIP
whether they look explicit or violent. Look through `atlas/images/` anyway, add the original file
name of anything you don't want to `tools/exclude.txt`, and run it again.

An earlier sketch for this week, [Eyes Closed](../week-6-eyes-closed/), places typed thoughts by meaning.
