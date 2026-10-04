import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync(new URL("banner-painting.webp", import.meta.url));
const destination = new URL("banner.svg", import.meta.url);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1983" height="793" viewBox="0 0 1983 793" role="img" aria-labelledby="title description">
  <title id="title">xpathed</title>
  <desc id="description">An antique celestial map with torn edges. One golden path climbs a vast branching web tree to a single illuminated window. An ink bloom reveals the scene once.</desc>
  <style>@media (prefers-reduced-motion: reduce) { .artwork { mask: none; } }</style>
  <defs>
    <filter id="ink" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="7" result="grain"/>
      <feDisplacementMap in="SourceGraphic" in2="grain" scale="155" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <mask id="reveal" maskUnits="userSpaceOnUse" x="0" y="0" width="1983" height="793">
      <circle cx="991.5" cy="396.5" r="1500" fill="white" filter="url(#ink)">
        <animate attributeName="r" values="0;0;1500" dur="9s" begin="0s" fill="freeze" calcMode="spline" keyTimes="0;0.0556;1" keySplines="0 0 1 1;0.22 0.61 0.36 1"/>
      </circle>
    </mask>
  </defs>
  <g class="artwork" mask="url(#reveal)">
    <image width="1983" height="793" preserveAspectRatio="xMidYMid meet" href="data:image/webp;base64,${source.toString("base64")}"/>
    <text x="120" y="414" fill="#eee5ce" font-family="Georgia, 'Times New Roman', serif" font-size="142" letter-spacing="-5">xpathed</text>
  </g>
</svg>
`;

assert.deepEqual(Buffer.from(svg.match(/base64,([^\"]+)/)[1], "base64"), source);
assert(!/<script\b|<foreignObject\b|(?:href|src)="https?:/i.test(svg));
if (process.argv.includes("--check")) {
  assert.equal(
    readFileSync(destination, "utf8"),
    svg,
    "Rebuild banner.svg after changing its source.",
  );
  console.log(
    "Banner matches its builder; painting bytes are unchanged and all resources are embedded.",
  );
} else {
  writeFileSync(destination, svg);
}
