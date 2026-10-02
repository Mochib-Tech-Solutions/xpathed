import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync(new URL("banner-painting.jpg", import.meta.url));
const destination = new URL("banner.svg", import.meta.url);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2161" height="728" viewBox="0 0 2161 728" role="img" aria-labelledby="title description">
  <title id="title">xpathed — Natural language to verified XPath</title>
  <desc id="description">An old oil painting of a branching library, with a golden thread leading through its arches. A grainy ink bloom reveals the scene once.</desc>
  <style>@media (prefers-reduced-motion: reduce) { .painting { mask: none; } }</style>
  <defs>
    <filter id="ink" filterUnits="userSpaceOnUse" x="-250" y="-250" width="2661" height="1228">
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="12" result="grain"/>
      <feDisplacementMap in="SourceGraphic" in2="grain" scale="150" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="0.65"/>
    </filter>
    <mask id="reveal" maskUnits="userSpaceOnUse" x="0" y="0" width="2161" height="728">
      <circle cx="980" cy="365" r="1800" fill="white" filter="url(#ink)">
        <animate attributeName="r" values="0;1800" dur="4.8s" begin="0s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.3 1"/>
      </circle>
    </mask>
  </defs>
  <rect width="2161" height="728" fill="#13110d"/>
  <image class="painting" width="2161" height="728" preserveAspectRatio="xMidYMid meet" mask="url(#reveal)" href="data:image/jpeg;base64,${source.toString("base64")}"/>
  <g fill="#eee5ce">
    <text x="118" y="349" font-family="Georgia, 'Times New Roman', serif" font-size="148" letter-spacing="-5">xpathed</text>
    <text x="124" y="405" font-family="Arial, Helvetica, sans-serif" font-size="29" letter-spacing="0.7">Natural language → verified XPath</text>
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
