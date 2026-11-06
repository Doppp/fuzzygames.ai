# Fuzzy Games

Soft Focus homepage for [fuzzygames.ai](https://fuzzygames.ai). This repo is the live copy of the site.

The publishable site is in `dist/`. It is intentionally buildless: edit the files directly, then preview with any local static-file server.

## Local preview

```sh
python3 -m http.server 4173 --directory dist
```

Open `http://127.0.0.1:4173`.

## Hosting

The site is hosted on GitHub Pages. `.github/workflows/pages.yml` publishes `dist/` on every push to `master`.
