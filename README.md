# Speaking Runway

An offline visual speaking timer for 10, 15, and 20-minute sessions.

## Run locally

Serve the folder over HTTP so the service worker can install:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Install on iPhone

1. Deploy this folder to any HTTPS static host.
2. Open the site in Safari.
3. Tap Share, then **Add to Home Screen**.
4. Launch Speaking Runway from the new Home Screen icon.

After the first successful load, all app assets are cached for offline use.
