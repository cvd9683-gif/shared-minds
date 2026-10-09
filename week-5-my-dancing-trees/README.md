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
- **Skip ahead.** Next to today's date, *Next day* moves you to tomorrow (tap the habits you
  kept first) and *Skip a week* plays out a week, with about three in four habits kept. Watch
  the island fill in, unlock a week-goal plant, and get gifts from the example friends. *Back
  to today* puts everything back; nothing from demo time is saved.
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

## Playing with friends

Anyone can open the app and play straight away with the example island and neighbours.
Signing in is optional, under *Together → Play with real friends*:

- **Sign in with Google.** The island you've been playing with becomes yours and is saved.
- **Invite a friend.** Open *Together* → *Invite a friend* and send the link. When they
  sign in through it, you appear on each other's maps.
- **Visit and gift.** Sail to a friend's island to see the plants from habits they chose
  to share. Gifts you leave arrive on their island live. When they keep a gift you earned
  from a week goal, it counts toward your next rare plant.
- **Privacy is enforced by the database**, not only the app (`firestore.rules`): your
  habits, journal and private plants live in a document only you can read. Visitors read a
  separate public copy that holds shared habits only, and only if you're open to visits.

The example islands (Mara, Theo, Jae, Priya) stay on the map as neighbours, even after you
add real friends. Without a Firebase config the whole app runs as a one-person
prototype.

### Turning it on

1. In the [Firebase console](https://console.firebase.google.com), create a project.
2. **Build → Authentication → Get started**, enable **Google**. Under **Settings →
   Authorized domains**, add `shared-minds-two.vercel.app`.
3. **Build → Firestore Database → Create database** (production mode). Open **Rules**,
   paste in [`firestore.rules`](firestore.rules), and **Publish**.
4. **Project settings → Your apps → Web (`</>`)**, register an app, and copy the
   `firebaseConfig` object into [`firebase-config.js`](firebase-config.js) in place of `null`.

The config values identify the project and are safe to commit; the rules do the protecting.

## What is real and what is simulated

The island, habits, characters, music, plots and privacy settings all work. Signed out,
Mara, Theo, Jae and Priya are example friends and their gifts are simulated, so the social
side can be tried by one person.
