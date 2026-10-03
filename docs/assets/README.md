# README banner

`banner-painting.png` is the original artwork: a gold-and-charcoal celestial engraving of a branching web tree, with one luminous path to a single target. Its torn map edges have real alpha transparency. `banner-painting.webp` is a compressed 1600 × 640 copy, retaining transparency. `banner.svg` embeds the WebP bytes at the original 1983 × 793 aspect ratio, with the xpathed wordmark over the quiet left side. It contains no external resources or scripts.

The artwork and wordmark appear together through one 11-second ink bloom, following the timing and turbulent circular reveal of the [Browser Harness banner](https://github.com/browser-use/browser-harness). Native SVG animation holds briefly, then expands a circle with a grainy edge. The finished image stays visible, retaining the ragged border on both light and dark backgrounds. Reduced-motion preferences show the full artwork immediately. The circle's underlying radius also reveals the full image when SVG animation is unavailable or removed.

To regenerate the compressed artwork, use `cwebp` from the WebP tools. Rebuild or check the generated SVG from the repository root:

```sh
rtk cwebp -quiet -q 80 -m 6 -resize 1600 640 docs/assets/banner-painting.png -o docs/assets/banner-painting.webp
rtk node docs/assets/build-banner.mjs
rtk node docs/assets/build-banner.mjs --check
```

Animation support depends on the Markdown renderer. The original PNG is also available as a static fallback. Rendering checks in a local browser do not establish how GitHub's image pipeline will display the file.

## Artwork brief

> An epic antique celestial atlas of the web's branching document tree. A colossal tree of finely engraved golden branches divides into smaller branches and dim architectural window-like nodes. One continuous bright gold route follows the hierarchy to one brilliant window high on the right. Gold stippling, etched crosshatching, midnight charcoal, a distant landscape and celestial clouds give the scene the scale and texture of an aged atlas. Keep the leftmost quarter quiet for separate lettering. The artwork is a wide map fragment with organically torn, chipped edges on all four sides and actual transparency outside its silhouette. No frame, rolled scroll, people, screenshots, circuitry, labels or watermarks.
