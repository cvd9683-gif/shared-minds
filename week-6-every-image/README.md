# Every Image

Shared Minds · Week 6. Open [`index.html`](index.html) through a local server (`python3 -m http.server`
from the repo root, then go to `/week-6-every-image/`). It needs no build step to run.

The whole screen is TV static, and every dot is a picture squeezed down to its average colour. The
cursor is a lens: under it the static holds still and the dots swell until you can see what they are.
Click the dot in the middle to open it.

An opened picture shows its two addresses. In pixel space it's one number: its 32 × 32 pixels read
as a single number in base 256, about 7,398 digits long, and you can see every digit. In AI space
it's the prompt and seed that led Stable Diffusion to it. Below them are the six pictures closest
to it in meaning.

The lens works on an opened picture too: its pixels swell into the pictures whose colour they share,
and clicking one opens it, as far down as you like (**back** climbs out one level). The small map in
the corner opens the full map of meaning.

## The numbers

- A 32 × 32 picture has 1,024 pixels, and each can be any of 16,777,216 colours. That's
  16,777,216<sup>1,024</sup> ≈ 10<sup>7,398</sup> possible pictures, nearly all of them static.
- An AI picture has an address too: its prompt and its seed. Same prompt, same seed, same picture,
  every time. Stable Diffusion has about 4.3 billion seeds, times every prompt anyone could write.
  That's a sliver of pixel space: the part that looks like things people have already made.

## How it works

- **The static and the lens.** The screen is a grid of 6-pixel dots, redrawn about twelve times a
  second. Every 20 × 20 block of dots holds all 400 pictures once, shuffled differently per block, so
  neighbours never repeat. Under the lens a dot settles into its picture's real average colour, and
  a fisheye magnifies it until the picture shows.
- **The atlas.** The AI pictures come from [DiffusionDB](https://poloclub.github.io/diffusiondb/), about
  14 million Stable Diffusion images shared on a public Discord, each with its prompt and seed.
- **The map: position is meaning, lines are colour.** CLIP turns each picture into 512 numbers by what
  it shows. k-means groups those numbers into eight regions, and UMAP spreads each region into an
  island, with similar regions placed near each other. CLIP did the grouping; I named the regions by
  hand after looking at them (`tools/region-names.json`). It split portraits into mostly men and
  mostly women by itself. Lines join each picture to the two whose average colour is closest: the
  pictures that could hide in the same dot of static. So the map shows two kinds of closeness at
  once, what pictures mean and what colour they are, and they rarely agree. The six thumbnails under
  an opened picture are its closest in meaning.
- **Sound.** White noise is the sound version of static: every frequency at once. Moving the lens,
  you hear the noise. Rest it on a dot and the noise narrows into one tone, the way attention narrows
  static into a picture. Each region of the map has its own root note, and a picture's place in its
  region picks a note of that scale, so pictures of similar things sound alike. Opening a picture silences the static and plays its chord; inside a
  picture there's no noise, only the tones of the pixels under the lens.

## Building the atlas

The atlas in `atlas/` holds 400 pictures from DiffusionDB part 1; the page needs it to run. To rebuild it, or build a bigger one, run this (it
downloads a DiffusionDB part of several hundred MB and the CLIP model, about 350 MB):

```sh
cd week-6-every-image/tools
npm install
node build-atlas.mjs                        # 400 pictures from DiffusionDB part 1
node build-atlas.mjs --parts 1,2 --limit 800
node build-atlas.mjs --from ~/Pictures/ai   # or any folder of your own images
node build-atlas.mjs --remap                # redo only the map: regions, layout, neighbours
```

It writes `atlas/atlas.json`, each picture at 512 × 512 to `atlas/images/`, and all of them at
96 × 96 in one sprite sheet, `atlas/thumbs.jpg`. Commit all three. `--reexport` rewrites the image files without re-running CLIP.

DiffusionDB is unfiltered, so the script drops pictures by prompt words and by asking CLIP
whether they look explicit or violent. Look through `atlas/images/` anyway, add the original file
name of anything you don't want to `tools/exclude.txt`, and run it again.

An earlier sketch for this week, [Eyes Closed](../week-6-eyes-closed/), places typed thoughts by meaning.
