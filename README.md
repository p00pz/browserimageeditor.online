# Browser Image Editor

Free image tools that never upload your files.

Browser Image Editor is an open-source, client-side image tools website.

## What it does

- Compresses images in the browser.
- Resizes images to exact dimensions.
- Converts common image formats.
- Crops images with fixed or custom aspect ratios.
- Creates PDFs from images.
- Enhances photos on the device.
- Supports installable and offline-friendly use.

## Privacy

No upload, no server, no account. Images are processed in the browser on the visitor's own device.

## Screenshots

<!-- Add screenshots here before publishing. -->

## Tech stack

- Vite 5 in multi-page-app mode
- Vanilla JavaScript and HTML (no framework)
- Web Workers and Comlink
- `browser-image-compression`, Cropper.js, `fflate`, `heic-to`, ONNX Runtime Web, `pdf-lib`, and Pica
- Satori and `@resvg/resvg-js` for generated Open Graph images

## Getting started

```sh
bun install
bun run gen
bun run dev
```

## Building

```sh
bun run build
```

The build lifecycle runs `gen-sw.mjs` after Vite writes `dist/`, producing `dist/sw.js`.

## Project structure

```text
src/       application pages, styles, and browser code
content/   content and locale data
scripts/   generators and audits
tests/     Node test suite
```

## Testing

```sh
bun test
```

## Deployment

GitHub Actions publishes `dist/` on every push to `main`; select **GitHub Actions** in **Settings → Pages → Build and deployment**.

The project uses the apex custom domain `browserimageeditor.online`. In the repository's **Settings → Pages**, add that custom domain and enable **Enforce HTTPS** when it becomes available. Before configuring DNS, verify the custom domain in GitHub to reduce takeover risk.

At the DNS provider, add these A records for the apex (`@`):

```text
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

Also add `www.browserimageeditor.online` as a CNAME to `p00pz.github.io` (without the repository name). These values were checked against [GitHub's custom-domain documentation](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

`public/CNAME` is intentionally committed and copied to `dist/CNAME` on build. GitHub's current documentation notes that an Actions-based Pages workflow does not require it and ignores it for custom-domain configuration; repository Pages settings remain the source of truth.

The service worker is versioned from content hashes, so GitHub Pages' default caching is appropriate. GitHub Pages does not support custom `_headers` files.

### Repository setup

Create an empty repository named `browserimageeditor.online`, then run:

```sh
git init
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:p00pz/browserimageeditor.online.git
git branch -M main
git push -u origin main
```

Finally, set **Settings → Pages → Source** to **GitHub Actions**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
