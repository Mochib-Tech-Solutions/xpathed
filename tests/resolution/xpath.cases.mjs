import assert from "node:assert/strict";
import test from "node:test";

import { browserUrl, request, observe, verify, withFixture } from "./fixture.mjs";

test("xpath-offscreen-duplicates-preserve-document-wide-uniqueness", async () => {
  await withFixture(
    `<style>body{min-height:3000px}</style>
    <section aria-label="Profile"><button id="expected-target">Save</button></section>
    <section aria-label="Other" style="position:absolute;top:2000px"><button>Save</button></section>
    <script>window.mutateXpathFixture = () => {
      const other = document.querySelector('[aria-label="Other"]');
      other.className = 'new-style'; other.append(other.firstElementChild.cloneNode(true));
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      const candidate = capture.candidates.find((c) => c.label === "Save");
      assert.equal(capture.candidates.filter((c) => c.label === "Save").length, 1);
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      };
      const { target } = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(target.state.inViewport, true);
      assert.deepEqual((await verify(target.xpaths)).matches, [["expected-target"]]);
      const after = await observe({ mutateXpath: true, xpaths: target.xpaths });
      assert.deepEqual(after.matches, [["expected-target"]]);
      assert.equal(after.scrollY, 0);
      const revalidated = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(revalidated.target.state.inViewport, true);
    },
  );
});

for (const scope of ["current_view"])
  test(`xpath-quotes-are-escaped-and-duplicate-attributes-use-context-${scope}`, async () => {
    await withFixture(
      `<section aria-label="Employee"><button data-oracle="expected-target" data-testid="shared">OK</button></section>
    <section aria-label="Other"><button data-testid="shared">OK</button></section>
    <button data-oracle="quoted-target" data-testid="He said &quot;don't&quot;">Quoted</button>
    <div id="app"><a href="#unique" data-oracle="unique-target">Unique gallery</a></div>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          scope,
          documentId: page.documentId,
        });
        const employee = capture.candidates.find(
          (candidate) => candidate.tag === "button" && candidate.scope.includes("Employee"),
        );
        const selection = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: employee.id,
          action: "click",
        });
        assert.ok(selection.target.xpaths[0].includes("Employee"));
        assert.equal(selection.target.xpaths.length, 1);
        assert.ok(
          selection.target.xpaths.every((xpath) => !xpath.includes("[@data-testid='shared'][1]")),
        );
        assert.deepEqual(
          (await verify(selection.target.xpaths)).matches,
          selection.target.xpaths.map(() => ["expected-target"]),
        );
        const quoted = capture.candidates.find((candidate) => candidate.text === "Quoted");
        const quotedSelection = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: quoted.id,
          action: "click",
        });
        assert.ok(quotedSelection.target.xpaths[0].includes("concat("));
        assert.equal(quotedSelection.target.xpaths.length, 1);
        assert.deepEqual(
          (await verify(quotedSelection.target.xpaths)).matches,
          quotedSelection.target.xpaths.map(() => ["quoted-target"]),
        );
        const unique = capture.candidates.find((candidate) => candidate.tag === "a");
        const uniqueSelection = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: unique.id,
          action: "click",
        });
        assert.deepEqual(uniqueSelection.target.xpaths, [
          "//a[normalize-space(.)='Unique gallery']",
        ]);
        assert.deepEqual((await verify(uniqueSelection.target.xpaths)).matches, [
          ["unique-target"],
        ]);
      },
    );
  });

for (const scope of ["current_view"])
  test(`xpath-indistinguishable-elements-use-verified-positional-fallback-${scope}`, async () => {
    await withFixture(
      `<div><span data-oracle="expected-target">Same</span><span>Same</span></div>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          scope,
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((entry) => entry.tag === "span");
        const selection = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "hover",
        });
        assert.equal(selection.target.xpaths.length, 1);
        assert.ok(selection.target.xpaths[0].startsWith("/html/"));
        assert.deepEqual((await verify(selection.target.xpaths)).matches, [["expected-target"]]);
      },
    );
  });

for (const source of ["context", "unrelated"]) {
  test(`xpath-evidence-rechecks-only-retained-privacy-sources-${source}`, async () => {
    await withFixture(
      `<section><h2 id="context">Billing</h2><button id="expected-target">Save</button></section>
      <button id="unrelated">Other action</button>
      <script>window.mutateXpathFixture = () => document.querySelector('#${source}').setAttribute('data-private', '');</script>`,
      async (session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((item) => item.label === "Save");
        assert.ok(candidate);
        const identity = { documentId: page.documentId, captureId: capture.captureId };
        const evidence = await request(`/pages/${page.pageId}/xpath-evidence`, {
          ...identity,
          candidateIds: [candidate.id],
        });
        assert.ok(evidence.nodes.some((node) => node.tag === "h2" && node.text === "Billing"));
        const target = evidence.targets.find((item) => item.candidateId === candidate.id);
        assert.ok(target);
        await observe({ mutateXpath: true });
        const expression = "//section[h2[normalize-space(.)='Billing']]//button";
        // Deliberately exercise Browser's generic verifier after collecting its evidence.
        const response = await fetch(`${browserUrl}/pages/${page.pageId}/selections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...identity,
            xpathEvidenceId: evidence.evidenceId,
            actions: [{ actionId: "single", candidateId: candidate.id, action: "click" }],
            xpathProposals: [
              { nodeId: target.nodeId, proposals: [{ expression, requirements: [] }] },
            ],
          }),
        });
        const result = await response.json();
        assert.equal(response.status, source === "context" ? 409 : 200, JSON.stringify(result));
        if (source === "context") {
          assert.equal(result.code, "stale_capture");
        } else {
          assert.deepEqual(result.actions[0].target.xpaths, [expression]);
          assert.deepEqual((await verify([expression])).matches, [["expected-target"]]);
        }
      },
    );
  });
}

test("xpath-evidence-rejects-interleaved-capture-batches", async () => {
  await withFixture(
    `<section><h2 id="first-context">Private later</h2><button id="first">First action</button></section>
    <section><h2>Public context</h2><button id="second" onclick="window.observedEvents = { second: 1 }">Second action</button></section>
    <script>window.mutateXpathFixture = () => document.querySelector('#first-context').setAttribute('data-private', '');</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const first = capture.candidates.find((item) => item.label === "First action");
      const second = capture.candidates.find((item) => item.label === "Second action");
      assert.ok(first && second);
      const identity = { documentId: page.documentId, captureId: capture.captureId };
      const evidence = (candidate) =>
        request(`/pages/${page.pageId}/xpath-evidence`, {
          ...identity,
          candidateIds: [candidate.id],
        });
      const firstEvidence = await evidence(first);
      await observe({ mutateXpath: true });
      const secondEvidence = await evidence(second);
      assert.equal(typeof firstEvidence.evidenceId, "string");
      assert.ok(firstEvidence.evidenceId);
      assert.notEqual(firstEvidence.evidenceId, secondEvidence.evidenceId);
      const verifyBatch = (candidate, batch, expression) =>
        fetch(`${browserUrl}/pages/${page.pageId}/selections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...identity,
            xpathEvidenceId: batch.evidenceId,
            actions: [{ actionId: "single", candidateId: candidate.id, action: "click" }],
            xpathProposals: [
              {
                nodeId: batch.targets.find((item) => item.candidateId === candidate.id).nodeId,
                proposals: [{ expression, requirements: [] }],
              },
            ],
          }),
        });
      // The first request's verification is delayed until a concurrent request replaces its evidence.
      const [stale, current] = await Promise.all([
        verifyBatch(
          first,
          firstEvidence,
          "//section[h2[normalize-space(.)='Private later']]//button",
        ),
        verifyBatch(second, secondEvidence, "//button[@id='second']"),
      ]);
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "stale_xpath_evidence");
      assert.equal(current.status, 200);
      const selected = await current.json();
      assert.equal(selected.actions[0].target.candidateId, second.id);
      assert.deepEqual((await verify(selected.actions[0].target.xpaths)).matches, [["second"]]);
      const obsoleteAfterSuccess = await verifyBatch(first, firstEvidence, "//button[@id='first']");
      assert.equal(obsoleteAfterSuccess.status, 409);
      assert.equal((await obsoleteAfterSuccess.json()).code, "stale_xpath_evidence");
      const execution = await request(`/pages/${page.pageId}/execute`, {
        ...identity,
        sessionId: session.sessionId,
        actionId: "single",
      });
      assert.equal(execution.status, "completed");
      assert.equal((await observe()).events.second, 1);
    },
  );
});

for (const tag of ["x:control", "x$control"]) {
  test(`xpath-unusual-html-tag-${tag.includes(":") ? "colon" : "dollar"}`, async () => {
    await withFixture(
      `<${tag} role="button" aria-label="Save" data-oracle="expected" style="display:block;width:120px;height:40px">Save</${tag}>`,
      async (session, page) => {
        const before = await observe();
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((item) => item.tag === tag);
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        const after = await verify(target.xpaths);
        assert.deepEqual(after.matches, [["expected"]]);
        assert.equal(after.scrollY, before.scrollY);
        assert.equal(after.activeElement, before.activeElement);
      },
    );
  });
}

test("xpath-wrapping-native-label-survives-unrelated-insertion-and-wrapper", async () => {
  const secret = "PRIVATE_WRAPPING_LABEL_VALUE";
  await withFixture(
    `<label>Country <input data-oracle="expected" data-observe-value value="${secret}"></label>
    <label>Language <input></label>
    <script>window.mutateXpathFixture = () => {
      const unrelated = document.createElement('label');
      unrelated.innerHTML = 'Unrelated <input>';
      document.body.prepend(unrelated);
      const input = document.querySelector('[data-oracle="expected"]');
      const wrapper = document.createElement('span');
      input.before(wrapper); wrapper.append(input);
    };</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find(
        (item) => item.tag === "input" && item.label === "Country",
      );
      assert.ok(candidate);
      const identity = { documentId: page.documentId, captureId: capture.captureId };
      const evidence = await request(`/pages/${page.pageId}/xpath-evidence`, {
        ...identity,
        candidateIds: [candidate.id],
      });
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        ...identity,
        candidateId: candidate.id,
        action: "fill",
      });
      assert.ok(!JSON.stringify({ capture, evidence, target }).includes(secret));
      const selected = await verify(target.xpaths);
      assert.deepEqual(selected.matches, [["expected"]]);
      assert.equal(selected.scrollY, before.scrollY);
      assert.equal(selected.activeElement, before.activeElement);
      assert.deepEqual(selected.values, before.values);
      const changed = await observe({ xpaths: target.xpaths, mutateXpath: true });
      assert.deepEqual(changed.matches, [["expected"]]);
      assert.deepEqual(changed.values, [secret]);
    },
  );
});

for (const nested of [false, true]) {
  test(`xpath-${nested ? "nested" : "direct"}-heading-survives-wrapper-and-section-insertion`, async () => {
    const heading = (text) => (nested ? `<div><h2>${text}</h2></div>` : `<h2>${text}</h2>`);
    await withFixture(
      `<section>${heading("Billing")}<button data-oracle="expected">Save</button></section>
      <section>${heading("Shipping")}<button>Save</button></section>
      <script>window.mutateXpathFixture = () => {
        const heading = document.querySelector('h2');
        const wrapper = document.createElement('div');
        heading.before(wrapper); wrapper.append(heading);
        const unrelated = document.createElement('section');
        unrelated.innerHTML = '<h2>Unrelated</h2><button>Save</button>';
        document.body.prepend(unrelated);
      };</script>`,
      async (session, page) => {
        const before = await observe();
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidates = capture.candidates.filter(
          (item) => item.tag === "button" && item.scope.includes("Billing"),
        );
        assert.equal(candidates.length, 1);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidates[0].id,
          action: "click",
        });
        const selected = await verify(target.xpaths);
        assert.deepEqual(selected.matches, [["expected"]]);
        assert.equal(selected.scrollY, before.scrollY);
        assert.equal(selected.activeElement, before.activeElement);
        assert.deepEqual((await observe({ xpaths: target.xpaths, mutateXpath: true })).matches, [
          ["expected"],
        ]);
      },
    );
  });
}

test("xpath-heading-scope-excludes-nested-items-and-private-editable-hidden-content", async () => {
  await withFixture(
    `<section>
      <section><h2>Nested section</h2></section>
      <article><h2>Nested article</h2></article>
      <div role="group"><h2>Nested group</h2></div>
      <ul><li><h2>Nested item</h2></li></ul>
      <div><h2>Repeated item one</h2><button>First item action</button></div>
      <div><h2>Repeated item two</h2><button>Second item action</button></div>
      <div hidden><h2>HIDDEN_HEADING_SECRET</h2></div>
      <div data-private><h2>PRIVATE_HEADING_SECRET</h2></div>
      <div contenteditable><h2>EDITABLE_HEADING_SECRET</h2></div>
      <div><h2>Billing</h2></div>
      <button data-oracle="expected">Save</button>
    </section>
    <section><div><h2>Shipping</h2></div><button>Save</button></section>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find(
        (item) => item.tag === "button" && item.label === "Save" && item.scope.includes("Billing"),
      );
      assert.ok(candidate);
      assert.deepEqual(candidate.scope, ["Billing"]);
      const identity = { documentId: page.documentId, captureId: capture.captureId };
      const evidence = await request(`/pages/${page.pageId}/xpath-evidence`, {
        ...identity,
        candidateIds: [candidate.id],
      });
      assert.ok(evidence.nodes.some((node) => node.tag === "h2" && node.text === "Billing"));
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        ...identity,
        candidateId: candidate.id,
        action: "inspect",
      });
      assert.deepEqual((await verify(target.xpaths)).matches, [["expected"]]);
      for (const secret of [
        "HIDDEN_HEADING_SECRET",
        "PRIVATE_HEADING_SECRET",
        "EDITABLE_HEADING_SECRET",
      ])
        assert.ok(!JSON.stringify({ capture, evidence, target }).includes(secret), secret);
      for (const borrowed of [
        "Nested section",
        "Nested article",
        "Nested group",
        "Nested item",
        "Repeated item one",
        "Repeated item two",
      ])
        assert.ok(!JSON.stringify(evidence).includes(borrowed), borrowed);
    },
  );
});

for (const role of ["article", "unknown region"]) {
  test(`xpath-heading-scope-respects-${role.replaceAll(" ", "-")}-boundary`, async () => {
    await withFixture(
      `<section>
        <div role="${role}"><h2>Nested context</h2><button>Nested action</button></div>
        <div><h2>Billing</h2></div><button data-oracle="expected">Save</button>
      </section>`,
      async (session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find(
          (item) => item.tag === "button" && item.label === "Save",
        );
        assert.ok(candidate);
        assert.deepEqual(candidate.scope, ["Billing"]);
        const evidence = await request(`/pages/${page.pageId}/xpath-evidence`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateIds: [candidate.id],
        });
        assert.ok(evidence.nodes.some((node) => node.tag === "h2" && node.text === "Billing"));
        assert.ok(!JSON.stringify(evidence).includes("Nested context"));
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.deepEqual((await verify(target.xpaths)).matches, [["expected"]]);
      },
    );
  });
}

test("xpath-heading-scope-survives-deep-neutral-wrappers", async () => {
  await withFixture(
    `<script>
      let container = document.body;
      for (let index = 0; index < 1200; index++) {
        const wrapper = document.createElement('div');
        container.append(wrapper); container = wrapper;
      }
      container.innerHTML = '<h2>Billing</h2><button data-oracle="expected">Save</button>';
      window.mutateXpathFixture = () => {
        const unrelated = document.createElement('section');
        unrelated.innerHTML = '<h2>Unrelated</h2><button>Save</button>';
        document.body.prepend(unrelated);
      };
    </script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      const candidate = capture.candidates.find((item) => item.tag === "button");
      assert.ok(candidate);
      assert.deepEqual(candidate.scope, ["Billing"]);
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "inspect",
      });
      const selected = await verify(target.xpaths);
      assert.deepEqual(selected.matches, [["expected"]]);
      assert.equal(selected.scrollY, before.scrollY);
      assert.equal(selected.activeElement, before.activeElement);
      assert.deepEqual((await observe({ xpaths: target.xpaths, mutateXpath: true })).matches, [
        ["expected"],
      ]);
    },
  );
});
