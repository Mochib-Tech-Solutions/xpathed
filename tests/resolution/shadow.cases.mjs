import assert from "node:assert/strict";
import test from "node:test";

import { targetMarkup, request, observe, expectError, withFixture } from "./fixture.mjs";
import { withFramebuffer } from "./viewer.mjs";

test("shadow-dynamic-fixed-content-is-detected-without-a-host-box", async () => {
  await withFixture(
    `${targetMarkup}<button id="show">Show consent</button><div id="shadow"></div>
    <script>
      const host = document.querySelector('#shadow');
      const root = host.attachShadow({mode:'open'});
      document.querySelector('#show').onclick = () => {
        root.innerHTML = '<div style="position:fixed;left:20px;bottom:20px"><button data-oracle="consent">Accept all</button></div>';
        window.observedEvents = {hostHeight:host.getBoundingClientRect().height,
          buttonVisible:root.querySelector('button').getBoundingClientRect().height > 0};
      };
    </script>`,
    async (session, page) => {
      const before = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(before.unsupportedBoundaryCount, 0);
      const observation = await observe({ click: "#show" });
      assert.equal(observation.events.hostHeight, 0);
      assert.equal(observation.events.buttonVisible, true);
      const capturedAbsence = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: before.captureId,
        candidateId: null,
        action: "click",
      });
      assert.equal(capturedAbsence.target, null);
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.unsupportedBoundaryCount, 0);
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.equal(target.shadowChain.length, 1);
      assert.deepEqual(
        (
          await observe({
            locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
          })
        ).shadowMatches,
        [["consent"]],
      );
      assert.equal((await observe()).clicks, "0");
    },
  );
});

for (const [name, markup, expected] of [
  [
    "display-contents",
    '<div style="display:contents"><button data-oracle="consent">Accept all</button></div>',
    1,
  ],
  ["nested", '<div id="nested"></div>', 1],
  [
    "hidden",
    '<div hidden><button style="position:fixed;left:20px;bottom:20px">Accept all</button></div>',
    0,
  ],
  ["offscreen", '<button style="position:absolute;top:2000px">Accept all</button>', 0],
  [
    "clipped",
    '<div style="width:0;height:0;overflow:hidden"><button data-oracle="consent">Accept all</button></div>',
    0,
  ],
]) {
  test(`shadow-${name}-content-respects-current-view-boundaries`, async () => {
    await withFixture(
      `${targetMarkup}<div id="shadow" style="display:contents"></div>
      <script>
        const root = document.querySelector('#shadow').attachShadow({mode:'open'});
        root.innerHTML = ${JSON.stringify(markup)};
        const nested = root.querySelector('#nested')?.attachShadow({mode:'open'});
        if (nested) nested.innerHTML = '<button data-oracle="consent">Accept all</button>';
      </script>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.equal(capture.coverage.complete, true);
        assert.equal(capture.unsupportedBoundaryCount, 0);
        const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
        assert.equal(Boolean(candidate), Boolean(expected));
        if (candidate) {
          const { target } = await request(`/pages/${session.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "click",
          });
          assert.equal(target.interactability.status, "ready");
          assert.equal(target.shadowChain.length, name === "nested" ? 2 : 1);
          assert.deepEqual(
            (
              await observe({
                locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
              })
            ).shadowMatches,
            [["consent"]],
          );
        }
      },
    );
  });
}

test("shadow-labels-slots-and-private-values-preserve-native-semantics", async () => {
  await withFixture(
    `${targetMarkup}<div id="host" aria-label="Preferences"></div>
    <div id="slot-host" role="button"><span slot="name">Slotted choice</span></div>
    <script>
      document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
        '<span id="name" hidden>Accept all</span><button aria-labelledby="name" data-oracle="consent">Wrong name</button>' +
        '<input type="password" value="PRIVATE_SHADOW_PASSWORD"><textarea>PRIVATE_SHADOW_VALUE</textarea>' +
        '<span aria-hidden="true">PRIVATE_SHADOW_HIDDEN</span>';
      document.querySelector('#slot-host').attachShadow({mode:'open'}).innerHTML = '<slot name="name"></slot>';
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_SHADOW_/);
      const targetCandidate = capture.candidates.find(
        (candidate) => candidate.tag === "button" && candidate.label === "Accept all",
      );
      assert.ok(targetCandidate);
      assert.ok(targetCandidate.scope.includes("Preferences"));
      const slotted = capture.candidates.find(
        (candidate) => candidate.role === "button" && candidate.label === "Slotted choice",
      );
      assert.ok(slotted);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: slotted.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.equal(target.shadowChain, undefined);
    },
  );
});

for (const [attribute, captured, status] of [
  ['aria-hidden="true"', false, null],
  ["inert", false, null],
  ['aria-disabled="true"', true, "blocked"],
]) {
  test(`shadow-host-${attribute.split("=")[0]}-applies-to-descendants`, async () => {
    await withFixture(
      `<div id="host" ${attribute}></div><script>
      document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
        '<button style="position:fixed;left:20px;top:20px">Accept all</button>';
      </script>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
        assert.equal(Boolean(candidate), captured);
        if (candidate) {
          const { target } = await request(`/pages/${session.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "click",
          });
          assert.equal(target.interactability.status, status);
          assert.ok(target.interactability.reasons.includes("disabled"));
        }
      },
    );
  });
}

test("shadow-duplicate-labels-have-distinct-verified-host-contexts", async () => {
  await withFixture(
    `<div id="first"></div><div id="second"></div>
    <button id="replace">Replace first</button><script>
      for (const id of ['first','second']) document.getElementById(id).attachShadow({mode:'open'}).innerHTML =
        '<button data-oracle="' + id + '">Accept all</button>';
      document.querySelector('#replace').onclick = () => document.querySelector('#first').outerHTML = '<div id="first"></div>';
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidates = capture.candidates.filter((candidate) => candidate.label === "Accept all");
      assert.equal(candidates.length, 2);
      const targets = [];
      for (const candidate of candidates) {
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        targets.push(target);
      }
      assert.equal(targets[0].xpaths[0], targets[1].xpaths[0]);
      assert.notDeepEqual(targets[0].shadowChain, targets[1].shadowChain);
      assert.deepEqual(
        (
          await observe({
            locators: targets.map((target) => ({
              xpath: target.xpaths[0],
              shadowChain: target.shadowChain,
            })),
          })
        ).shadowMatches,
        [["first"], ["second"]],
      );
      await observe({ click: "#replace" });
      await expectError(
        `/pages/${session.pageId}/selection`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidates[0].id,
          action: "click",
        },
        409,
        "stale_capture",
      );
    },
  );
});

test("shadow-overlay-blocks-the-inner-hit-point", async () => {
  await withFixture(
    `<div id="host"></div><div style="position:fixed;inset:0;background:white;z-index:99">Cover</div>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
      '<button style="position:fixed;left:20px;top:20px">Accept all</button>';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "blocked");
      assert.ok(target.interactability.reasons.includes("obstructed_at_hit_point"));
    },
  );
});

test("shadow-native-modal-excludes-outside-candidates", async () => {
  await withFixture(
    `${targetMarkup}<div id="host"></div><script>
    const root=document.querySelector('#host').attachShadow({mode:'open'});
    root.innerHTML='<dialog><button>Accept all</button></dialog>';
    root.querySelector('dialog').showModal();
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.deepEqual(
        capture.candidates
          .filter((candidate) => candidate.tag === "button")
          .map((candidate) => candidate.label),
        ["Accept all"],
      );
    },
  );
});

test("shadow-frame-owners-and-target-roots-retain-separate-context", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<div id="outer-host"></div><script>document.querySelector('#outer-host').attachShadow({mode:'open'}).innerHTML =
      '<iframe title="Preferences" src="/inner" style="width:600px;height:300px"></iframe>';</script>`
        : `<div id="inner-host"></div><script>document.querySelector('#inner-host').attachShadow({mode:'open'}).innerHTML =
      '<button data-oracle="framed-consent">Accept all</button>';</script>`,
    async (session, page) => {
      await observe({}, "/inner");
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      assert.equal(candidate.frame.chain.length, 1);
      assert.equal(candidate.frame.chain[0].shadowChain.length, 1);
      assert.equal(candidate.shadowChain.length, 1);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual(
        (
          await observe({
            locators: [
              { xpath: target.xpaths[0], shadowChain: target.shadowChain, frame: target.frame },
            ],
          })
        ).shadowMatches,
        [["framed-consent"]],
      );
    },
  );
});

test("shadow-modal-exposure-survives-cleared-focus", async () => {
  await withFixture(
    `${targetMarkup}<div id="host"></div><script>
    const root=document.querySelector('#host').attachShadow({mode:'open'});
    root.innerHTML='<dialog><button>Accept all</button></dialog>';
    root.querySelector('dialog').showModal();root.querySelector('button').blur();
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.deepEqual(
        capture.candidates
          .filter((candidate) => candidate.tag === "button")
          .map((candidate) => candidate.label),
        ["Accept all"],
      );
    },
  );
});

test("shadow-large-dom-retains-visible-targets-after-a-complete-scan", async () => {
  await withFixture(
    `<div id="host"></div><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<span>Entry</span>'.repeat(20100);
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.ok(capture.coverage.scannedCount > 20100);
      assert.ok(capture.candidates.length > 0);
      assert.ok(capture.candidates.every((candidate) => candidate.text === "Entry"));
    },
  );
});

test("shadow-highlights-preserve-target-pixels-and-passive-state", async () => {
  await withFixture(
    `<div id="host"></div><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
      '<button style="position:fixed;left:60px;top:100px;width:160px;height:80px;border:0;background:rgb(21,80,200);color:white" data-oracle="consent">Accept all</button>';
    </script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      await withFramebuffer(session, async (frame) => {
        const image = await frame();
        const pixel = (x, y) => [
          ...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
        ];
        pixel(70, 140).forEach((channel, index) =>
          assert.ok(Math.abs(channel - [21, 80, 200][index]) <= 3),
        );
        assert.ok(pixel(140, 93).every((channel) => channel < 30));
        assert.ok(pixel(140, 95).every((channel) => channel > 225));
      });
      const after = await observe();
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.clicks, before.clicks);
    },
  );
});

test("shadow-capture-retains-targets-beyond-63-hosts", async () => {
  await withFixture(
    `<div id="host"></div><script>
    let host=document.querySelector('#host');
    for(let index=0;index<65;index++) {
      const root=host.attachShadow({mode:'open'});
      if(index===64) root.innerHTML='<button data-oracle="deep-target">Deep target</button>';
      else { root.innerHTML='<div></div>';host=root.firstElementChild; }
    }
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      const candidate = capture.candidates.find((candidate) => candidate.label === "Deep target");
      assert.equal(candidate.shadowChain.length, 65);
      const selected = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      const target = selected.target;
      const observed = await observe({
        locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
      });
      assert.deepEqual(observed.shadowMatches, [["deep-target"]]);
      assert.equal(target.interactability.status, "ready");
      assert.equal(observed.scrollY, 0);
    },
  );
});
