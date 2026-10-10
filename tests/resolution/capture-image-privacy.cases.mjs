import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import jpeg from "jpeg-js";
import {
  browserUrl,
  targetMarkup,
  request,
  observe,
  verify,
  expectError,
  withFixture,
} from "./fixture.mjs";
import { assertSameMaskedImage } from "./viewer.mjs";

test("capture-image-does-not-wait-for-page-font-readiness", async () => {
  await withFixture(
    `${targetMarkup}<input value="PRIVATE_VALUE"><script>
      Object.defineProperty(document.fonts, 'ready', {get() {throw new Error('Unrelated font loading');}});
      window.observedEvents={get inputOpacity(){return getComputedStyle(document.querySelector('input')).opacity}};
    </script>`,
    async (_session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      assert.ok(capture.image.png);
      assert.equal((await observe()).events.inputOpacity, "1");
    },
  );
});

test("capture-image-restores-controls-when-mask-preparation-throws", async () => {
  await withFixture(
    `${targetMarkup}<input value="PRIVATE_VALUE" data-observe-value><script>
      const append=document.documentElement.append.bind(document.documentElement);
      let fail=true;
      document.documentElement.append=(...nodes)=>{
        if(fail && nodes.some(node=>node.nodeName==='STYLE')) {fail=false;throw new Error('Mask preparation failed');}
        return append(...nodes);
      };
      window.observedEvents={get inputOpacity(){return getComputedStyle(document.querySelector('input')).opacity}};
    </script>`,
    async (_session, page) => {
      await expectError(
        `/pages/${page.pageId}/capture`,
        {
          documentId: page.documentId,
          includeImage: true,
        },
        409,
        "capture_image_unavailable",
      );
      const after = await observe();
      assert.equal(after.events.inputOpacity, "1");
      assert.deepEqual(after.values, ["PRIVATE_VALUE"]);
    },
  );
});

test("capture-image-keeps-privacy-masks-out-of-viewer-on-success-and-failure", async () => {
  await withFixture(
    `${targetMarkup}<div contenteditable style="position:fixed;left:100px;top:100px;width:100px;height:100px;background:rgb(240,10,10)"></div><div id="closed-host"></div><script>
      let armed=false;
      window.mutateXpathFixture=()=>{armed=true};
      new MutationObserver(records=>{
        if(armed && records.some(record=>[...record.addedNodes].some(node=>node.nodeName==='STYLE'))) {
          armed=false;document.querySelector('#closed-host').attachShadow({mode:'closed'}).innerHTML='<input value="PRIVATE_VALUE">';
        }
      }).observe(document.documentElement,{childList:true});
    </script>`,
    async (session, page) => {
      const socket = new WebSocket(`${browserUrl.replace("http", "ws")}${session.viewPath}`, {
        headers: { Origin: process.env.XPATHED_VIEWER_ORIGIN ?? "http://localhost:8081" },
      });
      const colors = [];
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.type !== "frame") return;
        const image = jpeg.decode(Buffer.from(frame.data, "base64"));
        const offset = (130 * image.width + 130) * 4;
        colors.push([...image.data.subarray(offset, offset + 3)]);
        socket.send(JSON.stringify({ type: "ack", frameId: frame.frameId }));
      });
      try {
        await once(socket, "message", { signal: AbortSignal.timeout(5000) });
        const first = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          includeImage: true,
        });
        assert.ok(first.image.png);
        await observe({ mutateXpath: true });
        await expectError(
          `/pages/${page.pageId}/capture`,
          {
            documentId: page.documentId,
            includeImage: true,
          },
          409,
          "stale_capture",
        );
        await once(socket, "message", { signal: AbortSignal.timeout(5000) });
        assert.ok(colors.length >= 2, "The viewer resumes after failed image capture");
        assert.ok(
          colors.every((color) =>
            color.every((channel, index) => Math.abs(channel - [240, 10, 10][index]) <= 15),
          ),
          `The live viewer must preserve the control's actual appearance: ${JSON.stringify(colors)}`,
        );
      } finally {
        const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
        socket.close();
        await closed;
      }
    },
  );
});

test("capture-opt-in-image-masks-private-values-across-frames-and-shadow-roots", async () => {
  await withFixture(
    `${targetMarkup}<style>input,textarea,select,[contenteditable],[data-private],[data-sensitive]{display:block;width:200px;height:30px;margin:4px;border:1px solid black}iframe{width:250px;height:80px}</style>
      <input id="focused" aria-label="Email" value="PRIVATE_FIRST" data-observe-value>
      <input type="password" value="PRIVATE_FIRST"><input type="hidden" value="PRIVATE_HIDDEN">
      <textarea>PRIVATE_FIRST</textarea><select><option>PRIVATE_FIRST</option></select>
      <div contenteditable="true">PRIVATE_FIRST<span style="position:fixed;left:400px;top:200px">PRIVATE_FIRST</span></div>
      <div data-private>PRIVATE_FIRST</div><div data-sensitive>PRIVATE_FIRST</div><div id="shadow"></div>
      <iframe title="Private form" srcdoc="<input aria-label='Secret' value='PRIVATE_FIRST'>"></iframe>
      <script>
        const root = document.querySelector('#shadow').attachShadow({mode:'open'});
        root.innerHTML = '<input aria-label="Shadow secret" value="PRIVATE_FIRST"><div contenteditable>PRIVATE_FIRST</div>';
        const update = scope => {
          for (const element of scope.querySelectorAll('input,textarea')) element.value='PRIVATE_OTHER';
          for (const element of scope.querySelectorAll('option,[contenteditable],[contenteditable] span,[data-private],[data-sensitive]')) element.textContent='PRIVATE_OTHER';
        };
        window.mutateXpathFixture = () => { update(document); update(root); update(document.querySelector('iframe').contentDocument); };
        document.querySelector('#focused').focus();
      </script>`,
    async (_session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      assert.equal(capture.image.width, before.innerWidth);
      assert.equal(capture.image.height, before.innerHeight);
      const image = Buffer.from(capture.image.png, "base64");
      assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(!JSON.stringify(capture.candidates).includes("PRIVATE_"));
      const unchanged = await observe();
      assert.equal(unchanged.activeElement, before.activeElement);
      assert.equal(unchanged.scrollY, before.scrollY);
      assert.deepEqual(unchanged.values, before.values);
      await observe({ mutateXpath: true });
      const changed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      await assertSameMaskedImage(
        changed.image.png,
        capture.image.png,
        "capture-opt-in-image-masks-private-values-across-frames-and-shadow-roots",
      );
      assert.ok(!JSON.stringify(changed.candidates).includes("PRIVATE_"));
      const withoutImage = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(withoutImage.image, null);
    },
  );
});

test("capture-opt-in-image-masks-fractional-private-text-edges", async () => {
  await withFixture(
    `${targetMarkup}<input id="focused" aria-label="Email" value="PRIVATE_FIRST" data-observe-value><div id="shadow"></div>
    <script>
      const root=document.querySelector('#shadow').attachShadow({mode:'open'});
      root.innerHTML='<div contenteditable style="position:absolute;left:20.25px;top:100.5px;width:200.5px;height:30.5px;opacity:.75!important">PRIVATE_FIRST</div>';
      const editable=root.querySelector('[contenteditable]');
      window.observedEvents={get editableStyle(){return editable.style.cssText}};
      window.mutateXpathFixture=()=>{editable.textContent='PRIVATE_OTHER'};
      document.querySelector('#focused').focus();
    </script>`,
    async (_session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      await observe({ mutateXpath: true });
      const changed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      await assertSameMaskedImage(
        changed.image.png,
        capture.image.png,
        "capture-opt-in-image-masks-fractional-private-text-edges",
      );
      assert.ok(!JSON.stringify(capture.candidates).includes("PRIVATE_"));
      assert.ok(!JSON.stringify(changed.candidates).includes("PRIVATE_"));
      const after = await observe();
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.deepEqual(after.values, before.values);
      assert.deepEqual(after.events, before.events);
    },
  );
});

test("capture-lazy-image-reuses-identities-and-masks-frames-and-shadow-values", async () => {
  await withFixture(
    `${targetMarkup}<input aria-label="Email" value="PRIVATE_FIRST" data-observe-value>
    <div id="shadow"></div><iframe title="Form" srcdoc="<input aria-label='Child' value='PRIVATE_FIRST'>"></iframe>
    <script>
      const root=document.querySelector('#shadow').attachShadow({mode:'open'});
      root.innerHTML='<input aria-label="Shadow" value="PRIVATE_FIRST">';
      window.mutateXpathFixture=()=>{
        document.querySelector('input').value='PRIVATE_OTHER';
        root.querySelector('input').value='PRIVATE_OTHER';
        document.querySelector('iframe').contentDocument.querySelector('input').value='PRIVATE_OTHER';
      };
      document.querySelector('input').focus();
    </script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.image, null);
      const identity = { documentId: page.documentId, captureId: capture.captureId };
      const first = await request(`/pages/${page.pageId}/capture-image`, identity);
      assert.equal(first.sessionId, session.sessionId);
      assert.equal(first.pageId, page.pageId);
      assert.equal(first.documentId, capture.documentId);
      assert.equal(first.captureId, capture.captureId);
      assert.equal(first.image.width, before.innerWidth);
      assert.equal(first.image.height, before.innerHeight);
      const after = await observe();
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.deepEqual(after.values, before.values);
      await observe({ mutateXpath: true });
      const second = await request(`/pages/${page.pageId}/capture-image`, identity);
      await assertSameMaskedImage(
        second.image.png,
        first.image.png,
        "capture-lazy-image-reuses-identities-and-masks-frames-and-shadow-values",
      );
      const target = capture.candidates.find((candidate) => candidate.label === "About us");
      const selected = await request(`/pages/${page.pageId}/selection`, {
        ...identity,
        candidateId: target.id,
        action: "click",
      });
      assert.equal(
        selected.target.candidateId,
        target.id,
        "The original retained capture remains usable",
      );
      assert.deepEqual((await verify(selected.target.xpaths)).matches, [["expected-target"]]);
      assert.equal((await observe()).clicks, "0");
    },
  );
});

for (const unsafe of ["closed-shadow", "private-display-contents"]) {
  test(`capture-lazy-image-fails-closed-for-${unsafe}-without-consuming-text-capture`, async () => {
    await withFixture(
      `${targetMarkup}<div id="private-host" ${unsafe === "private-display-contents" ? 'data-private style="display:contents"' : ""}></div>
      <script>document.querySelector('#private-host').attachShadow({mode:'${unsafe === "closed-shadow" ? "closed" : "open"}'}).innerHTML='<input value="PRIVATE_VALUE">';</script>`,
      async (_session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        const identity = { documentId: page.documentId, captureId: capture.captureId };
        await expectError(
          `/pages/${page.pageId}/capture-image`,
          identity,
          409,
          "capture_image_unavailable",
        );
        const target = capture.candidates.find((candidate) => candidate.label === "About us");
        const selected = await request(`/pages/${page.pageId}/selection`, {
          ...identity,
          candidateId: target.id,
          action: "click",
        });
        assert.deepEqual((await verify(selected.target.xpaths)).matches, [["expected-target"]]);
        assert.equal((await observe()).clicks, "0");
      },
    );
  });
}

for (const timing of ["before-image", "during-masking"]) {
  test(`capture-lazy-image-rejects-private-name-source-${timing}`, async () => {
    await withFixture(
      `<span id="source" hidden aria-label="Captured public name"></span><button aria-labelledby="source">Fallback</button>
      <script>
        window.mutateXpathFixture=()=>document.querySelector('#source').setAttribute('data-private','');
        ${timing === "during-masking" ? `new MutationObserver(records=>{if(records.some(record=>[...record.addedNodes].some(node=>node.nodeName==='STYLE'&&node.textContent.includes('data-sensitive'))))window.mutateXpathFixture();}).observe(document.documentElement,{childList:true});` : ""}
      </script>`,
      async (_session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.ok(
          capture.candidates.some((candidate) => candidate.label === "Captured public name"),
        );
        if (timing === "before-image") await observe({ mutateXpath: true });
        await expectError(
          `/pages/${page.pageId}/capture-image`,
          {
            documentId: page.documentId,
            captureId: capture.captureId,
          },
          409,
          "stale_capture",
        );
      },
    );
  });
}

test("capture-lazy-image-rechecks-private-sources-after-masking-failure", async () => {
  await withFixture(
    `<span id="source" hidden aria-label="Captured public name"></span><button aria-labelledby="source">Fallback</button>
    <div id="unsafe-mask" data-private style="display:contents">Private content</div>
    <script>window.mutateXpathFixture=()=>{
      const original=getComputedStyle;
      window.getComputedStyle=(element,...args)=>{
        if(element.id==='unsafe-mask') document.querySelector('#source').setAttribute('data-private','');
        return original(element,...args);
      };
    };</script>`,
    async (_session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((candidate) => candidate.label === "Captured public name"));
      await observe({ mutateXpath: true });
      await expectError(
        `/pages/${page.pageId}/capture-image`,
        { documentId: page.documentId, captureId: capture.captureId },
        409,
        "stale_capture",
      );
      assert.deepEqual((await verify(["//*[@id='source' and @data-private]"])).matches, [
        ["source"],
      ]);
    },
  );
});

test("capture-rendering-boundary-rechecks-new-private-ancestors-and-targets", async () => {
  await withFixture(
    `<button id="expected-target" aria-labelledby="private-reference">Keep me</button>
    <span id="private-reference" data-private hidden aria-label="Private marker reference"></span>
    <button style="position:absolute;top:1600px">Offscreen</button>
    <section id="private-group" aria-label="Private marker context">
      <h2>Private marker heading</h2><input placeholder="Private marker placeholder">
      <button aria-label="Private marker name">Private marker text</button>
    </section>
    <button id="private-direct" aria-label="Private marker direct">Private marker direct text</button>
    <div id="sensitive-host"></div>
    <script>
      document.querySelector('#sensitive-host').attachShadow({mode:'open'}).innerHTML = '<button aria-label="Private marker shadow">Private marker shadow text</button>';
      const NativeObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback, options) {
          super(callback, options);
          requestAnimationFrame(() => {
            document.querySelector('#private-group').setAttribute('data-private', '');
            document.querySelector('#private-direct').setAttribute('data-private', '');
            document.querySelector('#sensitive-host').setAttribute('data-sensitive', '');
          });
        }
      };
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(!JSON.stringify(capture.candidates).includes("Private marker"));
      assert.deepEqual(
        capture.candidates.map((candidate) => candidate.label),
        ["Keep me"],
      );
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.eligibleCount, 2);
      assert.equal(capture.coverage.capturedCount, 1);
      assert.equal(capture.coverage.excludedOffscreenCount, 1);
      const observation = await verify(["//*[@id='private-group' and @data-private]"]);
      assert.deepEqual(observation.matches, [["private-group"]]);
      assert.equal(observation.clicks, "0");
    },
  );
});

test("capture-image-rejects-inaccessible-author-shadow-content-without-blocking-text-capture", async () => {
  await withFixture(
    `<button>Public action</button><div id="private-host"></div>
     <script>document.querySelector('#private-host').attachShadow({mode:'closed'}).innerHTML='<input value="CLOSED_SHADOW_PRIVATE">';</script>`,
    async (session, page) => {
      const body = { documentId: page.documentId };
      const capture = await request(`/pages/${page.pageId}/capture`, body);
      assert.ok(capture.candidates.some((candidate) => candidate.label === "Public action"));
      assert.equal(JSON.stringify(capture).includes("CLOSED_SHADOW_PRIVATE"), false);
      await expectError(
        `/pages/${page.pageId}/capture`,
        { ...body, includeImage: true },
        409,
        "capture_image_unavailable",
      );
      const after = await request(`/pages/${page.pageId}/capture`, body);
      assert.ok(after.candidates.some((candidate) => candidate.label === "Public action"));
    },
  );
});

test("capture-image-wait-rechecks-private-name-sources-before-returning", async () => {
  await withFixture(
    `<span id="source" hidden aria-label="Private marker screenshot"></span>
    <button aria-labelledby="source">Public fallback</button>
    <script>
      new MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(node => node.nodeName === 'STYLE' && node.textContent.includes('data-sensitive'))))
          document.querySelector('#source').setAttribute('data-private', '');
      }).observe(document.documentElement, {childList:true});
    </script>`,
    async (session, page) => {
      const body = { documentId: page.documentId };
      const withoutImage = await request(`/pages/${page.pageId}/capture`, body);
      assert.ok(
        withoutImage.candidates.some(
          (candidate) => candidate.label === "Private marker screenshot",
        ),
      );
      await expectError(
        `/pages/${page.pageId}/capture`,
        { ...body, includeImage: true },
        409,
        "stale_capture",
      );
      const observation = await verify(["//*[@id='source' and @data-private]"]);
      assert.deepEqual(observation.matches, [["source"]]);
    },
  );
});

test("capture-caches-refresh-ancestor-privacy-disabled-state-and-scope", async () => {
  await withFixture(
    `<section id="group" aria-label="Original context">
      <div id="state-host"><button id="expected-target">Save</button></div>
      <div id="private-host"><button>Private later</button></div>
    </section>
    <script>window.mutateXpathFixture = () => {
      document.querySelector('#group').setAttribute('aria-label', 'Updated context');
      document.querySelector('#state-host').setAttribute('aria-disabled', 'true');
      document.querySelector('#private-host').setAttribute('data-private', '');
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const save = capture.candidates.find((candidate) => candidate.label === "Save");
      const privateTarget = capture.candidates.find(
        (candidate) => candidate.label === "Private later",
      );
      assert.ok(save.scope.includes("Original context"));
      assert.ok(privateTarget);
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: save.id,
        action: "click",
      };
      assert.equal(
        (await request(`/pages/${page.pageId}/selection`, selection)).target.state.enabled,
        true,
      );
      await observe({ mutateXpath: true });
      const changed = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(changed.target.state.enabled, false);
      assert.ok(changed.target.interactability.reasons.includes("disabled"));
      await expectError(
        `/pages/${page.pageId}/selection`,
        { ...selection, candidateId: privateTarget.id },
        409,
        "stale_capture",
      );
      const refreshed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const current = refreshed.candidates.find((candidate) => candidate.label === "Save");
      assert.ok(current.scope.includes("Updated context"));
      assert.ok(!current.scope.includes("Original context"));
      assert.equal(current.state.enabled, false);
      assert.ok(!JSON.stringify(refreshed.candidates).includes("Private later"));
      assert.equal((await observe()).clicks, "0");
    },
  );
});
