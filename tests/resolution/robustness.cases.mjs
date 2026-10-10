import assert from "node:assert/strict";
import test from "node:test";

import { targetMarkup, request, verify, withFixture } from "./fixture.mjs";

test("robustness-capture-preserves-unicode-labels-and-state-without-form-values", async () => {
  await withFixture(
    `${targetMarkup}
    <fieldset><legend>Équipe القاهرة</legend>
      <label for="name">Nom prénom</label><input id="name" value="INPUT_SECRET" placeholder="Votre nom">
      <label for="password">Password</label><input id="password" type="password" value="PASSWORD_SECRET">
      <label>Notes<textarea>TEXTAREA_SECRET</textarea></label>
      <label>Country<select><option value="VALUE_SECRET" selected>SELECT_SECRET</option></select></label>
      <div contenteditable aria-label="Editor">EDITOR_SECRET</div>
      <div contenteditable aria-label="Empty editor" style="width:100px;height:30px"></div>
      <input id="checked" type="checkbox" checked aria-label="Remember me">
      <div role="checkbox" aria-label="Mixed choice" aria-checked="mixed">Mixed</div>
      <button disabled>Disabled</button>
      <a href="https://example.test/?token=URL_SECRET">Link</a>
      <span>Hover text</span>
    </fieldset>
    <button hidden>Hidden one</button><div style="display:none"><button>Hidden two</button></div>
    <div style="opacity:0"><button>Transparent three</button></div><button aria-hidden="true">Hidden four</button>
    <button style="position:absolute;top:4000px">Offscreen</button>
    <script>localStorage.setItem('credential', 'STORAGE_SECRET');document.cookie = 'session=COOKIE_SECRET';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const serialized = JSON.stringify(capture);
      for (const secret of [
        "INPUT_SECRET",
        "PASSWORD_SECRET",
        "TEXTAREA_SECRET",
        "SELECT_SECRET",
        "VALUE_SECRET",
        "EDITOR_SECRET",
        "URL_SECRET",
        "STORAGE_SECRET",
        "COOKIE_SECRET",
      ])
        assert.ok(!serialized.includes(secret), secret);
      const name = capture.candidates.find((candidate) => candidate.label === "Nom prénom");
      assert.ok(name);
      assert.equal(name.tag, "input");
      assert.equal(name.placeholder, "Votre nom");
      assert.equal(name.state.editable, true);
      assert.ok(name.scope.includes("Équipe القاهرة"));
      for (const label of ["Password", "Notes", "Country", "Editor", "Empty editor", "Remember me"])
        assert.ok(
          capture.candidates.some((candidate) => candidate.label === label),
          label,
        );
      const checkbox = capture.candidates.find((candidate) => candidate.label === "Remember me");
      assert.equal(checkbox.state.checked, null);
      const checkedSelection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: checkbox.id,
        action: "check",
      });
      assert.equal(checkedSelection.target.state.checked, true);
      assert.equal(
        capture.candidates.find((candidate) => candidate.label === "Mixed choice").state.checked,
        null,
      );
      assert.equal(
        capture.candidates.find((candidate) => candidate.text === "Disabled").state.enabled,
        false,
      );
      assert.ok(!capture.candidates.some((candidate) => candidate.text === "Offscreen"));
      assert.ok(capture.candidates.some((candidate) => candidate.text === "Hover text"));
      assert.ok(capture.candidates.every((candidate) => !candidate.text.startsWith("Hidden")));
      assert.equal(
        capture.candidates.find((candidate) => candidate.text === "Transparent three").state
          .rendered,
        false,
      );
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.capturedCount, capture.candidates.length);
    },
  );
});

test("robustness-input-button-labels-are-captured-without-editable-values", async () => {
  await withFixture(
    `<input type="submit" value="Save changes" data-oracle="expected-target">
    <input type="button" value="Preview"><input type="reset" value="Clear form">
    <input type="image" alt="Submit form" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-oracle="image-submit">
    <input value="EDITABLE_SECRET"><input type="password" value="PASSWORD_SECRET">
    <input type="checkbox" value="CHECKBOX_SECRET"><input type="radio" value="RADIO_SECRET">`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const save = capture.candidates.find((candidate) => candidate.label === "Save changes");
      assert.ok(save);
      assert.equal(save.role, "button");
      const image = capture.candidates.find((candidate) => candidate.label === "Submit form");
      assert.ok(image);
      assert.equal(image.role, "button");
      assert.equal(image.state.editable, false);
      for (const label of ["Preview", "Clear form"])
        assert.ok(capture.candidates.some((candidate) => candidate.label === label));
      assert.ok(!JSON.stringify(capture).includes("SECRET"));
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: save.id,
        action: "click",
      });
      assert.ok(selection.target.xpaths[0].includes("Save changes"));
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["expected-target"]),
      );
      const imageSelection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: image.id,
        action: "click",
      });
      assert.equal(imageSelection.target.state.editable, false);
      assert.deepEqual(
        (await verify(imageSelection.target.xpaths)).matches,
        imageSelection.target.xpaths.map(() => ["image-submit"]),
      );
    },
  );
});
