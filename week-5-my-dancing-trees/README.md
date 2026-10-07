# My Dancing Trees

Shared Minds · Week 5. Open [`index.html`](index.html) in a browser; it needs no build step.

A habit tracker where every habit you keep grows a singing plant on your own island.
Your island becomes a choir, and the choir becomes a song. Friends sail between islands
to leave each other plants, and a plant you earned from a hard week can grow into a rare
one when a friend keeps it.

The prompt asked for a social product that makes people kinder and happier, and that
also makes money. This is my answer, as a working prototype.

## How it works

- **Habits grow characters.** You name your own habits, how much, and on which days.
  Each habit grows one kind of native California plant, and each kind sings one part:
  redwoods are the bass, oaks keep the beat, poppies carry the melody.
- **Two views of the same season.** *Forest* is the choir: every plant you have grown,
  standing in curved rows, singing together. *Plots* is a top-down garden where each
  plot is a day. Tap a day to read its field notes, or step into the forest as it
  looked that day.
- **Tap to layer.** Tap a character and its whole section sings. Tap others and they
  join on the beat, so anyone can build the song by hand.
- **Ecosystems.** Each island is a Big Sur coast, a redwood canyon or an oak meadow,
  with its own native cast, its own key and tempo, and its own landscape.
- **Gifts with a story.** Finishing a habit for a week grows an uncommon plant. You can
  keep it or sail it to a friend with the story of how you grew it. When friends keep
  three of your earned gifts, you grow a rare plant. The Albino Redwood is real: it
  can't make its own food and lives on what the tree beside it shares.

## The prompt's questions

**One story, an average, or many parallel stories?** Many parallel stories, connected.
Everyone sings in their own ecosystem's key, and gifts carry plants, and their parts,
between islands. Over a season, your song holds pieces of your friends' songs.

**You're in charge of the algorithm. Similar or different? Peaceful or challenging?**
There is no feed to rank. You see the people you chose and you visit them on purpose,
by sailing. The only nudge is toward giving: the rare plants grow from generosity, not
from attention.

**Authentication: accountability or anonymity?** Accountability to a few people, privacy
from everyone else. You sign in as yourself, but every habit starts private. Friends
see your plants and hear your song, and only learn what a habit is if you choose to
share it. Private habits leave no trace for visitors, not even a placeholder. Journal
entries are never shared. Stats are hidden from visitors by default so no one compares.

**Haidt: what can we really do?** Make the app something you finish, not something you
scroll. Missed days stay as plain soil, with no red marks or broken streaks. The reward
is a song you made and a gift someone kept.

**Money.** Free to grow and gift. Paid seasons for groups, such as a class, a team or a
recovery circle, with a shared archipelago and group goals. Optional ecosystems and
seasonal characters, and printed or vinyl pressings of your island's song at the end of
a season. No ads: ads pay for attention, which is the thing this design refuses to farm.

## What is real and what is simulated

The island, habits, characters, music, plots and privacy settings all work. Mara, Theo,
Jae and Priya are example friends, and the gifts they leave are simulated, so the
social side can be tried by one person. Real multi-person play needs sign-in and a shared
database (see below).

## Making it multiplayer

"Multi-user" here means people on different phones and networks, not people on the same
Wi-Fi. The plan is Firebase, which Music Map is already set up for:

- **Firebase Authentication** (this week's technical assignment) to sign in with Google
  or email, so each island belongs to one person.
- **Firestore or the Realtime Database** to store islands, habits, plants and gifts,
  with security rules so only you can log your habits and only the visitors you allow
  can read what you share.
- **Live updates** so a gift appears on a friend's island while they're looking at it.

The example friends can stay as demo islands for new visitors until they have friends
of their own.
