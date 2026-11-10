/** Finding and reading the ArcGIS MapView on a bom.gov.au location page. */

/** Duck-type check for an ArcGIS JS 4.x MapView. */
export function looksLikeMapView(v) {
  try {
    return !!v && typeof v === 'object' && !!v.extent && typeof v.zoom === 'number' &&
      typeof v.toScreen === 'function' && 'container' in v;
  } catch (_) {
    return false;
  }
}

/** Walk React fibers upward from a DOM element looking for a MapView in hooks/props. */
export function findMapViewFromElement(el, maxDomDepth = 12, maxFiberDepth = 80) {
  for (let d = 0; el && d < maxDomDepth; d++, el = el.parentElement) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    if (!key) continue;
    let fiber = el[key];
    for (let i = 0; fiber && i < maxFiberDepth; i++, fiber = fiber.return) {
      let hook = fiber.memoizedState;
      for (let j = 0; hook && typeof hook === 'object' && j < 60; j++, hook = hook.next) {
        const ms = hook.memoizedState;
        if (looksLikeMapView(ms)) return ms;
        if (ms && typeof ms === 'object' && looksLikeMapView(ms.current)) return ms.current;
      }
      const props = fiber.memoizedProps;
      if (props && typeof props === 'object') {
        for (const k in props) if (looksLikeMapView(props[k])) return props[k];
      }
      if (fiber.stateNode && looksLikeMapView(fiber.stateNode.view)) return fiber.stateNode.view;
    }
    return null; // only need the nearest React-managed ancestor
  }
  return null;
}

/**
 * Current north-up extent of a MapView, derived from center + resolution + size.
 * (view.extent can lag behind the rendered state, e.g. in background tabs; center/resolution
 * are what toScreen()/toMap() use.) Falls back to view.extent.
 */
export function viewExtent(view, width, height) {
  const c = view.center;
  const res = view.resolution;
  if (c && typeof c.x === 'number' && typeof res === 'number' && res > 0 && width && height) {
    const hw = (width / 2) * res;
    const hh = (height / 2) * res;
    return { xmin: c.x - hw, xmax: c.x + hw, ymin: c.y - hh, ymax: c.y + hh, spatialReference: c.spatialReference };
  }
  const e = view.extent;
  return e ? { xmin: e.xmin, xmax: e.xmax, ymin: e.ymin, ymax: e.ymax, spatialReference: e.spatialReference } : null;
}
