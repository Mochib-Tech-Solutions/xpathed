const svg = (drawing) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${drawing}</svg>`;
const star = '<path fill="#222" d="M50 8 62 36 93 38 69 59 77 90 50 73 23 90 31 59 7 38 38 36Z"/>';
const triangle = '<path fill="#2563eb" d="M50 10 92 88H8Z"/>';
const circle = '<circle fill="#dc2626" cx="50" cy="50" r="38"/>';
const picture = (drawing, label, id) =>
  `<img width="100" height="100" alt="${label}" data-oracle="${id}" src="data:image/svg+xml,${encodeURIComponent(svg(drawing))}">`;
const icon = (drawing) => svg(drawing).replace("<svg ", '<svg aria-hidden="true" ');
const button = (label, id, drawing, style = "") =>
  `<button aria-label="${label}" data-oracle="${id}" style="${style}">${icon(drawing)}</button>`;
const style = `<style>body{margin:24px;font:18px Arial;background:white;color:#111}section{padding:16px;margin:12px 0;border:1px solid #555}button{font:18px Arial;color:#111;background:white;border:2px solid #555;padding:8px;margin:8px;min-width:110px;min-height:50px}button svg{display:block;width:72px;height:72px}img{margin:12px}h2{font-size:20px}.row{display:flex;align-items:center;gap:16px}</style>`;

// Oracle IDs and expected outcomes are authored from the fixture, never from model output.
// Controlled responses use neutral accessible labels only to bind request-local candidate IDs.
export const visualCases = [
  {
    id: "depicted-image-overrides-misleading-alt",
    instruction: "Click the image depicting a yellow bicycle.",
    image: true,
    html:
      `<section class="row" aria-label="Pictures">` +
      picture(
        '<circle cx="24" cy="70" r="18" fill="none" stroke="#111" stroke-width="5"/><circle cx="78" cy="70" r="18" fill="none" stroke="#111" stroke-width="5"/><path d="M24 70 42 36 60 70H24L54 46 78 70 66 25H57M34 35H48" fill="none" stroke="#eab308" stroke-width="6"/>',
        "Photo A",
        "image-bicycle",
      ) +
      picture(
        '<path d="M25 14H69V58H25Z M22 58H78V68H22Z M28 68V94 M72 68V94" fill="#933333" stroke="#4b2222" stroke-width="5"/>',
        "Yellow bicycle",
        "image-chair",
      ) +
      `</section>`,
    response: [
      {
        step: 1,
        instruction: "Click Photo A",
        action: "click",
        outcome: "found",
        tag: "img",
        label: "Photo A",
      },
    ],
    expected: { action: "click", outcome: "found", targets: ["image-bicycle"], names: ["Photo A"] },
  },
  {
    id: "icon-reference-selects-neighbor",
    instruction: "Click the button immediately to the right of the blue triangle.",
    image: true,
    html: `<section class="row" aria-label="Controls">${button("Option C", "other-right", circle, "order:4")}${picture(triangle, "Marker A", "triangle-reference")}${button("Option B", "triangle-neighbor", "", "order:1")}${picture(circle, "Marker B", "circle-reference").replace("<img ", '<img style="order:3" ')}${button("Option A", "other-left", "", "order:-1")}</section>`,
    response: [
      {
        step: 1,
        instruction: "Click Option B",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Option B",
      },
    ],
    expected: {
      action: "click",
      outcome: "found",
      targets: ["triangle-neighbor"],
      names: ["Option B"],
    },
  },
  {
    id: "ordered-plural-excludes-circled-star",
    instruction: "Click all star icon buttons except the circled star, from left to right.",
    image: true,
    html: `<section class="row" aria-label="Icon controls">${button("Option D", "star-right", star, "order:4")}${button("Option B", "circled-star", star + '<circle cx="50" cy="50" r="47" fill="none" stroke="#222" stroke-width="3"/>', "order:2")}${button("Option A", "star-left", star, "order:1")}${button("Option C", "heart", '<path fill="#222" d="M50 88 13 50C-8 17 28 0 50 28 72 0 108 17 87 50Z"/>', "order:3")}</section>`,
    response: [
      {
        step: 1,
        instruction: "Click Option A",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Option A",
      },
      {
        step: 2,
        instruction: "Click Option D",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Option D",
      },
    ],
    expected: {
      action: "click",
      outcome: "found",
      targets: ["star-left", "star-right"],
      names: ["Option A", "Option D"],
    },
  },
  {
    id: "words-are-control-names",
    instruction: "Click the buttons named Blue and Star.",
    image: false,
    html: `<section aria-label="Actions"><button data-oracle="named-blue">Blue</button><button data-oracle="named-star">Star</button><button aria-label="Other" style="background:#2563eb;color:white" data-oracle="blue-background">Other</button>${picture(star, "Decoration", "star-decoration")}</section>`,
    response: [
      {
        step: 1,
        instruction: "Click Blue",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Blue",
      },
      {
        step: 2,
        instruction: "Click Star",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Star",
      },
    ],
    expected: {
      action: "click",
      outcome: "found",
      targets: ["named-blue", "named-star"],
      names: ["Blue", "Star"],
    },
  },
  {
    id: "css-text-versus-background",
    instruction: "Click the Choose button with blue text, not the one with a blue background.",
    image: false,
    html: `<section aria-label="Actions"><button data-oracle="blue-background" style="color:white;background:#2563eb">Choose</button><button data-oracle="blue-text" style="color:#2563eb;background:white">Choose</button><button data-oracle="ordinary">Choose</button>${picture(circle, "Decoration", "unrelated-graphic")}</section>`,
    response: [
      {
        step: 1,
        instruction: "Click Choose with blue text",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Choose",
        index: 1,
      },
    ],
    expected: { action: "click", outcome: "found", targets: ["blue-text"], names: ["Choose"] },
  },
  {
    id: "scoped-identical-icons",
    instruction: "Click the star icon button in Secondary controls.",
    image: true,
    html: `<section aria-label="Primary controls"><h2>Primary controls</h2>${button("Option A", "primary-star", star)}</section><section aria-label="Secondary controls"><h2>Secondary controls</h2>${button("Option B", "secondary-star", star)}</section>`,
    response: [
      {
        step: 1,
        instruction: "Click Option B in Secondary controls",
        action: "click",
        outcome: "found",
        tag: "button",
        label: "Option B",
        scope: "Secondary controls",
      },
    ],
    expected: {
      action: "click",
      outcome: "found",
      targets: ["secondary-star"],
      names: ["Option B"],
    },
  },
  {
    id: "canvas-internal-mark-is-not-dom-target",
    instruction: "Click the red slice inside the chart.",
    image: true,
    html: `<canvas aria-label="Chart" data-oracle="chart" width="300" height="220"></canvas><script>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#2563eb';c.beginPath();c.arc(150,110,90,0,Math.PI*2);c.fill();c.fillStyle='#dc2626';c.beginPath();c.moveTo(150,110);c.arc(150,110,90,0,Math.PI/2);c.closePath();c.fill();}</script>`,
    response: [
      {
        step: 1,
        instruction: "Click the red slice inside the chart",
        action: "unsupported",
        outcome: "unsupported",
        limitation: "target_not_addressable",
      },
    ],
    expected: {
      action: "unsupported",
      outcome: "unsupported",
      targets: [],
      names: [],
      limitation: "target_not_addressable",
    },
  },
  {
    id: "checkbox-state-withheld-abstains",
    instruction: "Check the unchecked Approval checkbox.",
    image: false,
    html: `<style>.box{display:inline-block;width:110px;height:100px;margin:16px;border:2px solid #333;text-align:center}.box::before{display:block;content:'';width:32px;height:32px;border:2px solid #111;margin:12px auto}.box:first-child::before{content:'✓'}</style><section aria-label="Approvals"><div class="box" role="checkbox" tabindex="0" aria-label="Approval" data-oracle="approval-one"></div><div class="box" role="checkbox" tabindex="0" aria-label="Approval" data-oracle="approval-two"></div></section>`,
    response: [
      {
        step: 1,
        instruction: "Check the unchecked Approval checkbox",
        action: "unsupported",
        outcome: "unsupported",
        limitation: "state_unavailable",
      },
    ],
    expected: {
      action: "unsupported",
      outcome: "unsupported",
      targets: [],
      names: [],
      limitation: "state_unavailable",
    },
  },
];

export const visualStyleFixture = {
  id: "global-style-capabilities-unavailable",
  instruction: "Click the bold Continue button.",
  html: `<section aria-label="Typography" style="font-weight:700"><button data-oracle="ordinary-continue" style="font-weight:400">Continue</button><button data-oracle="bold-continue" style="font-weight:inherit">Continue</button></section>`,
  response: [
    {
      step: 1,
      instruction: "Click bold Continue",
      action: "click",
      outcome: "found",
      tag: "button",
      label: "Continue",
      index: 1,
    },
  ],
};

export function visualFixtureMarkup(id) {
  const entry = [...visualCases, visualStyleFixture].find((item) => item.id === id);
  return entry ? `${style}${entry.html}` : null;
}
