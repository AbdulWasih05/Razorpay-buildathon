import { useEffect, useState } from 'react';

/**
 * Three routes and about twenty lines, rather than a router dependency.
 *
 * The app has exactly three addresses -- the overview, the console, and the
 * console opened on its eval page -- and none of them take parameters or nest.
 * `react-router` would be a new dependency, a new build surface and a new thing
 * to explain at a panel, in exchange for features this app has no use for.
 *
 * The server side already works: the API's SPA fallback returns `index.html`
 * for any GET path that has no file extension and is not under `/api/`, so
 * `/app` and `/eval` are served without a route being added for them
 * (`apps/api/src/server.ts`).
 */

export type Route = 'landing' | 'console' | 'eval';

export function routeOf(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/app') return 'console';
  if (path === '/eval') return 'eval';
  return 'landing';
}

export function pathOf(route: Route): string {
  return route === 'console' ? '/app' : route === 'eval' ? '/eval' : '/';
}

/** The current route, kept in step with the back and forward buttons. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));

  useEffect(() => {
    // `popstate` covers back/forward. `pushState` does not fire it, so
    // `navigate` dispatches its own event rather than leaving the two ways of
    // changing the route to disagree about which one is current.
    const sync = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', sync);
    window.addEventListener('praman:navigate', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('praman:navigate', sync);
    };
  }, []);

  return route;
}

export function navigate(route: Route): void {
  window.history.pushState({}, '', pathOf(route));
  window.dispatchEvent(new Event('praman:navigate'));
  window.scrollTo(0, 0);
}

/**
 * Props for an anchor that navigates without a full page load.
 *
 * A real `href` rather than a click handler on a `<div>`: the link is
 * middle-clickable, openable in a new tab, and readable by anything crawling
 * the page -- which matters when the first visitor is plausibly an automated
 * screener rather than a person.
 */
export function linkTo(route: Route): {
  href: string;
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href: pathOf(route),
    onClick(event) {
      // Let the browser handle anything that means "open this elsewhere".
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(route);
    },
  };
}
