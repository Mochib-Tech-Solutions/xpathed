import assert from "node:assert/strict";
import test from "node:test";
import { targetMarkup, request, observe, verify, expectError, withFixture } from "./fixture.mjs";
import { assertSameMaskedImage } from "./viewer.mjs";

for (const [change, mutation] of Object.entries({
  replacement:
    "document.querySelector('#expected-target').outerHTML='<button id=expected-target>About us</button>'",
  name: "document.querySelector('#expected-target').textContent='Changed name'",
  geometry: "document.querySelector('#expected-target').style.transform='translateX(20px)'",
  state: "document.querySelector('#expected-target').disabled=true",
  scroll: "scrollTo(0,40)",
  "nested-scroll": "document.querySelector('#scroller').scrollTop=30",
  "frame-geometry": "document.querySelector('iframe').style.marginLeft='30px'",
  "frame-name": "document.querySelector('iframe').title='Changed frame'",
  "frame-document": "document.querySelector('iframe').srcdoc='<button>New child</button>'",
  "shadow-name": "document.querySelector('#shadow').setAttribute('aria-label','Changed host')",
})) {
  test(`capture-lazy-image-rejects-retained-${change}-changes`, async () => {
    await withFixture(
      `<style>body{min-height:2000px}#expected-target{position:fixed;top:10px;left:10px}#scroller{margin-top:60px;height:120px;width:250px;overflow:auto}</style>
      <button id="expected-target">About us</button>
      <div id="scroller"><div style="height:400px"><button>Scroll child</button></div></div>
      <iframe title="Child" srcdoc="<button>Child control</button>"></iframe><div id="shadow" aria-label="Host"></div>
      <script>
        document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow control</button>';
        window.mutateXpathFixture=()=>{${mutation}};
      </script>`,
      async (_session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        await observe({ mutateXpath: true });
        await expectError(
          `/pages/${page.pageId}/capture-image`,
          { documentId: page.documentId, captureId: capture.captureId },
          409,
          "stale_capture",
        );
      },
    );
  });
}

test("capture-lazy-image-rechecks-name-changes-during-masking", async () => {
  await withFixture(
    `${targetMarkup}<script>
      new MutationObserver(records=>{
        if(records.some(record=>[...record.addedNodes].some(node=>node.nodeName==='STYLE'&&node.textContent.includes('data-sensitive'))))
          document.querySelector('#expected-target').textContent='Changed while masking';
      }).observe(document.documentElement,{childList:true});
    </script>`,
    async (_session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      await expectError(
        `/pages/${page.pageId}/capture-image`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
        },
        409,
        "stale_capture",
      );
      assert.ok((await observe()).targetMarkup.includes("Changed while masking"));
    },
  );
});

for (const [location, mutation] of Object.entries({
  main: "document.body.insertAdjacentHTML('beforeend','<button style=position:fixed;right:20px;bottom:20px>Added control</button>')",
  frame:
    "document.querySelector('iframe').contentDocument.body.insertAdjacentHTML('beforeend','<button>Added child control</button>')",
  shadow:
    "{const button=document.createElement('button');button.textContent='Added shadow control';document.querySelector('#shadow').shadowRoot.append(button);}",
  "new-shadow":
    "document.querySelector('#new-shadow').attachShadow({mode:'open'}).innerHTML='<button>Added shadow tree</button>'",
  "new-frame":
    "document.body.insertAdjacentHTML('beforeend', '<iframe title=Added style=position:fixed;right:20px;bottom:20px srcdoc=\"<button>Added frame control</button>\"></iframe>')",
  "newly-visible": "document.querySelector('#hidden-control').hidden=false",
  "stylesheet-visible":
    "document.querySelector('#image-styles').sheet.insertRule('#css-hidden { display:block }', 1)",
  "hidden-subtree-stylesheet":
    "document.querySelector('#hidden-inventory').innerHTML='<button>Added hidden control</button>';document.querySelector('#image-styles').sheet.insertRule('#hidden-inventory { display:block;position:fixed;right:20px;bottom:20px }', 1)",
})) {
  test(`capture-lazy-image-rejects-added-${location}-content-without-invalidating-text-selection`, async () => {
    await withFixture(
      `${targetMarkup}<iframe title="Child" srcdoc="<button>Child control</button>"></iframe>
      <div id="shadow"></div><div id="new-shadow"></div><button id="hidden-control" hidden>Initially hidden</button>
      <style id="image-styles">#css-hidden { display:none;position:fixed;right:20px;bottom:20px }</style><button id="css-hidden">Initially CSS hidden</button>
      <div id="hidden-inventory" hidden></div>
      <script>
        document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow control</button>';
        window.mutateXpathFixture=()=>{${mutation}};
      </script>`,
      async (_session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        const identity = { documentId: page.documentId, captureId: capture.captureId };
        const target = capture.candidates.find((candidate) => candidate.label === "About us");
        await observe({ mutateXpath: true });
        await expectError(`/pages/${page.pageId}/capture-image`, identity, 409, "stale_capture");
        const selection = await request(`/pages/${page.pageId}/selection`, {
          ...identity,
          candidateId: target.id,
          action: "click",
        });
        assert.deepEqual((await verify(selection.target.xpaths)).matches, [["expected-target"]]);
      },
    );
  });
}

test("capture-lazy-image-allows-unrelated-hidden-mutations", async () => {
  await withFixture(
    `${targetMarkup}<span id="unrelated" hidden>First</span><script>window.mutateXpathFixture=()=>document.querySelector('#unrelated').textContent='Second';</script>`,
    async (_session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      await observe({ mutateXpath: true });
      const image = await request(`/pages/${page.pageId}/capture-image`, {
        documentId: page.documentId,
        captureId: capture.captureId,
      });
      assert.equal(image.captureId, capture.captureId);
      assert.ok(image.image.png);
    },
  );
});

test("capture-lazy-image-rejects-new-content-added-during-masking", async () => {
  await withFixture(
    `${targetMarkup}<script>
      new MutationObserver(records=>{
        if(records.some(record=>[...record.addedNodes].some(node=>node.nodeName==='STYLE'&&node.textContent.includes('data-sensitive')))) {
          const button=document.createElement('button');button.id='added-image-control';button.textContent='Added while masking';
          button.style='position:fixed;right:20px;bottom:20px';document.body.append(button);
        }
      }).observe(document.documentElement,{childList:true});
    </script>`,
    async (_session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      await expectError(
        `/pages/${page.pageId}/capture-image`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
        },
        409,
        "stale_capture",
      );
      assert.deepEqual((await verify(["//button[.='Added while masking']"])).matches, [
        ["added-image-control"],
      ]);
    },
  );
});

test("capture-lazy-image-releases-observers-when-capture-is-replaced", async () => {
  await withFixture(
    `${targetMarkup}<span id="observer-state" hidden></span><script>
      const NativeObserver=MutationObserver, observers=[];
      window.MutationObserver=class extends NativeObserver {
        constructor(callback) {super(callback);observers.push(this);this.active=false;}
        observe(...args) {this.active=true;return super.observe(...args);}
        disconnect() {this.active=false;return super.disconnect();}
      };
      window.mutateXpathFixture=()=>document.querySelector('#observer-state').textContent=String(observers.filter(observer=>observer.active).length);
    </script>`,
    async (_session, page) => {
      for (let iteration = 0; iteration < 3; iteration++) {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        await observe({ mutateXpath: true });
        assert.deepEqual((await verify(["//*[@id='observer-state' and .='1']"])).matches, [
          ["observer-state"],
        ]);
        const image = await request(`/pages/${page.pageId}/capture-image`, {
          documentId: page.documentId,
          captureId: capture.captureId,
        });
        assert.equal(image.captureId, capture.captureId);
      }
    },
  );
});

test("capture-lazy-image-rejects-wrong-capture-document-and-inactive-page", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
    const path = `/pages/${page.pageId}/capture-image`;
    await expectError(
      path,
      { documentId: page.documentId, captureId: "wrong" },
      409,
      "stale_capture",
    );
    await expectError(
      path,
      { documentId: "wrong", captureId: capture.captureId },
      409,
      "stale_document",
    );
    await request(`/sessions/${session.sessionId}/pages`);
    await expectError(
      path,
      { documentId: page.documentId, captureId: capture.captureId },
      409,
      "inactive_page",
    );
  });
});
