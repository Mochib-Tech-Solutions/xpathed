namespace Xpathed.Browser.Sessions;

internal static class BrowserHighlightScript
{
    public const string Create = """
        selectedNodes => {
          let host, canvas, animation, spotlightStarted;
          const nodes = [...new Set(selectedNodes)];
          let spotlightNodes = [];
          const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
          const clear = () => {
            cancelAnimationFrame(animation);
            host?.remove(); host = canvas = null;
          };
          const draw = () => {
            if (!host) return;
            if (nodes.some(node => !node.isConnected)) {
              clear();
              return;
            }
            const scale = devicePixelRatio || 1;
            if (canvas.width !== innerWidth * scale || canvas.height !== innerHeight * scale) {
              canvas.width = innerWidth * scale; canvas.height = innerHeight * scale;
            }
            const context = canvas.getContext('2d');
            context.setTransform(scale, 0, 0, scale, 0, 0);
            context.clearRect(0, 0, innerWidth, innerHeight);
            const boxes = [];
            for (const node of nodes) {
              let left = 0, top = 0, right = innerWidth, bottom = innerHeight, visible = true;
              for (let current = node; current; current = current.assignedSlot ?? current.parentElement ?? current.getRootNode().host) {
                const css = getComputedStyle(current);
                if (css.display === 'none' || css.visibility !== 'visible') { visible = false; break; }
                if (current !== node && current !== document.documentElement && current !== document.body) {
                  const box = current.getBoundingClientRect();
                  if (css.overflowX !== 'visible') { left = Math.max(left, box.left); right = Math.min(right, box.right); }
                  if (css.overflowY !== 'visible') { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
                }
                if (current.matches('dialog:modal, :popover-open')) break;
              }
              if (!visible || right <= left || bottom <= top) continue;
              for (const rect of node.getClientRects()) {
                const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
                const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
                if (width > 0 && height > 0) boxes.push({x, y, width, height, node});
              }
            }
            if (spotlightStarted === undefined && boxes.some(box => box.width <= 24 || box.height <= 24)) {
              spotlightStarted = performance.now();
            }
            const hovering = spotlightNodes.length > 0;
            const opacity = hovering ? 0.35 : reducedMotion.matches || spotlightStarted === undefined
              ? 0 : 0.35 * Math.min(1, Math.max(0, (1200 - (performance.now() - spotlightStarted)) / 600));
            if (opacity > 0 && boxes.length) {
              context.fillStyle = `rgba(0,0,0,${opacity})`;
              context.fillRect(0, 0, innerWidth, innerHeight);
              context.globalCompositeOperation = 'destination-out';
              context.fillStyle = 'black';
              for (const box of boxes.filter(box => !hovering || spotlightNodes.includes(box.node))) {
                const width = Math.max(48, box.width + 24), height = Math.max(48, box.height + 24);
                context.beginPath();
                context.roundRect(box.x + (box.width-width)/2, box.y + (box.height-height)/2, width, height, 12);
                context.fill();
              }
              context.globalCompositeOperation = 'source-over';
            }
            for (const {x, y, width, height} of boxes) {
              // Offset by half the outer stroke so every painted pixel stays outside the target.
              context.strokeStyle = 'black'; context.lineWidth = 8;
              context.strokeRect(x - 4, y - 4, width + 8, height + 8);
              context.strokeStyle = 'white'; context.lineWidth = 4;
              context.strokeRect(x - 4, y - 4, width + 8, height + 8);
            }
            // Neighboring or overlapping outlines must not cover another selected target's content.
            for (const {x, y, width, height} of boxes) context.clearRect(x, y, width, height);
            animation = requestAnimationFrame(draw);
          };
          host = document.createElement('div');
          host.setAttribute('aria-hidden', 'true'); host.inert = true; host.popover = 'manual';
          host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important;';
          const shadow = host.attachShadow({mode:'closed'});
          canvas = document.createElement('canvas');
          canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
          const style = document.createElement('style');
          style.textContent = ':host::backdrop { all:initial!important; background:transparent!important; pointer-events:none!important; }';
          shadow.append(style, canvas);
          document.documentElement.append(host);
          host.showPopover();
          draw();
          return {clear, spotlight(index) {
            spotlightNodes = nodes[index] ? [nodes[index]] : [];
            if (index < 0) spotlightStarted = -Infinity;
          }};
        }
        """;
}
