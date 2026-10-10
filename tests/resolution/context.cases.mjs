import assert from "node:assert/strict";
import test from "node:test";

import { request, observe, verify, withFixture } from "./fixture.mjs";

test("context-repeated-cards-retain-whole-item-identity-and-child-controls", async () => {
  await withFixture(
    `<style>#catalogue{display:grid;grid-template-columns:300px 300px;gap:20px}
    .card{height:180px;border:1px solid;display:flex;flex-direction:column}
    #shirt{order:2}#backpack{order:0}#lamp{order:1}</style>
    <main aria-label="Catalogue"><div id="catalogue">
      <div class="card" id="shirt"><a href="#">Shirt</a><p>Soft cotton</p><button id="shirt-cart">Add to cart</button><input data-observe-value value="PRIVATE_CARD_VALUE"><span hidden>PRIVATE_HIDDEN_CARD_TEXT</span></div>
      <div class="card" id="backpack"><a href="#">Backpack</a><p>Travel bag</p><button>Add to cart</button><input value="PRIVATE_OTHER_VALUE"><span hidden>PRIVATE_OTHER_TEXT</span></div>
      <div class="card" id="lamp"><a href="#">Lamp</a><p>Desk light</p><button disabled>Add to cart</button><input><span hidden>Hidden</span></div>
    </div></main><script>window.mutateXpathFixture=()=>document.querySelector('#backpack').style.order='3'</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_"));
      const shirt = capture.candidates.find(
        (c) => c.tag === "div" && c.text === "Shirt Soft cotton Add to cart",
      );
      const backpack = capture.candidates.find(
        (c) => c.tag === "div" && c.text === "Backpack Travel bag Add to cart",
      );
      const lamp = capture.candidates.find(
        (c) => c.tag === "div" && c.text === "Lamp Desk light Add to cart",
      );
      assert.ok(shirt && backpack && lamp, "Plain repeated cards must be selectable");
      assert.ok(shirt.geometry.y > backpack.geometry.y);
      assert.equal(lamp.geometry.y, backpack.geometry.y);
      assert.ok(lamp.geometry.x > backpack.geometry.x);
      assert.equal(capture.candidates.filter((c) => c.tag === "button").length, 3);
      assert.equal(capture.candidates.filter((c) => c.tag === "a").length, 3);
      assert.equal(capture.candidates.filter((c) => c.tag === "input").length, 3);
      const button = capture.candidates.find((c) => c.tag === "button" && c.parentId === shirt.id);
      assert.ok(button, "Item membership must survive unnamed layout wrappers");
      for (const candidate of capture.candidates) {
        if (candidate.parentId)
          assert.ok(capture.candidates.some((c) => c.id === candidate.parentId));
      }
      for (const [candidate, expected] of [
        [shirt, "shirt"],
        [button, "shirt-cart"],
      ]) {
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        const observed = await verify(target.xpaths);
        assert.deepEqual(observed.matches, [[expected]]);
        assert.equal(observed.scrollY, before.scrollY);
        assert.equal(observed.activeElement, before.activeElement);
        assert.deepEqual(observed.values, before.values);
        assert.equal(target.interactability.status, "ready");
      }
      await observe({ mutateXpath: true });
      const retained = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: shirt.id,
        action: "click",
      });
      assert.deepEqual((await verify(retained.target.xpaths)).matches, [["shirt"]]);
    },
  );
});

test("context-nested-layout-tables-retain-own-row-without-repeating-the-page", async () => {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const title = `Story ${index + 1} about browser testing`;
    return `<tr><td>${title}</td><td>${Array.from({ length: 6 }, (_, link) => `<a href="#story-${index}-${link}">Discussion link number ${link + 1}</a>`).join(" ")}</td></tr>`;
  }).join("");
  await withFixture(
    `<style>table{font:10px Arial;white-space:nowrap}</style>
    <section aria-label="News"><table><tr><td><table><tr><td><a id="expected-target" href="#new">new</a></td></tr></table></td></tr>
    <tr><td><table>${rows}</table></td></tr></table></section>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true, JSON.stringify(capture.coverage));
      const links = capture.candidates.filter((candidate) => candidate.tag === "a");
      assert.equal(links.length, 145);
      for (const link of links) {
        assert.ok(link.scope.includes("News"));
        assert.ok(
          !link.scope.some(
            (context) => context.includes("Story 1 about") && context.includes("Story 2 about"),
          ),
        );
      }
      const discussion = links.find((candidate) => candidate.label === "Discussion link number 1");
      assert.ok(
        discussion.scope.some((context) => context.includes("Story 1 about browser testing")),
      );
      const target = links.find((candidate) => candidate.label === "new");
      const selected = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: target.id,
        action: "click",
      });
      const after = await verify(selected.target.xpaths);
      assert.deepEqual(after.matches, [["expected-target"]]);
      assert.equal(selected.target.interactability.status, "ready");
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.clicks, "0");
    },
  );
});

test("context-table-rows-and-header-footer-scopes-distinguish-duplicates", async () => {
  await withFixture(
    '<header><button>Help</button></header><table><tr><td>Employee Alice</td><td><button>Approve</button><input value="ROW_SECRET"></td></tr><tr><td>Employee Bob</td><td><button>Approve</button></td></tr></table><footer><button>Help</button></footer>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const buttons = capture.candidates.filter((candidate) => candidate.tag === "button");
      assert.ok(buttons[0].scope.includes("header"));
      assert.ok(buttons[1].scope.some((scope) => scope.includes("Employee Alice")));
      assert.ok(buttons[2].scope.some((scope) => scope.includes("Employee Bob")));
      assert.ok(buttons[3].scope.includes("footer"));
      assert.equal(buttons[3].state.inViewport, true);
      assert.doesNotMatch(JSON.stringify(capture), /ROW_SECRET/);
    },
  );
});

test("context-unnamed-graphic-cards-retain-item-and-child-identity-without-layout-wrappers", async () => {
  const graphics = {
    img: `<img width="60" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='40'%3E%3Crect width='60' height='40' fill='red'/%3E%3C/svg%3E">`,
    svg: `<svg width="60" height="40"><circle cx="20" cy="20" r="15" fill="blue"/></svg>`,
    canvas: `<canvas width="60" height="40"></canvas>`,
    video: `<video width="60" height="40"></video>`,
  };
  const cards = Object.entries(graphics).map(
    ([tag, graphic]) =>
      `<div class="layout">${[1, 2]
        .map(
          (number) =>
            `<div class="card" id="${tag}-${number}"><div>${graphic.replace(
              `<${tag} `,
              `<${tag} id="${tag}-${number}-graphic" `,
            )}</div><div><button id="${tag}-${number}-cart">Add to cart</button></div></div>`,
        )
        .join("")}</div>`,
  );
  await withFixture(
    `<style>.layout{display:flex;gap:20px}.card{width:180px;height:105px;border:1px solid}.noncard{display:inline-block}</style>
     <main>${cards.join("")}</main>
     <div><div class="noncard"><button aria-label="Icon button"><svg width="20" height="20"><circle r="10"/></svg></button><span hidden>PRIVATE_LAYOUT_TEXT</span></div>
     <div class="noncard"><button aria-label="Icon button"><svg width="20" height="20"><circle r="10"/></svg></button><span hidden>PRIVATE_LAYOUT_TEXT</span></div></div>
     <div><div class="noncard"><img data-private width="20" height="20"><button>Add to cart</button></div>
     <div class="noncard"><img data-private width="20" height="20"><button>Add to cart</button></div></div>
     <input data-observe-value value="PRIVATE_CARD_FORM_VALUE">`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_/);
      const items = capture.candidates.filter((candidate) => candidate.isRepeatedItem);
      assert.equal(
        items.length,
        8,
        "Retain each graphic card, but not rows or icon-control wrappers",
      );
      const expected = Object.keys(graphics).flatMap((tag) => [`${tag}-1`, `${tag}-2`]);
      for (const [index, item] of items.entries()) {
        const children = capture.candidates.filter((candidate) => candidate.parentId === item.id);
        const graphic = children.find((candidate) => Object.hasOwn(graphics, candidate.tag));
        const button = children.find((candidate) => candidate.tag === "button");
        assert.ok(
          graphic && button,
          "Each unnamed graphic and button must retain their own card association",
        );
        assert.equal(graphic.label, "");
        assert.equal(graphic.text, "");
        assert.equal(button.label, "Add to cart");
        for (const [candidate, expectedId] of [
          [item, expected[index]],
          [graphic, `${expected[index]}-graphic`],
          [button, `${expected[index]}-cart`],
        ]) {
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "inspect",
          });
          assert.deepEqual((await verify(target.xpaths)).matches, [[expectedId]]);
        }
      }
      const after = await observe();
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
      assert.deepEqual(after.values, before.values);
      assert.deepEqual(after.events, before.events);
    },
  );
});
