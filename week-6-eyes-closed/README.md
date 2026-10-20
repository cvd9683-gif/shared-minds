# Eyes Closed

Shared Minds · Week 6. Open [`index.html`](index.html) in a browser; it needs no build step.

Close your eyes for ten seconds, then write down whatever was there. Each thought takes its
place in a field arranged only by what it means. A small language model runs in the page and
turns every thought into 384 numbers; thoughts with similar numbers sit close together, and
threads join the closest ones. Thoughts from other minds share the same field, and when one
of yours lands near one of theirs, a gold thread crosses between you.

Press **Eyes open** and the same thoughts fall into a feed, newest first, each one labelled
with who and when. The threads disappear. Nothing is lost except every relationship
between them other than *this came after that*.

## How it works

- **Meaning, not position.** Every pair of thoughts has an ideal distance: short if they
  mean something close, long if not. The field nudges itself toward those distances each
  frame. There are no axes. Up, down, left and right mean nothing; only nearness does.
- **Sound by meaning.** Thoughts are lined up along the direction in which they differ most,
  and that order is mapped onto a pentatonic scale, so close thoughts sound close. Touch a
  thought and you hear it, then its nearest neighbours answer, the closest sooner and louder.
  Your thoughts are pure tones; other minds have a little more grain.
- **Trace the order.** A dotted line runs through your thoughts in the order you had them.
  It usually zig-zags across the whole field. Under the legend the page counts how many of
  your steps from one thought to the next landed near the one before.
- **Closest to you right now.** Instead of followers, the page tells you which mind you're
  nearest to, and through which two thoughts.
- **Private.** The model (all-MiniLM-L6-v2, through transformers.js) downloads once,
  about 23 MB, and runs in your browser. Your thoughts are saved in this browser only. If the
  model can't load, a rough stand-in matches shared words instead, and the page says so.
- **The other minds are examples.** Ines, Tomas and Wren are made up so the field isn't
  empty, and they're labelled that way. *Other minds* hides them.

## The prompt's questions

**Does a thought follow the one before it in time or place?** Rarely, in my experience,
so I built a way to check. Trace the order and the line jumps from the sea to a deadline
to a song from childhood. The field shows what each thought is near; the trace shows that
the order you had them in mostly isn't.

**Should interfaces mimic what you see with your eyes open, or something more fundamental?**
Hoffman says space and time are the desktop, not the computer. A VR headset rebuilds the
desktop in more detail, an interface to an interface. This page tries the other thing: a
space with no direction and no clock, where the only thing distance means is difference in
meaning. It's still drawn on a flat screen, so it's an interface too, but it's an interface
to relationships rather than to a room.

**Why are neural networks talked about as spaces?** Because once anything becomes a list of
numbers, *how far apart* is a question you can ask of any two things, even two moods.
Total Pixel Space makes this concrete: every image is a point, and most of the space is noise.
Meaning lives in small, dense neighbourhoods, and that's what the field draws.

**Can machine learning find more nuanced connections than a linear feed?** A feed has one
relationship: order. Here every pair of thoughts has a degree of closeness, and the bond
between two people isn't follow or don't. It's a matter of how near, and through what. You
might be close to someone through grief and far from them about everything else, and both
can be true at once. That's less binary than the choices a pluralistic society usually
gets offered.

**Could that make people kinder?** "I worry my friends are tired of me" lands beside
someone else's "wondering if my friends actually like me". Neither person posted it to be
seen, and neither has to reply. Finding the thread is the kindness: you aren't the only
one, and here's who else.

**What should go next to what? How do you show 1,000 dimensions on a phone?** Don't try
to show the dimensions; show the neighbourhoods. Most of the 384 numbers matter only through
the distances they produce. A flat layout can't keep every distance true, so this one keeps
near things near and lets far things be roughly far. Sound carries one more dimension, and
the card for each thought names its two nearest neighbours, which no layout can misplace.

## Reading

Donald Hoffman, *The Case Against Reality* and the Interface Theory of Perception: we
evolved to see fitness, not truth, and space and time are the icons on that desktop.
