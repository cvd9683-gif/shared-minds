# Genius proxy for Music Map

The browser can't call the Genius API directly, and the Genius token shouldn't be
published in the site. This tiny Vercel function holds the token and passes on only
the two read-only lookups Music Map uses (song search and song details).

1. Get a token: <https://genius.com/api-clients> → **New API Client** → any name, the
   site's URL as *App Website URL* → **Save** → **Generate Access Token**. That is the
   *Client Access Token*.
2. On <https://vercel.com/new>, import the `shared-minds` repo and set
   **Root Directory** to `week-4-music-map/genius-proxy`. Framework preset: *Other*.
3. Under **Environment Variables** add `GENIUS_TOKEN` = the token
   (optional: `ALLOWED_ORIGIN` = `https://cvd9683-gif.github.io`). Deploy.
4. Put `https://<your-project>.vercel.app/api/genius` in `week-4-music-map/site/config.json`
   (and `public/config.json`) as `geniusProxy`.

Test it: `https://<your-project>.vercel.app/api/genius?path=/search?q=nas`
