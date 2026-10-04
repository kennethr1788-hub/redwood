import {DISPLAY_NAMES as names} from './display-names.js';

const products = ['build', 'studio', 'grow'];
/** @type {Record<string, string>} */
const titles = {home: 'Projects / recent work', setup: 'Setup', build: names.build, studio: names.studio, grow: names.grow, connections: 'Connections', settings: 'Settings', advisor: names.advisor};
let route = 'home';
let contextVersion = 0;
export const shellContextVersion = () => contextVersion;
export const shellShowsProjects = () => route === 'home';
let workContext = 'Local workspace';
let workNext = 'Choose existing work or a starting point.';

/** @param {string} context @param {string} next */
export function updateShellContext(context, next) {
  workContext = context; workNext = next;
  if (route === 'home' || route === 'advisor') renderContext();
}
function renderContext() {
  const context = document.querySelector('#current-context');
  const next = document.querySelector('#next-action');
  const startingPoint = /** @type {HTMLSelectElement} */ (document.querySelector('select[name="startingPoint"]'));
  const product = {IDEA: 'build', REPO: 'build', APP_OR_RECORDING: 'studio', GROW_INPUTS: 'grow'}[startingPoint.value];
  let text = workContext + ' · ' + workNext;
  let href = '#setup'; let action = 'Start with what you have';
  if (products.includes(route)) {
    text = names[route] + ' · Independent local product. Start it before opening its address.';
    action = 'Check setup for ' + names[route];
  } else if (route === 'setup') {
    text = names[product] + ' · Prepare context, then check local entry readiness.';
    href = '#' + product; action = 'View ' + names[product] + ' start command';
  } else if (route === 'connections') {
    text = 'Connection evidence and billing are separate. No action is authorized here.';
    action = 'Review setup';
  } else if (route === 'settings') {
    text = 'Local setup and browser continuity. Product state stays with its owner.';
    action = 'Review setup';
  } else if (route === 'advisor') {
    text = 'Prior shell context: ' + workContext + ' · ' + names.advisor + ' uses the Product and Project selected below.';
    href = '#home'; action = 'Return to work';
  }
  context.textContent = text; next.textContent = action; next.setAttribute('href', href);
  document.querySelector('#advisor-context').textContent = 'Prior shell context: ' + workContext + '. Next: ' + workNext + ' ' + names.advisor + ' uses the Product and Project selected below.';
}

export function initializeShell() {
  const menu = /** @type {HTMLButtonElement} */ (document.querySelector('#menu-toggle'));
  const sidebar = document.querySelector('.sidebar');
  const heading = /** @type {HTMLHeadingElement} */ (document.querySelector('#route-title'));
  const closeMenu = () => { sidebar.classList.remove('menu-open'); menu.setAttribute('aria-expanded', 'false'); };
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open)); sidebar.classList.toggle('menu-open', open);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); }
  });
  const navigate = (focus = true) => {
    const requested = window.location.hash.slice(1) || 'home';
    if (requested === 'content') { closeMenu(); /** @type {HTMLElement} */ (document.querySelector('#content')).focus(); return; }
    const nextRoute = Object.hasOwn(titles, requested) ? requested : 'home';
    // Utilities do not replace the selected work. Only a product selection supersedes a pending resume.
    if (products.includes(nextRoute)) contextVersion++;
    route = nextRoute;
    if (products.includes(route)) { workContext = names[route]; workNext = 'Open its local workspace after starting the product.'; window.dispatchEvent(new CustomEvent('selected-work', {detail: {product: route, projectId: null}})); }
    document.querySelectorAll('[data-view]').forEach(panel => { /** @type {HTMLElement} */ (panel).hidden = panel.id !== route; });
    document.querySelectorAll('[data-route]').forEach(link => {
      if (link.getAttribute('data-route') === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    heading.textContent = titles[route]; document.title = names.umbrella + ' — ' + titles[route];
    closeMenu(); renderContext();
    if (focus) { heading.focus({preventScroll: true}); window.scrollTo(0, 0); }
  };
  window.addEventListener('hashchange', () => navigate());
  document.querySelectorAll('[data-route]').forEach(link => link.addEventListener('click', () => {
    if (link.getAttribute('href') === window.location.hash) { closeMenu(); heading.focus(); }
  }));
  /** @type {HTMLSelectElement} */ (document.querySelector('select[name="startingPoint"]')).addEventListener('change', renderContext);
  // A product's setup shortcut selects the existing starting point; the form stays mounted.
  document.querySelectorAll('.product a[href="#setup"], #next-action').forEach(link => link.addEventListener('click', () => {
    if (products.includes(route)) {
      /** @type {HTMLSelectElement} */ (document.querySelector('select[name="startingPoint"]')).value = {build: 'IDEA', studio: 'APP_OR_RECORDING', grow: 'GROW_INPUTS'}[route];
      document.querySelector('form').dispatchEvent(new Event('change', {bubbles: true}));
    }
  }));
  navigate(false);
}
