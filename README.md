# Final Cut

Put the movies up on the wall. Take turns cutting one each. The last poster
standing is what you watch tonight.

- The host starts a room and picks up to 100 movies, searching TMDB for real
  posters.
- Friends join with the 4-letter code or the invite link and play on their
  own phones. Every cut shows up for everyone live.
- Cuts are exactly equal. With 100 movies and 8 players everyone gets 12
  cuts (96 in total). The last 4 then go to elimination votes: everyone
  votes for the one they want gone and most votes is out. If several movies
  tie for most votes, they all go. If every movie still standing ties,
  there's a revote where nobody can pick the movie they just voted for, and
  if that ties across the board too, one is drawn at random. With two
  movies left and everyone voted, a tie goes straight to the draw, since a
  revote would only flip the votes. It repeats
  until one is left. Anyone who joins mid-round gets a vote at the end.
- Only the host adds or removes movies, starts and ends rounds, skips
  someone who's away (they lose that cut), and can count the votes early if
  someone wanders off.
- No accounts. Friends just type their name.
- The host sets a 4-digit host PIN when starting a room. If their phone ever
  forgets them (a new phone, cleared data, or Safari's 7-day cleanup), they
  rejoin with the room code, tap **I'm the host**, and enter the PIN to get
  host controls back. The PIN is stored where no player can read it; the
  database rules check it.

It's a plain static site (HTML, CSS, one JS module) with no build step.

## Put it on your iPhone Home Screen

Open the site in **Safari**, tap **Share**, then **Add to Home Screen**. It
opens full-screen with its own icon, like an app. Opening it from the Home
Screen always starts on the first screen, with a **Back to room** button for
the last room you were in.

The Home Screen app keeps its own storage, separate from Safari, so it counts
as a different player. If you're hosting, create the room from the same place
you'll play from.

## Try it without any setup

Open `index.html?demo` (for example `https://<you>.github.io/final-cut/?demo`).
Demo mode keeps everything on one device. Open a few tabs to play as several
people.

## Setup

You need two free keys, both pasted into `config.js`.

### 1. TMDB (movie search and posters)

1. Sign up at <https://www.themoviedb.org/signup>.
2. Go to **Settings → API → Create → Developer** and fill in the form
   (personal, non-commercial).
3. Copy the **API Key** (the short one) into `TMDB_API_KEY` in `config.js`.

### 2. Firebase (keeps everyone's phones in sync)

1. Go to <https://console.firebase.google.com> and click **Create a project**.
   Name it `final-cut`. You can turn Google Analytics off.
2. **Build → Authentication → Get started → Sign-in method → Anonymous →
   Enable → Save.**
3. **Build → Realtime Database → Create database.** Pick a location, choose
   **Start in locked mode**, and click Enable.
4. In the database's **Rules** tab, replace everything with the contents of
   `database.rules.json` and click **Publish**.
5. Click the gear icon → **Project settings → General**. Under "Your apps",
   click the **`</>`** (Web) icon, give it a nickname, and click Register.
   Leave "Firebase Hosting" unticked.
6. Copy the `firebaseConfig = { ... }` object it shows you into
   `FIREBASE_CONFIG` in `config.js`. Make sure it includes `databaseURL`.
7. **Authentication → Settings → Authorized domains → Add domain** and add
   `<your-github-username>.github.io`.

### 3. Publish on GitHub Pages

**Settings → Pages → Build and deployment → Deploy from a branch →
`main` / `(root)` → Save.** A minute later the site is live at
`https://<your-github-username>.github.io/final-cut/`.

## About the keys being public

Both keys end up in the page source, and that's how these services are meant
to be used from a static site. The TMDB key can only read public movie data.
The Firebase config only identifies the project. What protects the data is
`database.rules.json`, which only lets signed-in (anonymous) players read and
write rooms.

## How a room is stored

```
rooms/ABCD/
  meta      { createdAt, createdBy }
  players/  { <uid>: { name, joinedAt } }
  movies/   { t603: { title, year, poster, runtime, director, overview, ... } }
  game      { phase: lobby|playing|done, order: [uid], turn, pool: [movieId],
              cuts: { movieId: { by, name, n, at } }, round, winner }
```

Cuts go through a database transaction that checks it's really that player's
turn, so two phones tapping at once can't both cut.

---

This product uses the TMDB API but is not endorsed or certified by TMDB.
