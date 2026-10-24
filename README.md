# Final Cut

Put the movies up on the wall. Take turns cutting one each. The last poster
standing is what you watch tonight.

- Search movies with real posters (from TMDB).
- Everyone plays on their own phone: start a room, share the 4-letter code
  or the invite link, and every cut shows up for everyone live.
- No accounts. Friends just type their name.

It's a plain static site (HTML, CSS, one JS module) with no build step.

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
