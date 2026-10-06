namespace Xpathed.Browser.Sessions;

internal static class BrowserHighlightScript
{
    public const string Create = """
        selectedNodes => {
          let host, canvas, animation, spotlightStarted;
          const nodes = [...new Set(selectedNodes)];
          let spotlightNodes = [];
          let spotlightActive = false;
          const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
          const intersections = new Map();
          const observer = new IntersectionObserver(entries => {
            for (const entry of entries) intersections.set(entry.target, entry.intersectionRect);
          }, {root: document});
          const clear = () => {
            cancelAnimationFrame(animation);
            observer.disconnect();
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
              // Reobserve each frame: movement can change clipping without changing the intersection ratio.
              observer.unobserve(node); observer.observe(node);
              if (getComputedStyle(node).visibility !== 'visible') continue;
              const intersection = intersections.get(node);
              if (!intersection || intersection.width <= 0 || intersection.height <= 0) continue;
              const {left, top, right, bottom} = intersection;
              for (const rect of node.getClientRects()) {
                const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
                const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
                if (width > 0 && height > 0) boxes.push({x, y, width, height, node});
              }
            }
            if (spotlightStarted === undefined && boxes.some(box => box.width <= 24 || box.height <= 24)) {
              spotlightStarted = performance.now();
            }
            const hovering = spotlightActive;
            const highlightedBoxes = hovering ? boxes.filter(box => spotlightNodes.includes(box.node)) : boxes;
            const opacity = hovering ? (spotlightNodes.length ? 0.35 : 0) : reducedMotion.matches || spotlightStarted === undefined
              ? 0 : 0.35 * Math.min(1, Math.max(0, (1200 - (performance.now() - spotlightStarted)) / 600));
            if (opacity > 0 && boxes.length) {
              context.fillStyle = `rgba(0,0,0,${opacity})`;
              context.fillRect(0, 0, innerWidth, innerHeight);
              context.globalCompositeOperation = 'destination-out';
              context.fillStyle = 'black';
              for (const box of highlightedBoxes) {
                const width = Math.max(48, box.width + 24), height = Math.max(48, box.height + 24);
                context.beginPath();
                context.roundRect(box.x + (box.width-width)/2, box.y + (box.height-height)/2, width, height, 12);
                context.fill();
              }
              context.globalCompositeOperation = 'source-over';
            }
            for (const {x, y, width, height} of highlightedBoxes) {
              // Offset by half the outer stroke so every painted pixel stays outside the target.
              context.strokeStyle = 'black'; context.lineWidth = 8;
              context.strokeRect(x - 4, y - 4, width + 8, height + 8);
              context.strokeStyle = 'white'; context.lineWidth = 4;
              context.strokeRect(x - 4, y - 4, width + 8, height + 8);
            }
            // Neighboring or overlapping outlines must not cover another selected target's content.
            for (const {x, y, width, height} of highlightedBoxes) context.clearRect(x, y, width, height);
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
          return {clear, spotlight(index, active) {
            spotlightNodes = nodes[index] ? [nodes[index]] : [];
            spotlightActive = active;
            if (index < 0) spotlightStarted = -Infinity;
          }};
        }
        """;
}
