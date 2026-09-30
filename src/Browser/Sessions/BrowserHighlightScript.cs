namespace Xpathed.Browser.Sessions;

internal static class BrowserHighlightScript
{
    public const string Create = """
        selectedNodes => {
          let host, canvas, animation;
          const nodes = [...new Set(selectedNodes)];
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
            context.fillStyle = 'rgba(59,130,246,0.18)';
            context.strokeStyle = 'rgb(37,99,235)'; context.lineWidth = 2;
            for (const node of nodes) {
              let left = 0, top = 0, right = innerWidth, bottom = innerHeight, visible = true;
              for (let current = node; current; current = current.parentElement) {
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
              context.save(); context.beginPath(); context.rect(left, top, right-left, bottom-top); context.clip();
              for (const rect of node.getClientRects()) {
                context.fillRect(rect.x, rect.y, rect.width, rect.height);
                context.strokeRect(rect.x, rect.y, rect.width, rect.height);
              }
              context.restore();
            }
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
          return {clear};
        }
        """;
}
