import assert from "node:assert/strict";
import test from "node:test";

import { request, observe, withFixture } from "./fixture.mjs";

test("scope-accessibility-exceptions-preserve-focus-modal-controls-and-role-fallback", async () => {
  await withFixture(
    `<div id="focused-parent"><button id="expected-target">Focused hidden exception</button></div>
    <input type="search" aria-label="Search"><div role="invalid textbox" aria-label="Role fallback" aria-readonly="true" tabindex="0" style="height:30px"></div>
    <script>document.querySelector('#expected-target').focus();document.querySelector('#focused-parent').setAttribute('aria-hidden','true');</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((entry) => entry.label === "Focused hidden exception"));
      assert.equal(capture.candidates.find((entry) => entry.label === "Search").role, "searchbox");
      const fallback = capture.candidates.find((entry) => entry.label === "Role fallback");
      assert.equal(fallback.role, "textbox");
      assert.equal(fallback.state.readonly, true);
      assert.equal((await observe()).activeElement, before.activeElement);
    },
  );
  await withFixture(
    `<button>Implicit inert background</button><section inert><dialog id="modal">
    <button id="expected-target">Modal exposed</button></dialog></section>
    <script>document.querySelector('#modal').showModal();</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((entry) => entry.label === "Modal exposed"));
      assert.ok(capture.candidates.every((entry) => entry.text !== "Implicit inert background"));
      assert.equal((await observe()).activeElement, before.activeElement);
    },
  );
});

test("scope-last-opened-modal-controls-exposure-independent-of-dom-order", async () => {
  await withFixture(
    `<dialog id="first"><button>Active modal</button></dialog><dialog id="second"><button>Older modal</button></dialog>
    <script>document.querySelector('#second').showModal();document.querySelector('#first').showModal();</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((entry) => entry.label === "Active modal"));
      assert.ok(capture.candidates.every((entry) => entry.text !== "Older modal"));
    },
  );
});
