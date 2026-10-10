import assert from "node:assert/strict";
import test from "node:test";

import { request, observe, verify, withFixture } from "./fixture.mjs";

test("locators-target-test-contracts-survive-language-tag-and-id-changes", async () => {
  const attributes = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  await withFixture(
    attributes
      .map(
        (attribute, index) =>
          `<button ${attribute}="identity-${index}" id=":r${index}:" data-oracle="target-${index}">Save ${index}</button>`,
      )
      .join("") +
      `<script>window.mutateXpathFixture = () => {
      for (const button of document.querySelectorAll('button[data-oracle]')) {
        const link = document.createElement('a');
        for (const attribute of button.attributes) link.setAttribute(attribute.name, attribute.value);
        link.id = 'changed-generated-' + button.getAttribute('data-oracle'); link.href = '#saved'; link.textContent = 'حفظ';
        const wrapper = document.createElement('span'); button.replaceWith(wrapper); wrapper.append(link);
      }
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const [index, attribute] of attributes.entries()) {
        const candidate = capture.candidates.find(
          (candidate) => candidate.label === `Save ${index}`,
        );
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.deepEqual(target.xpaths, [`//*[@${attribute}='identity-${index}']`]);
        paths.push(target.xpaths[0]);
      }
      const expected = attributes.map((_, index) => [`target-${index}`]);
      assert.deepEqual((await verify(paths)).matches, expected);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, expected);
    },
  );
});

test("locators-test-scopes-survive-translation-wrappers-and-generated-ids", async () => {
  const attributes = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  await withFixture(
    attributes
      .map(
        (attribute, index) =>
          `<div ${attribute}="scope-${index}"><h2>Account ${index}</h2><button id=":r${index}:" data-oracle="target-${index}">Log in ${index}</button></div>`,
      )
      .join("") +
      `<script>window.mutateXpathFixture = () => {
      const labels = ['Se connecter', 'تسجيل الدخول', '登录', 'Anmelden', 'Iniciar sesión'];
      for (const [index, button] of [...document.querySelectorAll('button[data-oracle]')].entries()) {
        const container = button.parentElement, section = document.createElement('section');
        for (const attribute of container.attributes) section.setAttribute(attribute.name, attribute.value);
        container.replaceWith(section); section.append(...container.childNodes);
        section.querySelector('h2').textContent = labels[index]; button.textContent = labels[index];
        button.id = 'changed-generated-' + index;
        const wrapper = document.createElement('span'); button.before(wrapper); wrapper.append(button);
      }
      const distractor = document.createElement('button'); distractor.textContent = 'Log in 0'; document.body.prepend(distractor);
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const [index, attribute] of attributes.entries()) {
        const candidate = capture.candidates.find(
          (candidate) => candidate.label === `Log in ${index}`,
        );
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.deepEqual(target.xpaths, [`//*[@${attribute}='scope-${index}']//button`]);
        paths.push(target.xpaths[0]);
      }
      const expected = attributes.map((_, index) => [`target-${index}`]);
      assert.deepEqual((await verify(paths)).matches, expected);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, expected);
    },
  );
});

test("locators-test-scopes-retain-semantics-for-multiple-and-offscreen-children", async () => {
  await withFixture(
    `<div data-testid="account"><button data-oracle="save">Save</button><button>Cancel</button></div>
    <section aria-label="Employee"><div data-testid="repeated"><button data-oracle="employee">Approve</button></div></section>
    <section aria-label="Other" style="position:absolute;top:2000px"><div data-testid="repeated"><button>Approve</button></div></section>
    <script>window.mutateXpathFixture = () => {
      document.querySelector('[data-oracle="save"]').textContent = 'Delete';
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const name of ["Save", "Approve"]) {
        const candidate = capture.candidates.find((candidate) => candidate.label === name);
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.match(target.xpaths[0], /normalize-space/);
        if (name === "Approve") assert.match(target.xpaths[0], /Employee/);
        paths.push(target.xpaths[0]);
      }
      assert.deepEqual((await verify(paths)).matches, [["save"], ["employee"]]);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [
        [],
        ["employee"],
      ]);
    },
  );
});

test("locators-namespace-collisions-preserve-same-node-and-reject-replacement", async () => {
  await withFixture(
    `<svg width="120" height="80"><g role="button" aria-label="Diagram node" data-oracle="svg-target"><rect width="100" height="60"/></g></svg>
    <script>
      const foreign = document.createElementNS('urn:fixture:other', 'g');
      foreign.setAttribute('role', 'button'); foreign.setAttribute('aria-label', 'Diagram node');
      foreign.setAttribute('data-oracle', 'foreign-target'); document.querySelector('svg').append(foreign);
      window.mutateXpathFixture = () => document.querySelector('[data-oracle="svg-target"]').remove();
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find(
        (candidate) => candidate.tag === "g" && candidate.label === "Diagram node",
      );
      assert.ok(candidate);
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "inspect",
      });
      assert.match(target.xpaths[0], /namespace-uri\(\)/);
      assert.deepEqual((await verify(target.xpaths)).matches, [["svg-target"]]);
      assert.deepEqual((await observe({ xpaths: target.xpaths, mutateXpath: true })).matches, [[]]);
    },
  );
});

for (const scope of ["current_view"])
  test(`locators-semantic-xpath-survives-generated-ids-wrappers-and-reordering-${scope}`, async () => {
    await withFixture(
      `<label for="a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6">Country</label><input id="a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6" data-oracle="country">
    <div id="contacts"><input name="contact" placeholder="Email" data-oracle="email"><input name="contact" placeholder="Phone"><input name="backup" placeholder="Email"></div>
    <table><tr><td>Alice</td><td><button data-oracle="alice">Approve</button></td></tr><tr><td>Bob</td><td><button>Approve</button></td></tr></table>
    <header><button>Help</button></header><footer><button data-oracle="footer">Help</button></footer>
    <button data-test-id="stable-save" data-oracle="save">Save</button>
    <script>window.mutateXpathFixture = () => {
      const country = document.querySelector('[data-oracle="country"]');
      country.id = 'new-generated-country'; document.querySelector('label').htmlFor = country.id;
      const tbody = document.querySelector('tbody'); tbody.prepend(tbody.lastElementChild);
      for (const selector of ['[data-oracle="country"]','[data-oracle="email"]','[data-oracle="footer"]','[data-oracle="save"]']) {
        const node = document.querySelector(selector), wrapper = document.createElement('div');
        node.before(wrapper); wrapper.append(node); node.className = 'changed-style';
      }
      document.querySelector('#contacts').prepend(document.querySelector('input[name="backup"]'));
      const extra = document.createElement('button'); extra.textContent = 'Help'; document.querySelector('header').prepend(extra);
      document.querySelector('[data-oracle="save"]').textContent = 'Save changes';
    };</script>`,
      async (session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          scope,
          documentId: page.documentId,
        });
        const cases = [
          ["country", (candidate) => candidate.label === "Country"],
          ["email", (candidate) => candidate.tag === "input" && candidate.placeholder === "Email"],
          [
            "alice",
            (candidate) =>
              candidate.tag === "button" &&
              candidate.scope.some((scope) => scope.includes("Alice")),
          ],
          [
            "footer",
            (candidate) => candidate.label === "Help" && candidate.scope.includes("footer"),
          ],
          ["save", (candidate) => candidate.label === "Save"],
        ];
        const paths = [];
        for (const [expected, matches] of cases) {
          const candidate = capture.candidates.find(matches);
          assert.ok(candidate, expected);
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "inspect",
          });
          assert.equal(target.xpaths.length, 1);
          paths.push(target.xpaths[0]);
        }
        const expected = cases.map(([id]) => [id]);
        assert.deepEqual((await verify(paths)).matches, expected);
        assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, expected);
      },
    );
  });

for (const scope of ["current_view"])
  test(`locators-user-facing-xpath-survives-id-changes-and-rejects-changed-meaning-${scope}`, async () => {
    await withFixture(
      `<section aria-label="Profile"><button id="save-profile" data-oracle="save">Save changes</button>
    <label for="country">Country</label><input id="country" data-oracle="country"></section>
    <script>let mutation = 0; window.mutateXpathFixture = () => {
      const save = document.querySelector('[data-oracle="save"]');
      if (++mutation === 1) {
        save.id = 'save-profile-updated';
        const duplicate = save.cloneNode(true); duplicate.id = 'other-save';
        duplicate.setAttribute('data-oracle', 'other-save'); document.body.prepend(duplicate);
        const country = document.querySelector('[data-oracle="country"]');
        country.id = 'country-updated'; document.querySelector('label').htmlFor = country.id;
        const wrapper = document.createElement('div'); save.before(wrapper); wrapper.append(save);
      } else {
        const replacement = save.cloneNode(true); replacement.textContent = 'Cancel replacement';
        replacement.setAttribute('data-oracle', 'replacement'); save.replaceWith(replacement);
      }
    };</script>`,
      async (session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          scope,
          documentId: page.documentId,
        });
        const paths = [];
        for (const label of ["Save changes", "Country"]) {
          const candidate = capture.candidates.find((entry) => entry.label === label);
          assert.ok(candidate, label);
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "inspect",
          });
          assert.equal(target.xpaths.length, 1);
          paths.push(target.xpaths[0]);
        }
        assert.deepEqual((await verify(paths)).matches, [["save"], ["country"]]);
        assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [
          ["save"],
          ["country"],
        ]);
        assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [
          [],
          ["country"],
        ]);
      },
    );
  });

test("locators-hidden-text-fragments-survive-wrappers-and-reject-added-label-text", async () => {
  await withFixture(
    `<button data-oracle="save"><span style="display:none">PRIVATE_CSS_VALUE</span>Save <em>changes</em><textarea>PRIVATE_TEXTAREA_VALUE</textarea></button>
    <script>let mutation = 0; window.mutateXpathFixture = () => {
      const target = document.querySelector('button');
      if (++mutation === 1) {
        const wrapper = document.createElement('div'); target.before(wrapper); wrapper.append(target);
        const labelWrapper = document.createElement('span');
        const label = target.childNodes[1]; label.before(labelWrapper); labelWrapper.append(label);
      } else target.append(' and delete account');
    };</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.tag === "button");
      assert.equal(candidate.label, "Save changes");
      const selection = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.doesNotMatch(JSON.stringify({ capture, selection }), /PRIVATE_/);
      assert.equal(selection.target.xpaths.length, 1);
      const paths = selection.target.xpaths;
      const initial = await verify(paths);
      assert.deepEqual(initial.matches, [["save"]]);
      assert.equal(initial.scrollY, before.scrollY);
      assert.equal(initial.activeElement, before.activeElement);
      assert.deepEqual(initial.values, before.values);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [["save"]]);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [[]]);
    },
  );
});
