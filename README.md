# Fuzzy Games

Static landing page for [fuzzygames.ai](https://fuzzygames.ai).

The publishable site is in `dist/`. It is intentionally buildless: edit the HTML or assets directly, then preview with any local static-file server.

## Local preview

```sh
python3 -m http.server 4173 --directory dist
```

Open `http://127.0.0.1:4173`.

## Hosting

The site is hosted through OpenAI Sites. `.openai/hosting.json` contains the non-secret project identifier and static output directory.
