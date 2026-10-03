namespace Xpathed.Browser.Sessions;

internal static class BrowserCaptureScript
{
    public const string Capture = """
        async identity => {
          let environment = JSON.parse(identity.environment);
          const frame = JSON.parse(identity.frame);
          const viewport = () => [innerWidth, innerHeight, scrollX, scrollY, visualViewport?.offsetLeft ?? 0, visualViewport?.offsetTop ?? 0, visualViewport?.scale ?? 1];
          const initialViewport = viewport();
          const scrollContainers = [];
          const viewUnchanged = () => viewport().every((value, index) => value === initialViewport[index]) &&
            scrollContainers.every(([element, x, y, width, height]) => element.isConnected && element.scrollLeft === x && element.scrollTop === y && element.clientWidth === width && element.clientHeight === height);
          const capturedDocument = document;
          const capturedRoot = document.documentElement;
          const budgetExceeded = {};
          let deadline = performance.now() + (identity.budgetMs ?? 2000);
          const checkBudget = () => { if (performance.now() > deadline) throw budgetExceeded; };
          let styleCache = new WeakMap();
          let textCache = new WeakMap();
          let labelCache = new WeakMap();
          let exposureCache = new WeakMap();
          let intersections = new WeakMap();
          let siblingShapes = new WeakMap();
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
          const accessibilityExposed = element => environment.exposed && (!modal || modal.contains(element)) && exposed(element) && !['hidden', 'collapse'].includes(cssFor(element).visibility);
          const rendered = element => {
            const rect = element.getBoundingClientRect();
            if (!environment.rendered || rect.width <= 0 || rect.height <= 0 || !accessibilityExposed(element)) return false;
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
              else if (node.nodeType === Node.ELEMENT_NODE) {
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
              const context = label(ancestor) || (ancestor.matches('tr,[role=row]') ? text(ancestor) : '') || (ancestor.matches('header,footer,nav,main,aside') ? ancestor.localName : '') || text(ancestor.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6'));
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
          const fillControl = element => textControl(element) || element.localName === 'input' &&
            ['date','month','week','time','datetime-local'].includes(element.type);
          const geometry = element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x: environment.x + x * environment.scaleX, y: environment.y + y * environment.scaleY,
              width: width * environment.scaleX, height: height * environment.scaleY };
          };
          const intersection = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
          const observeIntersections = async elements => {
            const pending = new Set(elements);
            intersections = new WeakMap();
            if (!pending.size) return;
            checkBudget();
            let observer, timeout;
            try {
              await new Promise((resolve, reject) => {
                timeout = setTimeout(() => reject(budgetExceeded), Math.max(0, deadline - performance.now()));
                observer = new IntersectionObserver(entries => {
                  for (const entry of entries) {
                    const { x, y, width, height } = entry.intersectionRect;
                    intersections.set(entry.target, { x, y, width, height });
                    pending.delete(entry.target);
                  }
                  if (!pending.size) resolve();
                }, { root: document });
                for (const element of pending) observer.observe(element);
              });
              checkBudget();
            } finally { clearTimeout(timeout); observer?.disconnect(); }
          };
          const visibleRect = element => {
            const rect = intersections.get(element);
            if (!rect || rect.width <= 0 || rect.height <= 0) return { left:0, top:0, right:0, bottom:0 };
            return intersection(environment.clip, { left: environment.x + rect.x * environment.scaleX, top: environment.y + rect.y * environment.scaleY,
              right: environment.x + (rect.x + rect.width) * environment.scaleX, bottom: environment.y + (rect.y + rect.height) * environment.scaleY });
          };
          const pointFor = element => { const clip = visibleRect(element); return { x: (clip.left + clip.right) / 2, y: (clip.top + clip.bottom) / 2 }; };
          const inView = element => { const rect = visibleRect(element); return rect.right > rect.left && rect.bottom > rect.top; };
          const receivesPoint = (element, point) => {
            const hit = document.elementFromPoint((point.x - environment.x) / environment.scaleX, (point.y - environment.y) / environment.scaleY);
            return !!hit && (hit === element || element.contains(hit));
          };
          const reset = budgetMs => {
            deadline = performance.now() + budgetMs;
            styleCache = new WeakMap(); textCache = new WeakMap(); labelCache = new WeakMap(); exposureCache = new WeakMap(); siblingShapes = new WeakMap();
            modal = currentModal();
          };
          const state = element => {
            const rect = visibleRect(element);
            return {
              accessibilityExposed: accessibilityExposed(element), readonly: (element.localName === 'textarea' ||
                element.localName === 'input' && ['text','search','email','url','tel','password','number','date','month','week','time','datetime-local'].includes(element.type)) && element.readOnly ||
                ['textbox','searchbox','spinbutton','combobox','listbox','checkbox','slider'].includes(role(element)) && element.getAttribute('aria-readonly') === 'true',
              rendered: rendered(element),
              inViewport: rect.right > rect.left && rect.bottom > rect.top,
              enabled: environment.enabled !== false && !element.matches(':disabled') && !element.closest('[aria-disabled="true"]'),
              editable: fillControl(element) && !element.readOnly && element.getAttribute('aria-readonly') !== 'true',
              selected: ({ true: true, false: false }[element.getAttribute('aria-selected')] ?? null),
              selectedOptionCount: element.localName === 'select' ? element.selectedOptions.length : null,
              checked: element.matches('input[type=checkbox],input[type=radio]') ? element.checked : ({ true: true, false: false }[element.getAttribute('aria-checked')] ?? null)
            };
          };
          const interactability = (element, action) => {
            const observed = state(element);
            const pointer = ['click', 'double_click', 'right_click', 'hover', 'check', 'uncheck'].includes(action);
            const editable = ['fill', 'type', 'clear'].includes(action);
            const keyboard = editable || ['select', 'press', 'focus', 'blur', 'upload'].includes(action);
            const rect = geometry(element);
            const hit = pointer && observed.inViewport && receivesPoint(element, pointFor(element));
            const semanticRole = role(element);
            const custom = editable ? !element.isContentEditable && !element.matches('input,textarea') && ['textbox','searchbox','spinbutton'].includes(semanticRole) :
              action === 'select' ? element.localName !== 'select' && ['combobox','listbox'].includes(semanticRole) :
              ['check','uncheck'].includes(action) ? !element.matches('input[type=checkbox],input[type=radio]') && ['checkbox','radio','switch'].includes(semanticRole) : false;
            const compatible = custom || (editable ? (action === 'type' ? textControl(element) : fillControl(element)) :
              action === 'select' ? element.localName === 'select' :
              action === 'upload' ? element.matches('input[type=file]') :
              ['focus', 'blur', 'press'].includes(action) ? element.isContentEditable || element.matches('input,textarea,select,button,a[href],summary,[tabindex]') :
              ['check', 'uncheck'].includes(action) ? element.matches('input[type=checkbox],input[type=radio]') && !(action === 'uncheck' && element.type === 'radio') : true);
            const checks = {
              compatibleControl: custom ? 'unknown' : compatible ? 'pass' : 'fail',
              enabled: ['hover', 'inspect', 'blur'].includes(action) ? 'not_applicable' : observed.enabled ? 'pass' : 'fail',
              writable: editable ? observed.readonly ? 'fail' : 'pass' : 'not_applicable',
              viewport: pointer ? observed.inViewport ? 'pass' : 'fail' : 'not_applicable',
              pointerReception: !pointer ? 'not_applicable' : !observed.inViewport ? 'unknown' : hit ? 'pass' : 'fail',
              keyboard: keyboard ? 'unknown' : 'not_applicable',
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
            const readiness = [checks.compatibleControl, checks.enabled, checks.writable, checks.viewport, checks.pointerReception, checks.keyboard];
            return { action, status: readiness.includes('fail') ? 'blocked' : custom ? 'unsupported' : readiness.includes('unknown') ? 'unknown' : 'ready', reasons, checks };
          };
          const shape = element => `${element.localName}:${[...element.children].map(child => child.localName).join(',')}`;
          const repeatedItem = element => {
            if (!element.matches('div,section,article,li,figure') || element.children.length < 2 || !element.parentElement) return false;
            const parent = element.parentElement;
            if (!siblingShapes.has(parent)) {
              const counts = new Map();
              for (const sibling of parent.children) {
                checkBudget();
                const key = shape(sibling);
                counts.set(key, (counts.get(key) ?? 0) + 1);
              }
              siblingShapes.set(parent, counts);
            }
            if (siblingShapes.get(parent).get(shape(element)) < 2) return false;
            // Retain repeated content items, not every layout wrapper or a copy of one control.
            const names = new Set();
            for (const child of element.querySelectorAll('a[href],button,img[alt],h1,h2,h3,h4,h5,h6,[role=button],[role=heading]')) {
              checkBudget();
              if (!accessibilityExposed(child)) continue;
              const name = label(child) || text(child);
              if (name) names.add(name);
              if (names.size >= 2) return true;
            }
            return false;
          };
          const eligible = element => {
            if (!accessibilityExposed(element)) return false;
            const container = element.closest(valueContainer);
            if (container && container !== element) return false;
            return element.matches('a[href],button,input,select,textarea,summary,img[alt],[aria-label],[aria-labelledby],[role],[tabindex],[contenteditable]:not([contenteditable="false"])') ||
              (!element.closest('button,a,textarea,select,[contenteditable]:not([contenteditable="false"])') &&
                ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && normalize(node.textContent)) || repeatedItem(element)));
          };
          const complexEffects = element => {
            if (environment.complexEffects) return true;
            for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
              checkBudget();
              const style = cssFor(ancestor);
              if (Number(style.opacity) !== 1 || style.filter !== 'none' || style.mixBlendMode !== 'normal' ||
                style.backdropFilter && style.backdropFilter !== 'none' || style.maskImage && style.maskImage !== 'none') {
                return true;
              }
            }
            return false;
          };
          const appearance = element => {
            const css = cssFor(element);
            const limitations = complexEffects(element) ? ['complex_effects'] : [];
            if (css.backgroundImage !== 'none') limitations.push('background_image');
            if (element.matches('img,svg,canvas,video,object,embed') || element.querySelector('img,svg,canvas,video,object,embed')) limitations.push('replaced_content');
            if (['::before','::after'].some(pseudo => {
              const style = getComputedStyle(element, pseudo);
              return !['none','normal'].includes(style.content) && style.display !== 'none';
            })) limitations.push('pseudo_element_appearance');
            if (limitations.length) return { backgroundColor:null, textColor:null, borderColor:null, limitations };
            const opaqueColor = value => {
              if (/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/u.test(value)) return value;
              if (value === 'rgba(0, 0, 0, 0)') return null;
              if (!limitations.includes('unsupported_color')) limitations.push('unsupported_color');
              return null;
            };
            const backgroundColor = opaqueColor(css.backgroundColor);
            if (css.backgroundColor === 'rgba(0, 0, 0, 0)') limitations.push('background_transparent');
            const textColor = opaqueColor(css.color);
            const sides = ['Top','Right','Bottom','Left'].filter(side => Number.parseFloat(css[`border${side}Width`]) > 0 && !['none','hidden'].includes(css[`border${side}Style`]));
            const borders = [...new Set(sides.map(side => css[`border${side}Color`]))];
            const borderColor = borders.length === 1 ? opaqueColor(borders[0]) : null;
            if (borders.length > 1) limitations.push('mixed_border_colors');
            return { backgroundColor, textColor, borderColor, limitations };
          };
          const describe = (element, index) => ({
            id: `${frame.id}:c${index + 1}`, frame, tag: element.localName, role: role(element), text: text(element),
            label: label(element), placeholder: normalize(element.getAttribute('placeholder')), scope: [...new Set([...scope(element), ...(environment.scope ?? [])])],
            state: { ...state(element), checked: null, selected: null, selectedOptionCount: null }, geometry: geometry(element),
            appearance: appearance(element), isRepeatedItem: repeatedItem(element)
          });
          const nodes = [];
          const nodeIds = new Map();
          const parentIdFor = element => {
            for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
              checkBudget();
              if (nodeIds.has(ancestor) && !ancestor.matches('a[href],button,input,select,textarea,summary,[role=button],[role=link]')) return nodeIds.get(ancestor);
            }
          };
          const frameElements = [];
          const shadowHosts = [];
          const candidates = [];
          let scannedCount = 0, eligibleCount = 0, excludedOffscreenCount = 0, unsupportedBoundaryCount = 0, bytes = 2, complete = !modalityUnknown, viewChanged = false;
          const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
          try {
            while (walker.nextNode()) {
              checkBudget();
              if (scannedCount === 20000) throw budgetExceeded;
              scannedCount++;
              const element = walker.currentNode;
              if (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
                scrollContainers.push([element, element.scrollLeft, element.scrollTop, element.clientWidth, element.clientHeight]);
              if (element.shadowRoot && accessibilityExposed(element)) {
                shadowHosts.push(element);
              }
              if (element.matches('iframe,frame') && accessibilityExposed(element)) frameElements.push(element);
              if (!eligible(element)) continue;
              eligibleCount++;
              if (!complete) continue;
              nodes.push(element);
            }
            if (complete) {
              await observeIntersections([...nodes, ...frameElements, ...shadowHosts, ...scrollContainers.map(([element]) => element)]);
              if (!viewUnchanged()) { viewChanged = true; throw budgetExceeded; }
              unsupportedBoundaryCount = shadowHosts.filter(inView).length;
              const retained = nodes.filter(inView);
              excludedOffscreenCount = nodes.length - retained.length;
              nodes.length = 0; nodes.push(...retained);
              const retainedFrames = frameElements.filter(inView);
              frameElements.length = 0; frameElements.push(...retainedFrames);
              const relevantAncestors = new Set();
              for (const node of [...nodes, ...frameElements]) {
                for (let ancestor = node.parentElement; ancestor && !relevantAncestors.has(ancestor); ancestor = ancestor.parentElement) {
                  checkBudget(); relevantAncestors.add(ancestor);
                }
              }
              for (let index = scrollContainers.length - 1; index >= 0; index--) {
                const [element] = scrollContainers[index];
                if (!inView(element) && !relevantAncestors.has(element)) scrollContainers.splice(index, 1);
              }
              if (nodes.length > 2000) throw budgetExceeded;
              nodes.forEach((element, index) => nodeIds.set(element, `${frame.id}:c${index + 1}`));
              for (const element of nodes) {
                checkBudget();
                const candidate = describe(element, candidates.length);
                candidate.parentId = parentIdFor(element);
                bytes += new TextEncoder().encode(JSON.stringify(candidate)).length + 1;
                if (bytes > 512000) { complete = false; break; }
                candidates.push(candidate);
              }
            }
          } catch (error) {
            if (error !== budgetExceeded) throw error;
            complete = false;
          }
          if (!complete) { nodes.length = 0; candidates.length = 0; }
          const capturedView = new Set([...nodes, ...frameElements, ...shadowHosts.filter(inView)]);
          const literal = value => !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : `concat(${value.split("'").map(part => `'${part}'`).join(`,"'",`)})`;
          const tag = element => element.namespaceURI === 'http://www.w3.org/1999/xhtml' ? element.localName : `*[local-name()=${literal(element.localName)}]`;
          const testAttributes = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
          const stableAttributes = ['id', 'name', 'aria-label', 'placeholder', 'alt', 'title'];
          const attributes = (element, names) => names.filter(name => {
            const value = element.getAttribute(name);
            return value && !/https?:\/\//u.test(value) && (name !== 'id' || !/(?:[a-f\d]{16}|\d{5}|^:|^\d+$|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})/iu.test(value));
          }).map(name => `@${name}=${literal(element.getAttribute(name))}`);
          const semanticAttributes = ['aria-label', 'placeholder', 'alt', 'title'];
          const textPredicates = element => {
            const semanticText = text(element);
            if (!semanticText) return [];
            const predicates = [`normalize-space(.)=${literal(semanticText)}`];
            const parts = [];
            const fragments = [];
            const xpathNormalize = value => value.replace(/[ \t\r\n]+/gu, ' ').replace(/^ | $/gu, '');
            let count = 0, excluded = false;
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              checkBudget();
              if (node.textContent.length > 64000) return predicates;
              const value = xpathNormalize(node.textContent);
              if (value) count++;
              // Bound expression size as well as the shared validation deadline.
              if (count > 16) return predicates;
              const parent = node.parentElement;
              if (parent.closest(`${valueContainer},${ignored}`) || !accessibilityExposed(parent)) {
                excluded = true;
                continue;
              }
              parts.push(node.textContent);
              if (value) fragments.push(`descendant::text()[normalize-space(.)!=''][${count}][normalize-space(.)=${literal(value)}]`);
            }
            // XPath joins descendant text without separators and normalizes only XML whitespace.
            // Accessible-name substitutions must not silently become unrelated DOM text.
            if (normalize(parts.join(' ')) !== semanticText) return predicates;
            if (excluded) {
              // Keep only exposed text literals. The count guard rejects added/replaced label fragments.
              if (fragments.length) predicates.push(`count(descendant::text()[normalize-space(.)!=''])=${count} and ${fragments.join(' and ')}`);
            } else {
              const xpathText = xpathNormalize(parts.join(''));
              if (xpathText && xpathText !== semanticText) predicates.push(`normalize-space(.)=${literal(xpathText)}`);
            }
            return predicates;
          };
          const contextPredicates = ancestor => {
            const predicates = attributes(ancestor, [...testAttributes, 'aria-label', 'title']);
            const heading = ancestor.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6');
            if (heading) predicates.push(...textPredicates(heading).map(predicate => `${tag(heading)}[${predicate}]`));
            if (ancestor.matches('tr,[role=row]')) {
              for (const cell of ancestor.children) {
                if (cell.matches('td,th,[role=cell],[role=rowheader],[role=gridcell]'))
                  predicates.push(...textPredicates(cell).map(predicate => `${tag(cell)}[${predicate}]`));
              }
            }
            return predicates;
          };
          const xpathsFor = element => {
            const xpaths = [];
            const add = xpath => {
              checkBudget();
              const matches = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              if (matches.snapshotLength !== 1 || matches.snapshotItem(0) !== element) return false;
              xpaths.push(xpath);
              return true;
            };
            const testPredicates = attributes(element, testAttributes);
            const stablePredicates = attributes(element, stableAttributes);
            const semanticPredicates = attributes(element, semanticAttributes);
            semanticPredicates.push(...textPredicates(element));
            if (element.matches(buttonInput) && element.getAttribute('value')) semanticPredicates.push(`@value=${literal(element.getAttribute('value'))}`);
            for (const predicate of testPredicates) if (add(`//${tag(element)}[${predicate}]`)) return xpaths;
            for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
              checkBudget();
              const prefixes = contextPredicates(ancestor).map(context => `//${tag(ancestor)}[${context}]`);
              if (ancestor.matches('header,footer,nav,main,aside')) prefixes.push(`//${tag(ancestor)}`);
              for (const prefix of prefixes) {
                for (const predicate of [...testPredicates, ...semanticPredicates])
                  if (add(`${prefix}//${tag(element)}[${predicate}]`)) return xpaths;
              }
            }
            for (const associatedLabel of element.labels ?? []) {
              if (element.id && associatedLabel.htmlFor === element.id)
                for (const predicate of textPredicates(associatedLabel))
                  if (add(`//${tag(element)}[@id=//label[${predicate}]/@for]`)) return xpaths;
            }
            for (const predicate of semanticPredicates) if (add(`//${tag(element)}[${predicate}]`)) return xpaths;
            for (const predicate of stablePredicates) if (add(`//${tag(element)}[${predicate}]`)) return xpaths;
            const targetPredicates = [...testPredicates, ...stablePredicates];
            for (let first = 0; first < targetPredicates.length; first++) {
              for (let second = first + 1; second < targetPredicates.length; second++) {
                if (add(`//${tag(element)}[${targetPredicates[first]} and ${targetPredicates[second]}]`)) return xpaths;
              }
            }
            for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
              checkBudget();
              const predicates = [...contextPredicates(ancestor), ...attributes(ancestor, ['id', 'name'])];
              const prefixes = predicates.map(context => `//${tag(ancestor)}[${context}]`);
              if (ancestor.matches('header,footer,nav,main,aside')) prefixes.push(`//${tag(ancestor)}`);
              for (const prefix of prefixes) {
                for (const predicate of [...targetPredicates, ...semanticPredicates]) if (add(`${prefix}//${tag(element)}[${predicate}]`)) return xpaths;
                if (add(`${prefix}//${tag(element)}`)) return xpaths;
              }
            }
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
            frameElements,
            highlightNodes(ids) {
              return ids.map(id => {
                const node = nodes[candidates.findIndex(candidate => candidate.id === id)];
                if (!node?.isConnected || node.ownerDocument !== document) throw new Error('stale_capture');
                return node;
              });
            },
            async updateEnvironment(value, budgetMs, scanBudget) {
              try {
                environment = value ? JSON.parse(value) : { x:0, y:0, scaleX:1, scaleY:1, exposed:true, rendered:true, clip:{left:0,top:0,right:innerWidth,bottom:innerHeight} };
                reset(budgetMs);
                if (!viewUnchanged()) return { errorCode: 'stale_capture' };
                const observed = [];
                let scanned = 0;
                const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
                while (walker.nextNode()) {
                  checkBudget();
                  if (++scanned > scanBudget) throw budgetExceeded;
                  const element = walker.currentNode;
                  if (eligible(element) || (element.matches('iframe,frame') || element.shadowRoot) && accessibilityExposed(element)) observed.push(element);
                }
                await observeIntersections(observed);
                if (!viewUnchanged()) return { errorCode: 'stale_capture' };
                const visible = observed.filter(inView);
                if (visible.length !== capturedView.size || visible.some(element => !capturedView.has(element))) return { errorCode: 'stale_capture' };
                for (let index = 0; index < nodes.length; index++) {
                  checkBudget();
                  const candidate = candidates[index], node = nodes[index];
                  if (parentIdFor(node) !== candidate.parentId) return { errorCode: 'stale_capture' };
                  if (candidate.isRepeatedItem) {
                    const current = geometry(node);
                    if (Object.keys(current).some(key => current[key] !== candidate.geometry[key])) return { errorCode: 'stale_capture' };
                  }
                }
                return { scannedCount: scanned };
              } catch (error) { if (error === budgetExceeded) return { errorCode: 'validation_budget_exceeded' }; throw error; }
            },
            receivesPoint(element, point, budgetMs) { reset(budgetMs); return receivesPoint(element, point); },
            point(candidateId, budgetMs) {
              try { reset(budgetMs); return pointFor(nodes[candidates.findIndex(candidate => candidate.id === candidateId)]); }
              catch (error) { if (error === budgetExceeded) return { errorCode: 'validation_budget_exceeded' }; throw error; }
            },
            frameInfo(element, budgetMs) {
              try {
              reset(budgetMs);
              if (!element.isConnected || element.ownerDocument !== document || !frameElements.includes(element)) throw new Error('stale_frame');
              const rect = geometry(element);
              const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : environment.scaleX;
              const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : environment.scaleY;
              let geometrySupported = true;
              for (let current = element; current; current = current.parentElement) {
                checkBudget();
                const css = cssFor(current);
                const individualScale = css.scale === 'none' ? [] : css.scale.split(/\s+/u).map(Number);
                const matrix = css.transform === 'none' ? null : new DOMMatrixReadOnly(css.transform);
                if (matrix && (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) || css.perspective !== 'none' || css.rotate !== 'none' || individualScale.some(value => !Number.isFinite(value) || value <= 0)) geometrySupported = false;
              }
              return { xpath: xpathsFor(element)[0], label: label(element),
                environment: { scope: [...new Set([...scope(element), ...(environment.scope ?? [])])], x: rect.x + element.clientLeft * scaleX, y: rect.y + element.clientTop * scaleY, scaleX: scaleX || 1, scaleY: scaleY || 1,
                  clip: intersection(visibleRect(element), { left: rect.x + element.clientLeft * scaleX, top: rect.y + element.clientTop * scaleY,
                    right: rect.x + (element.clientLeft + element.clientWidth) * scaleX, bottom: rect.y + (element.clientTop + element.clientHeight) * scaleY }),
                  exposed: accessibilityExposed(element), rendered: rendered(element), enabled: state(element).enabled, geometrySupported,
                  complexEffects: complexEffects(element) } };
              } catch (error) { if (error === budgetExceeded) return { errorCode: 'capture_budget_exceeded' }; throw error; }
            },
            data: { sessionId: identity.sessionId, pageId: identity.pageId, documentId: identity.documentId, captureId: identity.captureId, frameId: frame.id, capturedAt: new Date().toISOString(), candidates, scope: identity.scope,
              coverage: { scannedCount, eligibleCount, excludedOffscreenCount, capturedCount: candidates.length, complete, errorCode: complete ? null : viewChanged ? 'capture_view_changed' : modalityUnknown ? 'capture_exposure_unknown' : 'capture_budget_exceeded' }, unsupportedBoundaryCount },
            select(candidateId, action, budgetMs = 2000) {
              try {
              deadline = performance.now() + budgetMs;
              styleCache = new WeakMap(); textCache = new WeakMap(); labelCache = new WeakMap(); exposureCache = new WeakMap();
              modal = currentModal();
              if (modalityUnknown) return { errorCode: 'capture_exposure_unknown' };
              if (capturedDocument !== document) return { errorCode: 'stale_document' };
              if (!complete) return { errorCode: 'capture_budget_exceeded' };
              if (!viewUnchanged()) return { errorCode: 'stale_capture' };
              if (document.documentElement !== capturedRoot || nodes.some(node => !node.isConnected || node.ownerDocument !== document)) return { errorCode: 'stale_capture' };
              if (candidateId === null) return { target: null };
              const index = candidates.findIndex(candidate => candidate.id === candidateId);
              if (index < 0) return { errorCode: 'unknown_candidate' };
              const element = nodes[index];
              if (!element.isConnected || !accessibilityExposed(element)) return { errorCode: 'stale_capture' };
              if (!inView(element)) return { errorCode: 'stale_capture' };
              const xpaths = xpathsFor(element);
              if (!xpaths.length) return { errorCode: 'xpath_validation_failed' };
              return { target: { candidateId, frame, tag: element.localName, role: role(element), accessibleName: label(element), label: candidates[index].label || candidates[index].text,
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
