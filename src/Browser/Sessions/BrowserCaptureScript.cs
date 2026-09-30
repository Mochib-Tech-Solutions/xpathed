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
          let exposureCache = new WeakMap();
          let modalityUnknown = false;
          const currentModal = () => {
            const modals = [...document.querySelectorAll('dialog:modal')];
            const active = document.activeElement?.closest('dialog:modal') ?? document.elementFromPoint(0, 0)?.closest('dialog:modal');
            modalityUnknown = modals.length > 1 && !active;
            return active ?? modals[0];
          };
          let modal = currentModal();
          const normalize = value => (value ?? '').replace(/\s+/gu, ' ').trim().normalize('NFC');
          const valueContainer = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
          const buttonInput = 'input[type=button],input[type=submit],input[type=reset]';
          const ignored = 'script,style,noscript,template';
          const cssFor = element => {
            if (!styleCache.has(element)) styleCache.set(element, getComputedStyle(element));
            return styleCache.get(element);
          };
          const exposed = element => {
            if (exposureCache.has(element)) return exposureCache.get(element);
            const ancestors = [];
            let current = element;
            while (current && !exposureCache.has(current)) {
              checkBudget(); ancestors.push(current); current = current.parentElement;
            }
            let allowed = current ? exposureCache.get(current) : true;
            while (ancestors.length) {
              current = ancestors.pop();
              const css = cssFor(current);
              const hiddenAria = current.getAttribute('aria-hidden')?.toLowerCase() === 'true' && !current.contains(document.activeElement);
              const inert = current.hasAttribute('inert') && !(modal && current !== modal && current.contains(modal));
              allowed = allowed && !current.matches(`${ignored},input[type=hidden]`) && !inert && !hiddenAria && css.display !== 'none' && css.contentVisibility !== 'hidden';
              const disclosure = current.parentElement;
              if (disclosure?.matches('details:not([open])') && current !== disclosure.querySelector(':scope > summary')) allowed = false;
              exposureCache.set(current, allowed);
            }
            return allowed;
          };
          const accessibilityExposed = element => (!modal || modal.contains(element)) && exposed(element) && !['hidden', 'collapse'].includes(cssFor(element).visibility);
          const rendered = element => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || !accessibilityExposed(element)) return false;
            for (let current = element; current; current = current.parentElement) {
              checkBudget();
              if (Number(cssFor(current).opacity) === 0) return false;
            }
            return true;
          };
          const nameText = (reference, references) => reference ? normalize(reference.getAttribute('aria-label')) ||
            normalize(reference.getAttribute('alt')) || text(reference, !accessibilityExposed(reference), references) : '';
          const text = (element, includeHidden = false, references = new Set()) => {
            if (!element || element.matches(valueContainer) || element.closest(ignored)) return '';
            if (references.has(element)) return '';
            const cacheable = !includeHidden && references.size === 0;
            if (cacheable && textCache.has(element)) return textCache.get(element);
            references = new Set(references).add(element);
            const parts = [];
            const pending = [];
            const children = node => {
              for (let index = node.childNodes.length - 1; index >= 0; index--) {
                checkBudget(); pending.push(node.childNodes[index]);
              }
            };
            children(element);
            while (pending.length) {
              checkBudget();
              const node = pending.pop();
              const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
              if (!parent || parent.closest(`${valueContainer},${ignored}`) || !includeHidden && !accessibilityExposed(parent)) continue;
              if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent);
              else {
                const referencedName = normalize((node.getAttribute('aria-labelledby') ?? '').split(/\s+/u)
                  .map(id => nameText(document.getElementById(id), references)).join(' '));
                if (referencedName) parts.push(referencedName);
                else if (normalize(node.getAttribute('aria-label'))) parts.push(node.getAttribute('aria-label'));
                else if (node.localName === 'img') parts.push(node.getAttribute('alt'));
                else children(node);
              }
            }
            const result = normalize(parts.join(' '));
            if (result.length > 64000) throw budgetExceeded;
            if (cacheable) textCache.set(element, result);
            return result;
          };
          const label = element => {
            if (labelCache.has(element)) return labelCache.get(element);
            const result = normalize((element.getAttribute('aria-labelledby') ?? '').split(/\s+/u).map(id => nameText(document.getElementById(id))).join(' ')) ||
              normalize(element.getAttribute('aria-label')) || normalize(Array.from(element.labels ?? [], reference => nameText(reference)).join(' ')) ||
              normalize(element.getAttribute('alt')) || (element.matches(buttonInput) ? normalize(element.value) : '') ||
              (element.matches('button,a[href],summary,[role=button],[role=checkbox],[role=radio]') ? text(element) : '') || normalize(element.getAttribute('title'));
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
          const roles = new Set('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'.split(' '));
          const role = element => {
            const explicit = (element.getAttribute('role') ?? '').split(/\s+/u).find(value => roles.has(value));
            const presentationConflict = ['none', 'presentation'].includes(explicit) &&
              ((!element.matches(':disabled') && (element.tabIndex >= 0 || element.hasAttribute('tabindex'))) ||
              element.matches('[aria-label],[aria-labelledby],[aria-describedby],[aria-description],[aria-controls],[aria-owns],[aria-live],[aria-busy],[aria-current]'));
            if (explicit && !presentationConflict) return explicit;
            return element.localName === 'select' ? element.multiple || element.size > 1 ? 'listbox' : 'combobox' :
            element.localName === 'a' ? element.hasAttribute('href') ? 'link' : '' :
            ({ button: 'button', textarea: 'textbox', summary: 'button', img: 'img' }[element.localName] ??
            (element.localName === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', number: 'spinbutton', range: 'slider', search: element.list ? 'combobox' : 'searchbox', text: element.list ? 'combobox' : 'textbox', email: element.list ? 'combobox' : 'textbox', tel: element.list ? 'combobox' : 'textbox', url: element.list ? 'combobox' : 'textbox' }[element.type] ?? '') : ''));
          };
          const textControl = element => element.isContentEditable || element.localName === 'textarea' ||
            element.localName === 'input' && ['text','search','email','url','tel','password','number'].includes(element.type);
          const geometry = element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const state = element => {
            const rect = geometry(element);
            return {
              version: '2', accessibilityExposed: accessibilityExposed(element), readonly: (element.localName === 'textarea' ||
                element.localName === 'input' && ['text','search','email','url','tel','password','number','date','month','week','time','datetime-local'].includes(element.type)) && element.readOnly ||
                ['textbox','searchbox','spinbutton','combobox','listbox','checkbox','slider'].includes(role(element)) && element.getAttribute('aria-readonly') === 'true',
              rendered: rendered(element),
              inViewport: rect.width > 0 && rect.height > 0 && rect.x < innerWidth && rect.y < innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0,
              enabled: !element.matches(':disabled') && !element.closest('[aria-disabled="true"]'),
              editable: textControl(element) && !element.readOnly && element.getAttribute('aria-readonly') !== 'true',
              checked: element.matches('input[type=checkbox],input[type=radio]') ? element.checked : ({ true: true, false: false }[element.getAttribute('aria-checked')] ?? null)
            };
          };
          const interactability = (element, action) => {
            const observed = state(element);
            const pointer = ['click', 'hover', 'check', 'uncheck'].includes(action);
            const editable = ['fill', 'type'].includes(action);
            const rect = geometry(element);
            const point = { x: Math.max(0, rect.x) + (Math.min(innerWidth, rect.x + rect.width) - Math.max(0, rect.x)) / 2,
              y: Math.max(0, rect.y) + (Math.min(innerHeight, rect.y + rect.height) - Math.max(0, rect.y)) / 2 };
            const hit = pointer && observed.inViewport ? document.elementFromPoint(point.x, point.y) : null;
            const semanticRole = role(element);
            const custom = editable ? !element.isContentEditable && !element.matches('input,textarea') && ['textbox','searchbox','spinbutton'].includes(semanticRole) :
              action === 'select' ? element.localName !== 'select' && ['combobox','listbox'].includes(semanticRole) :
              ['check','uncheck'].includes(action) ? !element.matches('input[type=checkbox],input[type=radio]') && ['checkbox','radio','switch'].includes(semanticRole) : false;
            const compatible = custom || (editable ? textControl(element) :
              action === 'select' ? element.localName === 'select' :
              ['check', 'uncheck'].includes(action) ? element.matches('input[type=checkbox],input[type=radio]') && !(action === 'uncheck' && element.type === 'radio') : true);
            const checks = {
              compatibleControl: custom ? 'unknown' : compatible ? 'pass' : 'fail',
              enabled: action === 'hover' ? 'not_applicable' : observed.enabled ? 'pass' : 'fail',
              writable: editable ? observed.readonly ? 'fail' : 'pass' : 'not_applicable',
              viewport: pointer ? observed.inViewport ? 'pass' : 'fail' : 'not_applicable',
              pointerReception: !pointer ? 'not_applicable' : !observed.inViewport ? 'unknown' : hit && (hit === element || element.contains(hit)) ? 'pass' : 'fail',
              keyboard: editable || action === 'select' ? 'unknown' : 'not_applicable',
              stability: 'unknown', eventOutcome: 'unknown'
            };
            const reasons = [];
            if (!compatible) reasons.push('incompatible_control');
            if (custom) reasons.push('custom_control_unverified');
            if (checks.enabled === 'fail') reasons.push('disabled');
            if (checks.writable === 'fail') reasons.push('readonly');
            if (rect.width <= 0 || rect.height <= 0) reasons.push('zero_area');
            else if (!observed.inViewport) reasons.push('off_screen');
            if (!observed.rendered) reasons.push('not_visually_rendered');
            if (checks.pointerReception === 'fail') reasons.push(getComputedStyle(element).pointerEvents === 'none' ? 'pointer_events_none' : 'obstructed_at_hit_point');
            return { version: '1', action, status: Object.values(checks).includes('fail') ? 'blocked' : custom ? 'unsupported' : 'unknown', reasons, checks };
          };
          const eligible = element => {
            if (!accessibilityExposed(element)) return false;
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
          let scannedCount = 0, eligibleCount = 0, unsupportedBoundaryCount = 0, bytes = 2, complete = !modalityUnknown;
          const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
          try {
            while (walker.nextNode()) {
              checkBudget();
              if (scannedCount === 20000) throw budgetExceeded;
              scannedCount++;
              const element = walker.currentNode;
              if ((element.localName === 'iframe' || element.shadowRoot) && accessibilityExposed(element)) unsupportedBoundaryCount++;
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
              coverage: { scannedCount, eligibleCount, capturedCount: candidates.length, complete, errorCode: complete ? null : modalityUnknown ? 'capture_exposure_unknown' : 'capture_budget_exceeded' }, unsupportedBoundaryCount },
            select(candidateId, action) {
              try {
              deadline = performance.now() + 2000;
              styleCache = new WeakMap(); textCache = new WeakMap(); labelCache = new WeakMap(); exposureCache = new WeakMap();
              modal = currentModal();
              if (modalityUnknown) return { errorCode: 'capture_exposure_unknown' };
              if (capturedDocument !== document) return { errorCode: 'stale_document' };
              if (!complete) return { errorCode: 'capture_budget_exceeded' };
              if (document.documentElement !== capturedRoot || nodes.some(node => !node.isConnected || node.ownerDocument !== document)) return { errorCode: 'stale_capture' };
              if (candidateId === null) return { target: null };
              const index = candidates.findIndex(candidate => candidate.id === candidateId);
              if (index < 0) return { errorCode: 'unknown_candidate' };
              const element = nodes[index];
              if (!element.isConnected || !accessibilityExposed(element)) return { errorCode: 'stale_capture' };
              const xpaths = xpathsFor(element);
              if (!xpaths.length) return { errorCode: 'xpath_validation_failed' };
              return { target: { candidateId, tag: element.localName, label: candidates[index].label || candidates[index].text,
                xpaths, state: state(element), geometry: geometry(element), interactability: interactability(element, action) } };
              } catch (error) {
                if (error === budgetExceeded) return { errorCode: 'validation_budget_exceeded' };
                throw error;
              }
            }
          };
        }
        """;
}
