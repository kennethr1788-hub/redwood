import type {WithContext, WebPage, WebSite} from 'schema-dts';

/** Compile-time authoring only. This does not validate scraped markup or eligibility. */
export function recommendSchema(url: string, name: string): WithContext<WebPage | WebSite> {
  return {'@context': 'https://schema.org', '@type': new URL(url).pathname === '/' ? 'WebSite' : 'WebPage', url, name};
}
