# README banner

`banner-painting.jpg` is the original painting. `banner.svg` embeds its exact bytes at the original 2161 × 728 aspect ratio, with a title and a short caption over the quiet left side. It contains no external resources or scripts.

The painting appears through one 4.8-second ink bloom. Native SVG animation expands a circle; turbulence and displacement give its boundary a grainy edge. The finished image stays visible. Reduced-motion preferences show the full painting immediately. The circle's underlying radius also reveals the full image when SVG animation is unavailable or removed.

Rebuild or check the generated SVG from the repository root:

```sh
rtk node docs/assets/build-banner.mjs
rtk node docs/assets/build-banner.mjs --check
```

Animation support depends on the Markdown renderer. The original JPEG is also available as a static fallback. Rendering checks in a local browser do not establish how GitHub's image pipeline will display the file.

## Artwork brief

> Create an original aged oil painting, presented like a softly faded archival photograph of a nineteenth-century painting. A quiet, mysterious library or cabinet of curiosities becomes a subtle metaphor for finding one exact element among many: branching wooden shelves and nested architectural doorways form a graceful tree-like structure. A single small warm illuminated rectangular doorway is singled out by a delicate unbroken golden thread passing through the branching spaces. The destination is unmistakable but understated. Suggest precision, interpretation and discovery without literal computer UI. Elegant composition, painterly texture, visible canvas grain, softly worn pigments, chiaroscuro, muted charcoal, warm umber, parchment and restrained antique gold. Wide cinematic crop, generous breathing room, detailed but calm. Entire image is the painting, no photographed frame or wall. No people, no robots, no brains, no circuitry, no logos, no text, no letters, no watermark. It should feel like a real old painting with poetic conceptual meaning, not a tech stock illustration. Make the center-right illuminated destination readable at small size, and leave leftmost quarter darker and quieter for separate project lettering.
