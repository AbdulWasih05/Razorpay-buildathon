import { useEffect } from 'react';

import { App } from './App.js';
import { Landing } from './Landing.js';
import { navigate, useRoute, type Route } from './router.js';
import './styles.css';

/**
 * The route switch.
 *
 * `/` is the overview, `/app` the review console, `/eval` the console opened on
 * its eval page. The console is one component either way -- `/eval` is not a
 * separate page, it is the same console told which view to open on, so there is
 * no second place the queue or the approve door could get out of step.
 */

const TITLES: Record<Route, string> = {
  landing: 'Praman · defense-only dispute evidence responder',
  console: 'Praman · dispute review',
  eval: 'Praman · eval results',
};

export function Root() {
  const route = useRoute();

  // The tab title is the only part of the page a router this small would
  // otherwise leave stale, and a stale one is visible in every screenshot and
  // every browser tab in the demo video.
  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  if (route === 'landing') return <Landing />;

  // The console does not hold its own idea of which page is open. It is handed
  // one derived from the route and hands back a route change, so the address
  // bar and the page cannot disagree -- which they did, until F-022.
  return (
    <App
      view={route === 'eval' ? 'metrics' : 'queue'}
      onView={(next) => navigate(next === 'metrics' ? 'eval' : 'console')}
    />
  );
}
