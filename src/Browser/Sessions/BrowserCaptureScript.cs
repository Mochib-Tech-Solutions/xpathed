namespace Xpathed.Browser.Sessions;

internal static class BrowserCaptureScript
{
    public const string Capture = """
        identity => {
          const capturedDocument = document;
          const capturedRoot = document.documentElement;
          const budgetExceeded = {};
          let deadline = performance.now() + 2000;
          const checkBudget = () => { if (performance.now() > deadline) throw budgetExceeded; };
          let styleCache = new WeakMap();
          let textCache = new WeakMap();
          let labelCache = new WeakMap();
          const normalize = value => (value ?? '').replace(/\s+/gu, ' ').trim().normalize('NFC');
          const valueContainer = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
          const buttonInput = 'input[type=button],input[type=submit],input[type=reset]';
          const ignored = 'script,style,noscript,template';
          const rendered = element => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const ancestors = [];
            let current = element;
            while (current && !styleCache.has(current)) {
              checkBudget();
              ancestors.push(current);
              current = current.parentElement;
            }
            let visible = current ? styleCache.get(current) : true;
            while (ancestors.length) {
              current = ancestors.pop();
              const css = getComputedStyle(current);
              visible = visible && !current.matches('[hidden],[inert],[aria-hidden="true"]') && css.display !== 'none' && css.visibility === 'visible' && Number(css.opacity) > 0 && css.contentVisibility !== 'hidden';
              styleCache.set(current, visible);
            }
            return visible;
          };
          const text = element => {
            if (!element || element.matches(valueContainer) || element.closest(ignored)) return '';
            if (textCache.has(element)) return textCache.get(element);
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const parts = [];
            while (walker.nextNode()) {
              checkBudget();
              const parent = walker.currentNode.parentElement;
              if (parent && !parent.closest(`${valueContainer},${ignored}`) && rendered(parent)) parts.push(walker.currentNode.textContent);
            }
            const result = normalize(parts.join(' '));
            if (result.length > 64000) throw budgetExceeded;
            textCache.set(element, result);
            return result;
          };
          const label = element => {
            if (labelCache.has(element)) return labelCache.get(element);
            const result = normalize(element.getAttribute('aria-label')) ||
              normalize((element.getAttribute('aria-labelledby') ?? '').split(/\s+/u).map(id => text(document.getElementById(id))).join(' ')) ||
              normalize(Array.from(element.labels ?? [], text).join(' ')) || normalize(element.getAttribute('alt')) || normalize(element.getAttribute('title')) ||
              (element.matches(buttonInput) ? normalize(element.value) : '');
            labelCache.set(element, result);
            return result;
          };
          const scope = element => {
            const scopes = [];
            for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
              checkBudget();
              const context = label(ancestor) || text(ancestor.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6'));
              if (context && !scopes.includes(context)) scopes.push(context);
            }
            return scopes;
          };
          const role = element => element.getAttribute('role') || ({ button: 'button', a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button' }[element.localName] ??
            (element.localName === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button' }[element.type] ?? 'textbox') : ''));
          const geometry = element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const state = element => {
            const rect = geometry(element);
            return {
              rendered: rendered(element),
              inViewport: rect.x < innerWidth && rect.y < innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0,
              enabled: !element.matches(':disabled') && !element.closest('[aria-disabled="true"]'),
              editable: element.isContentEditable || element.matches('input:not([readonly]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]):not([type=hidden]),textarea:not([readonly])'),
              checked: element.matches('input[type=checkbox],input[type=radio]') ? element.checked : ({ true: true, false: false }[element.getAttribute('aria-checked')] ?? null)
            };
          };
          const eligible = element => {
            if (element.closest(ignored) || !rendered(element)) return false;
            const container = element.closest(valueContainer);
            if (container && container !== element) return false;
            return element.matches('a[href],button,input,select,textarea,summary,img[alt],[aria-label],[aria-labelledby],[role],[tabindex],[contenteditable]:not([contenteditable="false"])') ||
              (!element.closest('button,a,textarea,select,[contenteditable]:not([contenteditable="false"])') && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && normalize(node.textContent)));
          };
          const describe = (element, index) => ({
            id: `c${index + 1}`, tag: element.localName, role: role(element), text: text(element),
            label: label(element), placeholder: normalize(element.getAttribute('placeholder')), scope: scope(element),
            state: { ...state(element), checked: null }, geometry: geometry(element)
          });
          const nodes = [];
          const candidates = [];
          let scannedCount = 0, eligibleCount = 0, unsupportedBoundaryCount = 0, bytes = 2, complete = true;
          const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
          try {
            while (walker.nextNode()) {
              checkBudget();
              if (scannedCount === 20000) throw budgetExceeded;
              scannedCount++;
              const element = walker.currentNode;
              if ((element.localName === 'iframe' || element.shadowRoot) && rendered(element)) unsupportedBoundaryCount++;
              if (!eligible(element)) continue;
              eligibleCount++;
              if (eligibleCount > 2000) complete = false;
              if (!complete) continue;
              const candidate = describe(element, candidates.length);
              bytes += new TextEncoder().encode(JSON.stringify(candidate)).length + 1;
              if (bytes > 64000) { complete = false; continue; }
              nodes.push(element);
              candidates.push(candidate);
            }
          } catch (error) {
            if (error !== budgetExceeded) throw error;
            complete = false;
          }
          if (!complete) { nodes.length = 0; candidates.length = 0; }
          const literal = value => !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : `concat(${value.split("'").map(part => `'${part}'`).join(`,"'",`)})`;
          const tag = element => element.namespaceURI === 'http://www.w3.org/1999/xhtml' ? element.localName : `*[local-name()=${literal(element.localName)}]`;
          const testAttributes = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
          const stableAttributes = ['id', 'name', 'aria-label', 'placeholder', 'alt', 'title'];
          const attributes = (element, names) => names.filter(name => {
            const value = element.getAttribute(name);
            return value && !/https?:\/\//u.test(value) && (name !== 'id' || !/(?:[a-f\d]{16}|\d{5}|^:|^\d+$)/iu.test(value));
          }).map(name => `@${name}=${literal(element.getAttribute(name))}`);
          const xpathsFor = element => {
            const xpaths = [];
            const add = xpath => {
              if (xpaths.includes(xpath)) return;
              const matches = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              if (matches.snapshotLength === 1 && matches.snapshotItem(0) === element) xpaths.push(xpath);
            };
            const testPredicates = attributes(element, testAttributes);
            const stablePredicates = attributes(element, stableAttributes);
            const elementText = text(element);
            const semanticPredicates = elementText ? [`normalize-space(.)=${literal(elementText)}`] : [];
            if (element.matches(buttonInput) && element.getAttribute('value')) semanticPredicates.push(`@value=${literal(element.getAttribute('value'))}`);
            for (const predicate of [...testPredicates, ...stablePredicates]) add(`//${tag(element)}[${predicate}]`);
            for (const associatedLabel of element.labels ?? []) {
              const labelText = text(associatedLabel);
              if (labelText && element.id && associatedLabel.htmlFor === element.id) add(`//${tag(element)}[@id=//label[normalize-space(.)=${literal(labelText)}]/@for]`);
            }
            for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
              checkBudget();
              const predicates = [...attributes(ancestor, testAttributes), ...attributes(ancestor, stableAttributes)];
              const heading = ancestor.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6');
              if (heading && text(heading)) predicates.push(`${tag(heading)}[normalize-space(.)=${literal(text(heading))}]`);
              for (const context of predicates) {
                for (const predicate of [...testPredicates, ...stablePredicates, ...semanticPredicates]) add(`//${tag(ancestor)}[${context}]//${tag(element)}[${predicate}]`);
                add(`//${tag(ancestor)}[${context}]//${tag(element)}`);
              }
            }
            for (const predicate of semanticPredicates) add(`//${tag(element)}[${predicate}]`);
            if (!xpaths.length) {
              const segments = [];
              for (let current = element; current; current = current.parentElement) {
                const siblings = current.parentElement ? [...current.parentElement.children].filter(sibling => sibling.localName === current.localName && sibling.namespaceURI === current.namespaceURI) : [current];
                segments.unshift(`${tag(current)}${siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : ''}`);
              }
              add(`/${segments.join('/')}`);
            }
            return xpaths;
          };
          return {
            data: { ...identity, frameId: 'main', capturedAt: new Date().toISOString(), candidates,
              coverage: { scannedCount, eligibleCount, capturedCount: candidates.length, complete, errorCode: complete ? null : 'capture_budget_exceeded' }, unsupportedBoundaryCount },
            select(candidateId) {
              try {
              deadline = performance.now() + 2000;
              styleCache = new WeakMap(); textCache = new WeakMap(); labelCache = new WeakMap();
              if (capturedDocument !== document) return { errorCode: 'stale_document' };
              if (!complete) return { errorCode: 'capture_budget_exceeded' };
              if (document.documentElement !== capturedRoot || nodes.some(node => !node.isConnected || node.ownerDocument !== document)) return { errorCode: 'stale_capture' };
              if (candidateId === null) return { target: null };
              const index = candidates.findIndex(candidate => candidate.id === candidateId);
              if (index < 0) return { errorCode: 'unknown_candidate' };
              const element = nodes[index];
              if (!element.isConnected || !state(element).rendered) return { errorCode: 'stale_capture' };
              const xpaths = xpathsFor(element);
              if (!xpaths.length) return { errorCode: 'xpath_validation_failed' };
              return { target: { candidateId, tag: element.localName, label: candidates[index].label || candidates[index].text,
                xpaths, state: state(element), geometry: geometry(element) } };
              } catch (error) {
                if (error === budgetExceeded) return { errorCode: 'validation_budget_exceeded' };
                throw error;
              }
            }
          };
        }
        """;
}
