# Every Image

Shared Minds · Week 6. Open [`index.html`](index.html) through a local server (`python3 -m http.server`
from the repo root, then go to `/week-6-every-image/`). It needs no build step to run.

Live static, 32 × 32 pixels: the way almost every possible picture looks. But every pixel is a whole
picture squeezed down to one dot. Click any pixel and it zooms open into a picture someone asked an AI to
make, picked at random from the pictures whose average colour is close to that pixel's.

It opens with a short intro, one line at a time, on how big that space is. Then it's just the static.
Scroll in or click to open a pixel; scroll out, press Escape, or use **zoom out** to come back, and
**all the way out** returns to the static from any depth. Inside an AI picture the rule keeps going:
each of its pixels is another AI picture with that average colour, and **see its pixels** shows the
picture as a mosaic of them. **map** opens the map of meaning.

## The numbers

- A 32 × 32 picture has 1,024 pixels, and each can be any of 16,777,216 colours. That's
  16,777,216<sup>1,024</sup> ≈ 10<sup>7,398</sup> possible pictures, nearly all of them static.
- An AI picture has an address too: its prompt and its seed. Same prompt, same seed, same picture,
  every time. Stable Diffusion has about 4.3 billion seeds, times every prompt anyone could write.
  That's a sliver of pixel space: the part that looks like things people have already made.

## How it works

- **Pictures inside pixels.** The static is 1,024 random pixels, redrawn about eleven times a second. In real
  pixel space, a random picture is almost certainly noise; here every pixel opens into one of the AI
  pictures, so every click finds one.
- **The atlas.** The AI pictures come from [DiffusionDB](https://poloclub.github.io/diffusiondb/), about
  14 million Stable Diffusion images shared on a public Discord, each with its prompt and seed.
- **CLIP and UMAP.** CLIP turns each picture into 512 numbers by what it shows. UMAP flattens those
  numbers onto the map in the corner, so pictures that mean similar things sit together. The map
  starts dark; pictures appear on it as you find them. CLIP also picks each picture's six closest
  neighbours in meaning.
- **Sound.** Static hisses, brighter over bright pixels. Opening a picture plays a chime pitched by where it
  sits on the map, and inside a picture each pixel you pass sounds the picture it opens into, so similar
  pictures sound similar.

## Building the atlas

The atlas in `atlas/` holds 400 pictures from DiffusionDB part 1. If it's missing, the page runs on a
small demo set of drawings placed by colour. To rebuild it, or build a bigger one, run this (it
downloads a DiffusionDB part of several hundred MB and the CLIP model, about 350 MB):

```sh
cd week-6-every-image/tools
npm install
node build-atlas.mjs                        # 400 pictures from DiffusionDB part 1
node build-atlas.mjs --parts 1,2 --limit 800
node build-atlas.mjs --from ~/Pictures/ai   # or any folder of your own images
```

It writes `atlas/atlas.json`, each picture at 512 × 512 to `atlas/images/` and at 96 × 96 to
`atlas/thumbs/`. Commit all three. `--reexport` rewrites the image files without re-running CLIP. DiffusionDB is unfiltered, so the script drops pictures by prompt words and by asking CLIP
whether they look explicit or violent. Look through `atlas/images/` anyway, add the original file
name of anything you don't want to `tools/exclude.txt`, and run it again.

An earlier sketch for this week, [Eyes Closed](../week-6-eyes-closed/), places typed thoughts by meaning.
